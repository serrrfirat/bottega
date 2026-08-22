/** Caller-level tests for the boot-time governance_digest seeder (#161): the
 * seeder discovers opted-in spaces and idempotently guarantees a weekly job,
 * never duplicating on reboot, and leaves disabled spaces untouched. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../store/db";
import { GOVERNANCE_DIGEST_WEEKLY_CRON, seedGovernanceDigestJobs } from "./governance-digest-seed";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshStore(): Store {
  const root = mkdtempSync(join(tmpdir(), "bottega-governance-seed-"));
  roots.push(root);
  return createStore(join(root, "seed.db"));
}

async function space(store: Store, channel: string, policy: { proactive?: Record<string, boolean> }): Promise<string> {
  const created = await store.getOrCreateSpace({ platform: "slack", channel_id: channel });
  await store.updatePolicy(created.id, JSON.stringify(policy));
  return created.id;
}

describe("governance_digest boot seeder (#161)", () => {
  test("seeds one weekly job per space that opts into proactive.governance", async () => {
    const store = freshStore();
    const opted = await space(store, "CGOV", { proactive: { governance: true } });
    const other = await space(store, "COTHER", { proactive: { governance: false } });
    const none = await space(store, "CNONE", {});

    await seedGovernanceDigestJobs(store, () => Date.UTC(2026, 7, 21, 12));

    const jobs = await store.listSchedulerJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      action: "governance_digest",
      cron: GOVERNANCE_DIGEST_WEEKLY_CRON,
      spaceId: opted,
      params: { space: opted },
      enabled: true,
      createdBy: "bottega:seed",
    });
    // Disabled / absent-gate spaces are never targeted by the seeder.
    expect(jobs.some((job) => job.spaceId === other)).toBe(false);
    expect(jobs.some((job) => job.spaceId === none)).toBe(false);
  });

  test("is idempotent: a second boot never duplicates an existing job", async () => {
    const store = freshStore();
    const opted = await space(store, "CGOV", { proactive: { governance: true } });

    await seedGovernanceDigestJobs(store, () => Date.UTC(2026, 7, 21, 12));
    const afterFirst = await store.listSchedulerJobs();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.spaceId).toBe(opted);

    await seedGovernanceDigestJobs(store, () => Date.UTC(2026, 8, 21, 12));
    const afterSecond = await store.listSchedulerJobs();
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.id).toBe(afterFirst[0]!.id);
    expect(afterSecond[0]!.cron).toBe(GOVERNANCE_DIGEST_WEEKLY_CRON);
  });

  test("won't over-seed a space that already has any governance_digest job (operator-edited cron preserved)", async () => {
    const store = freshStore();
    const opted = await space(store, "CGOV", { proactive: { governance: true } });
    await store.createSchedulerJob({
      action: "governance_digest",
      cron: "0 6 * * 3",
      params: { space: opted },
      spaceId: opted,
      createdBy: "UADMIN",
    });

    await seedGovernanceDigestJobs(store, () => Date.UTC(2026, 7, 21, 12));

    const jobs = await store.listSchedulerJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ cron: "0 6 * * 3", createdBy: "UADMIN" });
  });

  test("is a no-op when no space is opted into governance", async () => {
    const store = freshStore();
    await space(store, "CGOV", { proactive: {} });
    await space(store, "COTHER", { proactive: { standup: true } });

    await seedGovernanceDigestJobs(store, () => Date.UTC(2026, 7, 21, 12));

    expect(await store.listSchedulerJobs()).toEqual([]);
  });
});