/**
 * OpenAPI tool generator tests (issue #345): a pure inline fixture spec
 * exercises fetch+validate (HTTPS, ≤2MB, OpenAPI 3.x), deterministic
 * generation (names + tiering + params), every cap failing CLOSED (oversize,
 * op count, non-HTTPS server, name collision, unknown scheme), and the
 * HTTPS-only egress host derivation.
 */
import { describe, expect, test } from "bun:test";
import {
  OPENAPI_MAX_OPERATIONS,
  OPENAPI_MAX_SPEC_BYTES,
  OPENAPI_RESPONSE_BOUND_BYTES,
  OpenApiSpecError,
  fetchOpenApiSpec,
  generateOpenApiTools,
  openApiHosts,
  paramsFromOpenApiOperation,
} from "./openapi-tools";
import type { JsonObject, JsonValue } from "./manifest";

/** A Hermetic fetch mock returning the given body/status (no network). */
function jsonFetch(body: string, status = 200): typeof fetch {
  // SAFETY: the stub implements fetch's call contract (input, init?) => Promise<Response>;
  // Bun's fetch also exposes fetch.preconnect, which the loader never calls.
  return (async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(body, { status })) as typeof fetch;
}

/** Deep-clones a known-good fixture through JSON so a test can mutate a copy. */
function cloneSpec(spec: JsonObject): JsonObject {
  // SAFETY: the fixture is constructed in-test from literal JsonValue data;
  // JSON round-tripping preserves that record shape (no functions/undefined/
  // NaN), so the clone is a valid JsonObject.
  return JSON.parse(JSON.stringify(spec)) as JsonObject;
}

/**
 * Re-narrows a JsonValue branch the caller already knows is a record.
 * Every call site passes an object literal it just built, never a scalar.
 */
function rec(value: JsonValue): JsonObject {
  // SAFETY: callers pass a JSON object literal (never an array/scalar), so
  // the cast only re-narrows to the record type the value already is.
  return value as JsonObject;
}
/** A minimal, valid OpenAPI 3.x fixture spec covering the generator's seams. */
function fixtureSpec(overrides: Record<string, JsonValue> = {}): JsonObject {
  return {
    openapi: "3.0.3",
    info: { title: "Fixture API", version: "1.0.0" },
    servers: [{ url: "https://api.example.test/v1" }],
    paths: {
      "/stats": {
        get: { operationId: "get_stats", summary: "Fetch stats", responses: { "200": { description: "ok" } } },
      },
      "/contacts": {
        post: {
          operationId: "send_mail",
          summary: "Send mail",
          parameters: [{ name: "campaign", in: "query", schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { to: { type: "string" }, count: { type: "integer" } } } } },
          },
          responses: { "200": { description: "ok" } },
        },
        get: { operationId: "list_contacts", summary: "List contacts", responses: { "200": { description: "ok" } } },
      },
      "/users/{id}": {
        delete: {
          operationId: "delete_user",
          summary: "Delete a user",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "gone" } },
        },
      },
      "/legacy": {
        get: { operationId: "old_op", deprecated: true, responses: { "200": { description: "ok" } } },
      },
    },
    ...overrides,
  };
}

