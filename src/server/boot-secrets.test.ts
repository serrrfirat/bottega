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

describe("seedBootSecretsFromVault precedence (issue #201)", () => {
  test("a vault row seeds the env BEFORE the SDK constructs providers", async () => {
    const env = freshEnv();
    const vault = new Map<string, string>([
      ["slack-app", "xapp-vault"],
      ["slack-bot", "xoxb-vault"],
      ["opencode", "sk-opencode-vault"],
      ["near", "near-vault-key"],
      ["openai", "sk-openai-vault"],
      ["anthropic", "sk-anthropic-vault"],
      ["github-webhook", "gh-webhook-vault"],
    ]);
    await seedBootSecretsFromVault({ env, fetchVault: () => Promise.resolve(vault), readKeychain: NO_KEYCHAIN, log: SILENT });
    expect(env.SLACK_APP_TOKEN).toBe("xapp-vault");
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-vault");
    expect(env.OPENCODE_API_KEY).toBe("sk-opencode-vault");
    expect(env.NEAR_API_KEY).toBe("near-vault-key");
    expect(env.OPENAI_API_KEY).toBe("sk-openai-vault");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-anthropic-vault");
    expect(env.GITHUB_WEBHOOK_SECRET).toBe("gh-webhook-vault");
  });

  test("vault beats env — the source of truth moved to the vault", async () => {
    const env = { NEAR_API_KEY: "env-key" };
    const vault = new Map([["near", "vault-key"]]);
    await seedBootSecretsFromVault({ env, fetchVault: () => Promise.resolve(vault), readKeychain: NO_KEYCHAIN, log: SILENT });
    expect(env.NEAR_API_KEY).toBe("vault-key");
  });

  test("env wins as the fallback when the vault has no row", async () => {
    const env = { NEAR_API_KEY: "env-key", SLACK_APP_TOKEN: "xapp-env" };
    await seedBootSecretsFromVault({ env, fetchVault: NO_VAULT, readKeychain: NO_KEYCHAIN, log: SILENT });
    expect(env.NEAR_API_KEY).toBe("env-key");
    expect(env.SLACK_APP_TOKEN).toBe("xapp-env");
  });

  test("Keychain is the last leg before fail closed (local dev)", async () => {
    const env = freshEnv();
    const keychain = new Map([["bottega-near", "keychain-near"]]);
    await seedBootSecretsFromVault({
      env,
      fetchVault: NO_VAULT,
      readKeychain: async (service) => keychain.get(service) ?? null,
      log: SILENT,
    });
    expect(env.NEAR_API_KEY).toBe("keychain-near");
    // The opencode row exists in the table but has no Keychain entry → unset.
    expect(env.OPENCODE_API_KEY).toBeUndefined();
  });

  test("missing everywhere leaves the env unset — the existing boot guards fail closed", async () => {
    const env = freshEnv();
    await seedBootSecretsFromVault({ env, fetchVault: NO_VAULT, readKeychain: NO_KEYCHAIN, log: SILENT });
    for (const secret of BOOT_SECRETS) {
      expect(env[secret.envName]).toBeUndefined();
    }
  });

  test("empty-string env values are treated as unset (fall through to Keychain)", async () => {
    const env = { NEAR_API_KEY: "" };
    await seedBootSecretsFromVault({ env, fetchVault: NO_VAULT, readKeychain: async () => "kc-key", log: SILENT });
    expect(env.NEAR_API_KEY).toBe("kc-key");
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
    const env = { NEAR_API_KEY: "env-key" };
    const vault = new Map([["near", ""]]);
    await seedBootSecretsFromVault({ env, fetchVault: () => Promise.resolve(vault), readKeychain: NO_KEYCHAIN, log: SILENT });
    expect(env.NEAR_API_KEY).toBe("env-key");
  });
});

describe("boot secret identity table (issue #201)", () => {
  test("every vault provider id maps back to its secret", () => {
    const providers = BOOT_SECRETS.map((s) => s.vaultProvider);
    expect(providers).toEqual([
      "slack-app",
      "slack-bot",
      "opencode",
      "near",
      "openai",
      "anthropic",
      "github-webhook",
    ]);
    for (const provider of providers) {
      expect(bootSecretForProvider(provider)?.vaultProvider).toBe(provider);
    }
    expect(bootSecretForProvider("github")).toBeUndefined();
  });

  test("Keychain services follow the dev.sh pattern: bottega-<provider>", () => {
    expect(keychainServiceFor(bootSecretForProvider("near")!)).toBe("bottega-near");
    expect(keychainServiceFor(bootSecretForProvider("opencode")!)).toBe("bottega-opencode");
    expect(keychainServiceFor(bootSecretForProvider("slack-app")!)).toBe("bottega-slack-app");
  });
});

describe("live boot with the secrets in the vault (issue #201)", () => {
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

  /** Fake broker: serves every boot secret as an api_key vault row. */
  function fakeBroker() {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname !== "/v1/snapshot") return new Response("not found", { status: 404 });
        return new Response(
          snapshotResponse([
            { id: 1, provider: "slack-app", credential: { type: "api_key", key: "xapp-vault" }, identityKey: null, rotatesInMs: null },
            { id: 2, provider: "slack-bot", credential: { type: "api_key", key: "xoxb-vault" }, identityKey: null, rotatesInMs: null },
            { id: 3, provider: "opencode", credential: { type: "api_key", key: "sk-opencode-vault" }, identityKey: null, rotatesInMs: null },
            { id: 4, provider: "near", credential: { type: "api_key", key: "near-vault-key" }, identityKey: null, rotatesInMs: null },
            { id: 5, provider: "openai", credential: { type: "api_key", key: "sk-openai-vault" }, identityKey: null, rotatesInMs: null },
            { id: 6, provider: "anthropic", credential: { type: "api_key", key: "sk-anthropic-vault" }, identityKey: null, rotatesInMs: null },
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
    "    apiKey: OPENCODE_API_KEY\n" +
    "  near:\n" +
    "    api: openai-completions\n" +
    "    baseUrl: \"https://cloud-api.near.ai/v1\"\n" +
    "    apiKey: NEAR_API_KEY\n" +
    "    models:\n" +
    "      - id: zai-org/GLM-5.1-FP8\n" +
    "        name: GLM 5.1 FP8 via NEAR AI Cloud\n" +
    "        contextWindow: 128000\n" +
    "        maxTokens: 8192\n";

  test("main() boots with every secret in the vault and none in env — the seed ran before the SDK constructed providers", async () => {
    const broker = fakeBroker();
    const env = tempEnv(broker.url);
    try {
      const agentDir = join(env.dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "models.yml"), MODEL_AGENT_YML);
      const server = await main({ agentDir });
      try {
        // The Slack guard passed AND the #80 model-key guard passed with
        // NOTHING in env before the boot — the vault seeded everything.
        expect(process.env.SLACK_APP_TOKEN).toBe("xapp-vault");
        expect(process.env.SLACK_BOT_TOKEN).toBe("xoxb-vault");
        expect(process.env.OPENCODE_API_KEY).toBe("sk-opencode-vault");
        expect(process.env.NEAR_API_KEY).toBe("near-vault-key");
        expect(process.env.OPENAI_API_KEY).toBe("sk-openai-vault");
        expect(process.env.ANTHROPIC_API_KEY).toBe("sk-anthropic-vault");
        expect(process.env.GITHUB_WEBHOOK_SECRET).toBe("gh-webhook-vault");
      } finally {
        await server.stop();
      }
    } finally {
      env.cleanup();
      broker.stop();
    }
  });
});
