/**
 * Proxy credential sync (issue #208 Wave 2): seeds iron-proxy with model
 * gateway keys and OAuth refresh credentials, then removes provider keys
 * from the app environment.
 *
 * The vault stays the source of truth. The SDK receives only
 * `bottega-proxy-placeholder`; iron-proxy swaps or mints the live
 * credential at egress. This boot adapter briefly resolves credentials,
 * writes mode-0600 boundary files atomically, clears provider env values,
 * and reloads the proxy. Missing credentials delete stale files so
 * `require: true` rejects the request.
 *
 * The codex provider (issue #214) is special (issue #230): the seed OWNS
 * the codex refresh — it mints the access token itself and writes it to a
 * STATIC secret file (openai-codex.secret) that the egress secrets
 * transform injects; the proxy never touches auth.openai.com for codex.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { resolveAuthBrokerConfig } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, type OAuthCredential } from "@oh-my-pi/pi-ai";
import { oauthTokenBlobFileName } from "../egress/generate";
import { PROXY_SECRETS_DIR, proxyBoundaryControlFromEnv } from "./boundary";
import { errorMessage } from "../tools/helpers";
import { fetchVaultApiKeysFromEnv, keychainReaderFromEnv, keychainServiceFor } from "../server/boot-secrets";
import type { BootSecret } from "../server/boot-secrets";
import type { JsonValue } from "./manifest";

/**
 * The model-gateway keys the sync writes (issue #208): one `<provider>.secret`
 * file per gateway, mirroring the egress generator's MODEL_GATEWAY_KEYS
 * (provider ids must match — the generated config reads exactly these
 * files). The env name is the same one models.yml historically referenced
 * (dev.sh's Keychain load) and the vault provider identity is the #201
 * row id. The openai-codex gateway is NOT in this list: it is a
 * FILESYSTEM credential (the Codex CLI auth file), seeded by the codex
 * leg (issue #230) as the same `<provider>.secret` shape the egress
 * static entry reads.
 */
export interface ModelProxyKey {
  provider: string;
  envName: string;
}

/** The four model-gateway keys (opencode-go's key-only decl + the three custom gateways). */
export const MODEL_PROXY_KEYS: readonly ModelProxyKey[] = [
  { provider: "near", envName: "NEAR_API_KEY" },
  { provider: "opencode", envName: "OPENCODE_API_KEY" },
  { provider: "openai", envName: "OPENAI_API_KEY" },
  { provider: "anthropic", envName: "ANTHROPIC_API_KEY" },
] as const;

/**
 * One OAuth provider the sync seeds into the proxy's `oauth_token`
 * entries (issue #208): the refresh token comes from the vault's OAuth
 * row (the #198 flow). Client credentials resolve per-user first — the
 * #198 dynamic-client-registration flow persists the registered
 * `client_information` into the vault credential (issue #250) — and fall
 * back to the deployment-level env override below when a deployment
 * registers ONE shared client instead.
 */
export interface OAuthProxyCredential {
  provider: string;
  /** Env var holding the OAuth client id (the deployment-level fallback). */
  clientIdEnv: string;
  /** Optional env var holding the OAuth client secret (public clients omit it). */
  clientSecretEnv?: string;
}

