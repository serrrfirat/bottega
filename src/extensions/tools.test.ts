/**
 * Extension tool bridge (issue #50): manifest tools become SDK definitions
 * whose execution routes through the extension runtime (issue #53) — the
 * bridge owns the SDK surface, the runtime owns gate → ladder → boundary →
 * audit. These tests pin the SDK surface and the failure mapping; the
 * runtime's own hermetic path lives in runtime.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createAudit } from "../policy/audit";
import { DenyRouter } from "../policy/approval-router";
import { parseOrgConfigYaml, type PolicyConfig } from "../policy/config";
import { createStore, type ExtensionCredential, type Store } from "../store/db";
import { extensionToolDefinitions } from "./tools";
import { createFixtureRegistry, fixtureManifest, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL } from "./fixture";
import { validateManifest, type ExtensionManifest, type McpBinding } from "./manifest";
import { createExtensionRegistry } from "./registry";
import { createExtensionRuntime, type ExtensionRuntime } from "./runtime";

/** Minimal structural view of an omptype schema's parse surface. */
interface ParsableSchema {
  safeParse(value: unknown): { success: boolean };
}

/** Full ToolDefinition execute signature; tests call with a fake context. */
function run(def: ToolDefinition, params: Record<string, unknown>) {
  return def.execute("1", params, undefined, undefined, {
    sessionManager: { getSessionFile: () => null },
  } as unknown as ExtensionContext);
}

const stubRuntime: ExtensionRuntime = {
  execute: async () => ({ ok: false, error: "stub runtime" }),
};

/**
 * A real runtime over the given manifests with fake-but-real deps: in-memory
 * store with an org credential row per manifest, real audit module, DenyRouter,
 * a recording boundary, and the injected MCP transport seam.
 */
function makeRuntime(
  manifests: ExtensionManifest[],
  opts: { mcpTransport?: (binding: McpBinding) => Transport; policy?: PolicyConfig } = {},
): { runtime: ExtensionRuntime; store: Store; boundaryCalls: ExtensionCredential[] } {
  const registry = createExtensionRegistry();
  for (const manifest of manifests) registry.register(manifest);
  const store = createStore(":memory:");
  for (const manifest of manifests) {
    void store.upsertExtensionCredential({
      provider: manifest.id,
      identityKey: "email:org@example.com",
      owner: null,
      scope: "org",
      brokerCredentialId: 1,
    });
  }
  const boundaryCalls: ExtensionCredential[] = [];
  const runtime = createExtensionRuntime({
    registry,
    store,
    audit: createAudit(store),
    // The ad-hoc manifests are not in any allowlist and cross the tier
    // stage as known tools with their manifest tier; the tools map allows
    // everything not explicitly denied unless the test overrides it.
    orgPolicy: opts.policy ?? parseOrgConfigYaml("tools:\n  unknown: allow\n"),
    router: DenyRouter,
    boundary: {
      async authorize(credential: ExtensionCredential) {
        boundaryCalls.push(credential);
      },
    },
    mcpTransport: opts.mcpTransport,
  });
  return { runtime, store, boundaryCalls };
}

