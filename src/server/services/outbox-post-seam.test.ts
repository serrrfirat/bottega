/**
 * Outbox post seam tests (issue #187, epic #170 item 3): the server side
 * of the worker→server delivery leg. Hermetic — a real SQLite temp DB
 * through the real store + a fake Slack adapter. Covers the worker-written
 * row → post → mark → outbox.posted audit path, the bounded post-failure
 * retry (outbox.failed → requeue → terminal), the at-most-once dedupe
 * across passes/restarts (fresh cursor), the fail-closed paths, and the
 * unclaimed nudge (job.unclaimed + one Slack post per stale row).
 */
import { afterAll, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_UNCLAIMED_EVENT, OUTBOX_FAILED_EVENT, OUTBOX_POSTED_EVENT } from "../../store/audit-events";
import { createStore, type Store } from "../../store/db";
import { DEFAULT_UNCLAIMED_TTL_MS, postOutboxRow, type OutboxRow } from "../../store/outbox";
import type { SlackAdapter } from "../adapters/slack";
import {
  DEFAULT_OUTBOX_MAX_POST_ATTEMPTS,
  nudgeUnclaimedOutboxRowsToSlack,
  postPendingOutboxRows,
  renderOutboxBlocks,
  renderOutboxMessage,
  startOutboxPostSeam,
  type OutboxPostPass,
} from "./outbox-post-seam";

const dirs: string[] = [];
function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "bottega-post-seam-"));
  dirs.push(dir);
  return createStore(join(dir, "test.db"));
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 7, 18, 10, 0, 0);

