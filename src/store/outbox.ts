/**
 * Worker → server outbox (epic #170 precondition 2, issue #187).
 *
 * The consumable signaling channel that replaces scanning the append-only
 * audit table as a queue. The executor container (which never holds Slack
 * tokens — credential boundary, issue #9) writes one row per completed job
 * via {@link postOutboxRow}; the server post seam (Wave 2) consumes rows
 * via {@link consumeOutboxWatermarked} and posts the results, marking them
 * posted as it goes. Audit stays pure append-only evidence: the outbox is
 * the queue, and the ROW (not an audit row) is the dedupe key across
 * restarts. One id threads enqueue → claim → run → outbox → post.
 *
 * Row lifecycle: pending → posted (consumed) | failed (the unclaimed TTL
 * path, {@link nudgeUnclaimedOutboxRows}, or the post seam's terminal
 * post-failure path, {@link failOutboxRow} — a failed post is requeued via
 * {@link requeueOutboxRow} within the seam's bounded attempts first). The
 * consumer never reads or writes the audit table.
 */
import { JOB_UNCLAIMED_EVENT } from "./audit-events";
import type { Store } from "./db";

/**
 * The job kinds that can ride the outbox (epic #170) plus the
 * `work_item` transition-notification kind (issue #159): a short line the
 * executor writes when an item lands in blocked/review, posted by the
 * server seam like any other row.
 */
export type OutboxKind = "git" | "extension" | "kb" | "scheduled" | "work_item";

/** A row's lifecycle state; mirrors the outbox.status CHECK. */
export type OutboxStatus = "pending" | "posted" | "failed";

/** One outbox row. Field names mirror the table columns (repo convention). */
export interface OutboxRow {
  /** The job id — one id across enqueue → claim → run → outbox → post. */
  id: string;
  kind: OutboxKind;
  /** JSON string; decoded by the consumer. */
  payload: string;
  space: string | null;
  status: OutboxStatus;
  attempts: number;
  created_at: number;
  posted_at: number | null;
}

/** The worker-side write; the payload is JSON-serialized by the writer. */
export interface OutboxWrite {
  id: string;
  kind: OutboxKind;
  payload: unknown;
  space?: string | null;
}

/** Watermarked cursor over the (created_at, id) ordering of the outbox. */
export interface OutboxWatermark {
  createdAt: number;
  id: string;
}

/** The server post seam's default batch size per consume pass. */
export const DEFAULT_OUTBOX_BATCH_SIZE = 50;

/**
 * How long a completed job's outbox row may sit unconsumed before the
 * fail-loud nudge treats it as unclaimed (epic #170). The server poller
 * normally consumes within seconds, so a row older than this means no live
 * consumer picked it up.
 */
export const DEFAULT_UNCLAIMED_TTL_MS = 5 * 60 * 1000;

const OUTBOX_KINDS: readonly OutboxKind[] = ["git", "extension", "kb", "scheduled", "work_item"];

/**
 * Worker-side writer (epic #170): records one completed job for the server
 * post seam. Deduped BY ROW ID — INSERT OR IGNORE makes re-enqueueing an
 * already-written job id a no-op, so the worker's own retries can never
 * duplicate a row. The payload is JSON-serialized here (the column is
 * TEXT); secrets never belong in it (the worker has no Slack tokens).
 * Throws on an unknown kind or a non-JSON-serializable payload (fail
 * closed).
 */
export function postOutboxRow(
  store: Store,
  input: OutboxWrite,
  opts: { now?: () => number } = {},
): void {
  if (!OUTBOX_KINDS.includes(input.kind)) {
    throw new Error(`unknown outbox kind: ${input.kind}`);
  }
  const payload = JSON.stringify(input.payload);
  if (payload === undefined) {
    throw new Error("outbox payload must be JSON-serializable");
  }
  const now = opts.now?.() ?? Date.now();
  // SAFETY: the row's column shape matches OutboxRow; INSERT OR IGNORE makes
  // a duplicate id a silent no-op (the row is the dedupe key).
  store
    .getDb()
    .query(
      "INSERT OR IGNORE INTO outbox (id, kind, payload, space, status, attempts, created_at, posted_at) " +
        "VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL)",
    )
    .run(input.id, input.kind, payload, input.space ?? null, now);
}

/**
 * Server-side watermarked consumer (epic #170): atomically reads the next
 * batch of pending rows after the cursor and marks them posted in the SAME
 * transaction — a row is consumed exactly once (at-most-once per row id;
 * posted rows are never re-read). The returned watermark is the advanced
 * cursor (the last consumed row's (created_at, id)) for the next pass.
 *
 * The query is indexed on (status, created_at): each pass scans only the
 * still-pending tail of the outbox, never the audit table. The returned
 * rows are for the caller (the Wave-2 post seam) to act on; posting
 * failures are the seam's concern (outbox.posted / outbox.failed audit
 * evidence), not this consumer's.
 *
 * The consume uses BEGIN IMMEDIATE so the read-and-mark is atomic against
 * concurrent consumers (single-writer SQLite serializes them).
 */
