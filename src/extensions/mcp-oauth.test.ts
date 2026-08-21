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
 * re-auth prompt, broker refresh sentinel dropped). Plus issue #257
 * credential durability for every MCP integration: confidential-client
 * fidelity (connect-negotiated token_endpoint_auth_method → persisted
 * client_secret + Basic auth on /token, env-free runtime mint), the
 * connect-time mint probe (a dead refresh fails the connect closed), and
 * refresh-token rotation write-back (a rotating server survives ≥3 runtime
 * refresh cycles, each using the latest rotated token — never a dead one).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { REMOTE_REFRESH_SENTINEL, type OAuthCredential } from "@oh-my-pi/pi-ai";
import type { ApprovalRequest, ApprovalResolution, ApprovalRouter } from "../policy/approval-router";
import { createAudit } from "../policy/audit";
import { parseOrgConfigYaml, type PolicyConfig } from "../policy/config";
import { createStore, type Store } from "../store/db";
import { EXTENSION_CONNECTED_EVENT, STATIC_CLIENT_PROVISIONED_EVENT } from "../store/audit-events";
import type { ExtensionManifest } from "./manifest";
import type { JsonValue } from "./manifest";
import { createExtensionRegistry, type ExtensionRegistry } from "./registry";
import {
  completeMcpOAuthFlow,
  createMcpOAuthConnector,
  createRuntimeMcpOAuthProvider,
  OAuthFlowStore,
  resolveMcpOAuthRegistrationCapability,
  startMcpOAuthFlow,
  tokensToVaultCredential,
  vaultCredentialToTokens,
  type McpOAuthTokenStore,
  type PersistedOAuthFlow,
} from "./mcp-oauth";
import { startOAuthCallbackServer } from "./oauth-callback";
import { mountUploadLink, uploadLinkPublicBase } from "./upload-link";
import { connectExtension, type ConnectExtensionDeps } from "./connect";
import type { StaticOAuthClientStore } from "./static-oauth-client";
import type { VaultOAuthCredential } from "./mcp-oauth";

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
    credentialTargets: [{ host: "127.0.0.1", pathPrefix: "/mcp" }],
  };
}

function registryWith(serverUrl: string): ExtensionRegistry {
  const registry = createExtensionRegistry();
  registry.register(oauthMcpManifest(serverUrl));
  return registry;
}

/** The hosted OAuth MCP manifest WITHOUT manifest-declared scopes (Notion's real shape, issue #262 evidence). */
function oauthMcpManifestNoScopes(serverUrl: string): ExtensionManifest {
  return { ...oauthMcpManifest(serverUrl), credentialSchema: { type: "oauth" } };
}

