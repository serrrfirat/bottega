/**
 * Headless extension journeys (issue #363): prove the real model-to-runtime
 * path, credential ladder, fail-closed overlays, and credential-safe boundary.
 */
import { describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { bootHarness, HEADLESS_HUMAN, type Harness } from "./harness";
import { createFixtureRegistry, FIXTURE_EXTENSION_ID } from "../../src/extensions/fixture";
import type { CredentialBoundary } from "../../src/extensions/boundary";
import type { ExtensionCredential, AuditRow, Store } from "../../src/store/db";
import type { JsonObject, McpBinding } from "../../src/extensions/manifest";
import { EXTENSION_CALL_EVENT, EXTENSION_CREDENTIAL_RESOLVED_EVENT, POLICY_DECISION_EVENT } from "../../src/store/audit-events";

function payload(row: AuditRow): JsonObject {
  // SAFETY: audit rows are serialized JSON objects by the store's append path.
  return JSON.parse(row.payload) as JsonObject;
}
async function seed(store: Store, scope: "org" | "personal", owner: string | null): Promise<ExtensionCredential> {
  return store.upsertExtensionCredential({
    provider: FIXTURE_EXTENSION_ID,
    identityKey: scope === "org" ? "email:org@example.com" : `email:${owner}@example.com`,
    owner,
    scope,
    brokerCredentialId: scope === "org" ? 7 : 8,
  });
}
function transport(): (binding: McpBinding) => Transport {
  return () => {
    const [client, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
    // SAFETY: this fixture always sends a JSON object of tool arguments with
    // the asserted city field to the MCP server.
    server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: `sunny in ${String((request.params.arguments as JsonObject)["city"] ?? "")}` }] }));
    void server.connect(serverTransport);
    return client;
  };
}
function registry() {
  return createFixtureRegistry();
}
function boundary(calls: ExtensionCredential[]): CredentialBoundary { return { async runWithAuthorization(request, invoke) { calls.push(request.credential); return invoke({ callId: request.callId, placeholder: "secret-placeholder", signal: new AbortController().signal }); } }; }

async function call(h: Harness, turns = 2): Promise<void> {
  await h.deliverMessage("ops", "weather in Lisbon");
  await h.modelStub.waitForRequests(turns);
}

describe("headless extension coverage", () => {
  test("synthetic extension crosses policy, ladder, boundary and provider", async () => {
    const calls: ExtensionCredential[] = [];
    const h = await bootHarness({ headless: true, registry: registry(), mcpTransport: transport(), extensionBoundary: boundary(calls), orgConfigYaml: "tools:\n  unknown: allow\nextensions:\n  allow:\n    - fixture.weather\n", modelTurns: [{ type: "tool_calls", calls: [{ name: "weather_current", args: { city: "Lisbon" } }] }, { type: "text", text: "done" }] });
    try { await seed(h.store, "org", null); await call(h); expect(calls).toHaveLength(1); expect(h.modelStub.latestMessages().some((m) => m.role === "tool" && String(m.content).includes("sunny in Lisbon"))).toBe(true); const rows = await h.store.listAudit({ event_type: EXTENSION_CALL_EVENT }); expect(payload(rows.at(-1)!)).toMatchObject({ credential_id: calls[0]!.id, decision: "allow" }); } finally { h.cleanup(); }
  });

  test("personal ladder and org credential clamp are honored", async () => {
    const calls: ExtensionCredential[] = []; const h = await bootHarness({ headless: true, registry: registry(), mcpTransport: transport(), extensionBoundary: boundary(calls), orgConfigYaml: "tools:\n  unknown: allow\nextensions:\n  org_credentials: deny\n", modelTurns: [{ type: "tool_calls", calls: [{ name: "weather_current", args: { city: "Oslo" } }] }, { type: "text", text: "ok" }] });
    try { await seed(h.store, "org", null); const me = await seed(h.store, "personal", HEADLESS_HUMAN); await call(h); expect(calls[0]!.id).toBe(me.id); } finally { h.cleanup(); }
  });

  test("deny overlays reject before credential resolution", async () => {
    const calls: ExtensionCredential[] = []; const h = await bootHarness({ headless: true, registry: registry(), mcpTransport: transport(), extensionBoundary: boundary(calls), orgConfigYaml: "tools:\n  unknown: allow\nextensions:\n  allow:\n    - fixture.weather\n  deny:\n    - fixture.weather\n", modelTurns: [{ type: "tool_calls", calls: [{ name: "weather_current", args: { city: "Oslo" } }] }, { type: "text", text: "ok" }] });
    try { await seed(h.store, "org", null); await call(h); expect(calls).toHaveLength(0); expect(await h.store.listAudit({ event_type: EXTENSION_CREDENTIAL_RESOLVED_EVENT })).toHaveLength(0); const decisions = await h.store.listAudit({ event_type: POLICY_DECISION_EVENT }); const denied = decisions.find((r) => payload(r).decision === "deny"); expect(denied).toBeDefined(); } finally { h.cleanup(); }
  });
});
