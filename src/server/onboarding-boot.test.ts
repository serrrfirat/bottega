/**
 * Boot-time onboarding guide test (issue #116).
 *
 * main() runs the shared first-run checks at boot; when any check fails AND
 * an onboarding space is configured (org settings onboarding.space_id), it
 * posts ONE guided message naming the failing checks with a pointer to the
 * first_run_wizard, and audits admin.onboarding_boot. Driven against a REAL
 * main() in a temp cwd (fresh store pre-seeded with settings, temp agent
 * dir override, fake postOnboardingGuide seam), so the whole boot path is
 * exercised — the same shape as the models.yml boot tests (#67).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../store/db";
import { ADMIN_ONBOARDING_BOOT_EVENT } from "../store/audit-events";
import { main } from "./index";

interface BootEnv {
  dir: string;
  posts: Array<{ spaceId: string; text: string }>;
  cleanup(): void;
}

/**
 * Temp cwd with the env a fresh deployment sees: Slack tokens present (the
 * server needs them to boot), every OTHER setup knob absent so the wizard
 * checks fail deterministically.
 */
function tempEnv(): BootEnv {
  const dir = mkdtempSync(join(tmpdir(), "bottega-boot-onboarding-"));
  const posts: Array<{ spaceId: string; text: string }> = [];
  const saved = {
    cwd: process.cwd(),
    app: process.env.SLACK_APP_TOKEN,
    bot: process.env.SLACK_BOT_TOKEN,
    configDir: process.env.BOTTEGA_CONFIG_DIR,
    dbPath: process.env.BOTTEGA_DB_PATH,
    modelKey: process.env.OPENCODE_API_KEY,
    nearKey: process.env.NEAR_API_KEY,
    broker: process.env.OMP_AUTH_BROKER_TOKEN,
    gitTokenFile: process.env.EXECUTOR_GIT_TOKEN_FILE,
    callbackPort: process.env.BOTTEGA_CALLBACK_PORT,
  };
  process.chdir(dir);
  // The server boots the KB config (issue #91): a fresh deployment root
  // ships the empty-sources config like the committed config/kb.yml.
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "kb.yml"), "sources:\n");
  process.env.SLACK_APP_TOKEN = "xapp-1-test";
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  // The browser-leg listener (startOAuthCallbackServer) must never inherit
  // the live .env's BOTTEGA_CALLBACK_PORT — the harness dev server holds
  // it, so booting against it is EADDRINUSE. Pin 0 (ephemeral, the #209
  // default) like every other setup knob this fixture scrubs.
  process.env.BOTTEGA_CALLBACK_PORT = "0";
  delete process.env.BOTTEGA_CONFIG_DIR;
  delete process.env.BOTTEGA_DB_PATH;
  delete process.env.OPENCODE_API_KEY;
  delete process.env.NEAR_API_KEY;
  delete process.env.OMP_AUTH_BROKER_TOKEN;
  delete process.env.EXECUTOR_GIT_TOKEN_FILE;
  return {
    dir,
    posts,
    cleanup() {
      process.chdir(saved.cwd);
      if (saved.app === undefined) delete process.env.SLACK_APP_TOKEN;
      else process.env.SLACK_APP_TOKEN = saved.app;
      if (saved.bot === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = saved.bot;
      if (saved.configDir === undefined) delete process.env.BOTTEGA_CONFIG_DIR;
      else process.env.BOTTEGA_CONFIG_DIR = saved.configDir;
      if (saved.dbPath === undefined) delete process.env.BOTTEGA_DB_PATH;
      else process.env.BOTTEGA_DB_PATH = saved.dbPath;
      if (saved.modelKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = saved.modelKey;
      if (saved.nearKey === undefined) delete process.env.NEAR_API_KEY;
      else process.env.NEAR_API_KEY = saved.nearKey;
      if (saved.broker === undefined) delete process.env.OMP_AUTH_BROKER_TOKEN;
      else process.env.OMP_AUTH_BROKER_TOKEN = saved.broker;
      if (saved.gitTokenFile === undefined) delete process.env.EXECUTOR_GIT_TOKEN_FILE;
      else process.env.EXECUTOR_GIT_TOKEN_FILE = saved.gitTokenFile;
      if (saved.callbackPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
      else process.env.BOTTEGA_CALLBACK_PORT = saved.callbackPort;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Writes every file a fully-configured deployment needs (all checks pass). */
function configureEverything(dir: string): void {
  const secretsDir = join(dir, "data", "secrets");
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(secretsDir, "github-pat"), "github_pat_boot_test", { mode: 0o600 });
  const egressDir = join(dir, "config");
  mkdirSync(egressDir, { recursive: true });
  writeFileSync(join(egressDir, "egress.yml"), 'domains:\n  - "cloud-api.near.ai"\n');
}

describe("boot-time onboarding guide (issue #116)", () => {
  test("checks fail + onboarding space configured → exactly one guided post naming the failures, audited", async () => {
    const env = tempEnv();
    try {
      const store = createStore("data/bottega.db");
      store.setOrgSettings({ onboarding: { space_id: "slack:C123" } });
      store.close();

      const agentDir = join(env.dir, "agent");
      const server = await main({
        agentDir,
        postOnboardingGuide: async (spaceId, text) => {
          env.posts.push({ spaceId, text });
        },
      });
      await server.stop();

      expect(env.posts).toHaveLength(1);
      expect(env.posts[0]!.spaceId).toBe("slack:C123");
      expect(env.posts[0]!.text).toContain("first_run_wizard");
      expect(env.posts[0]!.text).toContain("model_key");
      expect(env.posts[0]!.text).toContain("broker_token");
      expect(env.posts[0]!.text).toContain("git_pat");
      expect(env.posts[0]!.text).toContain("egress_allowlist");

      const reopened = createStore("data/bottega.db");
      const rows = await reopened.listAudit({ event_type: ADMIN_ONBOARDING_BOOT_EVENT });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.space_id).toBe("slack:C123");
      // SAFETY: the boot guide writes this payload via JSON.stringify of
      // { posted, checks } before auditing the event.
      const payload = JSON.parse(rows[0]!.payload) as { posted: boolean; checks: Array<{ name: string; ok: boolean }> };
      expect(payload.posted).toBe(true);
      expect(payload.checks.some((c) => c.name === "model_key" && c.ok === false)).toBe(true);
      reopened.close();
    } finally {
      env.cleanup();
    }
  });

  test("all checks pass + space configured → no boot post", async () => {
    const env = tempEnv();
    try {
      process.env.OPENCODE_API_KEY = "sk-boot-test";
      process.env.OMP_AUTH_BROKER_TOKEN = "bt-boot-test";
      configureEverything(env.dir);
      const store = createStore("data/bottega.db");
      store.setOrgSettings({ onboarding: { space_id: "slack:C123" } });
      store.close();

      const agentDir = join(env.dir, "agent");
      const server = await main({
        agentDir,
        postOnboardingGuide: async (spaceId, text) => {
          env.posts.push({ spaceId, text });
        },
      });
      await server.stop();

      expect(env.posts).toHaveLength(0);
      const reopened = createStore("data/bottega.db");
      expect(await reopened.listAudit({ event_type: ADMIN_ONBOARDING_BOOT_EVENT })).toHaveLength(0);
      reopened.close();
    } finally {
      env.cleanup();
    }
  });

  test("checks fail + no onboarding space configured → no boot post (fail closed)", async () => {
    const env = tempEnv();
    try {
      const store = createStore("data/bottega.db");
      store.setOrgSettings({ response_mode: "mention" }); // knobs, but no onboarding space
      store.close();

      const agentDir = join(env.dir, "agent");
      const server = await main({
        agentDir,
        postOnboardingGuide: async (spaceId, text) => {
          env.posts.push({ spaceId, text });
        },
      });
      await server.stop();

      expect(env.posts).toHaveLength(0);
      const reopened = createStore("data/bottega.db");
      expect(await reopened.listAudit({ event_type: ADMIN_ONBOARDING_BOOT_EVENT })).toHaveLength(0);
      reopened.close();
    } finally {
      env.cleanup();
    }
  });

  test("a failed guide post is audited (posted: false) and never fails the boot", async () => {
    const env = tempEnv();
    try {
      const store = createStore("data/bottega.db");
      store.setOrgSettings({ onboarding: { space_id: "slack:C123" } });
      store.close();

      const agentDir = join(env.dir, "agent");
      const server = await main({
        agentDir,
        postOnboardingGuide: async () => {
          throw new Error("slack unreachable");
        },
      });
      await server.stop();

      const reopened = createStore("data/bottega.db");
      const rows = await reopened.listAudit({ event_type: ADMIN_ONBOARDING_BOOT_EVENT });
      expect(rows).toHaveLength(1);
      // SAFETY: the boot guide writes this payload via JSON.stringify of
      // { posted, checks } before auditing the event.
      const payload = JSON.parse(rows[0]!.payload) as {
        posted: boolean;
        checks: Array<{ name: string; ok: boolean }>;
      };
      expect(payload.posted).toBe(false);
      expect(payload.checks.length).toBeGreaterThan(0);
      reopened.close();
    } finally {
      env.cleanup();
    }
  });
});
