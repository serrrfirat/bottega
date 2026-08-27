import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type Store } from "../../store/db";
import {
  WORK_ITEM_FORKED_EVENT,
  WORK_REVIEW_CONTINUATION_REQUESTED_EVENT,
  WORK_REVIEW_CONTINUATION_RESOLVED_EVENT,
} from "../../store/audit-events";
import { continueWork, CONTINUATION_GUIDANCE_MAX_CHARS } from "./continuation";
import { forkWorkItem } from "../../work-items/fork";

const dirs: string[] = [];
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bottega-continuation-"));
  dirs.push(dir);
  const store = createStore(join(dir, "test.db"));
  stores.push(store);
  return { store, transcriptDir: join(dir, "transcripts") };
}

async function blockedSource(store: Store, transcriptDir: string) {
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C359" });
  const source = await store.createWorkItem({
    space_id: space.id,
    requester: "U1",
    description: "review vendor retention controls",
    repo: "acme/compliance",
    delivery: "git",
    model: "reasoning-model",
    reasoning_effort: "high",
    pr_url: "https://github.com/acme/compliance/pull/9",
    pr_branch: "review-9",
    base_branch: "main",
    skills: ["pr_review"],
  });
  await store.claimWorkItemById(source.id);
  await store.transitionWorkItem(source.id, "claimed", "working", { by: "executor" });
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(transcriptDir, `${source.id}.jsonl`),
    [
      `{"type":"message","message":{"content":"check vendor policy"},"timestamp":"${new Date(source.created_at + 10).toISOString()}"}`,
      `{"type":"message","message":{"content":"retention period is missing"},"timestamp":"${new Date(source.created_at + 20).toISOString()}"}`,
      "",
    ].join("\n"),
  );
  await store.transitionWorkItem(source.id, "working", "blocked", { evidence: "retention period missing", by: "executor" });
  await store.appendAudit({
    space_id: space.id,
    actor: "executor",
    event_type: "work_item.failed",
    payload: JSON.stringify({ id: source.id, error: "retention period missing" }),
  });
  return { source, space };
}

describe("continueWork (issue #359)", () => {
  test("creates one fork with trimmed guidance and inherited execution pins", async () => {
    const { store, transcriptDir } = fixture();
    const { source, space } = await blockedSource(store, transcriptDir);

    const result = await continueWork(
      { store, transcriptDir },
      { sourceId: source.id, requester: "U2", spaceId: space.id, guidance: "  confirm the retention period with legal  " },
    );

    expect(result.existed).toBe(false);
    const fork = await store.getWorkItem(result.forkId);
    expect(fork).not.toBeNull();
    expect(fork!).toMatchObject({
      forked_from: source.id,
      space_id: source.space_id,
      delivery: source.delivery,
      repo: source.repo,
      model: source.model,
      reasoning_effort: source.reasoning_effort,
      pr_url: source.pr_url,
      pr_branch: source.pr_branch,
      base_branch: source.base_branch,
    });
    expect(JSON.parse(fork!.fork_json!)).toMatchObject({ note: "confirm the retention period with legal" });
    expect((await store.getWorkItem(source.id))!.state).toBe("blocked");

    const requested = await store.listAudit({ event_type: WORK_REVIEW_CONTINUATION_REQUESTED_EVENT });
    expect(requested.map((row) => JSON.parse(row.payload))).toContainEqual({ source_id: source.id, by: "U2", guided: true });
    const resolved = await store.listAudit({ event_type: WORK_REVIEW_CONTINUATION_RESOLVED_EVENT });
    expect(resolved.map((row) => JSON.parse(row.payload))).toContainEqual(
      expect.objectContaining({ source_id: source.id, fork_id: result.forkId, existed: false }),
    );
    expect((await store.listAudit({ event_type: WORK_ITEM_FORKED_EVENT })).filter((row) => JSON.parse(row.payload).forked_from === source.id)).toHaveLength(1);
  });

  test("concurrent requests settle on the same fork", async () => {
    const { store, transcriptDir } = fixture();
    const { source, space } = await blockedSource(store, transcriptDir);
    const results = await Promise.all(
      ["U2", "U3", "U4", "U5"].map((requester) =>
        continueWork({ store, transcriptDir }, { sourceId: source.id, requester, spaceId: space.id }),
      ),
    );
    expect(new Set(results.map((result) => result.forkId)).size).toBe(1);
    expect(results.filter((result) => !result.existed)).toHaveLength(1);
    expect(results.filter((result) => result.existed)).toHaveLength(3);
    expect((await store.listAudit({ event_type: WORK_ITEM_FORKED_EVENT })).filter((row) => JSON.parse(row.payload).forked_from === source.id)).toHaveLength(1);
  });

  test("generic fork does not suppress continuation; repeat continuation resolves to the continuation fork", async () => {
    const { store, transcriptDir } = fixture();
    const { source, space } = await blockedSource(store, transcriptDir);

    // An unrelated #358 timeline fork of the same source, no continuation intent.
    const generic = await forkWorkItem(
      { ...store, transcriptDir },
      { sourceId: source.id, atTimelineIndex: 1, requester: "U0" },
    );
    expect(JSON.parse(generic.fork_json!)).not.toHaveProperty("intent");

    const first = await continueWork({ store, transcriptDir }, { sourceId: source.id, requester: "U2", spaceId: space.id });
    expect(first.existed).toBe(false);
    expect(first.forkId).not.toBe(generic.id);
    const continuation = await store.getWorkItem(first.forkId);
    expect(continuation).not.toBeNull();
    expect(JSON.parse(continuation!.fork_json!)).toMatchObject({ intent: "continuation" });

    const second = await continueWork({ store, transcriptDir }, { sourceId: source.id, requester: "U3", spaceId: space.id });
    expect(second.existed).toBe(true);
    expect(second.forkId).toBe(first.forkId);

    const forks = (await store.listAudit({ event_type: WORK_ITEM_FORKED_EVENT }))
      .map((row) => JSON.parse(row.payload))
      .filter((payload) => payload.forked_from === source.id);
    expect(forks.filter((payload) => payload.intent === "continuation")).toHaveLength(1);
    expect(forks.filter((payload) => payload.intent === undefined)).toHaveLength(1);
  });

  test("rejects unknown, foreign-space, and overlong guidance", async () => {
    const { store, transcriptDir } = fixture();
    await expect(continueWork({ store, transcriptDir }, { sourceId: "wi_missing", requester: "U2", spaceId: "slack:C359" })).rejects.toThrow(/not found/);
    const { source, space } = await blockedSource(store, transcriptDir);
    await expect(continueWork({ store, transcriptDir }, { sourceId: source.id, requester: "U2", spaceId: "slack:other" })).rejects.toThrow(/foreign space/);
    await expect(
      continueWork({ store, transcriptDir }, { sourceId: source.id, requester: "U2", spaceId: space.id, guidance: "x".repeat(CONTINUATION_GUIDANCE_MAX_CHARS + 1) }),
    ).rejects.toThrow(/guidance/);
  });
});
