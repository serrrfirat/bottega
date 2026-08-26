/**
 * Work-review router tests (issue #359): the BLOCKED issue card's
 * "Open review" click authorizes the clicking Slack actor live (channel
 * membership, fail-closed), then mints an actor-bound single-use review
 * token and delivers its private link by ephemeral message. Hermetic: real
 * store, fake SlackAdapter members.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "bun:test";
import { createStore, type Store } from "../../store/db";
import type { SlackAction } from "./slack";
import { type OutboxKind, type OutboxRow } from "../../store/outbox";
import {
  OPEN_WORK_REVIEW_ACTION_ID,
  RETRY_WITH_CONTEXT_ACTION_ID,
  openWorkReviewButton,
  retryWithContextButton,
} from "./blocks";
import { renderOutboxBlocks } from "../services/outbox-post-seam";
import { resolveOpenReviewAction } from "./work-review-router";

const dirs: string[] = [];
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface EphemeralPost {
  spaceId: string;
  userId: string;
  text: string;
}

function freshFixture(opts: { members?: readonly string[]; failMembership?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bottega-work-review-"));
  dirs.push(dir);
  const store = createStore(join(dir, "test.db"));
  stores.push(store);
  const transcriptDir = join(dir, "transcripts");
  const ephemerals: EphemeralPost[] = [];
  return { store, transcriptDir, ephemerals, adapterOpts: opts };
}

function click(value: string, spaceId = "slack:C1", teamId = "T1"): SlackAction {
  return {
    actionId: OPEN_WORK_REVIEW_ACTION_ID,
    value,
    spaceId,
    principal: "U1",
    messageTs: "1000.0001",
    teamId,
  };
}

/** Seeds a blocked git item with a transcript in space slack:C1. */
async function seedBlockedItem(store: Store, transcriptDir: string, channelId = "C1") {
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: channelId });
  const item = await store.createWorkItem({
    space_id: space.id,
    requester: "U0",
    description: "Vendor NDA retention review",
    repo: "org/vendor-docs",
    delivery: "git",
  });
  await store.claimWorkItemById(item.id);
  await store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(transcriptDir, `${item.id}.jsonl`),
    [
      JSON.stringify({ role: "user", content: [{ type: "text", text: "review the NDA" }], timestamp: Date.now() }),
    ].join("\n"),
  );
  vi.useFakeTimers();
  vi.advanceTimersByTime(1000);
  await store.transitionWorkItem(item.id, "working", "blocked", { evidence: "missing retention period", by: "executor" });
  vi.useRealTimers();
  return { item, space };
}

/** Builds a real outbox-shaped work_item notification payload. */
function blockedRow(payloadJson: string, kind: OutboxKind = "work_item"): OutboxRow {
  const t = Date.now();
  return {
    id: "job_test",
    kind,
    payload: payloadJson,
    space: "slack:C1",
    status: "pending",
    attempts: 0,
    created_at: t,
    posted_at: null,
  };
}

describe("Blocked card controls (issue #359)", () => {
  test("a blocked landing renders exactly the open-review and fast-continue actions", async () => {
    const { store, transcriptDir } = freshFixture();
    const { item } = await seedBlockedItem(store, transcriptDir);
    const blocks = renderOutboxBlocks(
      blockedRow(
        JSON.stringify({ workItemId: item.id, description: "Vendor NDA retention review", state: "blocked" }),
      ),
    );
    expect(blocks).toBeDefined();
    const buttonActions = (blocks ?? []).flatMap((block) =>
      "elements" in block && Array.isArray(block.elements)
        ? block.elements.map((element) => element.action_id)
        : [],
    );
    expect(buttonActions.sort()).toEqual(
      [OPEN_WORK_REVIEW_ACTION_ID, RETRY_WITH_CONTEXT_ACTION_ID].sort(),
    );
    const joined = JSON.stringify(blocks);
    expect(joined).toContain("Open review");
    expect(joined).toContain("Continue using work so far");
  });

  test("buttons carry only the work-item id as their value", () => {
    const reviewButton = JSON.parse(JSON.stringify(openWorkReviewButton("wi_x")));
    expect(reviewButton.elements[0].action_id).toBe(OPEN_WORK_REVIEW_ACTION_ID);
    expect(reviewButton.elements[0].text.text).toBe("Open review");
    expect(reviewButton.elements[0].value).toBe("wi_x");
    const retry = JSON.parse(JSON.stringify(retryWithContextButton("wi_x")));
    expect(retry.elements[0].text.text).toBe("Continue using work so far");
  });
});

