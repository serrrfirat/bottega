/**
 * Outbox seam tests (issue #187, epic #170 precondition 2) — hermetic, on a
 * real SQLite temp DB through the real store. Covers the worker-side writer
 * (dedupe by row id), the server-side watermarked consumer (marks posted,
 * cursor advances, audit untouched), the status transitions, and the
 * fail-loud unclaimed TTL path.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_UNCLAIMED_EVENT } from "./audit-events";
import { createStore, type Store } from "./db";
import { consumeOutboxWatermarked, nudgeUnclaimedOutboxRows, postOutboxRow, type OutboxRow } from "./outbox";

const dirs: string[] = [];
function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "bottega-outbox-"));
  dirs.push(dir);
  return createStore(join(dir, "test.db"));
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 7, 18, 10, 0, 0);

/** Injectable clock (ms epoch) so TTL tests never sleep. */
function clock(start = T0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// SAFETY: SELECT * returns the outbox column shape (OutboxRow); a missing
// row maps to null below.
function outboxRow(store: Store, id: string): OutboxRow | null {
  const row = store.getDb().query("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | null;
  return row ?? null;
}

describe("outbox writer (postOutboxRow)", () => {
  test("writes a pending row with the JSON payload, space, and 0 attempts", () => {
    const store = freshStore();
    const t = clock();
    postOutboxRow(store, { id: "job_1", kind: "git", payload: { pr_url: "https://github.com/acme/x/pull/1" }, space: "slack:C1" }, { now: t.now });
    const row = outboxRow(store, "job_1");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("job_1");
    expect(row!.kind).toBe("git");
    expect(JSON.parse(row!.payload)).toEqual({ pr_url: "https://github.com/acme/x/pull/1" });
    expect(row!.space).toBe("slack:C1");
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(0);
    expect(row!.created_at).toBe(T0);
    expect(row!.posted_at).toBeNull();
  });

  test("dedupes by row id: re-writing the same job id is a no-op", () => {
    const store = freshStore();
    const t = clock();
    postOutboxRow(store, { id: "job_1", kind: "extension", payload: { url: "https://x.dev/1" }, space: "slack:C1" }, { now: t.now });
    t.advance(1000);
    postOutboxRow(store, { id: "job_1", kind: "extension", payload: { url: "https://x.dev/2" }, space: "slack:C2" }, { now: t.now });
    const row = outboxRow(store, "job_1");
    expect(JSON.parse(row!.payload)).toEqual({ url: "https://x.dev/1" });
    expect(row!.space).toBe("slack:C1");
    expect(row!.created_at).toBe(T0);
  });

  test("unknown kind fails closed (no row written)", () => {
    const store = freshStore();
    expect(() => postOutboxRow(store, { id: "job_x", kind: "chat" as never, payload: {} })).toThrow(/unknown outbox kind/);
    expect(outboxRow(store, "job_x")).toBeNull();
  });

  test("a non-JSON-serializable payload fails closed", () => {
    const store = freshStore();
    expect(() => postOutboxRow(store, { id: "job_x", kind: "kb", payload: undefined })).toThrow(/JSON-serializable/);
    expect(outboxRow(store, "job_x")).toBeNull();
  });
});

describe("outbox watermarked consumer (consumeOutboxWatermarked)", () => {
  test("write → consume marks the rows posted and returns them", () => {
    const store = freshStore();
    const t = clock();
    postOutboxRow(store, { id: "job_1", kind: "git", payload: { pr_url: "https://github.com/acme/x/pull/1" }, space: "slack:C1" }, { now: t.now });
    const { rows, watermark } = consumeOutboxWatermarked(store, { now: t.now });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("job_1");
    expect(rows[0]!.payload).toBe(JSON.stringify({ pr_url: "https://github.com/acme/x/pull/1" }));
    expect(watermark).toEqual({ createdAt: T0, id: "job_1" });
    const row = outboxRow(store, "job_1");
    expect(row!.status).toBe("posted");
    expect(row!.posted_at).toBe(T0);
  });

  test("dedupes by row id across passes: a posted row is never re-consumed", () => {
    const store = freshStore();
    const t = clock();
    postOutboxRow(store, { id: "job_1", kind: "git", payload: {} }, { now: t.now });
    const first = consumeOutboxWatermarked(store, { now: t.now });
    expect(first.rows).toHaveLength(1);
    // Same watermark (or even a fresh cursor) must not surface the row again.
    const second = consumeOutboxWatermarked(store, { watermark: first.watermark, now: t.now });
    expect(second.rows).toHaveLength(0);
    expect(second.watermark).toEqual(first.watermark);
    const fromScratch = consumeOutboxWatermarked(store, { now: t.now });
    expect(fromScratch.rows).toHaveLength(0);
  });

  test("watermarked cursor advances: the next pass starts after the previous batch", () => {
    const store = freshStore();
    const t = clock();
    for (const id of ["job_1", "job_2", "job_3"]) {
      postOutboxRow(store, { id, kind: "scheduled", payload: { id }, space: "slack:C1" }, { now: t.now });
      t.advance(1);
    }
    const first = consumeOutboxWatermarked(store, { limit: 2, now: t.now });
    expect(first.rows.map((r) => r.id)).toEqual(["job_1", "job_2"]);
    const second = consumeOutboxWatermarked(store, { limit: 2, watermark: first.watermark, now: t.now });
    expect(second.rows.map((r) => r.id)).toEqual(["job_3"]);
    expect(second.rows[0]!.status).toBe("posted");
  });

  test("at-most-once from any cursor: posted rows are excluded by the status filter, not by cursor state", () => {
    const store = freshStore();
    const t = clock();
    for (const id of ["job_1", "job_2"]) postOutboxRow(store, { id, kind: "git", payload: {} }, { now: t.now });
    const first = consumeOutboxWatermarked(store, { now: t.now });
    expect(first.rows).toHaveLength(2);
    // A fresh cursor (e.g. after a server restart) must not re-surface the
    // already-posted rows: the row status, not cursor memory, is the dedupe.
    const second = consumeOutboxWatermarked(store, { watermark: null, now: t.now });
    expect(second.rows).toHaveLength(0);
    expect(outboxRow(store, "job_1")!.status).toBe("posted");
    expect(outboxRow(store, "job_2")!.status).toBe("posted");
  });

  test("never touches the audit table: no audit rows are read or written", async () => {
    const store = freshStore();
    const t = clock();
    postOutboxRow(store, { id: "job_1", kind: "git", payload: {} }, { now: t.now });
    consumeOutboxWatermarked(store, { now: t.now });
    // The audit trail is empty — the consumer's dedupe lives in the outbox
    // row status, not in audit rows scanned as a queue.
    expect(await store.listAudit()).toEqual([]);
  });
});

describe("outbox unclaimed TTL path (nudgeUnclaimedOutboxRows)", () => {
  test("a pending row past the TTL is marked failed and audited job.unclaimed", async () => {
    const store = freshStore();
    const t = clock();
    postOutboxRow(store, { id: "job_1", kind: "git", payload: { pr_url: "https://github.com/acme/x/pull/1" }, space: "slack:C1" }, { now: t.now });
    t.advance(5 * 60 * 1000 + 1);
    const nudged = await nudgeUnclaimedOutboxRows(store, { now: t.now });
    expect(nudged.map((r) => r.id)).toEqual(["job_1"]);
    expect(outboxRow(store, "job_1")!.status).toBe("failed");
    const unclaimed = await store.listAudit({ event_type: JOB_UNCLAIMED_EVENT });
    expect(unclaimed).toHaveLength(1);
    expect(JSON.parse(unclaimed[0]!.payload)).toEqual({ id: "job_1", kind: "git" });
    expect(unclaimed[0]!.space_id).toBe("slack:C1");
  });

  test("a fresh pending row is left alone", async () => {
    const store = freshStore();
    const t = clock();
    postOutboxRow(store, { id: "job_1", kind: "extension", payload: {} }, { now: t.now });
    const nudged = await nudgeUnclaimedOutboxRows(store, { now: t.now });
    expect(nudged).toEqual([]);
    expect(outboxRow(store, "job_1")!.status).toBe("pending");
    expect(await store.listAudit({ event_type: JOB_UNCLAIMED_EVENT })).toHaveLength(0);
  });

  test("a row nudged once is never re-audited (row status is the dedupe)", async () => {
    const store = freshStore();
    const t = clock();
    postOutboxRow(store, { id: "job_1", kind: "git", payload: {} }, { now: t.now });
    t.advance(5 * 60 * 1000 + 1);
    await nudgeUnclaimedOutboxRows(store, { now: t.now });
    await nudgeUnclaimedOutboxRows(store, { now: t.now });
    expect(await store.listAudit({ event_type: JOB_UNCLAIMED_EVENT })).toHaveLength(1);
  });

  test("a row the consumer posted between the read and the mark wins the race", async () => {
    const store = freshStore();
    const t = clock();
    postOutboxRow(store, { id: "job_1", kind: "git", payload: {} }, { now: t.now });
    t.advance(5 * 60 * 1000 + 1);
    // The consumer posts the stale row before the nudge marks it.
    consumeOutboxWatermarked(store, { now: t.now });
    const nudged = await nudgeUnclaimedOutboxRows(store, { now: t.now });
    expect(nudged).toEqual([]);
    expect(outboxRow(store, "job_1")!.status).toBe("posted");
    expect(await store.listAudit({ event_type: JOB_UNCLAIMED_EVENT })).toHaveLength(0);
  });

  test("status transitions: pending → posted on consume; pending → failed on the unclaimed TTL", async () => {
    const store = freshStore();
    const t = clock();
    postOutboxRow(store, { id: "job_1", kind: "git", payload: {} }, { now: t.now });
    t.advance(1);
    postOutboxRow(store, { id: "job_2", kind: "kb", payload: {} }, { now: t.now });
    // A partial pass consumes only the first row; job_2 stays pending and
    // later ages out into the unclaimed path.
    const consumed = consumeOutboxWatermarked(store, { limit: 1, now: t.now });
    expect(consumed.rows.map((r) => r.id)).toEqual(["job_1"]);
    t.advance(5 * 60 * 1000 + 1);
    await nudgeUnclaimedOutboxRows(store, { now: t.now });
    expect(outboxRow(store, "job_1")!.status).toBe("posted");
    expect(outboxRow(store, "job_2")!.status).toBe("failed");
    const unclaimed = await store.listAudit({ event_type: JOB_UNCLAIMED_EVENT });
    expect(unclaimed).toHaveLength(1);
    expect(JSON.parse(unclaimed[0]!.payload)).toEqual({ id: "job_2", kind: "kb" });
  });
});