/** The OAuth providers with verified token endpoints (see OAUTH_TOKEN_ENDPOINTS). */
export const OAUTH_PROXY_CREDENTIALS: readonly OAuthProxyCredential[] = [
  { provider: "linear", clientIdEnv: "LINEAR_OAUTH_CLIENT_ID", clientSecretEnv: "LINEAR_OAUTH_CLIENT_SECRET" },
  { provider: "attio", clientIdEnv: "ATTIO_OAUTH_CLIENT_ID", clientSecretEnv: "ATTIO_OAUTH_CLIENT_SECRET" },
  { provider: "notion", clientIdEnv: "NOTION_OAUTH_CLIENT_ID", clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET" },
] as const;

/** The proxy oauth_token blob's file shape: the refresh grant + client credentials (issue #208). */
interface ProxyOAuthBlob {
  refresh_token: string;
  client_id: string;
  /** Present only when the deployment configures a client secret (public clients omit it). */
  client_secret?: string;
}

/**
 * A vault OAuth credential carrying the per-user registered client
 * identity (issue #250): the #198 dynamic-client-registration flow
 * persists `client_information` (`client_id`/`client_secret`) into the
 * vault row, so the refresh grant can mint for the USER's client rather
 * than a shared deployment client. The SDK type omits these fields (the
 * SDK never reads them back), but extra JSON survives the vault round-trip.
 */
export interface VaultOAuthCredential extends OAuthCredential {
  client_id?: string;
  client_secret?: string;
}

/** One OAuth vault row's seed-relevant fields (issue #250). */
export interface OAuthVaultRow {
  /** The refresh token (real locally; {@link REMOTE_REFRESH_SENTINEL} remotely). */
  refresh?: string;
  /** The per-user registered client id (the DCR `client_information`). */
  clientId?: string;
  /** The per-user registered client secret (public clients omit it). */
  clientSecret?: string;
}

/**
 * One provider's blob-seed result (issue #250): `notes` are routine
 * transitions (seeded / removed), `warnings` are receivable gaps
 * (refresh present but no client id anywhere). `wrote:false` means the
 * blob was DELETED — fail closed: a blob that cannot mint is never
 * written, so there is never half-wired state.
 */
export interface ProxyBlobSeedResult {
  notes: string[];
  warnings: string[];
  wrote: boolean;
}

/** The proxy-side secret file for a model gateway key. */
export function proxyKeyFileName(provider: string): string {
  return `${provider}.secret`;
}

/** The proxy-side OAuth blob for a provider (the tokens entry's json_key file). */
export function proxyOAuthBlobFileName(provider: string): string {
  return oauthTokenBlobFileName(provider);
}

/**
 * The codex provider's filesystem credential (issue #214 + #230): the
 * ChatGPT subscription OAuth tokens come from the Codex CLI's auth file —
 * the default `~/.codex/auth.json`, overridable with `CODEX_AUTH_PATH`
 * (the same env var the canary resolution gates on). Only the ACCESS +
 * REFRESH tokens are read; the id_token and other fields never enter the
 * app. The seed REFRESHES the grant itself and writes the ACCESS token to
 * the proxy's static openai-codex.secret — the proxy never mints for
 * codex (issue #230).
 */
export const CODEX_AUTH_FILE_ENV = "CODEX_AUTH_PATH";
export const CODEX_AUTH_FILE_DEFAULT = "~/.codex/auth.json";
/**
 * The Codex public OAuth client id (the openai/codex CLI's login client —
 * verified from the OAuth flow; the refresh grant at
 * {@link CODEX_TOKEN_ENDPOINT} uses it).
 */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/**
 * The Codex OAuth refresh endpoint (issue #230): the seed owns the codex
 * refresh — POST grant_type=refresh_token with the Codex public client id
 * (the grant shape verified 200 repeatedly from the live proxy; the same
 * endpoint the CLI's CODEX_REFRESH_TOKEN_URL_OVERRIDE targets). The egress
 * proxy no longer touches auth.openai.com: this endpoint is called ONLY by
 * the seed's refresh path.
 */
export const CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

/** The Codex CLI auth file's token shape: { tokens: { access_token, refresh_token } }. */
export interface CodexAuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Resolves the Codex auth file path from env: `CODEX_AUTH_PATH` when set,
 * else the default `~/.codex/auth.json`. Under the test runner an UNSET
 * path yields null — the sync and the canary resolution must never read a
 * real developer's home auth file hermetically (the #191 isolation rule);
 * an explicit `CODEX_AUTH_PATH` (a fixture) is always honored.
 */
export function codexAuthFilePathFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[CODEX_AUTH_FILE_ENV];
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  if (process.env.NODE_ENV === "test") return null;
  return CODEX_AUTH_FILE_DEFAULT.replace(/^~/, homedir());
}

/**
 * The historical iron-proxy `oauth_token` transform mint-failure marker
 * (issue #218, verified from the iron-proxy v0.49.0 source + binary):
 * when a refresh grant cannot mint, the transform 502s the request with
 * `{"error":"oauth_token failed to mint an access token","grant":"..."}`
 * (`require: true` — fail closed, never an unauthenticated upstream call).
 * Under issue #230 the codex provider is a STATIC secrets entry (the
 * seed owns the refresh), but the OAuth extensions still mint through the
 * transform and the 403-no-body family (a standalone `403` in the message
 * — the upstream rejecting with no body, e.g. an account-plan denial)
 * remains the codex turn-side fingerprint; the model SDK's error message
 * carries the body text and the driver surfaces it in the session error,
 * so this string is the turn-side fingerprint of a dead/denied Codex
 * credential.
 */
export const CODEX_MINT_FAILURE_MARKER = "oauth_token failed to mint";

/**
 * The recovery path every Codex mint failure names (issue #218) — shared
 * by the boot error (the seed throws it) and the turn error (the
 * presenter surfaces it): re-login with the Codex CLI, then restart so
 * the seed re-verifies and the proxy reloads with the fresh token.
 */
export const CODEX_MINT_REMEDY = "run `codex login`, then restart the server";

/**
 * Maps a driver/proxy error message to the user-visible Codex mint-failure
 * reply (issue #218): a dead refresh token must surface the recovery path
 * instead of an empty-response fallback. Matches the proxy's 502 body
 * string ({@link CODEX_MINT_FAILURE_MARKER}) and the 403-no-body family (a
 * standalone `403` in the message — the upstream rejecting with no body,
 * e.g. an account-plan denial). Returns null for anything else, so callers
 * keep their existing text.
 */
export function codexMintFailureText(message: string | undefined): string | null {
  if (message === undefined) return null;
  const trimmed = message.trim();
  if (trimmed === "") return null;
  if (!trimmed.includes(CODEX_MINT_FAILURE_MARKER) && !/\b403\b/.test(trimmed)) return null;
  return `Codex auth failed to mint an access token — ${CODEX_MINT_REMEDY}.`;
}

/**
 * One Codex refresh-grant probe outcome (issue #218 + #230): the token
 * endpoint's verdict on the seeded refresh token, the freshly minted
 * ACCESS token (the seed's static secret), and the refresh token to
 * persist — the endpoint's rotation when it returned one, else the probed
 * token.
 */
