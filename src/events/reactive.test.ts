/**
 * Reactive core tests (issue #356): hermetic coverage of the safety
 * properties — exactly-once crash recovery over persisted watermarks,
 * independent behaviors on one event, backoff→dead-letter fail-closed
 * delivery, space filtering, bounded in-flight, and sweeps.
 *
 * Fail-on-old: every test here imports src/events/reactive.ts, which does
 * not exist before #356 lands.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type AuditRow, type Store } from "../store/db";
import {
  createMemoryReactiveStorage,
  startReactiveCore,
  type ReactiveBehavior,
  type ReactionResult,
} from "./reactive";

const stores: Store[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "bottega-reactive-"));
  dirs.push(dir);
  const store = createStore(join(dir, "store.db"));
  stores.push(store);
  return store;
}

/**
 * Flush the async tick chain (several awaits deep: storage round-trips,
 * Promise.all batches) without touching the clock — the delivery-poller
 * test suite's pattern, deep enough for the core's pass.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

/** One deterministic pass: advance fake time past one poll interval, flush. */
async function tick(core: { stop(): void } | null = null): Promise<void> {
  void core;
  vi.advanceTimersByTime(10);
  await flushMicrotasks();
}

function probeEvent(store: Store, spaceId: string | null, payload: string): Promise<number> {
  return store.appendAudit({ space_id: spaceId, actor: "test", event_type: "probe.event", payload });
}

/**
 * Dedupes an external effect the #312 way: the marker audit row IS the
 * record that this reaction already ran.
 */
async function markHandled(store: Store, row: AuditRow): Promise<ReactionResult> {
  const markers = await store.listAudit({ event_type: "probe.handled" });
  if (markers.some((marker) => JSON.parse(marker.payload).of === row.id)) return { handled: false };
  await store.appendAudit({
    space_id: row.space_id,
    actor: "test",
    event_type: "probe.handled",
    payload: JSON.stringify({ of: row.id }),
  });
  return { handled: true };
}

