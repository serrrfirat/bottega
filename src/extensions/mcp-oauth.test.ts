/**
 * Generic MCP OAuth (issue #198) — hermetic full path: a real in-process
 * stub OAuth + MCP server (Bun.serve on 127.0.0.1) implements the RFC 9728
 * protected-resource metadata, RFC 8414 authorization-server metadata, RFC
 * 7591 dynamic client registration, PKCE S256 verification, the
 * authorization-code exchange, and refresh-token rotation — so the MCP
 * SDK's OAuth client is exercised over REAL HTTP with NO network egress.
 *
 * Covered: metadata discovery + DCR + PKCE authorize URL (mint), the full
 * connect round trip (mint → browser → callback → vault + registry +
 * audit), refresh via the runtime provider, and every fail-closed path
 * (missing metadata, bad code, replay/expired state, missing vault row →
 * re-auth prompt, broker refresh sentinel dropped).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { REMOTE_REFRESH_SENTINEL, type OAuthCredential } from "@oh-my-pi/pi-ai";
import { createAudit } from "../policy/audit";
import { createStore, type Store } from "../store/db";
import { EXTENSION_CONNECTED_EVENT } from "../store/audit-events";
import type { ExtensionManifest } from "./manifest";
import type { JsonValue } from "./manifest";
import { createExtensionRegistry, type ExtensionRegistry } from "./registry";
import {
  completeMcpOAuthFlow,
  createRuntimeMcpOAuthProvider,
  OAuthFlowStore,
  startMcpOAuthFlow,
  tokensToVaultCredential,
  vaultCredentialToTokens,
  type McpOAuthTokenStore,
  type PersistedOAuthFlow,
} from "./mcp-oauth";
import { startOAuthCallbackServer } from "./oauth-callback";
import { uploadLinkPublicBase } from "./upload-link";

const dir = mkdtempSync(join(tmpdir(), "bottega-mcp-oauth-"));
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

/** A hosted OAuth MCP manifest (kind mcp, streamable-http, credential oauth). */
function oauthMcpManifest(serverUrl: string): ExtensionManifest {
  return {
    id: "fixture.oauthmcp",
    label: "Fixture OAuth MCP",
    vendor: "bottega-fixtures",
    kind: "mcp",
    mcp: { serverUrl, transport: "streamable-http" },
    credentialSchema: { type: "oauth", scopes: ["default"] },
    tools: [{ name: "oauth.ping", tier: "read", description: "Stub ping", params: [] }],
    domains: ["127.0.0.1"],
  };
}

function registryWith(serverUrl: string): ExtensionRegistry {
  const registry = createExtensionRegistry();
  registry.register(oauthMcpManifest(serverUrl));
  return registry;
}

