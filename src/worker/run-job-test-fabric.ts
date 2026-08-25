/**
 * TEST-FABRIC-ONLY sandbox runners for the per-job sandbox boundary (issue
 * #101, epic #229 P1). These are the in-process and child-process lanes used
 * exclusively by hermetic unit tests and process fixtures — NEVER by
 * production wiring (the executor refuses to boot without the Docker runner;
 * a child process shares the host filesystem and kernel namespace and is
 * insufficient for the #338 boundary). Production uses
 * {@link createDockerSandboxRunner} in run-job.ts.
 *
 * The in-process runner ({@link inProcessSandboxRunner}) drives the whole
 * job through the job-scoped store facade inside the caller's process. The
 * child-process lane ({@link createChildProcessSandboxRunner},
 * {@link probeChildProcessSandbox}) is one strict DTO over bounded stdin, one
 * bounded reply over fd 3, an allowlisted environment, a new process group,
 * and hard timeout/lease-loss teardown of that entire group. Both share the
 * contract — scope re-derivation, fail-closed on anything but that one job,
 * caps, and the exit-code mapping — that run-job.ts's {@link runIsolatedJobBody}
 * implements and the caller-surface tests pin.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutorDeps } from "../executor";
import { createJobScopedStore, jobScopeFromEnvelope } from "./scoped-store";
import type { JobResourceCaps } from "./caps";
import {
  MAX_SANDBOX_REQUEST_BYTES,
  MAX_SANDBOX_RESPONSE_BYTES,
  SANDBOX_PROTOCOL_VERSION,
  sandboxResponseSchema,
  type SandboxRequest,
} from "./sandbox-protocol";
import {
  SAFE_CHILD_ENV_NAMES,
  runIsolatedJobBody,
  sanitizeSandboxEnv,
  readBounded,
  type SandboxProbe,
  type SandboxResult,
  type SandboxRunner,
} from "./run-job";

/**
 * In-process body adapter for hermetic unit tests only. Production wiring
 * always uses {@link createDockerSandboxRunner}; the executor refuses
 * to start without an explicitly supplied runner.
 */
export function inProcessSandboxRunner(): SandboxRunner {
  return async (job, ctx) => {
    const deps: ExecutorDeps = {
      ...ctx.deps,
      store: createJobScopedStore(ctx.deps.store, jobScopeFromEnvelope(job)),
    };
    return runIsolatedJobBody(deps, ctx.cfg, ctx.caps, job);
  };
}

export interface ChildProcessSandboxOptions {
  /** The one database file made available to the child. */
  dbPath: string;
  /** Test seam; production uses the checked-in child entrypoint. */
  entrypoint?: string;
  /** Related credential mount used only by extension jobs. Never serialized or copied into other jobs. */
  brokerTokenFile?: string;
  /** Linux deployment must have prlimit; other OSes run the process-boundary lane only. */
  requireOsResourceLimits?: boolean;
}

const SANDBOX_CHILD_ENTRYPOINT = fileURLToPath(new URL("./run-job-child.ts", import.meta.url));

/**
 * TEST-FABRIC ONLY (never production): one strict DTO over bounded stdin, one
 * bounded reply over fd 3, an allowlisted environment, a new process group,
 * and hard timeout/lease-loss teardown of that entire group. Production uses
 * {@link createDockerSandboxRunner} — a child process is insufficient for the
 * #338 boundary because it shares the host filesystem and kernel namespace.
 */
export function createChildProcessSandboxRunner(options: ChildProcessSandboxOptions): SandboxRunner {
  if (options.dbPath.trim() === "") throw new Error("sandbox database path is required");
  const entrypoint = options.entrypoint ?? SANDBOX_CHILD_ENTRYPOINT;
  const requireLimits = options.requireOsResourceLimits ?? process.platform === "linux";
  const brokerTokenFile =
    options.brokerTokenFile ?? process.env.OMP_AUTH_BROKER_TOKEN_FILE ?? "/app/data/.omp/auth-broker.token";
  return async (job, ctx) => {
    const request: SandboxRequest = {
      version: SANDBOX_PROTOCOL_VERSION,
      mode: "execute",
      dbPath: options.dbPath,
      job,
      config: ctx.cfg,
      caps: ctx.caps,
    };
    const response = await spawnSandboxChild(request, {
      entrypoint,
      caps: ctx.caps,
      signal: ctx.signal,
      tokenFile: ctx.cfg.tokenFile,
      brokerTokenFile,
      requireLimits,
    });
    if ("result" in response) return response.result;
    if ("probe" in response) {
      return { exitCode: null, signal: null, timedOut: false, protocolError: "invalid sandbox IPC: unexpected probe" };
    }
    return response;
  };
}

