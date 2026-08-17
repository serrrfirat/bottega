/**
 * Delivery poller tests (issue #12): the server-side half of the executor's
 * onDelivery seam. A pending PR (work_item.delivery_pending audit row) must
 * be announced to the space exactly once, with the request recorded in the
 * audit trail so restarts never re-post.
 */
import { describe, expect, test, vi } from "bun:test";
import { DELIVERY_PENDING_EVENT, DELIVERY_REQUESTED_EVENT } from "../../store/audit-events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditRow, ListAuditOpts, Store } from "../../store/db";
import { createStore } from "../../store/db";
import { buildDeliveryBlocks } from "../adapters/delivery-router";
import { DELIVERY_APPROVE_ACTION_ID, DELIVERY_DENY_ACTION_ID, type SlackAdapter } from "../adapters/slack";
import { DEFAULT_POLL_INTERVAL_MS, pollPendingDeliveries, startDeliveryPoller } from "./delivery-poller";

// --- Fakes ------------------------------------------------------------------

class FakeStore implements Pick<Store, "listAudit" | "appendAudit"> {
  rows: AuditRow[] = [];
  private nextId = 1;

  async listAudit(opts: ListAuditOpts = {}): Promise<AuditRow[]> {
    let rows = this.rows;
    if (opts.event_type !== undefined) rows = rows.filter((r) => r.event_type === opts.event_type);
    if (opts.space !== undefined) rows = rows.filter((r) => r.space_id === opts.space);
    if (opts.since !== undefined) rows = rows.filter((r) => r.ts >= (opts.since ?? 0));
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);
    return [...rows];
  }

  async appendAudit(entry: { ts?: number; space_id?: string | null; actor: string; event_type: string; payload: string }): Promise<number> {
    this.rows.push({
      id: this.nextId++,
      ts: entry.ts ?? Date.now(),
      space_id: entry.space_id ?? null,
      actor: entry.actor,
      event_type: entry.event_type,
      payload: entry.payload,
    });
    return this.rows.length;
  }

  deliveryPending(spaceId: string, itemId: string, prUrl: string): void {
    this.rows.push({
      id: this.nextId++,
      ts: Date.now(),
      space_id: spaceId,
      actor: "executor",
      event_type: DELIVERY_PENDING_EVENT,
      payload: JSON.stringify({ id: itemId, pr_url: prUrl, summary: "implemented it" }),
    });
  }
}

class FakeAdapter implements Pick<SlackAdapter, "postMessage"> {
  posted: Array<{ spaceId: string; text: string; blocks?: unknown[] }> = [];
  failNext = false;

  async postMessage(spaceId: string, text: string, opts?: { blocks?: unknown[] }): Promise<string | undefined> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("postMessage failed (fake)");
    }
    this.posted.push({ spaceId, text, ...(opts?.blocks ? { blocks: opts.blocks } : undefined) });
    return undefined;
  }
}

const SPACE = "slack:C123";
const PR_URL = "https://github.com/acme/sandbox/pull/42";

// --- Tests ------------------------------------------------------------------

