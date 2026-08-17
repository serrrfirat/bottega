import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudit } from "../policy/audit";
import type { ApprovalRequest, ApprovalResolution, ApprovalRouter } from "../policy/approval-router";
import { parseOrgConfigYaml, type PolicyConfig } from "../policy/config";
import {
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_RESOLVED_EVENT,
  EXTENSION_CONNECTED_EVENT,
  POLICY_DECISION_EVENT,
} from "../store/audit-events";
import { createStore, type Store } from "../store/db";
import {
  apiKeyIdentityKey,
  connectExtension,
  CONNECT_EXTENSION_TOOL,
  connectExtensionToolDefinition,
  pickNewestBrokerEntry,
  type BrokerConnectResult,
  type ConnectExtensionDeps,
  type ConnectScope,
} from "./connect";
import { fixtureManifest } from "./fixture";
import type { ExtensionManifest } from "./manifest";
import { createExtensionRegistry, type ExtensionRegistry } from "./registry";

const dir = mkdtempSync(join(tmpdir(), "bottega-connect-"));
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const store = createStore(join(dir, `test-${stores.length}.db`));
  stores.push(store);
  return store;
}

/** OAuth-shaped manifest (the fixture is api_key; Linear/GitHub-style providers are oauth). */
function oauthManifest(): ExtensionManifest {
  const base = fixtureManifest();
  return {
    ...base,
    id: "com.example.oauth",
    label: "Example OAuth",
    credentialSchema: { type: "oauth", scopes: ["read"] },
    tools: [{ ...base.tools![0], name: "oauth.current" }],
  };
}

function registry(): ExtensionRegistry {
  const r = createExtensionRegistry();
  r.register(fixtureManifest());
  r.register(oauthManifest());
  return r;
}

class RecordingRouter implements ApprovalRouter {
  readonly requests: ApprovalRequest[] = [];
  constructor(private resolution: ApprovalResolution = { approved: true }) {}
  async request(d: ApprovalRequest): Promise<ApprovalResolution> {
    this.requests.push(d);
    return this.resolution;
  }
}

class RecordingBroker {
  readonly calls: Array<{ provider: string; credentialType: string; apiKey?: string }> = [];
  result: BrokerConnectResult;
  constructor(result: BrokerConnectResult = { identityKey: null, brokerCredentialId: 9 }) {
    this.result = result;
  }
  async connect(input: { provider: string; credentialType: string; apiKey?: string }): Promise<BrokerConnectResult> {
    this.calls.push(input);
    return this.result;
  }
}

function defaultPolicy(): PolicyConfig {
  return parseOrgConfigYaml(""); // fail-closed default: connect_extension denied
}

function allowedPolicy(): PolicyConfig {
  return parseOrgConfigYaml("tools:\n  connect_extension: allow\n");
}

interface Harness {
  deps: ConnectExtensionDeps;
  store: Store;
  router: RecordingRouter;
  broker: RecordingBroker;
}

function makeDeps(overrides: { policy?: PolicyConfig; router?: RecordingRouter; broker?: RecordingBroker } = {}): Harness {
  const store = freshStore();
  const router = overrides.router ?? new RecordingRouter();
  const broker = overrides.broker ?? new RecordingBroker();
  const policy = overrides.policy ?? defaultPolicy();
  return {
    deps: {
      registry: registry(),
      store,
      audit: createAudit(store),
      broker: broker.connect.bind(broker),
      gate: { loadPolicy: () => Promise.resolve(policy), router },
    },
    store,
    router,
    broker,
  };
}

async function connect(h: Harness, extension: string, scope: ConnectScope, actor: string, extra: { spaceId?: string; apiKey?: string } = {}) {
  return connectExtension({ extension, scope, actor, spaceId: extra.spaceId, apiKey: extra.apiKey }, h.deps);
}

function rowsFor(store: Store, provider: string) {
  return store.listExtensionCredentials(provider);
}