/** Injectable clock (ms epoch) so TTL/retry tests never sleep. */
function clock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function outboxRow(store: Store, id: string): OutboxRow | null {
  // SAFETY: SELECT * returns the outbox column shape (OutboxRow); a missing
  // row yields undefined, mapped to null below.
  const row = store.getDb().query("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | null;
  return row ?? null;
}

class FakeAdapter implements Pick<SlackAdapter, "postMessage"> {
  posted: Array<{ spaceId: string; text: string; blocks?: unknown[] }> = [];
  /** Fail this many postMessage calls, then succeed. */
  failuresLeft = 0;
  failForever = false;

  async postMessage(spaceId: string, text: string, opts?: { blocks?: unknown[] }): Promise<string | undefined> {
    if (this.failForever || this.failuresLeft > 0) {
      if (!this.failForever) this.failuresLeft -= 1;
      throw new Error("postMessage failed (fake)");
    }
    this.posted.push({ spaceId, text, blocks: opts?.blocks });
    return undefined;
  }
}

const SPACE = "slack:C123";
const GIT_PAYLOAD = { state: "done", result: { summary: "implemented it", pr_url: "https://github.com/acme/sandbox/pull/42" } };

function writeGitRow(store: Store, id: string, t: { now: () => number }): void {
  postOutboxRow(store, { id, kind: "git", payload: GIT_PAYLOAD, space: SPACE }, { now: t.now });
}

/** One pass with an advancing clock, mirroring the loop's fresh-cursor consume. */
async function pass(
  store: Store,
  adapter: FakeAdapter,
  t: { now: () => number; advance: (ms: number) => void },
  opts: { maxPostAttempts?: number } = {},
): Promise<OutboxPostPass> {
  t.advance(1000);
  return postPendingOutboxRows(store, adapter, { now: t.now, ...opts });
}

// --- Rendering (display-only) ------------------------------------------------

describe("renderOutboxMessage", () => {
  test("git done renders summary + PR url", () => {
    const row: OutboxRow = {
      id: "job_1", kind: "git", payload: JSON.stringify(GIT_PAYLOAD), space: SPACE,
      status: "posted", attempts: 0, created_at: T0, posted_at: T0,
    };
    expect(renderOutboxMessage(row)).toBe("Done: implemented it — https://github.com/acme/sandbox/pull/42");
  });

  test("extension done renders summary + url", () => {
    const row: OutboxRow = {
      id: "job_2", kind: "extension", payload: JSON.stringify({ state: "done", result: { summary: "created ticket", url: "https://linear.example/issue/OPS-42" } }),
      space: SPACE, status: "posted", attempts: 0, created_at: T0, posted_at: T0,
    };
    expect(renderOutboxMessage(row)).toBe("Done: created ticket — https://linear.example/issue/OPS-42");
  });

  test("kb result renders source + count", () => {
    const row: OutboxRow = {
      id: "job_3", kind: "kb", payload: JSON.stringify({ state: "completed", result: { url: "https://docs.example.com/guide", source: "docs.example.com", count: 12, chunks: 12, saved: 12 } }),
      space: SPACE, status: "posted", attempts: 0, created_at: T0, posted_at: T0,
    };
    expect(renderOutboxMessage(row)).toBe("kb completed: https://docs.example.com/guide — source: docs.example.com — 12 item(s)");
  });

  test("a blocked row renders the state alone (result is null)", () => {
    const row: OutboxRow = {
      id: "job_4", kind: "git", payload: JSON.stringify({ state: "blocked", result: null }),
      space: SPACE, status: "posted", attempts: 0, created_at: T0, posted_at: T0,
    };
    expect(renderOutboxMessage(row)).toBe("Blocked");
  });

  test("a work_item notification row renders the one-line landing (issue #159)", () => {
    const row: OutboxRow = {
      id: "wi_x:blocked", kind: "work_item",
      payload: JSON.stringify({ state: "blocked", workItemId: "wi_x", description: "do the thing", evidence: "no repo" }),
      space: SPACE, status: "posted", attempts: 0, created_at: T0, posted_at: T0,
    };
    expect(renderOutboxMessage(row)).toBe("Blocked: do the thing — no repo");
    const review: OutboxRow = {
      id: "wi_y:review", kind: "work_item",
      payload: JSON.stringify({ state: "review", workItemId: "wi_y", description: "check the PR" }),
      space: SPACE, status: "posted", attempts: 0, created_at: T0, posted_at: T0,
    };
    expect(renderOutboxMessage(review)).toBe("Review: check the PR");
  });

  test("a work_item notification renders an issueCard with the state icon, title, and optional link (issue #279)", () => {
    const row: OutboxRow = {
      id: "wi_x:blocked", kind: "work_item",
      payload: JSON.stringify({ state: "review", workItemId: "wi_x", description: "check the PR", link: "https://github.com/acme/sandbox/work/wi_x" }),
      space: SPACE, status: "posted", attempts: 0, created_at: T0, posted_at: T0,
    };
    const blocks = renderOutboxBlocks(row);
    expect(blocks).toBeDefined();
    const card = blocks![0] as { text?: { text?: string } };
    const text = card.text!.text!;
    expect(text).toContain("🔍");
    expect(text).toContain("*check the PR*");
    expect(text).toContain("https://github.com/acme/sandbox/work/wi_x");
  });

  test("a work_item payload without card fields keeps the text fallback (no blocks)", () => {
    const row: OutboxRow = {
      id: "wi_bad", kind: "work_item",
      payload: "not json",
      space: SPACE, status: "posted", attempts: 0, created_at: T0, posted_at: T0,
    };
    // The text line still renders; the card renderer declines (undefined) —
    // the post seam falls back to the bare line, never a malformed block.
    expect(renderOutboxMessage(row)).toBe("work_item");
    expect(renderOutboxBlocks(row)).toBeUndefined();
  });

  test("non-work_item rows render no card blocks", () => {
    const row: OutboxRow = {
      id: "job_1", kind: "git", payload: JSON.stringify(GIT_PAYLOAD), space: SPACE,
      status: "posted", attempts: 0, created_at: T0, posted_at: T0,
    };
    expect(renderOutboxBlocks(row)).toBeUndefined();
  });
});

// --- One pass (postPendingOutboxRows) ---------------------------------------

describe("postPendingOutboxRows", () => {
  test("a worker-written row is posted to its space, marked posted, and audited outbox.posted", async () => {
    const store = freshStore();
    const adapter = new FakeAdapter();
    const t = clock();
    writeGitRow(store, "job_1", t);

    const result = await postPendingOutboxRows(store, adapter, { now: t.now });

    expect(result.posted).toBe(1);
    expect(result.nudged).toBe(0);
    expect(adapter.posted).toEqual([{ spaceId: SPACE, text: "Done: implemented it — https://github.com/acme/sandbox/pull/42", blocks: undefined }]);
    expect(outboxRow(store, "job_1")!.status).toBe("posted");
    expect(outboxRow(store, "job_1")!.posted_at).toBe(T0);
    const posted = await store.listAudit({ event_type: OUTBOX_POSTED_EVENT });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.actor).toBe("server");
    expect(posted[0]!.space_id).toBe(SPACE);
    expect(JSON.parse(posted[0]!.payload)).toEqual({ id: "job_1", kind: "git", space: SPACE });
  });

  test("a row is never posted twice across passes or a restart (row status is the dedupe)", async () => {
    const store = freshStore();
    const adapter = new FakeAdapter();
    const t = clock();
    writeGitRow(store, "job_1", t);

    const first = await postPendingOutboxRows(store, adapter, { now: t.now });
    expect(first.posted).toBe(1);
    // Same seam, next pass — a fresh cursor must not re-surface the posted row.
    const second = await postPendingOutboxRows(store, adapter, { now: t.now });
    expect(second.posted).toBe(0);
    // Restart: another fresh cursor (new process, no memory) — still one post.
    const restarted = await postPendingOutboxRows(store, adapter, { now: t.now });
    expect(restarted.posted).toBe(0);
    expect(adapter.posted).toHaveLength(1);
  });

  test("a blocked/review completion row is superseded by its transition notification (issue #159)", async () => {
    const store = freshStore();
    const adapter = new FakeAdapter();
    const t = clock();
    // The executor writes the notification row when the item LANDS in
    // blocked; the job-completion row (state blocked) follows later.
    postOutboxRow(
      store,
      { id: "wi_x:blocked", kind: "work_item", payload: { state: "blocked", workItemId: "wi_x", description: "do the thing", evidence: "no repo" }, space: SPACE },
      { now: t.now },
    );
    postOutboxRow(store, { id: "wi_x", kind: "git", payload: { state: "blocked", result: null }, space: SPACE }, { now: t.now });

    const result = await postPendingOutboxRows(store, adapter, { now: t.now });
    // Exactly ONE post: the notification card — the completion row's bare
    // "Blocked" would duplicate it and is never posted.
    expect(result.posted).toBe(1);
    expect(adapter.posted).toHaveLength(1);
    expect(adapter.posted[0]!.spaceId).toBe(SPACE);
    expect(adapter.posted[0]!.text).toBe("Blocked: do the thing — no repo");
    // The issueCard carries the state icon + bold description.
    const blocks = adapter.posted[0]!.blocks as Array<{ text?: { text?: string } }>;
    const cardText = blocks[0]!.text!.text!;
    expect(cardText).toContain("🚫");
    expect(cardText).toContain("*do the thing*");
    expect(outboxRow(store, "wi_x:blocked")!.status).toBe("posted");
    expect(outboxRow(store, "wi_x")!.status).toBe("posted");
    // Only the notification row's post is audited outbox.posted.
    const posted = await store.listAudit({ event_type: OUTBOX_POSTED_EVENT });
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!.payload)).toEqual({ id: "wi_x:blocked", kind: "work_item", space: SPACE });
  });

  test("a failing post audits outbox.failed and retries within bounds, then fails terminal", async () => {
    const store = freshStore();
    const adapter = new FakeAdapter();
    adapter.failForever = true;
    const t = clock();
    writeGitRow(store, "job_1", t);

    const failedAudits: Array<{ attempts: number; error: string }> = [];
    for (let i = 0; i < DEFAULT_OUTBOX_MAX_POST_ATTEMPTS; i++) {
      const result = await pass(store, adapter, t);
      expect(result.posted).toBe(0);
    }
    const audits = await store.listAudit({ event_type: OUTBOX_FAILED_EVENT });
    expect(audits).toHaveLength(DEFAULT_OUTBOX_MAX_POST_ATTEMPTS);
    for (const [i, audit] of audits.entries()) {
      // SAFETY: the outbox.failed audit payload is the seam's own JSON
      // serialization (attempts + error, asserted below).
      const payload = JSON.parse(audit.payload) as { attempts: number; error: string };
      failedAudits.push(payload);
      expect(payload.attempts).toBe(i + 1);
      expect(payload.error).toBe("postMessage failed (fake)");
      expect(audit.space_id).toBe(SPACE);
    }
    // The bound is the row's attempts vocabulary: after 5 failures the row
    // is terminal — never consumed or nudged again.
    expect(failedAudits.map((a) => a.attempts)).toEqual([1, 2, 3, 4, 5]);
    expect(outboxRow(store, "job_1")!.status).toBe("failed");
    expect(outboxRow(store, "job_1")!.attempts).toBe(DEFAULT_OUTBOX_MAX_POST_ATTEMPTS);
    expect(await store.listAudit({ event_type: OUTBOX_POSTED_EVENT })).toHaveLength(0);
    expect(adapter.posted).toHaveLength(0);
    const after = await pass(store, adapter, t);
    expect(after.posted).toBe(0);
    expect(adapter.posted).toHaveLength(0);
  });

  test("a transient failure requeues the row and the next pass delivers it", async () => {
    const store = freshStore();
    const adapter = new FakeAdapter();
    adapter.failuresLeft = 2;
    const t = clock();
    writeGitRow(store, "job_1", t);

    const first = await pass(store, adapter, t);
    expect(first.posted).toBe(0);
    expect(outboxRow(store, "job_1")!.status).toBe("pending");
    expect(outboxRow(store, "job_1")!.attempts).toBe(1);
    expect(await store.listAudit({ event_type: OUTBOX_FAILED_EVENT })).toHaveLength(1);

    const second = await pass(store, adapter, t);
    expect(second.posted).toBe(0);
    expect(outboxRow(store, "job_1")!.status).toBe("pending");
    expect(outboxRow(store, "job_1")!.attempts).toBe(2);

    const third = await pass(store, adapter, t);
    expect(third.posted).toBe(1);
    expect(adapter.posted).toHaveLength(1);
    expect(outboxRow(store, "job_1")!.status).toBe("posted");
    expect(await store.listAudit({ event_type: OUTBOX_POSTED_EVENT })).toHaveLength(1);
    expect(await store.listAudit({ event_type: OUTBOX_FAILED_EVENT })).toHaveLength(2);
  });

  test("a malformed payload or a row with no space fails closed — never posted, terminal", async () => {
    const store = freshStore();
    const adapter = new FakeAdapter();
    const t = clock();
    // A contract-violating row a buggy worker could write: not JSON.
    store.getDb().query(
      "INSERT INTO outbox (id, kind, payload, space, status, attempts, created_at, posted_at) " +
        "VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL)",
    ).run("job_bad", "kb", "not json", SPACE, t.now());
    postOutboxRow(store, { id: "job_nospace", kind: "git", payload: { state: "done", result: null }, space: null }, { now: t.now });

    const result = await postPendingOutboxRows(store, adapter, { now: t.now });

    expect(result.posted).toBe(0);
    expect(adapter.posted).toHaveLength(0);
    expect(outboxRow(store, "job_bad")!.status).toBe("failed");
    expect(outboxRow(store, "job_nospace")!.status).toBe("failed");
    const failed = await store.listAudit({ event_type: OUTBOX_FAILED_EVENT });
    expect(failed).toHaveLength(2);
    expect(JSON.parse(failed[0]!.payload)).toMatchObject({ id: "job_bad", error: "malformed outbox payload" });
    expect(JSON.parse(failed[1]!.payload)).toMatchObject({ id: "job_nospace", error: "no space on the outbox row" });
    // Terminal: a second pass touches nothing.
    const again = await postPendingOutboxRows(store, adapter, { now: t.now });
    expect(again.posted).toBe(0);
    expect(adapter.posted).toHaveLength(0);
  });
});

