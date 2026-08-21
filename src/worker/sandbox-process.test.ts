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
import { jobScopeFromEnvelope } from "./scoped-store";
import { resolveMemoryProvider } from "../server/memory-provider";

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
    const run = fake.runLaunch();
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
    // Register the container so a lease-abort docker kill can tear it down.
    fake.runLaunch();
    // Once the container is "running", lose the lease: the renewal abort must
    // docker-kill the container tree and fail the job loudly.
    await store.failJob(job.id);

    const outcome = await pending;
    expect(outcome.state).toBe("blocked");
    expect(fake.killLaunches().length).toBeGreaterThan(0);
    const failed = await store.listAudit({ event_type: JOB_FAILED_EVENT });
    expect(failed.some((row) => JSON.parse(row.payload).error === "sandbox lease lost")).toBe(true);
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
  function makeRpc() {
    const { store, dir } = freshStore();
    const job: WorkerJob = { id: "job_1", kind: "scheduled", payload: { action: "memory_consolidation" }, attempts: 1, status: "running" };
    const scope = jobScopeFromEnvelope(job);
    const rpcDir = join(dir, "rpc");
    mkdirSync(rpcDir, { recursive: true });
    const server = JobStoreRpcServer.create(store, scope, rpcDir, {
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
    const { server } = makeRpc();
    await server.listen();
    const session = connectStoreRpc(server.socketPath);
    try {
      await session.ready();
      await session.store.setIngestWatermark("github", "cursor-1");
      expect(await session.store.getIngestWatermark("github")).toBe("cursor-1");
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
    const joined = runArgs.join(" ");
    // No raw DB file mount and no whole shared-root bind mount (no `-v host:cont` short mounts).
    expect(joined).not.toMatch(/bottega\.db/);
    expect(joined).not.toContain("-v ");
    // The per-job RPC socket dir is mounted via an exact volume-subpath.
    expect(joined).toContain("--mount type=volume");
    expect(joined).toContain("volume-subpath=");
    // A whole-volume mount (type=volume without volume-subpath) never appears.
    expect(joined).not.toContain("type=volume,src=data");
  });
});