describe("extension tool bridge", () => {
  test("the fixture tool becomes an SDK definition with tier read and typed params", async () => {
    const definitions = extensionToolDefinitions(createFixtureRegistry().list(), { runtime: stubRuntime });
    expect(definitions).toHaveLength(1);
    const definition = definitions[0];
    expect(definition.name).toBe(FIXTURE_EXTENSION_TOOL);
    expect(definition.label).toBe(FIXTURE_EXTENSION_TOOL);
    expect(definition.description).toContain("Current weather for a city");
    expect(definition.approval).toBe("read");

    const schema = definition.parameters as unknown as ParsableSchema;
    expect(schema.safeParse({ city: "Lisbon" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false); // city is required
  });

  test("cli extension tools shell out to the preinstalled command with --name value flags", async () => {
    const cli = validateManifest({
      id: "com.example.cli",
      label: "Example CLI",
      vendor: "example",
      kind: "cli",
      cli: { command: "/bin/echo", args: ["hello"] },
      credentialSchema: { type: "api_key" },
      tools: [
        {
          name: "example.greet",
          tier: "read",
          description: "Echoes a greeting",
          params: [
            { name: "name", type: "string", required: true },
            { name: "loud", type: "boolean" },
          ],
        },
      ],
      domains: ["api.example.com"],
    });
    const { runtime, boundaryCalls } = makeRuntime([cli]);
    const [definition] = extensionToolDefinitions([{ manifest: cli }], { runtime });
    const result = await run(definition, { name: "world", loud: true });
    expect(result.content).toEqual([{ type: "text", text: "hello --name world --loud\n" }]);
    // The cli path still resolves + injects the credential at the boundary.
    expect(boundaryCalls).toHaveLength(1);
    expect(boundaryCalls[0]!.provider).toBe("com.example.cli");
  });

  test("cli failures surface as tool errors, not silent no-ops", async () => {
    const cli = validateManifest({
      id: "com.example.cli",
      label: "Example CLI",
      vendor: "example",
      kind: "cli",
      cli: { command: "/usr/bin/false" },
      credentialSchema: { type: "api_key" },
      tools: [{ name: "example.fail", tier: "read", description: "Always fails", params: [] }],
      domains: ["api.example.com"],
    });
    const { runtime } = makeRuntime([cli]);
    const [definition] = extensionToolDefinitions([{ manifest: cli }], { runtime });
    const result = await run(definition, {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("exited 1");
  });

  test("cli tools spawn a PATH-resolved stub with mapped args and NO credentials in env", async () => {
    // Hermetic stub CLI on PATH (issue #58): dumps its invocation and env so
    // the test can assert the arg mapping and the credential boundary.
    const stubDir = mkdtempSync(join(tmpdir(), "bottega-cli-stub-"));
    const originalPath = process.env.PATH;
    const originalToken = process.env.GITHUB_TOKEN;
    const originalMarker = process.env.BOTTEGA_CLI_TEST_MARKER;
    try {
      const stub = join(stubDir, "stub-cli");
      writeFileSync(
        stub,
        [
          "#!/usr/bin/env bash",
          'echo "cmd=$(basename "$0")"',
          'echo "args=$*"',
          "env | sort",
        ].join("\n") + "\n",
      );
      chmodSync(stub, 0o755);
      process.env.PATH = `${stubDir}:${originalPath ?? ""}`;
      // The parent's environment carries a credential and a benign marker;
      // only the marker may reach the child.
      process.env.GITHUB_TOKEN = "ghp_fakecredential_do_not_leak";
      process.env.BOTTEGA_CLI_TEST_MARKER = "marker-pass";

      const cli = validateManifest({
        id: "com.example.stubcli",
        label: "Stub CLI",
        vendor: "example",
        kind: "cli",
        cli: { command: "stub-cli", args: ["fixed"], env: { GH_CONFIG_DIR: "/etc/gh" } },
        credentialSchema: { type: "api_key" },
        tools: [
          {
            name: "stub.greet",
            tier: "read",
            description: "Greets through the stub",
            params: [
              { name: "name", type: "string", required: true },
              { name: "loud", type: "boolean" },
            ],
          },
        ],
        domains: ["api.example.com"],
      });
      const { runtime } = makeRuntime([cli]);
      const [definition] = extensionToolDefinitions([{ manifest: cli }], { runtime });
      const result = await run(definition, { name: "world", loud: true });
      const first = result.content[0];
      const output = first && "text" in first ? first.text : "";
      // Spawn path: command resolved on PATH, manifest fixed args first,
      // then params as --name value flags (--name alone for booleans).
      expect(output).toContain("cmd=stub-cli");
      expect(output).toContain("args=fixed --name world --loud");
      // Non-credential parent env passes through; manifest env delta applies.
      expect(output).toContain("BOTTEGA_CLI_TEST_MARKER=marker-pass");
      expect(output).toContain("GH_CONFIG_DIR=/etc/gh");
      // The no-cred-in-env guarantee: the parent's credential never reaches
      // the spawned CLI (iron-proxy boundary is the only auth path).
      expect(output).not.toContain("ghp_fakecredential_do_not_leak");
    } finally {
      process.env.PATH = originalPath;
      if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalToken;
      if (originalMarker === undefined) delete process.env.BOTTEGA_CLI_TEST_MARKER;
      else process.env.BOTTEGA_CLI_TEST_MARKER = originalMarker;
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  test("a cli manifest declaring a credential in cli.env is rejected (fail closed)", () => {
    expect(() =>
      validateManifest({
        id: "com.example.sneaky",
        label: "Sneaky CLI",
        vendor: "example",
        kind: "cli",
        cli: { command: "gh", env: { GITHUB_TOKEN: "ghp_stored" } },
        credentialSchema: { type: "api_key" },
        tools: [{ name: "sneaky.list", tier: "read", description: "Lists", params: [] }],
        domains: ["api.github.com"],
      }),
    ).toThrow(/looks like a credential/);
  });

  test("mcp extension tools call the provider's official MCP server over the injected transport", async () => {
    const mcp = validateManifest({
      id: "com.example.mcp",
      label: "Example MCP",
      vendor: "example",
      kind: "mcp",
      mcp: { serverUrl: "http://127.0.0.1:1/mcp", transport: "streamable-http" },
      credentialSchema: { type: "oauth", scopes: ["read"] },
      tools: [
        {
          name: "weather.current",
          tier: "read",
          description: "Current weather",
          params: [{ name: "city", type: "string" }],
        },
      ],
      domains: ["api.example.com"],
    });
    const mcpTransport = (_binding: McpBinding): Transport => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = request.params.arguments as Record<string, unknown>;
        return { content: [{ type: "text", text: `sunny in ${args["city"]}` }] };
      });
      void server.connect(serverTransport);
      return clientTransport;
    };
    const { runtime } = makeRuntime([mcp], { mcpTransport });
    const [definition] = extensionToolDefinitions([{ manifest: mcp }], { runtime });
    const result = await run(definition, { city: "Lisbon" });
    expect(result.content).toEqual([{ type: "text", text: "sunny in Lisbon" }]);
  });

  test("the bridge forwards providerName to the runtime call and keeps the manifest name on the SDK definition (issue #148)", async () => {
    const mcp = validateManifest({
      id: "com.example.mcp",
      label: "Example MCP",
      vendor: "example",
      kind: "mcp",
      mcp: { serverUrl: "http://127.0.0.1:1/mcp", transport: "streamable-http" },
      credentialSchema: { type: "oauth", scopes: ["read"] },
      tools: [
        {
          name: "weather.current",
          providerName: "current_weather",
          tier: "read",
          description: "Current weather",
          params: [{ name: "city", type: "string" }],
        },
      ],
      domains: ["api.example.com"],
    });
    // The stub records the tool name the RUNTIME forwards to the provider.
    const seen: string[] = [];
    const mcpTransport = (_binding: McpBinding): Transport => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        seen.push(request.params.name);
        return { content: [{ type: "text", text: "ok" }] };
      });
      void server.connect(serverTransport);
      return clientTransport;
    };
    const { runtime } = makeRuntime([mcp], { mcpTransport });
    const [definition] = extensionToolDefinitions([{ manifest: mcp }], { runtime });
    // The SDK-facing name stays the manifest name (policy/audit/model-facing).
    expect(definition.name).toBe("weather.current");
    expect(definition.label).toBe("weather.current");
    const result = await run(definition, { city: "Lisbon" });
    expect(result.isError).not.toBe(true);
    // The provider received the WIRE name, not the manifest name.
    expect(seen).toEqual(["current_weather"]);
  });

  test("without providerName the bridge forwards the manifest name verbatim (fallback, issue #148)", async () => {
    const seen: string[] = [];
    const mcpTransport = (_binding: McpBinding): Transport => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        seen.push(request.params.name);
        return { content: [{ type: "text", text: "ok" }] };
      });
      void server.connect(serverTransport);
      return clientTransport;
    };
    const { runtime } = makeRuntime([fixtureManifest()], { mcpTransport });
    const [definition] = extensionToolDefinitions(createFixtureRegistry().list(), { runtime });
    const result = await run(definition, { city: "Lisbon" });
    expect(result.isError).not.toBe(true);
    expect(seen).toEqual(["weather.current"]);
  });

  test("mcp connection failures surface as tool errors", async () => {
    const { runtime } = makeRuntime([fixtureManifest()], {
      // Force the fixture's (unreachable) serverUrl through a transport that
      // fails immediately, proving failures fail closed as tool errors.
      mcpTransport: () => {
        throw new Error("connection refused");
      },
    });
    const definitions = extensionToolDefinitions(createFixtureRegistry().list(), { runtime });
    const result = await run(definitions[0], { city: "Lisbon" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("connection refused");
  });

  test("a gate denial surfaces as a tool error, not a silent no-op", async () => {
    const { runtime } = makeRuntime([fixtureManifest()], {
      policy: parseOrgConfigYaml("tools:\n  weather.current: deny\n"),
    });
    const definitions = extensionToolDefinitions(createFixtureRegistry().list(), { runtime });
    // The runtime's policy denies the tool before any credential work.
    const result = await run(definitions[0], { city: "Lisbon" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("policy:");
  });

  test("a cli extension without a tool still yields no definitions", () => {
    const cli = validateManifest({
      id: "com.example.cli2",
      label: "Example CLI",
      vendor: "example",
      kind: "cli",
      cli: { command: "/bin/echo" },
      credentialSchema: { type: "api_key" },
      tools: [],
      domains: ["api.example.com"],
    });
    expect(extensionToolDefinitions([{ manifest: cli }], { runtime: stubRuntime })).toEqual([]);
  });

  test("getCaller resolves the session principal so the ladder matches the caller's personal credential (issue #121)", async () => {
    const mcpTransport = (_binding: McpBinding): Transport => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = request.params.arguments as Record<string, unknown>;
        return { content: [{ type: "text", text: `sunny in ${args["city"]}` }] };
      });
      void server.connect(serverTransport);
      return clientTransport;
    };
    const { runtime, store, boundaryCalls } = makeRuntime([fixtureManifest()], {
      mcpTransport,
      // auto must NOT fall through to the org credential: deny org usage so
      // the ladder resolves the caller's own personal row.
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\nextensions:\n  org_credentials: deny\n"),
    });
    // Ada's personal credential, exactly like `connect github as me` stores.
    await store.upsertExtensionCredential({
      provider: FIXTURE_EXTENSION_ID,
      identityKey: "email:ada@example.com",
      owner: "UADA",
      scope: "personal",
      brokerCredentialId: 2,
    });
    const [definition] = extensionToolDefinitions(
      [{ manifest: fixtureManifest() }],
      {
        runtime,
        // The adapter layer (index.ts) wires this seam from the space's
        // last inbound principal; here the session file selects Ada.
        getCaller: (ctx) => (ctx.sessionManager?.getSessionFile() === "slack:C1.jsonl" ? "UADA" : undefined),
      },
    );
    const result = await definition.execute("1", { city: "Lisbon" }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "slack:C1.jsonl" },
    } as unknown as ExtensionContext);
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "sunny in Lisbon" }]);
    // The boundary saw ADA's row — the personal credential resolved.
    expect(boundaryCalls).toHaveLength(1);
    expect(boundaryCalls[0]!.owner).toBe("UADA");
    expect(boundaryCalls[0]!.scope).toBe("personal");
  });

  test("without getCaller the bridge falls back to caller 'agent' and a personal lookup asks (issue #121)", async () => {
    const { runtime, store, boundaryCalls } = makeRuntime([fixtureManifest()], {
      // Same org-denied policy: with caller "agent" there is no personal row
      // to match, so the ladder must ask instead of guessing.
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\nextensions:\n  org_credentials: deny\n"),
    });
    await store.upsertExtensionCredential({
      provider: FIXTURE_EXTENSION_ID,
      identityKey: "email:ada@example.com",
      owner: "UADA",
      scope: "personal",
      brokerCredentialId: 2,
    });
    // No getCaller: the bridge's documented default is caller "agent".
    const [definition] = extensionToolDefinitions([{ manifest: fixtureManifest() }], { runtime });
    const result = await run(definition, { city: "Lisbon" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/no fixture\.weather credential is available/);
    // Nothing resolved: no boundary injection, no credential audit.
    expect(boundaryCalls).toHaveLength(0);
  });
});
