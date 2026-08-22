/** Boot-time idempotent seeder for the opt-in weekly governance digest (#161).
 *
 * The governance_digest action is per-space opt-in: it posts only to a space
 * whose `spaces.policy_json` enables `proactive.governance` (see
 * proactiveEnabled). So the seeder discovers exactly those spaces at boot and
 * guarantees each has a weekly `governance_digest` job. This is default-on
 * (flip the gate on and the job appears) yet operator-disable-able (toggle the
 * gate off, or pause/delete the job — the store keeps the row and the action
 * honors the gate either way). Seeding never duplicates: a job already targeting
 * a space is left untouched, so every reboot is a no-op once the jobs exist.
 */
import type { Store } from "../store/db";
import { proactiveEnabled } from "./proactive-config";

/** Weekly governance digest: Monday 09:00 UTC. Mirrors setup.md's example. */
export const GOVERNANCE_DIGEST_WEEKLY_CRON = "0 9 * * 1";

/**
 * Idempotently ensures a weekly governance_digest job exists for every space
 * that has opted into the proactive.governance gate. Fails by throwing on a
 * store error so boot surfaces it loudly; it is otherwise a no-op when no
 * space is opted in or the jobs already exist.
 */
export async function seedGovernanceDigestJobs(
  store: Store,
  now: () => number = Date.now,
): Promise<void> {
  const spans = await store.listSpaces();
  if (spans.length === 0) return;
  const jobs = await store.listSchedulerJobs();
  for (const space of spans) {
    if (!proactiveEnabled(space.policy_json, "governance")) continue;
    const alreadySeeded = jobs.some(
      (job) => job.action === "governance_digest" && job.spaceId === space.id,
    );
    if (alreadySeeded) continue;
    await store.createSchedulerJob({
      action: "governance_digest",
      cron: GOVERNANCE_DIGEST_WEEKLY_CRON,
      params: { space: space.id },
      spaceId: space.id,
      createdBy: "bottega:seed",
      createdAt: now(),
    });
  }
}