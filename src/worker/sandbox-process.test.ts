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
  createDockerSandboxRunner,
  probeDockerSandbox,
  type DockerClient,
  type DockerProcess,
  runJobInSandbox,
  type SandboxRunnerContext,
} from "./run-job";
import { JOB_FAILED_EVENT } from "../store/audit-events";
import { memoryDenyProvider, MAX_RPC_FRAME_BYTES, connectStoreRpc, JobStoreRpcServer } from "./store-rpc";
import { resolveMemoryProvider, type ResolvedMemoryProvider } from "../server/memory-provider";

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

describe("child-process protocol lane (test fabric — NOT the production boundary)", () => {
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

// ---------------------------------------------------------------------------
// Production Docker sandbox boundary (#101/#338).
//
// The hermetic tests drive `createDockerSandboxRunner` through an injected
// fake docker CLI so they FAIL on the child-process/in-process runners (which
// never invoke docker, never mint a container name, and never prove distinct
// container identity). The real-container lane is gated separately below.
// ---------------------------------------------------------------------------

import { Readable, Writable } from "node:stream";
import { MAX_SANDBOX_RESPONSE_BYTES, SANDBOX_PROTOCOL_VERSION, type SandboxResponse } from "./sandbox-protocol";

function sandboxResponse(mode: "execute" | "probe", pid: number, result?: { exitCode: number | null; signal: string | null; timedOut: boolean }): string {
  const body: SandboxResponse =
    mode === "probe"
      ? { version: SANDBOX_PROTOCOL_VERSION, mode: "probe", pid, childMarker: "1", forbiddenEnvNames: [] }
      : { version: SANDBOX_PROTOCOL_VERSION, mode: "execute", pid, result: result ?? { exitCode: 0, signal: null, timedOut: false } };
  return JSON.stringify(body);
}

/** One fake docker CLI subprocess representing a launched container. */
class FakeProc implements DockerProcess {
  stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  constructor(readonly innerPid: number, private readonly fake: FakeDocker) {}
  private resolveExit: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    this.resolveExit = resolve;
  });
  /** Emit the job container's full JSON response then signal EOF on stdout. */
  respond(opts: { exitCode?: number | null; signal?: NodeJS.Signals | null } = {}): void {
    this.stdout.push(Buffer.from(sandboxResponse("execute", this.innerPid, { exitCode: opts.exitCode ?? 0, signal: opts.signal ?? null, timedOut: false })));
    this.stdout.push(null);
    this.stderr.push(null);
    this.resolveExit({ code: opts.exitCode ?? 0, signal: opts.signal ?? null });
    this.fake.completedRuns.push(this.innerPid);
  }
  kill(_signal?: NodeJS.Signals): void {
    // The container's PID 1 is killed; the `docker run` process exits as the
    // runtime tears down the whole container tree/cgroup.
    this.stdout.destroy();
    this.stderr.destroy();
    this.resolveExit({ code: null, signal: "SIGKILL" });
  }
}

/** A scripted docker CLI behind the DockerClient seam. */
class FakeDocker {
  launches: { args: string[]; proc: FakeProc | null }[] = [];
  broken = false;
  completedRuns: number[] = [];
  private nextInnerPid = 2000;
  /** Active containers keyed by --name, so a kill tears the run down. */
  private runsByContainer = new Map<string, FakeProc>();

  launch(args: string[]): DockerProcess {
    if (this.broken) throw new Error("spawn docker ENOENT");
    if (args.includes("run")) {
      const proc = new FakeProc(this.nextInnerPid++, this);
      this.runsByContainer.set(args[args.indexOf("--name") + 1], proc);
      this.launches.push({ args, proc });
      return proc;
    }
    if (args.includes("kill")) {
      // `docker kill <name>` terminates the container's PID 1; the attached
      // `docker run` process (the run FakeProc) exits as the tree is torn down.
      const name = args[args.length - 1];
      const run = this.runsByContainer.get(name);
      if (run) run.kill();
      const proc = new FakeProc(0, this);
      this.launches.push({ args, proc });
      return proc;
    }
    const proc = new FakeProc(0, this);
    this.launches.push({ args, proc });
    return proc;
  }
  /** The `docker run` launch for a job (container-identity proof). */
  runLaunch(): FakeProc {
    const run = this.launches.find((l) => l.args.includes("run"));
    if (!run?.proc) throw new Error("expected a `docker run` launch — the child runner never issues one");
    return run.proc;
  }
  /**
   * Awaits the supervisor's `docker run` launch with a bounded timeout. The
   * runner reaches `docker.launch` only after the async store-RPC listen
   * resolves (a real I/O operation), so callers must poll for the observable
   * launch instead of reading the fake synchronously.
   */
  async awaitLaunch(timeoutMs = 5_000): Promise<FakeProc> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = this.launches.find((l) => l.args.includes("run"));
      if (run?.proc) return run.proc;
      if (Date.now() >= deadline) throw new Error("timed out waiting for a `docker run` launch");
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  /** docker-kill launches issued by the supervisor. */
  killLaunches(): string[][] {
    return this.launches.filter((l) => l.args.includes("kill")).map((l) => l.args);
  }
}

