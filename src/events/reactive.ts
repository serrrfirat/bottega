/**
 * The reactive core (issue #356): ONE event-reactive mechanism that every
 * "react to state" loop subscribes to, replacing N bespoke pollers.
 *
 * The trusted substrate is the append-only audit ledger. Each
 * {@link ReactiveBehavior} declares the audit event types it reacts to; a
 * single tailing loop (`SELECT ... WHERE id > watermark`) delivers new rows
 * to behaviors with:
 *
 * - At-least-once delivery: a row is consumed (idempotency key recorded +
 *   watermark advanced, ATOMICALLY) only AFTER its reaction succeeds. A
 *   crash between the reaction's effects and the consume replays the row on
 *   recovery — safe because behaviors dedupe their own external effects on
 *   audit rows they append (the #312 / delivery.requested pattern), while
 *   `reactive_deliveries` keeps the durable per-behavior key
 *   (`behaviorId` + `row.id`) proving what already ran. Watermarks,
 *   deliveries, and dead letters persist in SQLite, so recovery survives
 *   restarts.
 * - Fail-closed errors: a throwing reaction is retried with exponential
 *   backoff, then dead-lettered into `reactive_dead_letter` (audit-visible,
 *   never silently dropped); the loop continues with later rows.
 * - Backpressure: reactions run with bounded in-flight per behavior
 *   (default 1, strictly ordered); a row that fails or waits out its
 *   backoff blocks the watermark frontier so overflow re-queues instead of
 *   dropping.
 * - Read-only ledger: this subsystem only SELECTs from `audit` — no
 *   behavior can mutate it through the core. Behaviors may append their own
 *   audit markers as reaction effects, exactly like today's seams.
 *
 * Time-based reactions that have no ledger event (the outbox queue sweep,
 * the memory-consolidation cadence, proactive sweeps like the M4
 * stale-procedure alert) ride the same lifecycle via an optional `sweep`
 * on the behavior — one owner for scheduling, logging, and stop().
 */
import type { Database } from "bun:sqlite";
import { errorMessage } from "../tools/helpers";
import type { AuditRow, Store } from "../store/db";
import { makeSingleFlightLoop } from "./single-flight-loop";

/** What a behavior reports after reacting to one audit row. */
export interface ReactionResult {
  /**
   * true when the behavior acted on the row (its external effect ran);
   * false when the row is a recognized no-op. Both outcomes consume the
   * row exactly once — false only suppresses retries, never delivery.
   */
  handled: boolean;
}

export interface ReactiveBehavior {
  /** Stable registration id, e.g. 'delivery-approval-prompt'; scopes the watermark + idempotency keys. */
  id: string;
  /** Audit event_types the behavior reacts to. Empty = sweep-only (no tailing). */
  events: readonly string[];
  /** Optional scoping: rows outside the filter are consumed unseen. */
  spaceFilter?: (spaceId: string) => boolean;
  /**
   * Reacts to one audit row. Required for event-driven behaviors; throwing
   * retries with backoff, then dead-letters. Omit for sweep-only behaviors.
   */
  react?: (row: AuditRow) => Promise<ReactionResult>;
  /** Optional periodic pass for time-based reactions (runs immediately at start). */
  sweep?: () => Promise<void>;
  /** Ms between sweeps. Default: the core's polling interval (every pass). */
  sweepIntervalMs?: number;
}

/** Durable bookkeeping seam of the core (SQLite by default, in-memory for fakes). */
export interface ReactiveStorage {
  getWatermark(behaviorId: string): Promise<number>;
  advanceWatermark(behaviorId: string, rowId: number): Promise<void>;
  /** Atomically records BOTH the idempotency key and the watermark advance (#356 exactly-once seam). */
  consume(behaviorId: string, rowId: number): Promise<void>;
  /** True when the row's reaction already ran (durable evidence; gating is watermark-based). */
  isDelivered(behaviorId: string, rowId: number): Promise<boolean>;
  recordDeadLetter(entry: DeadLetterEntry): Promise<void>;
}