export interface CodexMintOutcome {
  /** True when the token endpoint accepted the refresh grant (HTTP 2xx). */
  minted: boolean;
  /** The endpoint's HTTP status on a rejected grant; undefined on transport errors. */
  status?: number;
  /**
   * The freshly minted access token (RFC 6749 §5.1 `access_token`), when
   * the endpoint returned one — the value the seed writes to
   * openai-codex.secret. Undefined when no refresh happened or the
   * endpoint omitted it; the seed then keeps the auth file's access token.
   */
  accessToken?: string;
  /** The refresh token to persist: the endpoint's rotated token or the probed one. */
  refreshToken: string;
}

/** The Codex mint probe's inputs — all already in the seed (issue #214). */
export interface CodexMintProbeInput {
  refreshToken: string;
  clientId: string;
  tokenEndpoint: string;
}

/** The mint-probe seam (issue #218): verifies the refresh grant before the blob is written; tests stub it. */
export type CodexMintProbe = (input: CodexMintProbeInput) => Promise<CodexMintOutcome>;

/**
 * The default Codex mint probe (issue #218 + #230): POSTs the refresh
 * grant to the Codex token endpoint with the Codex public client id and
 * reports the verdict. A 2xx response's `access_token` (the seed's static
 * secret) and `refresh_token` (rotation, written back) are returned. Under
 * the test runner this is a no-op success — hermetic tests never touch the
 * network (the #191 isolation rule); the probe's own tests inject the
 * seam.
 */
/**
 * The Codex token endpoint's 2xx response (RFC 6749 §5.1): `access_token`
 * is the minted bearer; `refresh_token` is present only when the endpoint
 * rotates it, and is a non-empty string.
 */
const codexTokenResponseSchema = z.object({
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
});

async function probeCodexMint(input: CodexMintProbeInput): Promise<CodexMintOutcome> {
  if (process.env.NODE_ENV === "test") return { minted: true, refreshToken: input.refreshToken };
  let res: Response;
  try {
    res = await fetch(input.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
        client_id: input.clientId,
      }),
    });
  } catch {
    return { minted: false, refreshToken: input.refreshToken };
  }
  if (!res.ok) return { minted: false, status: res.status, refreshToken: input.refreshToken };
  let accessToken: string | undefined;
  let rotated = input.refreshToken;
  try {
    const parsed = codexTokenResponseSchema.safeParse(await res.json());
    if (parsed.success) {
      accessToken = parsed.data.access_token;
      if (parsed.data.refresh_token !== undefined) {
        rotated = parsed.data.refresh_token;
      }
    }
  } catch {
    // A 2xx with a non-JSON body still minted; keep the probed tokens.
  }
  return { minted: true, accessToken, refreshToken: rotated };
}

/**
 * Writes a (possibly rotated) refresh token back to the Codex CLI auth
 * file (issue #218): patches `tokens.refresh_token` in place, preserving
 * every other field, atomically (write-temp + rename, mode preserved,
 * 0600 default). The proxy's `oauth_token` transform rotates the refresh
 * token in memory without persisting it (x/oauth2 semantics, verified from
 * the iron-proxy v0.49.0 source) — the seed writes the minted token back
 * so the CLI's auth file and the proxy blob never diverge, and a later
 * reload/restart re-reads a LIVE token instead of the stale one. A
 * missing or unparseable file is left untouched (the boundary blob still
 * carries the rotated token). No-op when the token is unchanged.
 */
export function writeCodexAuthTokens(authFilePath: string, refreshToken: string): void {
  let raw: string;
  try {
    raw = readFileSync(authFilePath, "utf8");
  } catch {
    return;
  }
  let parsed: Record<string, JsonValue>;
  try {
    // SAFETY: the auth file is the Codex CLI's own JSON serialization — a
    // JSON document; the parse target types member access on it, and a
    // non-object payload fails the same property paths as before.
    parsed = JSON.parse(raw) as Record<string, JsonValue>;
  } catch {
    return;
  }
  // SAFETY: `tokens` is the document's tokens member — an object in the
  // CLI's serialization (the sync's own read requires it); the assertion
  // only types the refresh_token read/write below.
  const tokens = (parsed.tokens ??= {}) as Record<string, JsonValue>;
  if (tokens.refresh_token === refreshToken) return;
  tokens.refresh_token = refreshToken;
  let mode = 0o600;
  try {
    mode = statSync(authFilePath).mode & 0o777;
  } catch {
    // File vanished between read and write: keep the 0600 default.
  }
  // Preserve the file's formatting style (compact vs pretty) so the CLI's
  // own diffs stay clean; JSON parsing is whitespace-insensitive either way.
  const pretty = /\n\s{2}/.test(raw);
  const out = (pretty ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed)) + "\n";
  const tmpPath = `${authFilePath}.tmp`;
  writeFileSync(tmpPath, out, { mode });
  renameSync(tmpPath, authFilePath);
}

/**
 * Reads + parses the Codex CLI auth file: `{ tokens: { access_token,
 * refresh_token } }` (both non-empty). Returns null on a missing file,
 * unparseable JSON, or missing tokens — the fail-closed signal (the
 * caller deletes the boundary blob).
 */
/** The Codex CLI auth file's token shape (the fields the sync reads; other fields are preserved verbatim on write-back). */
const codexAuthFileSchema = z.object({
  tokens: z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1) }).optional(),
});

