/**
 * The per-job sandbox runner (issue #101, epic #229 P1): when
 * {@link ExecutorDeps.sandboxRunner} is present, git/extension jobs are
 * executed OUTSIDE the executor's main runWorkItemJob path — through this
 * module's {@link runJobSandboxBody}, which re-derives the job's scope from
 * its envelope id and drives the WHOLE job through the job-scoped store
 * facade ({@link createJobScopedStore}): claim, transitions, completion,
 * outbox row, and audits all write through the scope-guarded facade — never
 * the raw store. The boss loop's parent side ({@link runJobInSandbox})
 * maps the runner's exit code onto the job bus:
 *
 *   0 -> the sandbox completed the job itself (per-job outbox + audit
 *        written; the parent skips its own bookkeeping via selfReported).
 *   2 -> the sandbox already failed the job loudly (job.failed audit +
 *        item blocked written by the sandbox).
 *   3 -> transient lease-reclaim race — the parent requeues with backoff.
 *   other/signal/timeout -> CRASH: the parent fails the job loudly
 *        (failJob + job.failed audit) and unsticks the work item so it can
 *        NEVER hang at working after a sandbox crash (issue #149 question
 *        — the blocked landing guarantees the work item surfaces).
 *
 * P1 scope note: the runner is the per-job ISOLATION BOUNDARY — one job,
 * its own scoped store surface, per-kind resource caps. True child-PROCESS
 * teardown via Bun.spawn is the production wiring (deferred to the
 * follow-up); the contract — scope re-derivation, fail-closed on anything
 * but that one job, caps, and the exit-code mapping — is implemented here
 * and is what the caller-surface tests pin.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { processItem, runIngestPollJob, runKbJob, type ExecutorConfig, type ExecutorDeps, type JobRunOutcome } from "../executor";
import type { Store } from "../store/db";
import { JOB_COMPLETED_EVENT, JOB_FAILED_EVENT } from "../store/audit-events";
import { postOutboxRow } from "../store/outbox";
import { createAudit, type AuditModule } from "../policy/audit";
import type { SchedulerActionName } from "../scheduler/types";
import { scheduledJobPayloadSchema, workItemJobPayloadSchema, type WorkerJob } from "./envelope";
import { createJobScopedStore, jobScopeFromEnvelope } from "./scoped-store";
import { resolveKindCaps, type JobResourceCaps } from "./caps";
import {
  MAX_SANDBOX_REQUEST_BYTES,
  MAX_SANDBOX_RESPONSE_BYTES,
  SANDBOX_PROTOCOL_VERSION,
  sandboxResponseSchema,
  type SandboxRequest,
} from "./sandbox-protocol";

/** What a sandbox run reported back to the boss loop. */
export interface SandboxResult {
  /** The child/body exit code. null when the runner died by signal or invalid IPC. */
  exitCode: number | null;
  /** The terminating signal, if any. */
  signal: string | null;
  /** True when the run was torn down by the supervisor's deadline. */
  timedOut: boolean;
  /** True when lease renewal proved that the parent no longer owns the job. */
  leaseLost?: boolean;
  /** Bounded protocol validation failure. Never contains child output beyond the cap. */
  protocolError?: string;
}

/** Per-run context handed to the runner. */
export interface SandboxRunnerContext {
  deps: ExecutorDeps;
  cfg: ExecutorConfig;
  /** The kind's resolved resource caps (org overrides on the defaults). */
  caps: JobResourceCaps;
  /** Aborted by the boss loop when lease renewal fails. The runner must kill the full process tree. */
  signal: AbortSignal;
}

/** The injectable runner seam (tests supply fakes; production supplies the child). */
export type SandboxRunner = (job: WorkerJob, ctx: SandboxRunnerContext) => Promise<SandboxResult>;

/** Exit contract (see module doc). */
export const SANDBOX_EXIT_COMPLETED = 0;
export const SANDBOX_EXIT_FAILED = 2;
export const SANDBOX_EXIT_REQUEUE = 3;