describe("connectExtension scope gating", () => {
  test("personal connect runs for any principal without the policy gate (even under a denying policy)", async () => {
    const h = makeDeps({ policy: parseOrgConfigYaml("tools:\n  connect_extension: deny\n") });

    const outcome = await connect(h, "fixture.weather", "personal", "UADA");

    expect(outcome).toMatchObject({ ok: true });
    expect(h.router.requests).toHaveLength(0); // gate never consulted
    expect(h.broker.calls).toEqual([{ provider: "fixture.weather", credentialType: "api_key" }]);
    const rows = await rowsFor(h.store, "fixture.weather");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBe("UADA");
    expect(rows[0]!.scope).toBe("personal");
    expect(rows[0]!.broker_credential_id).toBe(9);
  });

  test("personal connect passes the api_key through to the broker seam", async () => {
    const h = makeDeps({ broker: new RecordingBroker({ identityKey: null, brokerCredentialId: 4 }) });

    const outcome = await connect(h, "fixture.weather", "personal", "UADA", { apiKey: "attio-secret-key" });

    expect(outcome.ok).toBe(true);
    expect(h.broker.calls[0]!.apiKey).toBe("attio-secret-key");
  });

  test("org connect is blocked by the fail-closed default policy without touching the broker", async () => {
    const h = makeDeps();

    const outcome = await connect(h, "fixture.weather", "org", "UADA");

    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false ? outcome.message : "").toContain("policy");
    expect(h.router.requests).toHaveLength(0);
    expect(h.broker.calls).toHaveLength(0);
    expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(0);
  });

  test("org connect is blocked when the policy denies the tool", async () => {
    const h = makeDeps({ policy: parseOrgConfigYaml("tools:\n  connect_extension: deny\n") });
    const outcome = await connect(h, "fixture.weather", "org", "UADA");
    expect(outcome.ok).toBe(false);
  });

  test("org connect routes through ask-human and connects when approved", async () => {
    const router = new RecordingRouter({ approved: true });
    const broker = new RecordingBroker({ identityKey: "org-key@example.com", brokerCredentialId: 7 });
    const h = makeDeps({ policy: allowedPolicy(), router, broker });

    const outcome = await connect(h, "fixture.weather", "org", "UADA", { spaceId: "slack:C1" });

    expect(outcome).toMatchObject({ ok: true });
    expect(h.router.requests).toHaveLength(1);
    expect(h.router.requests[0]!.tool).toBe(CONNECT_EXTENSION_TOOL);
    expect(h.router.requests[0]!.spaceId).toBe("slack:C1");
    expect(h.broker.calls).toEqual([{ provider: "fixture.weather", credentialType: "api_key" }]);
    const rows = await rowsFor(h.store, "fixture.weather");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBeNull();
    expect(rows[0]!.scope).toBe("org");
    expect(rows[0]!.identity_key).toBe("org-key@example.com");
  });

  test("org connect is blocked when the human denies", async () => {
    const router = new RecordingRouter({ approved: false });
    const h = makeDeps({ policy: allowedPolicy(), router });

    const outcome = await connect(h, "fixture.weather", "org", "UADA");

    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false ? outcome.message : "").toContain("approval denied");
    expect(h.broker.calls).toHaveLength(0);
    expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(0);
  });
});

describe("connectExtension broker seam", () => {
  test("oauth providers drive the oauth broker flow", async () => {
    const h = makeDeps({ broker: new RecordingBroker({ identityKey: "email:ada@example.com", brokerCredentialId: 5 }) });

    const outcome = await connect(h, "com.example.oauth", "personal", "UADA");

    expect(outcome.ok).toBe(true);
    expect(h.broker.calls).toEqual([{ provider: "com.example.oauth", credentialType: "oauth" }]);
  });

  test("api-key vault rows get a stable registry identity (org)", async () => {
    const h = makeDeps({ policy: allowedPolicy() });
    const outcome = await connect(h, "fixture.weather", "org", "UADA", { apiKey: "k" });
    expect(outcome.ok).toBe(true);
    const rows = await rowsFor(h.store, "fixture.weather");
    expect(rows[0]!.identity_key).toBe("api-key:fixture.weather");
  });

  test("api-key vault rows get a stable registry identity (personal)", async () => {
    const h = makeDeps();
    const outcome = await connect(h, "fixture.weather", "personal", "UADA");
    expect(outcome.ok).toBe(true);
    const rows = await rowsFor(h.store, "fixture.weather");
    expect(rows[0]!.identity_key).toBe("api-key:UADA");
  });

  test("a broker failure fails the connect without writing anything", async () => {
    const failing = { connect: async () => Promise.reject(new Error("broker unreachable")) };
    const h = makeDeps({ broker: failing as never });

    const outcome = await connect(h, "fixture.weather", "personal", "UADA");

    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false ? outcome.message : "").toContain("broker unreachable");
    expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(0);
    expect(await h.store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT })).toHaveLength(0);
  });
});

describe("connectExtension re-connect", () => {
  test("re-connecting personal updates the existing row, never duplicates", async () => {
    const h = makeDeps();
    h.broker.result = { identityKey: null, brokerCredentialId: 1 };
    const a = await connect(h, "com.example.oauth", "personal", "UADA");
    h.broker.result = { identityKey: "email:ada@example.com", brokerCredentialId: 2 };
    const b = await connect(h, "com.example.oauth", "personal", "UADA");

    expect(a.ok && b.ok).toBe(true);
    const rows = await rowsFor(h.store, "com.example.oauth");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.broker_credential_id).toBe(2);
    expect(rows[0]!.identity_key).toBe("email:ada@example.com");
  });

  test("re-connecting org updates the existing row, never duplicates", async () => {
    const h = makeDeps({ policy: allowedPolicy() });
    h.broker.result = { identityKey: "org-a", brokerCredentialId: 1 };
    const a = await connect(h, "fixture.weather", "org", "UADA");
    h.broker.result = { identityKey: "org-b", brokerCredentialId: 2 };
    const b = await connect(h, "fixture.weather", "org", "UADA");

    expect(a.ok && b.ok).toBe(true);
    const rows = await rowsFor(h.store, "fixture.weather");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.broker_credential_id).toBe(2);
    expect(rows[0]!.identity_key).toBe("org-b");
  });

  test("one personal row per owner: two principals get two rows", async () => {
    const h = makeDeps();
    await connect(h, "fixture.weather", "personal", "UADA");
    await connect(h, "fixture.weather", "personal", "UBOB");
    const rows = await rowsFor(h.store, "fixture.weather");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.owner).sort()).toEqual(["UADA", "UBOB"]);
  });
});