export function readCodexAuthTokens(authFilePath: string): CodexAuthTokens | null {
  let raw: string;
  try {
    raw = readFileSync(authFilePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = codexAuthFileSchema.parse(JSON.parse(raw));
    const tokens = parsed.tokens;
    if (tokens === undefined) return null;
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
  } catch {
    return null;
  }
}

/**
 * The re-refresh window (issue #230): the seed refreshes the access token
 * when its JWT `exp` is within this horizon of the current time — the
 * access token's ~7-day lifetime means a check cadence far below the
 * window always re-mints long before the token dies.
 */
export const CODEX_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * The periodic re-refresh cadence (issue #230): the armed hourly check
 * decodes the access token's `exp` and refreshes when it enters the
 * {@link CODEX_REFRESH_WINDOW_MS} window — well under the ~7-day lifetime,
 * so a long-running deployment (no restarts) still re-refreshes long
 * before the token dies.
 */
const CODEX_REFRESH_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Decodes a JWT's `exp` claim (seconds since epoch) from the middle
 * (payload) segment, base64url, WITHOUT verifying the signature — the
 * seed only needs the expiry to schedule the re-refresh, never to trust
 * the token (the refresh grant verifies the credential). Returns null for
 * anything that is not a three-segment JWT with a numeric `exp` — the
 * caller treats an undecodable expiry as "cannot verify freshness" and
 * refreshes (fail-safe).
 */
export function decodeCodexJwtExp(accessToken: string): number | null {
  const segments = accessToken.split(".");
  if (segments.length !== 3) return null;
  let payload: string;
  try {
    payload = Buffer.from(segments[1], "base64url").toString("utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(payload) as { exp?: unknown };
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) return null;
    return parsed.exp;
  } catch {
    return null;
  }
}

/**
 * The codex static credential sync (issue #230): the seed OWNS the codex
 * refresh. Reads the Codex CLI auth file, refreshes the grant when the
 * access token is within {@link CODEX_REFRESH_WINDOW_MS} of its JWT exp
 * (or the exp is undecodable — freshness cannot be verified), and writes:
 *   (a) the ACCESS token to `openai-codex.secret` (the egress static
 *       secrets injection entry, mode 0600, atomic) — the proxy never
 *       mints or rotates anything for codex,
 *   (b) the (possibly rotated) refresh token back to the oauth blob AND
 *       the CLI auth file, so the CLI session stays valid and a later
 *       boot re-reads a LIVE refresh token (the #218 write-back).
 * Fail closed unchanged: a missing/unparseable auth file or a REJECTED
 * refresh grant deletes BOTH boundary files — `require: true` 502s the
 * codex provider until the user logs in with the Codex CLI. A transport
 * error / 5xx / 429 is transient, not dead: warn and write the existing
 * access token (the runtime failure still surfaces the remedy).
 *
 * `throwOnRejected` distinguishes the boot path (a dead token FAILS the
 * boot loudly with the remedy — issue #218) from the background re-refresh
 * path (a dead token deletes the files and logs; a timer must never throw
 * the process).
 */
async function syncCodexCredential(opts: {
  env: NodeJS.ProcessEnv;
  secretsDir: string;
  mintCodexRefreshToken?: CodexMintProbe;
  log: (line: string) => void;
  throwOnRejected: boolean;
}): Promise<void> {
  const { env, secretsDir, log } = opts;
  const codexSecretFileName = proxyKeyFileName("openai-codex");
  const codexBlobFileName = proxyOAuthBlobFileName("openai-codex");
  const removeBoundaryFiles = (): void => {
    deleteSecretFile(secretsDir, codexSecretFileName);
    deleteSecretFile(secretsDir, codexBlobFileName);
  };
  const codexAuthPath = codexAuthFilePathFromEnv(env);
  if (codexAuthPath === null) {
    removeBoundaryFiles();
    log(
      `bottega boot: proxy ${codexSecretFileName} + ${codexBlobFileName} REMOVED — no Codex auth file ` +
        `(set ${CODEX_AUTH_FILE_ENV} or log in with the Codex CLI to create ~/.codex/auth.json; fail closed)`,
    );
    return;
  }
  const codexTokens = readCodexAuthTokens(codexAuthPath);
  if (codexTokens === null) {
    removeBoundaryFiles();
    log(
      `bottega boot: proxy ${codexSecretFileName} + ${codexBlobFileName} REMOVED — Codex auth file unreadable ` +
        `(set ${CODEX_AUTH_FILE_ENV} or log in with the Codex CLI to create ~/.codex/auth.json; fail closed)`,
    );
    return;
  }
  const exp = decodeCodexJwtExp(codexTokens.accessToken);
  const needsRefresh = exp === null || exp * 1_000 <= Date.now() + CODEX_REFRESH_WINDOW_MS;
  const writeBoundaryFiles = (accessToken: string, refreshToken: string): void => {
    writeSecretFile(secretsDir, codexSecretFileName, accessToken);
    writeSecretFile(
      secretsDir,
      codexBlobFileName,
      JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, client_id: CODEX_OAUTH_CLIENT_ID }),
    );
  };
  if (!needsRefresh) {
    // Fresh access token (exp comfortably ahead): write it statically — no
    // refresh round-trip, the proxy injects it at egress as-is.
    writeBoundaryFiles(codexTokens.accessToken, codexTokens.refreshToken);
    log(
      `bottega boot: proxy ${codexSecretFileName} seeded (Codex access token valid until ${new Date(exp * 1_000).toISOString()} — no refresh needed)`,
    );
    return;
  }
  const mintProbe = opts.mintCodexRefreshToken ?? probeCodexMint;
  const probe = await mintProbe({
    refreshToken: codexTokens.refreshToken,
    clientId: CODEX_OAUTH_CLIENT_ID,
    tokenEndpoint: CODEX_TOKEN_ENDPOINT,
  });
  if (!probe.minted && probe.status !== undefined && probe.status >= 400 && probe.status < 500 && probe.status !== 429) {
    removeBoundaryFiles();
    const err = new Error(
      `bottega boot: Codex refresh token REJECTED (HTTP ${probe.status}) — ${CODEX_MINT_REMEDY} ` +
        `(issue #230: the seed's refresh grant failed; the token is stale or was revoked)`,
    );
    if (opts.throwOnRejected) throw err;
    log(err.message);
    return;
  }
  if (!probe.minted) {
    log(
      `bottega boot: proxy ${codexSecretFileName} Codex refresh could not be verified ` +
        `(${probe.status === undefined ? "token endpoint unreachable" : `HTTP ${probe.status}`}) — writing the existing access token unverified; ` +
        "any egress failure surfaces the remedy in the turn",
    );
    writeBoundaryFiles(codexTokens.accessToken, codexTokens.refreshToken);
    return;
  }
  const accessToken = probe.accessToken !== undefined && probe.accessToken !== "" ? probe.accessToken : codexTokens.accessToken;
  writeBoundaryFiles(accessToken, probe.refreshToken);
  if (probe.refreshToken !== codexTokens.refreshToken) {
    // Rotation write-back (issue #218, kept in #230): persist the
    // endpoint's rotated refresh token to the CLI auth file so a later
    // boot re-reads a LIVE token instead of the rotated-away one.
    writeCodexAuthTokens(codexAuthPath, probe.refreshToken);
    log(
      `bottega boot: proxy ${codexSecretFileName} seeded (Codex access token refreshed; refresh token rotated — ` +
        `wrote back to ${codexAuthPath})`,
    );
  } else {
    log(`bottega boot: proxy ${codexSecretFileName} seeded (Codex access token refreshed; refresh grant verified)`);
  }
}

