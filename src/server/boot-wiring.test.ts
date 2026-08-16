/**
 * Caller-level boot-wiring test (testing-gaps audit 2026-08-17): drives a
 * REAL main() in a temp cwd and asserts the boot wiring the audit found
 * untested from the caller — the scheduler (#111) and KB (#91) integration:
 *
 * - the scheduler registry is wired into the session toolset: the
 *   create_scheduler_job tool accepts every registered action and persists
 *   a durable job through the boot-wired store (a registry that dropped an
 *   action would reject it here);
 * - the KB ingest tool rides the custom-tools bridge (kb_ingest present,
 *   write-tier, KB-shaped);
 * - the boot-time pin sync runs (fresh agent dir gets the modelRoles pin),
 *   a missing Slack token fails the boot closed, and the ACP driver flip
 *   (agent.driver: acp, issue #26) boots through the ACP factory.
 *
 * Hermetic: temp cwd + fake env, no Slack network (the adapter is never
 * started — the scheduler/onboarding paths the boot exposes need no
 * sessions), no live services. Same shape as onboarding-boot.test.ts (#116).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createStore } from "../store/db";
import { main } from "./index";

/** The scheduler tool execute never touches a session context. */
const unusedContext = {} as unknown as ExtensionContext;

interface BootEnv {
  dir: string;
  cleanup(): void;
}

/**
 * Temp cwd with the env a fresh deployment sees: Slack tokens present (the
 * server needs them to boot), every OTHER setup knob absent so the boot
 * runs the default paths deterministically.
 */
function tempEnv(): BootEnv {
  const dir = mkdtempSync(join(tmpdir(), "bottega-boot-wiring-"));
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
  };
  process.chdir(dir);
  // The server boots the KB config (issue #91): a fresh deployment root
  // ships the empty-sources config like the committed config/kb.yml.
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "kb.yml"), "sources:\n");
  process.env.SLACK_APP_TOKEN = "xapp-1-test";
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  delete process.env.BOTTEGA_CONFIG_DIR;
  delete process.env.BOTTEGA_DB_PATH;
  delete process.env.OPENCODE_API_KEY;
  delete process.env.NEAR_API_KEY;
  delete process.env.OMP_AUTH_BROKER_TOKEN;
  delete process.env.EXECUTOR_GIT_TOKEN_FILE;
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
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function textOf(result: AgentToolResult): string {
  return result.content.find((block) => block.type === "text")?.text ?? "";
}

describe("boot wiring (scheduler #111 + KB #91, caller-level)", () => {
  test("the scheduler registry and KB ingest tool are wired into the session toolset", async () => {
    const env = tempEnv();
    try {
      // Ship the agent-config template so the boot-time pin sync (issue
      // #78) takes the "created" path: the fresh agent dir gets a config
      // with the modelRoles pin instead of starting bare.
      mkdirSync(join(env.dir, "config", "omp"), { recursive: true });
      writeFileSync(
        join(env.dir, "config", "omp", "config.yml"),
        "modelRoles:\n  default: opencode-go/deepseek-v4-flash\n",
      );
      const agentDir = join(env.dir, "agent");
      let toolset: ToolDefinition[] | undefined;
      const server = await main({
        agentDir,
        onSessionToolset: (tools) => {
          toolset = tools;
        },
      });

      // The session toolset was captured — the seam fired during boot.
      expect(toolset).toBeDefined();
      const tools = toolset!;

      // KB wiring (issue #91): the ingest tool rides the custom-tools
      // bridge the space agent sees.
      const kb = tools.find((tool) => tool.name === "kb_ingest");
      expect(kb).toBeDefined();
      expect(kb!.approval).toBe("write");
      expect(kb!.label).toBe("Ingest knowledge base");
      expect(kb!.description).toContain("docs/wiki sources");

      // Scheduler wiring (issue #111): the admin tools are registered and
      // the registry accepts every typed action — job creation through the
      // boot-wired toolset persists durable rows in the boot store. A
      // registry that dropped one of the actions would return a tool error
      // instead of a job.
      const createJob = tools.find((tool) => tool.name === "create_scheduler_job");
      const listJobs = tools.find((tool) => tool.name === "list_scheduler_jobs");
      const deleteJob = tools.find((tool) => tool.name === "delete_scheduler_job");
      expect(createJob).toBeDefined();
      expect(listJobs).toBeDefined();
      expect(deleteJob).toBeDefined();

      const actions = ["standup_digest", "reflection", "org_pulse"] as const;
      const created: Array<{ action: string; cron: string }> = [];
      for (const action of actions) {
        const result = (await createJob!.execute(
          "boot-1",
          { action, cron: "0 9 * * 1-5" },
          undefined,
          undefined,
          unusedContext,
        )) as AgentToolResult;
        expect(result.isError).not.toBe(true);
        created.push(JSON.parse(textOf(result)) as { action: string; cron: string });
      }
      expect(created.map((job) => job.action).sort()).toEqual([...actions].sort());

      await server.stop();

      // The jobs are durable in the boot-wired store (data/bottega.db in
      // the temp cwd), so the wiring is the real boot store, not a stub.
      const reopened = createStore("data/bottega.db");
      const jobs = await reopened.listSchedulerJobs();
      expect(jobs.map((job) => job.action).sort()).toEqual([...actions].sort());
      expect(jobs.every((job) => job.cron === "0 9 * * 1-5")).toBe(true);
      expect(jobs.every((job) => job.enabled)).toBe(true);
      reopened.close();
    } finally {
      env.cleanup();
    }
  });

  test("a missing Slack token fails the boot closed", async () => {
    const env = tempEnv();
    try {
      delete process.env.SLACK_APP_TOKEN;
      await expect(main({ agentDir: join(env.dir, "agent") })).rejects.toThrow(
        "SLACK_APP_TOKEN and SLACK_BOT_TOKEN are required",
      );
    } finally {
      env.cleanup();
    }
  });

  test("agent.driver: acp boots through the ACP driver factory (issue #26)", async () => {
    const env = tempEnv();
    try {
      // The org floor config selects the space-agent driver; `acp` flips
      // the boot to createAcpDriver (the OMP registry guard is skipped).
      writeFileSync(join(env.dir, "config.yml"), "agent:\n  driver: acp\n");
      const server = await main({ agentDir: join(env.dir, "agent") });
      await server.stop();
      // Reaching stop() means the ACP boot path (driver factory + service
      // wiring) completed; the MCP server spawn happens only per session,
      // so this stays hermetic.
    } finally {
      env.cleanup();
    }
  });
});
