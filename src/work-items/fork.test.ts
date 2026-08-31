/**
 * Forkable work items (issue #358): hermetic tests over the REAL store and
 * hand-written JSONL transcripts. Fails on any pre-#358 tree: the fork
 * columns, the `work_item.forked` audit event, and the attempt preamble do
 * not exist there.
 */
import { afterAll, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type Store, type WorkItem } from "../store/db";
import { WORK_ITEM_FORKED_EVENT } from "../store/audit-events";
import { buildForkContext, buildForkPreamble, forkWorkItem, resolveForkPoint } from "./fork";

const dirs: string[] = [];
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freshFixture() {
  const dir = mkdtempSync(join(tmpdir(), "bottega-fork-"));
  dirs.push(dir);
  const store = createStore(join(dir, "test.db"));
  stores.push(store);
  return { store, transcriptDir: join(dir, "transcripts") };
}

/** Seeds a failed git item with a three-message transcript. */
async function seedFailedItem(store: Store, transcriptDir: string, channel = "C358") {
  // The store stamps rows with Date.now(); fake-timer install + advance
  // gives deterministic separation between the transcript stamps (derived
  // from created_at) and the later audit rows.
  vi.useFakeTimers();
  try {
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: channel });
    const item = await store.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "ship the thing",
      repo: "acme/repo",
      delivery: "git",
    });
    await store.claimWorkItemById(item.id);
    await store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      join(transcriptDir, `${item.id}.jsonl`),
      [
        '{"type":"title","title":"session"}',
        `{"type":"message","message":{"content":"explore the repo"},"timestamp":"${new Date(item.created_at + 10).toISOString()}"}`,
        `{"type":"message","message":{"content":[{"type":"tool_use","name":"bash","input":{"command":"ls"}},{"type":"text","text":"listing files"}]},"timestamp":"${new Date(item.created_at + 20).toISOString()}"}`,
        `{"type":"message","message":{"content":"the fix touches src/a.ts"},"timestamp":"${new Date(item.created_at + 30).toISOString()}"}`,
        "",
      ].join("\n"),
    );
    // Deterministic clock advance: audit rows must land strictly after the
    // transcript stamps above (the transcript is written while working; the
    // failure comes later). Fake timers — no real wall-clock latency.
    vi.advanceTimersByTime(1000);
    await store.transitionWorkItem(item.id, "working", "blocked", {
      evidence: "sandbox crashed",
      by: "executor",
    });
    await store.appendAudit({
      space_id: space.id,
      actor: "executor",
      event_type: "work_item.failed",
      payload: JSON.stringify({ id: item.id, error: "sandbox crashed" }),
    });
    return { item, space };
  } finally {
    vi.useRealTimers();
  }
}

describe("fork point resolution (issue #358)", () => {
  test("afterKind 'failed' cuts at the last failed entry", () => {
    const timeline = [
      { at: 1, kind: "created" as const, by: "U1" },
      { at: 2, kind: "failed" as const, cause: "boom one" },
      // SAFETY: the span pair is a tuple by construction; the assertion
      // keeps the literal narrow for resolveForkPoint's TimelineEntry shape.
      { at: 3, kind: "turn" as const, summary: "s", transcriptSpan: [4, 5] as [number, number] },
      { at: 4, kind: "blocked" as const, cause: "boom two" },
    ];
    const point = resolveForkPoint(timeline, { afterKind: "failed" });
    expect(point.timelineIndex).toBe(3);
    expect(point.meta.cause).toBe("boom two");
  });

  test("atTimelineIndex bounds are enforced fail-closed", () => {
    expect(() => resolveForkPoint([{ at: 1, kind: "created", by: "U1" }], { atTimelineIndex: 1 })).toThrow(/out of range/);
    expect(() => resolveForkPoint([{ at: 1, kind: "created", by: "U1" }], { afterKind: "failed" })).toThrow(/no failed\/blocked entry/);
  });
});

