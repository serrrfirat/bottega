/**
 * OpenAPI executor tests (issue #345): a hermetic fake upstream + fake
 * proxy asserting the core property — the executor sends NO credential, and
 * the egress layer injects the configured header (Authorization bearer or an
 * arbitrary apiKeyHeader) that the upstream sees. Also: bounded responses,
 * upstream 4xx/5xx → tool error naming the status, path/query/body request
 * building, unknown-arg refusal, and the fail-closed no-credential case.
 */
import { describe, expect, test } from "bun:test";
import {
  OPENAPI_RESPONSE_BOUND_BYTES,
  boundResponseText,
  buildOpenApiRequest,
  callOpenApiTool,
  type OpenApiEgressInject,
  type OpenApiEgressSeam,
} from "./openapi-executor";
import type { ExtensionManifest, ExtensionTool } from "./manifest";
import type { JsonObject } from "./manifest";

/** Named owner contract for a test auth binding (issue #345). */
interface TestAuthBinding {
  scheme: "bearer" | "apiKeyHeader";
  headerName?: string;
}

/** Builds the openapi auth binding with an optional header name (apiKeyHeader). */
function buildAuth(scheme: TestAuthBinding["scheme"], headerName?: string): TestAuthBinding {
  const auth: TestAuthBinding = { scheme };
  if (headerName !== undefined) auth.headerName = headerName;
  return auth;
}

/** A pinned openapi manifest binding a single origin host. */
function openApiManifest(auth: TestAuthBinding): ExtensionManifest {
  return {
    id: "sendgrid",
    label: "SendGrid",
    vendor: "SendGrid",
    kind: "openapi",
    openapi: {
      specUrl: "https://spec.example.test/openapi.json",
      auth: buildAuth(auth.scheme, auth.headerName),
    },
    credentialSchema: { type: "api_key" },
    tools: [],
    domains: ["api.sendgrid.test"],
    credentialTargets: [{ host: "api.sendgrid.test" }],
  };
}

/** A frozen openapi tool with method/path/param locations. */
function statsTool(): ExtensionTool {
  return {
    name: "sendgrid_get_stats",
    tier: "read",
    description: "Fetch stats",
    params: [
      { name: "campaign", type: "string", location: "query", required: false },
      { name: "id", type: "string", location: "path" },
    ],
    openapi: { method: "get", path: "/v3/stats/{id}" },
  };
}

/** A write-tier tool with a JSON body param. */
function sendTool(): ExtensionTool {
  return {
    name: "sendgrid_send_mail",
    tier: "write",
    description: "Send mail",
    params: [
      { name: "body", type: "string", jsonType: "object", location: "body" },
      { name: "tag", type: "string", location: "query", required: false },
    ],
    openapi: { method: "post", path: "/v3/mail/send" },
  };
}

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * A fake egress seam modeling the iron-proxy inject transform: it holds the
 * inject rule (header + formatter + secret) for the host and APPLIES it to
 * the executor's credential-free request before "forwarding" to a fake
 * upstream. This proves the producer side never sends the secret while the
 * injected header reaches the upstream — the end-to-end contract shape.
 */
function fakeEgress(opts: {
  header: string;
  formatter: string;
  secret: string;
  upstream: (req: CapturedRequest) => { status: number; body: string };
}): OpenApiEgressSeam & { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const inject: OpenApiEgressInject = { header: opts.header, formatter: opts.formatter };
  return {
    captured,
    injectForHost: (host) => (host === "api.sendgrid.test" ? inject : undefined),
    async fetchWire(request) {
      captured.push({ ...request, headers: { ...request.headers } });
      // Model the proxy transform: set the injected header from the secret.
      const value = opts.formatter.replace("{{ .Value }}", opts.secret);
      const headers = { ...request.headers, [opts.header]: value };
      const response = opts.upstream({ ...request, headers });
      return response;
    },
  };
}