describe("fetchOpenApiSpec (issue #345 caps)", () => {
  test("accepts a valid HTTPS OpenAPI 3.x document", async () => {
    const fetched = await fetchOpenApiSpec(
      "https://spec.example.test/openapi.json",
      jsonFetch(JSON.stringify(fixtureSpec())),
    );
    expect(fetched["openapi"]).toBe("3.0.3");
  });

  test("rejects a non-HTTPS spec URL (fail closed)", async () => {
    await expect(fetchOpenApiSpec("http://spec.example.test/openapi.json")).rejects.toThrow(OpenApiSpecError);
    await expect(fetchOpenApiSpec("http://spec.example.test/openapi.json")).rejects.toThrow(/HTTPS/);
  });

  test("rejects a document exceeding the 2MB cap (fail closed)", async () => {
    const oversized = "x".repeat(OPENAPI_MAX_SPEC_BYTES + 1);
    // The cap check happens on the raw body BEFORE parsing.
    await expect(
      fetchOpenApiSpec("https://spec.example.test/openapi.json", jsonFetch(oversized)),
    ).rejects.toThrow(/cap/);
  });

  test("rejects a document that is not OpenAPI 3.x (fail closed)", async () => {
    const swagger2 = { swagger: "2.0", info: {}, paths: {} };
    await expect(
      fetchOpenApiSpec("https://spec.example.test/openapi.json", jsonFetch(JSON.stringify(swagger2))),
    ).rejects.toThrow(/OpenAPI 3/);
  });

  test("rejects a non-JSON body (fail closed)", async () => {
    await expect(fetchOpenApiSpec("https://spec.example.test/openapi.json", jsonFetch("not json"))).rejects.toThrow(
      /not valid JSON/,
    );
  });

  test("rejects an HTTP error status (fail closed)", async () => {
    await expect(
      fetchOpenApiSpec("https://spec.example.test/openapi.json", jsonFetch("nope", 500)),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("generateOpenApiTools (issue #345 surface)", () => {
  test("names each operation <extension>_<operationId> with read/write tiers", () => {
    const { tools, operations } = generateOpenApiTools(fixtureSpec(), "sendgrid");
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.has("sendgrid_get_stats")).toBe(true);
    expect(byName.has("sendgrid_send_mail")).toBe(true);
    expect(byName.has("sendgrid_list_contacts")).toBe(true);
    expect(byName.has("sendgrid_delete_user")).toBe(true);
    // Deprecated is skipped.
    expect(byName.has("sendgrid_old_op")).toBe(false);
    // Tiers: GET → read; any non-GET mutation → write (issue #345).
    expect(byName.get("sendgrid_get_stats")!.tier).toBe("read");
    expect(byName.get("sendgrid_list_contacts")!.tier).toBe("read");
    expect(byName.get("sendgrid_send_mail")!.tier).toBe("write");
    expect(byName.get("sendgrid_delete_user")!.tier).toBe("write");
    // The review step lists every generated operation with its tier.
    expect(operations.length).toBe(4);
    expect(operations.find((op) => op.name === "sendgrid_delete_user")!.tier).toBe("write");
  });

  test("falls back to a method+path slug when operationId is missing", () => {
    const bad = cloneSpec(fixtureSpec());
    delete rec(rec(bad["paths"])["/stats"])["operationId"];
    const { tools } = generateOpenApiTools(bad, "sdk");
    expect(tools.some((tool) => tool.name === "sdk_get_stats")).toBe(true);
  });

  test("derives params from path/query parameters and JSON requestBody", () => {
    const { tools } = generateOpenApiTools(fixtureSpec(), "sendgrid");
    const mail = tools.find((tool) => tool.name === "sendgrid_send_mail")!;
    const paramNames = new Set(mail.params.map((param) => param.name));
    expect(paramNames.has("campaign")).toBe(true);
    // JSON body flattens to a single structured `body` param (jsonType object).
    expect(paramNames.has("body")).toBe(true);
    const body = mail.params.find((param) => param.name === "body")!;
    expect(body.jsonType).toBe("object");
    // Absent `required` means required by the manifest default (issue #248).
    expect(body.required).not.toBe(false);
    // Path param is required; query param without required flag is optional.
    const del = tools.find((tool) => tool.name === "sendgrid_delete_user")!;
    const id = del.params.find((param) => param.name === "id")!;
    expect(id.type).toBe("string");
    expect(id.required).not.toBe(false);
    const campaign = mail.params.find((param) => param.name === "campaign")!;
    expect(campaign.required).toBe(false);
  });

  test("defaults the tier to write for every non-GET method", () => {
    const patch = cloneSpec(fixtureSpec());
    rec(rec(patch["paths"])["/stats"])["patch"] = {
      operationId: "patch_stats",
      responses: { "200": { description: "ok" } },
    };
    const { tools } = generateOpenApiTools(patch, "sdk");
    expect(tools.find((tool) => tool.name === "sdk_patch_stats")!.tier).toBe("write");
  });

  test("caps the operation count at 200 (fail closed)", () => {
    const many: JsonObject = { paths: {} };
    const paths = rec(many["paths"]);
    for (let i = 0; i < OPENAPI_MAX_OPERATIONS + 5; i += 1) {
      paths[`/r${i}`] = { get: { operationId: `op_${i}`, responses: { "200": { description: "ok" } } } };
    }
    const spec: JsonObject = {
      openapi: "3.0.3",
      info: { title: "big", version: "1" },
      servers: [{ url: "https://api.example.test" }],
      paths: many["paths"],
    };
    expect(() => generateOpenApiTools(spec, "sdk")).toThrow(OpenApiSpecError);
    expect(() => generateOpenApiTools(spec, "sdk")).toThrow(/cap/);
  });

  test("fails closed on an internal name collision", () => {
    const spec = cloneSpec(fixtureSpec());
    rec(rec(spec["paths"])["/users/{id}"])["get"] = {
      operationId: "send_mail", // collides with the POST operationId
      responses: { "200": { description: "ok" } },
    };
    expect(() => generateOpenApiTools(spec, "sendgrid")).toThrow(/collides/);
  });

  test("fails closed on a reserved or already-registered tool name", () => {
    // extensionId `create` + operationId `work_item` → `create_work_item`,
    // which is a reserved bottega project tool name (issue #345: collision
    // with an existing tool name → pin fails closed).
    const reserveSpec: JsonObject = {
      openapi: "3.0.3",
      info: { title: "x", version: "1" },
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/wi": { get: { operationId: "work_item", responses: { "200": { description: "ok" } } } },
      },
    };
    expect(() => generateOpenApiTools(reserveSpec, "create")).toThrow(/collides/);
    // An already-registered tool surface is respected as a reserved set.
    expect(() =>
      generateOpenApiTools(fixtureSpec(), "sendgrid", { reservedNames: new Set(["sendgrid_get_stats"]) }),
    ).toThrow(/collides/);
  });
});

describe("openApiHosts (issue #345 egress allowlist)", () => {
  test("returns validated HTTPS origin hosts only", () => {
    expect(openApiHosts(fixtureSpec())).toEqual(["api.example.test"]);
  });

  test("derives a port-bearing HTTPS origin host", () => {
    const spec = { ...fixtureSpec(), servers: [{ url: "https://api.example.test:8443/v2" }] };
    expect(openApiHosts(spec)).toEqual(["api.example.test:8443"]);
  });

  test("fails closed on a missing servers array", () => {
    const spec = cloneSpec(fixtureSpec());
    delete spec["servers"];
    expect(() => openApiHosts(spec)).toThrow(/servers/);
  });

  test("fails closed on a non-HTTPS server", () => {
    const spec = { ...fixtureSpec(), servers: [{ url: "http://api.example.test" }] };
    expect(() => openApiHosts(spec)).toThrow(/HTTPS/);
  });

  test("fails closed on a relative or malformed server", () => {
    const spec = { ...fixtureSpec(), servers: [{ url: "/v1" }] };
    expect(() => openApiHosts(spec)).toThrow(/HTTPS/);
  });
});

describe("paramsFromOpenApiOperation (issue #345)", () => {
  test("skips cookie/header params (V1 scope is path+query+JSON body)", () => {
    // SAFETY: the object literal below is a JSON record — the cast re-narrows
    // a value the caller constructed as a record.
    const op: JsonObject = {
      parameters: [
        { name: "cookie", in: "cookie", schema: { type: "string" } },
        { name: "q", in: "query", schema: { type: "string" } },
      ],
    };
    const params = paramsFromOpenApiOperation(op);
    expect(params.map((param) => param.name)).toEqual(["q"]);
  });
});

describe("issue #345 constants", () => {
  test("the response bound is exposed for the executor layer", () => {
    expect(OPENAPI_RESPONSE_BOUND_BYTES).toBe(256 * 1024);
  });
});