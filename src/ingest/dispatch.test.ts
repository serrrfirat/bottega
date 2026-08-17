import { afterEach, describe, expect, test } from "bun:test";
import { createAudit, type AuditModule } from "../policy/audit";
import {
  INGEST_POLL_DISPATCH_EVENT,
  INGEST_POLL_REJECTED_EVENT,
  INGEST_WEBHOOK_DISPATCH_EVENT,
  INGEST_WEBHOOK_REJECTED_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from "../store/audit-events";
import { createStore, type AuditRow, type Store } from "../store/db";
import { dispatchIngestEvent, type IngestDispatchContext } from "./dispatch";
import type { IngestEvent } from "./types";

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function freshStore(): Store {
  const store = createStore(":memory:");
  stores.push(store);
  return store;
}

function payload(row: AuditRow): Record<string, unknown> {
  return JSON.parse(row.payload) as Record<string, unknown>;
}

function validMentionEvent(): IngestEvent {
  return {
    provider: "github",
    eventType: "mention",
    occurredAt: "2026-08-17T12:00:30.000Z",
    payload: {
      kind: "mention",
      repo: "acme/bottega",
      number: 42,
      isPullRequest: false,
      title: "Fix the flaky checkout",
      url: "https://github.com/acme/bottega/issues/42",
      body: "Can you look at this?",
      author: "someone",
      updatedAt: "2026-08-17T12:00:30.000Z",
    },
  };
}

async function setup(leg: "webhook" | "poll" = "poll"): Promise<{
  store: Store;
  audit: AuditModule;
  spaceId: string;
  posts: string[];
  ctx: IngestDispatchContext;
}> {
  const store = freshStore();
  const audit = createAudit(store);
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_INGEST" });
  const posts: string[] = [];
  const ctx: IngestDispatchContext = {
    store,
    audit,
    postMessage: async (_spaceId, text) => {
      posts.push(text);
      return "ts_1";
    },
    leg,
    spaceId: space.id,
  };
  return { store, audit, spaceId: space.id, posts, ctx };
}

describe("dispatchIngestEvent (issue #57)", () => {
  test("a valid poll mention becomes a work item + Slack post + ingest.poll.dispatch audit", async () => {
    const { store, audit, spaceId, posts, ctx } = await setup("poll");

    await dispatchIngestEvent(ctx, validMentionEvent());

    // The store's existing creation path produced exactly one work item.
    const created = await audit.listAudit({ event_type: WORK_ITEM_CREATED_EVENT });
    expect(created).toHaveLength(1);
    const item = await store.getWorkItem(payload(created[0]!).id as string);
    expect(item).toMatchObject({
      space_id: spaceId,
      requester: "ingest:github",
      delivery: "extension",
      state: "open",
      repo: "acme/bottega",
    });
    expect(item!.description).toContain("https://github.com/acme/bottega/issues/42");
    expect(JSON.parse(item!.evidence)).toEqual([
      { kind: "issue_url", url: "https://github.com/acme/bottega/issues/42", at: expect.any(Number) },
    ]);

    expect(posts).toEqual([
      "GitHub mention: Fix the flaky checkout (acme/bottega#42) — https://github.com/acme/bottega/issues/42",
    ]);

    const dispatched = await audit.listAudit({ event_type: INGEST_POLL_DISPATCH_EVENT });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ space_id: spaceId, actor: "ingest:github" });
    expect(payload(dispatched[0]!)).toEqual({
      provider: "github",
      event_type: "mention",
      url: "https://github.com/acme/bottega/issues/42",
      work_item_id: item!.id,
      space_id: spaceId,
    });
    expect(await audit.listAudit({ event_type: INGEST_POLL_REJECTED_EVENT })).toEqual([]);
  });

  test("the same event via the webhook leg audits ingest.webhook.dispatch", async () => {
    const { audit, posts, ctx } = await setup("webhook");

    await dispatchIngestEvent(ctx, validMentionEvent());

    const dispatched = await audit.listAudit({ event_type: INGEST_WEBHOOK_DISPATCH_EVENT });
    expect(dispatched).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(await audit.listAudit({ event_type: WORK_ITEM_CREATED_EVENT })).toHaveLength(1);
    expect(await audit.listAudit({ event_type: INGEST_POLL_DISPATCH_EVENT })).toEqual([]);
  });

  const rejectedCases: Array<{
    label: string;
    event: IngestEvent;
    reason: string;
  }> = [
    {
      label: "unknown provider",
      event: { ...validMentionEvent(), provider: "gitlab" as never },
      reason: "unknown provider: gitlab",
    },
    {
      label: "empty eventType",
      event: { ...validMentionEvent(), eventType: "" },
      reason: "eventType must be a non-empty string",
    },
    {
      label: "unparseable occurredAt",
      event: { ...validMentionEvent(), occurredAt: "not-a-timestamp" },
      reason: "occurredAt is not a parseable timestamp",
    },
    {
      label: "payload is a string",
      event: { ...validMentionEvent(), payload: "nope" },
      reason: "payload must be a JSON object",
    },
    {
      label: "mention payload missing required fields",
      event: { ...validMentionEvent(), payload: { kind: "mention", repo: "acme/bottega" } },
      reason: "invalid github mention payload",
    },
    {
      label: "unsupported event type",
      event: { ...validMentionEvent(), eventType: "issue_comment" },
      reason: "unsupported event type",
    },
  ];

  for (const invalid of rejectedCases) {
    test(`rejects ${invalid.label} → ingest.poll.rejected, nothing created or posted`, async () => {
      const { audit, posts, ctx } = await setup("poll");

      await dispatchIngestEvent(ctx, invalid.event);

      expect(posts).toEqual([]);
      expect(await audit.listAudit({ event_type: WORK_ITEM_CREATED_EVENT })).toEqual([]);
      expect(await audit.listAudit({ event_type: INGEST_POLL_DISPATCH_EVENT })).toEqual([]);
      const rejected = await audit.listAudit({ event_type: INGEST_POLL_REJECTED_EVENT });
      expect(rejected).toHaveLength(1);
      // The actor reflects the provider the event CLAIMED (even when invalid).
      expect(rejected[0]).toMatchObject({ actor: `ingest:${String(invalid.event.provider)}` });
      expect(String(payload(rejected[0]!).reason)).toContain(invalid.reason);
    });
  }

  test("a rejected webhook-leg event audits ingest.webhook.rejected", async () => {
    const { audit, posts, ctx } = await setup("webhook");

    await dispatchIngestEvent(ctx, { ...validMentionEvent(), occurredAt: "garbage" });

    expect(posts).toEqual([]);
    expect(await audit.listAudit({ event_type: INGEST_WEBHOOK_REJECTED_EVENT })).toHaveLength(1);
  });

  test("a store failure propagates (validation is not the caller's problem to guess)", async () => {
    const { audit, ctx } = await setup("poll");
    const store = {
      async createWorkItem() {
        throw new Error("database unavailable");
      },
    } as unknown as Store;
    const failing: IngestDispatchContext = { ...ctx, store };

    await expect(dispatchIngestEvent(failing, validMentionEvent())).rejects.toThrow("database unavailable");
    expect(await audit.listAudit({ event_type: INGEST_POLL_REJECTED_EVENT })).toEqual([]);
    expect(await audit.listAudit({ event_type: INGEST_POLL_DISPATCH_EVENT })).toEqual([]);
  });
});
