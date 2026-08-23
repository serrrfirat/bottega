/**
 * OpenAPI egress provisioner tests (issue #345): the production seam wired
 * into `ExtensionRuntimeDeps.openapiEgress`. `createOpenApiEgressSeam`
 * derives the proxy-side inject rule (header + formatter) from the openapi
 * manifest's auth scheme, FAILS CLOSED when the host has no openapi
 * extension or its static secret is not provisioned, and routes the
 * CREDENTIAL-FREE request through the given fetch (production: the global
 * fetch, whose Bun-native HTTP_PROXY/HTTPS_PROXY wiring rides the
 * iron-proxy tunnel). The seam attaches NO auth header — the proxy injects.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionSecretFileName } from "./boundary";
import { createOpenApiEgressSeam } from "./openapi-egress";
import type { OpenApiWireRequest } from "./openapi-executor";
import type { ExtensionRegistry, ResolvedExtension } from "./registry";
import type { JsonObject } from "./manifest";

function openApiManifest(auth: { scheme: "bearer" | "apiKeyHeader"; headerName?: string }): JsonObject {
  return {
    id: "sendgrid",
    label: "SendGrid",
    vendor: "SendGrid",
    kind: "openapi",
    openapi: {
      specUrl: "https://spec.example.test/openapi.json",
      auth,
    },
    credentialSchema: { type: "api_key" },
    tools: [],
    domains: ["api.sendgrid.test"],
    credentialTargets: [{ host: "api.sendgrid.test" }],
  };
}

function registryWith(manifest: JsonObject): Pick<ExtensionRegistry, "list"> {
  // SAFETY: the resolved-extensions surface only needs the openapi-arm
  // manifest here (the seam reads manifest.kind === "openapi", domains,
  // openapi.auth); the JsonObject fixture is that arm — the cast re-narrows
  // without ever widening to another kind.
  const resolved: ResolvedExtension = { manifest: manifest as never };
  return { list: () => [resolved] };
}

describe("createOpenApiEgressSeam (issue #345)", () => {
  test("injectForHost returns the bearer rule when the static secret is provisioned", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-seam-"));
    try {
      writeFileSync(join(dir, extensionSecretFileName("sendgrid")), "sk-live");
      const seam = createOpenApiEgressSeam({
        registry: registryWith(openApiManifest({ scheme: "bearer" })),
        secretsDir: dir,
      });
      expect(seam.injectForHost("api.sendgrid.test")).toEqual({
        header: "Authorization",
        formatter: "Bearer {{ .Value }}",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("injectForHost returns the apiKeyHeader rule (headerName + bare formatter) when provisioned", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-seam-"));
    try {
      writeFileSync(join(dir, extensionSecretFileName("sendgrid")), "sk-live");
      const seam = createOpenApiEgressSeam({
        registry: registryWith(openApiManifest({ scheme: "apiKeyHeader", headerName: "X-Api-Key" })),
        secretsDir: dir,
      });
      expect(seam.injectForHost("api.sendgrid.test")).toEqual({
        header: "X-Api-Key",
        formatter: "{{ .Value }}",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("injectForHost FAILS CLOSED when the static secret is not provisioned (no connect)", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-seam-"));
    try {
      // No secret file written — the connect never provisioned the key.
      const seam = createOpenApiEgressSeam({
        registry: registryWith(openApiManifest({ scheme: "bearer" })),
        secretsDir: dir,
      });
      expect(seam.injectForHost("api.sendgrid.test")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("injectForHost FAILS CLOSED for a host with no openapi extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "openapi-seam-"));
    try {
      const seam = createOpenApiEgressSeam({
        registry: { list: () => [] },
        secretsDir: dir,
      });
      expect(seam.injectForHost("api.sendgrid.test")).toBeUndefined();
      expect(seam.injectForHost("some-other.host")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fetchWire routes the credential-free request through the injected fetch and returns status+body", async () => {
    const captured: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    const fetchImpl: typeof fetch = Object.assign(
      // SAFETY: the stub implements fetch's call contract (input, init?) =>
      // Promise<Response>; Bun's fetch also exposes fetch.preconnect, which
      // the seam's fetchWire never calls.
      (async (input: string | URL | Request, init?: RequestInit) => {
        captured.push({
          url: input.toString(),
          method: (init?.method ?? "GET").toUpperCase(),
          // SAFETY: RequestInit.headers is a Record<string,string> (or
          // Headers); the seam passes a plain object of string headers, so
          // the cast re-narrows to what the captured shape holds.
          headers: (init?.headers ?? {}) as Record<string, string>,
          ...(init?.body !== undefined ? { body: String(init.body) } : undefined),
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
      { preconnect: fetch.preconnect },
    );
    const dir = mkdtempSync(join(tmpdir(), "openapi-seam-"));
    try {
      writeFileSync(join(dir, extensionSecretFileName("sendgrid")), "sk-live");
      const seam = createOpenApiEgressSeam({
        registry: registryWith(openApiManifest({ scheme: "bearer" })),
        secretsDir: dir,
        fetchImpl,
      });
      const request: OpenApiWireRequest = {
        method: "GET",
        url: "https://api.sendgrid.test/v3/stats?campaign=c1",
        headers: {},
      };
      const response = await seam.fetchWire(request);
      expect(response.status).toBe(200);
      expect(response.body).toBe(JSON.stringify({ ok: true }));
      // The seam attaches NO auth header — iron-proxy injects it at egress.
      expect(captured).toHaveLength(1);
      expect(captured[0]!.url).toBe("https://api.sendgrid.test/v3/stats?campaign=c1");
      expect(captured[0]!.headers["Authorization"]).toBeUndefined();
      expect(captured[0]!.headers["authorization"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});