describe("connectExtension audit + feedback", () => {
  test("every connect writes extension.connected {extension, scope, owner}", async () => {
    const personalHarness = makeDeps();
    await connect(personalHarness, "fixture.weather", "personal", "UADA", { spaceId: "slack:C1" });
    const orgHarness = makeDeps({ policy: allowedPolicy() });
    await connect(orgHarness, "fixture.weather", "org", "UBOB");

    const personalRows = await personalHarness.store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT });
    expect(personalRows).toHaveLength(1);
    expect(personalRows[0]!.actor).toBe("UADA");
    expect(personalRows[0]!.space_id).toBe("slack:C1");
    expect(JSON.parse(personalRows[0]!.payload)).toEqual({ extension: "fixture.weather", scope: "personal", owner: "UADA" });

    const orgRows = await orgHarness.store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT });
    expect(JSON.parse(orgRows[0]!.payload)).toEqual({ extension: "fixture.weather", scope: "org", owner: null });
  });

  test("org connects carry the gate's policy + approval audit rows", async () => {
    const h = makeDeps({ policy: allowedPolicy() });
    await connect(h, "fixture.weather", "org", "UADA");

    const decisions = await h.store.listAudit({ event_type: POLICY_DECISION_EVENT });
    expect(decisions.some((r) => JSON.parse(r.payload).tool === CONNECT_EXTENSION_TOOL)).toBe(true);
    const requested = await h.store.listAudit({ event_type: APPROVAL_REQUESTED_EVENT });
    expect(requested.some((r) => JSON.parse(r.payload).tool === CONNECT_EXTENSION_TOOL)).toBe(true);
    const resolved = await h.store.listAudit({ event_type: APPROVAL_RESOLVED_EVENT });
    expect(
      resolved.some(
        (r) => JSON.parse(r.payload).tool === CONNECT_EXTENSION_TOOL && JSON.parse(r.payload).approved === true,
      ),
    ).toBe(true);
  });

  test("feedback messages match the issue's wording", async () => {
    const personal = makeDeps();
    const p = await connect(personal, "fixture.weather", "personal", "UADA");
    expect(p.ok === true ? p.message : "").toBe("Fixture Weather connected as @UADA");

    const org = makeDeps({ policy: allowedPolicy() });
    const o = await connect(org, "fixture.weather", "org", "UADA");
    expect(o.ok === true ? o.message : "").toBe("Fixture Weather connected as an organization");
  });
});

describe("connectExtension unknown extension", () => {
  test("unknown extension ids fail before touching the broker or the store", async () => {
    const h = makeDeps();

    const outcome = await connect(h, "com.nope", "personal", "UADA");

    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false ? outcome.message : "").toContain("unknown extension");
    expect(h.router.requests).toHaveLength(0);
    expect(h.broker.calls).toHaveLength(0);
  });
});

describe("connectExtensionToolDefinition", () => {
  test("execute connects with the session principal and returns the confirmation", async () => {
    const h = makeDeps({ broker: new RecordingBroker({ identityKey: null, brokerCredentialId: 6 }) });
    const tool = connectExtensionToolDefinition({
      ...h.deps,
      getPrincipal: () => "UADA",
      spaceIdFromFile: (file) => (file === "slack:C1.jsonl" ? "slack:C1" : undefined),
    });

    const result = await tool.execute("t1", { extension: "fixture.weather", scope: "personal", api_key: undefined }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "slack:C1.jsonl" },
    } as never);

    expect((result.content[0] as { text: string }).text).toBe("Fixture Weather connected as @UADA");
    const rows = await rowsFor(h.store, "fixture.weather");
    expect(rows.find((r) => r.scope === "personal")!.owner).toBe("UADA");
  });

  test("execute surfaces a gate denial as a tool error", async () => {
    const h = makeDeps(); // default policy denies connect_extension
    const tool = connectExtensionToolDefinition({ ...h.deps, getPrincipal: () => "UADA" });

    const result = await tool.execute("t1", { extension: "fixture.weather", scope: "org", api_key: undefined }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "slack:C1.jsonl" },
    } as never);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("policy");
  });
});

describe("pure helpers", () => {
  test("pickNewestBrokerEntry picks the highest broker row id", () => {
    expect(pickNewestBrokerEntry([])).toBeNull();
    expect(pickNewestBrokerEntry([{ id: 3 }, { id: 9 }, { id: 5 }])).toEqual({ id: 9 });
    expect(pickNewestBrokerEntry([{ id: 1 }])).toEqual({ id: 1 });
  });

  test("apiKeyIdentityKey is stable and scope-aware", () => {
    expect(apiKeyIdentityKey("github", "org", null)).toBe("api-key:github");
    expect(apiKeyIdentityKey("github", "personal", "UADA")).toBe("api-key:UADA");
  });
});
