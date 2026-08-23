import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  SECRET_PROVISIONED_EVENT,
} from "../store/audit-events";
import { createStore, type Store } from "../store/db";
import { bootSecretForProvider } from "../server/boot-secrets";
import {
  apiKeyIdentityKey,
  connectExtension,
  connectViaAuthBroker,
  CONNECT_EXTENSION_TOOL,
  connectExtensionToolDefinition,
  pickNewestBrokerEntry,
  SECRET_PASTE_REDIRECT,
  storeBootSecret,
  type BrokerConnectResult,
  type ConnectExtensionDeps,
  type ConnectScope,
} from "./connect";
import { fixtureManifest } from "./fixture";
import type { ExtensionManifest } from "./manifest";
import { createExtensionRegistry, type ExtensionRegistry, type PinnedSnapshot } from "./registry";
import { DEFAULT_CATALOG_URL } from "./fetch-catalog";
import type { McpOAuthBaseProbeResult, McpOAuthStartResult } from "./mcp-oauth";

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
    // Issue #205: a stdio command must be the actual server binary — bare
    // package runners/shells are rejected by the validator. This fixture
    // never spawns (connect is config-only), so any binary name suffices.
    mcp: { command: "stdio-oauth-server", transport: "stdio" },
    credentialSchema: { type: "oauth", scopes: ["read"] },
    tools: [{ name: "stdio-oauth.current", tier: "read", description: "Stdio OAuth tool", params: [] }],
    domains: ["127.0.0.1"],
    credentialTargets: [{ host: "127.0.0.1" }],
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
  readonly vaultProviders: string[] = [];
  result: BrokerConnectResult;
  constructor(result: BrokerConnectResult = { identityKey: null, brokerCredentialId: 9 }) {
    this.result = result;
  }
  async connect(input: {
    provider: string;
    vaultProvider?: string;
    credentialType: string;
    apiKey?: string;
  }): Promise<BrokerConnectResult> {
    this.calls.push({ provider: input.provider, credentialType: input.credentialType, apiKey: input.apiKey });
    this.vaultProviders.push(input.vaultProvider ?? input.provider);
    return this.result;
  }
}

