import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../store/db";
import { prepareExecutor, type ExecutorConfig, type ExecutorDeps } from "../executor";
import type { WorkerJob } from "./envelope";
import {
  createChildProcessSandboxRunner,
  probeChildProcessSandbox,
  runJobInSandbox,
  type SandboxRunnerContext,
} from "./run-job";
import { JOB_FAILED_EVENT } from "../store/audit-events";

const dirs: string[] = [];
const stores: Store[] = [];
const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
const originalExtensionsDir = process.env.BOTTEGA_EXTENSIONS_DIR;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bottega-sandbox-process-"));
  dirs.push(dir);
  return dir;
}

function freshStore() {
  const dir = tempDir();
  const dbPath = join(dir, "store.db");
  const store = createStore(dbPath);
  stores.push(store);
  return { store, dbPath, dir };
}

function cfg(dir: string, leaseMs = 200): ExecutorConfig {
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  return {
    repoAllowlist: [],
    gitBaseUrl: "https://github.com",
    apiBaseUrl: "https://api.github.com",
    workspacesDir: join(dir, "workspaces"),
    transcriptDir: join(dir, "transcripts"),
    tokenFile: join(dir, "github-pat"),
    askpassScript: join(dir, "git-askpass.sh"),
    jobLeaseMs: leaseMs,
    maxJobAttempts: 1,
    jobBackoffMs: 1,
    jobBackoffMaxMs: 1,
    jobUnclaimedTtlMs: 60_000,
    jobSweepIntervalMs: 60_000,
  };
}

function deps(store: Store, dbPath: string): ExecutorDeps {
  return {
    store,
    dbPath,
    // SAFETY: These boundary tests never enter a parent-process memory-provider path.
    memoryProvider: undefined as never,
    // SAFETY: These boundary tests never enter a parent-process agent-driver path.
    driver: undefined as never,
  };
}

function runnerContext(store: Store, dbPath: string, dir: string, timeoutMs: number): SandboxRunnerContext {
  return {
    deps: deps(store, dbPath),
    cfg: cfg(dir),
    caps: { timeoutMs, memoryMb: 64 },
    signal: new AbortController().signal,
  };
}

async function processGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    // This integration test waits on real OS process teardown; fake timers cannot drive it.
    await Bun.sleep(20);
  }
  return false;
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    // This integration test waits on a real child process; fake timers cannot drive OS scheduling.
    await Bun.sleep(10);
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalSlackBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
  if (originalExtensionsDir === undefined) delete process.env.BOTTEGA_EXTENSIONS_DIR;
  else process.env.BOTTEGA_EXTENSIONS_DIR = originalExtensionsDir;
});

  test("worker startup fails closed when the isolation runner is unavailable", async () => {
    const { store, dbPath } = freshStore();
    await expect(prepareExecutor(deps(store, dbPath))).rejects.toThrow(/sandbox runner unavailable/);
  });

describe("production child-process sandbox boundary (#101)", () => {
  test("the real child entrypoint has a distinct PID and receives no parent secret environment", async () => {
    const { store, dbPath, dir } = freshStore();
    process.env.SLACK_BOT_TOKEN = "parent-secret-must-not-cross";
    delete process.env.BOTTEGA_SANDBOX_CHILD;

    const probe = await probeChildProcessSandbox({ dbPath, transcriptDir: join(dir, "transcripts") });

    expect(probe.pid).not.toBe(process.pid);
    expect(probe.childMarker).toBe("1");
    expect(probe.forbiddenEnvNames).toEqual([]);
    expect(process.env.BOTTEGA_SANDBOX_CHILD).toBeUndefined();
    expect(store.getOrgSettings()).toBeNull();
  });

  test("the real supervisor and checked-in child complete a job through temporary SQLite", async () => {
    const { store, dbPath, dir } = freshStore();
    const extensionsDir = join(dir, "extensions");
    mkdirSync(extensionsDir);
    process.env.BOTTEGA_EXTENSIONS_DIR = extensionsDir;
    await store.enqueueJob({
      id: "real-child-job",
      kind: "scheduled",
      payload: { action: "memory_consolidation" },
    });
    const job = await store.claimNextJob(1_000);
    if (!job) throw new Error("expected claimed job");
    const runner = createChildProcessSandboxRunner({
      dbPath,
      requireOsResourceLimits: false,
    });

    const outcome = await runJobInSandbox(deps(store, dbPath), cfg(dir, 1_000), job, runner);

    expect(outcome).toEqual({ state: "done", result: null, selfReported: true });
    expect((await store.getJob(job.id))?.status).toBe("completed");
  });

  test("timeout kills the full process group, including a descendant", async () => {
    const { store, dbPath, dir } = freshStore();
    const pidFile = join(dir, "descendant.pid");
    const fixture = join(dir, "timeout-child.ts");
    writeFileSync(
      fixture,
      `import { spawn } from "node:child_process";\nimport { readFileSync, writeFileSync } from "node:fs";\nconst request = JSON.parse(readFileSync(0, "utf8"));\nconst child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: false, stdio: "ignore" });\nwriteFileSync(request.config.transcriptDir + "/../descendant.pid", String(child.pid));\nsetInterval(() => {}, 1000);\n`,
    );
    const runner = createChildProcessSandboxRunner({ dbPath, entrypoint: fixture });
    const job: WorkerJob = { id: "timeout", kind: "scheduled", payload: { action: "memory_consolidation" }, attempts: 1, status: "running" };

    const result = await runner(job, runnerContext(store, dbPath, dir, 80));

    expect(result.timedOut).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
    expect(await processGone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });

  test("malformed bounded IPC is a crash, never a successful completion", async () => {
    const { store, dbPath, dir } = freshStore();
    const fixture = join(dir, "malformed-child.ts");
    writeFileSync(fixture, `import { writeSync } from "node:fs"; writeSync(3, "not-json");`);
    const runner = createChildProcessSandboxRunner({ dbPath, entrypoint: fixture });
    const job: WorkerJob = { id: "bad-ipc", kind: "scheduled", payload: { action: "memory_consolidation" }, attempts: 1, status: "running" };

    const result = await runner(job, runnerContext(store, dbPath, dir, 2_000));

    expect(result.exitCode).toBeNull();
    expect(result.protocolError).toMatch(/invalid sandbox IPC/);
  });

  test("lease loss aborts the real child tree and fails the job loudly", async () => {
    const { store, dbPath, dir } = freshStore();
    const pidFile = join(dir, "lease-child.pid");
    const fixture = join(dir, "lease-child.ts");
    writeFileSync(
      fixture,
      `import { readFileSync, writeFileSync } from "node:fs";\nconst request = JSON.parse(readFileSync(0, "utf8"));\nwriteFileSync(request.config.transcriptDir + "/../lease-child.pid", String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    );
    await store.enqueueJob({ id: "lease-loss", kind: "scheduled", payload: { action: "memory_consolidation" } });
    const job = await store.claimNextJob(100);
    if (!job) throw new Error("expected claimed job");
    const realRunner = createChildProcessSandboxRunner({ dbPath, entrypoint: fixture });
    const pending = runJobInSandbox(deps(store, dbPath), cfg(dir, 40), job, realRunner);
    await waitForFile(pidFile);
    await store.failJob(job.id);
    const outcome = await pending;

    expect(outcome).toEqual({ state: "blocked", result: null, selfReported: true });
    expect(await processGone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
    const failed = await store.listAudit({ event_type: JOB_FAILED_EVENT });
    expect(failed.some((row) => JSON.parse(row.payload).error === "sandbox lease lost")).toBe(true);
  });
});