/** Resolves the per-kind caps with the org settings `caps` overrides. */
export function capsFor(kind: WorkerJob["kind"], store: Store): JobResourceCaps {
  return resolveKindCaps(kind, store.getOrgSettings()?.caps ?? null);
}

/**
 * In-process body adapter for hermetic unit tests only. Production wiring
 * always uses {@link createChildProcessSandboxRunner}; the executor refuses
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

export interface SandboxProbe {
  pid: number;
  childMarker: "1";
  forbiddenEnvNames: string[];
}

const SANDBOX_CHILD_ENTRYPOINT = fileURLToPath(new URL("./run-job-child.ts", import.meta.url));
const SAFE_CHILD_ENV_NAMES = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "BOTTEGA_EXTENSIONS_DIR",
  "BOTTEGA_CONFIG_DIR",
  "OMP_AUTH_BROKER_URL",
  "BOTTEGA_PROXY_CONTROL_URL",
  "BOTTEGA_PROXY_SECRETS_DIR",
] as const;

/**
 * Production launcher: one strict DTO over bounded stdin, one bounded reply
 * over fd 3, an allowlisted environment, a new process group, and hard
 * timeout/lease-loss teardown of that entire group.
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
  const command = sandboxCommand(options.entrypoint, options.caps.memoryMb, options.requireLimits);
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

  let child: ChildProcess;
  try {
    child = spawn(command.file, command.args, {
      detached: process.platform !== "win32",
      env,
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
  if (timedOut || leaseLost) {
    const tornDown: SandboxResult = { exitCode: null, signal: exited.signal ?? "SIGKILL", timedOut };
    if (leaseLost) tornDown.leaseLost = true;
    return tornDown;
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
}

function sandboxCommand(
  entrypoint: string,
  memoryMb: number,
  requireLimits: boolean,
): { file: string; args: string[] } | { error: string } {
  if (process.platform !== "linux") return { file: process.execPath, args: [entrypoint] };
  const prlimit = "/usr/bin/prlimit";
  if (!existsSync(prlimit)) {
    if (requireLimits) return { error: "sandbox unavailable: /usr/bin/prlimit is required for resource caps" };
    return { file: process.execPath, args: [entrypoint] };
  }
  return {
    file: prlimit,
    args: [
      `--as=${memoryMb * 1024 * 1024}`,
      "--nofile=256:256",
      "--nproc=128:128",
      "--",
      process.execPath,
      entrypoint,
    ],
  };
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited. The exit event below is the teardown proof.
    }
  }
}

function readBounded(
  stream: NodeJS.ReadableStream,
  limit: number,
  onOverflow: () => void,
): Promise<Buffer> {
  const read = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) {
      onOverflow();
      read.reject(new Error(`response exceeds ${limit} bytes`));
      return;
    }
    chunks.push(bytes);
  });
  stream.once("end", () => read.resolve(Buffer.concat(chunks)));
  stream.once("error", read.reject);
  return read.promise;
}

/** Dispatches every durable worker kind inside the same real isolation boundary. */
export async function runIsolatedJobBody(
  deps: ExecutorDeps,
  cfg: ExecutorConfig,
  caps: JobResourceCaps,
  job: WorkerJob,
): Promise<SandboxResult> {
  switch (job.kind) {
    case "git":
    case "extension":
      return runJobSandboxBody(deps, cfg, caps, job);
    case "scheduled":
      return runScheduledJobBody(deps, cfg, caps, job);
    case "kb":
    case "ingest_poll": {
      const store = createJobScopedStore(deps.store, jobScopeFromEnvelope(job));
      const audit = createAudit(store);
      try {
        const outcome =
          job.kind === "kb" ? await runKbJob({ ...deps, store }, job) : await runIngestPollJob({ ...deps, store }, job);
        await completeSelf(store, audit, job, outcome);
        return { exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await failJobSelf(store, audit, job, message);
        return { exitCode: SANDBOX_EXIT_FAILED, signal: null, timedOut: false };
      }
    }
  }
}

/**
 * One job's isolated run body: the code that runs inside the sandbox (child
 * process in production, injected runner in tests). Re-derives the scope
 * from the envelope id (fail closed: the facade permits ONLY this job's
 * rows), claims the work item, runs the item's full delivery lifecycle, and
 * writes ITS OWN terminal lifecycle (completeJob + own outbox row + audit)
 * through the scoped facade. Never touches the claim loop's global sweep;
 * never touches another job's rows.
 */
export async function runJobSandboxBody(
  deps: ExecutorDeps,
  cfg: ExecutorConfig,
  _caps: JobResourceCaps,
  job: WorkerJob,
): Promise<SandboxResult> {
  const scope = jobScopeFromEnvelope(job);
  const store = createJobScopedStore(deps.store, scope);
  const audit = createAudit(store);

  const parsed = workItemJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // Malformed envelope → loud crash (parent fails the job).
    throw new Error(`job ${job.id} (${job.kind}) payload must be { workItemId } — failing closed`);
  }
  const workItemId = parsed.data.workItemId;

  try {
    const item = await store.claimWorkItemById(workItemId);
    if (item === null) {
      const current = await store.getWorkItem(workItemId);
      if (current === null) {
        throw new Error(`work item ${workItemId} not found`);
      }
      if (current.state === "done" || current.state === "blocked" || current.state === "aborted") {
        // Already settled elsewhere — the sandbox completes as a no-op and
        // writes its own outbox row so the server sees the settlement.
        await completeSelf(store, audit, job, { state: current.state, result: null });
        return { exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false };
      }
      // claimed/working under a live owner (lease-reclaim race): requeue,
      // never double-execute.
      return { exitCode: SANDBOX_EXIT_REQUEUE, signal: null, timedOut: false };
    }

    const settled = await processItem(deps, cfg, item);
    await completeSelf(store, audit, job, {
      state: settled.state,
      result: safeParseJson(settled.result),
    });
    return { exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false };
  } catch (err) {
    // Loud self-fail: the sandbox owns its failure — job.failed audit +
    // the item lands blocked (never stuck at working).
    const message = err instanceof Error ? err.message : String(err);
    await failSelf(store, audit, job, workItemId, message);
    return { exitCode: SANDBOX_EXIT_FAILED, signal: null, timedOut: false };
  }
}

