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
  SECRET_PASTE_REDIRECT,
  type BrokerConnectResult,
  type ConnectExtensionDeps,
  type ConnectScope,
} from "./connect";
import { fixtureManifest } from "./fixture";
import type { ExtensionManifest } from "./manifest";
import { createExtensionRegistry, type ExtensionRegistry } from "./registry";
import type { McpOAuthStartResult } from "./mcp-oauth";

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

/**
 * A stdio OAuth MCP (no hosted authorize endpoints): these stay on the
 * broker's provider-registry login path — the generic MCP OAuth flow only
 * applies to hosted (streamable-http) MCPs (issue #198).
 */
function stdioOAuthManifest(): ExtensionManifest {
  return {
    id: "com.example.stdio-oauth",
    label: "Example Stdio OAuth",
    vendor: "bottega-fixtures",
    kind: "mcp",
    mcp: { command: "npx", transport: "stdio" },
    credentialSchema: { type: "oauth", scopes: ["read"] },
    tools: [{ name: "stdio-oauth.current", tier: "read", description: "Stdio OAuth tool", params: [] }],
    domains: ["127.0.0.1"],
  };
}

function registry(): ExtensionRegistry {
  const r = createExtensionRegistry();
  r.register(fixtureManifest());
  r.register(oauthManifest());
  r.register(stdioOAuthManifest());
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

/** The generic MCP OAuth seam (issue #198): records starts, serves a scripted outcome. */
class RecordingMcpOAuth {
  readonly calls: Array<{ extension: string; provider: string; label: string; scope: string; actor: string; spaceId?: string }> = [];
  result: McpOAuthStartResult;
  constructor(result: McpOAuthStartResult = { ok: true, authorizationUrl: "https://auth.example/authorize?state=xyz", message: "Open this link to authorize" }) {
    this.result = result;
  }
  async start(input: { extension: string; provider: string; label: string; scope: string; actor: string; spaceId?: string }): Promise<McpOAuthStartResult> {
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
  mcpOAuth: RecordingMcpOAuth;
}

function makeDeps(overrides: {
  policy?: PolicyConfig;
  router?: RecordingRouter;
  broker?: RecordingBroker;
  mcpOAuth?: RecordingMcpOAuth;
} = {}): Harness {
  const store = freshStore();
  const router = overrides.router ?? new RecordingRouter();
  const broker = overrides.broker ?? new RecordingBroker();
  const mcpOAuth = overrides.mcpOAuth ?? new RecordingMcpOAuth();
  const policy = overrides.policy ?? defaultPolicy();
  return {
    deps: {
      registry: registry(),
      store,
      audit: createAudit(store),
      broker: broker.connect.bind(broker),
      mcpOAuth: { start: mcpOAuth.start.bind(mcpOAuth) },
      gate: { loadPolicy: () => Promise.resolve(policy), router },
    },
    store,
    router,
    broker,
    mcpOAuth,
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
  test("hosted OAuth MCPs route to the GENERIC MCP OAuth flow, never the broker (issue #198)", async () => {
    const h = makeDeps({ broker: new RecordingBroker({ identityKey: "email:ada@example.com", brokerCredentialId: 5 }) });

    const outcome = await connect(h, "com.example.oauth", "personal", "UADA", { spaceId: "slack:C1" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.credential).toBeNull(); // the credential lands at the browser callback
    expect(outcome.message).toContain("Open this link");
    expect(h.mcpOAuth.calls).toEqual([
      {
        extension: "com.example.oauth",
        provider: "com.example.oauth",
        label: "Example OAuth",
        scope: "personal",
        actor: "UADA",
        spaceId: "slack:C1",
      },
    ]);
    expect(h.broker.calls).toHaveLength(0); // the broker is a vault, not an OAuth registry
    expect(await rowsFor(h.store, "com.example.oauth")).toHaveLength(0); // registry row lands at the callback
  });

  test("a stdio OAuth MCP still drives the broker oauth login (no hosted authorize endpoints)", async () => {
    const h = makeDeps({ broker: new RecordingBroker({ identityKey: "email:ada@example.com", brokerCredentialId: 5 }) });

    const outcome = await connect(h, "com.example.stdio-oauth", "personal", "UADA");

    expect(outcome.ok).toBe(true);
    expect(h.broker.calls).toEqual([{ provider: "com.example.stdio-oauth", credentialType: "oauth" }]);
    expect(h.mcpOAuth.calls).toHaveLength(0);
  });

  test("hosted OAuth connects fail closed when the generic flow is not wired", async () => {
    const h = makeDeps();
    delete (h.deps as { mcpOAuth?: unknown }).mcpOAuth;

    const outcome = await connect(h, "com.example.oauth", "personal", "UADA");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("generic MCP OAuth is not wired");
    expect(h.broker.calls).toHaveLength(0);
    expect(h.mcpOAuth.calls).toHaveLength(0);
    expect(await rowsFor(h.store, "com.example.oauth")).toHaveLength(0);
  });

  test("an org-scope hosted OAuth connect gates first, then mints (denied → nothing)", async () => {
    const h = makeDeps({ policy: allowedPolicy() });

    const outcome = await connect(h, "com.example.oauth", "org", "UADA");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(h.router.requests).toHaveLength(1); // the org gate ran before the mint
    expect(h.mcpOAuth.calls).toHaveLength(1);
    expect(h.mcpOAuth.calls[0]!.scope).toBe("org");
    expect(h.broker.calls).toHaveLength(0);

    const denied = makeDeps(); // default policy denies connect_extension
    const blocked = await connect(denied, "com.example.oauth", "org", "UADA");
    expect(blocked.ok).toBe(false);
    expect(denied.mcpOAuth.calls).toHaveLength(0); // a denied connect never mints
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
    const a = await connect(h, "com.example.stdio-oauth", "personal", "UADA");
    h.broker.result = { identityKey: "email:ada@example.com", brokerCredentialId: 2 };
    const b = await connect(h, "com.example.stdio-oauth", "personal", "UADA");

    expect(a.ok && b.ok).toBe(true);
    const rows = await rowsFor(h.store, "com.example.stdio-oauth");
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

describe("connectExtension paste guard (issue #196)", () => {
  const CREDENTIAL_SHAPES = [
    "github_pat_abcdefghijklmnopqrstuvwxyz1234567890",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx",
    "sk-abcdefghijklmnopqrstuvwxyz1234567890",
    "AKIAIOSFODNN7EXAMPLE",
    "near-abcdefghijklmnopqrstuvwxyz123456",
  ];

  test.each(CREDENTIAL_SHAPES)("a pasted %s-shaped api_key is refused with the redirect", async (apiKey) => {
    const h = makeDeps();
    const outcome = await connect(h, "fixture.weather", "personal", "UADA", { apiKey });
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false ? outcome.message : "").toBe(SECRET_PASTE_REDIRECT);
    expect(h.broker.calls).toHaveLength(0);
    expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(0);
  });

  test("the refusal never leaks the pasted value", async () => {
    const secret = "github_pat_abcdefghijklmnopqrstuvwxyz1234567890";
    const h = makeDeps();
    const outcome = await connect(h, "fixture.weather", "personal", "UADA", { apiKey: secret });
    expect(outcome.ok === false ? outcome.message : "").not.toContain(secret);
  });

  test("the refusal is immediate: no gate request, no broker call, no audit row", async () => {
    const h = makeDeps({ policy: allowedPolicy() }); // even an allowed org policy
    const outcome = await connect(h, "fixture.weather", "org", "UADA", {
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
    });
    expect(outcome.ok).toBe(false);
    expect(h.router.requests).toHaveLength(0);
    expect(h.broker.calls).toHaveLength(0);
    expect(await h.store.listAudit({})).toHaveLength(0); // the value is nowhere
  });

  test("non-credential api keys still connect (the guard is narrow)", async () => {
    const h = makeDeps();
    const outcome = await connect(h, "fixture.weather", "personal", "UADA", { apiKey: "attio-secret-key" });
    expect(outcome.ok).toBe(true);
    expect(h.broker.calls[0]!.apiKey).toBe("attio-secret-key");
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

  test("execute surfaces the paste-guard refusal as a tool error without the value", async () => {
    const h = makeDeps();
    const tool = connectExtensionToolDefinition({ ...h.deps, getPrincipal: () => "UADA" });
    const secret = "github_pat_abcdefghijklmnopqrstuvwxyz1234567890";

    const result = await tool.execute(
      "t1",
      { extension: "fixture.weather", scope: "personal", api_key: secret },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "slack:C1.jsonl" } } as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe(SECRET_PASTE_REDIRECT);
    expect(text).not.toContain(secret);
    expect(h.broker.calls).toHaveLength(0);
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