// --- Unclaimed nudge leg ----------------------------------------------------

describe("nudgeUnclaimedOutboxRowsToSlack", () => {
  test("a stale pending row is nudged once: job.unclaimed audit + one Slack post", async () => {
    const store = freshStore();
    const adapter = new FakeAdapter();
    const t = clock();
    writeGitRow(store, "job_1", t);
    t.advance(DEFAULT_UNCLAIMED_TTL_MS + 1);

    const nudged = await nudgeUnclaimedOutboxRowsToSlack(store, adapter, { now: t.now });

    expect(nudged).toBe(1);
    expect(adapter.posted).toHaveLength(1);
    expect(adapter.posted[0]!.spaceId).toBe(SPACE);
    expect(adapter.posted[0]!.text).toContain("job_1");
    const unclaimed = await store.listAudit({ event_type: JOB_UNCLAIMED_EVENT });
    expect(unclaimed).toHaveLength(1);
    expect(JSON.parse(unclaimed[0]!.payload)).toMatchObject({ id: "job_1", kind: "git" });
    expect(outboxRow(store, "job_1")!.status).toBe("failed");

    // Once per row: the row is terminal, a second sweep posts nothing.
    const again = await nudgeUnclaimedOutboxRowsToSlack(store, adapter, { now: t.now });
    expect(again).toBe(0);
    expect(adapter.posted).toHaveLength(1);
    expect(await store.listAudit({ event_type: JOB_UNCLAIMED_EVENT })).toHaveLength(1);
  });

  test("a pass delivers reachable rows and nudges only the stale rows it could not reach", async () => {
    const store = freshStore();
    const adapter = new FakeAdapter();
    const t = clock();
    // 55 rows: the consume batch (50) covers the first 50; the tail of 5 is
    // beyond the batch and ages past the TTL — the seam was down when they
    // landed, and on recovery the consume reaches only the first batch.
    // Zero-padded ids keep the (created_at, id) ordering numeric.
    for (let i = 0; i < 55; i++) writeGitRow(store, `job_${String(i).padStart(2, "0")}`, t);
    t.advance(DEFAULT_UNCLAIMED_TTL_MS + 1);

    const first = await postPendingOutboxRows(store, adapter, { now: t.now });

    expect(first.posted).toBe(50);
    expect(first.nudged).toBe(5);
    expect(adapter.posted).toHaveLength(55);
    expect(await store.listAudit({ event_type: OUTBOX_POSTED_EVENT })).toHaveLength(50);
    expect(await store.listAudit({ event_type: JOB_UNCLAIMED_EVENT })).toHaveLength(5);
    // The 5 nudged rows are terminal failed; the 50 delivered rows are posted.
    expect(outboxRow(store, "job_49")!.status).toBe("posted");
    expect(outboxRow(store, "job_50")!.status).toBe("failed");

    const again = await postPendingOutboxRows(store, adapter, { now: t.now });
    expect(again.posted).toBe(0);
    expect(again.nudged).toBe(0);
    expect(adapter.posted).toHaveLength(55);
  });
});