/** The generic MCP OAuth seam (issue #198): records starts, serves a scripted outcome. */
class RecordingMcpOAuth {
  readonly calls: Array<{ extension: string; provider: string; label: string; scope: string; actor: string; spaceId?: string }> = [];
  result: McpOAuthStartResult;
  /** Issue #271: the scripted callback-base liveness verdict + probe call count. */
  probeResult: McpOAuthBaseProbeResult = { ok: true, base: "https://callback.example" };
  probeCalls = 0;
  constructor(result: McpOAuthStartResult = { ok: true, authorizationUrl: "https://auth.example/authorize?state=xyz", message: "Open this link to authorize" }) {
    this.result = result;
  }
  async start(input: { extension: string; provider: string; label: string; scope: string; actor: string; spaceId?: string }): Promise<McpOAuthStartResult> {
    this.calls.push(input);
    return this.result;
  }
  async probeCallbackBase(): Promise<McpOAuthBaseProbeResult> {
    this.probeCalls += 1;
    return this.probeResult;
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
      mcpOAuth: { start: mcpOAuth.start.bind(mcpOAuth), probeCallbackBase: mcpOAuth.probeCallbackBase.bind(mcpOAuth) },
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

    const outcome = await connect(h, "fixture.weather", "personal", "UADA", { apiKey: "attio-secret-key" });

    expect(outcome).toMatchObject({ ok: true });
    expect(h.router.requests).toHaveLength(0); // gate never consulted
    expect(h.broker.calls).toEqual([
      { provider: "fixture.weather", credentialType: "api_key", apiKey: "attio-secret-key" },
    ]);
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

    const outcome = await connect(h, "fixture.weather", "org", "UADA", { spaceId: "slack:C1", apiKey: "attio-secret-key" });

    expect(outcome).toMatchObject({ ok: true });
    expect(h.router.requests).toHaveLength(1);
    expect(h.router.requests[0]!.tool).toBe(CONNECT_EXTENSION_TOOL);
    expect(h.router.requests[0]!.spaceId).toBe("slack:C1");
    expect(h.broker.calls).toEqual([
      { provider: "fixture.weather", credentialType: "api_key", apiKey: "attio-secret-key" },
    ]);
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
    let prepared = false;
    // Issue #284: the pre-authorization preflight is the plain reconcile
    // (allowlist regen + reload) — no exclude/seed options exist anymore,
    // and the call must never probe/seed a credential.
    h.deps.reconcileEgress = async (provider) => {
      expect(provider).toBe("com.example.oauth");
      prepared = true;
      return { warnings: [] };
    };
    const start = h.deps.mcpOAuth!.start;
    h.deps.mcpOAuth!.start = async (input) => {
      expect(prepared).toBe(true);
      return await start(input);
    };

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
    // SAFETY: the harness deps expose mcpOAuth when wired; deleting it simulates the unwired deployment.
    delete (h.deps as { mcpOAuth?: unknown }).mcpOAuth;

    const outcome = await connect(h, "com.example.oauth", "personal", "UADA");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("generic MCP OAuth is not wired");
    expect(h.broker.calls).toHaveLength(0);
    expect(h.mcpOAuth.calls).toHaveLength(0);
    expect(await rowsFor(h.store, "com.example.oauth")).toHaveLength(0);
  });

  test("a dead callback base refuses the connect BEFORE any authorize URL is minted, naming the base (issue #271)", async () => {
    const mcpOAuth = new RecordingMcpOAuth();
    mcpOAuth.probeResult = { ok: false, base: "https://stale.tunnel.example", message: "GET https://stale.tunnel.example -> HTTP 502" };
    const h = makeDeps({ mcpOAuth });

    const outcome = await connect(h, "com.example.oauth", "personal", "UADA");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // The refusal is loud and names the base that would have been embedded.
      expect(outcome.message).toContain("stale.tunnel.example");
      expect(outcome.message).toContain("not reachable");
    }
    expect(h.mcpOAuth.probeCalls).toBe(1); // the gate probed the base first...
    expect(h.mcpOAuth.calls).toHaveLength(0); // ...and refused BEFORE minting an authorize URL
    expect(h.broker.calls).toHaveLength(0);
    expect(await rowsFor(h.store, "com.example.oauth")).toHaveLength(0);
  });

  test("a live callback base lets the hosted-OAuth connect mint the authorize URL (issue #271)", async () => {
    const h = makeDeps(); // the harness probe answers ok by default

    const outcome = await connect(h, "com.example.oauth", "personal", "UADA");

    expect(outcome.ok).toBe(true);
    expect(h.mcpOAuth.probeCalls).toBe(1);
    expect(h.mcpOAuth.calls).toHaveLength(1);
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
    const outcome = await connect(h, "fixture.weather", "personal", "UADA", { apiKey: "k" });
    expect(outcome.ok).toBe(true);
    const rows = await rowsFor(h.store, "fixture.weather");
    expect(rows[0]!.identity_key).toBe("api-key:UADA");
  });

  test("a broker failure fails the connect without writing anything", async () => {
    const failing = { connect: async () => Promise.reject(new Error("broker unreachable")) };
    // SAFETY: makeDeps' broker slot is only exercised via its connect method here; the rejecting double covers that one path.
    const h = makeDeps({ broker: failing as never });

    const outcome = await connect(h, "fixture.weather", "personal", "UADA", { apiKey: "attio-secret-key" });

    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false ? outcome.message : "").toContain("broker unreachable");
    expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(0);
    expect(await h.store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT })).toHaveLength(0);
  });
});

describe("connectExtension re-connect", () => {
  test("re-connecting personal names the stable replace target without touching the broker", async () => {
    const h = makeDeps();
    h.broker.result = { identityKey: "email:ada@example.com", brokerCredentialId: 1 };
    const first = await connect(h, "com.example.stdio-oauth", "personal", "UADA");
    const second = await connect(h, "com.example.stdio-oauth", "personal", "UADA");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.message).toContain("replace_connection");
      expect(second.message).toContain(first.ok && first.credential ? first.credential.id : "unreachable");
      expect(second.message).toContain("revision 1");
    }
    expect(h.broker.calls).toHaveLength(1);
  });

  test("re-connecting org names the approved stable replace target without overwriting it", async () => {
    const h = makeDeps({ policy: allowedPolicy() });
    h.broker.result = { identityKey: "org-a", brokerCredentialId: 1 };
    const first = await connect(h, "fixture.weather", "org", "UADA", { apiKey: "k" });
    const second = await connect(h, "fixture.weather", "org", "UADA", { apiKey: "k" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toContain("replace_connection");
    const rows = await rowsFor(h.store, "fixture.weather");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.broker_credential_id).toBe(1);
    expect(h.broker.calls).toHaveLength(1);
  });
  test("one personal row per owner: two principals get two rows", async () => {
    const h = makeDeps();
    await connect(h, "fixture.weather", "personal", "UADA", { apiKey: "attio-secret-key" });
    await connect(h, "fixture.weather", "personal", "UBOB", { apiKey: "attio-secret-key" });
    const rows = await rowsFor(h.store, "fixture.weather");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.owner).sort()).toEqual(["UADA", "UBOB"]);
    expect(new Set(rows.map((row) => row.vault_provider)).size).toBe(2);
    expect(new Set(h.broker.vaultProviders).size).toBe(2);
  });
});

