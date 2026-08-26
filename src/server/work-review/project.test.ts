/**
 * Plain-language work review projection tests (issue #359).
 * Hermetic: real SQLite store, graph rows, and JSONL evidence.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteMemoryProvider } from "../../memory/sqlite";
import { createStore, type Store } from "../../store/db";
import { WORK_ITEM_FAILED_EVENT } from "../../store/audit-events";
import { projectWorkReview } from "./project";

const root = mkdtempSync(join(tmpdir(), "bottega-work-review-"));
const stores: Store[] = [];

afterAll(() => {
  for (const store of stores) store.close();
  rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync(join(root, "fixture-"));
  const store = createStore(join(dir, "review.db"));
  stores.push(store);
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C359", name: "Vendor Reviews" });
  const item = await store.createWorkItem({
    space_id: space.id,
    requester: "legal-owner",
    description: "Review vendor retention obligations\nUse plain language for the decision",
    repo: "acme/contracts",
    pr_url: "https://github.com/acme/contracts/pull/17",
  });
  await store.claimWorkItemById(item.id, "reviewer");
  await store.transitionWorkItem(item.id, "claimed", "working", { by: "reviewer" });
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  writeFileSync(
    join(dir, "transcripts", `${item.id}.jsonl`),
    [
      `{"type":"message","message":{"content":"Checked vendor identity and governing law."},"timestamp":"${new Date(item.created_at + 10).toISOString()}"}`,
      `{"type":"message","message":{"content":"Checked data categories and transfer terms."},"timestamp":"${new Date(item.created_at + 20).toISOString()}"}`,
      `{"type":"message","message":{"content":"Checked termination and audit rights."},"timestamp":"${new Date(item.created_at + 30).toISOString()}"}`,
      `{"type":"message","message":{"content":"The review stopped after the retention check."},"timestamp":"${new Date(item.created_at + 40).toISOString()}"}`,
      "",
    ].join("\n"),
  );
  await Bun.sleep(50);
  await store.transitionWorkItem(item.id, "working", "blocked", {
    by: "reviewer",
    evidence: "Human input needed: provide the contract retention period before approval.",
  });
  await store.appendAudit({
    space_id: space.id,
    actor: "reviewer",
    event_type: WORK_ITEM_FAILED_EVENT,
    payload: JSON.stringify({ id: item.id, error: "Missing retention period\n    at checkRetention (src/check.ts:42:3)" }),
  });
  await store.getOrCreateSpace({ platform: "slack", channel_id: "C359-other", name: "Other" });
  const fork = await store.createWorkItem({
    space_id: space.id,
    requester: "other-lawyer",
    description: "Follow-up matter",
    forkedFrom: item.id,
  });
  await store.transitionWorkItem(fork.id, "open", "done", { by: "other-lawyer" }).catch(() => undefined);

  const memory = createSqliteMemoryProvider(store.getDb());
  await memory.save({
    scope: { kind: "channel", spaceId: space.id },
    content: `Decision: retain vendor records for seven years for this review (${item.id})`,
    source: "legal-board",
  });

  return { store, transcriptDir: join(dir, "transcripts"), item, fork };
}

describe("projectWorkReview (issue #359)", () => {
  test("projects stored legal evidence into plain-language sections", async () => {
    const h = await fixture();
    const review = await projectWorkReview(h, h.item.id);
    expect(review).not.toBeNull();
    expect(review?.workItemId).toBe(h.item.id);
    expect(review?.title).toBe("Review vendor retention obligations");
    expect(review?.state).toBe("blocked");
    expect(review?.whatHappened).toEqual([
      "Review vendor retention obligations",
      "This work paused because Missing retention period",
    ]);
    expect(review?.workCompleted).toEqual([
      "Checked vendor identity and governing law.",
      "Checked data categories and transfer terms.",
      "Checked termination and audit rights.",
      "The review stopped after the retention check.",
    ]);
    expect(review?.stillNeeded).toEqual([
      "Missing retention period",
      "Human input needed: provide the contract retention period before approval.",
    ]);
    expect(review?.relatedPeople).toEqual(["legal-owner", "reviewer"]);
    expect(review?.relatedDocuments).toEqual(["acme/contracts", "https://github.com/acme/contracts/pull/17"]);
    expect(review?.relatedMatters).toContain("Follow-up matter");
    expect(review?.relatedDecisions).toEqual(["Decision: retain vendor records for seven years for this review"]);
    const plainText = [
      ...(review?.whatHappened ?? []),
      ...(review?.workCompleted ?? []),
      ...(review?.stillNeeded ?? []),
      ...(review?.relatedDecisions ?? []),
    ].join(" ");
    expect(plainText).not.toContain(h.item.id);
    expect(plainText).not.toContain("src/check.ts");
    expect(plainText).not.toContain("checkRetention");
    expect(review?.activity.some((entry) => entry.kind === "failed" && entry.cause.includes("src/check.ts"))).toBe(true);
  });

  test("is deterministic and returns null for unknown items", async () => {
    const h = await fixture();
    const first = await projectWorkReview(h, h.item.id);
    const second = await projectWorkReview(h, h.item.id);
    expect(second).toEqual(first);
    expect(await projectWorkReview(h, "wi_unknown")).toBeNull();
  });

  test("keeps unrelated categories empty when the item has no such evidence", async () => {
    const h = await fixture();
    const dir = mkdtempSync(join(root, "minimal-"));
    const store = createStore(join(dir, "minimal.db"));
    stores.push(store);
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C999", name: "Empty" });
    const item = await store.createWorkItem({ space_id: space.id, requester: "requester", description: "Minimal task without graph neighbours" });
    const review = await projectWorkReview({ store, transcriptDir: join(dir, "transcripts") }, item.id);
    expect(review).not.toBeNull();
    expect(review?.relatedPeople).toEqual(["requester"]);
    expect(review?.relatedMatters).toEqual([]);
    expect(review?.relatedDocuments).toEqual([]);
    expect(review?.relatedDecisions).toEqual([]);
    expect(review?.stillNeeded).toEqual([]);
  });
});