function json(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** OAuth server state the tests assert on (client registrations, exchanges, refreshes). */
interface StubState {
  registerCalls: number;
  codeExchanges: number;
  refreshCalls: number;
  tokenGrantTypes: string[];
  lastRefreshTokenUsed: string | null;
}

/**
 * The hermetic stub: an OAuth authorization server + protected MCP endpoint
 * on one loopback port. `/mcp` requires `Authorization: Bearer <access>`;
 * everything else serves the RFC 9728/8414 metadata, DCR, the authorize
 * redirect (PKCE S256 challenge captured), and the token endpoint
 * (authorization_code + refresh_token with rotation).
 */
class StubOAuthMcp {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly baseUrl: string;
  readonly state: StubState = { registerCalls: 0, codeExchanges: 0, refreshCalls: 0, tokenGrantTypes: [], lastRefreshTokenUsed: null };
  #codes = new Map<string, { clientId: string; challenge: string | null }>();
  #refreshTokens = new Map<string, string>(); // refresh -> clientId
  #accessTokens = new Map<string, string>(); // access -> clientId
  #nextId = 0;
  /** Set false to serve /mcp with NO OAuth metadata (the fail-closed leg). */
  oauthMetadata = true;

  constructor() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.handle(req),
    });
    this.baseUrl = `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  /** The MCP endpoint URL the extension manifest binds to. */
  get mcpUrl(): string {
    return `${this.baseUrl}/mcp`;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") {
      const auth = req.headers.get("authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (token === null || !this.#accessTokens.has(token)) {
        const headers: Record<string, string> = {};
        if (this.oauthMetadata) {
          headers["www-authenticate"] = `Bearer resource_metadata="${this.baseUrl}/.well-known/oauth-protected-resource/mcp"`;
        }
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
      }
      // SAFETY: the MCP SDK sends jsonrpc/id/method on every request; the
      // stub reads only method and id, and anything else falls through to
      // the unknown-method response.
      const body = (await req.json()) as { jsonrpc: string; id: number; method: string };
      if (body.method === "initialize") {
        return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stub-oauth-mcp", version: "1.0.0" } } });
      }
      if (body.method === "tools/list") {
        return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "oauth.ping", description: "Stub ping", inputSchema: { type: "object", properties: {} } }] } });
      }
      if (body.method === "tools/call") {
        return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "pong" }] } });
      }
      return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown method" } });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      if (!this.oauthMetadata) return new Response("not found", { status: 404 });
      return json({ resource: this.mcpUrl, authorization_servers: [this.baseUrl], scopes_supported: ["default"], bearer_methods_supported: ["header"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      if (!this.oauthMetadata) return new Response("not found", { status: 404 });
      return json({
        issuer: this.baseUrl,
        authorization_endpoint: `${this.baseUrl}/authorize`,
        token_endpoint: `${this.baseUrl}/token`,
        registration_endpoint: `${this.baseUrl}/register`,
        scopes_supported: ["default"],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/register") {
      if (!this.oauthMetadata) return new Response("not found", { status: 404 });
      this.state.registerCalls += 1;
      // SAFETY: the DCR request carries these optional fields (RFC 7591);
      // the stub defaults each missing one in the registration response.
      const body = (await req.json()) as { client_name?: string; redirect_uris?: string[]; grant_types?: string[] };
      return json({
        client_id: `client-${this.state.registerCalls}`,
        redirect_uris: body.redirect_uris ?? [],
        token_endpoint_auth_method: "none",
        grant_types: body.grant_types ?? ["authorization_code"],
        client_name: body.client_name ?? "unknown",
      });
    }
    if (url.pathname === "/authorize") {
      if (!this.oauthMetadata) return new Response("not found", { status: 404 });
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? undefined;
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const method = url.searchParams.get("code_challenge_method") ?? "";
      this.#nextId += 1;
      const code = `code-${this.#nextId}`;
      this.#codes.set(code, { clientId, challenge: method === "S256" ? challenge : null });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      if (state !== undefined && state !== "") target.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: target.toString() } });
    }
    if (url.pathname === "/token") {
      if (!this.oauthMetadata) return new Response("not found", { status: 404 });
      const params = new URLSearchParams(await req.text());
      const grantType = params.get("grant_type") ?? "";
      this.state.tokenGrantTypes.push(grantType);
      if (grantType === "authorization_code") {
        this.state.codeExchanges += 1;
        const entry = this.#codes.get(params.get("code") ?? "");
        if (!entry) return json({ error: "invalid_grant" }, 400);
        // PKCE S256 verification: the verifier must hash to the challenge.
        const verifier = params.get("code_verifier") ?? "";
        if (entry.challenge !== null) {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
          const actual = Buffer.from(digest)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
          if (actual !== entry.challenge) return json({ error: "invalid_grant" }, 400);
        }
        this.#nextId += 1;
        const access = `access-${this.#nextId}`;
        const refresh = `refresh-${this.#nextId}`;
        this.#accessTokens.set(access, entry.clientId);
        this.#refreshTokens.set(refresh, entry.clientId);
        return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "default" });
      }
      if (grantType === "refresh_token") {
        this.state.refreshCalls += 1;
        const refresh = params.get("refresh_token") ?? "";
        const clientId = this.#refreshTokens.get(refresh);
        if (clientId === undefined) return json({ error: "invalid_grant" }, 400);
        this.state.lastRefreshTokenUsed = refresh;
        this.#nextId += 1;
        const access = `access-rotated-${this.#nextId}`;
        this.#accessTokens.set(access, clientId);
        // Rotate: the old refresh is gone, a fresh one takes its place.
        this.#refreshTokens.delete(refresh);
        const rotated = `refresh-rotated-${this.#nextId}`;
        this.#refreshTokens.set(rotated, clientId);
        return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: rotated });
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    return new Response("not found", { status: 404 });
  }
}

/** A fake vault token store: records saves, serves scripted loads. */
class FakeVaultStore implements McpOAuthTokenStore {
  saves: Array<{ provider: string; credential: OAuthCredential }> = [];
  loadResult: OAuthCredential | null = null;
  async save(provider: string, credential: OAuthCredential): Promise<{ brokerCredentialId: number }> {
    this.saves.push({ provider, credential });
    return { brokerCredentialId: 900 + this.saves.length };
  }
  async load(): Promise<OAuthCredential | null> {
    return this.loadResult;
  }
}

