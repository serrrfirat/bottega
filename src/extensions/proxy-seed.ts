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
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { REMOTE_REFRESH_SENTINEL } from "@oh-my-pi/pi-ai";
import { OAUTH_TOKEN_ENDPOINTS, oauthTokenBlobFileName } from "../egress/generate";
import { PROXY_SECRETS_DIR, proxyBoundaryControlFromEnv } from "./boundary";
import { errorMessage } from "../tools/helpers";
import { fetchVaultApiKeysFromEnv, keychainReaderFromEnv, keychainServiceFor } from "../server/boot-secrets";
import type { BootSecret } from "../server/boot-secrets";

/**
 * The model-gateway keys the sync writes (issue #208): one `<provider>.secret`
 * file per gateway, mirroring the egress generator's MODEL_GATEWAY_KEYS
 * (provider ids must match — the generated config reads exactly these
 * files). The env name is the same one models.yml historically referenced
 * (dev.sh's Keychain load) and the vault provider identity is the #201
 * row id.
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
 * row (the #198 flow), the client credentials from env (the org's
 * registered client — the #198 dynamic-client-registration flow does not
 * persist the registered client id, so the deployment provides it).
 */
export interface OAuthProxyCredential {
  provider: string;
  /** Env var holding the OAuth client id (required for the refresh grant). */
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

/** The proxy-side secret file for a model gateway key. */
export function proxyKeyFileName(provider: string): string {
  return `${provider}.secret`;
}

/** The proxy-side OAuth blob for a provider (the tokens entry's json_key file). */
export function proxyOAuthBlobFileName(provider: string): string {
  return oauthTokenBlobFileName(provider);
}

/**
 * The codex provider's filesystem credential (issue #214): the ChatGPT
 * subscription OAuth tokens come from the Codex CLI's auth file — the
 * default `~/.codex/auth.json`, overridable with `CODEX_AUTH_PATH` (the
 * same env var the canary resolution gates on). Only the ACCESS + REFRESH
 * tokens are read; the id_token and other fields never enter the app.
 */
export const CODEX_AUTH_FILE_ENV = "CODEX_AUTH_PATH";
export const CODEX_AUTH_FILE_DEFAULT = "~/.codex/auth.json";
/**
 * The Codex public OAuth client id (the openai/codex CLI's login client —
 * verified from the OAuth flow; the refresh grant at
 * https://auth.openai.com/oauth/token uses it, see OAUTH_TOKEN_ENDPOINTS).
 */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

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
 * The iron-proxy `oauth_token` transform's mint-failure marker (issue
 * #218), verified from the iron-proxy v0.49.0 source + binary: when the
 * refresh grant cannot mint, the transform 502s the request with
 * `{"error":"oauth_token failed to mint an access token","grant":"..."}`
 * (`require: true` — fail closed, never an unauthenticated upstream call).
 * The model SDK's error message carries that body text; the driver
 * surfaces it in the session error, so this string is the turn-side
 * fingerprint of a dead/rotated Codex refresh token.
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
 * One Codex refresh-grant probe outcome (issue #218): the token endpoint's
 * verdict on the seeded refresh token, plus the refresh token to persist —
 * the endpoint's rotation when it returned one, else the probed token.
 */
export interface CodexMintOutcome {
  /** True when the token endpoint accepted the refresh grant (HTTP 2xx). */
  minted: boolean;
  /** The endpoint's HTTP status on a rejected grant; undefined on transport errors. */
  status?: number;
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
 * The default Codex mint probe (issue #218): POSTs the refresh grant to
 * the Codex token endpoint with the Codex public client id and reports the
 * verdict. A 2xx response's `refresh_token` (rotation) is returned for
 * write-back. Under the test runner this is a no-op success — hermetic
 * tests never touch the network (the #191 isolation rule); the probe's own
 * tests inject the seam.
 */
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
  let rotated = input.refreshToken;
  try {
    const parsed = (await res.json()) as { refresh_token?: unknown };
    if (typeof parsed.refresh_token === "string" && parsed.refresh_token !== "") {
      rotated = parsed.refresh_token;
    }
  } catch {
    // A 2xx with a non-JSON body still minted; keep the probed token.
  }
  return { minted: true, refreshToken: rotated };
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
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const tokens = (parsed.tokens ??= {}) as Record<string, unknown>;
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
export function readCodexAuthTokens(authFilePath: string): CodexAuthTokens | null {
  let raw: string;
  try {
    raw = readFileSync(authFilePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown; refresh_token?: unknown } };
    const accessToken = parsed.tokens?.access_token;
    const refreshToken = parsed.tokens?.refresh_token;
    if (typeof accessToken !== "string" || accessToken === "") return null;
    if (typeof refreshToken !== "string" || refreshToken === "") return null;
    return { accessToken, refreshToken };
  } catch {
    return null;
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
   * OAuth vault-row seam (tests): provider → the newest oauth credential
   * rows (real refresh token locally; sentinel remotely). Default: the
   * local AuthStorage (discoverAuthStorage → listStoredCredentials).
   */
  readOAuthRows?: (provider: string) => Promise<Array<{ refresh?: string }>>;
  /**
   * Codex mint-probe seam (issue #218): verifies the refresh token mints
   * BEFORE the blob is written — a dead token fails the boot loudly with
   * the remedy instead of being seeded silently. Default: a real
   * refresh-grant POST to the Codex token endpoint (a no-op success under
   * the test runner — the #191 isolation rule). Tests stub it.
   */
  mintCodexRefreshToken?: CodexMintProbe;
  /** Proxy management API base + bearer (the reload half); default from env. */
  proxyControl?: { proxyControlUrl?: string; proxyControlToken?: string };
  /** Boot log sink; defaults to console.log. */
  log?: (line: string) => void;
}

/** The default OAuth-row reader: the local AuthStorage (the #198 store). */
async function readOAuthRowsFromLocalStorage(provider: string): Promise<Array<{ refresh?: string }>> {
  const storage = await discoverAuthStorage();
  try {
    await storage.reload();
    return storage
      .listStoredCredentials(provider)
      .flatMap((entry) => (entry.credential.type === "oauth" ? [{ refresh: entry.credential.refresh }] : []));
  } finally {
    storage.close();
  }
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
  const readOAuthRows = opts.readOAuthRows ?? readOAuthRowsFromLocalStorage;
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
  //    env's client credentials) → `<provider>-oauth.json` (or delete).
  for (const credential of OAUTH_PROXY_CREDENTIALS) {
    const fileName = proxyOAuthBlobFileName(credential.provider);
    const rows = await readOAuthRows(credential.provider);
    const refresh = rows.find(
      (row) => row.refresh !== undefined && row.refresh !== "" && row.refresh !== REMOTE_REFRESH_SENTINEL,
    )?.refresh;
    if (refresh === undefined) {
      deleteSecretFile(secretsDir, fileName);
      delete env[credential.clientIdEnv];
      if (credential.clientSecretEnv !== undefined) delete env[credential.clientSecretEnv];
      log(`bottega boot: proxy ${fileName} REMOVED — no OAuth row for ${credential.provider} (fail closed)`);
      continue;
    }
    const clientId = env[credential.clientIdEnv];
    if (clientId === undefined || clientId === "") {
      // Fail closed: the refresh grant cannot mint without a client id.
      deleteSecretFile(secretsDir, fileName);
      if (credential.clientSecretEnv !== undefined) delete env[credential.clientSecretEnv];
      log(
        `bottega boot: proxy ${fileName} REMOVED — ${credential.provider} refresh token exists but ${credential.clientIdEnv} is unset (fail closed)`,
      );
      continue;
    }
    const blob: Record<string, string> = { refresh_token: refresh, client_id: clientId };
    const clientSecret = credential.clientSecretEnv !== undefined ? env[credential.clientSecretEnv] : undefined;
    if (clientSecret !== undefined && clientSecret !== "") blob.client_secret = clientSecret;
    writeSecretFile(secretsDir, fileName, JSON.stringify(blob));
    delete env[credential.clientIdEnv];
    if (credential.clientSecretEnv !== undefined) delete env[credential.clientSecretEnv];
    log(`bottega boot: proxy ${fileName} seeded (${credential.provider} OAuth refresh token)`);
  }

  // 2.5. Codex subscription blob (issue #214): the ChatGPT subscription
  // OAuth tokens come from the Codex CLI auth file (CODEX_AUTH_PATH, default
  // ~/.codex/auth.json) — a FILESYSTEM credential, never env/Keychain/vault.
  // The tokens (access + refresh) land in the proxy's openai-codex-oauth.json
  // boundary blob (the egress oauth_token transform mints the live bearer
  // at egress); nothing enters the app env. A missing/unparseable auth
  // file DELETES the blob (fail closed — require: true 502s the codex
  // provider until the user logs in with the Codex CLI).
  {
    const codexFileName = proxyOAuthBlobFileName("openai-codex");
    const codexAuthPath = codexAuthFilePathFromEnv(env);
    if (codexAuthPath === null) {
      deleteSecretFile(secretsDir, codexFileName);
      log(
        `bottega boot: proxy ${codexFileName} REMOVED — no Codex auth file ` +
          `(set ${CODEX_AUTH_FILE_ENV} or log in with the Codex CLI to create ~/.codex/auth.json; fail closed)`,
      );
    } else {
      const codexTokens = readCodexAuthTokens(codexAuthPath);
      if (codexTokens === null) {
        deleteSecretFile(secretsDir, codexFileName);
        log(
          `bottega boot: proxy ${codexFileName} REMOVED — Codex auth file unreadable ` +
            `(set ${CODEX_AUTH_FILE_ENV} or log in with the Codex CLI to create ~/.codex/auth.json; fail closed)`,
        );
      } else {
        // Issue #218: verify the refresh token mints BEFORE seeding it. A
        // dead token (the endpoint rejects the grant) must fail the boot
        // loudly with the remedy — never a silent write of a credential
        // that 502s every turn. Transport errors / 5xx / 429 are transient
        // or unverifiable, not dead: warn and write (the runtime mint
        // failure still surfaces the same remedy loudly in the turn).
        const mintProbe = opts.mintCodexRefreshToken ?? probeCodexMint;
        const probe = await mintProbe({
          refreshToken: codexTokens.refreshToken,
          clientId: CODEX_OAUTH_CLIENT_ID,
          tokenEndpoint: OAUTH_TOKEN_ENDPOINTS.codex,
        });
        if (!probe.minted && probe.status !== undefined && probe.status >= 400 && probe.status < 500 && probe.status !== 429) {
          deleteSecretFile(secretsDir, codexFileName);
          throw new Error(
            `bottega boot: Codex refresh token REJECTED (HTTP ${probe.status}) — ${CODEX_MINT_REMEDY} ` +
              `(issue #218: the refresh grant failed; the token is stale or was rotated by the proxy's oauth_token transform without a write-back)`,
          );
        }
        if (!probe.minted) {
          log(
            `bottega boot: proxy ${codexFileName} Codex mint probe could not verify the refresh token ` +
              `(${probe.status === undefined ? "token endpoint unreachable" : `HTTP ${probe.status}`}) — writing the blob unverified; ` +
              "any egress mint failure surfaces the remedy in the turn",
          );
        }
        const blob = {
          access_token: codexTokens.accessToken,
          refresh_token: probe.refreshToken,
          client_id: CODEX_OAUTH_CLIENT_ID,
        };
        writeSecretFile(secretsDir, codexFileName, JSON.stringify(blob));
        if (probe.refreshToken !== codexTokens.refreshToken) {
          // Rotation write-back (issue #218): the endpoint rotated the
          // refresh token. The proxy's oauth_token transform rotates in
          // memory only (x/oauth2, verified from the iron-proxy v0.49.0
          // source) — persist the minted token to the CLI's auth file too,
          // so a reload/restart re-reads a LIVE token instead of the
          // rotated-away one.
          writeCodexAuthTokens(codexAuthPath, probe.refreshToken);
          log(
            `bottega boot: proxy ${codexFileName} seeded (Codex OAuth tokens; refresh token rotated by the mint probe — ` +
              `wrote back to ${codexAuthPath})`,
          );
        } else {
          log(`bottega boot: proxy ${codexFileName} seeded (Codex subscription OAuth tokens; refresh grant verified)`);
        }
      }
    }
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
