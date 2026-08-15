import { afterAll, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "./db";

const dir = mkdtempSync(join(tmpdir(), "bottega-store-"));
const dbPath = join(dir, "test.db");
const store = createStore(dbPath);

// Queue-sensitive tests (claim/transition/markStale) must not see items
// left behind by earlier tests: each gets a fresh DB file.
const stores: Store[] = [];
function freshStore(): Store {
  const s = createStore(join(dir, `store-${stores.length}.db`));
  stores.push(s);
  return s;
}

afterAll(() => {
  for (const s of stores) s.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("spaces", () => {
  test("getOrCreateSpace creates a space and is idempotent", async () => {
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C0123" });
    expect(space.id).toBe("slack:C0123");
    expect(space.platform).toBe("slack");
    expect(space.channel_id).toBe("C0123");
    expect(space.name).toBeNull();
    expect(space.policy_json).toBe("{}");
    expect(space.created_at).toBeGreaterThan(0);
    expect(space.updated_at).toBe(space.created_at);

    const again = await store.getOrCreateSpace({ platform: "slack", channel_id: "C0123", name: "late name" });
    expect(again).toEqual(space);
  });

  test("getSpace returns the row or null", async () => {
    expect(await store.getSpace("slack:missing")).toBeNull();
    const space = await store.getOrCreateSpace({ platform: "telegram", channel_id: "T1" });
    const got = await store.getSpace(space.id);
    expect(got).toEqual(space);
  });

  test("updatePolicy sets policy_json and bumps updated_at", async () => {
    vi.useFakeTimers();
    try {
      const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C2" });
      vi.advanceTimersByTime(1000);
      const updated = await store.updatePolicy(space.id, '{"pickup":{"auto":true}}');
      expect(updated.id).toBe(space.id);
      expect(updated.policy_json).toBe('{"pickup":{"auto":true}}');
      expect(updated.updated_at).toBe(space.updated_at + 1000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("work items", () => {
  test("createWorkItem round-trips with defaults", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C10" });
    const item = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "ship the schema" });
    expect(item.id).toMatch(/^wi_/);
    expect(item.space_id).toBe(space.id);
    expect(item.requester).toBe("U1");
    expect(item.state).toBe("open");
    expect(item.approvals).toBe("[]");
    expect(item.evidence).toBe("[]");
    expect(item.result).toBeNull();
    expect(item.created_at).toBeGreaterThan(0);

    const got = await s.getWorkItem(item.id);
    expect(got).toEqual(item);
  });

  test("createWorkItem rejects an unknown space (foreign key)", async () => {
    const s = freshStore();
    await expect(
      s.createWorkItem({ space_id: "slack:nope", requester: "U1", description: "x" }),
    ).rejects.toThrow();
  });

  test("claimNextWorkItem claims oldest open first, then null", async () => {
    const s = freshStore();
    vi.useFakeTimers();
    try {
      const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C11" });
      const first = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "first" });
      vi.advanceTimersByTime(10);
      const second = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "second" });

      const claimed = await s.claimNextWorkItem();
      expect(claimed?.id).toBe(first.id);
      expect(claimed?.state).toBe("claimed");

      const claimed2 = await s.claimNextWorkItem();
      expect(claimed2?.id).toBe(second.id);

      expect(await s.claimNextWorkItem()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("two concurrent claimNextWorkItem calls have exactly one winner", async () => {
    const racePath = join(dir, "race.db");
    const a = createStore(racePath);
    const b = createStore(racePath);
    try {
      const space = await a.getOrCreateSpace({ platform: "slack", channel_id: "C12" });
      await a.createWorkItem({ space_id: space.id, requester: "U1", description: "one slot" });

      const [ra, rb] = await Promise.all([a.claimNextWorkItem(), b.claimNextWorkItem()]);
      const winners = [ra, rb].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.state).toBe("claimed");
    } finally {
      a.close();
      b.close();
    }
  });

  test("transitionWorkItem rejects a wrong from-state", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C13" });
    const item = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "t" });
    await expect(s.transitionWorkItem(item.id, "claimed", "working")).rejects.toThrow();
    await expect(s.transitionWorkItem("wi_does-not-exist", "open", "working")).rejects.toThrow();
  });

  test("transitionWorkItem applies state, evidence, approval and result", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C14" });
    const item = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "t2" });

    const moved = await s.transitionWorkItem(item.id, "open", "working", {
      evidence: "picked up",
      result: JSON.stringify({ pr_url: "https://example.com/pr/1" }),
    });
    expect(moved.state).toBe("working");
    expect(moved.result).toBe(JSON.stringify({ pr_url: "https://example.com/pr/1" }));
    expect(JSON.parse(moved.evidence)).toEqual([{ kind: "note", url: "picked up", at: expect.any(Number) }]);

    const reviewed = await s.transitionWorkItem(item.id, "working", "review", {
      approval: { approver: "U9" },
      evidence: "needs review",
    });
    expect(reviewed.state).toBe("review");
    expect(JSON.parse(reviewed.approvals)).toEqual([{ approver: "U9", at: expect.any(Number) }]);
    expect(JSON.parse(reviewed.evidence)).toHaveLength(2);
  });

  test("markStaleWorkItems blocks only items older than the cutoff", async () => {
    const s = freshStore();
    vi.useFakeTimers();
    try {
      const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C15" });
      const old = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "old" });
      await s.claimNextWorkItem(); // -> claimed
      vi.advanceTimersByTime(100);
      const fresh = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "fresh" });

      // cutoff = now - 20 = old.updated_at + 80: blocks old, keeps fresh
      const changed = await s.markStaleWorkItems(20, "claimed");
      expect(changed).toBe(1);

      const stale = await s.getWorkItem(old.id);
      expect(stale?.state).toBe("blocked");
      expect(JSON.parse(stale!.evidence)).toEqual([
        { kind: "stale", url: expect.stringContaining("stale"), at: expect.any(Number) },
      ]);

      const untouched = await s.getWorkItem(fresh.id);
      expect(untouched?.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("audit", () => {
  test("appendAudit returns ids and listAudit filters", async () => {
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C20" });
    const since = Date.now();
    const id1 = await store.appendAudit({ space_id: space.id, actor: "U1", event_type: "message.in", payload: "{}" });
    const id2 = await store.appendAudit({ actor: "agent:work:wi_x", event_type: "tool_call", payload: "{}" });
    expect(id2).toBeGreaterThan(id1);

    const bySpace = await store.listAudit({ space: space.id });
    expect(bySpace.map((r) => r.id)).toEqual([id1]);

    const byType = await store.listAudit({ event_type: "tool_call" });
    expect(byType.map((r) => r.id)).toEqual([id2]);

    const after = await store.listAudit({ since });
    expect(after.length).toBeGreaterThanOrEqual(2);

    const limited = await store.listAudit({ limit: 1 });
    expect(limited).toHaveLength(1);

    const full = await store.listAudit({});
    expect(full.length).toBeGreaterThanOrEqual(2);
    expect(full[0]!.ts).toBeGreaterThan(0);
    expect(full[0]!.payload).toBeTypeOf("string");
  });

  test("audit is append-only: UPDATE and DELETE are rejected by triggers", async () => {
    const id = await store.appendAudit({ actor: "U1", event_type: "x", payload: "{}" });
    const raw = new Database(dbPath);
    try {
      expect(() => raw.query("UPDATE audit SET payload = 'tampered' WHERE id = ?").run(id)).toThrow(/append-only/);
      expect(() => raw.query("DELETE FROM audit WHERE id = ?").run(id)).toThrow(/append-only/);
    } finally {
      raw.close();
    }
    const rows = await store.listAudit({ event_type: "x" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toBe("{}");
  });
});

describe("migration", () => {
  test("schema.sql re-runs are no-ops across connections", () => {
    const migratePath = join(dir, "migrate.db");
    const s1 = createStore(migratePath);
    const s2 = createStore(migratePath); // re-runs the same schema on a second connection
    s1.close();
    s2.close();
    const s3 = createStore(migratePath); // still fine after close/reopen
    s3.close();
  });
});
