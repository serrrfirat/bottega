/**
 * Boot-time models.yml generation test (issue #67 Part B).
 *
 * The SDK reads models.yml from the agent dir; the DB settings are the
 * source of truth. main() writes the generated catalog at boot — but only
 * when the org settings blob carries model ids (otherwise the committed
 * template stays the default). Driven against a REAL main() in a temp cwd
 * (fresh store pre-seeded with settings, temp agent dir override), so the
 * whole boot path is exercised, not just the renderer.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../store/db";
import { main } from "./index";

function tempEnv(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "bottega-boot-gen-"));
  const saved = {
    cwd: process.cwd(),
    app: process.env.SLACK_APP_TOKEN,
    bot: process.env.SLACK_BOT_TOKEN,
    configDir: process.env.BOTTEGA_CONFIG_DIR,
  };
  process.chdir(dir);
  process.env.SLACK_APP_TOKEN = "xapp-1-test";
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  delete process.env.BOTTEGA_CONFIG_DIR;
  return {
    dir,
    cleanup() {
      process.chdir(saved.cwd);
      if (saved.app === undefined) delete process.env.SLACK_APP_TOKEN;
      else process.env.SLACK_APP_TOKEN = saved.app;
      if (saved.bot === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = saved.bot;
      if (saved.configDir === undefined) delete process.env.BOTTEGA_CONFIG_DIR;
      else process.env.BOTTEGA_CONFIG_DIR = saved.configDir;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("boot-time models.yml generation (issue #67)", () => {
  test("model ids in settings → models.yml generated into the agent dir at boot", async () => {
    const env = tempEnv();
    try {
      // Pre-seed the store main() will open (data/bottega.db in the temp cwd).
      const store = createStore("data/bottega.db");
      store.setOrgSettings({ models: { default: "zai-org/GLM-5.1-FP8", fast: "acme/chat" } });
      store.close();

      const agentDir = join(env.dir, "agent");
      const server = main({ agentDir });
      await server.stop();

      const generated = readFileSync(join(agentDir, "models.yml"), "utf8");
      expect(generated).toContain('id: "zai-org/GLM-5.1-FP8"');
      expect(generated).toContain('id: "acme/chat"');
    } finally {
      env.cleanup();
    }
  });

  test("no model ids in settings → template left in place (no generated file)", async () => {
    const env = tempEnv();
    try {
      const store = createStore("data/bottega.db");
      store.setOrgSettings({ response_mode: "mention" }); // knobs, but no model ids
      store.close();

      const agentDir = join(env.dir, "agent");
      const server = main({ agentDir });
      await server.stop();

      expect(existsSync(join(agentDir, "models.yml"))).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});
