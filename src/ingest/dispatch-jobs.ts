/**
 * The ingest polling worker-dispatch step (issue #101, epic #229 P1): the
 * scheduler action no longer fetches/validates in-process. Instead it
 * enqueues one `ingest_poll` job PER provider — fetch + validate move to
 * the worker (the job's isolated sandbox), dispatch + Slack post stay
 * in-process on the server post seam. Fetch and process never block the
 * scheduler loop.
 */
import { randomUUID } from "node:crypto";
import type { Store } from "../store/db";

/** The providers the poll action fans out to. Linear polls to a no-op (skeleton). */
export const INGEST_POLL_PROVIDERS = ["github", "linear"] as const;

/**
 * Enqueues one `ingest_poll` job per provider targeting `spaceId`. Each
 * job's payload is just `{provider}` — the envelope id is the single thread
 * (issue #170). Returns the enqueued envelope ids for observability.
 * Idempotent by envelope id (ON CONFLICT DO NOTHING), so a re-run never
 * duplicates a job row.
 */
export async function enqueueIngestPollJobs(
  store: Store,
  opts: { spaceId: string },
): Promise<string[]> {
  const ids: string[] = [];
  for (const provider of INGEST_POLL_PROVIDERS) {
    const id = `ingest_${provider}_${randomUUID()}`;
    await store.enqueueJob({
      id,
      kind: "ingest_poll",
      payload: { provider },
      spaceId: opts.spaceId,
    });
    ids.push(id);
  }
  return ids;
}