/**
 * The periodic codex re-refresh timer (issue #230): armed once per process
 * after a REAL boot seed (never under the test runner — hermetic isolation
 * rule) and unref'd so it never keeps the process alive. Every hour it
 * re-runs the codex credential sync, which refreshes when the access
 * token enters the final 24h of its JWT exp — a long-running deployment
 * re-refreshes long before the ~7-day access token dies, with the rotated
 * refresh token persisted to the blob + CLI auth file. The background
 * path never throws: a rejected grant deletes the boundary files (fail
 * closed — turns 502 with the remedy) and logs.
 */
let codexReRefreshArmed = false;

function armCodexReRefresh(opts: {
  env: NodeJS.ProcessEnv;
  secretsDir: string;
  mintCodexRefreshToken?: CodexMintProbe;
  log: (line: string) => void;
}): void {
  if (codexReRefreshArmed || process.env.NODE_ENV === "test") return;
  codexReRefreshArmed = true;
  const timer = setInterval(() => {
    void syncCodexCredential({ ...opts, throwOnRejected: false }).catch((err) => {
      opts.log(`bottega boot: Codex re-refresh check failed: ${errorMessage(err)}`);
    });
  }, CODEX_REFRESH_CHECK_INTERVAL_MS);
  timer.unref?.();
}

export interface ProxyCredentialSyncOpts {
  /** The env to read; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Directory for the proxy secret files; defaults to
   * BOTTEGA_PROXY_SECRETS_DIR ?? PROXY_SECRETS_DIR (the shared data
   * volume, mounted at PROXY_SECRETS_MOUNT_PATH on the proxy side).
   */
  secretsDir?: string;
  /**
   * Vault fetch seam (tests): provider → api_key secret. Default: the
   * auth-broker snapshot via fetchVaultApiKeysFromEnv (the same map the
   * #201 boot-secret seed uses).
   */
  fetchVault?: () => Promise<Map<string, string>>;
  /**
   * Keychain seam (tests). Default: keychainReaderFromEnv — gated on
   * BOTTEGA_KEYCHAIN_SEED=1 so hermetic tests never read a real Keychain.
   */
  readKeychain?: (service: string) => Promise<string | null>;
  /**
   * OAuth vault-row seam (tests + the connect-time reconcile): provider →
   * the newest oauth credential rows (real refresh token locally; sentinel
   * the per-user registered client identity when present
   * (issue #250). Default: the broker-aware vault reader
   * (readOAuthRowsFromVault — the broker's own vault db when a broker is
   * configured, else the embedded local storage, issue #252).
   */
  readOAuthRows?: (provider: string) => Promise<Array<OAuthVaultRow>>;
  /**
   * Codex refresh-grant seam (issue #218 + #230): performs the seed's
   * refresh — a dead token fails the boot loudly with the remedy instead
   * of being seeded silently, and a minted access token becomes the
   * static secret. Default: a real refresh-grant POST to the Codex token
   * endpoint (a no-op success under the test runner — the #191 isolation
   * rule). Tests stub it.
   */
  mintCodexRefreshToken?: CodexMintProbe;
  /** Proxy management API base + bearer (the reload half); default from env. */
  proxyControl?: { proxyControlUrl?: string; proxyControlToken?: string };
  /** Boot log sink; defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * The broker vault's agent dir (issue #252): the broker container runs
 * with `PI_CONFIG_DIR=/data/.omp` on the shared data volume (compose) /
 * the `./data` bind (dev), so the connect leg's OAuth rows land in the
 * broker's OWN SQLite vault at `data/.omp/agent/agent.db` — a DIFFERENT
 * physical file from the embedded default agent dir (`~/.omp`) the
 * broker-less reader opens. `BOTTEGA_BROKER_AGENT_DIR` relocates it
 * (deployments that mount the vault elsewhere; tests point it at a temp
 * dir so the reconcile can be driven without a real broker).
 */
export const BROKER_AGENT_DIR_ENV = "BOTTEGA_BROKER_AGENT_DIR";

/** The broker vault's agent dir relative to the server CWD (the shared data mount). */
export const BROKER_AGENT_DIR = "data/.omp";

/** The broker vault's agent dir: the override when set, else the project-local data mount. */
export function brokerAgentDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[BROKER_AGENT_DIR_ENV];
  return override !== undefined && override !== "" ? override : BROKER_AGENT_DIR;
}

