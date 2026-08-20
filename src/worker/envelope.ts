/**
 * The worker job envelope (epic #170): one typed shape for every
 * containerized job kind, and ONE id threaded across enqueue → claim →
 * run → outbox → post so "the ingest didn't happen" is a single
 * audit-trail query, not six log greps.
 *
 * This module is the shared contract file of the Wave-1 generalization:
 * the store's job bus (worker_jobs table) persists the envelope, the
 * executor's claim loop drives it, and the outbox seam consumes the same
 * id/kind/payload fields when it writes the worker→server completion
 * signal.
 */
import { z } from "zod";

/** The containerized job kinds the worker claim loop routes. */
export const WORKER_JOB_KINDS = ["git", "extension", "kb", "scheduled", "ingest_poll"] as const;
export type WorkerJobKind = (typeof WORKER_JOB_KINDS)[number];

/** Job-bus lifecycle states (the `worker_jobs.status` column). */
export const WORKER_JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type WorkerJobStatus = (typeof WORKER_JOB_STATUSES)[number];

/**
 * A claimable unit of containerized work. `payload` is kind-specific JSON:
 * git/extension carry {workItemId} (the job id equals the work item id for
 * debuggability); kb carries the ingest request (Wave 2); scheduled carries
 * a future dispatcher's action dispatch. `attempts` counts every claim
 * (including lease-expiry re-claims); `leaseUntil` is the running lease,
 * and doubles as the backoff not-before gate while queued.
 */
export interface WorkerJob {
  id: string;
  kind: WorkerJobKind;
  payload: unknown;
  spaceId?: string;
  /** How many times the job has been claimed (0 = never claimed). */
  attempts: number;
  /** Running-lease expiry; for queued jobs, the backoff not-before gate. */
  leaseUntil?: number | null;
  /** Lifecycle state (the worker_jobs.status column the store's transitions write). */
  status: WorkerJobStatus;
}

/** The git/extension envelope payload: the work item the job drives. */
export const workItemJobPayloadSchema = z.object({ workItemId: z.string() });

/**
 * The kb envelope payload (Wave 2): the ingest request. The URL names a
 * source DECLARED in config/kb.yml — the worker resolves the source from
 * the declared set and refuses any URL whose host is not declared (egress
 * scope). Parsed strictly enough to fail closed on a malformed dispatch.
 */
export const kbJobPayloadSchema = z.object({ url: z.string() }).passthrough();

/**
 * The scheduled envelope payload (issue #272, epic #229 P2): the
 * dispatcher's action dispatch. `action` names a handler in the executor's
 * scheduled-action registry (unknown names fail the job LOUDLY, never a
 * silent no-op); `params` are the action's own arguments, mirroring the
 * scheduler job row's params so the same handler shape runs in the worker.
 * Parsed strictly enough to fail closed on a malformed dispatch.
 */
export const scheduledJobPayloadSchema = z
  .object({
    action: z.string().min(1),
    params: z.record(z.string(), z.string()).optional().default({}),
  })
  .passthrough();

/**
 * The ingest_poll envelope payload (issue #101): the polling leg split —
 * the scheduler action dispatches one job per provider, and the worker does
 * the fetch + validate. Parsed strictly (only the provider key is
 * meaningful) so a malformed dispatch fails closed like every other kind.
 */
export const ingestPollJobPayloadSchema = z.object({ provider: z.string().min(1) }).passthrough();