describe("startReactiveCore (issue #356)", () => {
  test("crash between react and watermark-advance recovers to exactly-once (#312 semantics)", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      let crashed = false;
      const behavior: ReactiveBehavior = {
        id: "crashy",
        events: ["probe.event"],
        react: async (row) => {
          const result = await markHandled(store, row);
          // First attempt models the crash: effects landed, the process
          // died before recordDelivery/advanceWatermark could run.
          if (!crashed && result.handled) {
            crashed = true;
            throw new Error("crash between react and watermark advance");
          }
          return result;
        },
      };
      const rowId = await probeEvent(store, "slack:C1", '{"n":1}');

      const core = startReactiveCore(store, [behavior], { intervalMs: 5, backoffMs: 0, maxAttempts: 3 });
      core.start();
      await flushMicrotasks(); // pass 1: react lands its effect, then "crashes"
      await tick(); // pass 2: replay finds the marker, consumes as no-op

      // The reaction's effect ran exactly once despite the replay...
      const markers = await store.listAudit({ event_type: "probe.handled" });
      expect(markers).toHaveLength(1);
      expect(JSON.parse(markers[0]!.payload)).toEqual({ of: rowId });
      // ...the row was consumed exactly once (one idempotency key)...
      expect(deliveredCount(store, rowId)).toBe(true);
      // ...and the watermark persisted past the row in SQLite.
      // SAFETY: the row is written only by the core's upsert, so its shape is {last_id}.
      const watermark = store.getDb().query("SELECT last_id FROM reactive_watermarks").get() as { last_id: number };
      expect(watermark.last_id).toBe(rowId);
      core.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("watermark persistence: a fresh core never redelivers consumed rows", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      const seen: AuditRow[] = [];
      const behavior: ReactiveBehavior = {
        id: "counting",
        events: ["probe.event"],
        // NO behavioral dedupe: any redelivery would double-count. Only the
        // persisted watermark + delivery key stand between this and duplicates.
        react: async (row) => {
          seen.push(row);
          return { handled: true };
        },
      };
      const rowId = await probeEvent(store, "slack:C1", "{}");

      const first = startReactiveCore(store, [behavior], { intervalMs: 5 });
      first.start();
      await flushMicrotasks();
      first.stop();
      expect(seen.map((row) => row.id)).toEqual([rowId]);

      // Restart: a brand-new core instance over the same SQLite ledger.
      const second = startReactiveCore(store, [{ ...behavior }], { intervalMs: 5 });
      second.start();
      await tick();
      await tick();
      second.stop();
      expect(seen).toHaveLength(1); // no redelivery on recovery
    } finally {
      vi.useRealTimers();
    }
  });

  test("in-memory storage loses the watermark across cores (documents the durable default)", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      // The store HAS getDb, but the caller pins in-memory storage explicitly.
      let calls = 0;
      const behavior: ReactiveBehavior = {
        id: "volatile",
        events: ["probe.event"],
        react: async () => {
          calls += 1;
          return { handled: true };
        },
      };
      await probeEvent(store, "slack:C1", "{}");
      const a = startReactiveCore(store, [behavior], { intervalMs: 5, storage: createMemoryReactiveStorage() });
      a.start();
      await flushMicrotasks();
      a.stop();
      expect(calls).toBe(1);
      const b = startReactiveCore(store, [behavior], { intervalMs: 5, storage: createMemoryReactiveStorage() });
      b.start();
      await tick();
      b.stop();
      expect(calls).toBe(2); // replayed: nothing was persisted — why production boots use SQLite storage
    } finally {
      vi.useRealTimers();
    }
  });

  test("two behaviors on the same event fire independently", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      const alphaSeen: AuditRow[] = [];
      const betaSeen: AuditRow[] = [];
      await probeEvent(store, "slack:C1", "{}");
      const core = startReactiveCore(
        store,
        [
          {
            id: "alpha",
            events: ["probe.event"],
            react: async (row) => {
              alphaSeen.push(row);
              return { handled: true };
            },
          },
          {
            id: "beta",
            events: ["probe.event"],
            react: async (row) => {
              betaSeen.push(row);
              return { handled: true };
            },
          },
        ],
        { intervalMs: 5 },
      );
      core.start();
      await flushMicrotasks();
      core.stop();
      expect(alphaSeen).toHaveLength(1);
      expect(betaSeen).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("throwing behavior backs off, dead-letters visibly, and the loop continues", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      const behavior: ReactiveBehavior = {
        id: "doomed",
        events: ["probe.event"],
        react: async (row) => {
          if (JSON.parse(row.payload).poisoned) throw new Error("no handler for poisoned payload");
          return { handled: true };
        },
      };
      await probeEvent(store, "slack:C1", '{"poisoned":true}');
      const healthyId = await probeEvent(store, "slack:C1", '{"poisoned":false}');

      const core = startReactiveCore(store, [behavior], { intervalMs: 5, backoffMs: 5, maxAttempts: 2 });
      core.start();
      await flushMicrotasks(); // pass 1: poisoned row fails (attempt 1), frontier pins
      await tick(); // pass 2: backoff elapsed → attempt 2 → dead letter; healthy row delivers
      core.stop();

      // SAFETY: SELECT projects exactly the four reactive_dead_letter columns.
      const letters = store
        .getDb()
        .query("SELECT behavior_id, audit_row_id, error, attempts FROM reactive_dead_letter")
        .all() as Array<{ behavior_id: string; audit_row_id: number; error: string; attempts: number }>;
      expect(letters).toHaveLength(1);
      expect(letters[0]).toMatchObject({
        behavior_id: "doomed",
        error: "no handler for poisoned payload",
        attempts: 2,
      });
      // The dead-lettered row is consumed: it can never be retried again...
      expect(deliveredCount(store, 1)).toBe(true);
      // ...and the loop continued to the healthy row behind it.
      expect(deliveredCount(store, healthyId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("space filter excludes foreign spaces but still consumes them", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      await probeEvent(store, "slack:FOREIGN", "{}");
      const mineId = await probeEvent(store, "slack:MINE", "{}");
      const seen: AuditRow[] = [];
      const behavior: ReactiveBehavior = {
        id: "scoped",
        events: ["probe.event"],
        spaceFilter: (spaceId) => spaceId === "slack:MINE",
        react: async (row) => {
          seen.push(row);
          return { handled: true };
        },
      };
      const core = startReactiveCore(store, [behavior], { intervalMs: 5 });
      core.start();
      await flushMicrotasks();
      core.stop();
      expect(seen.map((row) => row.id)).toEqual([mineId]);
      // Both rows consumed: the foreign one cannot pin the frontier forever.
      // SAFETY: the row is written only by the core's upsert, so its shape is {last_id}.
      const watermarkRow = store.getDb().query("SELECT last_id FROM reactive_watermarks").get() as { last_id: number };
      expect(watermarkRow.last_id).toBe(mineId);
    } finally {
      vi.useRealTimers();
    }
  });

  test("in-flight reactions stay within the configured bound", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      let inFlight = 0;
      let peak = 0;
      const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const behavior: ReactiveBehavior = {
        id: "slowpoke",
        events: ["probe.event"],
        react: async (row) => {
          // SAFETY: this test writes every probe payload as {"n":<number>}.
          const n = JSON.parse(row.payload).n as number;
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await gates[n - 1]!.promise;
          inFlight -= 1;
          return { handled: true };
        },
      };
      for (const n of [1, 2, 3]) await probeEvent(store, "slack:C1", `{"n":${n}}`);
      const core = startReactiveCore(store, [behavior], { intervalMs: 5, maxInFlight: 2 });
      core.start();
      await flushMicrotasks();
      // Rows 1 and 2 run concurrently (bound = 2); row 3 is still queued.
      expect(peak).toBe(2);
      expect(deliveredCount(store, 3)).toBe(false);
      gates[0]!.resolve();
      await flushMicrotasks();
      gates[1]!.resolve();
      await tick(); // next pass delivers row 3 alone
      gates[2]!.resolve();
      await flushMicrotasks();
      core.stop();
      expect(peak).toBeLessThanOrEqual(2);
      expect(deliveredCount(store, 3)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("sweep-only behaviors run immediately and then on their cadence", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      let sweeps = 0;
      const behavior: ReactiveBehavior = {
        id: "sweeper",
        events: [],
        sweepIntervalMs: 25,
        sweep: async () => {
          sweeps += 1;
        },
      };
      const core = startReactiveCore(store, [behavior], { intervalMs: 10 });
      core.start();
      await flushMicrotasks();
      expect(sweeps).toBe(1); // immediate boot sweep
      await tick(); // +10: 10 since the sweep — not yet due (< 25)
      expect(sweeps).toBe(1);
      await tick(); // +20: still not due (< 25)
      await tick(); // +30: 30 since the boot sweep → due again
      core.stop();
      expect(sweeps).toBeGreaterThanOrEqual(2);
      const sweepsAfterStop = sweeps;
      await tick();
      await tick();
      expect(sweeps).toBe(sweepsAfterStop); // stop() ends the chain
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- helpers over the raw tables --------------------------------------------

function deliveredCount(store: Store, rowId: number): boolean {
  // SAFETY: an existence probe; get() yields undefined when no row matches.
  return store.getDb().query("SELECT 1 FROM reactive_deliveries WHERE row_id = ?").get(rowId) !== null;
}
