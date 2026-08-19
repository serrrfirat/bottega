/**
 * Generic MCP OAuth (issue #198): the authorization-code + PKCE flow for
 * ANY hosted OAuth MCP (Notion, GitHub, Linear) in the extension runtime —
 * the MCP SDK's OWN OAuth client drives RFC 9728 protected-resource /
 * RFC 8414 authorization-server discovery, RFC 7591 dynamic client
 * registration, PKCE, the code exchange, and refresh. The auth-broker
 * stays a VAULT (token storage through the existing broker upload path) —
 * never an OAuth registry, so connecting a new hosted MCP requires zero
 * broker changes.
 *
 * Two legs share one {@link BottegaMcpOAuthProvider} (the SDK's
 * {@link OAuthClientProvider} contract):
 *
 * - CONNECT (the #196 one-time-link posture): the connect tool mints a
 *   flow — `auth()` returns the authorization URL (state = an opaque
 *   single-use flow token), the flow's PKCE verifier / registered client
 *   info / discovery state are persisted to the shared `oauth_flows`
 *   table, and the URL is shown in Slack. The user's browser completes the
 *   flow; the server's callback endpoint (src/extensions/oauth-callback.ts)
 *   exchanges the code and stores the token in the vault.
 * - RUNTIME: the resolved credential's provider loads the vault row raw
 *   (`listStoredCredentials` — the REAL refresh token locally; the broker
 *   redacts it to {@link REMOTE_REFRESH_SENTINEL} remotely, so remote
 *   refresh falls back to a re-auth prompt, fail closed). The SDK refreshes
 *   on 401 and `saveTokens` persists the rotated tokens back into the
 *   vault.
 *
 * Fail closed everywhere: missing metadata, a failed exchange, a consumed/
 * expired flow token, or a missing vault row are clear errors — never a
 * silent no-op.
 */
import { randomBytes } from "node:crypto";
import { auth, discoverOAuthServerInfo, type AuthResult, type OAuthClientProvider, type OAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { REMOTE_REFRESH_SENTINEL, type OAuthCredential } from "@oh-my-pi/pi-ai";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { resolveAuthBrokerConfig } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import type { AuditModule } from "../policy/audit";
import type { ExtensionCredential, OAuthFlow, Store } from "../store/db";
import { EXTENSION_CONNECTED_EVENT } from "../store/audit-events";
import { errorMessage } from "../tools/helpers";
import { oauthIdentityKey, pickNewestBrokerEntry, type ConnectScope } from "./connect";
import type { ExtensionRegistry } from "./registry";
import type { VaultOAuthCredential } from "./proxy-seed";

/** Default flow lifetime: short by design — 15 minutes, like upload links. */
export const MCP_OAUTH_FLOW_TTL_MS = 15 * 60_000;
/** Per-actor cap on live (unexpired) flows — the mint path's rate limit. */
export const MCP_OAUTH_MAX_OUTSTANDING_PER_ACTOR = 5;

/** The store slice the flow path needs (the full {@link Store} satisfies it). */
export type OAuthFlowStoreSlice = Pick<
  Store,
  "createOAuthFlow" | "getOAuthFlow" | "consumeOAuthFlow" | "countActiveOAuthFlows"
>;

/**
 * The flow path's token bookkeeping, mirroring {@link UploadLinkStore}
 * (issue #196): SQLite-backed flows (shared across processes via the store
 * file) + single-use/expiry enforced by the store's atomic consume. The
 * flow TOKEN doubles as the OAuth `state` parameter — the authorization
 * URL's state is this row's key, so the callback can only complete the
 * flow that minted it.
 */
export class OAuthFlowStore {
  readonly ttlMs: number;
  readonly maxOutstandingPerActor: number;
  readonly #store: OAuthFlowStoreSlice;

  constructor(store: OAuthFlowStoreSlice, opts: { ttlMs?: number; maxOutstandingPerActor?: number } = {}) {
    this.#store = store;
    this.ttlMs = opts.ttlMs ?? MCP_OAUTH_FLOW_TTL_MS;
    this.maxOutstandingPerActor = opts.maxOutstandingPerActor ?? MCP_OAUTH_MAX_OUTSTANDING_PER_ACTOR;
  }

  /** Mints a single-use, expiring flow; refuses past the per-actor cap. */
  mint(input: {
    token: string;
    provider: string;
    scope: ConnectScope;
    actor: string;
    spaceId?: string | null;
    label: string;
    serverUrl: string;
    redirectUri: string;
    flow: string;
    ttlMs?: number;
    /** Absolute ms override — tests pin expiry without waiting. */
    expiresAt?: number;
  }): { ok: true; token: string; expiresAt: number } | { ok: false; reason: string } {
    if (this.#store.countActiveOAuthFlows(input.actor) >= this.maxOutstandingPerActor) {
      return {
        ok: false,
        reason: `too many outstanding ${input.label} authorization flows for ${input.actor} — reuse one or wait for it to expire`,
      };
    }
    const expiresAt = input.expiresAt ?? Date.now() + (input.ttlMs ?? this.ttlMs);
    this.#store.createOAuthFlow({
      token: input.token,
      provider: input.provider,
      scope: input.scope,
      actor: input.actor,
      spaceId: input.spaceId,
      label: input.label,
      serverUrl: input.serverUrl,
      redirectUri: input.redirectUri,
      flow: input.flow,
      expiresAt,
    });
    return { ok: true, token: input.token, expiresAt };
  }

  /** Non-consuming read (diagnostics); null when the token is unknown/used. */
  peek(token: string) {
    return this.#store.getOAuthFlow(token);
  }

  /** Atomic single-use consume; anything else is gone (fail closed). */
  consume(token: string): { ok: true; row: OAuthFlow } | { ok: false } {
    return this.#store.consumeOAuthFlow(token);
  }
}

