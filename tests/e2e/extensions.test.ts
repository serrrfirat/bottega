/**
 * Journey (issue #66): Extensions + policy.
 *
 * User journeys over REAL bottega components with emulated boundaries, per
 * the issue #66 harness contract:
 *
 *   real:     SQLite store (temp file), policy (org floor + space overlay),
 *             audit trail, connect capability, extension runtime, policy
 *             gate, Slack-backed approval router.
 *   emulated: extension MCP transport (in-memory stub).
 *
 * The harness contract (tests/e2e/harness.ts, issue #66) is the same shape;
 * while it is not on main yet this file carries a minimal local fixture and
 * merges into the shared harness when it lands. The stub MCP transport is a
 * journey-local boundary by contract. (The connect capability's own flows —
 * personal/org, gate, catalog — are covered at the capability level in
 * src/extensions/connect.test.ts; since #273 the connect-intent regex
 * pre-route is gone, so there is no space-service seam to journey here.)
 *
 * Coverage:
 *   1. extension tool call — runtime through the stub MCP transport with
 *      the credential ladder (org / me / auto) and the policy gate
 *      (deny-before-tier: an extension outside the space allowlist denies
 *      before any credential resolution) + audit rows.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createAudit } from "../../src/policy/audit";
import { DenyRouter } from "../../src/policy/approval-router";
import { parseOrgConfigYaml, type PolicyConfig } from "../../src/policy/config";
import { createStore, type AuditRow, type ExtensionCredential, type Store } from "../../src/store/db";
import {
  EXTENSION_CALL_EVENT,
  EXTENSION_CREDENTIAL_RESOLVED_EVENT,
  POLICY_DECISION_EVENT,
} from "../../src/store/audit-events";
import type { CallScope } from "../../src/extensions/credentials";
import { createFixtureRegistry, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL, fixtureManifest } from "../../src/extensions/fixture";
import type { ExtensionManifest, JsonObject, McpBinding } from "../../src/extensions/manifest";
import { createExtensionRuntime, type ExtensionRuntime, type ExtensionRuntimeDeps } from "../../src/extensions/runtime";
import type { CredentialBoundary } from "../../src/extensions/boundary";

// ---------------------------------------------------------------------------
// Local harness (mirrors the issue #66 contract until tests/e2e/harness.ts
// lands; the shared harness then owns the store/adapter/space-service and
// this file keeps only its journey-local boundaries: broker, MCP transport).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "bottega-e2e-ext-"));
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const store = createStore(join(dir, `store-${stores.length}.db`));
  stores.push(store);
  return store;
}

function parse(row: AuditRow): JsonObject {
  // SAFETY: every audit payload is written via JSON.stringify as a JSON
  // object (the audit writers all serialize records).
  return JSON.parse(row.payload) as JsonObject;
}

function seedOrgCredential(store: Store, provider = FIXTURE_EXTENSION_ID): Promise<ExtensionCredential> {
  return store.upsertExtensionCredential({
    provider,
    identityKey: "email:org@example.com",
    owner: null,
    scope: "org",
    brokerCredentialId: 7,
  });
}

function seedPersonalCredential(store: Store, provider: string, owner: string): Promise<ExtensionCredential> {
  return store.upsertExtensionCredential({
    provider,
    identityKey: `email:${owner.toLowerCase()}@example.com`,
    owner,
    scope: "personal",
    brokerCredentialId: 8,
  });
}

/** Second registered extension so the space allowlist can exclude one while staying non-empty (issue #56). */
function secondManifest(): ExtensionManifest {
  const base = fixtureManifest();
  return {
    ...base,
    id: "fixture.history",
    label: "Fixture History",
    tools: [
      {
        ...base.tools![0],
        name: "history.current",
        description: "History for a city (fixture extension)",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 2. Extension tool call through the real runtime (issue #53) with the stub
//    MCP transport, the credential ladder (issue #51) and the policy gate
//    (issue #56 deny-before-tier).
// ---------------------------------------------------------------------------

interface RuntimeHarness {
  runtime: ExtensionRuntime;
  store: Store;
  boundary: CredentialBoundary & { calls: ExtensionCredential[] };
  transports: { bindings: McpBinding[] };
}

function makeRuntimeHarness(opts: {
  policy?: PolicyConfig;
  callScope?: CallScope;
  mcpTransport?: (binding: McpBinding) => Transport;
} = {}): RuntimeHarness {
  const registry = createFixtureRegistry();
  registry.register(secondManifest());
  const store = freshStore();
  const boundary: CredentialBoundary & { calls: ExtensionCredential[] } = {
    calls: [],
    async runWithAuthorization(request, invoke) {
      boundary.calls.push(request.credential);
      return invoke({
        callId: request.callId,
        placeholder: "test-placeholder",
        signal: new AbortController().signal,
      });
    },
  };
  // SAFETY: the stub transport records every binding the runtime requests;
  // the array starts empty and only McpBinding values are pushed below.
  const transports = { bindings: [] as McpBinding[] };
  const mcpTransport =
    opts.mcpTransport ??
    ((binding: McpBinding) => {
      transports.bindings.push(binding);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        // SAFETY: the fixture call passes the tool arguments JSON from the
        // stub transport, which forwards the caller's object verbatim.
        const args = request.params.arguments as JsonObject;
        return { content: [{ type: "text", text: `sunny in ${String(args["city"] ?? "")}` }] };
      });
      void server.connect(serverTransport);
      return clientTransport;
    });
  const deps: ExtensionRuntimeDeps = {
    registry,
    store,
    audit: createAudit(store),
    orgPolicy: opts.policy ?? parseOrgConfigYaml("tools:\n  unknown: allow\n"),
    router: DenyRouter,
    boundary,
    mcpTransport,
    callScope: opts.callScope,
  };
  return { runtime: createExtensionRuntime(deps), store, boundary, transports };
}

describe("journey 3: extension tool call through the runtime (stub MCP transport)", () => {
  test("allowlisted extension: org ladder → boundary → stub MCP → full audit trail", async () => {
    const h = makeRuntimeHarness({
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\nextensions:\n  allow:\n    - fixture.weather\n"),
    });
    const org = await seedOrgCredential(h.store);

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Lisbon" },
      caller: "UADA",
      spaceId: "slack:C1",
    });

    expect(result).toEqual({ ok: true, content: [{ type: "text", text: "sunny in Lisbon" }] });
    // The ladder resolved the org row and the boundary received it.
    expect(h.boundary.calls).toEqual([org]);
    // The provider call went out over the injected transport.
    expect(h.transports.bindings).toHaveLength(1);
    // The trail carries policy decision, resolution, and call rows.
    const decisions = await h.store.listAudit({ event_type: POLICY_DECISION_EVENT });
    expect(parse(decisions.at(-1)!)).toMatchObject({ tool: FIXTURE_EXTENSION_TOOL, tier: "read", decision: "allow" });
    const resolved = await h.store.listAudit({ event_type: EXTENSION_CREDENTIAL_RESOLVED_EVENT });
    expect(parse(resolved[0]!)).toMatchObject({
      provider: FIXTURE_EXTENSION_ID,
      scope: "org",
      credential_id: org.id,
      broker_credential_id: 7,
    });
    const calls = await h.store.listAudit({ event_type: EXTENSION_CALL_EVENT });
    expect(calls[0]!.space_id).toBe("slack:C1");
    expect(calls[0]!.actor).toBe("UADA");
    expect(parse(calls[0]!)).toMatchObject({
      extension: FIXTURE_EXTENSION_ID,
      tool: FIXTURE_EXTENSION_TOOL,
      credential_id: org.id,
      decision: "allow",
    });
  });

  test("deny-before-tier: an extension outside the space allowlist denies before any credential resolution", async () => {
    // Org floor allowlists both fixture extensions; the space overlay removes
    // fixture.weather (overlays can only tighten — issue #56).
    const h = makeRuntimeHarness({
      policy: parseOrgConfigYaml(
        "tools:\n  unknown: allow\nextensions:\n  allow:\n    - fixture.weather\n    - fixture.history\n",
      ),
    });
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    await h.store.updatePolicy("slack:C1", JSON.stringify({ extensions: { allow: [FIXTURE_EXTENSION_ID] } }));
    await seedOrgCredential(h.store);

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Oslo" },
      caller: "UADA",
      spaceId: "slack:C1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not in this space's extension allowlist");
    // Deny-before-tier: no credential resolution, no boundary write, no provider call.
    expect(await h.store.listAudit({ event_type: EXTENSION_CREDENTIAL_RESOLVED_EVENT })).toHaveLength(0);
    expect(h.boundary.calls).toHaveLength(0);
    expect(h.transports.bindings).toHaveLength(0);
    // ...but the deny itself is on the trail, with no credential id.
    const calls = await h.store.listAudit({ event_type: EXTENSION_CALL_EVENT });
    expect(calls[0]!.space_id).toBe("slack:C1");
    expect(parse(calls[0]!)).toMatchObject({
      extension: FIXTURE_EXTENSION_ID,
      tool: FIXTURE_EXTENSION_TOOL,
      actor: "UADA",
      credential_id: null,
      decision: "deny",
    });
    const decisions = await h.store.listAudit({ event_type: POLICY_DECISION_EVENT });
    expect(parse(decisions.at(-1)!)).toMatchObject({ tool: FIXTURE_EXTENSION_TOOL, decision: "deny" });
  });

  test("me ladder: personal scope resolves the caller's row even when an org row exists", async () => {
    const h = makeRuntimeHarness({
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\n"),
      callScope: "me",
    });
    await seedOrgCredential(h.store);
    const personal = await seedPersonalCredential(h.store, FIXTURE_EXTENSION_ID, "UADA");

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Oslo" },
      caller: "UADA",
    });

    expect(result.ok).toBe(true);
    expect(h.boundary.calls).toEqual([personal]);
    const calls = await h.store.listAudit({ event_type: EXTENSION_CALL_EVENT });
    expect(parse(calls[0]!)).toMatchObject({ credential_id: personal.id, decision: "allow" });
  });

  test("auto ladder: org_credentials deny → the caller's personal credential wins", async () => {
    const h = makeRuntimeHarness({
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\nextensions:\n  org_credentials: deny\n"),
    });
    await seedOrgCredential(h.store);
    const personal = await seedPersonalCredential(h.store, FIXTURE_EXTENSION_ID, "UADA");

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Oslo" },
      caller: "UADA",
    });

    expect(result.ok).toBe(true);
    expect(h.boundary.calls).toEqual([personal]);
  });
});