function flowDeps(store: Store, registry: ExtensionRegistry, vault: FakeVaultStore, baseUrl: string) {
  return {
    registry,
    store,
    audit: createAudit(store),
    callbackBaseUrl: () => baseUrl,
    tokenStore: vault,
  };
}

describe("startMcpOAuthFlow — discovery + DCR + PKCE (issue #198)", () => {
  test("mints an authorization URL with PKCE S256, the flow state, and the callback redirect", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, "http://127.0.0.1:9");

      const outcome = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const url = new URL(outcome.authorizationUrl);
      expect(url.pathname).toBe("/authorize");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9/oauth/callback");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(url.searchParams.get("scope")).toBe("default");
      const state = url.searchParams.get("state");
      expect(state).toBeTruthy();
      expect(stub.state.registerCalls).toBe(1); // dynamic client registration happened

      // The flow row persists the PKCE verifier + client info + state key.
      const row = store.getOAuthFlow(state!);
      expect(row).not.toBeNull();
      if (!row) return;
      expect(row.provider).toBe("fixture.oauthmcp");
      expect(row.scope).toBe("personal");
      expect(row.actor).toBe("UADA");
      expect(row.redirect_uri).toBe("http://127.0.0.1:9/oauth/callback");
      expect(row.server_url).toBe(stub.mcpUrl);
      // SAFETY: the flow row is the JSON this module's own
      // persistOAuthFlow wrote (JSON.stringify of a PersistedOAuthFlow).
      const flow = JSON.parse(row.flow) as PersistedOAuthFlow;
      expect(flow.codeVerifier).toBeTruthy();
      expect(flow.clientInformation).toMatchObject({ client_id: "client-1" });
      expect(flow.authorizationUrl).toBe(outcome.authorizationUrl);
      // No token touched the flow row or the vault yet.
      expect(vault.saves).toHaveLength(0);
    } finally {
      stub.stop();
    }
  });

  test("fails closed when the server exposes no OAuth metadata", async () => {
    const stub = new StubOAuthMcp();
    stub.oauthMetadata = false; // /mcp 401s without resource_metadata; no well-knowns
    try {
      const store = freshStore();
      const deps = flowDeps(store, registryWith(stub.mcpUrl), new FakeVaultStore(), "http://127.0.0.1:9");

      const outcome = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.message).toContain("failed");
      expect(store.countActiveOAuthFlows("UADA")).toBe(0); // nothing persisted
    } finally {
      stub.stop();
    }
  });

  test("fails closed for non-hosted-OAuth extensions", async () => {
    const store = freshStore();
    const registry = createExtensionRegistry();
    registry.register({
      id: "fixture.apikey",
      label: "Fixture API Key",
      vendor: "bottega-fixtures",
      kind: "mcp",
      mcp: { serverUrl: "http://127.0.0.1:9/mcp", transport: "streamable-http" },
      credentialSchema: { type: "api_key" },
      tools: [{ name: "apikey.ping", tier: "read", description: "ping", params: [] }],
      domains: ["127.0.0.1"],
    });
    const deps = flowDeps(store, registry, new FakeVaultStore(), "http://127.0.0.1:9");

    const outcome = await startMcpOAuthFlow(
      { extension: "fixture.apikey", provider: "fixture.apikey", label: "Fixture API Key", scope: "personal", actor: "UADA" },
      deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("not a hosted OAuth MCP");
    expect(store.countActiveOAuthFlows("UADA")).toBe(0);
  });
});

