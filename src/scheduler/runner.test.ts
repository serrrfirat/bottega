import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryProvider } from "../memory/types";
import { createAudit, type AuditModule } from "../policy/audit";
import {
  SCHEDULER_ERROR_EVENT,
  SCHEDULER_FIRE_EVENT,
  SCHEDULER_MISSED_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from "../store/audit-events";
import { createStore, type AuditRow, type Store } from "../store/db";
import { buildRegistry } from "./actions";
import { nextCronFire } from "./cron";
import { recurringWorkAction } from "./recurring-work";
import { startScheduler, tickScheduler, type SchedulerTickDeps } from "./runner";
import type { SchedulerAction, SchedulerActionRegistry } from "./types";
import { z } from "zod";

const dir = mkdtempSync(join(tmpdir(), "bottega-scheduler-runner-"));
const stores: Store[] = [];

afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const store = createStore(join(dir, `${stores.length}.db`));
  stores.push(store);
  return store;
}

const unusedMemory: MemoryProvider = {
  save: async () => {
    throw new Error("unused memory save");
  },
  search: async () => [],
};

const jsonObjectSchema = z.record(z.string(), z.json());

function deps(
  store: Store,
  audit: AuditModule,
  registry: SchedulerActionRegistry,
  now: number,
  overrides: Partial<Pick<SchedulerTickDeps, "firstTick" | "fireTimeoutMs">> = {},
): SchedulerTickDeps {
  return {
    store,
    audit,
    registry,
    memoryProvider: unusedMemory,
    postMessage: async () => undefined,
    // SAFETY: no scheduler action exercised by these tests resolves a policy, so
    // the impossible return value is never observed.
    loadPolicy: async () => undefined as never,
    log: () => {},
    now: () => now,
    ...overrides,
  };
}

function payloads(rows: AuditRow[]) {
  return rows.map((row) => jsonObjectSchema.parse(JSON.parse(row.payload)));
}

