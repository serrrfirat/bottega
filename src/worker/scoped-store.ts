/**
 * Job-scoped store facade (issue #101, epic #229 P1): the per-job sandbox
 * runner's ONLY view of the store. The facade implements the full {@link
 * Store} by forwarding, but hard-denies anything outside the job's own
 * rows — its one worker_job row, its one work item, and reads/writes to
 * anything else are rejected with {@link ScopedStoreAccessError} LOUDLY
 * (throw), never silently dropped or defaulted.
 *
 * Scope model: one job owns one envelope id and one work item. The git and
 * extension kinds use the work item id as the job id; kb/ingest_poll jobs
 * have no work item (their payload rides the envelope), so those kinds pass
 * a scope with workItemId cleared and the work-item guards are inert.
 *
 * Boundary note: the child runs the actual job (its own item session +
 * workspace + tools) through this facade, while read-only shared infra
 * (org settings, memory provider, extension registry lookups) may touch the
 * real store — those reads are not write-scoped by design, and the facade's
 * job-row/work-item/enqueue guards are the write firewall.
 */
import type { Store, TransitionOpts, WorkItemState } from "../store/db";
import type { WorkerJob } from "./envelope";

/** A scoped-store breach: the sandbox asked for rows outside its own job. */
export class ScopedStoreAccessError extends Error {
  constructor(jobId: string, what: string) {
    super(`job ${jobId} attempted ${what}; the sandbox store is its own job's rows only`);
    this.name = "ScopedStoreAccessError";
  }
}

export interface JobScope {
  /** The envelope id of THIS job — the only worker_job row the runner may touch. */
  jobId: string;
  /**
   * The work item this job owns (git/extension). Null for kinds whose item
   * is not in the store (kb/ingest_poll/scheduled) — their work-item guards
   * become inert rather than complaining.
   */
  workItemId: string | null;
}

/** The durable envelope kinds that own a work item in the store. */
const WORK_ITEM_KINDS: Record<string, true> = { git: true, extension: true };

export function isWorkItemKind(job: WorkerJob): boolean {
  return WORK_ITEM_KINDS[job.kind] === true;
}

/**
 * Derives a job's scope from its envelope: git/extension jobs own the work
 * item named in the payload; kb/ingest_poll/scheduled have no store work
 * item. The scope derivation is the child's fail-closed gate: whatever the
 * job asked for, the facade only ever exposes THIS scope.
 */
export function jobScopeFromEnvelope(job: WorkerJob): JobScope {
  const payload = job.payload as { workItemId?: unknown };
  const workItemId =
    isWorkItemKind(job) && typeof payload.workItemId === "string" && payload.workItemId.length > 0
      ? payload.workItemId
      : null;
  return { jobId: job.id, workItemId };
}

/**
 * Wraps `base` so every method enforces the job scope. Methods that would
 * (a) touch another job's worker_job row, (b) enqueue/claim any job, or
 * (c) read/mutate a work item the job does not own are denied loudly. All
 * other slices (spaces, org settings, audit, scheduler reads, the shared
 * db handle) forward to the real store unchanged.
 */
export function createJobScopedStore<T extends Store>(base: T, scope: JobScope): T {
  const deny = (what: string): never => {
    throw new ScopedStoreAccessError(scope.jobId, what);
  };

  const ownJob = (id: string): string => (id === scope.jobId ? id : deny(`job-row access to ${id}`));
  const ownItem = (id: string): string =>
    isOwnItem(scope, id) ? id : deny(`work-item access to ${id}`);

  const handler: ProxyHandler<T> = {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      const name = prop as string;

      if (name === "getJob") {
        return (id: string) => base.getJob(ownJob(id));
      }
      if (name === "completeJob") {
        return (id: string) => base.completeJob(ownJob(id));
      }
      if (name === "failJob") {
        return (id: string) => base.failJob(ownJob(id));
      }
      if (name === "requeueJob") {
        return (id: string, backoffMs: number) => base.requeueJob(ownJob(id), backoffMs);
      }
      if (name === "renewJobLease") {
        return (id: string, leaseUntilMs: number) => base.renewJobLease(ownJob(id), leaseUntilMs);
      }
      // The isolated job never enqueues new jobs and never claims/sweeps —
      // those are the boss loop's job, not the sandbox's.
      if (name === "enqueueJob" || name === "claimNextJob" || name === "markUnclaimedJobs") {
        return (..._args: unknown[]): never => deny(name);
      }

      if (name === "getWorkItem") {
        return (id: string) => base.getWorkItem(ownItem(id));
      }
      if (name === "claimWorkItemById") {
        return (id: string, assignee?: string) => base.claimWorkItemById(ownItem(id), assignee);
      }
      if (name === "transitionWorkItem") {
        return (id: string, from: WorkItemState, to: WorkItemState, opts?: TransitionOpts) =>
          base.transitionWorkItem(ownItem(id), from, to, opts);
      }
      if (name === "listWorkItems") {
        return () => deny("listWorkItems — a scoped job reads its own item, not the queue");
      }
      if (name === "markStaleWorkItems") {
        return () => deny("markStaleWorkItems — stale-sweep is the boss loop's job");
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  };

  return new Proxy(base, handler) as T;
}

/** Whether a work-item read/transition is inside this job's scope. */
function isOwnItem(scope: JobScope, itemId: string): boolean {
  return scope.workItemId !== null && itemId === scope.workItemId;
}