/**
 * One scheduled job's isolated run body (issue #272, epic #229 P2): the
 * dispatcher-dispatch leg. Re-derives the scope from the envelope id (fail
 * closed: the facade permits ONLY this job's rows), resolves the named
 * action in the executor's scheduled-action registry (an unknown action
 * fails LOUDLY naming it — never a silent no-op), runs it against the
 * job-scoped store facade with the model-call seam from the job context,
 * and writes ITS OWN terminal lifecycle (completeJob + own outbox row +
 * audit) through the scoped facade. The action's return value rides the
 * completion outbox row + audit as the result. Worker actions never post to
 * Slack — the outbox seam is the post path — and have no policy context.
 */
export async function runScheduledJobBody(
  deps: ExecutorDeps,
  _cfg: ExecutorConfig,
  _caps: JobResourceCaps,
  job: WorkerJob,
): Promise<SandboxResult> {
  const scope = jobScopeFromEnvelope(job);
  const store = createJobScopedStore(deps.store, scope);
  const audit = createAudit(store);

  const parsed = scheduledJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // Malformed envelope → loud crash (parent fails the job).
    throw new Error(
      `job ${job.id} (scheduled) payload must be { action, ... } — failing closed: ${parsed.error.message}`,
    );
  }
  const { action: actionName, params } = parsed.data;
  // SAFETY: scheduledJobPayloadSchema types action as an arbitrary string; the
  // registry is keyed by the statically known SchedulerActionName union, so a
  // name outside it misses the map and the unknown-action throw below fails closed.
  const action = deps.scheduledActions?.get(actionName as SchedulerActionName);
  if (!action) {
    throw new Error(`scheduled job ${job.id} failed: unknown action "${actionName}" — no silent no-op`);
  }

  try {
    const result = await action.run(params, {
      store,
      audit,
      memoryProvider: deps.memoryProvider,
      postMessage: () => {
        throw new Error(
          `scheduled action ${actionName} attempted to post to Slack — the worker holds no tokens; the outbox seam is the post path`,
        );
      },
      loadPolicy: async () => {
        throw new Error(`scheduled action ${actionName} has no policy context in the worker`);
      },
      log: (line) => console.log(`[${job.id}] ${line}`),
      now: Date.now,
      consolidationModelCall: deps.consolidationModelCall,
    });
    await completeSelf(store, audit, job, { state: "completed", result: result ?? null });
    return { exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false };
  } catch (err) {
    // Loud self-fail: the action body owns its failure — job.failed audit,
    // no outbox row (the job bus surfaces the failure).
    const message = err instanceof Error ? err.message : String(err);
    await store.failJob(job.id);
    await audit.appendAudit({
      ts: Date.now(),
      space_id: job.spaceId ?? null,
      actor: "executor",
      event_type: JOB_FAILED_EVENT,
      payload: JSON.stringify({ id: job.id, kind: job.kind, error: message.slice(0, 2000) }),
    });
    console.log(`[${job.id}] scheduled job failed (${actionName}): ${message}`);
    return { exitCode: SANDBOX_EXIT_FAILED, signal: null, timedOut: false };
  }
}

