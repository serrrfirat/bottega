/**
 * Proxy credential sync (issue #208 Wave 2): seeds iron-proxy with model
 * gateway keys, then removes provider keys from the app environment.
 *
 * The vault stays the source of truth. The SDK receives only
 * `bottega-proxy-placeholder`; iron-proxy swaps the live credential at
 * egress. This boot adapter briefly resolves credentials, writes mode-0600
 * boundary files atomically, clears provider env values, and reloads the
 * proxy. Missing credentials delete stale files so `require: true` rejects
 * the request.
 *
 * Issue #284: MCP extension OAuth is OUT of the proxy plane entirely — the
 * MCP SDK owns OAuth for hosted MCP calls and tools/list (the runtime's
 * OAuthClientProvider, built from the persisted vault credential), so the
 * sync never reads/writes/probes extension OAuth credentials and never
 * emits `<provider>-oauth.json` blobs. The proxy is transport/allowlist
 * only.
 *
 * The codex provider (issue #214) is special (issue #230): the seed OWNS
 * the codex refresh — it mints the access token itself and writes it to a
 * STATIC secret file (openai-codex.secret) that the egress secrets
 * transform injects; the proxy never touches auth.openai.com for codex.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../fs-atomic";
import { z } from "zod";
import { DEFAULT_MODEL_CATALOG_DIR } from "../models/model-pin";
import { parseYamlSubset } from "../yaml-subset";
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

/** The model-gateway + web-search keys (opencode-go's key-only decl + the three custom gateways + tavily). */
export const MODEL_PROXY_KEYS: readonly ModelProxyKey[] = [
  { provider: "near", envName: "NEAR_API_KEY" },
  { provider: "opencode", envName: "OPENCODE_API_KEY" },
  { provider: "openai", envName: "OPENAI_API_KEY" },
  { provider: "anthropic", envName: "ANTHROPIC_API_KEY" },
  // The Tavily web-search provider key (issue #278): the search_web tool's
  // static secret, seeded like the model gateways and injected by the
  // proxy for api.tavily.com at egress.
  { provider: "tavily", envName: "TAVILY_API_KEY" },
] as const;

/** The proxy-side secret file for a model gateway key. */
export function proxyKeyFileName(provider: string): string {
  return `${provider}.secret`;
}

/**
 * The codex provider's rotation-persistence blob (issue #214 + #230): the
 * seed writes the refreshed access + rotated refresh token here so a later
 * boot re-reads a LIVE grant instead of the CLI auth file's stale one.
 * Extension OAuth blobs are gone under issue #284 (the SDK owns extension
 * OAuth); this file is the CODE X model provider's own persistence only —
 * the proxy never reads it (codex is a STATIC secrets entry).
 */