export interface DeadLetterEntry {
  behaviorId: string;
  rowId: number;
  error: string;
  attempts: number;
}

export interface ReactiveCoreOpts {
  /** Tailing cadence (and default sweep cadence), chained single-flight. Default 5000 ms. */
  intervalMs?: number;
  /** Max concurrent reactions per behavior. Default 1 (strictly ordered). */
  maxInFlight?: number;
  /** Failed-reaction attempts before dead-lettering. Default 5. */
  maxAttempts?: number;
  /** Base backoff before retry attempt n: backoffMs * 2^(n-1), capped. Default 500 ms. */
  backoffMs?: number;
  /** Backoff cap. Default 30000 ms. */
  maxBackoffMs?: number;
  /** Durable bookkeeping. Default: SQLite tables on store.getDb(), in-memory when absent. */
  storage?: ReactiveStorage;
  log?: (line: string) => void;
  /** Error hook — one throwing reaction or sweep never kills the loop. */
  onError?: (info: { behaviorId: string; rowId?: number; error: unknown; kind: "react" | "sweep" }) => void;
  /** End-of-pass summary (delivered = reactions that acted, failed = errored reactions). */
  onPass?: (summary: { delivered: number; failed: number }) => void;
}

export interface ReactiveCore {
  start(): void;
  stop(): void;
}

const REACTIVE_TABLES = `
  CREATE TABLE IF NOT EXISTS reactive_watermarks (
    behavior_id TEXT PRIMARY KEY,
    last_id     INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reactive_deliveries (
    behavior_id TEXT NOT NULL,
    row_id      INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (behavior_id, row_id)
  );
  CREATE TABLE IF NOT EXISTS reactive_dead_letter (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    behavior_id  TEXT NOT NULL,
    audit_row_id INTEGER NOT NULL,
    error        TEXT NOT NULL,
    attempts     INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  );
`;