describe("connectExtension audit + feedback", () => {
  test("every connect writes extension.connected {extension, scope, owner}", async () => {
    const personalHarness = makeDeps();
    await connect(personalHarness, "fixture.weather", "personal", "UADA", { spaceId: "slack:C1", apiKey: "attio-secret-key" });
    const orgHarness = makeDeps({ policy: allowedPolicy() });
    await connect(orgHarness, "fixture.weather", "org", "UBOB", { apiKey: "attio-secret-key" });

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
    const p = await connect(personal, "fixture.weather", "personal", "UADA", { apiKey: "attio-secret-key" });
    expect(p.ok === true ? p.message : "").toBe("Fixture Weather connected as @UADA");

    const org = makeDeps({ policy: allowedPolicy() });
    const o = await connect(org, "fixture.weather", "org", "UADA", { apiKey: "attio-secret-key" });
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
  const SECRET_PASTE_SAMPLES = [
    "github_pat_abcdefghijklmnopqrstuvwxyz1234567890",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx",
    "sk-abcdefghijklmnopqrstuvwxyz1234567890",
    "AKIAIOSFODNN7EXAMPLE",
    "near-abcdefghijklmnopqrstuvwxyz123456",
  ];

  test.each(SECRET_PASTE_SAMPLES)("a pasted %s-shaped api_key is refused with the redirect", async (apiKey) => {
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

  // Issue #222: the guard's ONLY opt-out is the browser-upload seam —
  // fromUpload: true stores credential-shaped keys (the one-time upload
  // POST, where the secret never touched chat and token consumption is the
  // authorization); every other caller omits it, so the guard is unchanged.
  test("fromUpload: true is the explicit upload opt-out — secret-shaped keys store", async () => {
    const h = makeDeps();
    const outcome = await connectExtension(
      { extension: "fixture.weather", scope: "personal", actor: "UADA", apiKey: "ghp_abcdefghijklmnopqrstuvwxyz123456", fromUpload: true },
      h.deps,
    );
    expect(outcome).toMatchObject({ ok: true });
    expect(h.broker.calls).toEqual([
      { provider: "fixture.weather", credentialType: "api_key", apiKey: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
    ]);
    expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(1);
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

    // SAFETY: the connect tool never reads the execute context; a minimal sessionManager fake satisfies the arity.
    const result = await tool.execute("t1", { extension: "fixture.weather", scope: "personal", api_key: "attio-secret-key" }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "slack:C1.jsonl" },
    } as never);

    // SAFETY: the tool replies with a single text content block; the confirmation text is asserted verbatim.
    expect((result.content[0] as { text: string }).text).toBe("Fixture Weather connected as @UADA");
    const rows = await rowsFor(h.store, "fixture.weather");
    expect(rows.find((r) => r.scope === "personal")!.owner).toBe("UADA");
  });

  test("execute surfaces a gate denial as a tool error", async () => {
    const h = makeDeps(); // default policy denies connect_extension
    const tool = connectExtensionToolDefinition({ ...h.deps, getPrincipal: () => "UADA" });

    // SAFETY: the connect tool never reads the execute context; a minimal sessionManager fake satisfies the arity.
    const result = await tool.execute("t1", { extension: "fixture.weather", scope: "org", api_key: undefined }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "slack:C1.jsonl" },
    } as never);

    expect(result.isError).toBe(true);
    // SAFETY: the tool replies with a single text content block; the denial text is asserted below.
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
      // SAFETY: the connect tool never reads the execute context; a minimal sessionManager fake satisfies the arity.
      { sessionManager: { getSessionFile: () => "slack:C1.jsonl" } } as never,
    );

    expect(result.isError).toBe(true);
    // SAFETY: the tool replies with a single text content block; the paste-guard text is asserted below.
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

describe("connectExtension catalog fallback (issue #232/#233) — register at runtime, no register gate", () => {
  const NOTION_RECORD = {
    id: "mcp/notion",
    slug: "notion",
    kind: "mcp",
    name: "Notion",
    description: "Notion's official MCP server",
    url: "https://notion.com/docs/mcp",
    domain: "notion.com",
  };
  const ACME_KEY_RECORD = {
    id: "mcp/acme-key",
    slug: "acme-key",
    kind: "mcp",
    name: "Acme Key",
    description: "An api_key-gated hosted MCP",
    url: "https://acme.example.com/docs/mcp",
    domain: "acme.example.com",
  };

  /** A valid MCP initialize result the endpoint doubles serve (issue #286). */
  const INITIALIZE_RESULT = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "stub-mcp", version: "1.0.0" },
    },
  });

  /** One URL (or prefix) → a scripted response for the endpoint doubles. */
  interface Route {
    match: string;
    status: number;
    body?: string;
    headers?: Record<string, string>;
  }

  interface CatalogRecordFixture {
    domain: string;
  }

  type TestFetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>;

  /** Adds Bun's non-request preconnect member to a hermetic fetch double. */
  function withFetchContract(implementation: TestFetch): typeof fetch {
    return Object.assign(implementation, { preconnect: fetch.preconnect });
  }

  function requestUrl(input: Parameters<typeof fetch>[0]): string {
    return input instanceof Request ? input.url : input.toString();
  }

  /** The derived candidate endpoints for a catalog record's domain (issue #286 §3). */
  function derivedCandidates(record: CatalogRecordFixture): string[] {
    const host = record.domain.startsWith("mcp.") ? record.domain : `mcp.${record.domain}`;
    return [`https://${host}/mcp`, `https://${host}/mcp/v1`];
  }

  /** Catalog doc + probe double routing: hermetic, no network. */
  function stubCatalogFetch(
    records: CatalogRecordFixture[],
    opts: { wellKnownStatus?: number; routes?: Route[] } = {},
  ): typeof fetch {
    const derivedRoutes: Route[] = records.flatMap((record) =>
      derivedCandidates(record).map((url) => ({
        match: url,
        status: 200,
        body: INITIALIZE_RESULT,
        headers: { "content-type": "application/json" },
      })),
    );
    const routes = [...(opts.routes ?? []), ...derivedRoutes];
    return withFetchContract(async (input) => {
      const url = requestUrl(input);
      if (url === DEFAULT_CATALOG_URL) {
        return new Response(JSON.stringify({ version: 1, data: records }), { status: 200 });
      }
      const exact = routes.find((r) => r.match === url);
      const route =
        exact ?? routes.filter((r) => url.startsWith(r.match)).sort((a, b) => b.match.length - a.match.length)[0];
      if (route !== undefined) {
        return new Response(route.body ?? "", { status: route.status, headers: route.headers });
      }
      if (url.includes("/.well-known/")) return new Response("", { status: opts.wellKnownStatus ?? 404 });
      return new Response("", { status: 404 });
    });
  }

  /** In-memory store-backed runtime registry (issue #233). */
  class MemoryRuntimeRegistry {
    readonly rows: PinnedSnapshot[] = [];
    async upsert(snapshot: PinnedSnapshot): Promise<void> {
      this.rows.push(snapshot);
    }
    async list(): Promise<PinnedSnapshot[]> {
      return [...this.rows];
    }
  }

  interface CatalogHarness extends Harness {
    snapshotsDir: string;
    egressPath: string;
    devEgressPath: string;
    runtimeRegistry: MemoryRuntimeRegistry;
    dir: string;
  }

  function makeCatalogHarness(opts: {
    router?: RecordingRouter;
    records?: CatalogRecordFixture[];
    wellKnownStatus?: number;
    routes?: Route[];
    policy?: PolicyConfig;
  } = {}): CatalogHarness {
    const base = makeDeps({
      router: opts.router,
      // Issue #233: the org connect approval covers the registration — the
      // org gate is the connect_extension gate (the register_extension
      // policy name is no longer consulted on this path).
      policy: opts.policy ?? parseOrgConfigYaml("tools:\n  connect_extension: allow\n"),
    });
    const dir = mkdtempSync(join(tmpdir(), "bottega-connect-catalog-"));
    const snapshotsDir = join(dir, "extensions");
    const egressPath = join(dir, "egress.yml");
    const devEgressPath = join(dir, "egress.dev.yml");
    const registry = createExtensionRegistry(snapshotsDir); // empty: notion/acme-key unregistered
    const runtimeRegistry = new MemoryRuntimeRegistry();
    return {
      ...base,
      deps: {
        ...base.deps,
        registry,
        catalogRegister: {
          catalog: {
            fetchImpl: stubCatalogFetch(opts.records ?? [NOTION_RECORD], {
              wellKnownStatus: opts.wellKnownStatus ?? 200,
              routes: opts.routes,
            }),
          },
          snapshotsDir,
          egressPath,
          devEgressPath,
          runtimeRegistry,
        },
      },
      snapshotsDir,
      egressPath,
      devEgressPath,
      runtimeRegistry,
      dir,
    };
  }

  const catalogDirs: string[] = [];
  afterAll(() => {
    for (const dir of catalogDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("a PERSONAL connect of an unregistered catalog extension registers at runtime with NO gate and continues the connect", async () => {
    const h = makeCatalogHarness();
    catalogDirs.push(h.dir);

    const outcome = await connect(h, "notion", "personal", "UADA");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.message).toBe("Open this link to authorize");
    // Issue #233: personal connects are DIRECT — no register gate, no
    // connect gate (the org gate only fires for org scope).
    expect(h.router.requests).toHaveLength(0);
    // Registered AT RUNTIME: store row (the durable evidence) + egress
    // regen + hot-register — and NO config/extensions file.
    expect(h.runtimeRegistry.rows).toHaveLength(1);
    expect(existsSync(join(h.snapshotsDir, "notion.json"))).toBe(false);
    expect(readFileSync(h.egressPath, "utf8")).toContain('"mcp.notion.com"');
    expect(h.mcpOAuth.calls).toHaveLength(1);
    expect(h.mcpOAuth.calls[0]!.extension).toBe("notion");
    expect(h.deps.registry.resolve("notion")).toBeDefined();
    // The registered manifest is the #231 notion shape: reviewed (the
    // connect authorizes it), OAuth, tools-less.
    const persisted = h.runtimeRegistry.rows[0]!;
    expect(persisted.extensionId).toBe("notion");
    expect(persisted.source.reviewed).toBe(true);
    expect(persisted.manifest.credentialSchema).toEqual({ type: "oauth" });
  });

  test("an ORG connect of an unregistered catalog extension crosses ONE gate — the connect approval covers the registration; a denied connect registers nothing", async () => {
    // Allowed policy: the org connect gate fires ONCE, carrying the draft
    // facts (vendor, domains, MCP endpoint) — the "add a domain" egress
    // step rides this approval (issue #233's security note).
    const h = makeCatalogHarness();
    catalogDirs.push(h.dir);

    const outcome = await connect(h, "notion", "org", "UADA");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.message).toBe("Open this link to authorize");
    expect(h.router.requests).toHaveLength(1);
    const request = h.router.requests[0]!;
    expect(request.tool).toBe(CONNECT_EXTENSION_TOOL);
    expect(request.args).toMatchObject({
      extension: "notion",
      scope: "org",
      registering_from_catalog: true,
      vendor: "Notion",
      domains: ["notion.com", "mcp.notion.com"],
      credentialTargets: [{ host: "mcp.notion.com", pathPrefix: "/mcp" }],
      mcpEndpoint: "https://mcp.notion.com/mcp",
    });
    expect(h.runtimeRegistry.rows).toHaveLength(1);
    expect(h.mcpOAuth.calls).toHaveLength(1);

    // DENIED: nothing registers — no store row, no egress, no mint, no
    // hot-register.
    const denied = makeCatalogHarness({ router: new RecordingRouter({ approved: false }) });
    catalogDirs.push(denied.dir);
    const deniedOutcome = await connect(denied, "notion", "org", "UADA");

    expect(deniedOutcome.ok).toBe(false);
    if (deniedOutcome.ok === false) expect(deniedOutcome.message).toContain("policy: approval denied");
    expect(denied.runtimeRegistry.rows).toHaveLength(0);
    expect(existsSync(join(denied.snapshotsDir, "notion.json"))).toBe(false);
    expect(existsSync(denied.egressPath)).toBe(false);
    expect(denied.mcpOAuth.calls).toHaveLength(0);
    expect(denied.deps.registry.resolve("notion")).toBeUndefined();
  });

  test("an api_key catalog extension registers at runtime then directs the key to the one-time upload link", async () => {
    const h = makeCatalogHarness({ records: [ACME_KEY_RECORD], wellKnownStatus: 404 });
    catalogDirs.push(h.dir);

    const outcome = await connect(h, "acme-key", "personal", "UADA");

    // The registration landed — but the connect cannot proceed without the
    // key, and the message points at the #196 safe path.
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.message).toContain('Registered "Acme Key" from the catalog at runtime');
      expect(outcome.message).toContain("connect_upload_link");
      // The guidance never asks for a pasted key in chat.
      expect(outcome.message).toContain("never paste a live key in chat");
    }
    expect(h.runtimeRegistry.rows).toHaveLength(1);
    expect(h.runtimeRegistry.rows[0]!.manifest.credentialSchema).toEqual({ type: "api_key" });
    expect(readFileSync(h.egressPath, "utf8")).toContain('"mcp.acme.example.com"');
    expect(h.mcpOAuth.calls).toHaveLength(0);
  });

  test("an org connect of an OPENAPI catalog entry crosses ONE gate whose payload lists the generated operations+tiers, then directs the key to the upload link (issue #345)", async () => {
    const openapiRecord = {
      id: "openapi/sendgrid",
      slug: "sendgrid",
      kind: "openapi",
      name: "SendGrid",
      description: "An API-first email vendor with no MCP server",
      domain: "sendgrid.com",
      openapi: { url: "https://raw.sendgrid.test/openapi.json", auth: { scheme: "bearer" } },
    };
    const spec = {
      openapi: "3.0.3",
      info: { title: "SendGrid API", version: "1.0.0" },
      servers: [{ url: "https://api.sendgrid.test/v1" }],
      paths: {
        "/mail/send": { post: { operationId: "send_mail", responses: { "200": { description: "ok" } } } },
        "/stats": { get: { operationId: "get_stats", responses: { "200": { description: "ok" } } } },
        "/stats/campaigns": { delete: { operationId: "delete_campaign", responses: { "204": { description: "ok" } } } },
      },
    };
    const h = makeCatalogHarness({
      records: [openapiRecord],
      routes: [
        {
          match: "https://raw.sendgrid.test/openapi.json",
          status: 200,
          body: JSON.stringify(spec),
          headers: { "content-type": "application/json" },
        },
      ],
    });
    catalogDirs.push(h.dir);

    const outcome = await connect(h, "sendgrid", "org", "UADA");

    // The registration landed (api_key → the connect then points at the
    // #196 safe upload path — never a pasted key in chat).
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.message).toContain('Registered "SendGrid" from the catalog at runtime');
      expect(outcome.message).toContain("connect_upload_link");
    }
    // ONE org gate carries the draft facts INCLUDING the operations+tiers
    // the review renders (issue #345).
    expect(h.router.requests).toHaveLength(1);
    const request = h.router.requests[0]!;
    expect(request.tool).toBe(CONNECT_EXTENSION_TOOL);
    expect(request.args).toMatchObject({
      extension: "sendgrid",
      scope: "org",
      registering_from_catalog: true,
      vendor: "SendGrid",
      domains: ["api.sendgrid.test"],
      operations: [
        { name: "sendgrid_send_mail", tier: "write", operation: "send_mail", method: "post", path: "/mail/send" },
        { name: "sendgrid_get_stats", tier: "read", operation: "get_stats", method: "get", path: "/stats" },
        { name: "sendgrid_delete_campaign", tier: "write", operation: "delete_campaign", method: "delete", path: "/stats/campaigns" },
      ],
    });
    // Registered AT RUNTIME (store + egress regen + hot-register, no file).
    expect(h.runtimeRegistry.rows).toHaveLength(1);
    const persisted = h.runtimeRegistry.rows[0]!;
    expect(persisted.manifest.kind).toBe("openapi");
    if (persisted.manifest.kind === "openapi") {
      expect(persisted.manifest.domains).toEqual(["api.sendgrid.test"]);
      expect(persisted.manifest.tools.map((t) => t.name).sort()).toEqual([
        "sendgrid_delete_campaign",
        "sendgrid_get_stats",
        "sendgrid_send_mail",
      ]);
    }
    expect(existsSync(join(h.snapshotsDir, "sendgrid.json"))).toBe(false);
    expect(h.mcpOAuth.calls).toHaveLength(0);
  });

  test("without the catalog seam an unknown extension keeps the fail-closed error", async () => {
    // Headless/executor contexts wire no seam: the old error stands.
    const h = makeDeps();
    const outcome = await connect(h, "com.nope", "personal", "UADA");
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.message).toContain("unknown extension");
  });

  test("every endpoint candidate failing the probe fails the full connect closed — no runtime row, no egress, no audit (issue #286)", async () => {
    // §9 #9: the deterministic catalog connect must never register an
    // endpoint the probe could not prove. Both derived candidates 404.
    const h = makeCatalogHarness({
      records: [NOTION_RECORD],
      routes: [
        { match: "https://mcp.notion.com/mcp", status: 404 },
        { match: "https://mcp.notion.com/mcp/v1", status: 404 },
      ],
    });
    catalogDirs.push(h.dir);

    const outcome = await connect(h, "notion", "personal", "UADA");

    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      // The lookup failure surfaces the probe evidence + the reviewed
      // override instruction (§8) — never a silent stall.
      expect(outcome.message).toContain("validation probe");
      expect(outcome.message).toContain("HTTP 404");
      expect(outcome.message).toContain("no other candidate accepted");
      expect(outcome.message).toContain("reviewed official endpoint");
    }
    // Fail closed: no store row, no egress, no OAuth start, no hot-register.
    expect(h.runtimeRegistry.rows).toHaveLength(0);
    expect(existsSync(join(h.snapshotsDir, "notion.json"))).toBe(false);
    expect(existsSync(h.egressPath)).toBe(false);
    expect(h.mcpOAuth.calls).toHaveLength(0);
    expect(h.deps.registry.resolve("notion")).toBeUndefined();
  });

  test("an oauth_challenge endpoint registers an OAuth-gated tools-less manifest whose domains include the VALIDATED host (issue #286)", async () => {
    // §9 #10: the endpoint answers 401 + a standards-compliant Bearer
    // challenge → the connect registers OAuth-gated without the RFC 8414
    // metadata probe, and the egress allowlist follows the validated URL's
    // host.
    const h = makeCatalogHarness({
      records: [NOTION_RECORD],
      wellKnownStatus: 404,
      routes: [
        {
          match: "https://mcp.notion.com/mcp",
          status: 401,
          headers: { "www-authenticate": 'Bearer error="invalid_token"' },
        },
      ],
    });
    catalogDirs.push(h.dir);

    const outcome = await connect(h, "notion", "personal", "UADA");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.message).toBe("Open this link to authorize");
    // The durable store row is OAuth-gated and tools-less (the #231
    // notion pattern) with the validated host allowlisted.
    expect(h.runtimeRegistry.rows).toHaveLength(1);
    const persisted = h.runtimeRegistry.rows[0]!;
    expect(persisted.manifest.credentialSchema).toEqual({ type: "oauth" });
    expect(persisted.manifest.tools).toBeUndefined();
    expect(persisted.manifest.domains).toEqual(["notion.com", "mcp.notion.com"]);
    // The connect continued into the OAuth flow (the runtime discovers the
    // surface at boot).
    expect(h.mcpOAuth.calls).toHaveLength(1);
    expect(h.deps.registry.resolve("notion")).toBeDefined();
    expect(readFileSync(h.egressPath, "utf8")).toContain('"mcp.notion.com"');
  });
});