export function consumeOutboxWatermarked(
  store: Store,
  opts: { limit?: number; watermark?: OutboxWatermark | null; now?: () => number } = {},
): { rows: OutboxRow[]; watermark: OutboxWatermark | null } {
  const limit = opts.limit ?? DEFAULT_OUTBOX_BATCH_SIZE;
  const now = opts.now?.() ?? Date.now();
  const watermark = opts.watermark ?? null;
  const db = store.getDb();

  db.exec("BEGIN IMMEDIATE");
  try {
    // SAFETY: SELECT * returns rows with the outbox column shape (OutboxRow).
    const rows = (watermark === null
      ? db
          .query("SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at, id LIMIT ?")
          .all(limit)
      : db
          .query(
            "SELECT * FROM outbox WHERE status = 'pending' AND " +
              "(created_at > ? OR (created_at = ? AND id > ?)) " +
              "ORDER BY created_at, id LIMIT ?",
          )
          .all(watermark.createdAt, watermark.createdAt, watermark.id, limit)) as OutboxRow[];
    for (const row of rows) {
      db.query("UPDATE outbox SET status = 'posted', posted_at = ? WHERE id = ?").run(now, row.id);
    }
    // The SELECT above snapshotted the rows before the mark; return them as
    // the consumer actually left them (posted), so the seam sees the truth.
    const consumed: OutboxRow[] = rows.map((row) => ({ ...row, status: "posted", posted_at: now }));
    const next: OutboxWatermark | null =
      rows.length > 0 ? { createdAt: rows[rows.length - 1]!.created_at, id: rows[rows.length - 1]!.id } : watermark;
    db.exec("COMMIT");
    return { rows: consumed, watermark: next };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Server post seam retry (Wave 2, issue #187): returns a row whose post
 * failed to the pending tail for another consume pass — the bounded retry
 * path. `attempts` counts every post attempt; `created_at` is bumped to now
 * so the row moves past the consumer's watermark (a requeued row is never
 * skipped by the cursor) and never reads as stale to the unclaimed nudge
 * while it is still being retried. Guarded on the posted status the consume
 * just wrote: a row the nudge failed is terminal and never requeued. The
 * audit trail (outbox.failed, written by the seam) is the evidence; this
 * mutation is queue state only.
 */
export function requeueOutboxRow(
  store: Store,
  id: string,
  opts: { now?: () => number } = {},
): void {
  const now = opts.now?.() ?? Date.now();
  store
    .getDb()
    .query(
      "UPDATE outbox SET status = 'pending', attempts = attempts + 1, created_at = ?, posted_at = NULL " +
        "WHERE id = ? AND status = 'posted'",
    )
    .run(now, id);
}

/**
 * Terminal mark for the server post seam (Wave 2, issue #187): a row whose
 * post failed beyond the bounded retries — or that failed closed (malformed
 * payload, no space) — is marked failed so it is never consumed or nudged
 * again. The outbox.status CHECK already allows it (the unclaimed path uses
 * the same status); the outbox.failed / job.unclaimed audit rows are the
 * evidence. `attempts` (the seam's final attempt count, matching the audit
 * row) records how many times the post was tried; omitted, the current
 * column value is kept.
 */
export function failOutboxRow(store: Store, id: string, opts: { attempts?: number } = {}): void {
  const attempts = opts.attempts;
  store
    .getDb()
    .query("UPDATE outbox SET status = 'failed', attempts = COALESCE(?, attempts) WHERE id = ? AND status <> 'failed'")
    .run(attempts ?? null, id);
}

/**
 * Fail-loud unclaimed path (epic #170): a pending outbox row that no
 * consumer picked up within the TTL is surfaced — audited as `job.unclaimed`
 * and returned so the caller can route the onboarding nudge. The row is
 * marked failed (terminal, never consumed) so the audit fires exactly once;
 * a row the consumer posted between the read and the guarded UPDATE is left
 * alone (the guard wins the race). Never scans the audit table: the outbox
 * row status is the dedupe.
 */
export async function nudgeUnclaimedOutboxRows(
  store: Store,
  opts: { olderThanMs?: number; now?: () => number; limit?: number } = {},
): Promise<OutboxRow[]> {
  const olderThanMs = opts.olderThanMs ?? DEFAULT_UNCLAIMED_TTL_MS;
  const now = opts.now?.() ?? Date.now();
  const limit = opts.limit ?? DEFAULT_OUTBOX_BATCH_SIZE;
  const cutoff = now - olderThanMs;
  const db = store.getDb();

  // SAFETY: SELECT * returns rows with the outbox column shape (OutboxRow).
  const stale = db
    .query("SELECT * FROM outbox WHERE status = 'pending' AND created_at <= ? ORDER BY created_at, id LIMIT ?")
    .all(cutoff, limit) as OutboxRow[];

  const nudged: OutboxRow[] = [];
  for (const row of stale) {
    // Guard on status: a consumer that posted the row between the read and
    // here wins — only a still-pending row is surfaced as unclaimed.
    const changed = db
      .query("UPDATE outbox SET status = 'failed' WHERE id = ? AND status = 'pending'")
      .run(row.id).changes;
    if (changed === 0) continue;
    await store.appendAudit({
      space_id: row.space,
      actor: "system",
      event_type: JOB_UNCLAIMED_EVENT,
      payload: JSON.stringify({ id: row.id, kind: row.kind }),
    });
    nudged.push({ ...row, status: "failed" });
  }
  return nudged;
}