describe("full connect round trip — mint → browser → callback → vault + registry + audit", () => {
  test("the callback exchanges the code (PKCE-verified), stores the token in the vault, and records the credential", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault });
      try {
        const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);

        const minted = await startMcpOAuthFlow(
          { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA", spaceId: "slack:C1" },
          deps,
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;

        // The user's browser: authorize → the stub 302s to our callback.
        const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
        expect(authorize.status).toBe(302);
        const callbackUrl = authorize.headers.get("location");
        expect(callbackUrl).toContain("/oauth/callback?code=");
        const done = await fetch(callbackUrl!);
        expect(done.status).toBe(200);
        expect(await done.text()).toContain("connected");

        // The token landed in the vault through the fake store (one save).
        expect(vault.saves).toHaveLength(1);
        expect(vault.saves[0]!.provider).toBe("fixture.oauthmcp");
        expect(vault.saves[0]!.credential.access).toBeTruthy();
        expect(vault.saves[0]!.credential.refresh).toBeTruthy();
        expect(stub.state.codeExchanges).toBe(1);
        expect(stub.state.tokenGrantTypes).toEqual(["authorization_code"]);

        // The registry row (personal, deterministic identity) + audit landed.
        const rows = await store.listExtensionCredentials("fixture.oauthmcp");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.owner).toBe("UADA");
        expect(rows[0]!.scope).toBe("personal");
        expect(rows[0]!.identity_key).toBe("oauth:UADA");
        expect(rows[0]!.broker_credential_id).toBe(901);
        const audit = await store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT });
        expect(audit).toHaveLength(1);
        expect(audit[0]!.actor).toBe("UADA");
        expect(audit[0]!.space_id).toBe("slack:C1");
        expect(JSON.parse(audit[0]!.payload)).toEqual({ extension: "fixture.oauthmcp", scope: "personal", owner: "UADA" });

        // The flow state is single-use: replaying the callback is a 404.
        const replay = await fetch(callbackUrl!);
        expect(replay.status).toBe(404);
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("an org connect records an org row with the deterministic org identity", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault });
      try {
        const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);
        const minted = await startMcpOAuthFlow(
          { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "org", actor: "UADA" },
          deps,
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;

        const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
        const done = await fetch(authorize.headers.get("location")!);
        expect(done.status).toBe(200);

        const rows = await store.listExtensionCredentials("fixture.oauthmcp");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.owner).toBeNull();
        expect(rows[0]!.scope).toBe("org");
        expect(rows[0]!.identity_key).toBe("oauth:fixture.oauthmcp");
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("a rejected exchange (bad code) fails closed: no vault write, no registry row", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault });
      try {
        const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);
        const minted = await startMcpOAuthFlow(
          { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
          deps,
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;
        const state = new URL(minted.authorizationUrl).searchParams.get("state")!;

        // The callback with a forged code → the exchange is rejected.
        const res = await fetch(`${callback.baseUrl}/oauth/callback?code=forged-code&state=${state}`);
        expect(res.status).toBe(500);
        expect(await res.text()).toContain("failed");
        expect(vault.saves).toHaveLength(0);
        expect(await store.listExtensionCredentials("fixture.oauthmcp")).toHaveLength(0);
        expect(await store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT })).toHaveLength(0);
        // The consumed flow state cannot be replayed for a real code either.
        expect(store.consumeOAuthFlow(state).ok).toBe(false);
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("a missing/expired/used flow state is a 404 (fail closed)", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: new FakeVaultStore() });
      try {
        const missing = await fetch(`${callback.baseUrl}/oauth/callback?code=x&state=nope`);
        expect(missing.status).toBe(404);

        const incomplete = await fetch(`${callback.baseUrl}/oauth/callback?state=nope`);
        expect(incomplete.status).toBe(400);

        const declined = await fetch(`${callback.baseUrl}/oauth/callback?error=access_denied&state=nope`);
        expect(declined.status).toBe(200);
        expect(await declined.text()).toContain("declined");

        const unknown = await fetch(`${callback.baseUrl}/nope`);
        expect(unknown.status).toBe(404);
        expect(stub.state.codeExchanges).toBe(0);
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });
});

