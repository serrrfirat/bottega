/**
 * One-time upload link tests (issue #196): the mint→upload→vault flow is
 * hermetic — a real in-process Bun.serve endpoint on 127.0.0.1, a real
 * SQLite store, a recording broker (the SAME seam the connect flow uses),
 * and a recording approval router. Nothing touches the network, Slack, or
 * a transcript.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAudit } from "../policy/audit";
import type { ApprovalRequest, ApprovalResolution, ApprovalRouter } from "../policy/approval-router";
import { parseOrgConfigYaml, type PolicyConfig } from "../policy/config";
import { EXTENSION_CONNECTED_EVENT, SECRET_PROVISIONED_EVENT, STATIC_CLIENT_PROVISIONED_EVENT } from "../store/audit-events";
import { BOOT_SECRETS } from "../server/boot-secrets";
import { createStore, type Store } from "../store/db";
import { CONNECT_EXTENSION_TOOL, type BrokerConnectResult } from "./connect";
import { fixtureManifest } from "./fixture";
import type { ExtensionManifest, JsonObject } from "./manifest";
import { createExtensionRegistry, type ExtensionRegistry } from "./registry";
import {
  createStaticOAuthClientStore,
  staticOAuthClientProviderKey,
  type StaticOAuthClient,
} from "./static-oauth-client";
import {
  mintUploadLink,
  mintUploadLinkToolDefinition,
  startUploadLinkServer,
  UPLOAD_LINK_MAX_OUTSTANDING_PER_ACTOR,
  UploadLinkStore,
  uploadLinkPublicBase,
  type UploadLinkEndpointDeps,
} from "./upload-link";

const dir = mkdtempSync(join(tmpdir(), "bottega-upload-link-"));
const stores: Store[] = [];
const callbackPort = process.env.BOTTEGA_CALLBACK_PORT;
const publicBaseFile = process.env.BOTTEGA_PUBLIC_BASE_URL_FILE;
beforeAll(() => {
  process.env.BOTTEGA_CALLBACK_PORT = "0";
  // Hermetic (issue #249): point the durable public-base store at a temp
  // path that never exists so env-driven legs never read a stray repo store.
  process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = join(dir, "no-public-base");
});
afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
  if (callbackPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
  else process.env.BOTTEGA_CALLBACK_PORT = callbackPort;
  if (publicBaseFile === undefined) delete process.env.BOTTEGA_PUBLIC_BASE_URL_FILE;
  else process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = publicBaseFile;
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

/** The OAuth manifest bound to a SPECIFIC server URL (issue #288 mint capability tests). */
function oauthManifestAt(serverUrl: string): ExtensionManifest {
  const manifest = oauthManifest();
  // Narrow the kind union: the OAuth fixture is the mcp arm by construction.
  if (manifest.kind !== "mcp" || manifest.mcp === undefined) {
    throw new Error("the oauth fixture manifest must be the mcp kind");
  }
  // The manifest's validated domains must cover the bound server host
  // (issue #346 #11: discovery is refused for a host outside the validated
  // domains). The hermetic stub serves on loopback http, so derive the
  // host from the bound URL rather than inheriting the fixture's nominal
  // domain.
  const host = new URL(serverUrl).hostname;
  return { ...manifest, mcp: { serverUrl, transport: "streamable-http" }, domains: [host] };
}

/** A registry holding the fixture + an OAuth manifest at the given server URL. */
function registryWithOauthAt(serverUrl: string): ExtensionRegistry {
  const r = createExtensionRegistry();
  r.register(fixtureManifest());
  r.register(oauthManifestAt(serverUrl));
  return r;
}

/**
 * Hermetic discovery stub (issue #288): serves the RFC 9728 protected-
 * resource metadata + RFC 8414 authorization-server metadata the mint's
 * dynamic-registration capability check discovers. `registrationEndpoint`
 * true → DCR-capable; false → the Gmail-class no-DCR shape; `metadata`
 * false → discovery cannot establish a verdict ("unknown", fail closed).
 */