describe("production docker sandbox boundary (#101/#338)", () => {
  test("the runner mints a distinct disposable container per job (no in-process fallback)", async () => {
    const { store, dbPath, dir } = freshStore();
    const fake = new FakeDocker();
    await store.enqueueJob({ id: "docker-job", kind: "scheduled", payload: { action: "memory_consolidation" } });
    const job = await store.claimNextJob(1_000);
    if (!job) throw new Error("expected claimed job");
    const runner = createDockerSandboxRunner({ hostStore: store, memoryProvider: memoryDenyProvider, workspacesDir: join(dir, "workspaces"), transcriptDir: join(dir, "transcripts"), docker: fake });
    const pending = runJobInSandbox(deps(store, dbPath), cfg(dir, 1_000), job, runner);
    // Await the observable launch: the runner reaches `docker.launch` only
    // after the async store-RPC listen resolves, so never read the fake
    // synchronously. Always settle `pending` (bounded) so no post-test
    // closed-DB work survives an assertion failure.
    try {
      const run = await fake.awaitLaunch();
      const runArgs = fake.launches.find((l) => l.args.includes("run"))!.args;
      run.respond();

      const outcome = await pending;
      expect(outcome.state).toBe("done");
      // Distinct container identity: a disposable (`--rm`) container with a
      // unique --name and an inner PID that differs from the host server.
      expect(runArgs).toContain("--rm");
      expect(runArgs).toContain("run");
      const nameIndex = runArgs.indexOf("--name");
      expect(nameIndex).toBeGreaterThan(-1);
      expect(runArgs[nameIndex + 1]).toMatch(/bottega-sandbox/);
      expect(runArgs[nameIndex + 1]).toContain("docker-job");
      expect(run.innerPid).not.toBe(process.pid);
      expect(fake.completedRuns).toContain(run.innerPid);
    } finally {
      await Promise.race([pending.catch(() => {}), new Promise((r) => setTimeout(r, 2_000))]);
    }
  });

  test("timeout issues a docker kill and fails closed", async () => {
    const { store, dbPath, dir } = freshStore();
    const fake = new FakeDocker();
    const job: WorkerJob = { id: "docker-timeout", kind: "scheduled", payload: { action: "memory_consolidation" }, attempts: 1, status: "running" };
    const runner = createDockerSandboxRunner({ hostStore: store, memoryProvider: memoryDenyProvider, workspacesDir: join(dir, "workspaces"), transcriptDir: join(dir, "transcripts"), docker: fake });
    const result = await runner(job, runnerContext(store, dbPath, dir, 60));

    expect(result.timedOut).toBe(true);
    expect(fake.killLaunches().length).toBeGreaterThan(0);
  });

  test("lease loss aborts the container and fails the job loudly", async () => {
    const { store, dbPath, dir } = freshStore();
    const fake = new FakeDocker();
    await store.enqueueJob({ id: "docker-lease", kind: "scheduled", payload: { action: "memory_consolidation" } });
    const job = await store.claimNextJob(100);
    if (!job) throw new Error("expected claimed job");
    const runner = createDockerSandboxRunner({ hostStore: store, memoryProvider: memoryDenyProvider, workspacesDir: join(dir, "workspaces"), transcriptDir: join(dir, "transcripts"), docker: fake });
    const pending = runJobInSandbox(deps(store, dbPath), cfg(dir, 40), job, runner);
    try {
      // Await the observable launch so the abort listener + container are
      // registered before the lease is lost (never read the fake synchronously).
      await fake.awaitLaunch();
      // Once the container is "running", lose the lease: the renewal abort must
      // docker-kill the container tree and fail the job loudly.
      await store.failJob(job.id);

      const outcome = await pending;
      expect(outcome.state).toBe("blocked");
      expect(fake.killLaunches().length).toBeGreaterThan(0);
      const failed = await store.listAudit({ event_type: JOB_FAILED_EVENT });
      expect(failed.some((row) => JSON.parse(row.payload).error === "sandbox lease lost")).toBe(true);
    } finally {
      await Promise.race([pending.catch(() => {}), new Promise((r) => setTimeout(r, 2_000))]);
    }
  });

  test("bounded IPC overflow is a crash, never a completion", async () => {
    const { store, dbPath, dir } = freshStore();
    const job: WorkerJob = { id: "docker-overflow", kind: "scheduled", payload: { action: "memory_consolidation" }, attempts: 1, status: "running" };
    // A run whose stdout exceeds the bounded result cap; the supervisor must
    // docker-kill it (which terminates the attached run process -> exit resolves).
    let runExit: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
    const overflowing: DockerClient = {
      launch(args: string[]) {
        if (args.includes("run")) {
          const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
          const stdout = new Readable({ read() {} });
          stdout.push(Buffer.alloc(MAX_SANDBOX_RESPONSE_BYTES + 1));
          stdout.push(null);
          const stderr = new Readable({ read() {} });
          stderr.push(null);
          const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => { runExit = r; });
          return { stdin, stdout, stderr, exit, kill: () => runExit({ code: null, signal: "SIGKILL" }) };
        }
        if (args.includes("kill")) {
          // docker kill terminates the container; the attached run exits.
          runExit({ code: null, signal: "SIGKILL" });
        }
        return { stdin: new Writable({ write(_c, _e, cb) { cb(); } }), stdout: new Readable({ read() {} }), stderr: new Readable({ read() {} }), exit: new Promise<{ code: null; signal: null }>(() => {}), kill: () => {} };
      },
    };
    const runner = createDockerSandboxRunner({ hostStore: store, memoryProvider: memoryDenyProvider, workspacesDir: join(dir, "workspaces"), transcriptDir: join(dir, "transcripts"), docker: overflowing });
    const result = await runner(job, runnerContext(store, dbPath, dir, 2_000));

    expect(result.exitCode).toBeNull();
    expect(result.protocolError).toMatch(/invalid sandbox IPC|exceeds/);
  });

  test("missing docker refuses to run — no child/in-process fallback", async () => {
    const { store, dbPath, dir } = freshStore();
    const broken = new FakeDocker();
    broken.broken = true;
    const job: WorkerJob = { id: "docker-missing", kind: "scheduled", payload: { action: "memory_consolidation" }, attempts: 1, status: "running" };
    const runner = createDockerSandboxRunner({ hostStore: store, memoryProvider: memoryDenyProvider, workspacesDir: join(dir, "workspaces"), transcriptDir: join(dir, "transcripts"), docker: broken });
    const result = await runner(job, runnerContext(store, dbPath, dir, 2_000));

    expect(result.exitCode).toBeNull();
    expect(result.protocolError).toMatch(/sandbox unavailable/);
  });

  test("execute-mode launch wires the immutable mounted store RPC socket env (#101)", async () => {
    const { store, dir } = freshStore();
    const job: WorkerJob = { id: "rpc-socket-job", kind: "scheduled", payload: { action: "memory_consolidation" }, attempts: 1, status: "running" };
    let runArgs: string[] = [];
    const capturing: DockerClient = {
      launch(args: string[]) {
        if (args.includes("run")) {
          runArgs = args;
          const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
          const stdout = new Readable({ read() {} });
          const stderr = new Readable({ read() {} });
          let resolveExit: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
          const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => { resolveExit = r; });
          queueMicrotask(() => {
            stdout.push(Buffer.from(JSON.stringify({ version: SANDBOX_PROTOCOL_VERSION, mode: "execute", pid: 5150, result: { exitCode: 0, signal: null, timedOut: false } }) + "\n"));
            stdout.push(null);
            stderr.push(null);
            resolveExit({ code: 0, signal: null });
          });
          return { stdin, stdout, stderr, exit, kill: () => resolveExit({ code: null, signal: "SIGKILL" }) };
        }
        return new FakeProc(0, new FakeDocker());
      },
    };
    // Host env poisoning: the RPC socket must be generated by the supervisor
    // as the immutable container-internal path, never passed through from the
    // host (which has no container path and no reason to set it).
    const originalHostRpcSocket = process.env.BOTTEGA_SANDBOX_RPC_SOCKET;
    process.env.BOTTEGA_SANDBOX_RPC_SOCKET = "host-must-not-leak.sock";
    const runner = createDockerSandboxRunner({
      hostStore: store,
      memoryProvider: memoryDenyProvider,
      workspacesDir: join(dir, "workspaces"),
      transcriptDir: join(dir, "transcripts"),
      docker: capturing,
    });
    try {
      const result = await runner(job, runnerContext(store, "", dir, 2_000));
      expect(result.exitCode).toBe(0);
      // The execute container receives the exact container-internal RPC store
      // socket path (mounted under /rpc), overriding any host value.
      expect(runArgs).toContain("--env");
      const rpcSocketEnv = runArgs.find((a) => a.startsWith("BOTTEGA_SANDBOX_RPC_SOCKET="));
      expect(rpcSocketEnv).toBe("BOTTEGA_SANDBOX_RPC_SOCKET=/rpc/store.sock");
    } finally {
      if (originalHostRpcSocket === undefined) delete process.env.BOTTEGA_SANDBOX_RPC_SOCKET;
      else process.env.BOTTEGA_SANDBOX_RPC_SOCKET = originalHostRpcSocket;
    }
  });
});

