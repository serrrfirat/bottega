/**
 * Boot secret seed tests (issue #201): hermetic — an injected vault map
 * and an injected Keychain reader for the precedence chain, plus one
 * end-to-end boot against a REAL fake auth-broker (loopback Bun.serve,
 * schema-valid snapshot): the live boot works with the secrets in the
 * vault and the fail-closed guards stay the last word. No real network,
 * no real Keychain, no Slack.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOT_SECRETS,
  bootSecretForProvider,
  fetchVaultApiKeysFromEnv,
  keychainServiceFor,
  seedBootSecretsFromVault,
} from "./boot-secrets";
import { main } from "./index";

const NO_VAULT = (): Promise<Map<string, string>> => Promise.resolve(new Map());
const NO_KEYCHAIN = (): Promise<string | null> => Promise.resolve(null);
const SILENT = (): void => {};

function freshEnv(): NodeJS.ProcessEnv {
  return {};
}

describe("seedBootSecretsFromVault precedence (issue #201, shrunk #208)", () => {
  test("a vault row seeds the env BEFORE the SDK constructs providers", async () => {
    const env = freshEnv();
    const vault = new Map<string, string>([
      ["slack-app", "xapp-vault"],
      ["slack-bot", "xoxb-vault"],
      ["github-webhook", "gh-webhook-vault"],
    ]);
    await seedBootSecretsFromVault({ env, fetchVault: () => Promise.resolve(vault), readKeychain: NO_KEYCHAIN, log: SILENT });
    expect(env.SLACK_APP_TOKEN).toBe("xapp-vault");
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-vault");
    expect(env.GITHUB_WEBHOOK_SECRET).toBe("gh-webhook-vault");
  });

  test("vault beats env — the source of truth moved to the vault", async () => {
    const env = { SLACK_APP_TOKEN: "xapp-env" };
    const vault = new Map([["slack-app", "xapp-vault"]]);
    await seedBootSecretsFromVault({ env, fetchVault: () => Promise.resolve(vault), readKeychain: NO_KEYCHAIN, log: SILENT });
    expect(env.SLACK_APP_TOKEN).toBe("xapp-vault");
  });

  test("env wins as the fallback when the vault has no row", async () => {
    const env = { SLACK_APP_TOKEN: "xapp-env" };
    await seedBootSecretsFromVault({ env, fetchVault: NO_VAULT, readKeychain: NO_KEYCHAIN, log: SILENT });
    expect(env.SLACK_APP_TOKEN).toBe("xapp-env");
  });

  test("Keychain is the last leg before fail closed (local dev)", async () => {
    const env = freshEnv();
    const keychain = new Map([["bottega-slack-app", "xapp-keychain"]]);
    await seedBootSecretsFromVault({
      env,
      fetchVault: NO_VAULT,
      readKeychain: async (service) => keychain.get(service) ?? null,
      log: SILENT,
    });
    expect(env.SLACK_APP_TOKEN).toBe("xapp-keychain");
    // The slack-bot row exists in the table but has no Keychain entry → unset.
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
  });

  test("missing everywhere leaves the env unset — the existing boot guards fail closed", async () => {
    const env = freshEnv();
    await seedBootSecretsFromVault({ env, fetchVault: NO_VAULT, readKeychain: NO_KEYCHAIN, log: SILENT });
    for (const secret of BOOT_SECRETS) {
      expect(env[secret.envName]).toBeUndefined();
    }
  });

  test("empty-string env values are treated as unset (fall through to Keychain)", async () => {
    const env = { SLACK_BOT_TOKEN: "" };
    await seedBootSecretsFromVault({ env, fetchVault: NO_VAULT, readKeychain: async () => "xoxb-kc", log: SILENT });
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-kc");
  });

  test("the default Keychain reader is gated on BOTTEGA_KEYCHAIN_SEED=1 (tests never read a real Keychain)", async () => {
    // The seed's default reader consults the INJECTED env: no opt-in flag →
    // the leg is inert without spawning `security` (which would read this
    // machine's real Keychain and break hermeticity).
    const env = freshEnv();
    await seedBootSecretsFromVault({ env, fetchVault: NO_VAULT, log: SILENT });
    for (const secret of BOOT_SECRETS) {
      expect(env[secret.envName]).toBeUndefined();
    }
  });

  test("an empty vault api_key row is treated as absent", async () => {
    const env = { SLACK_APP_TOKEN: "xapp-env" };
    const vault = new Map([["slack-app", ""]]);
    await seedBootSecretsFromVault({ env, fetchVault: () => Promise.resolve(vault), readKeychain: NO_KEYCHAIN, log: SILENT });
    expect(env.SLACK_APP_TOKEN).toBe("xapp-env");
  });
});

describe("boot secret identity table (issue #201, shrunk #208)", () => {
  test("every vault provider id maps back to its secret", () => {
    const providers = BOOT_SECRETS.map((s) => s.vaultProvider);
    expect(providers).toEqual([
      "slack-app",
      "slack-bot",
      "github-webhook",
      "bottega-api-token",
      "opencode",
      "near",
      "openai",
      "anthropic",
      "tavily",
    ]);
    for (const provider of providers) {
      expect(bootSecretForProvider(provider)?.vaultProvider).toBe(provider);
    }
    expect(bootSecretForProvider("github")).toBeUndefined();
    // Model provider identities remain provisionable through the upload-link
    // path, but are explicitly excluded from app-environment seeding.
    expect(bootSecretForProvider("near")?.seedAtBoot).toBe(false);
    expect(bootSecretForProvider("opencode")?.seedAtBoot).toBe(false);
  });

  test("Keychain services follow the dev.sh pattern: bottega-<provider>", () => {
    expect(keychainServiceFor(bootSecretForProvider("slack-app")!)).toBe("bottega-slack-app");
    expect(keychainServiceFor(bootSecretForProvider("slack-bot")!)).toBe("bottega-slack-bot");
    expect(keychainServiceFor(bootSecretForProvider("github-webhook")!)).toBe("bottega-github-webhook");
  });
});

describe("live boot with the secrets in the vault (issue #201, shrunk #208)", () => {
  /** A schema-valid broker snapshot (GET /v1/snapshot, wire schemas are strict). */
  function snapshotResponse(entries: unknown[]): string {
    return JSON.stringify({
      generation: 1,
      generatedAt: Date.now(),
      serverNowMs: Date.now(),
      refresher: { enabled: false, intervalMs: 60000, skewMs: 0, nextSweepInMs: 0 },
      credentials: entries,
    });
  }

  /** Fake broker: serves every boot secret as an api_key vault row (the
   * model provider keys are NOT boot secrets since #208 — the proxy holds
   * them, src/extensions/proxy-seed). */
  function fakeBroker() {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname !== "/v1/snapshot") return new Response("not found", { status: 404 });
        return new Response(
          snapshotResponse([
            { id: 1, provider: "slack-app", credential: { type: "api_key", key: "xapp-vault" }, identityKey: null, rotatesInMs: null },
            { id: 2, provider: "slack-bot", credential: { type: "api_key", key: "xoxb-vault" }, identityKey: null, rotatesInMs: null },
            { id: 7, provider: "github-webhook", credential: { type: "api_key", key: "gh-webhook-vault" }, identityKey: null, rotatesInMs: null },
          ]),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  interface BootEnv {
    dir: string;
    cleanup(): void;
  }

  /** Temp deployment root: broker env → the fake vault, every boot secret
   * absent from env, a models.yml the #80 guard can satisfy ONLY from the
   * seeded keys. */
  function tempEnv(brokerUrl: string): BootEnv {
    const dir = mkdtempSync(join(tmpdir(), "bottega-boot-secrets-"));
    const saved = {
      cwd: process.cwd(),
      app: process.env.SLACK_APP_TOKEN,
      bot: process.env.SLACK_BOT_TOKEN,
      opencode: process.env.OPENCODE_API_KEY,
      near: process.env.NEAR_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      githubWebhook: process.env.GITHUB_WEBHOOK_SECRET,
      brokerUrl: process.env.OMP_AUTH_BROKER_URL,
      brokerToken: process.env.OMP_AUTH_BROKER_TOKEN,
      snapshotTtl: process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS,
      configDir: process.env.BOTTEGA_CONFIG_DIR,
      dbPath: process.env.BOTTEGA_DB_PATH,
      callbackPort: process.env.BOTTEGA_CALLBACK_PORT,
    };
    process.chdir(dir);
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "kb.yml"), "sources:\n");
    process.env.OMP_AUTH_BROKER_URL = brokerUrl;
    process.env.OMP_AUTH_BROKER_TOKEN = "test-broker-token";
    // Force a fresh snapshot fetch — never a cached one from another test.
    process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "0";
    // The browser-leg listener (startOAuthCallbackServer) must never inherit
    // the live .env's BOTTEGA_CALLBACK_PORT — the harness dev server holds
    // it, so booting against it is EADDRINUSE. Pin 0 (ephemeral, the #209
    // default) like every other setup knob this fixture scrubs.
    process.env.BOTTEGA_CALLBACK_PORT = "0";
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.NEAR_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.BOTTEGA_CONFIG_DIR;
    delete process.env.BOTTEGA_DB_PATH;
    return {
      dir,
      cleanup() {
        process.chdir(saved.cwd);
        if (saved.app === undefined) delete process.env.SLACK_APP_TOKEN;
        else process.env.SLACK_APP_TOKEN = saved.app;
        if (saved.bot === undefined) delete process.env.SLACK_BOT_TOKEN;
        else process.env.SLACK_BOT_TOKEN = saved.bot;
        if (saved.opencode === undefined) delete process.env.OPENCODE_API_KEY;
        else process.env.OPENCODE_API_KEY = saved.opencode;
        if (saved.near === undefined) delete process.env.NEAR_API_KEY;
        else process.env.NEAR_API_KEY = saved.near;
        if (saved.openai === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = saved.openai;
        if (saved.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved.anthropic;
        if (saved.githubWebhook === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
        else process.env.GITHUB_WEBHOOK_SECRET = saved.githubWebhook;
        if (saved.brokerUrl === undefined) delete process.env.OMP_AUTH_BROKER_URL;
        else process.env.OMP_AUTH_BROKER_URL = saved.brokerUrl;
        if (saved.brokerToken === undefined) delete process.env.OMP_AUTH_BROKER_TOKEN;
        else process.env.OMP_AUTH_BROKER_TOKEN = saved.brokerToken;
        if (saved.snapshotTtl === undefined) delete process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS;
        else process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = saved.snapshotTtl;
        if (saved.configDir === undefined) delete process.env.BOTTEGA_CONFIG_DIR;
        else process.env.BOTTEGA_CONFIG_DIR = saved.configDir;
        if (saved.dbPath === undefined) delete process.env.BOTTEGA_DB_PATH;
        else process.env.BOTTEGA_DB_PATH = saved.dbPath;
        if (saved.callbackPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
        else process.env.BOTTEGA_CALLBACK_PORT = saved.callbackPort;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  const MODEL_AGENT_YML =
    "providers:\n" +
    "  opencode-go:\n" +
    "    apiKey: bottega-proxy-placeholder\n" +
    "  near:\n" +
    "    api: openai-completions\n" +
    "    baseUrl: \"https://cloud-api.near.ai/v1\"\n" +
    "    apiKey: bottega-proxy-placeholder\n" +
    "    models:\n" +
    "      - id: deepseek-ai/DeepSeek-V4-Flash\n" +
    "        name: DeepSeek V4 Flash via NEAR AI Cloud\n" +
    "        contextWindow: 128000\n" +
    "        maxTokens: 8192\n";

  test("main() boots with the secrets in the vault + the placeholder models.yml and NO provider keys — the #80 guard passes on the placeholders (issue #208)", async () => {
    const broker = fakeBroker();
    const env = tempEnv(broker.url);
    try {
      const agentDir = join(env.dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "models.yml"), MODEL_AGENT_YML);
      const server = await main({ agentDir });
      try {
        // The Slack guard passed with NOTHING in env before the boot — the
        // vault seeded the channel secrets…
        expect(process.env.SLACK_APP_TOKEN).toBe("xapp-vault");
        expect(process.env.SLACK_BOT_TOKEN).toBe("xoxb-vault");
        expect(process.env.GITHUB_WEBHOOK_SECRET).toBe("gh-webhook-vault");
        // …and the #80 model-key guard passed on the PROXY PLACEHOLDERS:
        // the model provider env keys are NOT boot secrets anymore (#208)
        // — the app process never holds a live key; the proxy does.
        expect(process.env.NEAR_API_KEY).toBeUndefined();
        expect(process.env.OPENCODE_API_KEY).toBeUndefined();
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      } finally {
        await server.stop();
      }
    } finally {
      env.cleanup();
      broker.stop();
    }
  });
});

describe("fetchVaultApiKeysFromEnv error legs (issue #201)", () => {
  test("a configured-but-unreachable broker yields an empty map — never a boot failure", async () => {
    // Bind a listener, grab its port, then stop it so connect is refused —
    // the exact "broker is down" failure a stale deployment sees.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("", { status: 500 }) });
    const url = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);
    const env = { OMP_AUTH_BROKER_URL: url, OMP_AUTH_BROKER_TOKEN: "t" };
    const keys = await fetchVaultApiKeysFromEnv(env);
    expect(keys.size).toBe(0);
  });

  test("a broker that returns a non-200 snapshot yields an empty map and does not throw", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("unavailable", { status: 503 }),
    });
    try {
      const env = { OMP_AUTH_BROKER_URL: `http://127.0.0.1:${server.port}`, OMP_AUTH_BROKER_TOKEN: "t" };
      const keys = await fetchVaultApiKeysFromEnv(env);
      expect(keys.size).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("missing broker env is the no-op default (no network touched)", async () => {
    const keys = await fetchVaultApiKeysFromEnv({});
    expect(keys.size).toBe(0);
  });
});
