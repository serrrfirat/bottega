/**
 * Timeline projection tests (issue #358): hermetic — a real temp-dir store
 * plus hand-written JSONL transcripts. Fails on any pre-#358 tree: neither
 * the module nor the per-item transition payload ids exist there.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type Store } from "../store/db";
import { JOB_CLAIMED_EVENT } from "../store/audit-events";
import { buildTimeline, MAX_TIMELINE_ENTRIES, parseItemTranscript } from "./timeline";

const dirs: string[] = [];
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freshFixture() {
  const dir = mkdtempSync(join(tmpdir(), "bottega-timeline-"));
  dirs.push(dir);
  const store = createStore(join(dir, "test.db"));
  stores.push(store);
  return { store, transcriptDir: join(dir, "transcripts") };
}

/** Seeds create → claim → work → fail over a git item with a transcript. */
async function seedFailedLifecycle(store: Store, transcriptDir: string, opts?: { transcript?: boolean }) {
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C358" });
  const item = await store.createWorkItem({
    space_id: space.id,
    requester: "U1",
    description: "ship the thing",
    repo: "acme/repo",
    delivery: "git",
  });
  await store.claimWorkItemById(item.id);
  await store.appendAudit({
    space_id: space.id,
    actor: "worker:1",
    event_type: JOB_CLAIMED_EVENT,
    payload: JSON.stringify({ id: item.id, kind: "git" }),
  });
  await store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
  if (opts?.transcript !== false) {
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
    // Real wall-clock separation: the transcript is written while working,
    // and the blocked landing happens strictly later — the seeded timestamps
    // must never tie with the audit rows' epoch-ms.
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
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
  return item;
}

describe("work-item timeline projection (issue #358)", () => {
  test("projects a seeded create→claim→turn→fail lifecycle in order", async () => {
    const { store, transcriptDir } = freshFixture();
    const item = await seedFailedLifecycle(store, transcriptDir);

    const entries = await buildTimeline(store, transcriptDir, item.id);
    expect(entries).not.toBeNull();
    const kinds = entries!.map((e) => e.kind);
    // Created first, failure landing last, transcript spans between them.
    expect(kinds[0]).toBe("created");
    expect(kinds.at(-1)).toBe("failed");
    expect(kinds).toContain("claimed");
    expect(kinds).toContain("turn");
    expect(kinds).toContain("tool-call");
    expect(kinds).toContain("blocked");

    const created = entries![0]!;
    expect(created).toEqual({ at: expect.any(Number), kind: "created", by: "U1" });
    const claimed = entries!.find((e) => e.kind === "claimed");
    expect(claimed).toEqual({ at: expect.any(Number), kind: "claimed", runner: "worker:1" });

    // Transcript spans are physical [start,end] line pairs; the tool call
    // carries only a digest, never the args.
    const turn = entries!.find((e) => e.kind === "turn" && e.summary.includes("explore the repo"));
    expect(turn && "transcriptSpan" in turn ? turn.transcriptSpan : null).toEqual([1, 1]);
    const tool = entries!.find((e): e is Extract<typeof e, { kind: "tool-call" }> => e.kind === "tool-call");
    expect(tool?.tool).toBe("bash");
    expect(tool?.argsDigest).toMatch(/^[0-9a-f]{16}$/);
    const failed = entries!.at(-1)!;
    expect("cause" in failed ? failed.cause : "").toBe("sandbox crashed");
  });

  test("an item without a transcript projects audit-only entries", async () => {
    const { store, transcriptDir } = freshFixture();
    const item = await seedFailedLifecycle(store, transcriptDir, { transcript: false });
    const entries = await buildTimeline(store, transcriptDir, item.id);
    expect(entries!.every((e) => e.kind !== "turn" && e.kind !== "tool-call")).toBe(true);
    expect(entries!.map((e) => e.kind)).toContain("created");
  });

  test("unknown items project to null", async () => {
    const { store, transcriptDir } = freshFixture();
    expect(await buildTimeline(store, transcriptDir, "wi_nope")).toBeNull();
  });

  test("the projection is bounded at MAX_TIMELINE_ENTRIES", async () => {
    const { store, transcriptDir } = freshFixture();
    const dir = mkdtempSync(join(tmpdir(), "bottega-timeline-cap-"));
    dirs.push(dir);
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C359" });
    const item = await store.createWorkItem({ space_id: space.id, requester: "U1", description: "cap" });
    mkdirSync(transcriptDir, { recursive: true });
    const lines = [`{"type":"title"}`];
    for (let i = 0; i < MAX_TIMELINE_ENTRIES + 50; i += 1) {
      lines.push(`{"type":"message","message":{"content":"line ${i}"}}`);
    }
    writeFileSync(join(transcriptDir, `${item.id}.jsonl`), lines.join("\n") + "\n");
    const entries = await buildTimeline(store, transcriptDir, item.id);
    expect(entries!.length).toBe(MAX_TIMELINE_ENTRIES);
  });

  test("parseItemTranscript drops malformed lines and crash-truncated tails", () => {
    const parsed = parseItemTranscript(
      ['{"type":"title"}', "{ truncated", '{"type":"message","message":{"content":"kept"}}'].join("\n"),
      0,
    );
    expect(parsed.turns.map((t) => t.summary)).toEqual(["kept"]);
  });
});
