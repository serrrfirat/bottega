/**
 * Delivery router tests (issue #149): the server side of the executor's
 * onDelivery seam. A button click on the poller's interactive prompt must
 * record the human's decision in the audit trail (delivery.resolved — the
 * row the executor's onDelivery wait reads) exactly once, and rewrite the
 * posted prompt with the outcome. Settle-once comes from the audit trail,
 * not memory: a fresh resolver over the same store must observe an earlier
 * decision and ignore further clicks.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELIVERY_REQUESTED_EVENT, DELIVERY_RESOLVED_EVENT } from "../../store/audit-events";
import { createStore, type Store } from "../../store/db";
import { DELIVERY_APPROVE_ACTION_ID, DELIVERY_DENY_ACTION_ID, type SlackAction, type SlackAdapter } from "./slack";
import { buildDeliveryBlocks, resolveDeliveryAction } from "./delivery-router";
import { z } from "zod";

const SPACE = "slack:C123";
const ITEM = "wi_1";
const PR_URL = "https://github.com/acme/sandbox/pull/42";

interface Posted {
  spaceId: string;
  text?: string;
  blocks?: unknown[];
}

interface Updated {
  spaceId: string;
  ts: string;
  text?: string;
}

function fakeAdapter(opts: { failUpdate?: boolean } = {}) {
  const posted: Posted[] = [];
  const updated: Updated[] = [];
  return {
    posted,
    updated,
    adapter: {
      async postMessage(spaceId, text, postOpts) {
        posted.push({ spaceId, text, blocks: postOpts?.blocks });
        return "1.000001";
      },
      async updateMessage(spaceId, ts, text) {
        if (opts.failUpdate) throw new Error("updateMessage failed (fake)");
        updated.push({ spaceId, ts, text });
      },
    },
  } satisfies {
    adapter: Pick<SlackAdapter, "postMessage" | "updateMessage">;
    posted: Posted[];
    updated: Updated[];
  };
}

interface Block {
  type: string;
  text?: { type: string; text: string };
  elements?: { type: string; text?: { type: string; text: string }; action_id?: string; value?: string; style?: string }[];
}

function buttons(blocks: Block[]): { actionId: string; value: string; style?: string }[] {
  const actions = blocks.find((b) => b.type === "actions");
  return (actions?.elements ?? [])
    .filter((e) => e.action_id !== undefined && e.value !== undefined)
    .map((e) => ({ actionId: e.action_id!, value: e.value!, style: e.style }));
}

function click(actionId: string, value: string, overrides: Partial<SlackAction> = {}): SlackAction {
  return { actionId, value, spaceId: SPACE, principal: "U42", messageTs: "1.000001", ...overrides };
}

/** Seeds the store the way the poller records an announcement (delivery.requested). */
async function seedAnnouncement(store: Store, itemId = ITEM, spaceId = SPACE): Promise<void> {
  await store.appendAudit({
    space_id: spaceId,
    actor: "server",
    event_type: DELIVERY_REQUESTED_EVENT,
    payload: JSON.stringify({ id: itemId, pr_url: PR_URL, summary: "implemented it" }),
  });
}

const resolvedRowSchema = z.object({ id: z.string(), approved: z.boolean(), approver: z.string() });

function resolvedRows(store: Store): Promise<Array<{ id: string; approved: boolean; approver: string }>> {
  return store.listAudit({ event_type: DELIVERY_RESOLVED_EVENT }).then((rows) =>
    rows.map((row) => resolvedRowSchema.parse(JSON.parse(row.payload))),
  );
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "bottega-delivery-router-"));
  const store = createStore(join(dir, "test.db"));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("buildDeliveryBlocks", () => {
  test("renders the PR with approve/deny buttons carrying the work item id", () => {
    // SAFETY: buildDeliveryBlocks is this repo's own renderer; its block shapes
    // (section/actions with text/elements) are exactly what the Block view models.
    const blocks = buildDeliveryBlocks(PR_URL, "implemented it", ITEM) as Block[];

    const sectionText = blocks
      .filter((b) => b.type === "section")
      .map((b) => b.text?.text ?? "")
      .join("\n");
    expect(sectionText).toContain("Delivery approval required");
    expect(sectionText).toContain(PR_URL);
    expect(sectionText).toContain("implemented it");

    const btns = buttons(blocks);
    expect(btns.map((b) => b.actionId).sort()).toEqual([DELIVERY_APPROVE_ACTION_ID, DELIVERY_DENY_ACTION_ID]);
    expect(btns[0].value).toBe(ITEM);
    expect(btns[1].value).toBe(ITEM);
    expect(btns.find((b) => b.actionId === DELIVERY_APPROVE_ACTION_ID)?.style).toBe("primary");
    expect(btns.find((b) => b.actionId === DELIVERY_DENY_ACTION_ID)?.style).toBe("danger");
  });

  test("escapes mrkdwn metacharacters in user-derived summary and prUrl", () => {
    // Regression for #346: summary/prUrl originate from agent/model message
    // text; without escaping they can inject mrkdwn into the delivered blocks.
    const blocks = buildDeliveryBlocks("https://x.dev/pull/<script>&amp;", "closing <@U1> & <#C2> now", ITEM) as Block[];

    const sectionText = blocks
      .filter((b) => b.type === "section")
      .map((b) => b.text?.text ?? "")
      .join("\n");

    // Metacharacters must be rendered as literal text, not structure.
    expect(sectionText).toContain("&lt;");
    expect(sectionText).toContain("&gt;");
    expect(sectionText).toContain("&amp;");
    // The raw metacharacters must not survive unescaped.
    expect(sectionText).not.toContain("<script>");
    expect(sectionText).not.toContain("<@");
  });
});