/** The boss-loop supervisor: map a runner result onto the job bus. */
export async function runJobInSandbox(
  deps: ExecutorDeps,
  cfg: ExecutorConfig,
  job: WorkerJob,
  runner: SandboxRunner,
): Promise<JobRunOutcome> {
  const caps = capsFor(job.kind, deps.store);
  const leaseAbort = new AbortController();
  let renewing = false;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  if (cfg.jobLeaseMs > 0) {
    renewTimer = setInterval(() => {
      if (renewing || leaseAbort.signal.aborted) return;
      renewing = true;
      void deps.store
        .renewJobLease(job.id, Date.now() + cfg.jobLeaseMs)
        .then((renewed) => {
          if (!renewed) leaseAbort.abort("lease_lost");
        })
        .catch(() => leaseAbort.abort("lease_lost"))
        .finally(() => {
          renewing = false;
        });
    }, Math.max(10, Math.floor(cfg.jobLeaseMs / 2)));
  }
  let result: SandboxResult;
  try {
    result = await runner(job, { deps, cfg, caps, signal: leaseAbort.signal });
  } finally {
    if (renewTimer !== null) clearInterval(renewTimer);
  }

  if (result.exitCode === SANDBOX_EXIT_COMPLETED || result.exitCode === SANDBOX_EXIT_FAILED) {
    // The sandbox already wrote the terminal lifecycle (completion or
    // failure). The parent must not write a second outbox row or audit.
    return {
      state: result.exitCode === SANDBOX_EXIT_COMPLETED ? "done" : "blocked",
      result: null,
      selfReported: true,
    };
  }
  if (result.exitCode === SANDBOX_EXIT_REQUEUE) {
    throw new Error(`sandbox requested requeue for ${job.id} (lease-reclaim race)`);
  }
  // Crash: fail loud — job.failed audit + the item never hangs at working.
  await failLoud(deps, job, result);
  return { state: "blocked", result: null, selfReported: true };
}

/**
 * Crash recovery (issue #101): the sandbox died without writing a terminal
 * lifecycle, so the PARENT fails the job loudly and unsticks the work item.
 * A crashed git/extension job is NEVER silently requeued — it surfaces as
 * a failed job + a blocked work item (the #149 landing).
 */
