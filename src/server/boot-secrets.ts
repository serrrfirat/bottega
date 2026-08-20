/**
 * Boot-time secret seeding (issue #201, shrunk #208): the boot resolves the
 * secrets the Slack adapter and the GitHub webhook verifier read — the
 * Slack tokens + the webhook shared secret — from the auth-broker vault
 * BEFORE the SDK constructs providers, with precedence **vault → env →
 * Keychain (local dev, opt-in) → fail closed**, and seeds `process.env`
 * so the Slack adapter sees ONE source of truth. The model provider keys
 * are NOT boot secrets anymore: since #208 the app's models.yml carries
 * only the proxy placeholder and iron-proxy injects the real keys at
 * egress (src/extensions/proxy-seed.ts seeds them into the proxy).
 *
 * The vault row identity is the broker's provider key: each secret maps to
 * a stable provider id (`slack-app`, `slack-bot`, `github-webhook`) — the
 * SAME ids the `connect_upload_link` provisioning path stores
 * (src/extensions/upload-link.ts) and the same shape as the Keychain
 * services (`bottega-<provider>`, the dev.sh pattern).
 *
 * Precedence per secret:
 *   1. **vault** — an api_key row for the provider in the auth-broker
 *      snapshot (`OMP_AUTH_BROKER_URL`/`OMP_AUTH_BROKER_TOKEN` — the same
 *      env contract as the #190 secret resolver). A configured-but-
 *      unreachable broker logs a warning and falls through: the boot
 *      guards (the Slack "required" check) still fail the boot per
 *      secret, so a missing-everywhere secret is never a half boot.
 *   2. **env** — the value already set (`.env`, dev.sh's Keychain load).
 *   3. **Keychain** — macOS `security` lookup of `bottega-<provider>`,
 *      ONLY when `BOTTEGA_KEYCHAIN_SEED=1` opts in (bare local runs
 *      without dev.sh; hermetic tests and deployment never read the
 *      developer's Keychain).
 *   4. **unset** — the existing boot guards fail with their unchanged
 *      messages.
 *
 * Every composition root (src/server/index.ts, src/executor.ts,
 * src/mcp/server.ts — the #172 parity set) calls this before constructing
 * anything else, then the proxy credential sync
 * (src/extensions/proxy-seed.ts). Secret VALUES are never logged — only
 * names + source.
 */
import { execFileSync } from "node:child_process";
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import { errorMessage } from "../tools/helpers";

/** One boot secret: the env name the SDK/adapter reads + the vault row identity. */
export interface BootSecret {
  envName: string;
  /** The auth-broker vault provider row identity (stable, documented). */
  vaultProvider: string;
  /** Human label for provisioning feedback and the upload form. */
  label: string;
  /** False when the id is provisionable here but consumed by iron-proxy. */
  seedAtBoot?: boolean;
}

/**
 * Provisionable secret identities. Slack and the webhook secret seed the
 * app environment. Model keys remain provisionable through the same
 * upload-link path but are consumed by the iron-proxy sync instead.
 */
export const BOOT_SECRETS: readonly BootSecret[] = [
  { envName: "SLACK_APP_TOKEN", vaultProvider: "slack-app", label: "Slack app-level token" },
  { envName: "SLACK_BOT_TOKEN", vaultProvider: "slack-bot", label: "Slack bot token" },
  { envName: "GITHUB_WEBHOOK_SECRET", vaultProvider: "github-webhook", label: "GitHub webhook shared secret" },
  { envName: "OPENCODE_API_KEY", vaultProvider: "opencode", label: "OpenCode model key", seedAtBoot: false },
  { envName: "NEAR_API_KEY", vaultProvider: "near", label: "NEAR model key", seedAtBoot: false },
  { envName: "OPENAI_API_KEY", vaultProvider: "openai", label: "OpenAI model key", seedAtBoot: false },
  { envName: "ANTHROPIC_API_KEY", vaultProvider: "anthropic", label: "Anthropic model key", seedAtBoot: false },
  { envName: "TAVILY_API_KEY", vaultProvider: "tavily", label: "Tavily web search key", seedAtBoot: false },
];

/** The boot secret with the given vault provider identity, if any. */
export function bootSecretForProvider(provider: string): BootSecret | undefined {
  return BOOT_SECRETS.find((secret) => secret.vaultProvider === provider);
}

/** macOS Keychain service for a boot secret (local dev): `bottega-<provider>`. */
export function keychainServiceFor(secret: BootSecret): string {
  return `bottega-${secret.vaultProvider}`;
}

/** Boot-time vault fetch timeout: a stale broker must not stall the boot. */
const BOOT_VAULT_FETCH_TIMEOUT_MS = 5_000;

/**
 * The default vault fetch: the auth-broker snapshot keyed by provider.
 * Broker env missing → empty map (the server boots without broker env; the
 * #190 boundary fails closed per extension call). A configured-but-
 * unreachable broker logs a warning and returns empty — the boot guards
 * remain the fail-closed arbiter per secret.
 */
