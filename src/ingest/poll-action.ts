/**
 * The ingest polling scheduler action (issues #57/#101): runs on the
 * durable scheduler's cron (a job with action "ingest_poll", params.space =
 * the target Slack space). The action is now a pure DISPATCHER — it
 * enqueues one `ingest_poll` worker job per provider via
 * {@link enqueueIngestPollJobs} and returns. The fetch + validate leg runs
 * inside the worker's per-job sandbox (issue #101); dispatch + Slack post
 * stay in-process on the server post seam. The scheduler loop never blocks
 * on a provider fetch and never dies on a provider error.
 *
 * Fail-closed behavior: a missing params.space skips the whole pass with a
 * log line (the job cannot target a channel it does not know). Enqueue
 * errors propagate (a busted job bus is a real outage, not a silent no-op).
 */
import type { SchedulerAction } from "../scheduler/types";
import { enqueueIngestPollJobs } from "./dispatch-jobs";

const ACTION_NAME = "ingest_poll";

/** Builds the ingest polling dispatcher action. */
export function createIngestPollAction(): SchedulerAction {
  return {
    name: ACTION_NAME,
    async run(params, ctx) {
      const spaceId = params.space?.trim() ?? "";
      if (!spaceId) {
        ctx.log(`[${ACTION_NAME}] no target space (params.space) configured — skipping poll`);
        return;
      }

      const ids = await enqueueIngestPollJobs(ctx.store, { spaceId });
      ctx.log(`[${ACTION_NAME}] enqueued poll jobs for ${ids.length} provider(s)`);
    },
  };
}
