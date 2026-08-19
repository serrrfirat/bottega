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
import { processItem, type ExecutorConfig, type ExecutorDeps, type JobRunOutcome } from "../executor";
import type { Store } from "../store/db";
import { JOB_COMPLETED_EVENT, JOB_FAILED_EVENT } from "../store/audit-events";
import { postOutboxRow } from "../store/outbox";
import { createAudit, type AuditModule } from "../policy/audit";
import { workItemJobPayloadSchema, type WorkerJob } from "./envelope";
import { createJobScopedStore, jobScopeFromEnvelope } from "./scoped-store";
import { resolveKindCaps, type JobResourceCaps } from "./caps";

/** What a sandbox run reported back to the boss loop. */
export interface SandboxResult {
  /** The child/body exit code. null when the runner died by signal. */
  exitCode: number | null;
  /** The terminating signal, if any. */
  signal: string | null;
  /** True when the run was torn down by the supervisor's deadline. */
  timedOut: boolean;
}

/** Per-run context handed to the runner. */
export interface SandboxRunnerContext {
  deps: ExecutorDeps;
  cfg: ExecutorConfig;
  /** The kind's resolved resource caps (org overrides on the defaults). */
  caps: JobResourceCaps;
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
 * The runner the boss loop is handed when none was injected: executes the
 * job through {@link runJobSandboxBody} — the SAME body the child process
 * entrypoint runs — with the store RE-WIRED to the job-scoped facade, so
 * the whole run (processItem's internal transitions included) writes like
 * the production child (which constructs its own deps.store as the facade).
 */
export function inProcessSandboxRunner(): SandboxRunner {
  return async (job, ctx) => {
    const deps: ExecutorDeps = { ...ctx.deps, store: createJobScopedStore(ctx.deps.store, jobScopeFromEnvelope(job)) };
    return runJobSandboxBody(deps, ctx.cfg, ctx.caps, job);
  };
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
    await failSelf(store, audit, job, workItemId, err);
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
  // Lease renewal (epic #170 / issue #101): a long run (caps go to 30 min,
  // the lease default) must not let its claim expire mid-flight, or another
  // worker on the same store could reclaim and double-run it. Renew at
  // lease/2 — renewJobLease returns false only once the row is no longer
  // running (swept/re-claimed), which the child-process supervisor turns
  // into a kill; the in-process path just stops renewing.
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  if (cfg.jobLeaseMs > 0) {
    renewTimer = setInterval(() => {
      void deps.store.renewJobLease(job.id, Date.now() + cfg.jobLeaseMs);
    }, Math.max(1_000, Math.floor(cfg.jobLeaseMs / 2)));
  }
  let result: SandboxResult;
  try {
    result = await runner(job, { deps, cfg, caps });
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
  const reason =
    result.timedOut ? "sandbox timeout" : `sandbox crashed (exit ${result.exitCode ?? "signal"}${result.signal ? ` ${result.signal}` : ""})`;
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
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await store.failJob(job.id);
  await audit.appendAudit({
    ts: Date.now(),
    space_id: job.spaceId ?? null,
    actor: "executor",
    event_type: JOB_FAILED_EVENT,
    payload: JSON.stringify({ id: job.id, kind: job.kind, error: message.slice(0, 2000) }),
  });
  console.log(`[${job.id}] sandbox failed the job (${job.kind}): ${message}`);
  await unstickWorkItem(store, workItemId, message);
}

/** Parses a work item's result JSON column; null when absent or corrupt. */
function safeParseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