/** Boot-time proof that the checked-in child entrypoint and sanitized env work. */
export async function probeChildProcessSandbox(options: {
  dbPath: string;
  transcriptDir: string;
  requireOsResourceLimits?: boolean;
}): Promise<SandboxProbe> {
  const response = await spawnSandboxChild(
    { version: SANDBOX_PROTOCOL_VERSION, mode: "probe" },
    {
      entrypoint: SANDBOX_CHILD_ENTRYPOINT,
      caps: { timeoutMs: 10_000, memoryMb: 512 },
      signal: new AbortController().signal,
      tokenFile: "",
      brokerTokenFile: "",
      requireLimits: options.requireOsResourceLimits ?? process.platform === "linux",
    },
  );
  if ("protocolError" in response) throw new Error(response.protocolError);
  if (!("probe" in response)) throw new Error("sandbox probe failed");
  return response.probe;
}

type SpawnChildResult =
  | { result: SandboxResult }
  | { probe: SandboxProbe }
  | SandboxResult;

/**
 * Environment handed to a sandbox child: the child marker, the two
 * kind-scoped credential mounts (set only for their own job kind), and the
 * allowlisted host passthrough names.
 */
type SandboxChildEnv = {
  BOTTEGA_SANDBOX_CHILD: string;
  EXECUTOR_GIT_TOKEN_FILE?: string;
  OMP_AUTH_BROKER_TOKEN_FILE?: string;
} & Partial<{ [K in (typeof SAFE_CHILD_ENV_NAMES)[number]]: string }>;