/**
 * The default OAuth-row reader (issue #252) for the boot sync and the
 * connect-time reconcile. When an auth broker IS configured, the connect
 * leg writes through the broker's `POST /v1/credential` into the
 * BROKER's own SQLite vault; the broker's snapshot/HTTP surfaces redact
 * the refresh token to {@link REMOTE_REFRESH_SENTINEL} and never expose
 * `client_id`, so the seed must read that physical file directly — the
 * SAME file the connect leg wrote — or a freshly connected provider (e.g.
 * notion) never seeds. Without a broker the embedded local storage IS the
 * connect-leg vault, so it stays the fallback. Both routes fail closed
 * (no usable row → the seed deletes the blob).
 */
export async function readOAuthRowsFromVault(provider: string): Promise<Array<OAuthVaultRow>> {
  const brokerConfig = await resolveAuthBrokerConfig();
  if (brokerConfig !== null) {
    return readOAuthRowsFromAgentDb(brokerAgentDirFromEnv(), provider);
  }
  return readOAuthRowsFromLocalStorage(provider);
}

/** Reads the OAuth rows straight from one agent-db DIR (the broker's vault, issue #252). */
async function readOAuthRowsFromAgentDb(agentDir: string, provider: string): Promise<Array<OAuthVaultRow>> {
  const dbPath = join(agentDir, "agent.db");
  // Absent vault → no rows → the seed deletes the blob (fail closed). Do
  // NOT create the broker's db here (SqliteAuthCredentialStore.open would):
  // a boot must not materialize the broker's vault.
  if (!existsSync(dbPath)) return [];
  const storage = await AuthStorage.create(dbPath);
  try {
    await storage.reload();
    return storage
      .listStoredCredentials(provider)
      .flatMap((entry) => (entry.credential.type === "oauth" ? [oauthVaultRow(entry.credential)] : []));
  } finally {
    storage.close();
  }
}

/**
 * The broker-less OAuth-row reader: the EMBEDDED local AuthStorage (the
 * #198 store at the default agent dir). Only correct when no broker is
 * configured — with a broker the connect leg writes a different vault
 * (see {@link readOAuthRowsFromVault}, issue #252).
 */
export async function readOAuthRowsFromLocalStorage(provider: string): Promise<Array<OAuthVaultRow>> {
  const storage = await discoverAuthStorage();
  try {
    await storage.reload();
    return storage
      .listStoredCredentials(provider)
      .flatMap((entry) => (entry.credential.type === "oauth" ? [oauthVaultRow(entry.credential)] : []));
  } finally {
    storage.close();
  }
}

/** Picks the seed-relevant fields off one vault OAuth credential (+ the #250 client identity). */
function oauthVaultRow(credential: OAuthCredential): OAuthVaultRow {
  return {
    refresh: credential.refresh,
    clientId: (credential as VaultOAuthCredential).client_id,
    clientSecret: (credential as VaultOAuthCredential).client_secret,
  };
}

/** Atomic 0600 write-temp + rename (the #53 boundary pattern). */
function writeSecretFile(secretsDir: string, fileName: string, value: string): void {
  mkdirSync(secretsDir, { recursive: true });
  const tmpPath = join(secretsDir, `${fileName}.tmp`);
  const finalPath = join(secretsDir, fileName);
  writeFileSync(tmpPath, value, { mode: 0o600 });
  renameSync(tmpPath, finalPath);
}

/** Deletes a proxy secret file (fail-closed: no stale credential). */
function deleteSecretFile(secretsDir: string, fileName: string): void {
  rmSync(join(secretsDir, fileName), { force: true });
}

/**
 * Seeds ONE provider's proxy OAuth blob (issue #208; shared with the
 * connect-time reconcile in issue #250). Client credentials resolve
 * per-user first — the vault row's registered `client_information`
 * (issue #250) — then the deployment env override (`clientIdEnv` /
 * `clientSecretEnv`, the #208 boot posture). Fail closed: no refresh row
 * → delete the blob; a refresh row with no resolvable client id → delete
 * the blob + a LOUD warning naming the env var (or provider) that the
 * operator must satisfy — a blob that cannot mint is never written.
 * `clearEnv` strips the consumed env vars after a successful seed (boot
 * behavior — the reconcile leaves the environment untouched). Never logs
 * secret values, only names + outcome.
 */