class CapabilityStub {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly baseUrl: string;
  registrationEndpoint = true;
  metadata = true;
  constructor() {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => this.handle(req) });
    this.baseUrl = `http://127.0.0.1:${this.server.port}`;
  }
  get mcpUrl(): string {
    return `${this.baseUrl}/mcp`;
  }
  stop(): void {
    this.server.stop(true);
  }
  handle(req: Request): Response {
    const url = new URL(req.url);
    const json = (body: JsonObject, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource/")) {
      return json({ resource: this.mcpUrl, authorization_servers: [this.baseUrl], scopes_supported: ["default"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      if (!this.metadata) return new Response("not found", { status: 404 });
      const metadata: JsonObject = {
        issuer: this.baseUrl,
        authorization_endpoint: `${this.baseUrl}/authorize`,
        token_endpoint: `${this.baseUrl}/token`,
        scopes_supported: ["default"],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      };
      if (this.registrationEndpoint) metadata["registration_endpoint"] = `${this.baseUrl}/register`;
      return json(metadata);
    }
    return new Response("not found", { status: 404 });
  }
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
  deps: UploadLinkEndpointDeps;
  store: Store;
  router: RecordingRouter;
  broker: RecordingBroker;
}

function makeDeps(overrides: { policy?: PolicyConfig; router?: RecordingRouter; broker?: RecordingBroker; registry?: ExtensionRegistry } = {}): Harness {
  const store = freshStore();
  const router = overrides.router ?? new RecordingRouter();
  const broker = overrides.broker ?? new RecordingBroker();
  const policy = overrides.policy ?? defaultPolicy();
  return {
    deps: {
      registry: overrides.registry ?? registry(),
      store,
      audit: createAudit(store),
      broker: broker.connect.bind(broker),
      // Issue #288: the static-client store rides the SAME broker seam the
      // boot wires — the recording broker is the vault for these tests.
      staticOAuthClientStore: createStaticOAuthClientStore({ broker: broker.connect.bind(broker) }),
      gate: { loadPolicy: () => Promise.resolve(policy), router },
    },
    store,
    router,
    broker,
  };
}

function rowsFor(store: Store, provider: string) {
  return store.listExtensionCredentials(provider);
}

function postSecret(url: string, secret: string): Promise<Response> {
  const body = new FormData();
  body.append("secret", secret);
  return fetch(url, { method: "POST", body });
}

/**
 * Issue #211: the hermetic mint — no public base configured, so the mint
 * resolves loopback WITHOUT probing. The ambient .env (auto-loaded by bun)
 * carries a live tunnel URL; tests that don't exercise the liveness probe
 * must pin this resolver so the suite never touches the network.
 */
const noPublicBase = async () => ({ base: undefined, warning: undefined });

describe("one-time upload link — mint → upload → vault (issue #196)", () => {
  test("GET serves the form; POST stores the secret through the same connect path", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "fixture.weather",
        scope: "personal",
        actor: "UADA",
        label: "Fixture Weather",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const form = await fetch(url);
      expect(form.status).toBe(200);
      const html = await form.text();
      expect(html).toContain("Fixture Weather");
      expect(html).toContain('name="secret"');
      expect(form.headers.get("cache-control")).toBe("no-store");

      const secret = "attio-secret-key";
      const upload = await postSecret(url, secret);
      expect(upload.status).toBe(200);
      expect(await upload.text()).toContain("Saved to the vault");

      // The SAME broker + registry path as the connect flow: the broker saw
      // the value and the vault row landed (personal, owner = the minting
      // principal).
      expect(h.broker.calls).toEqual([
        expect.objectContaining({ provider: "fixture.weather", credentialType: "api_key", apiKey: secret }),
      ]);
      const rows = await rowsFor(h.store, "fixture.weather");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.owner).toBe("UADA");
      expect(rows[0]!.scope).toBe("personal");
      expect(rows[0]!.broker_credential_id).toBe(9);
      const connected = await h.store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT });
      expect(JSON.parse(connected[0]!.payload)).toEqual({
        extension: "fixture.weather",
        scope: "personal",
        owner: "UADA",
      });
    } finally {
      endpoint.stop();
    }
  });

  // Issue #222 regression: the browser upload is the sanctioned secret path
  // — a REAL-shaped credential (GitHub classic/fine-grained PATs, OpenAI
  // keys) posted through the form must store, NOT hit the chat paste-guard
  // redirect. Pre-fix, connectExtension's looksLikeObviousSecret fired on
  // the upload api_key too (the canary's fixture secret never matched the
  // patterns, so only the 400 redirected here).
  test.each([
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "github_pat_abcdefghijklmnopqrstuvwxyz1234567890",
    "sk-abcdefghijklmnopqrstuvwxyz1234567890",
  ])("a real-shaped %s pasted through the upload POST is stored, not redirected", async (secret) => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "fixture.weather",
        scope: "personal",
        actor: "UADA",
        label: "Fixture Weather",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const upload = await postSecret(url, secret);
      expect(upload.status).toBe(200);
      expect(await upload.text()).toContain("Saved to the vault");

      // The broker saw the real value and the vault row landed — the same
      // connect path as any other upload, minus the chat paste guard.
      expect(h.broker.calls).toEqual([
        expect.objectContaining({ provider: "fixture.weather", credentialType: "api_key", apiKey: secret }),
      ]);
      const rows = await rowsFor(h.store, "fixture.weather");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.owner).toBe("UADA");
    } finally {
      endpoint.stop();
    }
  });

  test("an org-scope upload crosses the policy gate and records the org row", async () => {
    const router = new RecordingRouter({ approved: true });
    const h = makeDeps({ policy: allowedPolicy(), router });
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "fixture.weather",
        scope: "org",
        actor: "UADA",
        spaceId: "slack:C1",
        label: "Fixture Weather",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const upload = await postSecret(url, "attio-secret-key");
      expect(upload.status).toBe(200);

      expect(h.router.requests).toHaveLength(1);
      expect(h.router.requests[0]!.tool).toBe(CONNECT_EXTENSION_TOOL);
      expect(h.router.requests[0]!.spaceId).toBe("slack:C1");
      const rows = await rowsFor(h.store, "fixture.weather");
      expect(rows[0]!.owner).toBeNull();
      expect(rows[0]!.scope).toBe("org");
    } finally {
      endpoint.stop();
    }
  });

  test("single-use: a replayed POST is refused and stores nothing twice", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "fixture.weather",
        scope: "personal",
        actor: "UADA",
        label: "Fixture Weather",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const first = await postSecret(url, "attio-secret-key");
      expect(first.status).toBe(200);

      const replay = await postSecret(url, "attio-secret-key");
      expect(replay.status).toBe(404); // fail closed: consumed tokens are gone

      expect(h.broker.calls).toHaveLength(1);
      expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(1);
    } finally {
      endpoint.stop();
    }
  });

  test("expired tokens are refused (fail closed)", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "fixture.weather",
        scope: "personal",
        actor: "UADA",
        label: "Fixture Weather",
        expiresAt: Date.now() - 1_000, // already past its TTL
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const upload = await postSecret(url, "attio-secret-key");
      expect(upload.status).toBe(404);
      expect(h.broker.calls).toHaveLength(0);
      expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(0);
    } finally {
      endpoint.stop();
    }
  });

  test("an unknown token is refused on GET and POST", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const url = `${endpoint.baseUrl}/upload/not-a-real-token`;
      expect((await fetch(url)).status).toBe(404);
      expect((await postSecret(url, "attio-secret-key")).status).toBe(404);
    } finally {
      endpoint.stop();
    }
  });

  test("an empty secret is refused with 400", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      for (const empty of ["", "   "]) {
        const minted = endpoint.store.mint({
          extension: "fixture.weather",
          scope: "personal",
          actor: "UADA",
          label: "Fixture Weather",
        });
        expect(minted.ok).toBe(true);
        const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;
        expect((await postSecret(url, empty)).status).toBe(400);
      }
      expect(h.broker.calls).toHaveLength(0);
    } finally {
      endpoint.stop();
    }
  });

  test("the per-IP attempt cap fails closed with 429", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps, { maxAttemptsPerIp: 3, attemptsWindowMs: 60_000 });
    try {
      // Three attempts exhaust the window; the fourth is refused regardless
      // of the token.
      const url = `${endpoint.baseUrl}/upload/nope`;
      expect((await postSecret(url, "a")).status).toBe(404);
      expect((await postSecret(url, "b")).status).toBe(404);
      expect((await postSecret(url, "c")).status).toBe(404);
      expect((await postSecret(url, "d")).status).toBe(429);
    } finally {
      endpoint.stop();
    }
  });
});