/**
 * The vault token store: reads/writes the OAuth credential rows through the
 * EXISTING vault path (broker upload when a broker is configured, else the
 * local AuthStorage) — the same branches {@link connectViaAuthBroker}'s
 * api_key path uses. The broker is a vault, never an OAuth registry.
 */
export interface McpOAuthTokenStore {
  /** Stores the token in the vault; returns the vault row id (the registry's brokerCredentialId). */
  save(provider: string, credential: OAuthCredential): Promise<{ brokerCredentialId: number }>;
  /** Loads the vault row RAW (real refresh token locally, sentinel remotely); null when missing. */
  load(provider: string, brokerCredentialId: number): Promise<OAuthCredential | null>;
}

/** Production vault token store (env-configured broker, else local storage). */
export function createVaultTokenStore(): McpOAuthTokenStore {
  return {
    async save(provider, credential) {
      const brokerConfig = await resolveAuthBrokerConfig();
      if (brokerConfig) {
        const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
        const res = await client.uploadCredential(provider, credential);
        const newest = pickNewestBrokerEntry(res.entries);
        if (!newest) throw new Error(`the broker did not record the "${provider}" OAuth credential`);
        return { brokerCredentialId: newest.id };
      }
      const storage = await discoverAuthStorage();
      try {
        await storage.reload();
        const entries = storage.upsertCredential(provider, credential);
        const newest = pickNewestBrokerEntry(entries);
        if (!newest) throw new Error(`the vault did not record the "${provider}" OAuth credential`);
        return { brokerCredentialId: newest.id };
      } finally {
        storage.close();
      }
    },
    async load(provider, brokerCredentialId) {
      const storage = await discoverAuthStorage();
      try {
        await storage.reload();
        const row = storage.listStoredCredentials(provider).find((entry) => entry.id === brokerCredentialId);
        return row !== undefined && row.credential.type === "oauth" ? row.credential : null;
      } finally {
        storage.close();
      }
    },
  };
}

/**
 * Vault OAuth credential → SDK tokens. The vault stores `refresh` (real
 * locally; the broker redacts it to {@link REMOTE_REFRESH_SENTINEL}) and
 * `expires` as an absolute epoch-ms. A sentinel refresh is DROPPED — the
 * SDK must never POST it to the token endpoint; the runtime then falls to
 * the re-auth prompt on expiry (fail closed, no garbage requests).
 */
export function vaultCredentialToTokens(credential: OAuthCredential): OAuthTokens {
  const refreshToken =
    credential.refresh !== undefined &&
    credential.refresh !== "" &&
    credential.refresh !== REMOTE_REFRESH_SENTINEL
      ? credential.refresh
      : undefined;
  const tokens: OAuthTokens = {
    access_token: credential.access,
    token_type: "Bearer",
  };
  if (credential.expires > 0) {
    tokens.expires_in = Math.max(1, Math.floor((credential.expires - Date.now()) / 1000));
  }
  if (refreshToken !== undefined) tokens.refresh_token = refreshToken;
  return tokens;
}