async function failLoud(deps: ExecutorDeps, job: WorkerJob, result: SandboxResult): Promise<void> {
  const reason = result.leaseLost
    ? "sandbox lease lost"
    : result.timedOut
      ? "sandbox timeout"
      : result.protocolError
        ? result.protocolError
        : `sandbox crashed (exit ${result.exitCode ?? "signal"}${result.signal ? ` ${result.signal}` : ""})`;
  await deps.store.failJob(job.id);
  await deps.store.appendAudit({
    space_id: job.spaceId ?? null,
    actor: "executor",
    event_type: JOB_FAILED_EVENT,
    payload: JSON.stringify({ id: job.id, kind: job.kind, error: reason, sandbox_crash: true }),
  });
  console.log(`[${job.id}] ${reason} — job failed loudly, work item unstuck`);

  const parsed = workItemJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) return; // no work item to unstick
  await unstickWorkItem(deps.store, parsed.data.workItemId, reason);
}

/**
 * Moves the job's work item to blocked so a crash never leaves it stuck at
 * working/claimed. Uses the two-step claimed→working→blocked when the item
 * is still claimed (claimed→blocked is not a legal move) and the direct
 * working→blocked otherwise. Failures here are logged, never thrown — the
 * job already failed and the audit trail is the source of truth.
 */
export async function unstickWorkItem(store: Store, workItemId: string, reason: string): Promise<void> {
  const evidence = `sandbox crash: ${reason}`;
  const current = await store.getWorkItem(workItemId);
  if (current === null) return;
  if (current.state === "blocked" || current.state === "aborted" || current.state === "done") return;
  try {
    if (current.state === "claimed") {
      await store.transitionWorkItem(workItemId, "claimed", "working", { by: "executor" });
    }
    await store.transitionWorkItem(workItemId, "working", "blocked", { evidence, by: "executor" });
  } catch (err) {
    console.log(
      `[${workItemId}] could not unstick work item (${err instanceof Error ? err.message : String(err)}) — job already failed loudly`,
    );
  }
}

/** The sandbox's own success bookkeeping: completeJob + one outbox row + audit. */
async function completeSelf(
  store: Store,
  audit: AuditModule,
  job: WorkerJob,
  outcome: { state: string; result: unknown },
): Promise<void> {
  await store.completeJob(job.id);
  postOutboxRow(store, {
    id: job.id,
    kind: job.kind,
    payload: { state: outcome.state, result: outcome.result ?? null },
    space: job.spaceId ?? null,
  });
  await audit.appendAudit({
    ts: Date.now(),
    space_id: job.spaceId ?? null,
    actor: "executor",
    event_type: JOB_COMPLETED_EVENT,
    payload: JSON.stringify({ id: job.id, kind: job.kind, state: outcome.state, result: outcome.result ?? null }),
  });
}

/** The sandbox's own failure bookkeeping: failJob + job.failed audit + item blocked. */
async function failSelf(
  store: Store,
  audit: AuditModule,
  job: WorkerJob,
  workItemId: string,
  message: string,
): Promise<void> {
  await failJobSelf(store, audit, job, message);
  await unstickWorkItem(store, workItemId, message);
}

/** Failure bookkeeping for isolated kinds that do not own a work-item row. */
async function failJobSelf(store: Store, audit: AuditModule, job: WorkerJob, message: string): Promise<void> {
  await store.failJob(job.id);
  await audit.appendAudit({
    ts: Date.now(),
    space_id: job.spaceId ?? null,
    actor: "executor",
    event_type: JOB_FAILED_EVENT,
    payload: JSON.stringify({ id: job.id, kind: job.kind, error: message.slice(0, 2000) }),
  });
  console.log(`[${job.id}] sandbox failed the job (${job.kind}): ${message}`);
}

/** One decoded JSON document — the domain of a work item's stored result column. */
type JsonDocument = string | number | boolean | null | JsonDocument[] | { [key: string]: JsonDocument };

/** Parses a work item's result JSON column; null when absent or corrupt. */
function safeParseJson(text: string | null): JsonDocument {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