describe("boot-secret provisioning via the upload link (issue #201)", () => {
  test("boot secrets mint by their vault provider id without a registry entry", async () => {
    const store = new UploadLinkStore(freshStore(), { maxOutstandingPerActor: BOOT_SECRETS.length });
    for (const id of ["slack-app", "slack-bot", "opencode", "near", "openai", "anthropic", "tavily", "github-webhook"]) {
      const outcome = await mintUploadLink(
        { extension: id, scope: "org", actor: "UADA" },
        { registry: registry(), store, baseUrl: () => "http://127.0.0.1:9", resolvePublicBase: noPublicBase },
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.url).toContain(`http://127.0.0.1:9/upload/`);
    }
  });

  test("a boot-secret upload stores the api_key row in the vault — no registry row", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "near",
        scope: "personal",
        actor: "UADA",
        label: "NEAR AI Cloud key",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const secret = "near-vault-key";
      const upload = await postSecret(url, secret);
      expect(upload.status).toBe(200);
      expect(await upload.text()).toContain("Saved to the vault");

      // The broker saw the value under the boot secret's provider identity…
      expect(h.broker.calls).toEqual([{ provider: "near", credentialType: "api_key", apiKey: secret }]);
      // …and NO extension registry row exists (boot secrets have no manifest).
      expect(await rowsFor(h.store, "near")).toHaveLength(0);
      const audit = await h.store.listAudit({ event_type: SECRET_PROVISIONED_EVENT });
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0]!.payload)).toEqual({ secret: "near", scope: "personal", owner: "UADA" });
    } finally {
      endpoint.stop();
    }
  });

  test("an org-scope boot-secret upload crosses the policy gate", async () => {
    const router = new RecordingRouter({ approved: true });
    const h = makeDeps({ policy: allowedPolicy(), router });
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "openai",
        scope: "org",
        actor: "UADA",
        spaceId: "slack:C1",
        label: "OpenAI key",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const upload = await postSecret(url, "sk-openai-vault");
      expect(upload.status).toBe(200);

      expect(h.router.requests).toHaveLength(1);
      expect(h.router.requests[0]!.tool).toBe(CONNECT_EXTENSION_TOOL);
      expect(h.router.requests[0]!.spaceId).toBe("slack:C1");
      expect(h.broker.calls).toEqual([{ provider: "openai", credentialType: "api_key", apiKey: "sk-openai-vault" }]);
      const audit = await h.store.listAudit({ event_type: SECRET_PROVISIONED_EVENT });
      expect(JSON.parse(audit[0]!.payload)).toEqual({ secret: "openai", scope: "org", owner: null });
    } finally {
      endpoint.stop();
    }
  });

  test("a denied org gate stores nothing (fail closed)", async () => {
    const router = new RecordingRouter({ approved: false });
    const h = makeDeps({ policy: allowedPolicy(), router });
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "slack-app",
        scope: "org",
        actor: "UADA",
        label: "Slack app-level token",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const upload = await postSecret(url, "xapp-denied");
      expect(upload.status).toBe(400);
      expect(h.broker.calls).toHaveLength(0);
      expect(await h.store.listAudit({ event_type: SECRET_PROVISIONED_EVENT })).toHaveLength(0);
    } finally {
      endpoint.stop();
    }
  });
});