// Required real-container lane (issue #101/#338). Gated on an explicit
// integration flag so the hermetic suite never depends on a pre-built job
// image: CI builds `bottega:local` and sets BOTTEGA_RUN_INTEGRATION=1 (the
// required no-skip lane), while local runs skip it. Proves a genuine
// container with a distinct inner PID and zero parent-secret leakage.
const dockerSocketPresent = existsSync("/var/run/docker.sock") || process.env.BOTTEGA_SANDBOX_DOCKER_SOCKET !== undefined;
describe.skipIf(!dockerSocketPresent || process.env.BOTTEGA_RUN_INTEGRATION !== "1")(
  "real-container Docker sandbox lane (#101/#338)",
  () => {
  test("a real container launches with a distinct inner PID and no parent secrets", async () => {
    const { dir } = freshStore();
    const probe = await probeDockerSandbox({
      workspacesDir: join(dir, "workspaces"),
      transcriptDir: join(dir, "transcripts"),
      image: process.env.BOTTEGA_SANDBOX_IMAGE ?? "bottega:local",
      requireDocker: true,
    });
    expect(probe.childMarker).toBe("1");
    expect(probe.pid).toBeGreaterThan(0);
    expect(probe.pid).not.toBe(process.pid);
    expect(probe.forbiddenEnvNames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Job-scoped store RPC boundary (#101/#338).
//
// The supervisor retains the real Store + memory provider; the container's
// store/memory are thin clients over a bounded unix-socket RPC surfaced by
// the ALLOWLIST. These caller-level tests drive the REAL RPC server + client
// over a real temp socket: a cross-job row, a global write, an unlisted
// method, the raw DB handle, a malformed frame, and an oversized frame all
// FAIL CLOSED — never a silent forwarded call or a partial result.
// ---------------------------------------------------------------------------
import { connect as netConnect } from "node:net";

/** Sends one raw JSON frame to an RPC socket and returns the first reply. */
function rawRpc(socketPath: string, frame: string | Buffer, opts: { readReply?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw RPC socket timed out"));
    }, 5000);
    let dataBuf = "";
    socket.on("connect", () => socket.write(frame));
    if (opts.readReply !== false) {
      socket.on("data", (chunk: Buffer) => {
        dataBuf += chunk.toString("utf8");
        if (dataBuf.includes("\n")) {
          clearTimeout(timer);
          socket.destroy();
          resolve(dataBuf.split("\n")[0]!);
        }
      });
    } else {
      socket.on("data", () => { /* suppress */ });
    }
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (dataBuf.length === 0) reject(new Error("raw RPC socket closed without a reply"));
    });
  });
}

describe("job-scoped store RPC boundary (#101/#338)", () => {
  function makeRpc(jobOverride?: WorkerJob) {
    const { store, dir } = freshStore();
    const job: WorkerJob = jobOverride ?? {
      id: "job_1",
      kind: "scheduled",
      payload: { action: "memory_consolidation" },
      attempts: 1,
      status: "running",
    };
    const rpcDir = join(dir, "rpc");
    mkdirSync(rpcDir, { recursive: true });
    const server = JobStoreRpcServer.create(store, job, rpcDir, {
      memoryProvider: resolveMemoryProvider(store.getOrgSettings(), store.getDb()),
    });
    return { store, dir, job, server };
  }

  test("cross-job row access is denied loudly through the real scoped-store RPC host", async () => {
    const { store, job, server } = makeRpc();
    await server.listen();
    const session = connectStoreRpc(server.socketPath);
    try {
      await session.ready();
      // Another job's row is outside the scoped-store firewall (job-row guard).
      await expect(session.store.getJob("job_2")).rejects.toThrow(/job-row access/);
    } finally {
      session.close();
      server.close();
    }
    void store;
    void job;
  });

  test("global writes, raw handle, and unknown methods are denied by the allowlist (fail closed)", async () => {
    const { server } = makeRpc();
    await server.listen();
    try {
      // enqueueJob is a boss-loop global write, never on the allowlist.
      const enqueueReply = await rawRpc(server.socketPath, `${JSON.stringify({ ns: "store", id: 1, method: "enqueueJob", args: [{ id: "x", kind: "scheduled", payload: {} }] })}\n`);
      expect(enqueueReply).toMatch(/not on the allowlist|denied/);
      // getDb is the raw handle — never exposed.
      const getDbReply = await rawRpc(server.socketPath, `${JSON.stringify({ ns: "store", id: 2, method: "getDb", args: [] })}\n`);
      expect(getDbReply).toMatch(/raw store handle/);
      // An unknown store method is not on the allowlist.
      const unknownReply = await rawRpc(server.socketPath, `${JSON.stringify({ ns: "store", id: 3, method: "totallyMadeUp", args: [] })}\n`);
      expect(unknownReply).toBeDefined();
      // Expect an error reply (not a value reply) — the server replies with ok:false.
      const parsed = JSON.parse(unknownReply!);
      expect(parsed.ok).toBe(false);
    } finally {
      server.close();
    }
  });

  test("a raw malformed frame and an oversized frame tear the connection down (fail closed)", async () => {
    const { server } = makeRpc();
    await server.listen();
    try {
      // Malformed JSON → loud error reply + teardown.
      const malformed = await rawRpc(server.socketPath, "this is not json\n");
      expect(malformed).toMatch(/malformed RPC frame/);
      // Oversized frame → socket destroyed (no reply; rawRpc sees close/error).
      await expect(rawRpc(server.socketPath, `${"x".repeat(MAX_RPC_FRAME_BYTES + 4096)}\n`)).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  test("ingest-poll watermark RPC round-trips through the supervisor (store retained there)", async () => {
    const { server } = makeRpc({
      id: "job_poll",
      kind: "ingest_poll",
      payload: { provider: "github" },
      attempts: 1,
      status: "running",
    });
    await server.listen();
    const session = connectStoreRpc(server.socketPath);
    try {
      await session.ready();
      // The job's own validated provider is the only watermark it may touch.
      await expect(session.store.setIngestWatermark("github", "cursor-1")).resolves.toBeUndefined();
      // A different provider proves the raw socket cannot name it.
      await expect(session.store.getIngestWatermark("github")).resolves.toBe("cursor-1");
      await expect(session.store.setIngestWatermark("other", "x")).rejects.toThrow(/provider/);
    } finally {
      session.close();
      server.close();
    }
  });

  test("client-side unknown/global methods never exist on the explicit facade", async () => {
    const { server } = makeRpc();
    await server.listen();
    const session = connectStoreRpc(server.socketPath);
    try {
      await session.ready();
      // The facade exposes only allowlisted methods; a global write is absent
      // (no Proxy fallthrough) and getDb/close throw locally.
      expect("enqueueJob" in session.store).toBe(false);
      expect(session.store.getDb).toThrow(/raw store handle/);
      expect(session.store.close).toThrow(/raw store handle/);
    } finally {
      session.close();
      server.close();
    }
  });

  test("the resolved memory provider (readonly capabilities/backend) is observable after ready()", async () => {
    const { store, dir } = freshStore();
    const job: WorkerJob = { id: "job_mem", kind: "scheduled", payload: { action: "memory_consolidation" }, attempts: 1, status: "running" };
    const rpcDir = join(dir, "rpc");
    mkdirSync(rpcDir, { recursive: true });
    // A supervisor provider whose resolved identity differs from the client's
    // default, so passing it through ready() is provable by observation.
    const supervisorProvider: ResolvedMemoryProvider = {
      backend: "mem0",
      capabilities: { consolidation: "on-save", digestPruning: "unsupported" },
      save: async () => {
        throw new Error("unused in this test");
      },
      search: async () => [],
      pruneDigests: async () => {
        throw new Error("unused in this test");
      },
    };
    const server = JobStoreRpcServer.create(store, job, rpcDir, {
      memoryProvider: supervisorProvider,
    });
    await server.listen();
    const session = connectStoreRpc(server.socketPath);
    try {
      // Before ready(), the getter still exposes the unresolved default.
      expect(session.memoryProvider.backend).toBe("sqlite");
      await session.ready();
      // After ready(), the getter reflects the supervisor-reported values —
      // never a stale by-value snapshot.
      expect(session.memoryProvider.backend).toBe("mem0");
      expect(session.memoryProvider.capabilities.consolidation).toBe("on-save");
      expect(session.memoryProvider.capabilities.digestPruning).toBe("unsupported");
      expect(session.memoryProvider.save).toBeTypeOf("function");
    } finally {
      session.close();
      server.close();
    }
  });

  test("cross-job outbox, audit rows, and audit queries are denied (raw frame cannot forge another job's evidence)", async () => {
    // A scheduled job in space S with its own completion row must be the only
    // one it can post/read; a raw socket naming another job/space fails closed.
    const { store, job, server } = makeRpc({
      id: "job_sched",
      kind: "scheduled",
      payload: { action: "memory_consolidation" },
      spaceId: "slack:C1",
      attempts: 1,
      status: "running",
    });
    await server.listen();
    try {
      // A completion outbox row for ANOTHER job is refused.
      const otherOutbox = await rawRpc(server.socketPath, `${JSON.stringify({ ns: "store", id: 1, method: "postOutboxRow", args: [{ id: "job_other", kind: "scheduled", payload: { action: "memory_consolidation" }, space: "slack:C1" }] })}\n`);
      expect(otherOutbox).toMatch(/outbox row|ScopedStoreAccessError/);
      // An audit row pinning ANOTHER space (a scheduled-legitimate event, so the
      // space binding is what refuses it) is refused.
      const fakedAudit = await rawRpc(server.socketPath, `${JSON.stringify({ ns: "store", id: 2, method: "appendAudit", args: [{ space_id: "slack:C2", actor: "executor", event_type: "job.completed", payload: "{}" }] })}\n`);
      expect(fakedAudit).toMatch(/audit row for space/);
      // An audit query scoped to another space is refused.
      const fakedQuery = await rawRpc(server.socketPath, `${JSON.stringify({ ns: "store", id: 3, method: "queryAudit", args: [{ space_id: "slack:C2" }] })}\n`);
      expect(fakedQuery).toMatch(/audit query must be scoped/);
      // A listAudit scoped to another space is refused.
      const fakedList = await rawRpc(server.socketPath, `${JSON.stringify({ ns: "store", id: 4, method: "listAudit", args: [{ space: "slack:C2" }] })}\n`);
      expect(fakedList).toMatch(/audit list must be scoped/);
    } finally {
      server.close();
    }
    void store;
    void job;
  });

  test("space/settings reads are restricted to the job's own space; other-work-item reads denied", async () => {
    const { store, server } = makeRpc({
      id: "job_git",
      kind: "git",
      payload: { workItemId: "wi_1" },
      spaceId: "slack:C1",
      attempts: 1,
      status: "running",
    });
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    const otherSpace = await store.getOrCreateSpace({ platform: "slack", channel_id: "C2" });
    // Give the job its own work item so getSpace/transition paths exist.
    await store.createWorkItem({ space_id: space.id, requester: "U1", description: "own" });
    await server.listen();
    const session = connectStoreRpc(server.socketPath);
    try {
      await session.ready();
      // Reading its OWN space succeeds.
      await expect(session.store.getSpace(space.id)).resolves.toMatchObject({ id: space.id });
      // Reading ANOTHER space is denied.
      await expect(session.store.getSpace(otherSpace.id)).rejects.toThrow(/job-row access|space/);
      // A work item it does not own is denied (work-item guard).
      await expect(session.store.getWorkItem("wi_other")).rejects.toThrow(/work-item access/);
    } finally {
      session.close();
      server.close();
    }
  });

  test("extension credential reads are extension-jobs-only; maintainMemory only for scheduled consolidation", async () => {
    // A git job (not extension) cannot read the extension credential ladder.
    const git = makeRpc({ id: "job_git2", kind: "git", payload: { workItemId: "wi_1" }, spaceId: "slack:C1", attempts: 1, status: "running" });
    await git.server.listen();
    try {
      const credReply = await rawRpc(git.server.socketPath, `${JSON.stringify({ ns: "store", id: 1, method: "listExtensionCredentials", args: ["notion"] })}\n`);
      expect(credReply).toMatch(/extension credential read/);
    } finally {
      git.server.close();
    }

    // A scheduled job that is NOT memory_consolidation cannot run maintainMemory.
    const sched = makeRpc({ id: "job_sched2", kind: "scheduled", payload: { action: "digest" }, attempts: 1, status: "running" });
    await sched.server.listen();
    try {
      const maintainReply = await rawRpc(sched.server.socketPath, `${JSON.stringify({ ns: "memory", id: 1, method: "maintainMemory", args: [] })}\n`);
      expect(maintainReply).toMatch(/memory_consolidation/);
    } finally {
      sched.server.close();
    }
  });

  test("extension credential reads are pinned to the supervisor's registered providers (arbitrary provider strings deny)", async () => {
    // An extension-delivery job whose registry registered ONLY "notion":
    // its own provider succeeds; an arbitrary/caller-supplied provider denies.
    const { store, dir } = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C-ext-cred" });
    const item = await store.createWorkItem({ space_id: space.id, requester: "U1", description: "ext", delivery: "extension" });
    const job: WorkerJob = { id: "job_ext_cred", kind: "extension", payload: { workItemId: item.id }, spaceId: space.id, attempts: 1, status: "running" };
    const rpcDir = join(dir, "rpc");
    mkdirSync(rpcDir, { recursive: true });
    const server = JobStoreRpcServer.create(store, job, rpcDir, {
      memoryProvider: memoryDenyProvider,
      extensionProviderIds: ["notion"],
    });
    await server.listen();
    const session = connectStoreRpc(server.socketPath);
    try {
      await session.ready();
      // The registered provider is enumerable.
      await expect(session.store.listExtensionCredentials("notion")).resolves.toEqual([]);
      // An arbitrary provider not in the supervisor's registry is denied.
      await expect(session.store.listExtensionCredentials("slack")).rejects.toThrow(/not a registered extension/);
      await expect(session.store.listExtensionCredentials("gmail")).rejects.toThrow(/not a registered extension/);
    } finally {
      session.close();
      server.close();
    }
  });

  test("listExtensionCredentials fails closed when no extension registry is provided (empty set)", async () => {
    // No extensionProviderIds → empty set → every provider is denied, even a
    // plausible one, so a host can never grant credential reads by omission.
    const { store, dir } = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C-ext-empty" });
    const item = await store.createWorkItem({ space_id: space.id, requester: "U1", description: "ext", delivery: "extension" });
    const job: WorkerJob = { id: "job_ext_empty", kind: "extension", payload: { workItemId: item.id }, spaceId: space.id, attempts: 1, status: "running" };
    const rpcDir = join(dir, "rpc");
    mkdirSync(rpcDir, { recursive: true });
    const server = JobStoreRpcServer.create(store, job, rpcDir, { memoryProvider: memoryDenyProvider });
    await server.listen();
    const session = connectStoreRpc(server.socketPath);
    try {
      await session.ready();
      await expect(session.store.listExtensionCredentials("notion")).rejects.toThrow(/not a registered extension/);
    } finally {
      session.close();
      server.close();
    }
  });

  test("audit writes are pinned to the job kind's events/actors/spaces; forged actor/event/null-space deny", async () => {
    // A git job (own space) may write ONLY the git lifecycle + delivery
    // markers as actor "executor" in its OWN space. Forging another actor,
    // another event, or an org-level (null-space) row is refused.
    const git = makeRpc({ id: "job_audit_git", kind: "git", payload: { workItemId: "wi_1" }, spaceId: "slack:C1", attempts: 1, status: "running" });
    await git.server.listen();
    const gitSession = connectStoreRpc(git.server.socketPath);
    try {
      await gitSession.ready();
      // Legitimate git events in its own space succeed.
      await expect(
        gitSession.store.appendAudit({ space_id: "slack:C1", actor: "executor", event_type: "job.completed", payload: "{}" }),
      ).resolves.toBeGreaterThan(0);
      await expect(
        gitSession.store.appendAudit({ space_id: "slack:C1", actor: "executor", event_type: "work_item.delivery_pending", payload: "{}" }),
      ).resolves.toBeGreaterThan(0);
      // Forged actor (not executor) on a git event denies.
      await expect(
        gitSession.store.appendAudit({ space_id: "slack:C1", actor: "kb_ingest", event_type: "job.completed", payload: "{}" }),
      ).rejects.toThrow(/not an event this git job legitimately writes/);
      // Forged event_type (memory.write is kb-only) denies, even with the git actor.
      await expect(
        gitSession.store.appendAudit({ space_id: "slack:C1", actor: "executor", event_type: "memory.write", payload: "{}" }),
      ).rejects.toThrow(/not an event this git job legitimately writes/);
      // Forged org-level (null-space) git lifecycle row denies (git has a space).
      await expect(
        gitSession.store.appendAudit({ space_id: null, actor: "executor", event_type: "job.completed", payload: "{}" }),
      ).rejects.toThrow(/must be in the job's own space/);
      // Forged cross-space row denies.
      await expect(
        gitSession.store.appendAudit({ space_id: "slack:C2", actor: "executor", event_type: "job.completed", payload: "{}" }),
      ).rejects.toThrow(/audit row for space/);
    } finally {
      gitSession.close();
      git.server.close();
    }
  });

  test("kb jobs may write their org-scope memory.write and null-space lifecycle; other events deny", async () => {
    // A kb job (no space) legitimately writes org-scope memory rows (actor
    // kb_ingest, null space) and its own job.completed/job.failed lifecycle
    // rows (null space). A git-style delivery marker or a forged actor denies.
    const kb = makeRpc({ id: "job_audit_kb", kind: "kb", payload: { url: "https://docs.example.com" }, attempts: 1, status: "running" });
    await kb.server.listen();
    const kbSession = connectStoreRpc(kb.server.socketPath);
    try {
      await kbSession.ready();
      // The legitimate org-scope memory.write (kb_ingest, null) succeeds.
      await expect(
        kbSession.store.appendAudit({ actor: "kb_ingest", event_type: "memory.write", payload: "{}" }),
      ).resolves.toBeGreaterThan(0);
      // The kb job's own null-space lifecycle succeeds (kb has no space).
      await expect(
        kbSession.store.appendAudit({ actor: "executor", event_type: "job.completed", payload: "{}" }),
      ).resolves.toBeGreaterThan(0);
      // A git-only delivery marker denies on a kb job.
      await expect(
        kbSession.store.appendAudit({ actor: "executor", event_type: "work_item.delivery_pending", payload: "{}" }),
      ).rejects.toThrow(/not an event this kb job legitimately writes/);
      // Forging the memory.write actor (executor instead of kb_ingest) denies.
      await expect(
        kbSession.store.appendAudit({ actor: "executor", event_type: "memory.write", payload: "{}" }),
      ).rejects.toThrow(/not an event this kb job legitimately writes/);
    } finally {
      kbSession.close();
      kb.server.close();
    }
  });

test("memory writes/searches/prunes outside the job's own space are denied", async () => {
    const { server } = makeRpc({
      id: "job_kb",
      kind: "git",
      payload: { workItemId: "wi_1" },
      spaceId: "slack:C1",
      attempts: 1,
      status: "running",
    });
    await server.listen();
    const session = connectStoreRpc(server.socketPath);
    try {
      await session.ready();
      // An org-scope search is the shared floor — allowed.
      await expect(session.memoryProvider.search({ query: "kb", scope: { kind: "org" } })).resolves.toEqual([]);
      // A channel scope for ANOTHER space is denied.
      const saveOther = { content: "x", scope: { kind: "channel", spaceId: "slack:C2" } as const };
      await expect(session.memoryProvider.save(saveOther)).rejects.toThrow(/channel scope/);
      const searchOther = { query: "kb", scope: { kind: "channel", spaceId: "slack:C2" } as const };
      await expect(session.memoryProvider.search(searchOther)).rejects.toThrow(/channel scope/);
      // pruneDigests for another space is denied.
      await expect(session.memoryProvider.pruneDigests("slack:C2", 5)).rejects.toThrow(/pruneDigests/);
    } finally {
      session.close();
      server.close();
    }
  });

  test("legitimate job-lifecycle frames succeed end-to-end (own job, own space, own provider)", async () => {
    const { store, dir } = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    const item = await store.createWorkItem({ space_id: space.id, requester: "U1", description: "own" });
    await store.enqueueJob({ id: "job_git3", kind: "git", payload: { workItemId: item.id }, spaceId: space.id });
    const job: WorkerJob = { id: "job_git3", kind: "git", payload: { workItemId: item.id }, spaceId: space.id, attempts: 1, status: "running" };
    const rpcDir = join(dir, "rpc");
    mkdirSync(rpcDir, { recursive: true });
    const server = JobStoreRpcServer.create(store, job, rpcDir, {
      memoryProvider: resolveMemoryProvider(store.getOrgSettings(), store.getDb()),
    });
    await server.listen();
    const session = connectStoreRpc(server.socketPath);
    try {
      await session.ready();
      // The job reads its own row and its own work item.
      await expect(session.store.getJob("job_git3")).resolves.toMatchObject({ id: "job_git3" });
      await expect(session.store.getWorkItem(item.id)).resolves.toMatchObject({ id: item.id });
      // It appends an audit row in its OWN space with a git-legitimate event.
      await expect(
        session.store.appendAudit({ space_id: space.id, actor: "executor", event_type: "work_item.delivery_pending", payload: "{}" }),
      ).resolves.toBeGreaterThan(0);
      // Its own outbox completion row posts.
      await expect(
        session.store.postOutboxRow({ id: "job_git3", kind: "git", payload: { workItemId: item.id }, space: space.id }),
      ).resolves.toBeUndefined();
    } finally {
      session.close();
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Mount-scope + request regression: the Docker request and `docker run` args
// must NEVER carry the SQLite DB, a broad data/workspaces/transcripts/secrets
// root, or a dbPath; each job mounts only exact per-job subpaths.
// ---------------------------------------------------------------------------
describe("production docker mounts are per-job exact subpaths (no shared roots, no dbPath)", () => {
  test("the job request and run args never reveal a dbPath or mount a whole volume / raw DB", async () => {
    const { store, dbPath, dir } = freshStore();
    // A git work-item job (uses workspace + transcript + git PAT).
    const pat = "ghp_ci_test_pat";
    const tokenFile = join(dir, "secrets", "github-pat");
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(tokenFile, `${pat}\n`, { mode: 0o600 });
    const askpassScript = join(dir, "secrets", "git-askpass.sh");
    writeFileSync(askpassScript, "#!/bin/sh\nexec cat \"$EXECUTOR_GIT_TOKEN_FILE\"\n", { mode: 0o700 });
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C-git-mounts" });
    const item = await store.createWorkItem({ space_id: space.id, requester: "U1", description: "git mount scoping" });
    await store.enqueueJob({ id: "git-mounts-job", kind: "git", payload: { workItemId: item.id }, spaceId: space.id });
    const job = (await store.claimNextJob(1_000))!;

    // Capture the request the supervisor writes to stdin and the run args.
    let stdinPayload = "";
    const capturing: DockerClient = {
      launch(args: string[]) {
        if (!args.includes("run")) {
          return new FakeProc(0, new FakeDocker());
        }
        const stdin = new Writable({ write(chunk: Buffer, _e, cb) { stdinPayload += chunk.toString("utf8"); cb(); } });
        const stdout = new Readable({ read() {} });
        const stderr = new Readable({ read() {} });
        let resolveExit: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => { resolveExit = r; });
        // Complete the job with a canned but schema-valid response.
        queueMicrotask(() => {
          stdout.push(Buffer.from(JSON.stringify({ version: SANDBOX_PROTOCOL_VERSION, mode: "execute", pid: 9999, result: { exitCode: 0, signal: null, timedOut: false } }) + "\n"));
          stdout.push(null);
          stderr.push(null);
          resolveExit({ code: 0, signal: null });
        });
        return { stdin, stdout, stderr, exit, kill: () => resolveExit({ code: null, signal: "SIGKILL" }) };
      },
    };
    const runner = createDockerSandboxRunner({
      hostStore: store,
      memoryProvider: memoryDenyProvider,
      workspacesDir: join(dir, "workspaces"),
      transcriptDir: join(dir, "transcripts"),
      volume: "data",
      volumeWorkspacesRoot: join(dir, "workspaces"),
      volumeStateRoot: join(dir),
      gitTokenFile: tokenFile,
      askpassScript,
      docker: capturing,
    });
    const result = await runner(job, runnerContext(store, dbPath, dir, 2_000));
    expect(result.exitCode).toBe(0);

    // The request carries NO dbPath and no path into the database.
    const requestJson = JSON.parse(stdinPayload);
    expect(requestJson.dbPath).toBeUndefined();
    expect(JSON.stringify(requestJson)).not.toContain("store.db");
  });

  test("raw DB / whole-volume mounts never appear in the docker run args", async () => {
    const { store, dir } = freshStore();
    let runArgs: string[] = [];
    const capturing: DockerClient = {
      launch(args: string[]) {
        if (args.includes("run")) {
          runArgs = args;
          const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
          const stdout = new Readable({ read() {} });
          const stderr = new Readable({ read() {} });
          let resolveExit: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
          const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => { resolveExit = r; });
          queueMicrotask(() => {
            stdout.push(Buffer.from(JSON.stringify({ version: SANDBOX_PROTOCOL_VERSION, mode: "execute", pid: 4242, result: { exitCode: 0, signal: null, timedOut: false } }) + "\n"));
            stdout.push(null);
            stderr.push(null);
            resolveExit({ code: 0, signal: null });
          });
          return { stdin, stdout, stderr, exit, kill: () => resolveExit({ code: null, signal: "SIGKILL" }) };
        }
        return new FakeProc(0, new FakeDocker());
      },
    };
    const job: WorkerJob = { id: "scheduled-mounts", kind: "scheduled", payload: { action: "memory_consolidation" }, attempts: 1, status: "running" };
    const runner = createDockerSandboxRunner({
      hostStore: store,
      memoryProvider: memoryDenyProvider,
      workspacesDir: join(dir, "workspaces"),
      transcriptDir: join(dir, "transcripts"),
      volume: "data",
      volumeWorkspacesRoot: join(dir, "workspaces"),
      volumeStateRoot: join(dir),
      docker: capturing,
    });
    const result = await runner(job, runnerContext(store, "", dir, 5_000));
    expect(result.exitCode).toBe(0);
    // No raw DB file appears anywhere in the run args (never a dbPath mount)
    // and no whole shared-root bind mount (`-v host:cont` short mounts).
    expect(runArgs.join(" ")).not.toMatch(/bottega\.db/);
    expect(runArgs.join(" ")).not.toContain("-v ");
    // Parse each `--mount` arg (key=value pairs) and assert every volume
    // mount is an exact per-job subpath: a nonempty `volume-subpath` and a
    // destination that is not the whole volume root / a raw DB file.
    const mountArgs = runArgs
      .map((arg, i) => (arg === "--mount" ? runArgs[i + 1] : undefined))
      .filter((v): v is string => v !== undefined);
    expect(mountArgs.length).toBeGreaterThan(0);
    let volumeMounts = 0;
    for (const mount of mountArgs) {
      const fields = new Map<string, string>();
      for (const kv of mount.split(",")) {
        const eq = kv.indexOf("=");
        if (eq === -1) continue;
        fields.set(kv.slice(0, eq), kv.slice(eq + 1));
      }
      if (fields.get("type") === "volume") {
        volumeMounts += 1;
        // A whole-volume mount (no exact subpath) is a shared-root leak.
        expect(fields.get("volume-subpath") ?? "").not.toBe("");
        const dst = fields.get("dst") ?? "";
        expect(dst).not.toMatch(/bottega\.db/);
        // The destination must be a subpath (never the bare volume root).
        expect(dst.length).toBeGreaterThan(1);
      }
    }
    expect(volumeMounts).toBeGreaterThan(0);
  });

  test("compose-style volume mode with a RELATIVE transcript dir launches and mounts the exact per-job transcript subpath", async () => {
    // The production compose bug (#101): BOTTEGA_SANDBOX_STATE_VOLUME_ROOT is
    // /app/data while the executor's transcriptDir defaults to the RELATIVE
    // data/transcripts. The runner must resolve that relative dir against the
    // state volume root so volume-subpath computes transcripts/<itemId> and
    // the job launches instead of failing subpath validation.
    const { store, dir } = freshStore();
    const pat = "ghp_ci_test_pat";
    const tokenFile = join(dir, "secrets", "github-pat");
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(tokenFile, `${pat}\n`, { mode: 0o600 });
    const askpassScript = join(dir, "secrets", "git-askpass.sh");
    writeFileSync(askpassScript, "#!/bin/sh\nexec cat \"$EXECUTOR_GIT_TOKEN_FILE\"\n", { mode: 0o700 });
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C-relative-transcripts" });
    const item = await store.createWorkItem({ space_id: space.id, requester: "U1", description: "relative transcript mounts" });
    await store.enqueueJob({ id: "git-rel-t", kind: "git", payload: { workItemId: item.id }, spaceId: space.id });
    const job = (await store.claimNextJob(1_000))!;

    let runArgs: string[] = [];
    const capturing: DockerClient = {
      launch(args: string[]) {
        if (args.includes("run")) {
          runArgs = args;
          const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
          const stdout = new Readable({ read() {} });
          const stderr = new Readable({ read() {} });
          let resolveExit: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
          const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => { resolveExit = r; });
          queueMicrotask(() => {
            stdout.push(Buffer.from(JSON.stringify({ version: SANDBOX_PROTOCOL_VERSION, mode: "execute", pid: 7777, result: { exitCode: 0, signal: null, timedOut: false } }) + "\n"));
            stdout.push(null);
            stderr.push(null);
            resolveExit({ code: 0, signal: null });
          });
          return { stdin, stdout, stderr, exit, kill: () => resolveExit({ code: null, signal: "SIGKILL" }) };
        }
        return new FakeProc(0, new FakeDocker());
      },
    };
    const runner = createDockerSandboxRunner({
      hostStore: store,
      memoryProvider: memoryDenyProvider,
      // The compose production shape: RELATIVE transcriptDir + volume roots
      // under a single host dir (simulating data mounted at /app/data).
      workspacesDir: join(dir, "workspaces"),
      transcriptDir: "data/transcripts",
      volume: "data",
      volumeWorkspacesRoot: join(dir, "workspaces"),
      volumeStateRoot: join(dir),
      gitTokenFile: tokenFile,
      askpassScript,
      docker: capturing,
    });
    const result = await runner(job, runnerContext(store, "", dir, 5_000));
    expect(result.exitCode).toBe(0);

    // The job launched (docker run reached) and the transcript mount pins the
    // exact per-job subpath data/transcripts/<itemId> — never a whole root.
    expect(runArgs.length).toBeGreaterThan(0);
    const mountArgs = runArgs
      .map((arg, i) => (arg === "--mount" ? runArgs[i + 1] : undefined))
      .filter((v): v is string => v !== undefined);
    expect(mountArgs.length).toBeGreaterThan(0);
    const transcriptMount = mountArgs.find((m) => m.includes(`dst=/transcripts/${item.id},`)) ?? mountArgs.join(" ");
    expect(transcriptMount).toContain(`volume-subpath=data/transcripts/${item.id}`);
  });

  test("a pre-launch subpath failure removes the staged credential dirs (no leak on a throwing dockerRunArgs)", async () => {
    // Regression (#101): subpath validation threw AFTER per-job credential
    // staging but BEFORE docker launch, leaking the prepared credential dir
    // (the PAT copy). The runner must remove every staged dir on that path.
    const { store, dir } = freshStore();
    const pat = "ghp_ci_test_pat";
    const tokenFile = join(dir, "secrets", "github-pat");
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(tokenFile, `${pat}\n`, { mode: 0o600 });
    const askpassScript = join(dir, "secrets", "git-askpass.sh");
    writeFileSync(askpassScript, "#!/bin/sh\nexec cat \"$EXECUTOR_GIT_TOKEN_FILE\"\n", { mode: 0o700 });
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C-cleanup-throw" });
    const item = await store.createWorkItem({ space_id: space.id, requester: "U1", description: "cleanup on subpath throw" });
    await store.enqueueJob({ id: "git-cleanup", kind: "git", payload: { workItemId: item.id }, spaceId: space.id });
    const job = (await store.claimNextJob(1_000))!;

    // volumeWorkspacesRoot points at a path that does NOT contain the
    // workspace host, so appendContainerMounts throws in relativeSubpath
    // AFTER prepareJobMounts already staged the git credential dir.
    const neverReached: DockerClient = {
      launch: () => {
        throw new Error("docker must never be launched when subpath validation fails");
      },
    };
    const runner = createDockerSandboxRunner({
      hostStore: store,
      memoryProvider: memoryDenyProvider,
      workspacesDir: join(dir, "workspaces"),
      transcriptDir: join(dir, "transcripts"),
      volume: "data",
      volumeWorkspacesRoot: join(dir, "definitely-not-the-supervisor-workspaces-root"),
      volumeStateRoot: join(dir),
      gitTokenFile: tokenFile,
      askpassScript,
      docker: neverReached,
    });
    const stagingRoot = join(dir, ".omp", "sandbox");
    const stagedGitDir = join(stagingRoot, "creds", job.id, "git");
    const stagedPat = join(stagedGitDir, "github-pat");
    // The staging root does not exist yet — prepareJobMounts creates it
    // (with the per-job cred dir) only inside the runner.
    expect(existsSync(stagingRoot)).toBe(false);

    const result = await runner(job, runnerContext(store, "", dir, 5_000));
    // Fail closed: a protocol error is returned, never a launched container.
    expect(result.protocolError).toMatch(/not inside volume root/);
    // prepareJobMounts ran (the staging root chain was created and left in
    // place — only per-job leaves are removed), so the PAT copy was staged…
    expect(existsSync(stagingRoot)).toBe(true);
    // …and the cleanup finally removed every per-job credential dir, so no
    // auth material leaks (the staged github-pat + its cred dir are gone).
    expect(existsSync(stagedPat)).toBe(false);
    expect(existsSync(stagedGitDir)).toBe(false);
  });
});