// --- The loop (startOutboxPostSeam) -----------------------------------------

describe("startOutboxPostSeam", () => {
  /** Flush the async tick chain (several awaits deep) without touching the clock. */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  test("runs an immediate first pass and stop() prevents later ticks", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      const adapter = new FakeAdapter();
      writeGitRow(store, "job_1", { now: () => Date.now() });

      const seam = startOutboxPostSeam({ store, adapter, intervalMs: 10 });
      seam.start();
      // The immediate pass runs without waiting for the interval.
      await flushMicrotasks();
      expect(adapter.posted).toHaveLength(1);

      seam.stop();
      expect(vi.getTimerCount()).toBe(0); // interval cleared, not just dormant
      // A row landing after stop must not be posted.
      writeGitRow(store, "job_2", { now: () => Date.now() });
      vi.advanceTimersByTime(1000);
      await flushMicrotasks();
      expect(adapter.posted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps polling across a failed pass and recovers on the next tick", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      const adapter = new FakeAdapter();
      adapter.failuresLeft = 1;
      const logs: string[] = [];
      writeGitRow(store, "job_1", { now: () => Date.now() });

      const seam = startOutboxPostSeam({ store, adapter, intervalMs: 10, log: (l) => logs.push(l) });
      seam.start();
      await flushMicrotasks(); // first pass fails (fake postMessage) → requeued
      expect(adapter.posted).toHaveLength(0);
      expect(logs.some((l) => l.includes("retry 1/5"))).toBe(true);

      vi.advanceTimersByTime(10); // next interval tick retries and succeeds
      await flushMicrotasks();
      seam.stop();

      expect(adapter.posted).toHaveLength(1);
      expect(logs.some((l) => l.includes("posted 1 result"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a slow postMessage cannot overlap the next pass", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      writeGitRow(store, "job_1", { now: () => Date.now() });
      // Slack latency under load: postMessage hangs until released, so the
      // first pass is still inside postMessage when the interval elapses.
      // The chained design schedules the next pass only after this one
      // finishes: the loop stays single-flight (issue #70 pattern) — an
      // overlapping pass would be harmless to dedupe (the consume marks
      // rows posted atomically) but wasteful and harder to reason about.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const adapter = new FakeAdapter();
      const realPost = adapter.postMessage.bind(adapter);
      adapter.postMessage = async (spaceId, text) => {
        await gate;
        return realPost(spaceId, text);
      };

      const seam = startOutboxPostSeam({ store, adapter, intervalMs: 10 });
      seam.start();
      await flushMicrotasks();
      expect(adapter.posted).toHaveLength(0); // first pass stuck in postMessage

      vi.advanceTimersByTime(10); // interval elapses while the pass is in flight
      await flushMicrotasks();
      expect(vi.getTimerCount()).toBe(0); // no timer scheduled mid-pass

      release(); // pass finishes: post + outbox.posted recorded
      await flushMicrotasks();
      expect(adapter.posted).toHaveLength(1);

      // The chained tick after completion re-reads from a fresh cursor and
      // dedupes (the row is posted; nothing to do).
      vi.advanceTimersByTime(10);
      await flushMicrotasks();
      seam.stop();
      expect(adapter.posted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
