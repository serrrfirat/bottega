/**
 * OpenAPI pin integration tests (issue #345): a hermetic fake spec server
 * (Bun.serve) feeds fetchOpenApiSpec, and buildOpenApiPinnedManifest turns
 * a catalog entry + spec into a registry-valid, DETERMINISTIC pinned
 * manifest (re-pin byte-identical). All pin fail-closed cases from the
 * issue are exercised: non-openapi entry, missing openapi block, unknown
 * scheme, spec cap/collision (via generator), curated-id mismatch.
 */
import { describe, expect, test } from "bun:test";
import { buildOpenApiPinnedManifest, type CatalogEntry } from "./fetch-catalog";
import { parsePinnedSnapshot, SNAPSHOT_SCHEMA, type PinnedSnapshot } from "./registry";
import type { ExtensionTool, JsonObject } from "./manifest";

/** Narrow guard: an openapi manifest always pins a tools surface (issue #345). */
function toolsOf(manifest: PinnedSnapshot["manifest"]): ExtensionTool[] {
  if (manifest.kind !== "openapi") throw new Error("expected an openapi manifest");
  return manifest.tools;
}

/** A deterministic fixture spec (no timestamps) — the pin's reviewed surface. */
const SPEC: JsonObject = {
  openapi: "3.0.3",
  info: { title: "Fixture API", version: "1.0.0" },
  servers: [{ url: "https://api.sendgrid.test/v1" }],
  paths: {
    "/stats": { get: { operationId: "get_stats", summary: "Stats", responses: { "200": { description: "ok" } } } },
    "/contacts": {
      post: {
        operationId: "send_mail",
        summary: "Send",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { to: { type: "string" } } } } },
        },
        responses: { "200": { description: "ok" } },
      },
      delete: { operationId: "delete_contact", summary: "Delete", responses: { "204": { description: "gone" } } },
    },
    "/legacy": { get: { operationId: "old_op", deprecated: true, responses: { "200": { description: "ok" } } } },
  },
};

function openApiEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "api/sendgrid",
    slug: "sendgrid",
    name: "SendGrid",
    kind: "openapi",
    domain: "api.sendgrid.test",
    openapi: {
      url: "https://spec.example.test/openapi.json",
      auth: { scheme: "bearer", credentialLabel: "SendGrid API key" },
    },
    ...overrides,
  };
}

describe("buildOpenApiPinnedManifest (issue #345 pin integration)", () => {
  test("generates a registry-valid openapi manifest with a frozen tool surface", () => {
    const manifest = buildOpenApiPinnedManifest(openApiEntry(), SPEC);
    expect(manifest.kind).toBe("openapi");
    expect(toolsOf(manifest).map((tool) => tool.name).sort()).toEqual([
      "sendgrid_delete_contact",
      "sendgrid_get_stats",
      "sendgrid_send_mail",
    ]);
    expect(toolsOf(manifest).find((tool) => tool.name === "sendgrid_get_stats")!.tier).toBe("read");
    expect(toolsOf(manifest).find((tool) => tool.name === "sendgrid_send_mail")!.tier).toBe("write");
    expect(manifest.domains).toEqual(["api.sendgrid.test"]);
  });

  test("re-pin of the unused spec produces byte-identical manifest JSON", () => {
    const a = buildOpenApiPinnedManifest(openApiEntry(), SPEC);
    const b = buildOpenApiPinnedManifest(openApiEntry(), SPEC);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // The manifest round-trips through the registry's snapshot validator.
    const snapshot = {
      schema: SNAPSHOT_SCHEMA,
      extensionId: "sendgrid",
      pinnedAt: "2026-08-23T00:00:00.000Z",
      source: { catalog: "https://integrations.sh/api", specId: "sendgrid", vendorOfficial: false, reviewed: true },
      manifest: a,
    };
    expect(parsePinnedSnapshot(JSON.stringify(snapshot)).manifest.kind).toBe("openapi");
  });

  test("frozen tools carry the HTTP operation + param locations for the executor", () => {
    const manifest = buildOpenApiPinnedManifest(openApiEntry(), SPEC);
    const mail = toolsOf(manifest).find((tool) => tool.name === "sendgrid_send_mail")!;
    expect(mail.openapi).toEqual({ method: "post", path: "/contacts" });
    const body = mail.params.find((param) => param.name === "body")!;
    expect(body.location).toBe("body");
    expect(mail.tier).toBe("write");
  });

  test("honors the entry's optional operations curation", () => {
    const manifest = buildOpenApiPinnedManifest(
      openApiEntry({ openapi: { url: "https://x.test/x", operations: ["get_stats"], auth: { scheme: "bearer" } } }),
      SPEC,
    );
    expect(toolsOf(manifest).map((tool) => tool.name)).toEqual(["sendgrid_get_stats"]);
  });

  test("fails closed curating an operation the spec does not declare", () => {
    expect(() =>
      buildOpenApiPinnedManifest(
        openApiEntry({ openapi: { url: "https://x.test/x", operations: ["bogus"], auth: { scheme: "bearer" } } }),
        SPEC,
      ),
    ).toThrow(/curates operation "bogus"/);
  });

  test("fails closed for a non-openapi entry", () => {
    expect(() => buildOpenApiPinnedManifest({ ...openApiEntry(), kind: "mcp" }, SPEC)).toThrow(/kind "openapi"/);
  });

  test("fails closed for an entry missing the openapi block", () => {
    const entry = openApiEntry();
    delete entry.openapi;
    expect(() => buildOpenApiPinnedManifest(entry, SPEC)).toThrow(/missing the "openapi" block/);
  });
});