/**
 * SDK tokens → vault OAuth credential. `expires_in` (seconds) becomes an
 * absolute epoch-ms `expires`. A missing refresh token in the exchange
 * response preserves the vault's previous one (servers that don't rotate
 * omit it) — the grant must not silently lose its refresh capability.
 * Issue #256: when there is NO refresh token to keep — the exchange
 * returned none AND there is no previous row holding one — the credential
 * is never written as an empty-refresh row (that is the bug that breaks
 * every later read: the proxy mint fails with `oauth_token failed to mint`).
 * The save FAILS instead, so the connect fails closed with a clear cause.
 *
 * The per-user registered client identity (issue #250) rides along: the
 * DCR `client_information` (`client_id`/`client_secret`) is per-user vault
 * data, not a deployment env constant, so `tokensToVaultCredential`
 * persists it (fresh DCR first, the previous row's identity as the
 * refresh-round-trip carry-forward) for the connect-time egress reconcile
 * to seed the proxy OAuth blob from. Empty/undefined fields are stripped.
 */
export function tokensToVaultCredential(
  tokens: OAuthTokens,
  previous: OAuthCredential | null,
  clientInformation?: { client_id?: string; client_secret?: string; token_endpoint_auth_method?: string },
): VaultOAuthCredential {
  // A genuine new refresh wins; otherwise the previous row's refresh is
  // carried forward (non-rotating servers). Neither present → the grant
  // cannot be refreshed at all: fail closed rather than persist an
  // empty-refresh credential that mints nothing.
  const refresh = tokens.refresh_token && tokens.refresh_token !== "" ? tokens.refresh_token : previous?.refresh;
  if (refresh === undefined || refresh === "") {
    throw new Error("the OAuth server issued no refresh token (offline_access was not granted) — the credential was not saved");
  }
  const credential: VaultOAuthCredential = {
    type: "oauth",
    access: tokens.access_token,
    refresh,
    expires: tokens.expires_in !== undefined && tokens.expires_in > 0 ? Date.now() + tokens.expires_in * 1000 : 0,
  };
  const carried = previous as VaultOAuthCredential | null;
  const clientId = clientInformation?.client_id ?? carried?.client_id;
  const clientSecret = clientInformation?.client_secret ?? carried?.client_secret;
  // Issue #257: the negotiated auth method (client_secret_basic/post for
  // confidential AS, "none" for public) is per-user vault data — persisted
  // alongside the secret so the runtime mints with the SAME method, and
  // rotation write-backs never degrade it to a public client.
  const clientAuthMethod = clientInformation?.token_endpoint_auth_method ?? carried?.token_endpoint_auth_method;
  if (clientId !== undefined && clientId !== "") credential.client_id = clientId;
  if (clientSecret !== undefined && clientSecret !== "") credential.client_secret = clientSecret;
  if (clientAuthMethod !== undefined && clientAuthMethod !== "") credential.token_endpoint_auth_method = clientAuthMethod;
  return credential;
}

/** The persisted flow bookkeeping (the `oauth_flows.flow` JSON blob). */
export interface PersistedOAuthFlow {
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  discoveryState?: OAuthDiscoveryState;
  /**
   * The connect-negotiated `token_endpoint_auth_method` (issue #257).
   * Persisted so the callback restores confidential client auth even when
   * a real DCR response fails to echo the method back — defense-in-depth
   * for the vault row's `token_endpoint_auth_method` field.
   */
  tokenEndpointAuthMethod?: string;
  authorizationUrl?: string;
}

export interface McpOAuthProviderOpts {
  /** The registered callback URL; the authorization server redirects the browser here. */
  redirectUrl: string | URL;
  clientMetadata: OAuthClientMetadata;
  tokenStore: McpOAuthTokenStore;
  /** Which vault rows this provider reads/writes. */
  tokenTarget: { provider: string; brokerCredentialId?: number };
  /**
   * Runtime leg: when set, `redirectToAuthorization` THROWS this message
   * instead of surfacing a URL — the SDK's re-auth path fails closed with
   * a re-auth prompt (no interactive flow mid-tool-call).
   */
  reauthMessage?: string;
  /** Connect leg: called with the authorization URL the SDK builds. */
  onRedirect?: (url: URL) => void;
  /** OAuth `state` (the flow token); the connect leg sets it. */
  state?: string;
  /** Callback leg: restores the minted flow's PKCE/client/discovery state. */
  restore?: PersistedOAuthFlow;
}

/**
 * The runtime's {@link OAuthClientProvider}: one class for the connect mint
 * leg, the callback exchange leg, and the runtime leg (differentiated by
 * {@link McpOAuthProviderOpts}). The SDK's `auth()` orchestration drives
 * discovery, dynamic client registration, PKCE, exchange, and refresh; this
 * class only supplies the contract's state + persistence.
 */
