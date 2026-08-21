import { afterEach, describe, expect, test } from "bun:test";
import type { MemoryProvider } from "../memory/types";
import { createAudit } from "../policy/audit";
import { KNOWN_ACTIONS, buildRegistry } from "../scheduler/actions";
import { tickScheduler, type SchedulerTickDeps } from "../scheduler/runner";
import { createSchedulerJobArgsSchema } from "../scheduler/scheduler-tools";
import {
  INGEST_POLL_DISPATCH_EVENT,
  SCHEDULER_FIRE_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from "../store/audit-events";
import { createStore, type Store } from "../store/db";
import { createIngestPollAction } from "./poll-action";

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function freshStore(): Store {
  const store = createStore(":memory:");
  stores.push(store);
  return store;
}

const unusedMemory: MemoryProvider = {
  capabilities: { consolidation: "unsupported", digestPruning: "unsupported" },
  pruneDigests: async () => {
    throw new Error("unused memory prune");
  },
  save: async () => {
    throw new Error("unused memory save");
  },
  search: async () => [],
};

const FIRE_TIME = Date.UTC(2026, 7, 17, 12, 0, 0);

async function tickOnce(deps: Omit<SchedulerTickDeps, "now">, at: number): Promise<void> {
  await tickScheduler({ ...deps, now: () => at });
}

describe("createIngestPollAction (issue #57)", () => {
  test("exports the typed ingest_poll scheduler surface", () => {
    const action = createIngestPollAction();
    expect(action.name).toBe("ingest_poll");
    expect(KNOWN_ACTIONS).toContain("ingest_poll");
    expect(
      createSchedulerJobArgsSchema.parse({
        action: "ingest_poll",
        cron: "*/5 * * * *",
        params: { space: "slack:C1" },
      }).action,
    ).toBe("ingest_poll");
  });

  test("on fire, enqueues one ingest_poll worker job per provider targeting the space", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_INGEST" });

    const registry = buildRegistry([createIngestPollAction()]);
    const job = await store.createSchedulerJob({
      action: "ingest_poll",
      cron: "* * * * *",
      params: { space: space.id },
      createdBy: "U1",
    });
    await store.updateSchedulerNextFire(job.id, FIRE_TIME);

    await tickOnce(
      {
        store,
        audit,
        registry,
        memoryProvider: unusedMemory,
        postMessage: async () => "ts_1",
        // SAFETY: no poller resolves a policy; the impossible return is never observed.
        loadPolicy: async () => undefined as never,
        log: () => {},
      },
      FIRE_TIME,
    );

    // The fetch/validate leg moved to the worker (issue #101): the action
    // only fans out one job per provider — no fetch, no work item, no post
    // happen in the scheduler loop.
    const first = await store.claimNextJob(60_000);
    expect(first?.kind).toBe("ingest_poll");
    expect(first?.payload).toEqual({ provider: "github" });
    expect(first?.spaceId).toBe(space.id);
    const second = await store.claimNextJob(60_000);
    expect(second?.kind).toBe("ingest_poll");
    expect(second?.payload).toEqual({ provider: "linear" });
    expect(second?.spaceId).toBe(space.id);
    expect(await store.claimNextJob(60_000)).toBeNull();

    expect(await audit.listAudit({ event_type: WORK_ITEM_CREATED_EVENT })).toEqual([]);
    expect(await audit.listAudit({ event_type: INGEST_POLL_DISPATCH_EVENT })).toEqual([]);
    // The durable job fired once and advanced.
    expect(await audit.listAudit({ event_type: SCHEDULER_FIRE_EVENT })).toHaveLength(1);
    expect((await store.getSchedulerJob(job.id))?.lastResult).toBe("ok");
  });

  test("a missing params.space skips the pass with a log line", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const logs: string[] = [];
    const action = createIngestPollAction();

    await action.run(
      {},
      {
        store,
        audit,
        memoryProvider: unusedMemory,
        postMessage: async () => "ts_1",
        // SAFETY: no poller resolves a policy; the impossible return is never observed.
        loadPolicy: async () => undefined as never,
        log: (line) => logs.push(line),
        now: () => FIRE_TIME,
      },
    );

    expect(logs.join("\n")).toContain("[ingest_poll] no target space (params.space) configured — skipping poll");
    expect(await audit.listAudit({ event_type: INGEST_POLL_DISPATCH_EVENT })).toEqual([]);
    expect(await store.claimNextJob(60_000)).toBeNull();
  });
});
