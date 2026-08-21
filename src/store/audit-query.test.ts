import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "./db";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshStore(): Store {
  const root = mkdtempSync(join(tmpdir(), "bottega-audit-query-"));
  roots.push(root);
  return createStore(join(root, "audit.db"));
}

describe("indexed cursor-backed audit reads (#161)", () => {
  test("filters by event, space, actor, tool and time while paging newest-first", async () => {
    const store = freshStore();
    const rows = [
      { ts: 100, space_id: "slack:C1", actor: "U1", event_type: "policy.decision", payload: { tool: "bash", decision: "deny" } },
      { ts: 200, space_id: "slack:C1", actor: "U1", event_type: "policy.decision", payload: { tool: "bash", decision: "ask-human" } },
      { ts: 300, space_id: "slack:C1", actor: "U1", event_type: "policy.decision", payload: { tool: "bash", decision: "allow" } },
      { ts: 400, space_id: "slack:C2", actor: "U1", event_type: "policy.decision", payload: { tool: "bash", decision: "deny" } },
      { ts: 500, space_id: "slack:C1", actor: "U2", event_type: "extension.call", payload: { tool: "github.search", extension: "github" } },
    ] as const;
    for (const row of rows) await store.appendAudit({ ...row, payload: JSON.stringify(row.payload) });

    const first = await store.queryAudit({
      event_type: "policy.decision",
      space_id: "slack:C1",
      actor: "U1",
      tool: "bash",
      since: 100,
      until: 350,
      limit: 2,
    });
    expect(first.rows.map((row) => row.ts)).toEqual([300, 200]);
    expect(first.nextCursor).toEqual({ ts: 200, id: first.rows[1]!.id });

    const second = await store.queryAudit({
      event_type: "policy.decision",
      space_id: "slack:C1",
      actor: "U1",
      tool: "bash",
      since: 100,
      until: 350,
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect(second.rows.map((row) => row.ts)).toEqual([100]);
    expect(second.nextCursor).toBeNull();

    const extension = await store.queryAudit({ extension: "github", limit: 5 });
    expect(extension.rows.map((row) => row.event_type)).toEqual(["extension.call"]);
    store.close();
  });

  test("caps every page and uses the event/time index instead of scanning audit", async () => {
    const store = freshStore();
    for (let i = 0; i < 150; i += 1) {
      await store.appendAudit({
        ts: i,
        space_id: "slack:C1",
        actor: "U1",
        event_type: "approval.resolved",
        payload: "{}",
      });
    }

    const page = await store.queryAudit({ event_type: "approval.resolved", limit: 500 });
    expect(page.rows).toHaveLength(100);
    expect(page.nextCursor).not.toBeNull();

    // SAFETY: EXPLAIN QUERY PLAN always returns rows with a string detail
    // column; this query selects no other result columns.
    const plan = store
      .getDb()
      .query("EXPLAIN QUERY PLAN SELECT id, ts, space_id, actor, event_type, payload FROM audit WHERE event_type = ? AND ts >= ? ORDER BY ts DESC, id DESC LIMIT ?")
      .all("approval.resolved", 0, 51) as Array<{ detail: string }>;
    expect(plan.some((step) => step.detail.includes("idx_audit_event_ts"))).toBe(true);
    expect(plan.every((step) => !step.detail.includes("SCAN audit"))).toBe(true);
    store.close();
  });
});