export class BottegaMcpOAuthProvider implements OAuthClientProvider {
  readonly #opts: McpOAuthProviderOpts;
  #codeVerifier: string | undefined;
  #clientInformation: OAuthClientInformationMixed | undefined;
  #discoveryState: OAuthDiscoveryState | undefined;
  #tokens: OAuthTokens | undefined;
  #savedBrokerCredentialId: number | undefined;

  constructor(opts: McpOAuthProviderOpts) {
    this.#opts = opts;
    this.#codeVerifier = opts.restore?.codeVerifier;
    this.#clientInformation = opts.restore?.clientInformation;
    this.#discoveryState = opts.restore?.discoveryState;
  }

  get redirectUrl(): string | URL {
    return this.#opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.#opts.clientMetadata;
  }

  // The mint leg sets the OAuth state (the flow token); other legs pass an
  // empty string, which the SDK's startAuthorization skips (`if (state)`).
  state(): string {
    return this.#opts.state ?? "";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.#clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.#clientInformation = clientInformation;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // A successful exchange/refresh (saveTokens) is authoritative for this
    // provider instance; otherwise read the vault row RAW (the refresh
    // token is real locally, redacted remotely).
    if (this.#tokens !== undefined) return this.#tokens;
    const { brokerCredentialId } = this.#opts.tokenTarget;
    if (brokerCredentialId === undefined) return undefined;
    const credential = await this.#opts.tokenStore.load(this.#opts.tokenTarget.provider, brokerCredentialId);
    return credential !== null ? vaultCredentialToTokens(credential) : undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.#tokens = tokens;
    const previous =
      this.#opts.tokenTarget.brokerCredentialId === undefined
        ? null
        : await this.#opts.tokenStore
            .load(this.#opts.tokenTarget.provider, this.#opts.tokenTarget.brokerCredentialId)
            .catch(() => null);
    const saved = await this.#opts.tokenStore.save(
      this.#opts.tokenTarget.provider,
      tokensToVaultCredential(tokens, previous, this.#clientInformation),
    );
    this.#opts.tokenTarget.brokerCredentialId = saved.brokerCredentialId;
    this.#savedBrokerCredentialId = saved.brokerCredentialId;
  }

  /** The vault row id the last save produced (the callback's registry upsert). */
  get savedBrokerCredentialId(): number | undefined {
    return this.#savedBrokerCredentialId;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.#opts.reauthMessage !== undefined) throw new Error(this.#opts.reauthMessage);
    this.#opts.onRedirect?.(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    return this.#codeVerifier ?? "";
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discoveryState = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discoveryState;
  }

  // Never auto-delete vault rows: an invalid grant surfaces as the SDK's
  // re-auth path (which fails closed with the re-auth prompt) — a
  // credential the user connected must not vanish silently.
  invalidateCredentials(): void {}
}

/**
 * The OAuth client metadata bottega registers for every hosted MCP flow.
 * Issue #257: `tokenEndpointAuthMethod` is the CONNECT-negotiated
 * `token_endpoint_auth_method` — "none" for public-capable AS (the exact
 * pre-#257 behavior), `client_secret_basic`/`client_secret_post` for
 * confidential-capable ones, so DCR issues a client secret where the
 * authorization server requires confidential client auth.
 */
function clientMetadataFor(
  redirectUri: string,
  scopes: readonly string[] | undefined,
  tokenEndpointAuthMethod: string = "none",
): OAuthClientMetadata {
  const metadata: OAuthClientMetadata = {
    client_name: "bottega",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    grant_types: ["authorization_code", "refresh_token"],
  };
  if (scopes !== undefined && scopes.length > 0) metadata.scope = scopes.join(" ");
  return metadata;
}

export interface McpOAuthStartInput {
  extension: string;
  provider: string;
  label: string;
  scope: ConnectScope;
  actor: string;
  spaceId?: string;
}

export type McpOAuthStartResult = { ok: true; authorizationUrl: string; message: string } | { ok: false; message: string };

export interface McpOAuthFlowDeps {
  store: OAuthFlowStoreSlice & Pick<Store, "upsertExtensionCredential">;
  /** Redacting audit wrapper (src/policy/audit.ts). */
  audit: AuditModule;
  /** The PUBLIC callback base URL, resolved lazily per mint (issue #249): the durable store data/public-base-url, else BOTTEGA_OAUTH_CALLBACK_BASE_URL, else the loopback server. */
  callbackBaseUrl: () => string;
  /** Token persistence; defaults to the production vault store. */
  tokenStore?: McpOAuthTokenStore;
  /** Flow lifetime in ms (default {@link MCP_OAUTH_FLOW_TTL_MS}). */
  flowTtlMs?: number;
  /** Max live flows per actor (default {@link MCP_OAUTH_MAX_OUTSTANDING_PER_ACTOR}). */
  maxOutstandingPerActor?: number;
}

/** The connect seam: mints a hosted-MCP OAuth flow and returns the authorization URL. */
export interface McpOAuthConnector {
  start(input: McpOAuthStartInput): Promise<McpOAuthStartResult>;
}

/** Production connect seam (the server's default): {@link startMcpOAuthFlow}. */
export function createMcpOAuthConnector(deps: McpOAuthFlowDeps & { registry: Pick<ExtensionRegistry, "resolve"> }): McpOAuthConnector {
  return { start: (input) => startMcpOAuthFlow(input, deps) };
}

/**
 * The connect's negotiated server contract (issue #256 + issue #257):
 * SEP-835 resolves the OAuth scope as: auth() `scope` option → WWW-Authenticate
 * scope → the resource's advertised `scopes_supported` → client metadata
 * `scope`. The resource advertisement lists only the RESOURCE's own scopes
 * (the hosted MCP advertises e.g. "default") — it NEVER lists the OIDC
 * "offline_access" scope, without which the authorization server issues
 * NO refresh token, and every later proxy mint fails with "oauth_token
 * failed to mint". So the mint decides on the AUTHORIZATION SERVER's grant
 * signal: when it advertises the `refresh_token` grant, append
 * `offline_access` to the requested scope (the DCR registration request
 * and the authorization URL both carry it); otherwise keep the SDK's
 * resolution untouched (e.g. client-credentials servers have no consent).
 *
 * Issue #257 additionally negotiates the TOKEN-ENDPOINT AUTH METHOD from
 * `token_endpoint_auth_methods_supported`: prefer `client_secret_basic`
 * (RFC 6749 §2.3.1), fall back to `client_secret_post` (§2.3.1 alt), else
 * "none" (public — exactly the pre-#257 behavior). The negotiated method
 * flows into the DCR metadata, so confidential-capable AS issue a
 * client_secret and every later refresh re-sends it per the persisted
 * method.
 *
 * This costs an extra discovery round trip on the connect path (not hot);
 * in exchange no provider/state plumbing is needed and every server that
 * supports refreshable grants gets a token that can actually be refreshed.
 */
async function connectServerNegotiation(
  serverUrl: string,
  clientScopes: readonly string[] | undefined,
): Promise<{ scope: string | undefined; tokenEndpointAuthMethod: string }> {
  let info: OAuthServerInfo;
  try {
    info = await discoverOAuthServerInfo(serverUrl);
  } catch {
    // auth() below re-discovers and surfaces its own failure message (the
    // connect already fails closed there); don't double-fail here.
    return { scope: undefined, tokenEndpointAuthMethod: "none" };
  }
  const supportedMethods = info.authorizationServerMetadata?.token_endpoint_auth_methods_supported;
  const supports = (method: string) => supportedMethods?.includes(method) === true;
  const tokenEndpointAuthMethod = supports("client_secret_basic")
    ? "client_secret_basic"
    : supports("client_secret_post")
      ? "client_secret_post"
      : "none";
  const grantsRefresh =
    info.authorizationServerMetadata?.grant_types_supported?.includes("refresh_token") === true;
  if (!grantsRefresh) return { scope: undefined, tokenEndpointAuthMethod };
  const base = info.resourceMetadata?.scopes_supported?.join(" ") ?? clientScopes?.join(" ");
  const scope = base === undefined || base === "" ? "offline_access" : `${base} offline_access`;
  return { scope, tokenEndpointAuthMethod };
}

/**
 * The connect mint (issue #198): runs the SDK's `auth()` orchestration in
 * REDIRECT mode against the extension's hosted MCP server — discovery,
 * dynamic client registration, PKCE challenge — and persists the flow so
 * the callback can complete it. Returns the authorization URL for Slack
 * (the one-time-link posture; the URL is shown, the token never touches
 * chat). Fail closed: a non-hosted-OAuth extension, missing metadata, or a
 * failed flow start are clear errors with no flow row written. When the
 * server advertises the `refresh_token` grant, the requested scope carries
 * `offline_access` so the issued grant is refreshable (issue #256).
 */
export async function startMcpOAuthFlow(
  input: McpOAuthStartInput,
  deps: McpOAuthFlowDeps & { registry: Pick<ExtensionRegistry, "resolve"> },
): Promise<McpOAuthStartResult> {
  const resolved = deps.registry.resolve(input.extension);
  if (!resolved) {
    return { ok: false, message: `unknown extension "${input.extension}" — register it before connecting` };
  }
  const manifest = resolved.manifest;
  if (manifest.kind !== "mcp" || manifest.mcp.transport !== "streamable-http" || manifest.credentialSchema.type !== "oauth") {
    return {
      ok: false,
      message: `${manifest.label} is not a hosted OAuth MCP — connect it through the broker instead`,
    };
  }
  const serverUrl = manifest.mcp.serverUrl;
  const redirectUri = `${deps.callbackBaseUrl()}/oauth/callback`;
  const token = randomBytes(18).toString("base64url"); // the OAuth state: opaque, single-use
  // Issue #256/#257: negotiate the server contract ONCE before the mint —
  // the requested scope (offline_access when the AS grants refresh) + the
  // token-endpoint auth method (client_secret_basic/post for confidential
  // AS). auth()'s own discovery succeeds from the SAME metadata, so this
  // is one extra round trip on the connect path, not a divergence.
  const negotiation = await connectServerNegotiation(serverUrl, manifest.credentialSchema.scopes);
  let authorizationUrl: URL | undefined;
  const provider = new BottegaMcpOAuthProvider({
    redirectUrl: redirectUri,
    clientMetadata: clientMetadataFor(redirectUri, manifest.credentialSchema.scopes, negotiation.tokenEndpointAuthMethod),
    tokenStore: deps.tokenStore ?? createVaultTokenStore(),
    tokenTarget: { provider: manifest.id },
    state: token,
    onRedirect: (url) => {
      authorizationUrl = url;
    },
  });
  let result: AuthResult;
  try {
    result = await auth(provider, { serverUrl, ...(negotiation.scope !== undefined ? { scope: negotiation.scope } : {}) });
  } catch (err) {
    return { ok: false, message: `connect ${manifest.label} failed: ${errorMessage(err)}` };
  }
  if (result !== "REDIRECT" || authorizationUrl === undefined) {
    return {
      ok: false,
      message: `connect ${manifest.label} failed: the OAuth server did not start an authorization flow`,
    };
  }
  const flow: PersistedOAuthFlow = {
    codeVerifier: provider.codeVerifier(),
    clientInformation: provider.clientInformation(),
    discoveryState: provider.discoveryState(),
    tokenEndpointAuthMethod: negotiation.tokenEndpointAuthMethod,
    authorizationUrl: authorizationUrl.toString(),
  };
  const flowStore = new OAuthFlowStore(deps.store, {
    ttlMs: deps.flowTtlMs,
    maxOutstandingPerActor: deps.maxOutstandingPerActor,
  });
  const minted = flowStore.mint({
    token,
    provider: manifest.id,
    scope: input.scope,
    actor: input.actor,
    spaceId: input.spaceId,
    label: manifest.label,
    serverUrl,
    redirectUri,
    flow: JSON.stringify(flow),
    ttlMs: deps.flowTtlMs,
  });
  if (!minted.ok) return { ok: false, message: minted.reason };
  return {
    ok: true,
    authorizationUrl: authorizationUrl.toString(),
    message:
      `Open this link to authorize ${manifest.label}: ${authorizationUrl} — ` +
      `after you authorize in the browser, ${manifest.label} is connected.`,
  };
}

/**
 * The callback completion (issue #198): consumes the flow row (single-use,
 * TTL — fail closed on anything else), restores the minted provider (PKCE
 * verifier, registered client info, discovery state — so the exchange is
 * cryptographically bound to the SAME flow), runs the SDK's exchange, and
 * stores the token in the vault via the existing upload path. Then the
 * credential lands in the registry through the SAME ladder shape as every
 * connect: upsertExtensionCredential (metadata only, scope me/org) + the
 * `extension.connected` audit row. No broker provider registration — the
 * broker is only the vault the token lands in.
 */
export async function completeMcpOAuthFlow(
  flowRow: { provider: string; scope: ConnectScope; actor: string; space_id: string | null; label: string; server_url: string; redirect_uri: string; flow: string },
  code: string,
  deps: {
    store: Pick<Store, "consumeOAuthFlow" | "upsertExtensionCredential">;
    audit: AuditModule;
    tokenStore?: McpOAuthTokenStore;
    /**
     * Connect-time egress reconcile (issue #250): called after the vault
     * row + credential + audit land, so a successful connect immediately
     * regenerates egress with the superset and seeds the provider's proxy
     * OAuth blob (never boot-only, never clobbered). Best-effort: any
     * warnings fold into the result — the connect stays successful.
     */
    reconcileEgress?: (provider: string) => Promise<{ warnings: string[] }>;
  },
): Promise<{ brokerCredentialId: number; warnings: string[] }> {
  let persisted: PersistedOAuthFlow;
  try {
    // SAFETY: the JSON round-trip degrades the SDK's URL-typed fields to strings;
    // the exchange only reads client_id/client_secret + the separately
    // restored codeVerifier/redirectUri, so this cast is the documented
    // contract (JSON.parse of what JSON.stringify wrote in startMcpOAuthFlow).
    persisted = JSON.parse(flowRow.flow) as PersistedOAuthFlow;
  } catch {
    throw new Error(`connect ${flowRow.label} failed: the pending flow is malformed — re-run connect`);
  }
  // Issue #257: some real DCR responses omit `token_endpoint_auth_method`
  // even though the registration requested one (RFC 7591 servers may not
  // echo every field). Restore the connect-negotiated method — it is
  // authoritative, and it is what makes the vault row's confidential
  // identity self-describing for the runtime.
  if (persisted.tokenEndpointAuthMethod !== undefined) {
    // Cast: the SDK union arms don't all carry token_endpoint_auth_method,
    // but a freshly JSON.parse'd object is safe to mutate and the runtime
    // restores the method from the SAME union (issue #257).
    const restoredClient = persisted.clientInformation as
      | (OAuthClientInformationMixed & { token_endpoint_auth_method?: string })
      | undefined;
    if (restoredClient !== undefined && restoredClient.token_endpoint_auth_method === undefined) {
      // Fresh object from JSON.parse — mutating it never touches the row.
      restoredClient.token_endpoint_auth_method = persisted.tokenEndpointAuthMethod;
    }
  }
  const provider = new BottegaMcpOAuthProvider({
    redirectUrl: flowRow.redirect_uri,
    clientMetadata: clientMetadataFor(flowRow.redirect_uri, undefined, persisted.tokenEndpointAuthMethod),
    tokenStore: deps.tokenStore ?? createVaultTokenStore(),
    tokenTarget: { provider: flowRow.provider },
    restore: persisted,
  });
  let result: AuthResult;
  try {
    result = await auth(provider, { serverUrl: flowRow.server_url, authorizationCode: code });
  } catch (err) {
    throw new Error(`connect ${flowRow.label} failed: the authorization exchange was rejected (${errorMessage(err)})`);
  }
  if (result !== "AUTHORIZED") {
    throw new Error(`connect ${flowRow.label} failed: the authorization exchange did not complete`);
  }
  if (provider.savedBrokerCredentialId === undefined) {
    throw new Error(`connect ${flowRow.label} failed: the vault recorded no OAuth credential`);
  }
  // Issue #257: connect-time mint probe — ONE refresh_token round-trip
  // right after the exchange persisted the vault row. A credential whose
  // refresh grant the server immediately rejects (revoked, mis-issued, a
  // confidential client that dropped its secret) would otherwise connect
  // successfully only to fail closed silently on every later call. The
  // probe reuses the SAME provider (cached discovery + client info + the
  // just-exchanged tokens), so it costs a single HTTP round trip and the
  // probe itself rotates the row to its latest token.
  let probe: AuthResult;
  try {
    probe = await auth(provider, { serverUrl: flowRow.server_url });
  } catch (err) {
    throw new Error(
      `connect ${flowRow.label} failed: the authorization exchange was rejected (${errorMessage(err)}) — ` +
        `the returned refresh token cannot mint an access token`,
    );
  }
  if (probe !== "AUTHORIZED") {
    throw new Error(
      `connect ${flowRow.label} failed: the authorization exchange was rejected — the returned refresh token cannot mint an access token`,
    );
  }
  // The probe's refresh may have rotated the vault row again; the registry
  // reference must point at the POST-probe row (the same identity-key vault
  // row in production).
  const brokerCredentialId = provider.savedBrokerCredentialId as number;
  const owner = flowRow.scope === "personal" ? flowRow.actor : null;
  await deps.store.upsertExtensionCredential({
    provider: flowRow.provider,
    identityKey: oauthIdentityKey(flowRow.provider, flowRow.scope, owner),
    owner,
    scope: flowRow.scope,
    brokerCredentialId,
  });
  await deps.audit.appendAudit({
    space_id: flowRow.space_id,
    actor: flowRow.actor,
    event_type: EXTENSION_CONNECTED_EVENT,
    payload: { extension: flowRow.provider, scope: flowRow.scope, owner },
  });
  // Issue #250: reconcile the egress proxy plane now — regenerate egress
  // from the superset (committed pins ∪ runtime rows) and seed this
  // provider's proxy OAuth blob + reload. Best-effort and guarded: the
  // connect already landed, so a reconcile failure is receivable, never
  // fatal.
  let warnings: string[] = [];
  if (deps.reconcileEgress !== undefined) {
    try {
      const result = await deps.reconcileEgress(flowRow.provider);
      warnings = result.warnings;
    } catch (err) {
      warnings = [`connect ${flowRow.label} failed to reconcile egress: ${errorMessage(err)}`];
    }
  }
  return { brokerCredentialId, warnings };
}

export interface RuntimeMcpOAuthOpts {
  /** The ladder's resolved registry row (provider + brokerCredentialId). */
  credential: ExtensionCredential;
  /** Token persistence; defaults to the production vault store. */
  tokenStore?: McpOAuthTokenStore;
}

/**
 * Vault OAuth credential → the per-user registered client identity (issue
 * #257): restores `client_id`/`client_secret`/`token_endpoint_auth_method`
 * from the vault row so the SDK treats the client as ALREADY registered
 * (no re-DCR per call) and sends confidential credentials per the persisted
 * method. Returns undefined for rows without a client_id (pre-#250 →
 * runtime DCR as today; public clients → "none", preserved). A cast is
 * used because the SDK union types are exact Zod-object shapes that never
 * admit the extra fields the runtime object carries.
 */
function vaultCredentialClientInformation(credential: VaultOAuthCredential): OAuthClientInformationMixed | undefined {
  const { client_id, client_secret, token_endpoint_auth_method } = credential;
  if (client_id === undefined || client_id === "") return undefined;
  const info: Record<string, string> = { client_id };
  if (client_secret !== undefined && client_secret !== "") info.client_secret = client_secret;
  if (token_endpoint_auth_method !== undefined && token_endpoint_auth_method !== "") {
    info.token_endpoint_auth_method = token_endpoint_auth_method;
  }
  // `unknown`: the SDK union arms are exact Zod-object shapes — the runtime
  // object is a structural subset, never a full arm, so no arm overlaps.
  return info as unknown as OAuthClientInformationMixed;
}

/**
 * The RUNTIME leg's provider: loads the vault credential raw, hands the
 * SDK the tokens (real refresh token locally → the SDK refreshes on 401 and
 * `saveTokens` rotates the vault row; the broker's sentinel is dropped →
 * expiry falls to the re-auth prompt, fail closed). `redirectToAuthorization`
 * throws the re-auth prompt — the SDK's interactive path can never run
 * mid-tool-call.
 *
 * Issue #257: ASYNC — it eagerly loads the vault row's client identity
 * (`client_id`/`client_secret`/`token_endpoint_auth_method`) and restores
 * it on the provider, so confidential-capable AS get their secret on every
 * mint (per the persisted method) with no per-call re-DCR, and rotation
 * write-backs preserve the identity. One extra vault read per call-mint is
 * the price of confidential fidelity; pre-#250 rows (no client_id) fall
 * back to runtime DCR exactly as before.
 */
export async function createRuntimeMcpOAuthProvider(input: RuntimeMcpOAuthOpts): Promise<OAuthClientProvider> {
  const { provider } = input.credential;
  const tokenStore = input.tokenStore ?? createVaultTokenStore();
  const providerInstance = new BottegaMcpOAuthProvider({
    // Placeholder: the runtime leg never surfaces an authorization URL —
    // redirectToAuthorization throws first. The SDK requires a redirectUrl
    // for the authorization_code flow, so a non-interactive one is given.
    redirectUrl: "http://127.0.0.1/oauth/callback",
    clientMetadata: clientMetadataFor("http://127.0.0.1/oauth/callback", undefined),
    tokenStore,
    tokenTarget: { provider, brokerCredentialId: input.credential.broker_credential_id },
    reauthMessage:
      `the ${provider} OAuth session has expired or was revoked — ` +
      `re-run "connect ${provider} as me" (or "as org") to re-authorize`,
  });
  const credential = await tokenStore.load(provider, input.credential.broker_credential_id);
  if (credential !== null) {
    const clientInformation = vaultCredentialClientInformation(credential as VaultOAuthCredential);
    if (clientInformation !== undefined) providerInstance.saveClientInformation(clientInformation);
  }
  return providerInstance;
}