export async function fetchVaultApiKeysFromEnv(env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const url = env.OMP_AUTH_BROKER_URL;
  const token = env.OMP_AUTH_BROKER_TOKEN;
  if (!url || !token) return new Map();
  try {
    const client = new AuthBrokerClient({ url, token, timeoutMs: BOOT_VAULT_FETCH_TIMEOUT_MS });
    const result = await client.fetchSnapshot();
    if (result.status !== 200) {
      console.warn(`bottega boot: auth-broker vault snapshot returned status ${result.status} — skipping the vault leg`);
      return new Map();
    }
    const keys = new Map<string, string>();
    for (const entry of result.snapshot.credentials) {
      if (entry.credential.type === "api_key" && entry.credential.key) {
        keys.set(entry.provider, entry.credential.key);
      }
    }
    return keys;
  } catch (err) {
    console.warn(
      `bottega boot: auth-broker vault fetch failed (${errorMessage(err)}) — skipping the vault leg; ` +
        `the boot guards still fail closed on missing secrets`,
    );
    return new Map();
  }
}

/**
 * The default Keychain reader (local-dev leg): macOS `security` lookup of
 * `bottega-<provider>`, gated on `BOTTEGA_KEYCHAIN_SEED=1` — hermetic
 * tests and deployment never read the developer's Keychain, and dev.sh
 * already loads the Keychain into env itself (the env leg covers it). A
 * missing entry (or a non-darwin host) → null, so the chain falls through
 * to the boot guards.
 */
export function keychainReaderFromEnv(env: NodeJS.ProcessEnv): (service: string) => Promise<string | null> {
  if (env.BOTTEGA_KEYCHAIN_SEED !== "1" || process.platform !== "darwin") {
    return async () => null;
  }
  return async (service: string): Promise<string | null> => {
    try {
      const value = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: BOOT_VAULT_FETCH_TIMEOUT_MS,
      }).trim();
      return value === "" ? null : value;
    } catch {
      return null; // no entry (or no `security` binary) → next leg / fail closed
    }
  };
}

export interface BootSecretSeedOpts {
  /** The env to seed; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Vault fetch seam (tests): provider → api_key secret. Default: the
   * auth-broker snapshot via {@link fetchVaultApiKeysFromEnv}.
   */
  fetchVault?: () => Promise<Map<string, string>>;
  /**
   * Keychain seam (tests). Default: {@link keychainReaderFromEnv} — gated
   * on BOTTEGA_KEYCHAIN_SEED=1 so hermetic tests never read a real
   * Keychain.
   */
  readKeychain?: (service: string) => Promise<string | null>;
  /**
   * Env names to leave untouched by the seed (issue #101): the per-job
   * sandbox child must never receive the Slack/webhook secrets, so its
   * boot skips the providers that seed them (SLACK_APP_TOKEN,
   * SLACK_BOT_TOKEN, GITHUB_WEBHOOK_SECRET).
   */
  skipEnvNames?: readonly string[];
  /** Boot log sink; defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * The seed (issue #201): for each boot secret, resolve vault → env →
 * Keychain (local dev) → leave unset (the existing boot guards fail
 * closed). Runs BEFORE the SDK constructs providers — every composition
 * root calls this first. Never logs secret values.
 */
export async function seedBootSecretsFromVault(opts: BootSecretSeedOpts = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const fetchVault = opts.fetchVault ?? (() => fetchVaultApiKeysFromEnv(env));
  const readKeychain = opts.readKeychain ?? keychainReaderFromEnv(env);
  const vault = await fetchVault();
  for (const secret of BOOT_SECRETS) {
    if (secret.seedAtBoot === false) continue;
    if (opts.skipEnvNames?.includes(secret.envName)) continue;
    // 1. Vault (the source of truth): beats env/Keychain when a row exists.
    const fromVault = vault.get(secret.vaultProvider);
    if (fromVault !== undefined && fromVault !== "") {
      env[secret.envName] = fromVault;
      log(`bottega boot: ${secret.envName} seeded from the auth-broker vault`);
      continue;
    }
    // 2. Env: the fallback when the vault has no row — never clobbered.
    const existing = env[secret.envName];
    if (existing !== undefined && existing.trim() !== "") continue;
    // 3. Keychain (local dev, opt-in): the last leg before fail closed.
    const keychain = await readKeychain(keychainServiceFor(secret));
    if (keychain !== null && keychain !== "") {
      env[secret.envName] = keychain;
      log(`bottega boot: ${secret.envName} seeded from the macOS Keychain (${keychainServiceFor(secret)})`);
    }
    // 4. Unset → the existing boot guards (Slack "required") fail the
    //    boot with their unchanged messages. (The #80 model guard is
    //    unaffected: models.yml carries the placeholder, so the SDK's
    //    available-model count never depends on these secrets.)
  }
}