export function proxyOAuthBlobFileName(provider: string): string {
  return `${provider}-oauth.json`;
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
 * seed owns the refresh); the 403-no-body family (a standalone `403` in
 * the message — the upstream rejecting with no body, e.g. an
 * account-plan denial) remains the codex turn-side fingerprint; the model
 * SDK's error message carries the body text and the driver surfaces it in
 * the session error, so the marker string is the turn-side fingerprint of
 * a dead/denied Codex credential.
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
 * The provider id of a model ref (issue #342): the FIRST path segment of a
 * provider-qualified ref ("near/deepseek-ai/DeepSeek-V4-Flash" → "near",
 * "openai-codex/gpt-5.6-luna" → "openai-codex"), matched against the known
 * model-gateway providers ({@link MODEL_PROXY_KEYS} plus the codex static
 * entry) — the same provider ids the egress generator's MODEL_GATEWAY_KEYS
 * seeds. A bare id, role ref, or unknown provider → undefined (the caller
 * keeps a fail-closed text rather than guessing).
 */
export function providerFromModelRef(modelRef: string | undefined): string | undefined {
  if (modelRef === undefined) return undefined;
  const ref = modelRef.trim();
  if (ref === "") return undefined;
  const known = [...MODEL_PROXY_KEYS.map((k) => k.provider), "openai-codex"] as const;
  return known.find((p) => ref === p || ref.startsWith(`${p}/`));
}

/**
 * A provider-aware credential-failure remedy (issue #342): names the
 * provider and its provisioning env var derived from
 * {@link MODEL_PROXY_KEYS} (e.g. near → "set NEAR_API_KEY"), keeping the
 * fail-closed posture (never an empty or wrong guess, never a secret). A
 * provider absent from the table, or unknown → null, so callers keep
 * their existing text.
 */
export function providerCredentialRemedy(provider: string | undefined): string | null {
  if (provider === undefined) return null;
  const envName = MODEL_PROXY_KEYS.find((k) => k.provider === provider)?.envName;
  const provision = envName
    ? `set ${envName} (or provision it in the auth-broker vault)`
    : "provision it in the auth-broker vault";
  return `Model call failed: no credential for provider ${provider} — ${provision}, then restart the server.`;
}

/**
 * Maps a driver/proxy error message to the user-visible Codex mint-failure
 * reply (issue #218): a dead refresh token must surface the recovery path
 * instead of an empty-response fallback. Matches the proxy's 502 body
 * string ({@link CODEX_MINT_FAILURE_MARKER}) and — ONLY when the active
 * provider is the codex provider (issue #342) — the 403-no-body family (a
 * standalone `403` in the message — the upstream rejecting with no body,
 * e.g. an account-plan denial). A bare 403 for ANY OTHER provider maps to
 * the provider-aware credential remedy ({@link providerCredentialRemedy}),
 * never a false "run codex login". Returns null for anything else, so
 * callers keep their existing text.
 */
export function codexMintFailureText(message: string | undefined, provider?: string): string | null {
  if (message === undefined) return null;
  const trimmed = message.trim();
  if (trimmed === "") return null;
  // The mint marker is codex-specific — it always maps to the Codex remedy.
  if (trimmed.includes(CODEX_MINT_FAILURE_MARKER)) {
    return `Codex auth failed to mint an access token — ${CODEX_MINT_REMEDY}.`;
  }
  if (!/\b403\b/.test(trimmed)) return null;
  // A bare 403 is attributable to the Codex mint/grant family only when the
  // active provider IS codex; otherwise it belongs to the failing provider.
  if (provider === "openai-codex") {
    return `Codex auth failed to mint an access token — ${CODEX_MINT_REMEDY}.`;
  }
  return providerCredentialRemedy(provider);
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
 * every other field, atomically with secure mode 0600. The seed writes the
 * minted token back so the CLI's auth file and the codex blob never diverge,
 * and a later reload/restart re-reads a LIVE token instead of the stale one.
 * A missing or unparseable file is left untouched (the boundary blob still
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
  const mode = 0o600;
  // A Codex auth file contains credentials; never preserve a weaker mode.
  // Preserve the file's formatting style (compact vs pretty) so the CLI's
  // own diffs stay clean; JSON parsing is whitespace-insensitive either way.
  const pretty = /\n\s{2}/.test(raw);
  const out = (pretty ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed)) + "\n";
  writeFileAtomic(authFilePath, out, mode);
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

const codexJwtPayloadSchema = z.object({
  exp: z.number().finite(),
});

type CodexJwtPayload = z.infer<typeof codexJwtPayloadSchema>;

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
    const payloadResult = codexJwtPayloadSchema.safeParse(JSON.parse(payload));
    if (!payloadResult.success) return null;
    const parsed: CodexJwtPayload = payloadResult.data;
    return parsed.exp;
  } catch {
    return null;
  }
}

/** Atomic 0600 write-temp + rename (the #53 boundary pattern). */
function writeSecretFile(secretsDir: string, fileName: string, value: string): void {
  mkdirSync(secretsDir, { recursive: true });
  writeFileAtomic(join(secretsDir, fileName), value, 0o600);
}

/** Deletes a proxy secret file (fail-closed: no stale credential). */
function deleteSecretFile(secretsDir: string, fileName: string): void {
  rmSync(join(secretsDir, fileName), { force: true });
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

/**
 * The provider of a model ref (issue #339): a provider-qualified ref
 * ("openai-codex/gpt-5.6-luna") names the PROVIDER (the segment before the
 * last "/"); a bare id, a role ref, or a bare provider marker ("openai-codex"
 * with no slash) carries none or is handled by the caller. Matches the
 * canary's defaultModelProviderFor split at the last "/".
 */
function providerOfModelRef(modelRef: string | undefined): string | undefined {
  if (!modelRef) return undefined;
  const slash = modelRef.lastIndexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) return undefined;
  return modelRef.slice(0, slash);
}

/**
 * Whether the ACTIVE DEFAULT MODEL is the codex provider (issue #339): the
 * codex auth/mint leg runs ONLY when the configured default resolves to
 * `openai-codex` — a qualified ref ("openai-codex/gpt-5.6-luna"), a bare
 * provider marker ("openai-codex"), or a model whose provider is
 * `openai-codex`. Any other default (near/deepseek, opencode-go, bare ids,
 * role refs), or an UNKNOWN/absent value, is NOT codex-active — the safe
 * default is to never mint.
 */
export function isCodexActiveDefault(activeDefaultModel: string | undefined): boolean {
  if (activeDefaultModel === undefined || activeDefaultModel.trim() === "") return false;
  const ref = activeDefaultModel.trim();
  if (ref === "openai-codex") return true;
  return providerOfModelRef(ref) === "openai-codex";
}

/**
 * Reads the agent dir's config.yml `modelRoles.default` (issue #339): the
 * same pin the SDK/agent resolves its default session model from. Absent or
 * unreadable → undefined (the caller's safe default — never mint when
 * unknown). The agent dir is the deployment default `data/omp-agent`, which
 * the boot roots override with their own resolved agentDir.
 */