describe("token refresh — the runtime provider (issue #198)", () => {
  /** Runs a real connect round trip and returns the vault-saved credential. */
  async function connectCredential(stub: StubOAuthMcp, store: Store, vault: FakeVaultStore): Promise<OAuthCredential> {
    const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault });
    try {
      const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);
      const minted = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );
      expect(minted.ok).toBe(true);
      if (!minted.ok) throw new Error("mint failed");
      const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
      const done = await fetch(authorize.headers.get("location")!);
      expect(done.status).toBe(200);
      const saved = vault.saves[0];
      if (!saved) throw new Error("no vault save");
      return saved.credential;
    } finally {
      callback.stop();
    }
  }

  test("an expired credential refreshes through the SDK, and saveTokens rotates the vault row", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const real = await connectCredential(stub, store, vault);
      // Expire the grant: the access token is stale and the refresh token is
      // the REAL one the stub issued (locally stored, not a broker sentinel).
      vault.loadResult = { ...real, access: "access-stale", expires: Date.now() - 60_000 };
      const provider = createRuntimeMcpOAuthProvider({
        credential: {
          id: "ec_test",
          provider: "fixture.oauthmcp",
          identity_key: "oauth:UADA",
          owner: "UADA",
          scope: "personal",
          broker_credential_id: 901,
          created_at: Date.now(),
        },
        tokenStore: vault,
      });

      const result = await auth(provider, { serverUrl: stub.mcpUrl });

      expect(result).toBe("AUTHORIZED");
      expect(stub.state.refreshCalls).toBe(1);
      expect(stub.state.lastRefreshTokenUsed).toBe(real.refresh);
      // The rotated tokens were persisted back into the vault.
      const rotation = vault.saves[vault.saves.length - 1]!;
      expect(rotation.provider).toBe("fixture.oauthmcp");
      expect(rotation.credential.access).toBeTruthy();
      expect(rotation.credential.access).not.toBe("access-stale");
      expect(rotation.credential.refresh).toMatch(/^refresh-rotated-/);
      expect(rotation.credential.expires).toBeGreaterThan(Date.now());
    } finally {
      stub.stop();
    }
  });

  test("a missing vault row fails closed with the re-auth prompt (no interactive flow mid-call)", async () => {
    const stub = new StubOAuthMcp();
    try {
      const vault = new FakeVaultStore();
      vault.loadResult = null;
      const provider = createRuntimeMcpOAuthProvider({
        credential: {
          id: "ec_test",
          provider: "fixture.oauthmcp",
          identity_key: "oauth:UADA",
          owner: "UADA",
          scope: "personal",
          broker_credential_id: 901,
          created_at: Date.now(),
        },
        tokenStore: vault,
      });

      await expect(auth(provider, { serverUrl: stub.mcpUrl })).rejects.toThrow(/re-run "connect fixture\.oauthmcp as me"/);
      expect(vault.saves).toHaveLength(0);
    } finally {
      stub.stop();
    }
  });

  test("the broker's refresh sentinel is dropped — the SDK never POSTs it", async () => {
    const provider = createRuntimeMcpOAuthProvider({
      credential: {
        id: "ec_test",
        provider: "fixture.oauthmcp",
        identity_key: "oauth:UADA",
        owner: "UADA",
        scope: "personal",
        broker_credential_id: 901,
        created_at: Date.now(),
      },
      tokenStore: {
        async load() {
          return { type: "oauth", access: "access-ok", refresh: REMOTE_REFRESH_SENTINEL, expires: Date.now() + 60_000 };
        },
        async save() {
          throw new Error("the runtime must not save tokens when the broker owns refresh");
        },
      } satisfies McpOAuthTokenStore,
    });

    const tokens = await provider.tokens();
    expect(tokens).toMatchObject({ access_token: "access-ok" });
    expect(tokens!.refresh_token).toBeUndefined();
  });
});

