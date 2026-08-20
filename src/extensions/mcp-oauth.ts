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
import { createStaticOAuthClientStore, type StaticOAuthClient, type StaticOAuthClientStore } from "./static-oauth-client";
import type { ExtensionRegistry } from "./registry";
import type { ReconcileEgress } from "./egress-reconcile";

/** Default flow lifetime: short by design — 15 minutes, like upload links. */
export const MCP_OAUTH_FLOW_TTL_MS = 15 * 60_000;
/** Per-actor cap on live (unexpired) flows — the mint path's rate limit. */
export const MCP_OAUTH_MAX_OUTSTANDING_PER_ACTOR = 5;

/**
 * A vault OAuth credential carrying the per-user registered client
 * identity (issue #250): the dynamic-client-registration flow persists
 * `client_information` (`client_id`/`client_secret`) into the vault row,
 * so the SDK's refresh grant can mint for the USER's client rather than a
 * shared deployment client. The SDK type omits these fields (the SDK
 * never reads them back), but extra JSON survives the vault round-trip.
 */
export interface VaultOAuthCredential extends OAuthCredential {
  /**
   * Whether the credential's grant is refreshable (decision B, issue #265).
   * Explicitly `false` when the exchange returned an access-only token (no
   * refresh anywhere — e.g. Notion's AS caps grants at ~1h access tokens):
   * the row is still persisted so the connect succeeds, but there is no
   * refresh to mint from and expiry surfaces the re-connect prompt.
   * Refresh-bearing rows carry `true`; pre-#265 rows omit it (treated as
   * refreshable by presence of `refresh`).
   */
  refreshable?: boolean;
  client_id?: string;
  client_secret?: string;
  /**
   * The persisted token-endpoint auth method (issue #257): whichever
   * `token_endpoint_auth_method` the connect negotiated at registration
   * (`client_secret_basic` / `client_secret_post`, or "none" for public
   * clients). Rides the vault round-trip like `client_secret` so the
   * runtime re-sends confidential credentials per the persisted method.
   */
  token_endpoint_auth_method?: string;
}

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
 * is NEVER written as an empty-refresh row.
 *
 * Decision B (issue #265): instead of failing the save closed (the #256/
 * #263 posture), an access-only outcome — no refresh from the exchange AND
 * no previous row holding one — is persisted as a NON-RENEWABLE credential:
 * `refreshable: false`, no `refresh` field, `expires` from `expires_in`.
 * This accepts servers whose AS caps grants at ~1h access tokens (Notion's
 * measured behavior) so the connect succeeds; the credential serves for the
 * access token's lifetime and expiry surfaces the re-connect prompt.
 *
 * The per-user registered client identity (issue #250) rides along: the
 * DCR `client_information` (`client_id`/`client_secret`) is per-user vault
 * data, not a deployment env constant, so `tokensToVaultCredential`
 * persists it (fresh DCR first, the previous row's identity as the
 * refresh-round-trip carry-forward) and the runtime re-sends it on every
 * mint. Empty/undefined fields are stripped.
 */
export function tokensToVaultCredential(
  tokens: OAuthTokens,
  previous: OAuthCredential | null,
  clientInformation?: { client_id?: string; client_secret?: string; token_endpoint_auth_method?: string },
): VaultOAuthCredential {
  // A genuine new refresh wins; otherwise the previous row's refresh is
  // carried forward (non-rotating servers). Neither present → the grant
  // cannot be refreshed at all: persist a NON-RENEWABLE access-only
  // credential (decision B) — never an empty-refresh row, and never a
  // silent connect failure for servers that cap grants at access tokens.
  const refresh = tokens.refresh_token && tokens.refresh_token !== "" ? tokens.refresh_token : previous?.refresh;
  if (refresh === undefined || refresh === "") {
    const credential: VaultOAuthCredential = {
      type: "oauth",
      // The row shape requires a `refresh` field; an EMPTY value marks "no
      // refresh" — `vaultCredentialToTokens` drops it (the SDK never POSTs
      // it) and the runtime treats the credential as non-renewable
      // (decision B): expiry surfaces the re-connect prompt instead of a
      // mint. The `refreshable: false` marker makes the non-renewability
      // explicit.
      refresh: "",
      access: tokens.access_token,
      expires: tokens.expires_in !== undefined && tokens.expires_in > 0 ? Date.now() + tokens.expires_in * 1000 : 0,
      refreshable: false,
    };
    const carried = previous as VaultOAuthCredential | null;
    const clientId = clientInformation?.client_id ?? carried?.client_id;
    const clientSecret = clientInformation?.client_secret ?? carried?.client_secret;
    const clientAuthMethod = clientInformation?.token_endpoint_auth_method ?? carried?.token_endpoint_auth_method;
    if (clientId !== undefined && clientId !== "") credential.client_id = clientId;
    if (clientSecret !== undefined && clientSecret !== "") credential.client_secret = clientSecret;
    if (clientAuthMethod !== undefined && clientAuthMethod !== "") credential.token_endpoint_auth_method = clientAuthMethod;
    return credential;
  }
  const credential: VaultOAuthCredential = {
    type: "oauth",
    access: tokens.access_token,
    refresh,
    refreshable: true,
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
  #savedRefreshable = false;

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
    // Issue #262 instrumentation: whether the exchange/refresh response
    // carried a refresh_token — end-to-end evidence for the next live connect.
    // OFF by default (DEBUG is the ambient Node convention, no new env flags).
    if (process.env.DEBUG !== undefined) {
      console.debug(
        `[mcp-oauth] saveTokens provider=${this.#opts.tokenTarget.provider} refresh_token=${tokens.refresh_token ? "present" : "absent"}`,
      );
    }
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
    // Decision B (issue #265): the exchange/refresh's refreshability —
    // whether the persisted credential carries a refresh grant. The
    // callback leg consults it to decide whether the connect-time mint
    // probe must run: a non-renewable access-only credential (Notion's AS
    // caps grants at ~1h access tokens) has nothing to probe, and running
    // the probe would fail the connect ("the returned refresh token cannot
    // mint an access token") on a grant that is fine for its lifetime.
    this.#savedRefreshable =
      (tokens.refresh_token !== undefined && tokens.refresh_token !== "") ||
      (previous?.refresh !== undefined && previous.refresh !== "");
  }

  /** The vault row id the last save produced (the callback's registry upsert). */
  get savedBrokerCredentialId(): number | undefined {
    return this.#savedBrokerCredentialId;
  }

  /** Whether the last save persisted a refresh-bearing (renewable) grant. */
  get savedRefreshable(): boolean {
    return this.#savedRefreshable;
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
  /**
   * The static-client vault seam (issue #288): consulted ONLY when the
   * connect's negotiation discovers an authorization server WITHOUT a
   * usable dynamic-registration endpoint. Defaults to the production
   * store over the broker's opaque api-key vault rows.
   */
  staticClientStore?: StaticOAuthClientStore;
  /** Flow lifetime in ms (default {@link MCP_OAUTH_FLOW_TTL_MS}). */
  flowTtlMs?: number;
  /** Max live flows per actor (default {@link MCP_OAUTH_MAX_OUTSTANDING_PER_ACTOR}). */
  maxOutstandingPerActor?: number;
}

/** The connect seam: mints a hosted-MCP OAuth flow and returns the authorization URL. */
export interface McpOAuthConnector {
  start(input: McpOAuthStartInput): Promise<McpOAuthStartResult>;
  /**
   * Base-liveness probe (issue #271): verifies the PUBLIC callback base the
   * authorize URL's redirect_uri embeds (deps.callbackBaseUrl) is reachable
   * BEFORE a flow mints — fail closed: a dead tunnel/base refuses the
   * connect with the base named, never a dead authorize link.
   */
  probeCallbackBase(): Promise<McpOAuthBaseProbeResult>;
}

/** Issue #271 base-liveness verdict: the probed base + ok + failure evidence. */
export interface McpOAuthBaseProbeResult {
  ok: boolean;
  /** The public callback base that was probed (the redirect_uri base). */
  base?: string;
  /** Failure evidence (HTTP status / transport error) when !ok. */
  message?: string;
}

/** How long the callback-base liveness probe may take before the base is treated as dead (issue #271). */
export const MCP_OAUTH_BASE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Issue #271 liveness probe: any non-5xx HTTP response answers "live" — the
 * callback surface 404s unknown paths (a bare GET on the base), so a
 * 2xx/3xx/4xx proves the tunnel forwards to the listener; a 5xx
 * (Cloudflare 502/530, nginx 502) or a transport failure (DNS, refused,
 * timeout) proves the base is dead and any minted authorize URL would die
 * in the browser.
 */
export async function probeCallbackBaseLive(
  base: string,
  timeoutMs = MCP_OAUTH_BASE_PROBE_TIMEOUT_MS,
): Promise<McpOAuthBaseProbeResult> {
  try {
    const res = await fetch(base, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500
      ? { ok: true, base }
      : { ok: false, base, message: `GET ${base} -> HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, base, message: `GET ${base} failed: ${errorMessage(err)}` };
  }
}

/** Production connect seam (the server's default): {@link startMcpOAuthFlow}. */
export function createMcpOAuthConnector(deps: McpOAuthFlowDeps & { registry: Pick<ExtensionRegistry, "resolve"> }): McpOAuthConnector {
  return {
    start: (input) => startMcpOAuthFlow(input, deps),
    probeCallbackBase: () => probeCallbackBaseLive(deps.callbackBaseUrl()),
  };
}

/**
 * Value masking for the DEBUG token-endpoint capture (issue #263): token
 * values are never echoed to the log. Short values (≤8 chars) become the
 * literal `<masked>` marker; longer ones are truncated to their first 8
 * characters plus an ellipsis — enough to identify the field, never enough
 * to replay the token.
 */
function maskedTokenValue(value: string): string {
  return value.length <= 8 ? "<masked>" : `${value.slice(0, 8)}…`;
}

/**
 * Masks `access_token`/`refresh_token`/`id_token`/`client_secret` string
 * values inside a JSON-ish response body. Only the four token keys are
 * touched — every other field (scope, expires_in, the error shape) passes
 * through verbatim so the raw response is still inspectable.
 */
function maskTokenFields(body: string): string {
  return body.replace(
    /("(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*")([^"]*)(")/g,
    (_whole, pre: string, value: string, post: string) => `${pre}${maskedTokenValue(value)}${post}`,
  );
}

/**
 * Issue #263 RAW token-endpoint response capture — DEBUG-gated (issue #257
 * lens: every OAuth MCP integration shares this connect surface). When
 * `process.env.DEBUG` is set, the returned wrapper logs any request whose
 * URL path contains "/token": the date, request method, URL, response
 * status, and the response body with token values masked. Use for the
 * connect legs' `auth()` calls (the mint covers discovery/register/
 * authorize; the callback covers the code exchange + probe) so a LIVE
 * access-only exchange can be classified on the wire.
 *
 * OFF by default — DEBUG is the ambient Node convention, no new env flags.
 * The log is read from `res.clone()` and the ORIGINAL Response is handed
 * back untouched: the SDK conventionally consumes a Response body exactly
 * once, and capture must never disturb the real flow (or fail it).
 */
export function debugTokenExchangeFetch(): { fetchFn?: typeof fetch } {
  if (process.env.DEBUG === undefined) return {};
  // Cast: the ordinary arrow function below intentionally lacks Bun's
  // augmented `preconnect` member; its call signature is `typeof fetch`.
  const wrapped = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlText =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (err) {
      console.debug(`[mcp-oauth] token exchange ${init?.method ?? "GET"} ${urlText} failed: ${errorMessage(err)}`);
      throw err;
    }
    try {
      if (new URL(urlText).pathname.includes("/token")) {
        const clone = response.clone();
        const body = await clone.text();
        console.debug(
          `[mcp-oauth] token exchange ${new Date().toISOString()} ${init?.method ?? "GET"} ${urlText} -> ${response.status} ${maskTokenFields(body)}`,
        );
      }
    } catch {
      // Capture must never break the connect; the exchange response is untouched.
    }
    return response;
  }) as unknown as typeof fetch;
  return { fetchFn: wrapped };
}

/**
 * Whether the authorization server's advertised dynamic-registration
 * endpoint is USABLE (issue #288): present, a parseable absolute http(s)
 * URL, and not plain-http on a NON-loopback host (RFC 7591 requires TLS —
 * a remote registration endpoint over the wire would expose the client
 * metadata; fail closed to the static-client path). Loopback http is the
 * hermetic-test / local-dev posture, unchanged. Anything else is NOT
 * usable → the connect requires a provisioned static client.
 */
function registrationEndpointUsable(registrationEndpoint: unknown): boolean {
  if (typeof registrationEndpoint !== "string" || registrationEndpoint === "") return false;
  let url: URL;
  try {
    url = new URL(registrationEndpoint);
  } catch {
    return false; // malformed → unusable (fail closed)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) return false;
  return true;
}

/** Loopback hostnames (the http-allowed set for registration endpoints). */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/**
 * The connect's negotiated server contract (issue #256 + issue #257 +
 * issue #262): SEP-835 resolves the OAuth scope as: auth() `scope` option →
 * WWW-Authenticate scope → the resource's advertised `scopes_supported` →
 * client metadata `scope`. The resource advertisement lists only the
 * RESOURCE's own scopes (the hosted MCP advertises e.g. "default") — it
 * NEVER lists the OIDC "offline_access" scope, without which the
 * authorization server issues NO refresh token, and the grant cannot be
 * refreshed (the SDK's runtime mint fails closed at expiry). So the mint
 * decides on the AUTHORIZATION SERVER's grant signal: when it advertises
 * the `refresh_token` grant, append `offline_access` to the requested scope
 * (the DCR registration request and the authorization URL both carry it);
 * otherwise keep the SDK's resolution untouched (e.g. client-credentials
 * servers have no consent).
 *
 * Issue #257 additionally negotiates the TOKEN-ENDPOINT AUTH METHOD from
 * `token_endpoint_auth_methods_supported`: prefer `client_secret_basic`
 * (RFC 6749 §2.3.1), fall back to `client_secret_post` (§2.3.1 alt), else
 * "none" (public — exactly the pre-#257 behavior). The negotiated method
 * flows into the DCR metadata, so confidential-capable AS issue a
 * client_secret and every later refresh re-sends it per the persisted
 * method.
 *
 * Issue #262 makes the scope BASE placeholder-aware. Notion MCP advertises
 * `scopes_supported: ["default"]` — a PLACEHOLDER that is not a real
 * authorizable scope. Stacking `offline_access` onto it
 * ("default offline_access") made the AS issue an access-only token (no
 * refresh), failing the connect closed at the exchange. So a placeholder or
 * absent resource scope is discarded, and the extension's REAL manifest
 * scopes (credentialSchema.scopes) win; only when no real base exists at
 * all is `offline_access` requested alone. A transient discovery failure
 * that would silently degrade a refresh-advertising server to a
 * non-refreshable grant is logged loudly instead (never silent).
 *
 * Issue #288 adds the DYNAMIC-REGISTRATION verdict: `dynamicRegistration`
 * is true exactly when the authorization server advertises a usable
 * registration endpoint (see {@link registrationEndpointUsable}). A
 * no-DCR server (the Gmail class) makes the connect consult the
 * provisioned static client instead. A transient discovery failure keeps
 * the pre-#288 posture (proceed; auth() re-discovers and fails closed
 * there) and is treated as DCR-capable — a healthy DCR server must not be
 * refused because the first probe hiccuped.
 *
 * This costs an extra discovery round trip on the connect path (not hot);
 * in exchange no provider/state plumbing is needed and every server that
 * supports refreshable grants gets a token that can actually be refreshed.
 */
async function connectServerNegotiation(
  serverUrl: string,
  clientScopes: readonly string[] | undefined,
): Promise<{ scope: string | undefined; tokenEndpointAuthMethod: string; dynamicRegistration: boolean }> {
  let info: OAuthServerInfo;
  try {
    info = await discoverOAuthServerInfo(serverUrl);
  } catch (err) {
    // Issue #262 (no-silent-degradation): a refresh-advertising server that
    // TRANSIENTLY fails this pre-negotiation discovery must not silently
    // degrade to a non-refreshable grant request + public-client auth —
    // exactly the invariant #256/#257 protect. Log the cause loudly; still
    // proceed non-blocking, because auth() re-discovers and fails closed
    // there with a clear connect error if the server is truly unreachable.
    console.error(
      `[mcp-oauth] connect negotiation discovery failed for ${serverUrl}: ${errorMessage(err)} — ` +
        "proceeding without offline_access and without a negotiated token-endpoint auth method; " +
        "the connect will fail closed in auth() if the server is unreachable",
    );
    // Issue #288: unknown DCR capability is treated as DCR-capable — the
    // SDK's re-discovery is the authoritative check, and a genuinely
    // no-DCR server fails closed there with the SDK's own error. A healthy
    // DCR server must never be refused over a transient first probe.
    return { scope: undefined, tokenEndpointAuthMethod: "none", dynamicRegistration: true };
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
  const dynamicRegistration = registrationEndpointUsable(info.authorizationServerMetadata?.registration_endpoint);
  if (!grantsRefresh) return { scope: undefined, tokenEndpointAuthMethod, dynamicRegistration };
  // Issue #262: choose the scope BASE without ever building it out of the
  // "default" placeholder Notion (and similar AS) advertise in
  // `scopes_supported`. A placeholder/absent resource scope is discarded in
  // favor of the extension's REAL manifest scopes; only when no real base
  // exists is `offline_access` requested ALONE.
  const resourceScopes = info.resourceMetadata?.scopes_supported;
  const isPlaceholderScope =
    resourceScopes === undefined ||
    resourceScopes.length === 0 ||
    (resourceScopes.length === 1 && resourceScopes[0] === "default");
  const base =
    (resourceScopes !== undefined && !isPlaceholderScope
      ? resourceScopes.join(" ")
      : undefined) ??
    (clientScopes !== undefined && clientScopes.length > 0 ? clientScopes.join(" ") : undefined);
  const scope = base === undefined || base === "" ? "offline_access" : `${base} offline_access`;
  return { scope, tokenEndpointAuthMethod, dynamicRegistration };
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
  // Issue #262 instrumentation: when DEBUG is set, emit the composed authorize
  // scope + server for end-to-end connect evidence on the next live run. OFF
  // by default — no new env flags (DEBUG is the ambient Node convention).
  if (process.env.DEBUG !== undefined) {
    console.debug(`[mcp-oauth] connect ${manifest.id}: composed authorize scope=${negotiation.scope ?? "<none>"} server=${serverUrl}`);
  }
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
  // Issue #288: a NO-DCR authorization server (the Gmail class — OAuth
  // metadata without a usable registration endpoint) cannot register a
  // client dynamically; the SDK must use the deployment's PRE-REGISTERED
  // static client instead. Load it, combine it with the already-negotiated
  // token-endpoint auth method, and preload it on the provider BEFORE
  // auth() — the SDK's authInternal sees `clientInformation()` present and
  // SKIPS registerClient entirely (the `selectClientAuthMethod` seam then
  // chooses the token-endpoint authentication, unchanged). Missing static
  // client → a clear fail-closed provisioning instruction and NO flow row.
  if (!negotiation.dynamicRegistration) {
    const staticStore = deps.staticClientStore ?? createStaticOAuthClientStore();
    let staticClient: StaticOAuthClient | null;
    try {
      staticClient = await staticStore.load(manifest.id);
    } catch (err) {
      return {
        ok: false,
        message: `connect ${manifest.label} failed: the static OAuth client lookup failed (${errorMessage(err)})`,
      };
    }
    if (staticClient === null) {
      return {
        ok: false,
        message:
          `connect ${manifest.label} failed: ${manifest.id}'s authorization server does not support ` +
          `dynamic client registration — provision its static OAuth client first: request ` +
          `"connect_upload_link extension=${manifest.id} scope=org", open the link in a browser, and enter ` +
          `the pre-registered client ID and client secret, then re-run connect.`,
      };
    }
    provider.saveClientInformation({
      client_id: staticClient.client_id,
      client_secret: staticClient.client_secret,
      token_endpoint_auth_method: negotiation.tokenEndpointAuthMethod,
    });
  }
  let result: AuthResult;
  try {
    result = await auth(provider, {
      serverUrl,
      ...(negotiation.scope !== undefined ? { scope: negotiation.scope } : {}),
      // Issue #263: DEBUG-gated raw token-endpoint capture on the connect
      // leg (INTERACTIVE mint never hits /token — the wrapper only acts on
      // /token paths — but the SDK's discovery/register/authorize run
      // through the same fetchFn under DEBUG).
      ...debugTokenExchangeFetch(),
    });
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
     * regenerates egress with the superset and reloads the proxy (the
     * allowlist gains the new provider's domains). Issue #284: never
     * touches OAuth credentials — no blob seeding, no refresh POST (the
     * SDK owns the grant). Best-effort: any warnings fold into the result
     * — the connect stays successful.
     */
    reconcileEgress?: ReconcileEgress;
    /**
     * Post-connect same-space refresh (issue #281): invoked after a
     * successful connect (credential + registry + audit + egress all
     * landed) with the extension's provider and the SPACE whose connect
     * started the flow. The composition root wires this to refresh that
     * space's live session toolset so the freshly-connected provider's
     * tools appear on that space's next turn WITHOUT a restart. Absent →
     * no session refresh (the callback still succeeds).
     */
    onConnected?: (info: { provider: string; spaceId: string | null }) => void | Promise<void>;
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
    result = await auth(provider, {
      serverUrl: flowRow.server_url,
      authorizationCode: code,
      // Issue #263: DEBUG-gated raw token-endpoint response capture — this
      // exchange is the leg that actually hits /token (plus the probe).
      ...debugTokenExchangeFetch(),
    });
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
  //
  // Decision B (issue #265): a NON-RENEWABLE credential (access-only
  // exchange — no refresh anywhere, e.g. Notion's AS caps grants at ~1h
  // access tokens) has nothing to probe; running the probe would fail the
  // connect with "the returned refresh token cannot mint an access token"
  // on a grant that is perfectly usable for its lifetime. The probe runs
  // only for refresh-bearing saves; expiry of a non-renewable credential
  // surfaces the re-connect prompt at runtime instead.
  if (provider.savedRefreshable) {
    let probe: AuthResult;
    try {
      probe = await auth(provider, {
        serverUrl: flowRow.server_url,
        // Issue #263: the connect-time mint probe also exchanges tokens at
        // /token — captured under DEBUG like the code exchange.
        ...debugTokenExchangeFetch(),
      });
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
  // from the superset (committed pins ∪ runtime rows) so the new
  // provider's domains are allowlisted, and reload the running proxy.
  // Issue #284: this NEVER touches OAuth credentials — no blob seeding,
  // no refresh POST; the SDK owns the grant (the connect-time mint probe
  // above was the single refresh round-trip). Best-effort and guarded:
  // the connect already landed, so a reconcile failure is receivable,
  // never fatal.
  let warnings: string[] = [];
  if (deps.reconcileEgress !== undefined) {
    try {
      const result = await deps.reconcileEgress(flowRow.provider);
      warnings = result.warnings;
    } catch (err) {
      warnings = [`connect ${flowRow.label} failed to reconcile egress: ${errorMessage(err)}`];
    }
  }
  // Issue #281: the browser leg is the ONLY place that knows the connect
  // actually completed, so surface the connected space to the composition
  // root HERE — it refreshes that space's live session toolset so the new
  // provider's tools appear without a restart. Fire-and-forget-safe (a
  // disposed session cold-starts on the next turn, resuming the transcript),
  // awaited so the success page never precedes an unfinished refresh.
  if (deps.onConnected !== undefined) {
    try {
      await deps.onConnected({ provider: flowRow.provider, spaceId: flowRow.space_id });
    } catch (err) {
      warnings = [
        ...warnings,
        `connect ${flowRow.label} connected but the session toolset refresh failed: ${errorMessage(err)}`,
      ];
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