/** A registry holding a bespoke manifest (issue #262 scope-composition variants). */
function registryWithManifest(manifest: ExtensionManifest): ExtensionRegistry {
  const registry = createExtensionRegistry();
  registry.register(manifest);
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
  /** The `scope` field of every DCR registration request (issue #256). */
  registeredScopes: string[];
  /** The `scope` query param of every authorization URL minted (issue #256). */
  authorizeScopes: string[];
  /** The `token_endpoint_auth_method` requested in every DCR registration (issue #257). */
  registeredAuthMethods: string[];
  /** The client-auth method actually used on every /token call (issue #257). */
  clientAuthMethodsUsed: string[];
  /** How many DCR registrations were issued a client_secret (issue #257). */
  confidentialClients: number;
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
  readonly state: StubState = { registerCalls: 0, codeExchanges: 0, refreshCalls: 0, tokenGrantTypes: [], lastRefreshTokenUsed: null, registeredScopes: [], authorizeScopes: [], registeredAuthMethods: [], clientAuthMethodsUsed: [], confidentialClients: 0 };
  #codes = new Map<string, { clientId: string; challenge: string | null; offline: boolean }>();
  #refreshTokens = new Map<string, string>(); // refresh -> clientId
  #accessTokens = new Map<string, string>(); // access -> clientId
  #clientSecrets = new Map<string, string>(); // client_id -> client_secret (confidential mode)
  #nextId = 0;
  /** Set false to serve /mcp with NO OAuth metadata (the fail-closed leg). */
  oauthMetadata = true;
  /**
   * Set true to model a CONFIDENTIAL OAuth client (RFC 6749 §2.3.1): the AS
   * advertises client_secret_basic/post, DCR issues a client_secret ONLY to
   * a registration that requested a confidential method, and /token rejects
   * any call without valid client credentials (Basic header or
   * client_secret form param). A public client (method "none") can never
   * mint against it (issue #257).
   */
  confidential = false;
  /**
   * Set true to make the token endpoint's refresh_token grant fail with
   * invalid_grant — every refresh is rejected (models a server that issued
   * a refresh token which is already dead). The connect-time mint probe
   * must then fail the connect closed (issue #257).
   */
  deadRefresh = false;
  /**
   * Set true to make the token endpoint refuse to issue a refresh token even
   * when offline_access WAS requested (models a server that ignores
   * offline_access — exactly what Notion did pre-fix): the exchange returns
   * access with NO refresh, so a connect must fail closed rather than
   * persist an empty-refresh credential (issue #256).
   */
  dropRefresh = false;
  /**
   * Set false to model a provider whose authorization server does NOT
   * advertise the `refresh_token` grant (RFC 8414): the connect mint must
   * NOT append offline_access (no refreshable grant exists to request) and
   * an exchange that then returns no refresh must still fail closed
   * (issue #256 variant B).
   */
  grantRefresh = true;
  /**
   * The `scopes_supported` the protected-resource metadata advertises.
   * "default" is Notion MCP's placeholder — NOT a real authorizable scope —
   * and the mint must never stack offline_access onto it (issue #262).
   */
  protectedResourceScopes: string[] = ["default"];
  /**
   * Set true to make the authorization-server metadata endpoint answer
   * HTTP 500 — a TRANSIENT discovery failure, not a clean 404 — so the
   * connect's pre-negotiation discovery REJECTS. The negotiation must log
   * the degraded (no offline_access) connect loudly instead of silently
   * returning scope undefined (issue #262 (d)).
   */
  negotiationDiscoveryFails = false;
  /**
   * Set false to model a NO-DCR authorization server (issue #288 — the
   * Gmail class): the RFC 8414 metadata OMITS `registration_endpoint`
   * (and /register 404s), so the SDK cannot dynamically register a
   * client and the connect must use a provisioned static client instead.
   */
  registrationEndpoint = true;
  /**
   * Overrides the advertised `registration_endpoint` URL (issue #288
   * insecure-URL leg): when set, the metadata advertises THIS value —
   * e.g. a plain-http NON-loopback endpoint, which the connect must treat
   * as UNUSABLE (fail closed to the static-client path).
   */
  registrationEndpointOverride: string | undefined = undefined;

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

  /** Seeds a pre-registered static client's credentials (issue #288): the AS validates them on /token. */
  addStaticClient(clientId: string, clientSecret: string): void {
    this.#clientSecrets.set(clientId, clientSecret);
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
      return json({ resource: this.mcpUrl, authorization_servers: [this.baseUrl], scopes_supported: this.protectedResourceScopes, bearer_methods_supported: ["header"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      if (!this.oauthMetadata) return new Response("not found", { status: 404 });
      // Issue #262 (d): a transient discovery failure (HTTP 500, not a clean
      // 404) makes the SDK's discovery REJECT — the negotiation must log
      // the resulting no-offline_access connect loudly, never silently.
      if (this.negotiationDiscoveryFails) return json({ error: "internal server error" }, 500);
      // Issue #288: a no-DCR server (the Gmail class) omits
      // registration_endpoint entirely — /register 404s and the SDK cannot
      // dynamically register, so the connect needs a static client.
      const registrationEndpoint =
        this.registrationEndpointOverride ??
        (this.registrationEndpoint ? `${this.baseUrl}/register` : undefined);
      return json({
        issuer: this.baseUrl,
        authorization_endpoint: `${this.baseUrl}/authorize`,
        token_endpoint: `${this.baseUrl}/token`,
        ...(registrationEndpoint !== undefined ? { registration_endpoint: registrationEndpoint } : {}),
        scopes_supported: ["default"],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: this.grantRefresh ? ["authorization_code", "refresh_token"] : ["authorization_code"],
        token_endpoint_auth_methods_supported: this.confidential ? ["client_secret_basic", "client_secret_post"] : ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/register") {
      if (!this.oauthMetadata || !this.registrationEndpoint) return new Response("not found", { status: 404 });
      this.state.registerCalls += 1;
      // SAFETY: the DCR request carries these optional fields (RFC 7591);
      // the stub defaults each missing one in the registration response.
      const body = (await req.json()) as { client_name?: string; redirect_uris?: string[]; grant_types?: string[]; scope?: string; token_endpoint_auth_method?: string };
      this.state.registeredScopes.push(typeof body.scope === "string" ? body.scope : "");
      const requestedMethod = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
      this.state.registeredAuthMethods.push(requestedMethod);
      const clientId = `client-${this.state.registerCalls}`;
      // Issue #257: a confidential-enabled server issues a client_secret ONLY
      // when the registration actually asked for a confidential method
      // (RFC 7591 does not force secrets on public clients). The negotiated
      // method is echoed back so the SDK records the same method it will
      // use to authenticate on /token.
      if (this.confidential && (requestedMethod === "client_secret_basic" || requestedMethod === "client_secret_post")) {
        this.state.confidentialClients += 1;
        const clientSecret = `secret-${this.state.registerCalls}`;
        this.#clientSecrets.set(clientId, clientSecret);
        return json({
          client_id: clientId,
          redirect_uris: body.redirect_uris ?? [],
          token_endpoint_auth_method: requestedMethod,
          client_secret: clientSecret,
          grant_types: body.grant_types ?? ["authorization_code"],
          client_name: body.client_name ?? "unknown",
        });
      }
      return json({
        client_id: clientId,
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
      const scope = url.searchParams.get("scope") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const method = url.searchParams.get("code_challenge_method") ?? "";
      this.state.authorizeScopes.push(scope);
      // The server only issues a REFRESH token when the consent granted
      // offline_access (RFC 6749 §3.3). The stub models the real Notion
      // failure exactly: a scope WITHOUT offline_access yields an
      // authorization_code grant with NO refresh token.
      this.#nextId += 1;
      const code = `code-${this.#nextId}`;
      this.#codes.set(code, {
        clientId,
        challenge: method === "S256" ? challenge : null,
        offline: scope.split(" ").includes("offline_access"),
      });
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
      // Issue #257: recover HOW the caller authenticated, mirroring the SDK
      // (client_secret_basic → Basic header; client_secret_post → form
      // client_secret; public → client_id alone). A confidential server
      // only accepts valid confidential credentials.
      const basicHeader = req.headers.get("authorization") ?? "";
      let clientId = "";
      let clientSecret = "";
      if (basicHeader.startsWith("Basic ")) {
        const decoded = Buffer.from(basicHeader.slice(6), "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        clientId = separator === -1 ? decoded : decoded.slice(0, separator);
        clientSecret = separator === -1 ? "" : decoded.slice(separator + 1);
        this.state.clientAuthMethodsUsed.push("client_secret_basic");
      } else {
        clientId = params.get("client_id") ?? "";
        clientSecret = params.get("client_secret") ?? "";
        this.state.clientAuthMethodsUsed.push(clientSecret !== "" ? "client_secret_post" : "none");
      }
      if (this.confidential && (clientSecret === "" || this.#clientSecrets.get(clientId) !== clientSecret)) {
        return json({ error: "invalid_client" }, 401);
      }
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
        this.#accessTokens.set(access, entry.clientId);
        // No refresh token unless offline_access was granted — the exact
        // pre-#256 Notion behavior that persisted an empty refresh and
        // broke every later read. dropRefresh forces the no-refresh
        // response even when offline_access WAS requested, for the
        // fail-closed connect test.
        if (!entry.offline || this.dropRefresh) {
          return json({ access_token: access, token_type: "Bearer", expires_in: 3600, scope: "default" });
        }
        const refresh = `refresh-${this.#nextId}`;
        this.#refreshTokens.set(refresh, entry.clientId);
        return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "default" });
      }
      if (grantType === "refresh_token") {
        this.state.refreshCalls += 1;
        // Issue #257: every refresh dies (the probe-fail leg).
        if (this.deadRefresh) return json({ error: "invalid_grant" }, 400);
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

/**
 * A fake vault token store: identity-keys saved rows by provider, mirroring
 * the production `upsertAuthCredentialForProvider` — a re-save KEEPS the
 * same row id. This matters for issue #257: the connect-time mint probe's
 * rotation write-back saves the row a SECOND time, and the registry
 * reference must still point at the same (stable) row id. Loads honor a
 * scripted `loadResult` override: `undefined` (default) reads the saved
 * row, `null` scripts a genuinely missing row, an `OAuthCredential` scripts
 * a specific credential (expired/stripped/etc.).
 */
class FakeVaultStore implements McpOAuthTokenStore {
  saves: Array<{ provider: string; credential: OAuthCredential; brokerCredentialId: number }> = [];
  #rows = new Map<string, OAuthCredential>();
  #rowIds = new Map<string, number>();
  #nextId = 901;
  loadResult: OAuthCredential | null | undefined = undefined;
  async save(provider: string, credential: OAuthCredential): Promise<{ brokerCredentialId: number }> {
    this.#rows.set(provider, credential);
    let rowId = this.#rowIds.get(provider);
    if (rowId === undefined) {
      rowId = this.#nextId;
      this.#nextId += 1;
      this.#rowIds.set(provider, rowId);
    }
    this.saves.push({ provider, credential, brokerCredentialId: rowId });
    return { brokerCredentialId: rowId };
  }
  async load(provider: string): Promise<OAuthCredential | null> {
    if (this.loadResult !== undefined) return this.loadResult;
    return this.#rows.get(provider) ?? null;
  }
}

/**
 * A fake static-client vault store (issue #288): mirrors the production
 * seam — saves keyed by extension, loads the newest saved row. Loads honor
 * a scripted `loadResult` override: `undefined` (default) reads the saved
 * row, `null` scripts a genuinely missing client, an object scripts a
 * specific client.
 */
class FakeStaticClientStore implements StaticOAuthClientStore {
  rows = new Map<string, { client_id: string; client_secret: string }>();
  saves: Array<{ extension: string; client: { client_id: string; client_secret: string } }> = [];
  #nextId = 501;
  loadResult: { client_id: string; client_secret: string } | null | undefined = undefined;
  /** How many times the connect consulted the static client (DCR servers must never load). */
  loadCalls = 0;
  async save(extension: string, client: { client_id: string; client_secret: string }): Promise<{ brokerCredentialId: number }> {
    this.rows.set(extension, client);
    this.saves.push({ extension, client });
    const id = this.#nextId;
    this.#nextId += 1;
    return { brokerCredentialId: id };
  }
  async load(extension: string): Promise<{ client_id: string; client_secret: string } | null> {
    this.loadCalls += 1;
    if (this.loadResult !== undefined) return this.loadResult;
    return this.rows.get(extension) ?? null;
  }
}

function flowDeps(store: Store, registry: ExtensionRegistry, vault: FakeVaultStore, baseUrl: string, staticStore?: FakeStaticClientStore) {
  return {
    registry,
    store,
    audit: createAudit(store),
    callbackBaseUrl: () => baseUrl,
    tokenStore: vault,
    ...(staticStore !== undefined ? { staticClientStore: staticStore } : {}),
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
      expect(url.searchParams.get("scope")).toBe("default offline_access");
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
      credentialTargets: [{ host: "127.0.0.1", pathPrefix: "/mcp" }],
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
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
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

        // The token landed in the vault through the fake store. TWO writes:
        // the code-exchange row, then the issue #257 connect-time mint probe
        // (one refresh_token round-trip) which rotates the SAME identity-key
        // row to its latest token.
        expect(vault.saves).toHaveLength(2);
        expect(vault.saves[0]!.provider).toBe("fixture.oauthmcp");
        expect(vault.saves[0]!.credential.access).toBeTruthy();
        expect(vault.saves[0]!.credential.refresh).toBeTruthy();
        expect(vault.saves[1]!.provider).toBe("fixture.oauthmcp");
        expect(vault.saves[1]!.credential.refresh).toMatch(/^refresh-rotated-/);
        expect(stub.state.codeExchanges).toBe(1);
        expect(stub.state.tokenGrantTypes).toEqual(["authorization_code", "refresh_token"]);

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
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
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

  // Issue #281: a browser connect completes (credential + audit + egress all
  // land) but the running server must ALSO refresh the connected space's live
  // toolset — the freshly-connected provider's tools have to appear on the
  // SAME space's next turn WITHOUT a restart. The callback is the only place
  // that knows when the browser leg actually finished, so it must surface
  // the connected space to the composition root (which owns the sessions).
  // RED on old code: the callback never signals the connected space, so a
  // same-space turn stays starved of the new tools until a restart.
  test("a successful callback signals the connected space so its toolset can refresh without a restart", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const connected: Array<{ provider: string; spaceId: string | null }> = [];
      const callback = startOAuthCallbackServer({
        store,
        audit: createAudit(store),
        tokenStore: vault,
        port: 0,
        // The composition-root seam (server/index.ts wires this to the
        // space's session refresh). The callback must invoke it with the
        // space whose connect started the flow, so that space's toolset
        // refresh lands in the running server — no restart.
        onConnected: (info) => {
          connected.push(info);
        },
      });
      try {
        const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);
        const minted = await startMcpOAuthFlow(
          { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA", spaceId: "slack:C1" },
          deps,
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;

        const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
        const done = await fetch(authorize.headers.get("location")!);
        expect(done.status).toBe(200);

        // The callback succeeded — credential + audit landed.
        expect(await store.listExtensionCredentials("fixture.oauthmcp")).toHaveLength(1);
        // ...and the connected space was surfaced exactly once so the running
        // server can refresh its toolset without a restart.
        expect(connected).toEqual([{ provider: "fixture.oauthmcp", spaceId: "slack:C1" }]);
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
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
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
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: new FakeVaultStore(), port: 0 });
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

  test("the callback listener binds an EPHEMERAL port, never the .env-pinned dev port (#253)", async () => {
    // Regression for #253: these callback servers once bound the repo .env's
    // fixed BOTTEGA_CALLBACK_PORT (64204) — the port the live dev server
    // serves on — so `bun test` died with EADDRINUSE and the "fix" was to
    // kill the dev server. Simulate the collision env and prove the listener
    // still derives its port from the bind (ephemeral), not from the env.
    const savedPort = process.env.BOTTEGA_CALLBACK_PORT;
    process.env.BOTTEGA_CALLBACK_PORT = "64204";
    try {
      const store = freshStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: new FakeVaultStore(), port: 0 });
      try {
        const bound = new URL(callback.baseUrl).port;
        expect(bound).not.toBe("64204");
        expect(Number(bound)).toBeGreaterThan(0);
        expect(Number(bound)).toBeLessThan(65536);
        // The ephemeral surface still answers (unknown state → 404).
        const res = await fetch(`${callback.baseUrl}/oauth/callback?code=x&state=nope`);
        expect(res.status).toBe(404);
      } finally {
        callback.stop();
      }
    } finally {
      if (savedPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
      else process.env.BOTTEGA_CALLBACK_PORT = savedPort;
    }
  });
});

describe("issue #256 — offline_access + a durable refresh token", () => {
  test("issue #256 variant A — a server advertising refresh_token: the DCR registration AND the authorization URL request offline_access", async () => {
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

      // The exported authorization URL the user's browser visits.
      const scope = new URL(outcome.authorizationUrl).searchParams.get("scope") ?? "";
      expect(scope.split(" ")).toContain("offline_access");

      // The dynamic client REGISTRATION request carried the same scope.
      expect(stub.state.registeredScopes).toHaveLength(1);
      expect(stub.state.registeredScopes[0]!.split(" ")).toContain("offline_access");
      // When the user's browser follows the redirect, /authorize receives
      // the same offline_access scope (server-side view).
      const authorize = await fetch(outcome.authorizationUrl, { redirect: "manual" });
      expect(authorize.status).toBe(302);
      expect(stub.state.authorizeScopes).toHaveLength(1);
      expect(stub.state.authorizeScopes[0]!.split(" ")).toContain("offline_access");
    } finally {
      stub.stop();
    }
  });

  test("issue #256 variant C — an exchange that returns NO refresh token, with no previous row, lands a NON-RENEWABLE credential (decision B)", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
      try {
        const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);
        const minted = await startMcpOAuthFlow(
          { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
          deps,
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;

        // The mint DID request offline_access (issue #256) — but the server
        // still refuses to issue a refresh token (the exact Notion failure).
        // Decision B (issue #265): the connect SUCCEEDS with a
        // NON-RENEWABLE credential — refresh "", refreshable: false, expires
        // from expires_in — instead of failing closed. No empty-refresh row
        // that LOOKS refreshable is ever written (the #256 bug); the marker
        // + empty refresh keep the seed/egress from minting on it.
        stub.dropRefresh = true;
        const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
        const done = await fetch(authorize.headers.get("location")!);
        expect(done.status).toBe(200);
        expect(vault.saves).toHaveLength(1); // the exchange save; the mint probe is SKIPPED (nothing to probe)
        const saved = vault.saves[0]!.credential;
        expect(saved.type).toBe("oauth");
        expect(saved.refresh).toBe("");
        expect((saved as VaultOAuthCredential).refreshable).toBe(false);
        expect(saved.expires).toBeGreaterThan(Date.now());
        expect(saved.expires).toBeLessThanOrEqual(Date.now() + 3_700_000); // expires_in 3600s
        expect(await store.listExtensionCredentials("fixture.oauthmcp")).toHaveLength(1);
        expect(stub.state.refreshCalls).toBe(0); // non-renewable: no probe round-trip
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("issue #256 variant B — a server that does NOT advertise refresh_token gets no offline_access, and its no-refresh connect lands a NON-RENEWABLE credential (decision B)", async () => {
    const stub = new StubOAuthMcp();
    stub.grantRefresh = false; // RFC 8414 metadata lists NO refresh_token grant
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
      try {
        const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);
        const minted = await startMcpOAuthFlow(
          { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
          deps,
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;

        // (a) The mint must NOT inflate the scope with offline_access: this
        // server has no refresh grant to hand out, so requesting it would
        // be meaningless. The SDK's own resolution (resource scope "default")
        // is left untouched on BOTH the registration and the authorize URL.
        const mintScope = new URL(minted.authorizationUrl).searchParams.get("scope") ?? "";
        expect(mintScope).toBe("default");
        expect(mintScope.split(" ")).not.toContain("offline_access");
        expect(stub.state.registeredScopes).toHaveLength(1);
        expect(stub.state.registeredScopes[0]!.split(" ")).not.toContain("offline_access");

        // (b) The exchange then issues NO refresh token (nothing refreshable
        // was ever requested). Decision B (issue #265, blanket): the connect
        // SUCCEEDS with a non-renewable credential instead of failing
        // closed — the access-only grant is accepted for its lifetime.
        const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
        const done = await fetch(authorize.headers.get("location")!);
        expect(done.status).toBe(200);
        expect(vault.saves).toHaveLength(1);
        const saved = vault.saves[0]!.credential;
        expect(saved.refresh).toBe("");
        expect((saved as VaultOAuthCredential).refreshable).toBe(false);
        expect(await store.listExtensionCredentials("fixture.oauthmcp")).toHaveLength(1);
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("issue #256 variant A — a fresh connect persists a real refresh token and a subsequent runtime mint rotates it", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
      try {
        const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);
        const minted = await startMcpOAuthFlow(
          { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
          deps,
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;

        const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
        const done = await fetch(authorize.headers.get("location")!);
        expect(done.status).toBe(200);

        // (a) offline_access was requested on the minted/DCR surfaces.
        const mintedScope = new URL(minted.authorizationUrl).searchParams.get("scope") ?? "";
        expect(mintedScope.split(" ")).toContain("offline_access");
        expect(stub.state.registeredScopes[0]!.split(" ")).toContain("offline_access");

        // (b) The stored credential carries a REAL, non-empty refresh token.
        // `saved` is the POST-probe row (the connect-time mint probe already
        // refreshed + rotated once), whose token is the one the runtime
        // mint must present next.
        const saved = vault.saves[vault.saves.length - 1];
        expect(saved).toBeTruthy();
        if (!saved) return;
        expect(saved.credential.refresh).toMatch(/^refresh-rotated-/);
        expect(saved.credential.refresh).not.toBe("");
        expect(saved.credential.access).toMatch(/^access-/);

        // (c) The registry row points AT the saved row (same identity-key
        // row id across exchange + probe saves), so the runtime mint
        // resolves it and refreshes through the SDK.
        const rows = await store.listExtensionCredentials("fixture.oauthmcp");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.broker_credential_id).toBe(saved.brokerCredentialId);

        vault.loadResult = { ...saved.credential, access: "access-stale", expires: Date.now() - 60_000 };
        const provider = await createRuntimeMcpOAuthProvider({
          credential: { ...rows[0], id: "ec_test" },
          tokenStore: vault,
        });
        const result = await auth(provider, { serverUrl: stub.mcpUrl });
        expect(result).toBe("AUTHORIZED");
        // Probe refresh + this runtime refresh — each presented the LATEST
        // rotated token (never a dead one).
        expect(stub.state.refreshCalls).toBe(2);
        expect(stub.state.lastRefreshTokenUsed).toBe(saved.credential.refresh);
        const rotation = vault.saves[vault.saves.length - 1]!;
        expect(rotation.credential.refresh).toMatch(/^refresh-rotated-/);
        expect(rotation.credential.access).not.toBe("access-stale");
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });
});

describe("issue #262 — placeholder-aware offline_access scope composition (Notion) + no silent discovery degradation", () => {
  test("(a) a refresh-advertising AS with the placeholder scope [\"default\"] and NO manifest scopes requests offline_access ALONE — never \"default offline_access\"", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      // Notion's real shape (issue #262 evidence): the AS advertises the
      // refresh_token grant + scopes_supported ["default"], and the manifest
      // declares NO credentialSchema.scopes.
      const deps = flowDeps(store, registryWithManifest(oauthMcpManifestNoScopes(stub.mcpUrl)), vault, "http://127.0.0.1:9");

      const outcome = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      // The authorize URL must NOT carry "default offline_access" — the
      // placeholder is never a real scope to stack onto. offline_access
      // alone requests the refreshable grant with no bogus scope.
      const scope = new URL(outcome.authorizationUrl).searchParams.get("scope") ?? "";
      expect(scope).toBe("offline_access");
      expect(scope.split(" ")).not.toContain("default");
      // The DCR registration request carried the SAME composed scope.
      expect(stub.state.registeredScopes).toEqual(["offline_access"]);
    } finally {
      stub.stop();
    }
  });

  test("(b) a refresh-advertising AS with the placeholder [\"default\"] + REAL manifest scopes: the manifest wins over the placeholder", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const manifest: ExtensionManifest = { ...oauthMcpManifest(stub.mcpUrl), credentialSchema: { type: "oauth", scopes: ["documents:read"] } };
      const deps = flowDeps(store, registryWithManifest(manifest), vault, "http://127.0.0.1:9");

      const outcome = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      // The resource placeholder is ignored; the extension's REAL manifest
      // scopes are the base offline_access stacks onto.
      const scope = new URL(outcome.authorizationUrl).searchParams.get("scope") ?? "";
      expect(scope).toBe("documents:read offline_access");
    } finally {
      stub.stop();
    }
  });

  test("(c) a REAL resource scope base (non-placeholder) still composes offline_access unchanged — no regression", async () => {
    const stub = new StubOAuthMcp();
    stub.protectedResourceScopes = ["documents:read"]; // a genuinely advertised scope, not the "default" placeholder
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const deps = flowDeps(store, registryWithManifest(oauthMcpManifestNoScopes(stub.mcpUrl)), vault, "http://127.0.0.1:9");

      const outcome = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      const scope = new URL(outcome.authorizationUrl).searchParams.get("scope") ?? "";
      expect(scope).toBe("documents:read offline_access");
    } finally {
      stub.stop();
    }
  });

  test("(d) negotiation discovery THROWS: the connect proceeds but the offline_access degradation is LOGGED LOUDLY — never a silent scope:undefined", async () => {
    const stub = new StubOAuthMcp();
    stub.negotiationDiscoveryFails = true; // AS metadata answers HTTP 500 → discovery rejects
    const errorLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map(String).join(" "));
      originalError(...args);
    };
    try {
      const store = freshStore();
      const deps = flowDeps(store, registryWith(stub.mcpUrl), new FakeVaultStore(), "http://127.0.0.1:9");

      const outcome = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );

      // The connect proceeded past the negotiation and failed closed in
      // auth() — as before — so the offline_access/auth-method degradation
      // must have been VISIBLE in the log with the underlying cause.
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.message).toContain("failed");
      const loud = errorLines.find((line) => line.includes("negotiation discovery failed"));
      expect(loud).toBeTruthy();
      expect(loud!).toContain(stub.baseUrl);
      expect(loud!).toContain("500");
    } finally {
      console.error = originalError;
      stub.stop();
    }
  });
});

describe("issue #257 — OAuth credential durability for every MCP integration", () => {
  test("confidential AS: the mint negotiates client_secret_basic, DCR issues a secret, and the exchange + probe send it via Basic auth", async () => {
    const stub = new StubOAuthMcp();
    stub.confidential = true;
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
      try {
        const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);
        const minted = await startMcpOAuthFlow(
          { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
          deps,
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;

        // (a) The connect NEGOTIATED a confidential method (not "none") and
        // the DCR request asked for it — so the server issued a secret.
        expect(stub.state.registeredAuthMethods).toEqual(["client_secret_basic"]);
        expect(stub.state.confidentialClients).toBe(1);

        // (b) Browser authorize → callback exchange + connect-time probe
        // BOTH authenticate with valid confidential credentials via Basic
        // (the persisted method) — never a public (`none`) call.
        const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
        const done = await fetch(authorize.headers.get("location")!);
        expect(done.status).toBe(200);
        expect(stub.state.codeExchanges).toBe(1);
        expect(stub.state.clientAuthMethodsUsed).toEqual(["client_secret_basic", "client_secret_basic"]);

        // (c) The vault row carries the confidential client identity
        // (client_id + client_secret + negotiated method) — not just the
        // tokens — and the probe's refresh rotated it to the latest token.
        const latest = vault.saves[vault.saves.length - 1]!;
        expect(latest.credential).toMatchObject({
          client_id: "client-1",
          client_secret: "secret-1",
          token_endpoint_auth_method: "client_secret_basic",
        });
        expect(latest.credential.refresh).toMatch(/^refresh-rotated-/);

        // The registry row points at the SAME identity-key row (stable 901)
        // despite the second (probe) save.
        const rows = await store.listExtensionCredentials("fixture.oauthmcp");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.broker_credential_id).toBe(901);
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("connect-time mint probe: a server whose refresh is DEAD fails the connect closed with 'exchange was rejected', saving nothing beyond the exchange row", async () => {
    const stub = new StubOAuthMcp();
    stub.deadRefresh = true; // the exchange succeeds, but every refresh dies
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
      try {
        const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);
        const minted = await startMcpOAuthFlow(
          { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
          deps,
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;

        const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
        const done = await fetch(authorize.headers.get("location")!);
        expect(done.status).toBe(500);
        const errorBody = await done.text();
        expect(errorBody).toContain("authorization exchange was rejected");
        expect(errorBody).toContain("cannot mint an access token");

        // Exactly ONE vault save — the exchange row itself. The probe's
        // failed refresh never persisted, and NOTHING else (no registry
        // row, no audit) was written: the connect failed closed.
        expect(vault.saves).toHaveLength(1);
        expect(await store.listExtensionCredentials("fixture.oauthmcp")).toHaveLength(0);
        expect(await store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT })).toHaveLength(0);
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("rotation-on (Gate): a rotating server survives 3 runtime refresh cycles, each presenting the LATEST rotated token — never a dead one — and the vault row tracks the rotation", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
      try {
        const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);
        const minted = await startMcpOAuthFlow(
          { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
          deps,
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;
        const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
        const done = await fetch(authorize.headers.get("location")!);
        expect(done.status).toBe(200);

        const rows = await store.listExtensionCredentials("fixture.oauthmcp");
        const provider = await createRuntimeMcpOAuthProvider({
          credential: { ...rows[0], id: "ec_test" },
          tokenStore: vault,
        });

        // The post-probe row is where runtime minting starts from.
        const refreshBefore = [vault.saves[vault.saves.length - 1]!];
        for (let i = 0; i < 3; i++) {
          const result = await auth(provider, { serverUrl: stub.mcpUrl });
          expect(result).toBe("AUTHORIZED");
          // Each cycle MUST present the latest rotated token: the stub 400s
          // any rotated-away token as invalid_grant (which rejects the mint),
          // so a dead-token cycle could never reach AUTHORIZED.
          expect(stub.state.lastRefreshTokenUsed).toBe(refreshBefore[refreshBefore.length - 1]!.credential.refresh);
          refreshBefore.push(vault.saves[vault.saves.length - 1]!);
        }

        // 1 probe refresh + 3 runtime refreshes, and the vault wrote a
        // distinct NEW token on every save — no dead-token reuse.
        expect(stub.state.refreshCalls).toBe(4);
        expect(stub.state.tokenGrantTypes.filter((grant) => grant === "refresh_token")).toHaveLength(4);
        const refreshSeen = vault.saves.map((save) => save.credential.refresh);
        expect(new Set(refreshSeen).size).toBe(refreshSeen.length);
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("Gate — a confidential provider's env-free runtime mint: the vault's secret + method drive the refresh (no env vars); stripping the secret fails closed", async () => {
    const stub = new StubOAuthMcp();
    stub.confidential = true;
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
      try {
        const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);
        const minted = await startMcpOAuthFlow(
          { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
          deps,
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;
        const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
        const done = await fetch(authorize.headers.get("location")!);
        expect(done.status).toBe(200);

        const rows = await store.listExtensionCredentials("fixture.oauthmcp");

        // POSITIVE: the runtime provider reads ONLY the vault row — no
        // process.env, no re-registration — and the refresh authenticates
        // with the persisted secret via Basic auth.
        const provider = await createRuntimeMcpOAuthProvider({
          credential: { ...rows[0], id: "ec_test" },
          tokenStore: vault,
        });
        const result = await auth(provider, { serverUrl: stub.mcpUrl });
        expect(result).toBe("AUTHORIZED");
        expect(stub.state.clientAuthMethodsUsed.at(-1)).toBe("client_secret_basic");
        const mintedRow = vault.saves[vault.saves.length - 1]!;
        expect(mintedRow.credential).toMatchObject({ token_endpoint_auth_method: "client_secret_basic" });

        // NEGATIVE: a confidential client that LOSES its secret can no
        // longer authenticate on /token → the runtime mint must FAIL CLOSED
        // (invalid_client), never silently degrade to a public client.
        const stripped = { ...mintedRow.credential, client_secret: "", token_endpoint_auth_method: "none" };
        vault.loadResult = stripped;
        const publicProvider = await createRuntimeMcpOAuthProvider({
          credential: { ...rows[0], id: "ec_test" },
          tokenStore: vault,
        });
        await expect(auth(publicProvider, { serverUrl: stub.mcpUrl })).rejects.toMatchObject({ name: "InvalidClientError" });
        // The failed mint persisted nothing.
        expect(vault.saves.length).toBe(3);
        expect(vault.saves[2]!.credential.refresh).toMatch(/^refresh-rotated-/);
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });
});

describe("issue #263 — precise fail-closed cause + DEBUG token-endpoint capture", () => {
  /** Full mint → browser-authorize → callback round trip; returns the callback's HTTP response. */
  async function roundTrip(stub: StubOAuthMcp, store: Store, vault: FakeVaultStore): Promise<Response> {
    const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
    try {
      const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl);
      const minted = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );
      if (!minted.ok) throw new Error(`mint failed: ${minted.message}`);
      const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
      return await fetch(authorize.headers.get("location")!);
    } finally {
      callback.stop();
    }
  }

  test("(a) an AS that advertises the refresh_token grant but returns an access-only exchange lands a NON-RENEWABLE credential (decision B)", async () => {
    const stub = new StubOAuthMcp();
    stub.dropRefresh = true; // ignores offline_access: the exchange returns access with NO refresh_token
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      // The AS DOES advertise refresh_token (the #263 shape — Notion
      // advertises refresh_token yet grants an access-only token).
      const metadata = (await (await fetch(`${stub.baseUrl}/.well-known/oauth-authorization-server`)).json()) as {
        grant_types_supported: string[];
      };
      expect(metadata.grant_types_supported).toContain("refresh_token");

      // Decision B (issue #265): the access-only outcome is ACCEPTED — the
      // connect succeeds and persists a non-renewable credential (the #263
      // fail-closed rejection is deliberately relaxed for this tier).
      const done = await roundTrip(stub, store, vault);
      expect(done.status).toBe(200);
      expect(vault.saves).toHaveLength(1); // exchange save only — probe skipped
      const saved = vault.saves[0]!.credential;
      expect(saved.refresh).toBe("");
      expect((saved as VaultOAuthCredential).refreshable).toBe(false);
      expect(await store.listExtensionCredentials("fixture.oauthmcp")).toHaveLength(1);
      expect(stub.state.refreshCalls).toBe(0); // non-renewable: no mint probe
    } finally {
      stub.stop();
    }
  });

  test("(b) a refresh-advertising AS that honors offline_access still lands a refreshable row a subsequent tools/list mint can use", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const done = await roundTrip(stub, store, vault);
      expect(done.status).toBe(200);

      // The POST-probe vault row is genuinely refreshable.
      const saved = vault.saves[vault.saves.length - 1];
      expect(saved).toBeTruthy();
      if (!saved) return;
      expect(saved.credential.refresh).toMatch(/^refresh-rotated-/);
      expect(saved.credential.refresh).not.toBe("");

      // A later mint resolves the registry row and refreshes through the
      // SDK from a stale access token — the #263 negotiation threading
      // never broke the #256/#257 happy path.
      const rows = await store.listExtensionCredentials("fixture.oauthmcp");
      expect(rows).toHaveLength(1);
      vault.loadResult = { ...saved.credential, access: "access-stale", expires: Date.now() - 60_000 };
      const provider = await createRuntimeMcpOAuthProvider({ credential: { ...rows[0], id: "ec_test" }, tokenStore: vault });
      const result = await auth(provider, { serverUrl: stub.mcpUrl });
      expect(result).toBe("AUTHORIZED");
      expect(stub.state.refreshCalls).toBe(2); // connect-time probe + this runtime mint
      expect(vault.saves[vault.saves.length - 1]!.credential.refresh).toMatch(/^refresh-rotated-/);
    } finally {
      stub.stop();
    }
  });

  test("(c) DEBUG capture: the token endpoint's masked response is logged while DEBUG is set and is silent without it", async () => {
    const stub = new StubOAuthMcp();
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const savedDebug = process.env.DEBUG;
      const originalDebug = console.debug;
      const lines: string[] = [];
      console.debug = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      try {
        // OFF by default: connect with DEBUG unset emits NO token capture.
        delete process.env.DEBUG;
        const off = await roundTrip(stub, store, vault);
        expect(off.status).toBe(200);
        expect(lines.filter((l) => l.includes("/token"))).toHaveLength(0);
        lines.length = 0;

        // ON: connect again with DEBUG set → the token endpoint's MASKED
        // responses are captured (the exchange + the connect-time probe).
        process.env.DEBUG = "1";
        const on = await roundTrip(stub, store, vault);
        expect(on.status).toBe(200);
        const tokenLogs = lines.filter((l) => l.includes("/token"));
        expect(tokenLogs.length).toBeGreaterThan(0);
        const joined = tokenLogs.join("\n");
        // The masked marker appears (short values → <masked>; longer → first-8 + …).
        expect(joined).toMatch(/<masked>|…/);
        // No real token value ever leaks into the capture.
        for (const save of vault.saves) {
          expect(joined).not.toContain(save.credential.access);
          expect(joined).not.toContain(save.credential.refresh);
        }
      } finally {
        if (savedDebug === undefined) delete process.env.DEBUG;
        else process.env.DEBUG = savedDebug;
        console.debug = originalDebug;
      }
    } finally {
      stub.stop();
    }
  });
});

describe("token refresh — the runtime provider (issue #198)", () => {
  /** Runs a real connect round trip and returns the vault-saved credential. */
  async function connectCredential(stub: StubOAuthMcp, store: Store, vault: FakeVaultStore): Promise<OAuthCredential> {
    const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
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
      // The POST-probe row: the connect-time mint probe already refreshed +
      // rotated once, so the runtime must start from the LATEST vault row.
      const saved = vault.saves[vault.saves.length - 1];
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
      const provider = await createRuntimeMcpOAuthProvider({
        credential: {
          id: "ec_test",
          provider: "fixture.oauthmcp",
          vault_provider: "fixture.oauthmcp",
          identity_key: "oauth:UADA",
          owner: "UADA",
          scope: "personal",
          broker_credential_id: 901,
          pending_vault_provider: null,
          pending_broker_credential_id: null,
          pending_identity_key: null,
          retiring_broker_credential_id: null,
          status: "active",
          revision: 1,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
        tokenStore: vault,
      });

      const result = await auth(provider, { serverUrl: stub.mcpUrl });

      expect(result).toBe("AUTHORIZED");
      // The connect-time probe already refreshed once; THIS is the runtime
      // refresh, presenting the post-probe (latest rotated) token.
      expect(stub.state.refreshCalls).toBe(2);
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
      const provider = await createRuntimeMcpOAuthProvider({
        credential: {
          id: "ec_test",
          provider: "fixture.oauthmcp",
          vault_provider: "fixture.oauthmcp",
          identity_key: "oauth:UADA",
          owner: "UADA",
          scope: "personal",
          broker_credential_id: 901,
          pending_vault_provider: null,
          pending_broker_credential_id: null,
          pending_identity_key: null,
          retiring_broker_credential_id: null,
          status: "active",
          revision: 1,
          created_at: Date.now(),
          updated_at: Date.now(),
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
    const provider = await createRuntimeMcpOAuthProvider({
      credential: {
        id: "ec_test",
        provider: "fixture.oauthmcp",
        vault_provider: "fixture.oauthmcp",
        identity_key: "oauth:UADA",
        owner: "UADA",
        scope: "personal",
        broker_credential_id: 901,
        pending_vault_provider: null,
        pending_broker_credential_id: null,
        pending_identity_key: null,
        retiring_broker_credential_id: null,
        status: "active",
        revision: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
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
      // Exchange write + the issue #257 connect-time mint probe's rotation
      // write-back, both on the SAME identity-key row (stable id 901).
      expect(vault.saves).toHaveLength(2);
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

describe("shared public base across worktrees — OAuth callback surface (issue #293)", () => {
  test("a worktree-started server mints the authorize redirect_uri from the shared store, not a loopback fallback", async () => {
    const stub = new StubOAuthMcp();
    const top = mkdtempSync(join(tmpdir(), "bottega-worktree-oauth-"));
    const sharedStore = join(top, "checkout", "data", "public-base-url");
    const worktreeCwd = join(top, "checkout", ".worktrees", "feature");
    mkdirSync(dirname(sharedStore), { recursive: true });
    mkdirSync(worktreeCwd, { recursive: true });
    // The tunnel (issue #249) wrote the live base to the canonical store.
    writeFileSync(sharedStore, "https://tunnel-a.trycloudflare.com\n");

    const savedFile = process.env.BOTTEGA_PUBLIC_BASE_URL_FILE;
    const savedEnv = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
    const savedCwd = process.cwd();
    try {
      // scripts/dev.sh (issue #293): the server runs from the feature
      // worktree, the env carries the CANONICAL store's absolute path.
      process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = sharedStore;
      delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      process.chdir(worktreeCwd);

      const store = freshStore();
      const vault = new FakeVaultStore();
      const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, "http://127.0.0.1:9");
      // The server's exact wiring (src/server/index.ts): the callback base
      // resolves LAZILY from the shared store on every mint; the loopback
      // URL is only the unconfigured fallback.
      deps.callbackBaseUrl = () => uploadLinkPublicBase() ?? "http://127.0.0.1:9";

      const minted = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", actor: "UADA", scope: "personal" as const },
        deps,
      );
      expect(minted.ok).toBe(true);
      if (minted.ok) {
        expect(new URL(minted.authorizationUrl).searchParams.get("redirect_uri")).toBe(
          "https://tunnel-a.trycloudflare.com/oauth/callback",
        );
      }
    } finally {
      if (savedFile === undefined) delete process.env.BOTTEGA_PUBLIC_BASE_URL_FILE;
      else process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = savedFile;
      if (savedEnv === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = savedEnv;
      process.chdir(savedCwd);
      rmSync(top, { recursive: true, force: true });
      stub.stop();
    }
  });
});

describe("production connector probeCallbackBase — the connect-side gate (issue #271)", () => {
  test("any non-5xx answers live; a dead base is refused with the base named", async () => {
    // Live: the callback surface 404s unknown paths, so a real loopback
    // server answering 404 proves the base forwards to a listener.
    const live = Bun.serve({ port: 0, fetch: () => new Response("not found", { status: 404 }) });
    // Dead: a port that just stopped listening — connection refused.
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const deadPort = dead.port;
    dead.stop();
    try {
      const store = freshStore();
      const connector = createMcpOAuthConnector({
        registry: registryWith("https://mcp.example.com/mcp"),
        store,
        audit: createAudit(store),
        callbackBaseUrl: () => `http://127.0.0.1:${live.port}`,
      });
      const liveProbe = await connector.probeCallbackBase();
      expect(liveProbe).toMatchObject({ ok: true, base: `http://127.0.0.1:${live.port}` });

      const deadConnector = createMcpOAuthConnector({
        registry: registryWith("https://mcp.example.com/mcp"),
        store,
        audit: createAudit(store),
        callbackBaseUrl: () => `http://127.0.0.1:${deadPort}`,
      });
      const deadProbe = await deadConnector.probeCallbackBase();
      expect(deadProbe.ok).toBe(false);
      if (!deadProbe.ok) {
        expect(deadProbe.base).toContain(String(deadPort));
        expect(deadProbe.message).toBeDefined();
      }
    } finally {
      live.stop();
    }
  });
});

describe("issue #288 — static OAuth clients for no-DCR authorization servers", () => {
  const STATIC_CLIENT_ID = "static-client-123.apps.example";
  const STATIC_CLIENT_SECRET = "static-secret-456";

  class RecordingRouter implements ApprovalRouter {
    readonly requests: ApprovalRequest[] = [];
    constructor(private resolution: ApprovalResolution = { approved: true }) {}
    async request(d: ApprovalRequest): Promise<ApprovalResolution> {
      this.requests.push(d);
      return this.resolution;
    }
  }

  /** POSTs client_id + client_secret to the one-time upload URL (the browser leg). */
  function postStaticClient(url: string, clientId: string, clientSecret: string): Promise<Response> {
    const body = new FormData();
    body.append("client_id", clientId);
    body.append("client_secret", clientSecret);
    return fetch(url, { method: "POST", body });
  }

  /** The caller-level connect deps: the REAL connector (probe + mint) over the stub. */
  function callerDeps(store: Store, registry: ExtensionRegistry, vault: FakeVaultStore, staticStore: FakeStaticClientStore, baseUrl: string) {
    const router = new RecordingRouter({ approved: true });
    const policy: PolicyConfig = parseOrgConfigYaml("tools:\n  connect_extension: allow\n");
    const connector = createMcpOAuthConnector({
      registry,
      store,
      audit: createAudit(store),
      callbackBaseUrl: () => baseUrl,
      tokenStore: vault,
      staticClientStore: staticStore,
    });
    const deps: ConnectExtensionDeps = {
      registry,
      store,
      audit: createAudit(store),
      broker: async () => {
        throw new Error("the hosted-OAuth connect must never touch the broker");
      },
      mcpOAuth: connector,
      gate: { loadPolicy: async () => policy, router },
      reconcileEgress: async () => ({ warnings: [] }),
    };
    return { deps, router };
  }

  test("caller-level RED: a no-DCR connect fails with the connect_upload_link instruction and writes no flow", async () => {
    const stub = new StubOAuthMcp();
    stub.registrationEndpoint = false; // the Gmail class: OAuth metadata, NO registration endpoint
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const staticStore = new FakeStaticClientStore();
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
      try {
        const { deps } = callerDeps(store, registryWith(stub.mcpUrl), vault, staticStore, callback.baseUrl);

        const red = await connectExtension({ extension: "fixture.oauthmcp", scope: "personal", actor: "UADA" }, deps);

        // Old code fails with the SDK's bare "does not support dynamic
        // client registration"; the fix must name the provisioning path.
        expect(red.ok).toBe(false);
        if (!red.ok) {
          expect(red.message).toContain("connect_upload_link");
          expect(red.message).toContain("scope=org");
          expect(red.message).toContain("fixture.oauthmcp");
        }
        expect(stub.state.registerCalls).toBe(0);
        expect(store.countActiveOAuthFlows("UADA")).toBe(0); // no flow row written
        expect(staticStore.loadCalls).toBe(1); // the no-DCR connect consulted the static client
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("caller-level GREEN: after provisioning through the real one-time upload HTTP path, the no-DCR connect returns an authorization URL with zero registration requests", async () => {
    const stub = new StubOAuthMcp();
    stub.registrationEndpoint = false;
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const staticStore = new FakeStaticClientStore();
      const registry = registryWith(stub.mcpUrl);
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
      try {
        const { deps, router } = callerDeps(store, registry, vault, staticStore, callback.baseUrl);

        // Provision through the REAL one-time upload HTTP path (the boot's
        // wiring: the upload mount rides the callback server's listener).
        const upload = mountUploadLink({
          registry,
          store,
          audit: createAudit(store),
          broker: async () => {
            throw new Error("the fake static-client store owns the vault here");
          },
          staticOAuthClientStore: staticStore,
          gate: { loadPolicy: async () => parseOrgConfigYaml("tools:\n  connect_extension: allow\n"), router },
        });
        const uploadServer = startOAuthCallbackServer({ store, audit: createAudit(store), uploadLink: upload, port: 0 });
        try {
          const minted = upload.store.mint({
            extension: "fixture.oauthmcp",
            scope: "org",
            actor: "UADA",
            label: "Fixture OAuth MCP",
          });
          expect(minted.ok).toBe(true);
          if (!minted.ok) return;
          const uploadUrl = `${uploadServer.baseUrl}/upload/${minted.token}`;

          // The form renders TWO separate fields (client ID + client secret).
          const form = await fetch(uploadUrl);
          expect(form.status).toBe(200);
          const formHtml = await form.text();
          expect(formHtml).toContain('name="client_id"');
          expect(formHtml).toContain('name="client_secret"');
          expect(formHtml).not.toContain(STATIC_CLIENT_ID);
          expect(formHtml).not.toContain(STATIC_CLIENT_SECRET);

          const uploaded = await postStaticClient(uploadUrl, STATIC_CLIENT_ID, STATIC_CLIENT_SECRET);
          expect(uploaded.status).toBe(200);
          expect(await uploaded.text()).toContain("Saved to the vault");
          expect(staticStore.saves).toEqual([
            { extension: "fixture.oauthmcp", client: { client_id: STATIC_CLIENT_ID, client_secret: STATIC_CLIENT_SECRET } },
          ]);
          // The org-scoped store crossed the connect_extension gate.
          expect(router.requests).toHaveLength(1);
          expect(router.requests[0]!.tool).toBe("connect_extension");
          // The audit row carries METADATA ONLY — never the client values.
          const audit = await store.listAudit({ event_type: STATIC_CLIENT_PROVISIONED_EVENT });
          expect(audit).toHaveLength(1);
          expect(JSON.parse(audit[0]!.payload)).toEqual({
            extension: "fixture.oauthmcp",
            scope: "org",
            owner: null,
            status: "provisioned",
          });
          const auditText = JSON.stringify(JSON.parse(audit[0]!.payload));
          expect(auditText).not.toContain(STATIC_CLIENT_ID);
          expect(auditText).not.toContain(STATIC_CLIENT_SECRET);
        } finally {
          uploadServer.stop();
        }

        // GREEN: the same caller now connects — the authorize request
        // carries the configured client id + the correct redirect/state/PKCE,
        // and the server recorded ZERO registration requests.
        const green = await connectExtension({ extension: "fixture.oauthmcp", scope: "personal", actor: "UADA" }, deps);
        expect(green.ok).toBe(true);
        if (!green.ok) return;
        const match = green.message.match(/https?:\/\/\S+/);
        expect(match).toBeTruthy();
        const url = new URL(match![0]);
        expect(url.searchParams.get("client_id")).toBe(STATIC_CLIENT_ID);
        expect(url.searchParams.get("redirect_uri")).toBe(`${callback.baseUrl}/oauth/callback`);
        expect(url.searchParams.get("state")).toBeTruthy();
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(stub.state.registerCalls).toBe(0);
        // No SECRET appears in the connect reply or audit trail (the client
        // id is public — it is the authorize URL's own client_id param).
        expect(green.message).not.toContain(STATIC_CLIENT_SECRET);
        const connectedAudit = await store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT });
        expect(connectedAudit).toHaveLength(0); // the callback has not run yet

        // The flow row persisted the static client identity (client id +
        // secret + negotiated auth method) so the callback can exchange.
        const state = url.searchParams.get("state")!;
        const row = store.getOAuthFlow(state);
        expect(row).not.toBeNull();
        if (row) {
          const flow = JSON.parse(row.flow) as PersistedOAuthFlow;
          expect(flow.clientInformation).toMatchObject({
            client_id: STATIC_CLIENT_ID,
            client_secret: STATIC_CLIENT_SECRET,
            token_endpoint_auth_method: "none", // public stub: the negotiated method
          });
          expect(flow.codeVerifier).toBeTruthy();
        }
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("a DCR-capable server still registers dynamically — the static client is never loaded", async () => {
    const stub = new StubOAuthMcp(); // registrationEndpoint defaults true
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const staticStore = new FakeStaticClientStore();
      const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, "http://127.0.0.1:9", staticStore);

      const outcome = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(stub.state.registerCalls).toBe(1); // DCR happened, unchanged
      expect(staticStore.loadCalls).toBe(0); // the static client was never consulted
    } finally {
      stub.stop();
    }
  });

  test("an INSECURE registration endpoint (plain-http, non-loopback) is treated as no-DCR — fail closed to the static client", async () => {
    const stub = new StubOAuthMcp();
    stub.registrationEndpointOverride = "http://insecure.example/register";
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const staticStore = new FakeStaticClientStore();
      const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, "http://127.0.0.1:9", staticStore);

      // No static client → the provisioning instruction, never a POST to
      // the insecure endpoint.
      const red = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );
      expect(red.ok).toBe(false);
      if (!red.ok) {
        expect(red.message).toContain("connect_upload_link");
        expect(red.message).toContain("scope=org");
      }
      expect(stub.state.registerCalls).toBe(0);
      expect(store.countActiveOAuthFlows("UADA")).toBe(0);

      // With a static client provisioned the connect succeeds — and still
      // never POSTs to the insecure registration endpoint.
      staticStore.rows.set("fixture.oauthmcp", { client_id: STATIC_CLIENT_ID, client_secret: STATIC_CLIENT_SECRET });
      const green = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );
      expect(green.ok).toBe(true);
      if (!green.ok) return;
      expect(new URL(green.authorizationUrl).searchParams.get("client_id")).toBe(STATIC_CLIENT_ID);
      expect(stub.state.registerCalls).toBe(0);
    } finally {
      stub.stop();
    }
  });

  test("the callback exchanges with the persisted static client and writes the per-user token under the EXTENSION provider — never the synthetic client provider", async () => {
    const stub = new StubOAuthMcp();
    stub.registrationEndpoint = false;
    stub.confidential = true; // the AS requires client_secret_basic on /token
    stub.addStaticClient(STATIC_CLIENT_ID, STATIC_CLIENT_SECRET);
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const staticStore = new FakeStaticClientStore();
      staticStore.rows.set("fixture.oauthmcp", { client_id: STATIC_CLIENT_ID, client_secret: STATIC_CLIENT_SECRET });
      const callback = startOAuthCallbackServer({ store, audit: createAudit(store), tokenStore: vault, port: 0 });
      try {
        const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, callback.baseUrl, staticStore);
        const minted = await startMcpOAuthFlow(
          { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
          deps,
        );
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;
        expect(stub.state.registerCalls).toBe(0);

        const authorize = await fetch(minted.authorizationUrl, { redirect: "manual" });
        expect(authorize.status).toBe(302);
        const done = await fetch(authorize.headers.get("location")!);
        expect(done.status).toBe(200);

        // The per-user token rows landed under the REAL extension provider
        // (exchange + connect-time probe) — the synthetic client provider
        // was never written by the callback.
        expect(vault.saves).toHaveLength(2);
        for (const save of vault.saves) expect(save.provider).toBe("fixture.oauthmcp");
        expect(staticStore.saves).toHaveLength(0);
        const lastSave = vault.saves[vault.saves.length - 1]!;
        const saved = lastSave.credential;
        // The persisted static client identity rode the vault round-trip:
        // the SDK exchanged AND refreshed with it via Basic auth.
        expect(saved).toMatchObject({
          client_id: STATIC_CLIENT_ID,
          client_secret: STATIC_CLIENT_SECRET,
          token_endpoint_auth_method: "client_secret_basic",
        });
        expect(stub.state.clientAuthMethodsUsed).toEqual(["client_secret_basic", "client_secret_basic"]);

        // The registry row references the extension-provider vault row.
        const rows = await store.listExtensionCredentials("fixture.oauthmcp");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.broker_credential_id).toBe(lastSave.brokerCredentialId);

        // The RUNTIME mint reuses the persisted identity: an expired access
        // token refreshes through the SDK with the static client's secret.
        vault.loadResult = { ...saved, access: "access-stale", expires: Date.now() - 60_000 };
        const provider = await createRuntimeMcpOAuthProvider({ credential: { ...rows[0], id: "ec_test" }, tokenStore: vault });
        const result = await auth(provider, { serverUrl: stub.mcpUrl });
        expect(result).toBe("AUTHORIZED");
        expect(stub.state.refreshCalls).toBe(2); // connect-time probe + this runtime mint
        expect(stub.state.clientAuthMethodsUsed.at(-1)).toBe("client_secret_basic");
      } finally {
        callback.stop();
      }
    } finally {
      stub.stop();
    }
  });

  test("a missing static client row reads fail-closed (null) — the connect names the provisioning path", async () => {
    const stub = new StubOAuthMcp();
    stub.registrationEndpoint = false;
    try {
      const store = freshStore();
      const vault = new FakeVaultStore();
      const staticStore = new FakeStaticClientStore();
      staticStore.loadResult = null; // no row at all
      const deps = flowDeps(store, registryWith(stub.mcpUrl), vault, "http://127.0.0.1:9", staticStore);

      const outcome = await startMcpOAuthFlow(
        { extension: "fixture.oauthmcp", provider: "fixture.oauthmcp", label: "Fixture OAuth MCP", scope: "personal", actor: "UADA" },
        deps,
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.message).toContain("connect_upload_link");
        expect(outcome.message).toContain("scope=org");
      }
      expect(store.countActiveOAuthFlows("UADA")).toBe(0);
      expect(stub.state.registerCalls).toBe(0);
    } finally {
      stub.stop();
    }
  });
});

describe("issue #288 — the mint's capability discovery is bounded (P2 review)", () => {
  test("a never-responding authorization server maps the capability check to UNKNOWN within the injected timeout — never an OS-level hang", async () => {
    // A server that ACCEPTS the connection but never responds: the mint's
    // discovery fetch must abort at the bounded timeout, not hang until the
    // OS-level fetch timeout. The timeout is injected (150ms) so the test
    // completes in milliseconds — production uses the 5s probe constant.
    const hanging = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const started = Date.now();
      const capability = await resolveMcpOAuthRegistrationCapability(`http://127.0.0.1:${hanging.port}/mcp`, 150);
      const elapsed = Date.now() - started;
      expect(capability).toBe("unknown"); // fail closed: no no-DCR verdict, no mint
      expect(elapsed).toBeLessThan(3_000); // far below an OS-level timeout
    } finally {
      hanging.stop(true);
    }
  });
});