describe("resolveDeliveryAction", () => {
  test("approve records delivery.resolved with the clicking user and rewrites the prompt", async () => {
    const { store, cleanup } = makeStore();
    try {
      await seedAnnouncement(store);
      const { adapter, updated } = fakeAdapter();

      const handled = await resolveDeliveryAction({ store, adapter }, click(DELIVERY_APPROVE_ACTION_ID, ITEM, { principal: "U7" }));

      expect(handled).toBe(true);
      expect(await resolvedRows(store)).toEqual([{ id: ITEM, approved: true, approver: "U7" }]);
      expect(updated).toEqual([{ spaceId: SPACE, ts: "1.000001", text: expect.stringContaining("Delivery approved") }]);
      expect(updated[0].text).toContain("<@U7>");
    } finally {
      cleanup();
    }
  });

  test("deny records delivery.resolved approved:false and rewrites the prompt", async () => {
    const { store, cleanup } = makeStore();
    try {
      await seedAnnouncement(store);
      const { adapter, updated } = fakeAdapter();

      const handled = await resolveDeliveryAction({ store, adapter }, click(DELIVERY_DENY_ACTION_ID, ITEM));

      expect(handled).toBe(true);
      expect(await resolvedRows(store)).toEqual([{ id: ITEM, approved: false, approver: "U42" }]);
      expect(updated[0].text).toContain("Delivery denied");
      expect(updated[0].text).toContain("<@U42>");
    } finally {
      cleanup();
    }
  });

  test("settle-once: the first recorded click wins, later clicks are ignored (fresh resolver too)", async () => {
    const { store, cleanup } = makeStore();
    try {
      await seedAnnouncement(store);
      const { adapter, updated } = fakeAdapter();

      await resolveDeliveryAction({ store, adapter }, click(DELIVERY_APPROVE_ACTION_ID, ITEM, { principal: "U1" }));
      await resolveDeliveryAction({ store, adapter }, click(DELIVERY_DENY_ACTION_ID, ITEM, { principal: "U2" }));

      expect(await resolvedRows(store)).toEqual([{ id: ITEM, approved: true, approver: "U1" }]);
      expect(updated).toHaveLength(1); // the second click rewrote nothing

      // A server restart loses no state: a fresh resolver over the same
      // store observes the recorded decision and ignores the click.
      const restarted = fakeAdapter();
      const handled = await resolveDeliveryAction({ store, adapter: restarted.adapter }, click(DELIVERY_APPROVE_ACTION_ID, ITEM));
      expect(handled).toBe(false);
      expect(restarted.updated).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("ignores an item that was never announced", async () => {
    const { store, cleanup } = makeStore();
    try {
      const { adapter, updated } = fakeAdapter();

      const handled = await resolveDeliveryAction({ store, adapter }, click(DELIVERY_APPROVE_ACTION_ID, "wi_never"));

      expect(handled).toBe(false);
      expect(await resolvedRows(store)).toEqual([]);
      expect(updated).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("ignores a click from a foreign space", async () => {
    const { store, cleanup } = makeStore();
    try {
      await seedAnnouncement(store);
      const { adapter, updated } = fakeAdapter();

      const handled = await resolveDeliveryAction(
        { store, adapter },
        click(DELIVERY_APPROVE_ACTION_ID, ITEM, { spaceId: "slack:C999" }),
      );

      expect(handled).toBe(false);
      expect(await resolvedRows(store)).toEqual([]);
      expect(updated).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("ignores non-delivery action ids (exec-tier approvals go elsewhere)", async () => {
    const { store, cleanup } = makeStore();
    try {
      await seedAnnouncement(store);
      const { adapter, updated } = fakeAdapter();

      const handled = await resolveDeliveryAction({ store, adapter }, click("bottega_approve", ITEM));

      expect(handled).toBe(false);
      expect(await resolvedRows(store)).toEqual([]);
      expect(updated).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("a failed message rewrite never loses the recorded decision", async () => {
    const { store, cleanup } = makeStore();
    try {
      await seedAnnouncement(store);
      const { adapter } = fakeAdapter({ failUpdate: true });

      const handled = await resolveDeliveryAction({ store, adapter }, click(DELIVERY_APPROVE_ACTION_ID, ITEM));

      // The audit row IS the decision; the rewrite is best-effort.
      expect(handled).toBe(true);
      expect(await resolvedRows(store)).toEqual([{ id: ITEM, approved: true, approver: "U42" }]);
    } finally {
      cleanup();
    }
  });
});
