import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry, MemoryProvider, MemoryScopeKey } from "../memory/types";
import { createAudit } from "../policy/audit";
import { loadSpacePolicy, parseOrgConfigYaml } from "../policy/config";
import { createStore, type Store } from "../store/db";
import { buildRegistry } from "./actions";
import { memoryReviewAction, renderMemoryReview } from "./memory-review";
import { tickScheduler } from "./runner";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshStore(): Store {
  const root = mkdtempSync(join(tmpdir(), "bottega-memory-review-"));
  roots.push(root);
  return createStore(join(root, "memory-review.db"));
}

/** SQLite-shaped review provider: reports recallable/forgotten counts deterministically. */
function reviewMemory(countRecall: Record<string, number>, countForgot: Record<string, number>): MemoryProvider {
  return {
    capabilities: { consolidation: "explicit", digestPruning: "explicit", forget: "explicit" },
    async save(input): Promise<MemoryEntry> {
      return {
        id: "unused",
        key: input.scope,
        content: input.content,
        metadata: input.metadata ?? {},
        createdAt: 0,
        provenance: { source: input.source ?? "tool", spaceId: null, principal: null, scopeLabel: "org" },
      };
    },
    async search(): Promise<MemoryEntry[]> {
      return [];
    },
    async pruneDigests(): Promise<number> {
      return 0;
    },
    async forget(input): Promise<{ id: string; key: MemoryScopeKey; forgottenAt: number }> {
      return { id: input.id, key: input.scope, forgottenAt: 0 };
    },
    countForgotten: async (scope) => countForgot[scope.kind] ?? 0,
    countRecallable: async (scope) => countRecall[scope.kind] ?? 0,
  };
}

async function dueReviewJob(store: Store, now: number): Promise<void> {
  const job = await store.createSchedulerJob({
    action: "weekly_memory_review",
    cron: "0 9 * * 1",
    params: { space: "slack:CREV" },
    spaceId: "slack:CREV",
    createdBy: "UADMIN",
  });
  await store.updateSchedulerNextFire(job.id, now);
}

describe("weekly memory review (#163)", () => {
  test("renderMemoryReview is deterministic, redacted, and carries the next review date", () => {
    const text = renderMemoryReview(3, 2, Date.UTC(2026, 7, 21, 12));
    expect(text).toContain("*Weekly memory review*");
    expect(text).toContain("Recallable memory entries: 3");
    expect(text).toContain("Forgotten (tombstoned) memory entries: 2");
    expect(text).toContain("Next review: 2026-08-28");
    // Redacted: the review never echoes memory content.
    expect(text).not.toContain("secret");
    expect(text).not.toContain("xoxb-");
  });

  test("registered scheduler action posts a deterministic redacted review with counts", async () => {
    const now = Date.UTC(2052, 7, 21, 9);
    const store = freshStore();
    await store.getOrCreateSpace({ platform: "slack", channel_id: "CREV", name: "memory-review" });
    await store.updatePolicy("slack:CREV", JSON.stringify({ proactive: { memory_review: true } }));
    await dueReviewJob(store, now);
    const audit = createAudit(store);
    const posts: Array<{ space: string; text: string }> = [];
    const orgPolicy = parseOrgConfigYaml("response_mode: always\n");
    const provider = reviewMemory({ org: 2, channel: 1 }, { org: 1, channel: 1 });

    await tickScheduler({
      store,
      audit,
      registry: buildRegistry([memoryReviewAction]),
      memoryProvider: provider,
      postMessage: async (space, text) => {
        posts.push({ space, text });
        return "1.1";
      },
      loadPolicy: (space) => loadSpacePolicy(orgPolicy, store, space),
      log: () => {},
      now: () => now,
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]!.space).toBe("slack:CREV");
    expect(posts[0]!.text).toContain("Recallable memory entries: 3");
    expect(posts[0]!.text).toContain("Forgotten (tombstoned) memory entries: 2");
    expect(posts[0]!.text).toContain("Next review: 2052-08-28");
    const posted = await store.listAudit({ event_type: "memory.review_posted" });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.payload).toContain('"recallable":3');
    expect(posted[0]!.payload).toContain('"forgotten":2');
    expect(posted[0]!.payload).not.toContain("content");
    store.close();
  });

  test("disabled policy posts nothing; delivery failure is audited without content leak", async () => {
    const now = Date.UTC(2052, 7, 21, 9);
    const store = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "CREV", name: "memory-review" });
    const audit = createAudit(store);
    const orgPolicy = parseOrgConfigYaml("response_mode: always\n");
    let calls = 0;
    const run = () =>
      memoryReviewAction.run(
        { space: space.id },
        {
          store,
          audit,
          memoryProvider: reviewMemory({ org: 1 }, { org: 0 }),
          postMessage: async () => {
            calls += 1;
            throw new Error("Slack failed with secret xoxb-1234567890");
          },
          loadPolicy: (target) => loadSpacePolicy(orgPolicy, store, target),
          log: () => {},
          now: () => now,
        },
      );

    // Disabled proactive gate → never posts.
    await expect(run()).resolves.toBeUndefined();
    expect(calls).toBe(0);
    // Enable → the failure is audited with reason only, never the error body.
    await store.updatePolicy(space.id, JSON.stringify({ proactive: { memory_review: true } }));
    await expect(run()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    const failures = await store.listAudit({ event_type: "memory.review_failed" });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toContain("delivery_failed");
    expect(failures[0]!.payload).not.toContain("xoxb-");
    expect(failures[0]!.payload).not.toContain("Slack failed");
    store.close();
  });
});