describe("connectExtension api_key no-key redirect (issue #247)", () => {
  // Chat connects never carry an api_key (the removed #61 connect-intent
  // regex pre-route captured none, and the paste guard refuses pasted
  // keys), so an api_key connect with `apiKey` omitted must NEVER fall
  // into the broker's bare "needs its API key" throw: an existing
  // personal/org credential means the provider is ALREADY connected, and
  // otherwise the honest next step is the #196 one-time upload link.

  test("A: personal, existing credential → already connected (replace pointer), never 'needs its API key'", async () => {
    const h = makeDeps();
    // The explicit-key path creates the personal row.
    const first = await connect(h, "fixture.weather", "personal", "UADA", { apiKey: "attio-secret-key" });
    expect(first.ok).toBe(true);

    // The chat re-connect carries no key.
    const outcome = await connect(h, "fixture.weather", "personal", "UADA");
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.message).toContain("replace_connection");
      expect(outcome.message).toContain("expected revision");
      expect(outcome.message).not.toContain("needs its API key");
    }
    // The broker was NOT called again and no duplicate row was written.
    expect(h.broker.calls).toHaveLength(1);
    expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(1);
  });

  test("B: personal, no credential, no key → points at connect_upload_link, not the bare broker throw", async () => {
    const h = makeDeps();
    const outcome = await connect(h, "fixture.weather", "personal", "UADA");
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.message).toContain("connect_upload_link");
      expect(outcome.message).not.toContain("needs its API key");
    }
    expect(h.broker.calls).toHaveLength(0);
    expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(0);
  });

  test("C: isolation — actor B with no own credential still gets the upload-link pointer though A is connected", async () => {
    const h = makeDeps();
    await connect(h, "fixture.weather", "personal", "UADA", { apiKey: "attio-secret-key" });

    const b = await connect(h, "fixture.weather", "personal", "UBOB");

    expect(b.ok).toBe(false);
    if (b.ok === false) {
      expect(b.message).toContain("connect_upload_link");
      expect(b.message).not.toContain("needs its API key");
    }
    expect(h.broker.calls).toHaveLength(1); // only A's explicit connect reached the broker
  });

  test("D: org, no key, no org credential → gate runs first, then the connect_upload_link pointer", async () => {
    const h = makeDeps({ policy: allowedPolicy() });
    const outcome = await connect(h, "fixture.weather", "org", "UADA");

    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.message).toContain("connect_upload_link");
      expect(outcome.message).not.toContain("needs its API key");
    }
    // The org policy gate ran BEFORE the pointer (its approval was requested).
    expect(h.router.requests).toHaveLength(1);
    expect(h.broker.calls).toHaveLength(0);
    expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(0);
  });

  test("the chat connect_extension tool surfaces the upload-link pointer, not the broker throw (tool path)", async () => {
    const h = makeDeps();
    const tool = connectExtensionToolDefinition({ ...h.deps, getPrincipal: () => "UADA" });

    // SAFETY: the connect tool never reads the execute context; a minimal sessionManager fake satisfies the arity.
    const result = await tool.execute("t1", { extension: "fixture.weather", scope: "personal", api_key: undefined }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "slack:C1.jsonl" },
    } as never);

    expect(result.isError).toBe(true);
    // SAFETY: the tool replies with a single text content block; the pointer text is asserted below.
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("connect_upload_link");
    expect(text).not.toContain("needs its API key");
    expect(h.broker.calls).toHaveLength(0);
  });
});