describe("Open review action routing (issue #359)", () => {
  test("a current member receives one actor-bound redeem link by ephemeral message", async () => {
    const { store, transcriptDir, ephemerals } = freshFixture();
    const { item } = await seedBlockedItem(store, transcriptDir);
    const handled = await resolveOpenReviewAction(
      {
        store,
        adapter: {
          isChannelMember: async () => true,
          postEphemeral: async (spaceId, userId, text) => void ephemerals.push({ spaceId, userId, text }),
        },
        publicBaseUrl: () => "https://bottega.example.com",
      },
      click(item.id),
    );
    expect(handled).toBe(true);
    expect(ephemerals.length).toBe(1);
    const post = ephemerals[0]!;
    expect(post.spaceId).toBe("slack:C1");
    expect(post.userId).toBe("U1");
    const linkText = /https:\/\/bottega\.example\.com\/work-review\/redeem\/\S+/u.exec(post.text)?.[0] ?? "";
    const link = new URL(linkText);
    expect(link.pathname.startsWith("/work-review/redeem/")).toBe(true);

    // Redemption proves the hashed-at-rest, actor-bound mint: only the raw
    // token redeems exactly once into a session carrying this identity.
    const rawToken = link.pathname.split("/").pop() ?? "";
    const session = store.redeemWorkReviewToken({
      rawToken,
      rawSession: "session-value",
      csrfHash: "csrf-hash",
      sessionExpiresAt: Date.now() + 60_000,
      now: Date.now(),
    });
    expect(session).not.toBeNull();
    expect(session?.identity).toEqual({
      workItemId: item.id,
      slackTeamId: "T1",
      slackUserId: "U1",
      slackChannelId: "C1",
    });
    expect(
      store.redeemWorkReviewToken({
        rawToken,
        rawSession: "session-two",
        csrfHash: "csrf-hash",
        sessionExpiresAt: Date.now() + 60_000,
        now: Date.now(),
      }),
    ).toBeNull();
  });

  test("a non-member receives no link and no work details", async () => {
    const { store, transcriptDir, ephemerals } = freshFixture({ members: ["U2"] });
    const { item } = await seedBlockedItem(store, transcriptDir);
    const handled = await resolveOpenReviewAction(
      {
        store,
        adapter: {
          isChannelMember: async (_spaceId, userId) => userId !== "U1",
          postEphemeral: async (spaceId, userId, text) => void ephemerals.push({ spaceId, userId, text }),
        },
        publicBaseUrl: () => "https://bottega.example.com",
      },
      click(item.id),
    );
    expect(handled).toBe(false);
    expect(ephemerals.length).toBe(0);
    // Seeding itself writes work-item lifecycle audit rows; the DENY must
    // add none of the issue-#359 review events (no token mint / link event).
    const rows = (await store.queryAudit({ limit: 100 })).rows;
    expect(rows.some((row) => row.event_type.startsWith("work_review."))).toBe(false);
  });

  test("a membership lookup outage fails closed", async () => {
    const { store, transcriptDir, ephemerals } = freshFixture({ failMembership: true });
    const { item } = await seedBlockedItem(store, transcriptDir);
    const handled = await resolveOpenReviewAction(
      {
        store,
        adapter: {
          isChannelMember: async () => {
            throw new Error("conversations.members failed");
          },
          postEphemeral: async (spaceId, userId, text) => void ephemerals.push({ spaceId, userId, text }),
        },
        publicBaseUrl: () => "https://bottega.example.com",
      },
      click(item.id),
    );
    expect(handled).toBe(false);
    expect(ephemerals.length).toBe(0);
  });

  test("the originating channel must match the work item's space", async () => {
    const { store, transcriptDir, ephemerals } = freshFixture();
    const { item } = await seedBlockedItem(store, transcriptDir, "C2");
    const handled = await resolveOpenReviewAction(
      {
        store,
        adapter: {
          isChannelMember: async () => true,
          postEphemeral: async (spaceId, userId, text) => void ephemerals.push({ spaceId, userId, text }),
        },
        publicBaseUrl: () => "https://bottega.example.com",
      },
      click(item.id),
    );
    expect(handled).toBe(false);
    expect(ephemerals.length).toBe(0);
  });

  test("unknown items and foreign clicks are ignored", async () => {
    const { store, transcriptDir, ephemerals } = freshFixture();
    await seedBlockedItem(store, transcriptDir);
    const unknownHandled = await resolveOpenReviewAction(
      {
        store,
        adapter: {
          isChannelMember: async () => true,
          postEphemeral: async (spaceId, userId, text) => void ephemerals.push({ spaceId, userId, text }),
        },
        publicBaseUrl: () => "https://bottega.example.com",
      },
      click("wi_missing"),
    );
    expect(unknownHandled).toBe(false);

    const foreignHandled = await resolveOpenReviewAction(
      {
        store,
        adapter: {
          isChannelMember: async () => true,
          postEphemeral: async (spaceId, userId, text) => void ephemerals.push({ spaceId, userId, text }),
        },
        publicBaseUrl: () => "https://bottega.example.com",
      },
      click("", "slack:C9"),
    );
    expect(foreignHandled).toBe(false);
    expect(ephemerals.length).toBe(0);
  });
});