describe("vault credential <-> SDK token conversion", () => {
  test("tokensToVaultCredential preserves the previous refresh token when the server does not rotate", () => {
    const previous: OAuthCredential = { type: "oauth", access: "old", refresh: "refresh-keep", expires: 1 };
    const converted = tokensToVaultCredential({ access_token: "new", token_type: "Bearer", expires_in: 3600 }, previous);
    expect(converted).toMatchObject({ type: "oauth", access: "new", refresh: "refresh-keep" });
    expect(converted.expires).toBeGreaterThan(Date.now());
  });

  test("tokensToVaultCredential stores the rotated refresh token when present", () => {
    const converted = tokensToVaultCredential(
      { access_token: "a", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-new" },
      null,
    );
    expect(converted.refresh).toBe("refresh-new");
  });

  test("vaultCredentialToTokens carries the real refresh token and drops the sentinel", () => {
    expect(vaultCredentialToTokens({ type: "oauth", access: "a", refresh: "refresh-real", expires: Date.now() + 1000 })).toMatchObject({
      access_token: "a",
      refresh_token: "refresh-real",
    });
    expect(vaultCredentialToTokens({ type: "oauth", access: "a", refresh: REMOTE_REFRESH_SENTINEL, expires: Date.now() + 1000 }).refresh_token).toBeUndefined();
  });
});

describe("OAuthFlowStore — per-actor cap + single-use", () => {
  test("refuses past the per-actor cap", () => {
    const store = freshStore();
    const flowStore = new OAuthFlowStore(store, { maxOutstandingPerActor: 2 });
    for (let i = 0; i < 2; i++) {
      const minted = flowStore.mint({
        token: `t${i}`,
        provider: "fixture.oauthmcp",
        scope: "personal",
        actor: "UADA",
        label: "Fixture OAuth MCP",
        serverUrl: "http://x/mcp",
        redirectUri: "http://x/callback",
        flow: "{}",
      });
      expect(minted.ok).toBe(true);
    }
    const third = flowStore.mint({
      token: "t3",
      provider: "fixture.oauthmcp",
      scope: "personal",
      actor: "UADA",
      label: "Fixture OAuth MCP",
      serverUrl: "http://x/mcp",
      redirectUri: "http://x/callback",
      flow: "{}",
    });
    expect(third.ok).toBe(false);
    expect(store.countActiveOAuthFlows("UADA")).toBe(2);
  });

  test("an expired flow token is consumed as gone (fail closed)", () => {
    const store = freshStore();
    const flowStore = new OAuthFlowStore(store);
    const minted = flowStore.mint({
      token: "expired-token",
      provider: "fixture.oauthmcp",
      scope: "personal",
      actor: "UADA",
      label: "Fixture OAuth MCP",
      serverUrl: "http://x/mcp",
      redirectUri: "http://x/callback",
      flow: "{}",
      expiresAt: Date.now() - 1000,
    });
    expect(minted.ok).toBe(true);
    expect(store.consumeOAuthFlow("expired-token").ok).toBe(false);
    expect(store.getOAuthFlow("expired-token")).toBeNull();
  });
});

describe("completeMcpOAuthFlow — direct unit path", () => {
  test("exchanges a minted flow's code without the HTTP callback", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, "http://127.0.0.1:9");
      const minted = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );
      expect(minted.ok).toBe(true);
      if (!minted.ok) return;

      // Browser leg: follow the authorize redirect to the code+state pair.
      const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
      const callback = new URL(authorize.headers.get("location")!);
      const state = callback.searchParams.get("state")!;
      const code = callback.searchParams.get("code")!;
      const row = store.consumeOAuthFlow(state);
      expect(row.ok).toBe(true);
      if (!row.ok) return;

      const completed = await completeMcpOAuthFlow(row.row, code, { store, audit: createAudit(store), tokenStore: vault });
      expect(completed.brokerCredentialId).toBe(901);
      expect(vault.saves).toHaveLength(1);
      const rows = await store.listExtensionCredentials("fixture.oauthmcp");
      expect(rows[0]!.broker_credential_id).toBe(901);
    } finally {
      stub.stop();
    }
  });
});

describe("durable public-base store — tunnel rotation heals without a restart (issue #249)", () => {
  test("the mint re-reads the store every flow, so the next mint uses a rotated tunnel host", async () => {
    const stub = new StubOAuthMcp();
    const storeDir = mkdtempSync(join(tmpdir(), "bottega-public-base-rotation-"));
    const storeFile = join(storeDir, "public-base-url");
    const savedFile = process.env.BOTTEGA_PUBLIC_BASE_URL_FILE;
    const savedEnv = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
    try {
      process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = storeFile;
      delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;

      const store = freshStore();
      const vault = new FakeVaultStore();
      const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, "http://127.0.0.1:9");
      // The SERVER's wiring (issue #249): the callback base resolves LAZILY
      // from the durable store at mint time — never captured at boot. A
      // store rotation mid-process is picked up by the next mint.
      deps.callbackBaseUrl = () => uploadLinkPublicBase() ?? "http://127.0.0.1:9";

      const input = { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", actor: "UADA", scope: "personal" as const };

      // First mint: the store points at tunnel A.
      writeFileSync(storeFile, "https://tunnel-a.trycloudflare.com\n");
      const first = await startMcpOAuthFlow(input, deps);
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(new URL(first.authorizationUrl).searchParams.get("redirect_uri")).toBe("https://tunnel-a.trycloudflare.com/oauth/callback");
      }

      // MID-PROCESS tunnel rotation: the SAME server process, NO restart.
      // The store now carries tunnel B — the next mint must use the new host.
      writeFileSync(storeFile, "https://tunnel-b.trycloudflare.com\n");
      const second = await startMcpOAuthFlow(input, deps);
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(new URL(second.authorizationUrl).searchParams.get("redirect_uri")).toBe("https://tunnel-b.trycloudflare.com/oauth/callback");
      }
    } finally {
      if (savedFile === undefined) delete process.env.BOTTEGA_PUBLIC_BASE_URL_FILE;
      else process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = savedFile;
      if (savedEnv === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = savedEnv;
      rmSync(storeDir, { recursive: true, force: true });
      stub.stop();
    }
  });
});