describe("scheduler runner (issue #86)", () => {
  test("fires a due job exactly once and advances from the fire time", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const fireTime = Date.UTC(2026, 7, 17, 12, 0);
    let calls = 0;
    const action: SchedulerAction = {
      name: "standup_digest",
      run: async (params, ctx) => {
        calls += 1;
        expect(params).toEqual({ style: "brief" });
        expect(ctx.now()).toBe(fireTime);
      },
    };
    const registry = buildRegistry([action]);
    const job = await store.createSchedulerJob({
      action: action.name,
      cron: "*/5 * * * *",
      params: { style: "brief" },
      createdBy: "U1",
    });
    await store.updateSchedulerNextFire(job.id, fireTime);

    await tickScheduler(deps(store, audit, registry, fireTime));
    await tickScheduler(deps(store, audit, registry, fireTime));

    expect(calls).toBe(1);
    const updated = await store.getSchedulerJob(job.id);
    expect(updated?.lastResult).toBe("ok");
    expect(updated?.lastFiredAt).toBe(fireTime);
    expect(updated?.nextFireAt).toBe(nextCronFire(job.cron, fireTime));
    const rows = await audit.listAudit({ event_type: SCHEDULER_FIRE_EVENT });
    expect(payloads(rows)).toEqual([
      { id: job.id, action: action.name, space_id: null, result: "ok" },
    ]);
  });

  test("audits handler errors and records an error result", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const fireTime = Date.UTC(2026, 7, 17, 12, 0);
    const registry = buildRegistry([
      { name: "reflection", run: async () => { throw new Error("reflection broke"); } },
    ]);
    const job = await store.createSchedulerJob({ action: "reflection", cron: "0 * * * *", createdBy: "U1" });
    await store.updateSchedulerNextFire(job.id, fireTime);

    await tickScheduler(deps(store, audit, registry, fireTime));

    expect((await store.getSchedulerJob(job.id))?.lastResult).toBe("error");
    expect(payloads(await audit.listAudit({ event_type: SCHEDULER_ERROR_EVENT }))).toEqual([
      { id: job.id, action: "reflection", error: "reflection broke" },
    ]);
    expect(payloads(await audit.listAudit({ event_type: SCHEDULER_FIRE_EVENT }))).toEqual([
      { id: job.id, action: "reflection", space_id: null, result: "error" },
    ]);
  });

  test("first tick audits and skips jobs missed while the process was down", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const now = Date.UTC(2026, 7, 17, 12, 7);
    const scheduledFor = Date.UTC(2026, 7, 17, 12, 0);
    let calls = 0;
    const registry = buildRegistry([
      { name: "org_pulse", run: async () => { calls += 1; } },
    ]);
    const job = await store.createSchedulerJob({ action: "org_pulse", cron: "*/5 * * * *", createdBy: "U1" });
    await store.updateSchedulerNextFire(job.id, scheduledFor);

    await tickScheduler(deps(store, audit, registry, now, { firstTick: true }));

    expect(calls).toBe(0);
    expect((await store.getSchedulerJob(job.id))?.nextFireAt).toBe(nextCronFire(job.cron, now));
    expect(payloads(await audit.listAudit({ event_type: SCHEDULER_MISSED_EVENT }))).toEqual([
      { id: job.id, action: "org_pulse", scheduled_for: scheduledFor },
    ]);
    expect(await audit.listAudit({ event_type: SCHEDULER_FIRE_EVENT })).toEqual([]);
  });

  test("disables and audits an unknown action row without firing it", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const now = Date.UTC(2026, 7, 17, 12, 0);
    store.getDb().query(
      `INSERT INTO scheduler_jobs
       (id, action, cron, params, space_id, created_by, created_at, next_fire_at, enabled)
       VALUES (?, ?, ?, '{}', NULL, ?, ?, ?, 1)`,
    ).run("sj_unknown", "removed_action", "* * * * *", "U1", now - 1000, now);

    await tickScheduler(deps(store, audit, new Map(), now));

    // SAFETY: this test INSERTs the scheduler_jobs row with an INTEGER enabled
    // column; bun:sqlite surfaces INTEGER columns as numbers.
    const raw = store.getDb().query("SELECT enabled FROM scheduler_jobs WHERE id = ?").get("sj_unknown") as { enabled: number };
    expect(raw.enabled).toBe(0);
    expect(payloads(await audit.listAudit({ event_type: SCHEDULER_ERROR_EVENT }))).toEqual([
      { id: "sj_unknown", action: "removed_action", error: "unknown scheduler action: removed_action" },
    ]);
    expect(await audit.listAudit({ event_type: SCHEDULER_FIRE_EVENT })).toEqual([]);
  });

  test("treats a bounded handler timeout as an audited error", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const now = Date.UTC(2026, 7, 17, 12, 0);
    const registry = buildRegistry([
      { name: "reflection", run: () => new Promise<void>(() => {}) },
    ]);
    const job = await store.createSchedulerJob({ action: "reflection", cron: "* * * * *", createdBy: "U1" });
    await store.updateSchedulerNextFire(job.id, now);

    await tickScheduler(deps(store, audit, registry, now, { fireTimeoutMs: 0 }));

    expect((await store.getSchedulerJob(job.id))?.lastResult).toBe("error");
    const errors = payloads(await audit.listAudit({ event_type: SCHEDULER_ERROR_EVENT }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toMatch(/timed out/i);
  });

  test("threads the job's bound space into recurring_work without params.space (issue #220)", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const fireTime = Date.UTC(2026, 7, 17, 12, 0);
    const registry = buildRegistry([recurringWorkAction]);
    // The work_items row references the space row (FK); recurring-work
    // relies on the scheduler's existing space binding, so create it here.
    await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    const job = await store.createSchedulerJob({
      action: "recurring_work",
      cron: "* * * * *",
      params: { description: "Prepare the weekly ops report" },
      spaceId: "slack:C1",
      createdBy: "U1",
    });
    await store.updateSchedulerNextFire(job.id, fireTime);

    await tickScheduler(deps(store, audit, registry, fireTime));

    const rows = await audit.listAudit({ event_type: WORK_ITEM_CREATED_EVENT });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.space_id).toBe("slack:C1");
    const created = JSON.parse(rows[0]!.payload) as { id: string; requester: string };
    expect(created.requester).toBe("scheduler");
    const item = await store.getWorkItem(created.id);
    expect(item).toMatchObject({
      space_id: "slack:C1",
      requester: "scheduler",
      description: "Prepare the weekly ops report",
      delivery: "extension",
    });
    expect((await store.getSchedulerJob(job.id))?.lastResult).toBe("ok");
    expect(await audit.listAudit({ event_type: SCHEDULER_ERROR_EVENT })).toEqual([]);
  });

  test("start and stop run the immediate pass without leaving a timer", async () => {
    let lists = 0;
    // SAFETY: startScheduler reads only listSchedulerJobs on the start/stop path
    // under test; the rest of Store is never reached, so the partial fake is safe
    // to treat as a Store (never is the single-hop escape).
    const store = {
      listSchedulerJobs: async () => {
        lists += 1;
        return [];
      },
    } as never;
    const audit = {
      appendAudit: async () => 1,
      listAudit: async () => [],
    } satisfies AuditModule;
    const scheduler = startScheduler({
      store,
      audit,
      registry: new Map(),
      memoryProvider: unusedMemory,
      postMessage: async () => undefined,
      // SAFETY: the fake store returns no jobs, so startScheduler never invokes
      // loadPolicy; the impossible return value is never observed.
      loadPolicy: async () => undefined as never,
      log: () => {},
      pollIntervalMs: 60_000,
    });

    scheduler.start();
    scheduler.start();
    scheduler.stop();
    await Promise.resolve();
    expect(lists).toBe(1);
  });
});