export async function seedProxyOAuthBlob(
  provider: string,
  opts: {
    /** Directory for the proxy secret files. */
    secretsDir: string;
    /** The env override source; defaults to process.env. */
    env?: NodeJS.ProcessEnv;
    /** Vault-row seam; defaults to the local AuthStorage. */
    readOAuthRows?: (provider: string) => Promise<Array<OAuthVaultRow>>;
    /** Deployment client-id env (fallback); derived from OAUTH_PROXY_CREDENTIALS when known. */
    clientIdEnv?: string;
    /** Deployment client-secret env (fallback, optional). */
    clientSecretEnv?: string;
    /** Strip the consumed env vars after a successful seed (boot only). */
    clearEnv?: boolean;
    /** Log sink; defaults to console.log. */
    log?: (line: string) => void;
  },
): Promise<ProxyBlobSeedResult> {
  const env = opts.env ?? process.env;
  const readOAuthRows = opts.readOAuthRows ?? readOAuthRowsFromVault;
  const known = OAUTH_PROXY_CREDENTIALS.find((c) => c.provider === provider);
  const clientIdEnv = opts.clientIdEnv ?? known?.clientIdEnv;
  const clientSecretEnv = opts.clientSecretEnv ?? known?.clientSecretEnv;
  const fileName = proxyOAuthBlobFileName(provider);
  const notes: string[] = [];
  const warnings: string[] = [];

  const rows = await readOAuthRows(provider);
  const row = rows.find(
    (r) => r.refresh !== undefined && r.refresh !== "" && r.refresh !== REMOTE_REFRESH_SENTINEL,
  );
  const refresh = row?.refresh;
  // Resolve both client credentials up front so the #208 boot env-strip
  // below never races the resolution, then strip when requested — on EVERY
  // outcome (no-refresh, missing id, success): a booted env must not
  // persist consumed client secrets.
  const envClientId = clientIdEnv !== undefined ? env[clientIdEnv] : undefined;
  const envClientSecret = clientSecretEnv !== undefined ? env[clientSecretEnv] : undefined;
  if (opts.clearEnv === true && clientIdEnv !== undefined) delete env[clientIdEnv];
  if (opts.clearEnv === true && clientSecretEnv !== undefined) delete env[clientSecretEnv];
  if (refresh === undefined) {
    deleteSecretFile(opts.secretsDir, fileName);
    notes.push(`bottega proxy: ${fileName} REMOVED — no OAuth row for ${provider} (fail closed)`);
    return { notes, warnings, wrote: false };
  }
  // Per-user vault client identity first (issue #250), deployment env second.
  const clientId = row?.clientId !== undefined && row.clientId !== "" ? row.clientId : envClientId;
  if (clientId === undefined || clientId === "") {
    // Fail closed: the refresh grant cannot mint without a client id. The
    // warning NAMES the env var (e.g. NOTION_OAUTH_CLIENT_ID) the operator
    // must set when no per-user client was registered. The caller
    // (boot loop / egress reconcile) is the sole logger.
    deleteSecretFile(opts.secretsDir, fileName);
    warnings.push(
      `bottega proxy: ${fileName} REMOVED — ${provider} refresh token exists but ` +
        `${clientIdEnv ?? `${provider} client id`} is unset (fail closed)`,
    );
    return { notes, warnings, wrote: false };
  }
  const blob: ProxyOAuthBlob = { refresh_token: refresh, client_id: clientId };
  // Per-user vault client secret first (issue #250), env second.
  const clientSecret =
    row?.clientSecret !== undefined && row.clientSecret !== ""
      ? row.clientSecret
      : envClientSecret !== undefined
        ? envClientSecret
        : undefined;
  if (clientSecret !== undefined && clientSecret !== "") blob.client_secret = clientSecret;
  writeSecretFile(opts.secretsDir, fileName, JSON.stringify(blob));
  notes.push(`bottega proxy: ${fileName} seeded (${provider} OAuth refresh token)`);
  return { notes, warnings, wrote: true };
}

/**
 * The sync (issue #208): resolves every provider credential and writes it
 * to the proxy's secret files, then reloads the proxy when a control URL
 * + token are configured (the #123/#197 seam — a running proxy re-reads
 * the file sources on /v1/reload). Missing credentials DELETE the file
 * (fail closed: the config's require:true entries 502). Never logs secret
 * values — only names + source. Reload failures THROW when a control URL
 * is configured (a boot that cannot push its credentials must fail), and
 * are skipped when no control pair exists (write-only, bare local runs).
 */
/** The repo's live proxy-secrets dir, ABSOLUTE (the #191 guard compares
 * against this, not a cwd-relative resolve — a boot in a temp cwd must
 * stay isolated). */
const LIVE_PROXY_SECRETS_DIR = resolve(import.meta.dir, "../../data/proxy-secrets");

