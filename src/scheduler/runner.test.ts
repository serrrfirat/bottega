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
} from "../store/audit-events";
import { createStore, type AuditRow, type Store } from "../store/db";
import { buildRegistry } from "./actions";
import { nextCronFire } from "./cron";
import { startScheduler, tickScheduler, type SchedulerTickDeps } from "./runner";
import type { SchedulerAction, SchedulerActionRegistry } from "./types";

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
    loadPolicy: async () => undefined as never,
    log: () => {},
    now: () => now,
    ...overrides,
  };
}

function payloads(rows: AuditRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
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

  test("start and stop run the immediate pass without leaving a timer", async () => {
    let lists = 0;
    const store = {
      listSchedulerJobs: async () => {
        lists += 1;
        return [];
      },
    } as unknown as Store;
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