describe("storeBootSecret (issue #201)", () => {
  const slackApp = bootSecretForProvider("slack-app")!;
  const depsFor = (h: Harness) => ({
    broker: h.deps.broker,
    audit: h.deps.audit,
    gate: h.deps.gate,
  });

  test("org-scope stores cross the policy gate; a deny blocks with nothing stored", async () => {
    // deny-by-default policy → the exec-tier gate blocks before any broker write.
    const h = makeDeps();
    const outcome = await storeBootSecret(
      { secret: slackApp, value: "xapp-secret", scope: "org", actor: "UADA", spaceId: "slack:C1" },
      depsFor(h),
    );
    expect(outcome.ok).toBe(false);
    expect(h.broker.calls).toHaveLength(0);
    expect(await h.store.listAudit({ event_type: SECRET_PROVISIONED_EVENT })).toHaveLength(0);
  });

  test("an approved org store writes the value through the broker and audits metadata only", async () => {
    const router = new RecordingRouter({ approved: true });
    const broker = new RecordingBroker({ identityKey: null, brokerCredentialId: 12 });
    const h = makeDeps({ policy: allowedPolicy(), router, broker });
    const outcome = await storeBootSecret(
      { secret: slackApp, value: "xapp-secret", scope: "org", actor: "UADA", spaceId: "slack:C1" },
      depsFor(h),
    );
    expect(outcome).toMatchObject({ ok: true });
    expect(h.router.requests).toHaveLength(1);
    expect(h.broker.calls).toEqual([{ provider: "slack-app", credentialType: "api_key", apiKey: "xapp-secret" }]);
    const rows = await h.store.listAudit({ event_type: SECRET_PROVISIONED_EVENT });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      secret: "slack-app",
      scope: "org",
      owner: null,
    });
  });

  test("a broker failure fails the store closed with nothing audited", async () => {
    const router = new RecordingRouter({ approved: true });
    const failing = { connect: async () => Promise.reject(new Error("vault unreachable")) };
    // SAFETY: only the broker connect slot is exercised; the rejecting double covers that one path.
    const h = makeDeps({ policy: allowedPolicy(), router, broker: failing as never });
    const outcome = await storeBootSecret(
      { secret: slackApp, value: "xapp-secret", scope: "org", actor: "UADA" },
      depsFor(h),
    );
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false ? outcome.message : "").toContain("vault unreachable");
    expect(await h.store.listAudit({ event_type: SECRET_PROVISIONED_EVENT })).toHaveLength(0);
  });
});

