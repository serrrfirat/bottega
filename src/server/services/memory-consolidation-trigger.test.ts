/**
 * Server-side memory-consolidation trigger tests (issues #272, #155, and
 * #321): the server enqueues explicit consolidation, accepts declared
 * provider-managed consolidation, and rejects unsupported maintenance.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteMemoryProvider } from "../../memory/sqlite";
import { createStore, type Store } from "../../store/db";
import {
  createMemoryConsolidationTrigger,
  type MemoryConsolidationTriggerDeps,
} from "./memory-consolidation-trigger";

const stores: Store[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "bottega-mc-trigger-"));
  dirs.push(dir);
  const store = createStore(join(dir, "store.db"));
  stores.push(store);
  return store;
}

function sqliteBackend(store: Store) {
  return Object.assign(createSqliteMemoryProvider(store.getDb()), { backend: "sqlite" as const });
}

function jobCount(store: Store): number {
  const row = store.getDb().query("SELECT COUNT(*) AS c FROM worker_jobs").get() as { c: number };
  return row.c;
}

describe("memory consolidation trigger (issue #272)", () => {
  test("the sqlite-backed trigger enqueues a scheduled memory_consolidation job and never touches a model call", async () => {
    const store = freshStore();
    const deps: MemoryConsolidationTriggerDeps = {
      store,
      memoryProvider: sqliteBackend(store),
      log: () => {},
    };
    const trigger = createMemoryConsolidationTrigger(deps);

    const jobId = await trigger.fire();
    expect(jobId).toMatch(/^mc_/);
    const job = await store.getJob(jobId!);
    expect(job).toMatchObject({ id: jobId, kind: "scheduled" });
    expect(job!.payload).toEqual({ action: "memory_consolidation" });

    // The trigger's surface carries NO model-call seam: the only side
    // effect of a fire is the enqueue (the LLM leg runs in the worker).
    expect(jobCount(store)).toBe(1);
    trigger.stop();
  });

  test("does not enqueue when the provider declares on-save consolidation", async () => {
    const store = freshStore();
    const deps: MemoryConsolidationTriggerDeps = {
      store,
      memoryProvider: {
        capabilities: { consolidation: "on-save", digestPruning: "unsupported" },
      },
      log: () => {},
    };
    const trigger = createMemoryConsolidationTrigger(deps);

    expect(await trigger.fire()).toBeNull();
    expect(jobCount(store)).toBe(0);
    trigger.stop();
  });

  test("rejects a configured provider that cannot honor consolidation", async () => {
    const store = freshStore();
    const trigger = createMemoryConsolidationTrigger({
      store,
      memoryProvider: {
        capabilities: { consolidation: "unsupported", digestPruning: "unsupported" },
      },
    });

    await expect(trigger.fire()).rejects.toThrow(
      /does not support required consolidation/,
    );
    expect(() => trigger.start()).toThrow(
      /does not support required consolidation/,
    );
    expect(jobCount(store)).toBe(0);
  });

  test("fires are deduped while one is in flight", async () => {
    // The in-flight guard exists so two interval ticks can never enqueue a
    // second job while the first fire is still pending. Drive it
    // deterministically with a slow enqueue (a gate) instead of racing the
    // real clock.
    let enqueues = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeStore = {
      enqueueJob: async () => {
        enqueues += 1;
        await gate;
      },
    } as unknown as Store;
    const trigger = createMemoryConsolidationTrigger({
      store: fakeStore,
      memoryProvider: {
        capabilities: { consolidation: "explicit", digestPruning: "explicit" },
      },
      log: () => {},
    });

    const first = trigger.fire();
    await Promise.resolve(); // let the first fire enter its run
    expect(await trigger.fire()).toBeNull(); // in flight → skipped
    release();
    await first;
    expect(enqueues).toBe(1);
    trigger.stop();
  });
});