describe("buildOpenApiRequest (issue #345)", () => {
  test("substitutes path params, appends query params, sets no auth header", () => {
    const request = buildOpenApiRequest(statsTool(), { id: "a/b", campaign: "c1" }, "https://api.sendgrid.test");
    expect(request.method).toBe("GET");
    expect(request.url).toContain("/v3/stats/a%2Fb");
    expect(request.url).toContain("campaign=c1");
    expect(request.headers["authorization"]).toBeUndefined();
    expect(request.headers["Authorization"]).toBeUndefined();
    expect(request.body).toBeUndefined();
  });

  test("serializes a JSON body param (issue #248 surface) and sets content-type", () => {
    const request = buildOpenApiRequest(sendTool(), { body: '{"to":"a@example.com"}' }, "https://api.sendgrid.test");
    expect(request.method).toBe("POST");
    expect(request.body).toBe('{"to":"a@example.com"}');
    expect(request.headers["content-type"]).toBe("application/json");
  });

  test("refuses to forward an unknown argument (fail closed)", () => {
    expect(() => buildOpenApiRequest(statsTool(), { id: "x", hacker: "leak" }, "https://api.sendgrid.test")).toThrow(
      /unexpected argument "hacker"/,
    );
  });

  test("fails closed on a missing required param", () => {
    expect(() => buildOpenApiRequest(statsTool(), {}, "https://api.sendgrid.test")).toThrow(/missing required/);
  });
});

describe("boundResponseText (issue #345)", () => {
  test("returns the body verbatim under the 256KB cap", () => {
    const small = "hello";
    expect(boundResponseText(small)).toBe(small);
  });

  test("truncates an oversized body with a marker", () => {
    const oversized = "x".repeat(OPENAPI_RESPONSE_BOUND_BYTES * 2 + 100);
    const bounded = boundResponseText(oversized);
    expect(bounded.length).toBeLessThan(oversized.length);
    expect(bounded).toContain("response truncated");
  });
});

describe("callOpenApiTool (issue #345 proxy-transform contract)", () => {
  test("GET read lands the injected bearer header at the fake upstream", async () => {
    const egress = fakeEgress({
      header: "Authorization",
      formatter: "Bearer {{ .Value }}",
      secret: "sssh-bearer",
      upstream: (req) => {
        expect(req.headers["Authorization"]).toBe("Bearer sssh-bearer");
        expect(req.headers["authorization"]).toBeUndefined();
        return { status: 200, body: '{"ok":true}' };
      },
    });
    const result = await callOpenApiTool(openApiManifest({ scheme: "bearer" }), statsTool(), argsOf({ id: "x" }), { egress });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content[0].text).toBe('{"ok":true}');
    expect(egress.captured[0].headers["Authorization"]).toBeUndefined(); // executor sent none
  });

  test("apiKeyHeader scheme injects an arbitrary header (X-Api-Key) at egress", async () => {
    const egress = fakeEgress({
      header: "X-Api-Key",
      formatter: "{{ .Value }}",
      secret: "key-123",
      upstream: (req) => {
        expect(req.headers["X-Api-Key"]).toBe("key-123");
        return { status: 200, body: "plain text response" };
      },
    });
    const result = await callOpenApiTool(
      openApiManifest({ scheme: "apiKeyHeader", headerName: "X-Api-Key" }),
      statsTool(),
      { id: "x" },
      { egress },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content[0].text).toBe("plain text response");
    expect(egress.captured[0].headers["X-Api-Key"]).toBeUndefined();
  });

  test("maps an upstream 4xx/5xx to a tool error naming the status", async () => {
    const egress = fakeEgress({
      header: "Authorization",
      formatter: "Bearer {{ .Value }}",
      secret: "x",
      upstream: () => ({ status: 401, body: '{"error":"nope"}' }),
    });
    const result = await callOpenApiTool(openApiManifest({ scheme: "bearer" }), statsTool(), argsOf({ id: "x" }), { egress });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("HTTP 401");
  });

  test("fails closed when no credential is provisioned for the host", async () => {
    const egress: OpenApiEgressSeam = {
      injectForHost: () => undefined,
      fetchWire: async () => {
        throw new Error("should not send");
      },
    };
    const result = await callOpenApiTool(openApiManifest({ scheme: "bearer" }), statsTool(), argsOf({ id: "x" }), { egress });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no provisioned credential");
  });

  test("a non-openapi manifest is refused", async () => {
    const cliManifest: ExtensionManifest = {
      id: "cli",
      label: "CLI",
      vendor: "CLI",
      kind: "cli",
      cli: { command: "/bin/true" },
      credentialSchema: { type: "api_key" },
      domains: [],
      credentialTargets: [],
    };
    const result = await callOpenApiTool(cliManifest, statsTool(), argsOf({ id: "x" }), {
      egress: fakeEgress({
        header: "Authorization",
        formatter: "Bearer {{ .Value }}",
        secret: "x",
        upstream: () => ({ status: 200, body: "hi" }),
      }),
    });
    expect(result.ok).toBe(false);
  });
});

/** A JsonObject-typed args view of a JSON-scalar literal (all values are JsonValue). */
function argsOf(record: Record<string, string | number | boolean | null>): JsonObject {
  return record;
}