describe("connectViaAuthBroker fail-closed guards (issue #52/#247)", () => {
  test("an api_key connect without a key refuses to run — never an empty upload", async () => {
    await expect(
      connectViaAuthBroker({ provider: "fixture.weather", credentialType: "api_key" }),
    ).rejects.toThrow(/needs its API key/);
    await expect(
      connectViaAuthBroker({ provider: "fixture.weather", credentialType: "api_key", apiKey: "   " }),
    ).rejects.toThrow(/needs its API key/);
  });
});

describe("connectExtension fail-closed deny branches (issue #198/#247)", () => {
  test("a THROWING callback-base probe fails the hosted OAuth connect closed, naming the cause", async () => {
    const h = makeDeps({ policy: allowedPolicy() });
    h.deps.mcpOAuth!.probeCallbackBase = async () => {
      throw new Error("tunnel connection refused");
    };
    const outcome = await connect(h, "com.example.oauth", "personal", "UADA");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false ? outcome.message : "").toContain("tunnel connection refused");
    // Nothing minted, nothing brokered.
    expect(h.mcpOAuth.calls).toHaveLength(0);
    expect(h.broker.calls).toHaveLength(0);
    expect(await rowsFor(h.store, "com.example.oauth")).toHaveLength(0);
  });

  test("a credential-upsert failure after a successful broker connect fails closed with no audit", async () => {
    // A broker that succeeds, but a store whose upsert throws (e.g. a DB
    // write error): the connect must surface a fail-closed message and
    // never record an extension.connected audit.
    const h = makeDeps({
      policy: allowedPolicy(),
      broker: new RecordingBroker({ identityKey: "email:ada@example.com", brokerCredentialId: 5 }),
    });
    h.deps.store.upsertExtensionCredential = async () => {
      throw new Error("db write failed");
    };

    const outcome = await connect(h, "com.example.stdio-oauth", "personal", "UADA");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false ? outcome.message : "").toContain("db write failed");
    expect(await h.store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT })).toHaveLength(0);
  });
});

describe("connectExtension hosted-OAuth start fail-closed (issue #198)", () => {
  test("a throwing mcpOAuth.start fails the connect closed after a healthy probe", async () => {
    const h = makeDeps({ policy: allowedPolicy() });
    h.deps.reconcileEgress = async () => ({ warnings: [] });
    h.deps.mcpOAuth!.start = async () => {
      throw new Error("authorize exchange failed");
    };
    const outcome = await connect(h, "com.example.oauth", "personal", "UADA");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false ? outcome.message : "").toContain("authorize exchange failed");
    expect(h.broker.calls).toHaveLength(0);
    expect(await rowsFor(h.store, "com.example.oauth")).toHaveLength(0);
  });
});