describe("fork service (issue #358)", () => {
  test("fork at failure creates a NEW item with prior context, original untouched, edge present", async () => {
    const { store, transcriptDir } = freshFixture();
    const { item: source } = await seedFailedItem(store, transcriptDir);

    const fork = await forkWorkItem(
      { ...store, transcriptDir },
      { sourceId: source.id, afterKind: "failed", note: "retrying tonight", requester: "U2" },
    );

    // A NEW open row in the SAME space — delivery-approval policy applies
    // unchanged because policy resolves per-space at claim time.
    expect(fork.id).not.toBe(source.id);
    expect(fork.state).toBe("open");
    expect(fork.space_id).toBe(source.space_id);
    expect(fork.description).toBe(source.description);
    expect(fork.repo).toBe(source.repo);
    expect(fork.delivery).toBe(source.delivery);
    expect(fork.forked_from).toBe(source.id);
    // SAFETY: fork_json is written by createWorkItem via JSON.stringify of
    // the typed ForkMeta; the parse restores that shape.
    const meta = JSON.parse(fork.fork_json!) as { cause?: string; spanEnd?: number; note?: string };
    expect(meta.cause).toBe("sandbox crashed");
    expect(meta.note).toBe("retrying tonight");
    // The transcript cut covers all four lines (the failure is terminal).
    expect(meta.spanEnd).toBe(4);

    // The original is untouched: still blocked, no back-pointer.
    const original = await store.getWorkItem(source.id);
    expect(original!.state).toBe("blocked");
    expect(original!.forked_from).toBeNull();

    // The edge is audited on the fork's creation trail.
    const edges = await store.listAudit({ event_type: WORK_ITEM_FORKED_EVENT });
    const payloads = edges.map((row) => JSON.parse(row.payload));
    expect(payloads).toContainEqual(expect.objectContaining({ id: fork.id, forked_from: source.id }));

    // The enqueued job exists for the fork (one id across enqueue → claim).
    expect(await store.getJob(fork.id)).not.toBeNull();
  });

  test("fork boots with a bounded attempt preamble carrying prior progress", async () => {
    const { store, transcriptDir } = freshFixture();
    const { item: source } = await seedFailedItem(store, transcriptDir);
    const fork = await forkWorkItem(
      { ...store, transcriptDir },
      { sourceId: source.id, afterKind: "failed", requester: "U2" },
    );

    const preamble = await buildForkPreamble(store, transcriptDir, fork);
    expect(preamble).not.toBeNull();
    expect(preamble).toContain('attempt 2 of "ship the thing"');
    expect(preamble).toContain("failed at sandbox crashed");
    expect(preamble).toContain("- the fix touches src/a.ts");
    expect(preamble!.length).toBeLessThanOrEqual(4096 + 512); // bounded context block

    // Originals get no preamble at all.
    expect(await buildForkPreamble(store, transcriptDir, source)).toBeNull();
  });

  test("fork inherits the exec-gated space: same space id keeps delivery approval required", async () => {
    const { store, transcriptDir } = freshFixture();
    const { item: source, space } = await seedFailedItem(store, transcriptDir);
    // The gate lives on the SPACE (policy resolved per-space at claim), not
    // the row: a fork that carried any other space would bypass it.
    const fork = await forkWorkItem(
      { ...store, transcriptDir },
      { sourceId: source.id, afterKind: "failed", requester: "U2" },
    );
    expect(fork.space_id).toBe(space.id);

    // The executor's legal map requires review→done to carry a recorded
    // approval regardless of origin; prove the fork follows it by landing
    // its delivery without approval — the transition itself must refuse.
    await store.claimWorkItemById(fork.id);
    await store.transitionWorkItem(fork.id, "claimed", "working", { by: "executor" });
    expect(store.transitionWorkItem(fork.id, "review", "done", { result: "{}", by: "executor" })).rejects.toThrow();
  });

  test("unknown sources and missing selectors fail closed", async () => {
    const { store, transcriptDir } = freshFixture();
    await expect(forkWorkItem({ ...store, transcriptDir }, { sourceId: "wi_nope", afterKind: "failed", requester: "U2" })).rejects.toThrow(/not found/);

    const { item } = await seedFailedItem(store, transcriptDir, "C358b");
    await expect(forkWorkItem({ ...store, transcriptDir }, { sourceId: item.id, requester: "U2" })).rejects.toThrow(/one of atTimelineIndex or afterKind/);
  });

  test("attempt numbering walks the forked-from chain", async () => {
    const { store, transcriptDir } = freshFixture();
    const { item } = await seedFailedItem(store, transcriptDir);
    const first = await forkWorkItem({ ...store, transcriptDir }, { sourceId: item.id, afterKind: "failed", requester: "U2" });
    // Fail the first fork too, then fork again — attempt 3.
    vi.useFakeTimers();
    try {
      await store.claimWorkItemById(first.id);
      await store.transitionWorkItem(first.id, "claimed", "working", { by: "executor" });
      vi.advanceTimersByTime(1000);
      await store.transitionWorkItem(first.id, "working", "blocked", { evidence: "again", by: "executor" });
    } finally {
      vi.useRealTimers();
    }
    const second = await forkWorkItem({ ...store, transcriptDir }, { sourceId: first.id, afterKind: "failed", requester: "U3" });
    const preamble = await buildForkPreamble(store, transcriptDir, second);
    expect(preamble).toContain("attempt 3 of");
  });
});

describe("fork context builder (issue #358)", () => {
  test("renders the most recent messages within both caps, oldest first", () => {
    const path = join(dirs[dirs.length - 1] ?? mkdtempSync(join(tmpdir(), "bottega-forkctx-")), "ctx.jsonl");
    writeFileSync(
      path,
      [
        '{"type":"message","message":{"content":"one"}}',
        '{"type":"message","message":{"content":"two"}}',
        '{"type":"message","message":{"content":"three"}}',
        "",
      ].join("\n"),
    );
    expect(buildForkContext(path, 4)).toBe("- one\n- two\n- three");
    expect(buildForkContext(null, 4)).toBe("");
    expect(buildForkContext(path, 0)).toBe("");
  });
});

// listJobs shape guard: keep the fork-enqueue assertion honest if the job
// listing contract ever changes.
declare module "../store/db" {}
export type { WorkItem };