describe("upload link minting (issue #196)", () => {
  test("mint is rate-limited per actor (outstanding cap)", () => {
    const store = new UploadLinkStore(freshStore(), { maxOutstandingPerActor: 2 });
    const first = store.mint({ extension: "fixture.weather", scope: "personal", actor: "UADA", label: "Fixture Weather" });
    const second = store.mint({ extension: "fixture.weather", scope: "personal", actor: "UADA", label: "Fixture Weather" });
    const third = store.mint({ extension: "fixture.weather", scope: "personal", actor: "UADA", label: "Fixture Weather" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toContain("too many outstanding");
  });

  test("arch: the minted token is 144 random bits (18 bytes, 24 base64url chars)", () => {
    // architecture.md: "mints a 144-bit opaque token". 18 random bytes →
    // 24 base64url chars with no padding (18 % 3 == 0). Two mints must
    // never collide — the token is the unguessable upload secret.
    const store = new UploadLinkStore(freshStore());
    const one = store.mint({ extension: "fixture.weather", scope: "personal", actor: "UADA", label: "Fixture Weather" });
    const two = store.mint({ extension: "fixture.weather", scope: "personal", actor: "UADA", label: "Fixture Weather" });
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(two.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(one.token).not.toBe(two.token);
  });

  test("arch: the default cap is five live links per actor (UPLOAD_LINK_MAX_OUTSTANDING_PER_ACTOR)", () => {
    // architecture.md: "limited to five live links per actor". The default
    // cap (not a custom override) must refuse the sixth outstanding link.
    expect(UPLOAD_LINK_MAX_OUTSTANDING_PER_ACTOR).toBe(5);
    const db = freshStore();
    const store = new UploadLinkStore(db); // default cap
    const minted: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const r = store.mint({ extension: "fixture.weather", scope: "personal", actor: "UADA", label: `Weather ${i}` });
      minted.push(r.ok);
      if (!r.ok) expect(r.reason).toContain("too many outstanding");
    }
    expect(minted).toEqual([true, true, true, true, true, false]);
    // The live-link count is tracked in the SQLite table: exactly the five
    // successful mints are outstanding for the actor.
    expect(db.countActiveUploadTokens("UADA")).toBe(5);
  });

  test("arch: the token lives in the SQLite upload_tokens table (durable backing, not memory)", () => {
    // architecture.md: mint "in SQLite". The token must be queryable back
    // through the raw store's table read (UploadLinkStore.peek is just a
    // thin slice over it), proving the secret survives outside the
    // upload-link process object.
    const db = freshStore();
    const store = new UploadLinkStore(db);
    const minted = store.mint({ extension: "fixture.weather", scope: "personal", actor: "UADA", label: "Fixture Weather" });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const row = db.getUploadToken(minted.token); // the direct SQLite table read
    expect(row).not.toBeNull();
    expect(row?.actor).toBe("UADA");
    expect(row?.extension).toBe("fixture.weather");
    expect(db.countActiveUploadTokens("UADA")).toBe(1);
  });

  test("oauth extensions cannot mint — they have no secret to upload", async () => {
    const store = new UploadLinkStore(freshStore());
    const outcome = await mintUploadLink(
      { extension: "com.example.oauth", scope: "personal", actor: "UADA" },
      { registry: registry(), store, baseUrl: () => "http://127.0.0.1:9", resolvePublicBase: noPublicBase },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("OAuth");
  });

  test("unknown extensions cannot mint", async () => {
    const store = new UploadLinkStore(freshStore());
    const outcome = await mintUploadLink(
      { extension: "com.nope", scope: "personal", actor: "UADA" },
      { registry: registry(), store, baseUrl: () => "http://127.0.0.1:9", resolvePublicBase: noPublicBase },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("unknown extension");
  });

  test("mintUploadLinkToolDefinition returns the single-use URL for the session principal", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const tool = mintUploadLinkToolDefinition({
        registry: h.deps.registry,
        store: endpoint.store,
        baseUrl: () => endpoint.baseUrl,
        resolvePublicBase: noPublicBase,
        getPrincipal: () => "UADA",
        spaceIdFromFile: (file) => (file === "slack:C1.jsonl" ? "slack:C1" : undefined),
      });

      const result = await tool.execute(
        "t1",
        { extension: "fixture.weather", scope: "personal", connection_id: undefined, expected_revision: undefined },
        undefined,
        undefined,
        // SAFETY: the upload-link tool never reads the execute context; a minimal sessionManager fake satisfies the arity.
        { sessionManager: { getSessionFile: () => "slack:C1.jsonl" } } as never,
      );
      expect(result.isError).toBeUndefined();
      // SAFETY: the tool replies with a single text content block carrying the upload URL.
      const text = (result.content[0] as { text: string }).text;
      // Issue #210: the result carries the URL verbatim on its own line.
      const url = text.split("\n")[0]!;
      expect(url.startsWith(`${endpoint.baseUrl}/upload/`)).toBe(true);

      // The minted token is real: the endpoint's store consumes it.
      const token = url.slice(endpoint.baseUrl.length + "/upload/".length);
      const consumed = endpoint.store.consume(token);
      expect(consumed.ok).toBe(true);
      if (consumed.ok) {
        expect(consumed.row.actor).toBe("UADA");
        expect(consumed.row.space_id).toBe("slack:C1");
      }
    } finally {
      endpoint.stop();
    }
  });

  test("the mint tool anchors its reply to the minted public URL — never a loopback (issue #210)", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    // Issue #211: the "tunnel" is a live Bun.serve stub (404 on unknown
    // paths, exactly like the real inbound surface) — the tool's DEFAULT
    // resolver health-checks the configured base and must mint with it.
    const tunnel = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not found", { status: 404 }) });
    try {
      // The post-fix wiring expression server/index.ts uses: baseUrl is
      // the loopback FALLBACK only; the mint resolves the PUBLIC base
      // itself (health-checked, issue #211). A configured public base is
      // the bug's trigger: the agent re-emitted the token with a loopback
      // base pattern-copied from older context, rendering a dead link.
      const baseUrl = () => endpoint.baseUrl;
      const saved = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = `http://127.0.0.1:${tunnel.port}`;
      try {
        const tool = mintUploadLinkToolDefinition({
          registry: h.deps.registry,
          store: endpoint.store,
          baseUrl,
          getPrincipal: () => "UADA",
        });
        const result = await tool.execute(
          "t1",
          { extension: "fixture.weather", scope: "personal", connection_id: undefined, expected_revision: undefined },
          undefined,
          undefined,
          // SAFETY: the upload-link tool never reads the execute context; a minimal sessionManager fake satisfies the arity.
          { sessionManager: { getSessionFile: () => null } } as never,
        );
        expect(result.isError).toBeUndefined();
        // SAFETY: the mint tool replies with a single text content block
        // (the SDK tool-result contract); text is that block.
        const text = (result.content[0] as { text: string }).text;
        // The minted URL is anchored verbatim (first line)…
        const url = text.split("\n")[0]!;
        expect(url.startsWith(`http://127.0.0.1:${tunnel.port}/upload/`)).toBe(true);
        // …with an explicit relay contract the agent must follow…
        expect(text).toContain("exactly as written");
        // …a LIVE public base mints without a staleness warning…
        expect(text).not.toMatch(/WARNING|unreachable|stale/i);
        // …and no loopback base can leak into the reply.
        expect(text).not.toMatch(new RegExp(`127\\.0\\.0\\.1:${endpoint.baseUrl.split(":").pop()}`));

        // The token is real: the SHARED endpoint store consumes it.
        const token = url.slice(`http://127.0.0.1:${tunnel.port}/upload/`.length);
        const consumed = endpoint.store.consume(token);
        expect(consumed.ok).toBe(true);
        if (consumed.ok) expect(consumed.row.actor).toBe("UADA");
      } finally {
        if (saved === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
        else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = saved;
      }
    } finally {
      tunnel.stop();
      endpoint.stop();
    }
  });
});

describe("upload link public base + stable port (issue #196)", () => {
  test("uploadLinkPublicBase reads the #198 public-base env when no durable store is present (absent/empty → undefined)", () => {
    const savedFile = process.env.BOTTEGA_PUBLIC_BASE_URL_FILE;
    const saved = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
    try {
      // Hermetic (issue #249): point the durable-store path at a temp file
      // that never exists, so this leg exercises env-ONLY resolution.
      process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = join(dir, "no-public-base");
      delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      expect(uploadLinkPublicBase()).toBeUndefined();
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "";
      expect(uploadLinkPublicBase()).toBeUndefined();
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "https://upload.example.com";
      expect(uploadLinkPublicBase()).toBe("https://upload.example.com");
    } finally {
      if (savedFile === undefined) delete process.env.BOTTEGA_PUBLIC_BASE_URL_FILE;
      else process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = savedFile;
      if (saved === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = saved;
    }
  });

  test("uploadLinkPublicBase prefers the durable store, then the env, then undefined (issue #249)", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "bottega-public-base-"));
    const storeFile = join(storeDir, "public-base-url");
    const savedFile = process.env.BOTTEGA_PUBLIC_BASE_URL_FILE;
    const saved = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
    try {
      process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = storeFile;
      delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      // Neither source present → undefined.
      expect(uploadLinkPublicBase()).toBeUndefined();

      // The durable store is written (the rotating tunnel, issue #249) → it wins.
      writeFileSync(storeFile, "https://tunnel-a.trycloudflare.com\n");
      expect(uploadLinkPublicBase()).toBe("https://tunnel-a.trycloudflare.com");

      // The env is a deployment-only override: the store still wins.
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "https://env.example.com";
      expect(uploadLinkPublicBase()).toBe("https://tunnel-a.trycloudflare.com");

      // Store cleared (whitespace) → the env wins.
      writeFileSync(storeFile, "  \n");
      expect(uploadLinkPublicBase()).toBe("https://env.example.com");

      // Both absent → undefined.
      delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      expect(uploadLinkPublicBase()).toBeUndefined();

      // Store removed mid-process → the env wins (an unreadable store never
      // errors out of the resolution).
      writeFileSync(storeFile, "https://tunnel-b.trycloudflare.com");
      rmSync(storeFile);
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "https://env.example.com";
      expect(uploadLinkPublicBase()).toBe("https://env.example.com");
    } finally {
      if (savedFile === undefined) delete process.env.BOTTEGA_PUBLIC_BASE_URL_FILE;
      else process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = savedFile;
      if (saved === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = saved;
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  test("the mint returns the public base URL when configured and reachable, else the loopback fallback", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    // Issue #211: the "tunnel" is a live Bun.serve stub (404 on unknown
    // paths, exactly like the real inbound surface). The mint's DEFAULT
    // resolver probes the configured base — the post-fix server/index.ts
    // wiring: baseUrl is the loopback fallback only.
    const tunnel = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not found", { status: 404 }) });
    try {
      const baseUrl = () => endpoint.baseUrl;
      const saved = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      try {
        delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
        const local = await mintUploadLink(
          { extension: "fixture.weather", scope: "personal", actor: "UADA" },
          { registry: registry(), store: endpoint.store, baseUrl },
        );
        expect(local.ok).toBe(true);
        if (local.ok) {
          expect(local.url.startsWith(`${endpoint.baseUrl}/upload/`)).toBe(true);
          expect(local.warning).toBeUndefined(); // absent env is the normal local-dev posture
        }

        process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = `http://127.0.0.1:${tunnel.port}`;
        const remote = await mintUploadLink(
          { extension: "fixture.weather", scope: "personal", actor: "UADA" },
          { registry: registry(), store: endpoint.store, baseUrl },
        );
        expect(remote.ok).toBe(true);
        if (remote.ok) {
          expect(remote.url.startsWith(`http://127.0.0.1:${tunnel.port}/upload/`)).toBe(true);
          expect(remote.warning).toBeUndefined(); // the live probe passed
          // The public prefix changes only the browser-facing base: the
          // token is the same single-use token the loopback endpoint burns.
          const token = remote.url.slice(`http://127.0.0.1:${tunnel.port}/upload/`.length);
          expect(endpoint.store.consume(token).ok).toBe(true);
        }
      } finally {
        if (saved === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
        else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = saved;
      }
    } finally {
      tunnel.stop();
      endpoint.stop();
    }
  });

  test("BOTTEGA_CALLBACK_PORT pins the listener; absent → ephemeral", () => {
    const saved = process.env.BOTTEGA_CALLBACK_PORT;
    const h = makeDeps();
    try {
      process.env.BOTTEGA_CALLBACK_PORT = "18765";
      const pinned = startUploadLinkServer(h.deps);
      try {
        expect(pinned.baseUrl).toBe("http://127.0.0.1:18765");
      } finally {
        pinned.stop();
      }
      delete process.env.BOTTEGA_CALLBACK_PORT;
      const ephemeral = startUploadLinkServer(h.deps);
      try {
        expect(ephemeral.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
        expect(ephemeral.baseUrl).not.toBe("http://127.0.0.1:18765");
      } finally {
        ephemeral.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
      else process.env.BOTTEGA_CALLBACK_PORT = saved;
    }
  });

  test("an invalid BOTTEGA_CALLBACK_PORT fails closed at bind time", () => {
    const saved = process.env.BOTTEGA_CALLBACK_PORT;
    const h = makeDeps();
    try {
      process.env.BOTTEGA_CALLBACK_PORT = "not-a-port";
      expect(() => startUploadLinkServer(h.deps)).toThrow(/BOTTEGA_CALLBACK_PORT/);
    } finally {
      if (saved === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
      else process.env.BOTTEGA_CALLBACK_PORT = saved;
    }
  });

  test("the endpoint binds loopback only — never a non-loopback interface", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      // The running listener's own bound address is the authoritative
      // loopback-only proof: a wildcard bind ("0.0.0.0" / "::") surfaces
      // here as a different hostname and fails the assertion. The baseUrl
      // string alone cannot catch that — it is a constant, not the bound
      // address.
      expect(endpoint.hostname).toBe("127.0.0.1");
      expect(endpoint.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
      // Probe the first non-loopback IPv4 address, when one exists: the
      // form must be unobtainable there while the loopback URL serves — the
      // tunnel / proxy terminates at the host and forwards; the listener
      // itself never exposes the form to the network. The probe must accept
      // BOTH network shapes: some refuse the hop (connection refused), while
      // NAT/gateway setups answer with their own HTTP error (e.g. a 502).
      // Either is proof it is not our listener — only a response that is our
      // listener's own 404/invalid-link answer on that port would violate
      // the loopback-only guarantee.
      const lan = Object.values(networkInterfaces())
        .flat()
        .find((iface) => iface !== undefined && !iface.internal && iface.family === "IPv4");
      if (lan !== undefined) {
        const port = endpoint.baseUrl.slice("http://127.0.0.1:".length);
        const probe = `http://${lan.address}:${port}/upload/nope`;
        try {
          const r = await fetch(probe, { signal: AbortSignal.timeout(1_000) });
          // Resolved: it must NOT be OUR listener answering this route. Our
          // listener serves GET /upload/nope with 404 + its invalid-link
          // body; any other status/body (a gateway 502, a foreign 404 page,
          // ...) is a different host and is exactly the pass condition.
          const body = await r.text();
          expect(r.status === 404 && body.includes("this upload link is invalid")).toBe(false);
        } catch {
          // Connection refused (or unresponsive): nothing at the LAN address
          // answers this route — the listener is not reachable off loopback.
        }
        expect((await fetch(`${endpoint.baseUrl}/upload/nope`)).status).toBe(404);
      }
    } finally {
      endpoint.stop();
    }
  });
});

describe("upload link public base liveness (issue #211)", () => {
  /** The mint reply's URL line: the warning block precedes the relay text. */
  function urlLine(text: string): string {
    return text.split("\n").find((line) => line.startsWith("http://"))!;
  }

  test("a dead configured public URL (5xx from the ingress) → the mint falls back to loopback WITH a loud warning", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    // The tunnel is GONE but the hostname still resolves: Cloudflare's edge
    // answers 502/530 for the dead quick tunnel — the observed canary
    // failure mode (run msyi15gi-iwa). The app's own surface never 5xxs an
    // unknown path, so a 5xx means the ingress cannot reach the listener.
    const deadTunnel = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("Bad Gateway", { status: 502 }),
    });
    try {
      const saved = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = `http://127.0.0.1:${deadTunnel.port}`;
      try {
        const tool = mintUploadLinkToolDefinition({
          registry: h.deps.registry,
          store: endpoint.store,
          baseUrl: () => endpoint.baseUrl, // the post-fix wiring: loopback fallback only
          getPrincipal: () => "UADA",
        });
        const result = await tool.execute(
          "t1",
          { extension: "fixture.weather", scope: "personal", connection_id: undefined, expected_revision: undefined },
          undefined,
          undefined,
          // SAFETY: the upload-link tool never reads the execute context; a minimal sessionManager fake satisfies the arity.
          { sessionManager: { getSessionFile: () => null } } as never,
        );
        expect(result.isError).toBeUndefined();
        // SAFETY: the mint tool replies with a single text content block
        // (the SDK tool-result contract); text is that block.
        const text = (result.content[0] as { text: string }).text;
        // The warning is LOUD and actionable: it names the env var, says
        // the tunnel URL is stale, and flags the link as loopback-only.
        expect(text).toContain("WARNING");
        expect(text).toContain("BOTTEGA_OAUTH_CALLBACK_BASE_URL");
        expect(text).toContain("stale");
        expect(text).toContain("LOOPBACK-only");
        // The minted link is the loopback fallback — never the dead URL…
        const url = urlLine(text);
        expect(url.startsWith(`${endpoint.baseUrl}/upload/`)).toBe(true);
        // …and the relay contract still anchors the reply to that URL.
        expect(text).toContain("exactly as written");
        const token = url.slice(endpoint.baseUrl.length + "/upload/".length);
        expect(endpoint.store.consume(token).ok).toBe(true);
      } finally {
        if (saved === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
        else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = saved;
      }
    } finally {
      deadTunnel.stop();
      endpoint.stop();
    }
  });

  test("a dead configured public URL (connection refused) → the mint falls back to loopback WITH a loud warning", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    // The tunnel process is DOWN: nothing listens on the host — the probe's
    // connection is refused (the DNS-failure leg of the liveness check;
    // hermetically equivalent and local).
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const deadPort = dead.port;
    dead.stop();
    try {
      const saved = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = `http://127.0.0.1:${deadPort}`;
      try {
        const outcome = await mintUploadLink(
          { extension: "fixture.weather", scope: "personal", actor: "UADA" },
          { registry: registry(), store: endpoint.store, baseUrl: () => endpoint.baseUrl },
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.url.startsWith(`${endpoint.baseUrl}/upload/`)).toBe(true);
          expect(outcome.warning).toBeDefined();
          expect(outcome.warning).toContain("WARNING");
          expect(outcome.warning).toContain("stale");
        }
      } finally {
        if (saved === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
        else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = saved;
      }
    } finally {
      endpoint.stop();
    }
  });
});

describe("shared public base across worktrees (issue #293)", () => {
  test("a mint from a worktree-shaped cwd (no local data/public-base-url) uses the shared store the dev launcher propagated", async () => {
    // The chat failure: the live dev server restarted from
    // .worktrees/<name>, whose data/ has no public-base-url, while the
    // canonical checkout's store held the live tunnel URL — so the mint
    // fell back to the loopback URL. scripts/dev.sh now propagates the
    // CANONICAL store path via BOTTEGA_PUBLIC_BASE_URL_FILE (the #249 env
    // contract); the server never guesses repo topology.
    const top = mkdtempSync(join(tmpdir(), "bottega-worktree-base-"));
    const sharedStore = join(top, "checkout", "data", "public-base-url");
    const worktreeCwd = join(top, "checkout", ".worktrees", "feature");
    mkdirSync(dirname(sharedStore), { recursive: true });
    mkdirSync(worktreeCwd, { recursive: true });

    const savedFile = process.env.BOTTEGA_PUBLIC_BASE_URL_FILE;
    const savedEnv = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
    const savedCwd = process.cwd();
    try {
      process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = sharedStore;
      delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      process.chdir(worktreeCwd);
      // Reproduces the failure shape exactly: this cwd has NO local store.
      expect(existsSync(join(worktreeCwd, "data", "public-base-url"))).toBe(false);
      // The #249 resolution (store first, env second, then undefined) still
      // finds the CANONICAL store from a worktree cwd — the fix.
      writeFileSync(sharedStore, "https://tunnel-a.trycloudflare.com\n");
      expect(uploadLinkPublicBase()).toBe("https://tunnel-a.trycloudflare.com");

      // Caller-level: the mint's DEFAULT resolver (the post-fix
      // server/index.ts wiring) health-checks the resolved base and mints
      // with it — a live loopback stub stands in for the tunnel.
      const tunnel = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not found", { status: 404 }) });
      try {
        writeFileSync(sharedStore, `http://127.0.0.1:${tunnel.port}\n`);
        const h = makeDeps();
        const endpoint = startUploadLinkServer(h.deps);
        try {
          const outcome = await mintUploadLink(
            { extension: "fixture.weather", scope: "personal", actor: "UADA" },
            { registry: registry(), store: endpoint.store, baseUrl: () => endpoint.baseUrl },
          );
          expect(outcome.ok).toBe(true);
          if (outcome.ok) {
            expect(outcome.url.startsWith(`http://127.0.0.1:${tunnel.port}/upload/`)).toBe(true);
            expect(outcome.warning).toBeUndefined(); // the live probe passed
          }
        } finally {
          endpoint.stop();
        }
      } finally {
        tunnel.stop();
      }
    } finally {
      if (savedFile === undefined) delete process.env.BOTTEGA_PUBLIC_BASE_URL_FILE;
      else process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = savedFile;
      if (savedEnv === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = savedEnv;
      process.chdir(savedCwd);
      rmSync(top, { recursive: true, force: true });
    }
  });
});

describe("static OAuth client provisioning via the upload link (issue #288)", () => {
  const STATIC_CLIENT_ID = "static-client-123.apps.example";
  const STATIC_CLIENT_SECRET = "static-secret-456";

  /** POSTs client_id + client_secret to the one-time upload URL (the browser leg). */
  function postStaticClient(url: string, clientId: string, clientSecret: string): Promise<Response> {
    const body = new FormData();
    body.append("client_id", clientId);
    body.append("client_secret", clientSecret);
    return fetch(url, { method: "POST", body });
  }

  /** The recorded opaque api_key payload the vault store writes. */
  function expectedOpaqueJson(client: StaticOAuthClient): string {
    return JSON.stringify({ client_id: client.client_id, client_secret: client.client_secret });
  }

  test("hosted OAuth extensions mint an ORG-scoped static-client link (two-field browser form), and the POST stores the opaque api_key under the synthetic provider key", async () => {
    const stub = new CapabilityStub();
    stub.registrationEndpoint = false; // the Gmail-class no-DCR shape
    try {
      const h = makeDeps({ registry: registryWithOauthAt(stub.mcpUrl), policy: allowedPolicy() });
      const endpoint = startUploadLinkServer(h.deps);
      try {
        const minted = await mintUploadLink(
          { extension: "com.example.oauth", scope: "org", actor: "UADA", spaceId: "slack:C1" },
          { registry: h.deps.registry, store: endpoint.store, baseUrl: () => endpoint.baseUrl, resolvePublicBase: noPublicBase },
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;
        expect(minted.mode).toBe("static_client");
        const url = minted.url;

        // The form renders TWO separate fields — client ID + client secret —
        // and never echoes a value.
        const form = await fetch(url);
        expect(form.status).toBe(200);
        const html = await form.text();
        expect(html).toContain("Example OAuth");
        expect(html).toContain('name="client_id"');
        expect(html).toContain('name="client_secret"');
        expect(html).toContain("PRE-REGISTERED OAuth client");
        expect(html).not.toContain(STATIC_CLIENT_ID);
        expect(html).not.toContain(STATIC_CLIENT_SECRET);

        // POST → the ORG gate → the vault store seam: the broker saw an
        // OPAQUE api_key under the SYNTHETIC provider key, never the real
        // extension id (per-user OAuth token rows stay separate).
        const upload = await postStaticClient(url, STATIC_CLIENT_ID, STATIC_CLIENT_SECRET);
        expect(upload.status).toBe(200);
        expect(await upload.text()).toContain("Saved to the vault");
        expect(h.router.requests).toHaveLength(1);
        expect(h.router.requests[0]!.tool).toBe(CONNECT_EXTENSION_TOOL);
        expect(h.router.requests[0]!.spaceId).toBe("slack:C1");
        expect(h.broker.calls).toEqual([
          {
            provider: staticOAuthClientProviderKey("com.example.oauth"),
            credentialType: "api_key",
            apiKey: expectedOpaqueJson({ client_id: STATIC_CLIENT_ID, client_secret: STATIC_CLIENT_SECRET }),
          },
        ]);
        // No extension registry row: the static client is deployment state,
        // not a per-user credential (the same ladder as boot secrets).
        expect(await rowsFor(h.store, "com.example.oauth")).toHaveLength(0);
        // The audit row carries METADATA ONLY — extension/scope/owner/status,
        // never the client values.
        const audit = await h.store.listAudit({ event_type: STATIC_CLIENT_PROVISIONED_EVENT });
        expect(audit).toHaveLength(1);
        expect(JSON.parse(audit[0]!.payload)).toEqual({
          extension: "com.example.oauth",
          scope: "org",
          owner: null,
          status: "provisioned",
        });
        const auditText = JSON.stringify(JSON.parse(audit[0]!.payload));
        expect(auditText).not.toContain(STATIC_CLIENT_ID);
        expect(auditText).not.toContain(STATIC_CLIENT_SECRET);
      } finally {
        endpoint.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("a DCR-capable hosted OAuth extension REFUSES the static-client mint — the old direct-connect guidance, nothing minted or stored", async () => {
    const stub = new CapabilityStub(); // registrationEndpoint defaults true
    try {
      const h = makeDeps({ registry: registryWithOauthAt(stub.mcpUrl) });
      const endpoint = startUploadLinkServer(h.deps);
      try {
        const outcome = await mintUploadLink(
          { extension: "com.example.oauth", scope: "org", actor: "UADA" },
          { registry: h.deps.registry, store: endpoint.store, baseUrl: () => endpoint.baseUrl, resolvePublicBase: noPublicBase },
        );
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          // DCR-capable servers keep the pre-#288 guidance: connect directly.
          expect(outcome.message).toContain("connect it directly");
          expect(outcome.message).toContain("no secret to upload");
        }
        // Nothing minted (no upload token), nothing stored (no vault row).
        expect(h.store.countActiveUploadTokens("UADA")).toBe(0);
        expect(h.broker.calls).toHaveLength(0);
        expect(await h.store.listAudit({ event_type: STATIC_CLIENT_PROVISIONED_EVENT })).toHaveLength(0);
      } finally {
        endpoint.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("an UNKNOWN dynamic-registration capability (discovery failure) fails closed — no static-client link is minted", async () => {
    const stub = new CapabilityStub();
    stub.metadata = false; // the AS metadata 404s → discovery cannot establish no-DCR
    try {
      const h = makeDeps({ registry: registryWithOauthAt(stub.mcpUrl) });
      const endpoint = startUploadLinkServer(h.deps);
      try {
        const outcome = await mintUploadLink(
          { extension: "com.example.oauth", scope: "org", actor: "UADA" },
          { registry: h.deps.registry, store: endpoint.store, baseUrl: () => endpoint.baseUrl, resolvePublicBase: noPublicBase },
        );
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.message).toContain("no secret to upload");
        expect(h.store.countActiveUploadTokens("UADA")).toBe(0);
        expect(h.broker.calls).toHaveLength(0);
      } finally {
        endpoint.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("static-client provisioning is ORG-only: a personal-scope mint is refused and a personal-scope POST fails closed", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      // The mint refuses personal scope for a hosted OAuth extension.
      const minted = await mintUploadLink(
        { extension: "com.example.oauth", scope: "personal", actor: "UADA" },
        { registry: h.deps.registry, store: endpoint.store, baseUrl: () => endpoint.baseUrl, resolvePublicBase: noPublicBase },
      );
      expect(minted.ok).toBe(false);
      if (!minted.ok) {
        expect(minted.message).toContain("OAuth");
        expect(minted.message).toContain("org-scoped");
      }

      // Defense in depth: a PERSONAL-scope static token (minted directly,
      // bypassing the mint gate) still fails closed at the POST.
      const personal = endpoint.store.mint({
        extension: "com.example.oauth",
        scope: "personal",
        actor: "UADA",
        label: "Example OAuth",
      });
      expect(personal.ok).toBe(true);
      if (!personal.ok) return;
      const res = await postStaticClient(`${endpoint.baseUrl}/upload/${personal.token}`, STATIC_CLIENT_ID, STATIC_CLIENT_SECRET);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("org-scoped");
      expect(h.broker.calls).toHaveLength(0);
      expect(await h.store.listAudit({ event_type: STATIC_CLIENT_PROVISIONED_EVENT })).toHaveLength(0);
    } finally {
      endpoint.stop();
    }
  });

  test("malformed / empty / oversized client values are refused with 400 and store nothing", async () => {
    const h = makeDeps({ policy: allowedPolicy() });
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const cases: Array<[string, string]> = [
        ["", STATIC_CLIENT_SECRET], // empty client id
        [STATIC_CLIENT_ID, ""], // empty client secret
        ["   ", STATIC_CLIENT_SECRET], // whitespace-only client id
        ["c".repeat(513), STATIC_CLIENT_SECRET], // oversized client id
        [STATIC_CLIENT_ID, "s".repeat(513)], // oversized client secret
      ];
      for (const [clientId, clientSecret] of cases) {
        const minted = endpoint.store.mint({
          extension: "com.example.oauth",
          scope: "org",
          actor: "UADA",
          label: "Example OAuth",
        });
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;
        const res = await postStaticClient(`${endpoint.baseUrl}/upload/${minted.token}`, clientId, clientSecret);
        expect(res.status).toBe(400);
      }
      expect(h.broker.calls).toHaveLength(0);
      expect(await h.store.listAudit({ event_type: STATIC_CLIENT_PROVISIONED_EVENT })).toHaveLength(0);
    } finally {
      endpoint.stop();
    }
  });

  test("single-use: a replayed static-client POST stores nothing twice", async () => {
    const h = makeDeps({ policy: allowedPolicy() });
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "com.example.oauth",
        scope: "org",
        actor: "UADA",
        label: "Example OAuth",
      });
      expect(minted.ok).toBe(true);
      if (!minted.ok) return;
      const url = `${endpoint.baseUrl}/upload/${minted.token}`;

      const first = await postStaticClient(url, STATIC_CLIENT_ID, STATIC_CLIENT_SECRET);
      expect(first.status).toBe(200);
      const replay = await postStaticClient(url, STATIC_CLIENT_ID, STATIC_CLIENT_SECRET);
      expect(replay.status).toBe(404); // fail closed: the consumed token is gone

      expect(h.broker.calls).toHaveLength(1);
      expect(await h.store.listAudit({ event_type: STATIC_CLIENT_PROVISIONED_EVENT })).toHaveLength(1);
    } finally {
      endpoint.stop();
    }
  });

  test("a denied org gate stores nothing (fail closed)", async () => {
    const router = new RecordingRouter({ approved: false });
    const h = makeDeps({ policy: allowedPolicy(), router });
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "com.example.oauth",
        scope: "org",
        actor: "UADA",
        label: "Example OAuth",
      });
      expect(minted.ok).toBe(true);
      if (!minted.ok) return;

      const res = await postStaticClient(`${endpoint.baseUrl}/upload/${minted.token}`, STATIC_CLIENT_ID, STATIC_CLIENT_SECRET);
      expect(res.status).toBe(400);
      expect(h.broker.calls).toHaveLength(0);
      expect(await h.store.listAudit({ event_type: STATIC_CLIENT_PROVISIONED_EVENT })).toHaveLength(0);
    } finally {
      endpoint.stop();
    }
  });

  test("the mint reply for a static-client link relays the URL verbatim and names the two fields — no values", async () => {
    const stub = new CapabilityStub();
    stub.registrationEndpoint = false; // no-DCR → the static-client link mints
    try {
      const h = makeDeps({ registry: registryWithOauthAt(stub.mcpUrl) });
      const endpoint = startUploadLinkServer(h.deps);
      try {
        const tool = mintUploadLinkToolDefinition({
          registry: h.deps.registry,
          store: endpoint.store,
          baseUrl: () => endpoint.baseUrl,
          resolvePublicBase: noPublicBase,
          getPrincipal: () => "UADA",
        });
        const result = await tool.execute(
          "t1",
          { extension: "com.example.oauth", scope: "org", connection_id: undefined, expected_revision: undefined },
          undefined,
          undefined,
          // SAFETY: the upload-link tool never reads the execute context; a minimal sessionManager fake satisfies the arity.
          { sessionManager: { getSessionFile: () => null } } as never,
        );
        expect(result.isError).toBeUndefined();
        // SAFETY: the tool replies with a single text content block carrying the upload URL.
        const text = (result.content[0] as { text: string }).text;
        const url = text.split("\n")[0]!;
        expect(url.startsWith(`${endpoint.baseUrl}/upload/`)).toBe(true);
        // The reply names the two browser fields and never carries values.
        expect(text).toContain("client ID");
        expect(text).toContain("client secret");
        expect(text).not.toContain("static-secret");
        const token = url.slice(endpoint.baseUrl.length + "/upload/".length);
        expect(endpoint.store.consume(token).ok).toBe(true);
      } finally {
        endpoint.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("vault provider separation: the static client row never collides with per-user OAuth rows under the real extension id", async () => {
    const h = makeDeps({ policy: allowedPolicy() });
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "com.example.oauth",
        scope: "org",
        actor: "UADA",
        label: "Example OAuth",
      });
      expect(minted.ok).toBe(true);
      if (!minted.ok) return;
      const res = await postStaticClient(`${endpoint.baseUrl}/upload/${minted.token}`, STATIC_CLIENT_ID, STATIC_CLIENT_SECRET);
      expect(res.status).toBe(200);

      // The synthetic provider key is deterministic and distinct from the
      // extension id (a personal connect's OAuth row lives under the real id).
      expect(staticOAuthClientProviderKey("com.example.oauth")).toBe("static-oauth-client:com.example.oauth");
      expect(h.broker.calls).toHaveLength(1);
      expect(h.broker.calls[0]!.provider).toBe("static-oauth-client:com.example.oauth");
      expect(h.broker.calls[0]!.provider).not.toBe("com.example.oauth");
    } finally {
      endpoint.stop();
    }
  });
});
