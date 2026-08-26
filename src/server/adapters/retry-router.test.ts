/**
 * Retry-with-context router tests (issue #358): the BLOCKED issue card's
 * button click forks at the failure point through the same fork service as
 * REST. Hermetic: real store, fake SlackAdapter. Fails on any pre-#358
 * tree — no retry action id, no fork machinery.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "bun:test";
import { createStore, type Store } from "../../store/db";
import type { SlackAction, SlackAdapter } from "./slack";
import { RETRY_WITH_CONTEXT_ACTION_ID, retryWithContextButton } from "./blocks";
import { resolveRetryAction } from "./retry-router";

const dirs: string[] = [];
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freshFixture() {
  const dir = mkdtempSync(join(tmpdir(), "bottega-retry-"));
  dirs.push(dir);
  const store = createStore(join(dir, "test.db"));
  stores.push(store);
  const transcriptDir = join(dir, "transcripts");
  const posts: Array<{ spaceId: string; text: string }> = [];
  // The DI seam expects a full SlackAdapter; the router only consumes
  // postMessage, so the unused members are deterministic no-throw stubs.
  const adapter = {
    postMessage: async (spaceId: string, text: string): Promise<string | undefined> => {
      posts.push({ spaceId, text });
      return "1700.1";
    },
    updateMessage: async () => {},
    downloadFile: async () => {
      throw new Error("not used");
    },
    uploadFile: async () => undefined,
    addReaction: async () => {},
    removeReaction: async () => {},
    startStream: async () => {
      throw new Error("not used");
    },
    appendText: async () => {},
    appendTask: async () => {},
    stopStream: async () => {},
    isChannelMember: async () => true,
    postEphemeral: async () => {},
    streamingSupported: () => false,
    start: async () => {},
    stop: async () => {},
  } satisfies SlackAdapter;
  return { store, transcriptDir, posts, adapter };
}

function click(value: string, spaceId = "slack:C1"): SlackAction {
  return {
    actionId: RETRY_WITH_CONTEXT_ACTION_ID,
    value,
    spaceId,
    principal: "U42",
    messageTs: "1700.0001",
  };
}

/** Seeds a blocked git item with a transcript in space slack:C1. */
async function seedBlockedItem(store: Store, transcriptDir: string) {
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
  const item = await store.createWorkItem({
    space_id: space.id,
    requester: "U1",
    description: "fix the flake",
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
      `{"type":"message","message":{"content":"found the race"},"timestamp":"${new Date(item.created_at + 10).toISOString()}"}`,
      "",
    ].join("\n"),
  );
  vi.useFakeTimers();
  vi.advanceTimersByTime(1000);
  await store.transitionWorkItem(item.id, "working", "blocked", { evidence: "boom", by: "executor" });
  await store.appendAudit({
    space_id: space.id,
    actor: "executor",
    event_type: "work_item.failed",
    payload: JSON.stringify({ id: item.id, error: "boom" }),
  });
  vi.useRealTimers();
  return { item, space };
}

describe("Retry with context router (issue #358)", () => {
  test("a click forks at the failure point and announces the new attempt", async () => {
    const { store, transcriptDir, posts, adapter } = freshFixture();
    const { item } = await seedBlockedItem(store, transcriptDir);

    const handled = await resolveRetryAction({ store, adapter, transcriptDir }, click(item.id));
    expect(handled).toBe(true);

    // The fork exists, carries the edge + prior context, and the space was told.
    const edges = await store.listAudit({ event_type: "work_item.forked" });
    // SAFETY: audit payloads are written via JSON.stringify, so each parses to an object.
    const forkPayloads = edges.map((row) => JSON.parse(row.payload) as { id: string; forked_from: string });
    expect(forkPayloads.filter((p) => p.forked_from === item.id)).toHaveLength(1);
    const forkId = forkPayloads.find((p) => p.forked_from === item.id)!.id;
    const fork = await store.getWorkItem(forkId);
    expect(fork!.forked_from).toBe(item.id);
    expect(JSON.parse(fork!.fork_json!)).toMatchObject({ cause: "boom" });
    expect(posts).toEqual([
      expect.objectContaining({
        spaceId: "slack:C1",
        text: expect.stringContaining(`Retrying with context — forked as *${forkId}*`),
      }),
    ]);
  });

  test("the original stays blocked; a second click answers with the existing fork", async () => {
    const { store, transcriptDir, posts, adapter } = freshFixture();
    const { item } = await seedBlockedItem(store, transcriptDir);

    expect(await resolveRetryAction({ store, adapter, transcriptDir }, click(item.id))).toBe(true);
    expect((await store.getWorkItem(item.id))!.state).toBe("blocked");
    posts.length = 0;

    // Second click: settle-once via the fork's own audit row — no second fork.
    expect(await resolveRetryAction({ store, adapter, transcriptDir }, click(item.id))).toBe(true);
    const edges = await store.listAudit({ event_type: "work_item.forked" });
    // SAFETY: audit payloads are written via JSON.stringify, so each parses to an object.
    expect(edges.filter((row) => (JSON.parse(row.payload) as { forked_from?: string }).forked_from === item.id)).toHaveLength(1);
    expect(posts).toEqual([expect.objectContaining({ text: expect.stringContaining("Already retried") })]);
  });

  test("foreign-space and unknown-item clicks are ignored untouched", async () => {
    const { store, transcriptDir, adapter } = freshFixture();
    const { item } = await seedBlockedItem(store, transcriptDir);

    expect(await resolveRetryAction({ store, adapter, transcriptDir }, click(item.id, "slack:C9"))).toBe(false);
    expect(await resolveRetryAction({ store, adapter, transcriptDir }, click("wi_missing"))).toBe(false);
    expect(await store.listAudit({ event_type: "work_item.forked" })).toHaveLength(0);
  });

  test("the renderer carries the work-item id under the shared action id", () => {
    const block = retryWithContextButton("wi_123");
    expect(block.type).toBe("actions");
    const element = block.elements![0]!;
    expect(element.action_id).toBe(RETRY_WITH_CONTEXT_ACTION_ID);
    expect(element.value).toBe("wi_123");
    expect(element.text.text).toBe("Continue using work so far");
  });
});
