import { afterEach, describe, expect, test } from "bun:test";
import type { JsonValue } from "../memory/mem0";
import type { MemoryProvider } from "../memory/types";
import { createAudit } from "../policy/audit";
import { KNOWN_ACTIONS, buildRegistry } from "../scheduler/actions";
import { tickScheduler, type SchedulerTickDeps } from "../scheduler/runner";
import { createSchedulerJobArgsSchema } from "../scheduler/scheduler-tools";
import {
  INGEST_POLL_DISPATCH_EVENT,
  INGEST_POLL_REJECTED_EVENT,
  SCHEDULER_FIRE_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from "../store/audit-events";
import { createStore, type AuditRow, type Store } from "../store/db";
import { createLinearPoller } from "./linear/poller";
import { createIngestPollAction } from "./poll-action";
import type { IngestEvent, Poller } from "./types";

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
  save: async () => {
    throw new Error("unused memory save");
  },
  search: async () => [],
};

function payload(row: AuditRow): Record<string, JsonValue> {
  // SAFETY: audit payloads are written via JSON.stringify, so the parsed value is a JSON object.
  return JSON.parse(row.payload) as Record<string, JsonValue>;
}

function mentionEvent(): IngestEvent {
  return {
    provider: "github",
    eventType: "mention",
    occurredAt: "2026-08-17T12:00:30.000Z",
    payload: {
      kind: "mention",
      repo: "acme/bottega",
      number: 42,
      isPullRequest: false,
      title: "Fix the flaky checkout",
      url: "https://github.com/acme/bottega/issues/42",
      body: "Can you look at this?",
      author: "someone",
      updatedAt: "2026-08-17T12:00:30.000Z",
    },
  };
}

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

  test("a polled mention dispatches through the scheduler loop (work item + post + audit)", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_INGEST" });
    const posts: string[] = [];
    const poller: Poller = { poll: async () => [mentionEvent()] };

    const registry = buildRegistry([createIngestPollAction({ pollers: { github: () => poller } })]);
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
        postMessage: async (_spaceId, text) => {
          posts.push(text);
          return "ts_1";
        },
        // SAFETY: no poller resolves a policy; the impossible return is never observed.
        loadPolicy: async () => undefined as never,
        log: () => {},
      },
      FIRE_TIME,
    );

    const created = await audit.listAudit({ event_type: WORK_ITEM_CREATED_EVENT });
    expect(created).toHaveLength(1);
    expect(posts).toEqual([
      "GitHub mention: Fix the flaky checkout (acme/bottega#42) — https://github.com/acme/bottega/issues/42",
    ]);
    const dispatched = await audit.listAudit({ event_type: INGEST_POLL_DISPATCH_EVENT });
    expect(dispatched).toHaveLength(1);
    expect(payload(dispatched[0]!)).toMatchObject({
      provider: "github",
      event_type: "mention",
      url: "https://github.com/acme/bottega/issues/42",
    });
    // The durable job fired once and advanced.
    expect(await audit.listAudit({ event_type: SCHEDULER_FIRE_EVENT })).toHaveLength(1);
    expect((await store.getSchedulerJob(job.id))?.lastResult).toBe("ok");
  });

  test("a poll error logs loudly and the scheduler loop survives", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_INGEST" });
    const logs: string[] = [];
    const poller: Poller = {
      poll: async () => {
        throw new Error("search exploded");
      },
    };

    const registry = buildRegistry([createIngestPollAction({ pollers: { github: () => poller } })]);
    const job = await store.createSchedulerJob({
      action: "ingest_poll",
      cron: "* * * * *",
      params: { space: space.id },
      createdBy: "U1",
    });
    await store.updateSchedulerNextFire(job.id, FIRE_TIME);
    const deps = {
      store,
      audit,
      registry,
      memoryProvider: unusedMemory,
      postMessage: async () => "ts_1",
      // SAFETY: no poller resolves a policy; the impossible return is never observed.
      loadPolicy: async () => undefined as never,
      log: (line: string) => logs.push(line),
    };

    await tickOnce(deps, FIRE_TIME);
    expect(logs.join("\n")).toContain("[ingest_poll] github poll failed: search exploded");
    expect(await audit.listAudit({ event_type: WORK_ITEM_CREATED_EVENT })).toEqual([]);
    expect(await audit.listAudit({ event_type: INGEST_POLL_DISPATCH_EVENT })).toEqual([]);
    expect(await audit.listAudit({ event_type: INGEST_POLL_REJECTED_EVENT })).toEqual([]);
    // The job stays enabled and the next occurrence still fires (loop survived).
    expect((await store.getSchedulerJob(job.id))?.enabled).toBe(true);
    expect((await store.getSchedulerJob(job.id))?.lastResult).toBe("ok");

    const nextFire = FIRE_TIME + 60_000;
    await tickOnce(deps, nextFire);
    expect(logs.join("\n").match(/github poll failed: search exploded/g)).toHaveLength(2);
  });

  test("unconfigured providers (Linear skeleton) poll to a no-op", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_INGEST" });
    const posts: string[] = [];

    const registry = buildRegistry([
      createIngestPollAction({
        pollers: {
          github: () => ({ poll: async () => [] }),
          linear: () => createLinearPoller(),
        },
      }),
    ]);
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
        postMessage: async (_spaceId, text) => {
          posts.push(text);
          return "ts_1";
        },
        // SAFETY: no poller resolves a policy; the impossible return is never observed.
        loadPolicy: async () => undefined as never,
        log: () => {},
      },
      FIRE_TIME,
    );

    expect(posts).toEqual([]);
    expect(await audit.listAudit({ event_type: WORK_ITEM_CREATED_EVENT })).toEqual([]);
    expect(await audit.listAudit({ event_type: INGEST_POLL_DISPATCH_EVENT })).toEqual([]);
    expect((await store.getSchedulerJob(job.id))?.lastResult).toBe("ok");
  });

  test("a missing params.space skips the pass with a log line", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const logs: string[] = [];
    const poller: Poller = {
      poll: async () => {
        throw new Error("must not be polled without a target space");
      },
    };
    const action = createIngestPollAction({ pollers: { github: () => poller } });

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
  });
});