export async function syncProxyCredentialsFromEnv(opts: ProxyCredentialSyncOpts = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const secretsDir = opts.secretsDir ?? env.BOTTEGA_PROXY_SECRETS_DIR ?? PROXY_SECRETS_DIR;
  // Test isolation (issue #191 pattern): under the test runner the sync
  // must never write the repo's live default dir. Unlike the boundary's
  // per-call authorize (which MUST write or fail), boot credential
  // seeding is a no-op when no proxy/isolated dir exists under test —
  // the boots in src/smoke.test.ts / src/secrets/agent-dir.test.ts run
  // in the repo cwd and verify wiring, not seeding.
  if (process.env.NODE_ENV === "test" && resolve(secretsDir) === LIVE_PROXY_SECRETS_DIR) {
    log("bottega boot: proxy credential sync skipped (test runner, live default secrets dir)");
    return;
  }
  const fetchVault = opts.fetchVault ?? (() => fetchVaultApiKeysFromEnv(env));
  const readKeychain = opts.readKeychain ?? keychainReaderFromEnv(env);
  const readOAuthRows = opts.readOAuthRows ?? readOAuthRowsFromVault;
  const control = opts.proxyControl ?? proxyBoundaryControlFromEnv(env);

  const vault = await fetchVault();

  // 1. Model gateway keys: env → vault → Keychain → write `<provider>.secret`
  //    (or delete — fail closed).
  let changed = false;
  for (const key of MODEL_PROXY_KEYS) {
    const fileName = proxyKeyFileName(key.provider);
    const fromEnv = env[key.envName];
    const fromVault = vault.get(key.provider);
    const fromKeychain = await readKeychain(
      // SAFETY: keychainServiceFor reads only secret.vaultProvider
      // (boot-secrets.ts); the sync object carries it under `provider`.
      keychainServiceFor({ envName: key.envName, vaultProvider: key.provider, label: key.provider } as BootSecret),
    );
    const value = fromVault ?? fromEnv ?? fromKeychain ?? null;
    if (value !== null && value.trim() !== "") {
      writeSecretFile(secretsDir, fileName, value);
      log(`bottega boot: proxy ${fileName} seeded (${key.provider} key)`);
    } else {
      deleteSecretFile(secretsDir, fileName);
      log(`bottega boot: proxy ${fileName} REMOVED — no ${key.provider} key anywhere (fail closed)`);
    }
    delete env[key.envName];
    changed = true;
  }

  // 2. OAuth blobs: the vault's newest oauth row's refresh token (+ the
  //    per-user/#250 client credentials, env override) →
  //    `<provider>-oauth.json` (or delete — fail closed). The seed rule is
  //    the SAME implementation the connect-time reconcile uses (issue
  //    #250): per-user vault client identity wins, env is the deployment
  //    fallback, and a refresh without any resolvable client id deletes
  //    the blob loudly (no half-wired state).
  for (const credential of OAUTH_PROXY_CREDENTIALS) {
    const result = await seedProxyOAuthBlob(credential.provider, {
      secretsDir,
      env,
      readOAuthRows,
      clientIdEnv: credential.clientIdEnv,
      clientSecretEnv: credential.clientSecretEnv,
      clearEnv: true,
      log,
    });
    for (const note of result.notes) log(note);
    for (const warning of result.warnings) log(warning);
  }

  // 2.5. Codex static credential (issue #214 + #230): the ChatGPT
  // subscription OAuth tokens come from the Codex CLI auth file
  // (CODEX_AUTH_PATH, default ~/.codex/auth.json) — a FILESYSTEM
  // credential, never env/Keychain/vault. The SEED owns the codex refresh
  // (issue #230): it refreshes the grant when the access token is within
  // 24h of its JWT exp, writes the ACCESS token to openai-codex.secret
  // (the egress static secrets injection entry — the proxy never touches
  // auth.openai.com), and writes the rotated refresh token back to the
  // oauth blob + the CLI auth file. A missing/unparseable auth file or a
  // REJECTED grant deletes BOTH boundary files (fail closed — require:
  // true 502s the codex provider until the user logs in with the Codex
  // CLI). The boot path throws on a dead token (loud remedy); the
  // background re-refresh path deletes + logs.
  await syncCodexCredential({
    env,
    secretsDir,
    mintCodexRefreshToken: opts.mintCodexRefreshToken,
    log,
    throwOnRejected: true,
  });
  // Issue #230: the periodic re-refresh timer — a long-running deployment
  // re-refreshes long before the ~7-day access token dies, without a
  // restart. Armed once per process after a real (non-test) seed.
  armCodexReRefresh({ env, secretsDir, mintCodexRefreshToken: opts.mintCodexRefreshToken, log });

  // 3. Reload: a running proxy re-reads the file sources (ttl + reload).
  //    Configured control → the reload is REQUIRED (throw on failure);
  //    unconfigured → write-only (the proxy reads at its next start).
  if (!changed) return;
  if (control.proxyControlUrl === undefined || control.proxyControlToken === undefined) {
    log("bottega boot: proxy credentials written (no proxy control configured — reload skipped)");
    return;
  }
  let res: Response;
  try {
    res = await fetch(`${control.proxyControlUrl}/v1/reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${control.proxyControlToken}` },
    });
  } catch (err) {
    throw new Error(`bottega boot: proxy credential sync reload failed: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    throw new Error(`bottega boot: proxy credential sync reload failed (${res.status})`);
  }
  log("bottega boot: proxy reloaded with the seeded credentials");
}