/** SQLite-backed storage: the durable default used by every production boot. */
export function createSqliteReactiveStorage(db: Database): ReactiveStorage {
  db.exec(REACTIVE_TABLES);
  const consumeRow = db.transaction((behaviorId: string, rowId: number) => {
    db.query("INSERT OR IGNORE INTO reactive_deliveries (behavior_id, row_id, created_at) VALUES (?, ?, ?)").run(
      behaviorId,
      rowId,
      Date.now(),
    );
    db.query(
      `INSERT INTO reactive_watermarks (behavior_id, last_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(behavior_id) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at`,
    ).run(behaviorId, Math.max(rowId, currentWatermark(db, behaviorId)), Date.now());
  });
  return {
    async getWatermark(behaviorId: string): Promise<number> {
      return currentWatermark(db, behaviorId);
    },
    async advanceWatermark(behaviorId: string, rowId: number): Promise<void> {
      db.query(
        `INSERT INTO reactive_watermarks (behavior_id, last_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(behavior_id) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at`,
      ).run(behaviorId, rowId, Date.now());
    },
    async consume(behaviorId: string, rowId: number): Promise<void> {
      consumeRow(behaviorId, rowId);
    },
    async isDelivered(behaviorId: string, rowId: number): Promise<boolean> {
      return (
        db.query("SELECT 1 FROM reactive_deliveries WHERE behavior_id = ? AND row_id = ?").get(behaviorId, rowId) !==
        null
      );
    },
    async recordDeadLetter(entry: DeadLetterEntry): Promise<void> {
      db.query(
        "INSERT INTO reactive_dead_letter (behavior_id, audit_row_id, error, attempts, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(entry.behaviorId, entry.rowId, entry.error, entry.attempts, Date.now());
    },
  };
}

function currentWatermark(db: Database, behaviorId: string): number {
  // SAFETY: the watermark row is written only by this module's upserts, so its shape is {last_id}.
  const row = db.query("SELECT last_id FROM reactive_watermarks WHERE behavior_id = ?").get(behaviorId) as {
    last_id: number;
  } | null;
  return row?.last_id ?? 0;
}

/** In-memory fallback for stores without a raw DB handle (test fakes). */
export function createMemoryReactiveStorage(): ReactiveStorage {
  const watermarks = new Map<string, number>();
  const delivered = new Set<string>();
  return {
    async getWatermark(behaviorId: string): Promise<number> {
      return watermarks.get(behaviorId) ?? 0;
    },
    async advanceWatermark(behaviorId: string, rowId: number): Promise<void> {
      watermarks.set(behaviorId, Math.max(watermarks.get(behaviorId) ?? 0, rowId));
    },
    async consume(behaviorId: string, rowId: number): Promise<void> {
      delivered.add(`${behaviorId}:${rowId}`);
      watermarks.set(behaviorId, Math.max(watermarks.get(behaviorId) ?? 0, rowId));
    },
    async isDelivered(behaviorId: string, rowId: number): Promise<boolean> {
      return delivered.has(`${behaviorId}:${rowId}`);
    },
    async recordDeadLetter(): Promise<void> {},
  };
}

interface RetryGate {
  attempts: number;
  nextAttemptAt: number;
}

/** The store surface the core needs; getDb is optional so test fakes satisfy it. */
type ReactiveStore = Pick<Store, "listAudit"> & Partial<Pick<Store, "getDb">>;

/**
 * Starts ONE reactive core over the audit ledger: a single-flight tailing
 * pass (immediate first pass, then chained from each pass's end) that
 * delivers new ledger rows to every behavior and runs due sweeps. The
 * ledger is read-only to this subsystem; all bookkeeping goes through the
 * (durable by default) {@link ReactiveStorage}.
 */
export function startReactiveCore(
  store: ReactiveStore,
  behaviors: readonly ReactiveBehavior[],
  opts: ReactiveCoreOpts = {},
): ReactiveCore {
  const intervalMs = opts.intervalMs ?? 5000;
  const maxInFlight = Math.max(1, opts.maxInFlight ?? 1);
  const maxAttempts = opts.maxAttempts ?? 5;
  const backoffMs = opts.backoffMs ?? 500;
  const maxBackoffMs = opts.maxBackoffMs ?? 30000;
  const log = opts.log ?? (() => {});
  const storage =
    opts.storage ??
    (store.getDb !== undefined ? createSqliteReactiveStorage(store.getDb()) : createMemoryReactiveStorage());
  // Per-row retry bookkeeping: attempt count + earliest retry time. Rows
  // awaiting their backoff stay queued above the watermark (never dropped).
  const retryGates = new Map<string, RetryGate>();
  const lastSweepAt = new Map<string, number>();

  async function runSweep(behavior: ReactiveBehavior, now: number): Promise<void> {
    if (now - (lastSweepAt.get(behavior.id) ?? 0) < (behavior.sweepIntervalMs ?? intervalMs)) return;
    lastSweepAt.set(behavior.id, now);
    try {
      await behavior.sweep!();
    } catch (error) {
      opts.onError?.({ behaviorId: behavior.id, error, kind: "sweep" });
      log(`reactive core: sweep ${behavior.id} failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Consumes rows past the watermark in id order; stops at the first blocked
   * row. Delivered rows are consumed atomically (key + watermark); a failed
   * row pins the frontier so later rows re-queue, never drop.
   */
  async function tail(behavior: ReactiveBehavior, summary: { delivered: number; failed: number }): Promise<void> {
    if (behavior.events.length === 0) return;
    let watermark = await storage.getWatermark(behavior.id);
    let lastConsumed = watermark;
    // One indexed query; the client-side filter keeps fake stores (which
    // ignore unknown listAudit options) correct too.
    const matches =
      behavior.events.length === 1
        ? await store.listAudit({ event_type: behavior.events[0], after_id: watermark })
        : (
            await Promise.all(
              behavior.events.map((event) => store.listAudit({ event_type: event, after_id: watermark })),
            )
          ).flat();
    const pending = matches
      .filter((row) => row.id > lastConsumed && behavior.events.includes(row.event_type))
      .sort((a, b) => a.id - b.id);

    const consumeOne = async (row: AuditRow): Promise<boolean | null> => {
      // Space filter: foreign (or space-less) rows are consumed unseen.
      if (behavior.spaceFilter !== undefined && (row.space_id === null || !behavior.spaceFilter(row.space_id))) {
        await storage.consume(behavior.id, row.id);
        lastConsumed = row.id;
        return false;
      }
      const gate = retryGates.get(`${behavior.id}:${row.id}`);
      if (gate !== undefined && Date.now() < gate.nextAttemptAt) return null; // still backing off
      try {
        const result = (await behavior.react?.(row)) ?? { handled: false };
        await storage.consume(behavior.id, row.id);
        retryGates.delete(`${behavior.id}:${row.id}`);
        lastConsumed = row.id;
        if (result.handled) summary.delivered += 1;
        return result.handled;
      } catch (error) {
        const attempts = (retryGates.get(`${behavior.id}:${row.id}`)?.attempts ?? 0) + 1;
        opts.onError?.({ behaviorId: behavior.id, rowId: row.id, error, kind: "react" });
        if (attempts >= maxAttempts) {
          // Fail closed, never silently: the row lands in an audit-visible
          // dead-letter table, then the frontier moves past it.
          await storage.recordDeadLetter({
            behaviorId: behavior.id,
            rowId: row.id,
            error: errorMessage(error),
            attempts,
          });
          await storage.consume(behavior.id, row.id);
          retryGates.delete(`${behavior.id}:${row.id}`);
          lastConsumed = row.id;
          log(`reactive core: behavior ${behavior.id} dead-lettered row ${row.id} after ${attempts} attempts`);
          return false;
        }
        retryGates.set(`${behavior.id}:${row.id}`, {
          attempts,
          nextAttemptAt: Date.now() + Math.min(backoffMs * 2 ** (attempts - 1), maxBackoffMs),
        });
        summary.failed += 1;
        return null;
      }
    };

    for (let i = 0; i < pending.length; ) {
      if (maxInFlight === 1) {
        // Strictly ordered fast path: one row at a time, no batching hops.
        const row = pending[i]!;
        i += 1;
        const outcome = await consumeOne(row);
        if (outcome !== null) watermark = Math.max(watermark, lastConsumed);
        if (outcome === null) break; // failed/backing-off row pins the frontier
        continue;
      }
      const batch: AuditRow[] = [];
      while (batch.length < maxInFlight && i < pending.length) {
        batch.push(pending[i]!);
        i += 1;
      }
      const outcomes = await Promise.all(batch.map((row) => consumeOne(row)));
      watermark = Math.max(watermark, lastConsumed);
      // Backpressure: any failed or backing-off row pins the frontier here —
      // later rows re-queue (they stay above the watermark), never drop.
      if (outcomes.some((ok) => ok === null)) break;
    }
    if (watermark > lastConsumed) await storage.advanceWatermark(behavior.id, watermark);
  }

  const loop = makeSingleFlightLoop({
    tick: async () => {
      const now = Date.now();
      const summary = { delivered: 0, failed: 0 };
      for (const behavior of behaviors) {
        if (behavior.sweep !== undefined) await runSweep(behavior, now);
        await tail(behavior, summary);
      }
      if (summary.delivered > 0 || summary.failed > 0) opts.onPass?.(summary);
    },
    intervalMs,
  });

  return {
    start() {
      loop.start();
    },
    stop() {
      loop.stop();
    },
  };
}
