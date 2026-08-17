import { describe, expect, test } from "bun:test";
import {
  ExtensionValidationError,
  PROJECT_TOOL_NAMES,
  RESERVED_TOOL_NAMES,
  validateManifest,
  type ExtensionManifest,
} from "./manifest";
import { fixtureManifest } from "./fixture";

function cliManifest(): ExtensionManifest {
  return {
    id: "com.example.cli",
    label: "Example CLI",
    vendor: "example",
    kind: "cli",
    cli: { command: "/usr/bin/example", args: ["--json"], env: { EXAMPLE_HOME: "/opt/example" } },
    credentialSchema: { type: "oauth", scopes: ["read", "write"] },
    tools: [
      {
        name: "example.query",
        tier: "write",
        description: "Queries the example CLI",
        params: [{ name: "id", type: "number", required: false }],
      },
    ],
    domains: ["api.example.com"],
  };
}

function mutate(manifest: ExtensionManifest, path: string[], value: unknown): Record<string, unknown> {
  const doc = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  let cursor: Record<string, unknown> = doc;
  for (const key of path.slice(0, -1)) {
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
  return doc;
}

function expectInvalid(doc: unknown, messagePart: string): void {
  try {
    validateManifest(doc);
    expect.unreachable(`expected validation failure: ${messagePart}`);
  } catch (err) {
    expect(err).toBeInstanceOf(ExtensionValidationError);
    expect((err as Error).message).toContain(messagePart);
  }
}

describe("extension manifest validation (fail closed)", () => {
  test("accepts the fixture mcp manifest", () => {
    const manifest = validateManifest(fixtureManifest());
    expect(manifest.id).toBe("fixture.weather");
    expect(manifest.kind).toBe("mcp");
    expect(manifest.mcp).toEqual({ serverUrl: "http://127.0.0.1:9/mcp", transport: "streamable-http" });
    expect(manifest.tools[0].name).toBe("weather.current");
    expect(manifest.domains).toEqual(["fixture.weather.test"]);
  });

  test("accepts a cli manifest with args, env, and oauth scopes", () => {
    const manifest = validateManifest(cliManifest());
    expect(manifest.kind).toBe("cli");
    expect(manifest.cli).toEqual({
      command: "/usr/bin/example",
      args: ["--json"],
      env: { EXAMPLE_HOME: "/opt/example" },
    });
    expect(manifest.credentialSchema).toEqual({ type: "oauth", scopes: ["read", "write"] });
  });

  test("rejects a non-object manifest", () => {
    expectInvalid("nope", "manifest must be an object");
    expectInvalid(null, "manifest must be an object");
    expectInvalid([], "manifest must be an object");
  });

  test("rejects malformed ids", () => {
    expectInvalid(mutate(fixtureManifest(), ["id"], ""), "id must be a non-empty string");
    expectInvalid(mutate(fixtureManifest(), ["id"], "has space"), "id");
    expectInvalid(mutate(fixtureManifest(), ["id"], "Upper.Case"), "id");
  });

  test("rejects a missing label or vendor", () => {
    expectInvalid(mutate(fixtureManifest(), ["label"], ""), "label must be a non-empty string");
    expectInvalid(mutate(fixtureManifest(), ["vendor"], 42), "vendor must be a non-empty string");
  });

  test("rejects an unknown kind", () => {
    expectInvalid(mutate(fixtureManifest(), ["kind"], "http"), "kind must be \"mcp\" or \"cli\"");
  });

  test("kind mcp requires an mcp binding and forbids a cli binding", () => {
    expectInvalid(mutate(fixtureManifest(), ["mcp"], undefined), "requires an mcp binding");
    expectInvalid(
      { ...fixtureManifest(), cli: { command: "/bin/echo" } },
      "must not declare a cli binding",
    );
  });

  test("kind cli requires a cli binding and forbids an mcp binding", () => {
    expectInvalid(mutate(cliManifest(), ["cli"], undefined), "requires a cli binding");
    expectInvalid({ ...cliManifest(), mcp: fixtureManifest().mcp }, "must not declare an mcp binding");
  });

  test("mcp binding requires exactly one of serverUrl or command", () => {
    expectInvalid(
      { ...fixtureManifest(), mcp: { serverUrl: "http://x", command: "mcp", transport: "stdio" } },
      "exactly one of serverUrl or command",
    );
    expectInvalid({ ...fixtureManifest(), mcp: { transport: "stdio" } }, "exactly one of");
  });

  test("mcp binding transport must match the binding kind", () => {
    expectInvalid(
      { ...fixtureManifest(), mcp: { serverUrl: "http://x", transport: "stdio" } },
      "serverUrl bindings must use transport \"streamable-http\"",
    );
    expectInvalid(
      { ...fixtureManifest(), mcp: { command: "/usr/bin/mcp", transport: "streamable-http" } },
      "command bindings must use transport \"stdio\"",
    );
    expectInvalid(
      { ...fixtureManifest(), mcp: { serverUrl: "http://x", transport: "sse" } },
      "must be \"streamable-http\" or \"stdio\"",
    );
  });

  test("mcp serverUrl must be an http(s) URL", () => {
    expectInvalid(
      { ...fixtureManifest(), mcp: { serverUrl: "ftp://x", transport: "streamable-http" } },
      "must be an http(s) URL",
    );
    expectInvalid(
      { ...fixtureManifest(), mcp: { serverUrl: "not a url", transport: "streamable-http" } },
      "valid URL",
    );
  });

  test("credential schema rejects unknown types and api_key scopes", () => {
    expectInvalid(
      mutate(fixtureManifest(), ["credentialSchema"], { type: "password" }),
      "credentialSchema.type",
    );
    expectInvalid(
      mutate(fixtureManifest(), ["credentialSchema"], { type: "api_key", scopes: ["read"] }),
      "only applies to oauth",
    );
    expectInvalid(
      mutate(fixtureManifest(), ["credentialSchema"], { type: "oauth", scopes: [""] }),
      "non-empty strings",
    );
  });

  test("tool names must be unique, well-formed, and not reserved", () => {
    const duplicated = mutate(fixtureManifest(), ["tools"], [
      fixtureManifest().tools[0],
      { ...fixtureManifest().tools[0], description: "again" },
    ]);
    expectInvalid(duplicated, "duplicate tool name");

    expectInvalid(mutate(fixtureManifest(), ["tools", "0", "name"], "read"), "reserved by the runtime");
    expectInvalid(mutate(fixtureManifest(), ["tools", "0", "name"], "create_work_item"), "reserved by the runtime");
    expectInvalid(mutate(fixtureManifest(), ["tools", "0", "name"], "bad name"), "must match");
  });

  test("project tool names are part of the reserved set", () => {
    expect(PROJECT_TOOL_NAMES).toContain("create_work_item");
    for (const name of PROJECT_TOOL_NAMES) {
      expect(RESERVED_TOOL_NAMES).toContain(name);
    }
  });

  test("tool tiers must be read/write/exec", () => {
    expectInvalid(mutate(fixtureManifest(), ["tools", "0", "tier"], "admin"), "tier must be");
  });

  test("tool descriptions must be non-empty", () => {
    expectInvalid(mutate(fixtureManifest(), ["tools", "0", "description"], ""), "description must be a non-empty string");
  });

  test("providerName is optional, validated, and defaults to the manifest name (issue #148)", () => {
    // Absent → no providerName on the typed tool (falls back to name).
    const plain = validateManifest(fixtureManifest());
    expect(plain.tools[0].providerName).toBeUndefined();
    // Valid providerName survives validation.
    const mapped = validateManifest(
      mutate(fixtureManifest(), ["tools", "0", "providerName"], "wire.name-tool_1"),
    );
    expect(mapped.tools[0].providerName).toBe("wire.name-tool_1");
    // Fail closed on malformed provider names.
    expectInvalid(mutate(fixtureManifest(), ["tools", "0", "providerName"], ""), "providerName must be a non-empty string");
    expectInvalid(mutate(fixtureManifest(), ["tools", "0", "providerName"], 42), "providerName must be a non-empty string");
    expectInvalid(mutate(fixtureManifest(), ["tools", "0", "providerName"], "Bad Name"), "must match");
    expectInvalid(mutate(fixtureManifest(), ["tools", "0", "providerName"], "UPPER"), "must match");
  });

  test("params reject unknown types, duplicates, and bad required flags", () => {
    expectInvalid(
      mutate(fixtureManifest(), ["tools", "0", "params"], [{ name: "x", type: "date" }]),
      "type must be",
    );
    expectInvalid(
      mutate(fixtureManifest(), ["tools", "0", "params"], [
        { name: "x", type: "string" },
        { name: "x", type: "string" },
      ]),
      "duplicate param",
    );
    expectInvalid(
      mutate(fixtureManifest(), ["tools", "0", "params"], [{ name: "x", type: "string", required: "yes" }]),
      "required must be a boolean",
    );
  });

  test("domains must be hostnames without scheme, port, or trailing dot", () => {
    expectInvalid(mutate(fixtureManifest(), ["domains"], ["https://api.example.com"]), "domain");
    expectInvalid(mutate(fixtureManifest(), ["domains"], ["api.example.com:443"]), "domain");
    expectInvalid(mutate(fixtureManifest(), ["domains"], ["api.example.com."]), "domain");
    expectInvalid(mutate(fixtureManifest(), ["domains"], ["bad domain"]), "domain");
    expectInvalid(mutate(fixtureManifest(), ["domains"], "not-an-array"), "domains must be an array");
  });

  test("an empty domains array is accepted (no egress allowance)", () => {
    const manifest = validateManifest({ ...fixtureManifest(), domains: [] });
    expect(manifest.domains).toEqual([]);
  });

  test("wildcard domains with a leading *. are accepted", () => {
    const manifest = validateManifest({ ...fixtureManifest(), domains: ["*.fixture.weather.test"] });
    expect(manifest.domains).toEqual(["*.fixture.weather.test"]);
  });

  test("an empty tools array is allowed (egress-only extension)", () => {
    const manifest = validateManifest({ ...fixtureManifest(), tools: [] });
    expect(manifest.tools).toEqual([]);
  });
});