describe("pollPendingDeliveries (issue #12)", () => {
  test("announces a pending delivery to the space and records the request", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    store.deliveryPending(SPACE, "wi_1", PR_URL);

    const posted = await pollPendingDeliveries(store, adapter);

    expect(posted).toBe(1);
    // The announcement is an INTERACTIVE prompt (issue #149): approve/deny
    // buttons carrying the work item id — the key the delivery router
    // resolves on when a human clicks.
    expect(adapter.posted).toEqual([
      {
        spaceId: SPACE,
        text: `PR ready: ${PR_URL} — approve to finish`,
        blocks: buildDeliveryBlocks(PR_URL, "implemented it", "wi_1"),
      },
    ]);
    // SAFETY: the toEqual assertion above pinned the announcement to
    // buildDeliveryBlocks(...) — an interactive prompt with an actions block
    // carrying action_id/value elements.
    const blocks = adapter.posted[0].blocks as Array<{
      type: string;
      elements?: Array<{ action_id?: string; value?: string }>;
    }>;
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions?.elements?.map((e) => e.action_id).sort()).toEqual([
      DELIVERY_APPROVE_ACTION_ID,
      DELIVERY_DENY_ACTION_ID,
    ]);
    expect(actions?.elements?.every((e) => e.value === "wi_1")).toBe(true);
    const requested = store.rows.filter((r) => r.event_type === DELIVERY_REQUESTED_EVENT);
    expect(requested).toHaveLength(1);
    expect(requested[0].actor).toBe("server");
    expect(requested[0].space_id).toBe(SPACE);
    expect(JSON.parse(requested[0].payload)).toEqual({
      id: "wi_1",
      pr_url: PR_URL,
      summary: "implemented it",
    });
  });

  test("never announces the same item twice (dedupe via the audit trail)", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    store.deliveryPending(SPACE, "wi_1", PR_URL);

    await pollPendingDeliveries(store, adapter);
    const second = await pollPendingDeliveries(store, adapter);

    expect(second).toBe(0);
    expect(adapter.posted).toHaveLength(1);
    // A restart replays the same audit rows — still one announcement.
    const third = await pollPendingDeliveries(store, adapter);
    expect(third).toBe(0);
    expect(adapter.posted).toHaveLength(1);
  });

  test("announces distinct pending deliveries independently", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    store.deliveryPending(SPACE, "wi_1", PR_URL);
    store.deliveryPending("slack:C456", "wi_2", "https://github.com/acme/sandbox/pull/43");

    const posted = await pollPendingDeliveries(store, adapter);

    expect(posted).toBe(2);
    expect(adapter.posted.map((p) => p.spaceId).sort()).toEqual(["slack:C123", "slack:C456"]);
  });

  test("skips malformed markers without posting or recording", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    store.rows.push(
      {
        id: 1,
        ts: Date.now(),
        space_id: SPACE,
        actor: "executor",
        event_type: DELIVERY_PENDING_EVENT,
        payload: "not json",
      },
      {
        id: 2,
        ts: Date.now(),
        space_id: SPACE,
        actor: "executor",
        event_type: DELIVERY_PENDING_EVENT,
        payload: JSON.stringify({ id: "wi_3" }), // no pr_url
      },
      {
        id: 3,
        ts: Date.now(),
        space_id: null, // no space to announce to
        actor: "executor",
        event_type: DELIVERY_PENDING_EVENT,
        payload: JSON.stringify({ id: "wi_4", pr_url: PR_URL }),
      },
    );

    const posted = await pollPendingDeliveries(store, adapter);

    expect(posted).toBe(0);
    expect(adapter.posted).toHaveLength(0);
    expect(store.rows.filter((r) => r.event_type === DELIVERY_REQUESTED_EVENT)).toHaveLength(0);
  });

  test("a failed postMessage is not recorded and retries on the next pass", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    store.deliveryPending(SPACE, "wi_1", PR_URL);
    adapter.failNext = true;

    await expect(pollPendingDeliveries(store, adapter)).rejects.toThrow("postMessage failed");
    expect(store.rows.filter((r) => r.event_type === DELIVERY_REQUESTED_EVENT)).toHaveLength(0);

    const posted = await pollPendingDeliveries(store, adapter);
    expect(posted).toBe(1);
    expect(adapter.posted).toHaveLength(1);
  });
});

