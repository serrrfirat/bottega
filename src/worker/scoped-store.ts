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
import { z } from "zod";
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
const WORK_ITEM_KINDS = { git: true, extension: true } as const;

export function isWorkItemKind(job: WorkerJob): boolean {
  return Object.hasOwn(WORK_ITEM_KINDS, job.kind);
}

/** The envelope payload fields a work-item-bearing job carries. */
const workItemPayloadSchema = z.object({ workItemId: z.string().min(1) });

/**
 * Derives a job's scope from its envelope: git/extension jobs own the work
 * item named in the payload; kb/ingest_poll/scheduled have no store work
 * item. The scope derivation is the child's fail-closed gate: whatever the
 * job asked for, the facade only ever exposes THIS scope.
 */
export function jobScopeFromEnvelope(job: WorkerJob): JobScope {
  const parsed = workItemPayloadSchema.safeParse(job.payload);
  const workItemId =
    isWorkItemKind(job) && parsed.success && parsed.data.workItemId !== undefined
      ? parsed.data.workItemId
      : null;
  return { jobId: job.id, workItemId };
}

/** A proxy trap key that names a Store member (symbols are engine machinery, forwarded verbatim). */
function isNamedProperty(prop: string | symbol): prop is string {
  // String(x) returns x itself exactly for string primitives (typeof-free test).
  return String(prop) === prop;
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
    get(target, prop) {
      if (!isNamedProperty(prop)) {
        // SAFETY: engine-internal symbol keys carry no Store contract; they
        // are forwarded untouched off the proxied store itself.
        return target[prop as keyof T];
      }
      const name = prop;

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

      // SAFETY: the trap forwards an arbitrary Store member by name; target is
      // the proxied store itself, so every named member exists on it.
      const value = target[name as keyof T];
      return value instanceof Function ? value.bind(target) : value;
    },
  };

  // SAFETY: the facade's own intercepts above preserve the Store contract; the
  // proxy forwards to the very store instance passed in, so T is exact.
  return new Proxy(base, handler) as T;
}

/** Whether a work-item read/transition is inside this job's scope. */
function isOwnItem(scope: JobScope, itemId: string): boolean {
  return scope.workItemId !== null && itemId === scope.workItemId;
}