async function spawnSandboxChild(
  request: SandboxRequest,
  options: {
    entrypoint: string;
    caps: JobResourceCaps;
    signal: AbortSignal;
    tokenFile: string;
    requireLimits: boolean;
    brokerTokenFile: string;
  },
): Promise<SpawnChildResult> {
  const encoded = JSON.stringify(request);
  if (Buffer.byteLength(encoded) > MAX_SANDBOX_REQUEST_BYTES) {
    return { exitCode: null, signal: null, timedOut: false, protocolError: "sandbox request exceeds IPC limit" };
  }
  const command = sandboxCommand(options.entrypoint, options.requireLimits);
  if ("error" in command) {
    return { exitCode: null, signal: null, timedOut: false, protocolError: command.error };
  }
  const env: SandboxChildEnv = { BOTTEGA_SANDBOX_CHILD: "1" };
  for (const name of SAFE_CHILD_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (options.tokenFile !== "" && request.mode === "execute" && request.job.kind === "git") {
    env.EXECUTOR_GIT_TOKEN_FILE = options.tokenFile;
  }
  if (options.brokerTokenFile !== "" && request.mode === "execute" && request.job.kind === "extension") {
    env.OMP_AUTH_BROKER_TOKEN_FILE = options.brokerTokenFile;
  }

  // Defense-in-depth: the env is built only from SAFE_CHILD_ENV_NAMES plus
  // job-scoped credential *file* handles — never from the coordinator's
  // process.env — but strip any forbidden credential name regardless so the
  // child can never inherit Slack/provider/credential secrets from the parent.
  sanitizeSandboxEnv(env);

  // Issue #105 (P2): the child now runs from its own EMPTY temp cwd, so the
  // natural `BOTTEGA_CONFIG_DIR ?? process.cwd()` fallback for relative
  // `config/` and knowledge-base paths would resolve against that empty dir
  // instead of the caller's real config root. Preserve the caller's prior
  // semantics: an unset value reverts to the coordinator cwd, and a relative
  // value resolves against that same cwd — only an absolute value passes
  // through untouched. The child's cwd itself stays empty — only the config
  // anchor is made explicit and absolute.
  if (env.BOTTEGA_CONFIG_DIR === undefined) {
    env.BOTTEGA_CONFIG_DIR = process.cwd();
  } else if (!isAbsolute(env.BOTTEGA_CONFIG_DIR)) {
    env.BOTTEGA_CONFIG_DIR = join(process.cwd(), env.BOTTEGA_CONFIG_DIR);
  }

  // The child must NEVER run from a cwd that can carry a `.env`: Bun itself
  // eagerly auto-loads `.env`/`.env.local`/mode dotenv files from the
  // process cwd (issue #105), and `@oh-my-pi/pi-coding-agent` additionally
  // reads `process.cwd()/.env` at import time — both bypass `sanitizeSandboxEnv`
  // because they happen inside the nested Bun AFTER spawn. `--no-env-file`
  // (in `sandboxCommand`) stops Bun's implicit load, but it cannot stop the
  // third-party cwd read. So the child is always spawned from a dedicated,
  // fresh, EMPTY temp directory of the sandbox's own — never whatever cwd
  // spawned this runner. No
  // dotenv file can exist there, so neither loader can ever find one.
  const childCwd = mkdtempSync(join(tmpdir(), "bottega-sandbox-child-"));
  try {
    let child: ChildProcess;
    try {
      child = spawn(command.file, command.args, {
        detached: process.platform !== "win32",
        env,
        cwd: childCwd,
        stdio: ["pipe", "inherit", "inherit", "pipe"],
      });
    } catch (error) {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        protocolError: `sandbox unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const responseStream = child.stdio[3];
    if (!(responseStream instanceof Readable) || child.stdin === null) {
      killProcessTree(child);
      return { exitCode: null, signal: null, timedOut: false, protocolError: "sandbox IPC pipes unavailable" };
    }

    let responseBytes: Buffer;
    const boundedResponse = readBounded(responseStream, MAX_SANDBOX_RESPONSE_BYTES, () => killProcessTree(child));
    child.stdin.end(encoded);
    let timedOut = false;
    let leaseLost = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, options.caps.timeoutMs);
    const abort = (): void => {
      leaseLost = true;
      killProcessTree(child);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    const exitWait = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    child.once("error", () => exitWait.resolve({ code: null, signal: null }));
    child.once("exit", (code, signal) => exitWait.resolve({ code, signal }));
    const exited = await exitWait.promise;
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);

    // The child has exited, so it no longer holds any fd into the cwd dir;
    // safe to remove it regardless of the branch below.
    try {
      rmSync(childCwd, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of the ephemeral cwd; never fail the run for it.
    }

    // A late lease-loss abort that lands AFTER the child already exited
    // cleanly must not discard the child's terminal IPC reply: the
    // supervisor's renew tick fires every half-lease and sees
    // `status != 'running'` the moment the child has self-completed the job,
    // so the exact success path this fabric verifies would be torn down as
    // lease_lost on fast hosts (#344 CI). For a clean exit the PID-checked
    // response below is authoritative — the job bus transitions stay
    // serialized by the store's status-guarded writes. A genuine mid-flight
    // loss still kills the child (signal exit), keeps `exitedCleanly` false,
    // and returns the torn-down result here.
    const exitedCleanly = exited.signal === null && exited.code !== null;
    if (timedOut || (leaseLost && !exitedCleanly)) {
      const tornDown: SandboxResult = { exitCode: null, signal: exited.signal ?? "SIGKILL", timedOut };
      if (leaseLost) tornDown.leaseLost = true;
      if (!responseStream.destroyed) responseStream.destroy();
      return tornDown;
    }

    try {
      responseBytes = await boundedResponse;
    } catch (error) {
      const invalid: SandboxResult = {
        exitCode: null,
        signal: exited.signal,
        timedOut,
        protocolError: `invalid sandbox IPC: ${error instanceof Error ? error.message : String(error)}`,
      };
      if (leaseLost) invalid.leaseLost = true;
      return invalid;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(responseBytes.toString("utf8"));
    } catch {
      return { exitCode: null, signal: exited.signal, timedOut: false, protocolError: "invalid sandbox IPC: response is not JSON" };
    }
    const parsed = sandboxResponseSchema.safeParse(parsedJson);
    if (!parsed.success || parsed.data.pid !== child.pid) {
      return { exitCode: null, signal: exited.signal, timedOut: false, protocolError: "invalid sandbox IPC: schema or PID mismatch" };
    }
    if (parsed.data.mode === "probe") {
      return {
        probe: {
          pid: parsed.data.pid,
          childMarker: parsed.data.childMarker,
          forbiddenEnvNames: parsed.data.forbiddenEnvNames,
        },
      };
    }
    const expectedProcessExit = parsed.data.result.exitCode ?? 70;
    if (exited.signal !== null || exited.code !== expectedProcessExit) {
      return { exitCode: null, signal: exited.signal, timedOut: false, protocolError: "invalid sandbox IPC: exit mismatch" };
    }
    return { result: parsed.data.result };
  } finally {
    // Defensive: if the child never spawned or an early return happened
    // before exit, still remove the ephemeral cwd.
    try {
      rmSync(childCwd, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

/**
 * Without `--no-env-file`, Bun eagerly auto-loads `.env`, `.env.*`, and
 * mode-specific dotenv files from the child's cwd at startup (issue #105).
 * The parent already strips forbidden credential names from the spawned env,
 * but a real `.env` sitting in the runner's cwd would be re-injected by the
 * nested Bun runtime itself — silently reintroducing Slack/provider secrets
 * into a child that must be hermetic. This is the child-process TEST FABRIC
 * (never the production Docker boundary), so disabling Bun's implicit dotenv
 * loading here is safe and required; production isolation is unchanged.
 *
 * On Linux the child additionally runs under `/usr/bin/prlimit` for
 * process-count and file-descriptor caps. Deliberately NO `--as`/RLIMIT_AS:
 * that limit caps *virtual address space*, not resident memory, and the
 * Bun/JSC runtime reserves well over 3 GiB of address space at startup
 * (verified empirically: a 3 GiB cap SIGTRAPs the runtime before main(),
 * 4 GiB boots). Any job-realistic `memoryMb` ceiling (32–512 MiB) therefore
 * killed the child before it could ever write its IPC response. Real memory
 * enforcement belongs to the production Docker lane's cgroup
 * `--memory ${caps.memoryMb}m`, which bounds RSS properly.
 */
function sandboxCommand(entrypoint: string, requireLimits: boolean): { file: string; args: string[] } | { error: string } {
  if (process.platform !== "linux") return { file: process.execPath, args: ["--no-env-file", entrypoint] };
  const prlimit = "/usr/bin/prlimit";
  if (!existsSync(prlimit)) {
    if (requireLimits) return { error: "sandbox unavailable: /usr/bin/prlimit is required for resource caps" };
    return { file: process.execPath, args: ["--no-env-file", entrypoint] };
  }
  return {
    file: prlimit,
    args: [
      "--nofile=256:256",
      "--nproc=128:128",
      "--",
      process.execPath,
      "--no-env-file",
      entrypoint,
    ],
  };
}

function killProcessTree(child: ChildProcess): void {
  const childPid = child.pid;
  if (childPid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
      return;
    }
    // Exact-pid tree kill. We deliberately do NOT signal a process GROUP
    // (`kill(-pgid)`): a negative signal addresses every member of the group,
    // and under a concurrent multi-file `bun test` the sandbox child's pid is
    // free to be recycled the instant it exits — the OS can hand it to a
    // freshly-spawned sibling test worker, and `kill(-pid)` would then SIGKILL
    // that worker (the intermittent exit-137 runner kill, #344). Instead we
    // snapshot the live process table, walk PPID ancestry from our child to
    // find only processes that descend from it, and SIGKILL each by its exact
    // pid — leaf-first, re-verified against a fresh snapshot right before the
    // signal. The runner, its parent, and sibling workers are unreachable
    // because none of them is a descendant of the sandbox child. A grandchild
    // a nested Bun misplaced into the worker's group is still found (its parent
    // is the child) and reaped.
    const snapshot = () => {
      const childrenOf = new Map<number, number[]>();
      let table = "";
      try {
        table = execFileSync("ps", ["-o", "pid=,ppid=", "-A"], { encoding: "utf8", timeout: 2_000 });
      } catch {
        return childrenOf;
      }
      for (const line of table.split("\n")) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 2) continue;
        const pid = Number(cols[0]);
        const ppid = Number(cols[1]);
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
        const sib = childrenOf.get(ppid) ?? [];
        sib.push(pid);
        childrenOf.set(ppid, sib);
      }
      return childrenOf;
    };
    const childrenOf = snapshot();
    const descendants: number[] = [];
    const stack = [childPid];
    const seen = new Set<number>([childPid]);
    while (stack.length > 0) {
      // SAFETY: the stack only ever holds `number` pids (seeded with the
      // numeric child pid and pushed from the numeric `childrenOf` map), so a
      // non-empty pop is always a number. A guard avoids the type assertion.
      const popped = stack.pop();
      if (popped === undefined) break;
      const pid = popped;
      for (const kid of childrenOf.get(pid) ?? []) {
        if (seen.has(kid)) continue;
        seen.add(kid);
        descendants.push(kid);
        stack.push(kid);
      }
    }
    descendants.reverse(); // deepest first
    // Re-verify descendants against a FRESH snapshot taken right before the
    // signal loop: only exact pids that are STILL descendants of the child at
    // this instant are killed. Any pid recycled into an unrelated live worker
    // (a transitively-changed PPID chain) fails the ancestry check and is left
    // alone, so sibling workers are unreachable.
    const freshChildren = snapshot();
    for (const pid of descendants) {
      if (pid === process.pid || pid === process.ppid || pid <= 1) continue;
      if (!snapshotDescendantOf(pid, childPid, freshChildren)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited; safe to move on.
      }
    }
    child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited. The exit event below is the teardown proof.
    }
  }
}

/** True if `pid`'s PPID chain (in `childrenOf`) reaches `root`. */
function snapshotDescendantOf(pid: number, root: number, childrenOf: Map<number, number[]>): boolean {
  const parentOf = new Map<number, number>();
  for (const [ppid, kids] of childrenOf) {
    for (const kid of kids) parentOf.set(kid, ppid);
  }
  let current = pid;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = parentOf.get(current);
    if (parent === undefined) return false;
    if (parent === root) return true;
    current = parent;
  }
  return false;
}