export function agentDirModelDefault(agentDir: string): string | undefined {
  try {
    const parsed = parseYamlSubset(readFileSync(join(agentDir, "config.yml"), "utf8"));
    const roles = z.record(z.string(), z.unknown()).safeParse(parsed.modelRoles);
    const defaultParsed = roles.success ? z.string().safeParse(roles.data.default) : undefined;
    const value = defaultParsed?.success ? defaultParsed.data : undefined;
    return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
  } catch {
    return undefined;
  }
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
   * The ACTIVE DEFAULT MODEL (issue #339): a resolved model-role default
   * ref (e.g. "near/deepseek-ai/DeepSeek-V4-Flash" or
   * "openai-codex/gpt-5.6-luna"). The codex auth/mint leg runs ONLY when
   * this resolves to the `openai-codex` provider. When undefined, the sync
   * derives it from the deployment agent-dir config.yml
   * `modelRoles.default`; when that also yields nothing, codex is treated
   * as NOT active (safe default — never mint when unknown).
   */
  activeDefaultModel?: string;
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
  /**
   * Reload fetch seam (tests): performs the POST to the proxy management
   * API. Default: the global `fetch`. Injected so a test can pin the reload
   * outcome to its own stub regardless of whether another test file mutated
   * the GLOBAL `fetch` (test isolation — issue #300): the reload must
   * observe the injected outcome, never a cross-file substitution. Typed as
   * fetch's CALLABLE signature (not `typeof fetch`, which carries the
   * `preconnect` static a plain stub cannot satisfy).
   */
  fetchReload?: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>;
  /** Boot log sink; defaults to console.log. */
  log?: (line: string) => void;
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
 *
 * Issue #284: the sync touches NO MCP extension OAuth credential — no
 * vault OAuth rows, no `<provider>-oauth.json` blobs, no refresh-grant
 * POSTs. Only the model-gateway keys and the codex static credential
 * (the seed's own refresh) land in the proxy plane.
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
  const control = opts.proxyControl ?? proxyBoundaryControlFromEnv(env);
  const fetchReload = opts.fetchReload ?? fetch;

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
    // Issue #343: an EMPTY credential row (an auth-broker vault row holding
    // "", or an empty env var) is not nullish, so `fromVault ?? fromEnv ??`
    // would let it win and shadow a valid lower-precedence source (e.g. a
    // Keychain entry). Each source counts only when its value is non-empty
    // after trim — pick the first non-empty of vault → env → Keychain.
    const value = [fromVault, fromEnv, fromKeychain].find(
      (candidate) => candidate !== null && candidate !== undefined && candidate.trim() !== "",
    ) ?? null;
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

  // 2. Codex static credential (issue #214 + #230) — GATED behind the
  // ACTIVE DEFAULT MODEL (issue #339). The ChatGPT subscription OAuth
  // tokens come from the Codex CLI auth file (CODEX_AUTH_PATH, default
  // ~/.codex/auth.json) — a FILESYSTEM credential, never
  // env/Keychain/vault. The SEED owns the codex refresh (issue #230): it
  // refreshes the grant when the access token is within 24h of its JWT
  // exp, writes the ACCESS token to openai-codex.secret (the egress
  // static secrets injection entry — the proxy never touches
  // auth.openai.com), and writes the rotated refresh token back to the
  // oauth blob + the CLI auth file. A missing/unparseable auth file or a
  // REJECTED grant deletes BOTH boundary files (fail closed — require:
  // true 502s the codex provider until the user logs in with the Codex
  // CLI). The boot path throws on a dead token (loud remedy); the
  // background re-refresh path deletes + logs.
  //
  // Issue #339: this leg runs ONLY when the ACTIVE DEFAULT MODEL is the
  // openai-codex provider. Otherwise the seed never reads ~/.codex/auth.json,
  // never mints/refreshes, never throws the login remedy, and never arms
  // the hourly re-refresh timer — stale openai-codex boundary files are
  // DELETED (fail closed) and the boot proceeds silently.
  const activeDefaultModel = opts.activeDefaultModel ?? agentDirModelDefault(DEFAULT_MODEL_CATALOG_DIR);
  if (!isCodexActiveDefault(activeDefaultModel)) {
    const codexSecretFileName = proxyKeyFileName("openai-codex");
    const codexBlobFileName = proxyOAuthBlobFileName("openai-codex");
    deleteSecretFile(secretsDir, codexSecretFileName);
    deleteSecretFile(secretsDir, codexBlobFileName);
    log(`bottega boot: proxy ${codexSecretFileName} REMOVED — codex provider disabled (default is not codex)`);
  } else {
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
  }

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
    res = await fetchReload(`${control.proxyControlUrl}/v1/reload`, {
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