describe("startDeliveryPoller (issue #12)", () => {
  /** Flush the async tick chain (several awaits deep) without touching the clock. */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  test("runs an immediate first pass and stop() prevents later ticks", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeStore();
      const adapter = new FakeAdapter();
      store.deliveryPending(SPACE, "wi_1", PR_URL);

      const poller = startDeliveryPoller({ store, adapter, intervalMs: 10 });
      poller.start();
      // The immediate pass runs without waiting for the interval.
      await flushMicrotasks();
      expect(adapter.posted).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1); // the poll interval is registered

      poller.stop();
      expect(vi.getTimerCount()).toBe(0); // interval cleared, not just dormant
      // A delivery landing after stop must not be announced.
      store.deliveryPending(SPACE, "wi_2", "https://github.com/acme/sandbox/pull/99");
      vi.advanceTimersByTime(1000);
      await flushMicrotasks();
      expect(adapter.posted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps polling across failures and recovers on the next tick", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeStore();
      const adapter = new FakeAdapter();
      store.deliveryPending(SPACE, "wi_1", PR_URL);
      adapter.failNext = true;
      const logs: string[] = [];

      const poller = startDeliveryPoller({ store, adapter, intervalMs: 10, log: (l) => logs.push(l) });
      poller.start();
      await flushMicrotasks(); // first pass fails (fake postMessage)
      expect(adapter.posted).toHaveLength(0);
      expect(logs.some((l) => l.includes("poll failed"))).toBe(true);

      vi.advanceTimersByTime(10); // next interval tick retries
      await flushMicrotasks();
      poller.stop();

      expect(adapter.posted).toHaveLength(1); // recovered on the next tick
      expect(logs.some((l) => l.includes("announced"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a slow postMessage cannot overlap the next pass (issue #70)", async () => {
    vi.useFakeTimers();
    try {
      const store = new FakeStore();
      store.deliveryPending(SPACE, "wi_1", PR_URL);
      // Slack latency under load: postMessage hangs until released, so the
      // first pass is still inside the announce step when the interval
      // elapses. The old setInterval loop started a second pass then, which
      // re-read the audit trail BEFORE delivery.requested was recorded and
      // double-announced. Chained ticks must wait for the pass to finish.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const adapter = new FakeAdapter();
      const realPost = adapter.postMessage.bind(adapter);
      adapter.postMessage = async (spaceId, text) => {
        await gate;
        return realPost(spaceId, text);
      };

      const poller = startDeliveryPoller({ store, adapter, intervalMs: 10 });
      poller.start();
      await flushMicrotasks();
      expect(adapter.posted).toHaveLength(0); // first pass stuck in postMessage

      // The interval elapses while the first pass is still in flight: the
      // chained design has no timer scheduled until the pass completes.
      vi.advanceTimersByTime(10);
      await flushMicrotasks();
      expect(vi.getTimerCount()).toBe(0);
      expect(adapter.posted).toHaveLength(0);

      release(); // pass finishes: post + delivery.requested recorded
      await flushMicrotasks();
      expect(adapter.posted).toHaveLength(1);
      expect(store.rows.filter((r) => r.event_type === DELIVERY_REQUESTED_EVENT)).toHaveLength(1);

      // The chained tick after completion re-reads the trail and dedupes.
      vi.advanceTimersByTime(10);
      await flushMicrotasks();
      poller.stop();
      expect(adapter.posted).toHaveLength(1);
      expect(store.rows.filter((r) => r.event_type === DELIVERY_REQUESTED_EVENT)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("default interval is 5 seconds (documented contract)", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5000);
  });
});

describe("pollPendingDeliveries against the real store (issue #29)", () => {
  test("announces once on the real append-only audit trail and dedupes across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-poller-"));
    const dbPath = join(dir, "poller.db");
    try {
      const store = createStore(dbPath);
      // The executor writes the marker through the real store API.
      await store.appendAudit({
        space_id: SPACE,
        actor: "executor",
        event_type: DELIVERY_PENDING_EVENT,
        payload: JSON.stringify({ id: "wi_1", pr_url: PR_URL, summary: "implemented it" }),
      });

      const adapter = new FakeAdapter();
      const posted = await pollPendingDeliveries(store, adapter);

      expect(posted).toBe(1);
      expect(adapter.posted).toEqual([
        {
          spaceId: SPACE,
          text: `PR ready: ${PR_URL} — approve to finish`,
          blocks: buildDeliveryBlocks(PR_URL, "implemented it", "wi_1"),
        },
      ]);
      const requested = await store.listAudit({ event_type: DELIVERY_REQUESTED_EVENT });
      expect(requested).toHaveLength(1);
      expect(requested[0].actor).toBe("server");
      expect(requested[0].space_id).toBe(SPACE);
      expect(JSON.parse(requested[0].payload)).toEqual({
        id: "wi_1",
        pr_url: PR_URL,
        summary: "implemented it",
      });
      store.close();

      // Server restart: a fresh connection to the same file replays the same
      // append-only audit rows — the announcement must not repeat.
      const restarted = createStore(dbPath);
      const second = await pollPendingDeliveries(restarted, adapter);
      expect(second).toBe(0);
      expect(adapter.posted).toHaveLength(1);
      restarted.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
