/**
 * Four-persona multiplayer matrix (issue #298) — HERMETIC full-stack journeys.
 *
 * The caller-level role/multiplayer matrix lives in canary-multiplayer.test.ts
 * (direct tool-definition + store invocation). This file is the emulator-backed
 * counterpart: every journey boots the REAL stack via bootHarness (real store,
 * real policy gate, real Slack emulator as the Slack boundary, real Bolt router)
 * and drives the four fixed personas — requester, approver, member,
 * second-member — each with its own emulator identity + token + DM channel.
 *
 * The journeys replicate the live `live.roles.*` journey shape hermetically:
 *   1. requester submits a work item → approver receives the approval prompt
 *      (approval.requested) and approves via an emulated action (the #44 Bolt
 *      seam); the member observes the delivery post (delivery.requested) in the
 *      shared channel, and the approver's decision lands (delivery.resolved).
 *   2. second-member cannot approve someone else's request — fail-closed authz:
 *      settle-once (a later click on an already-settled prompt is ignored and
 *      never attributes an approval to the second member) + foreign-space
 *      delivery clicks fail closed (never write delivery.resolved).
 *   3. cross-persona policy: read-tier (list_work_items) is viewer-visible;
 *      the write-tier prompt resolves with the ACTUAL clicking principal and is
 *      recorded with the right actor.
 * Each step asserts deterministic store/audit evidence (approval rows, delivery
 * rows) with the correct principal.
 *
 * The live roles journeys (live.roles.*) stay gated on real Slack identities
 * for the nightly leg; this file is the every-commit hermetic counterpart —
 * see the "Hybrid layers + nightly cadence (issue #298)" note in features.md.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bootHarness } from "./harness";
import {
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_RESOLVED_EVENT,
  DELIVERY_RESOLVED_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from "../../src/store/audit-events";
import { loadSpacePolicy } from "../../src/policy/config";
import { evaluatePolicyGate } from "../../src/policy/gate";
import { SlackApprovalRouter } from "../../src/server/adapters/approval-router";
import { pollPendingDeliveries } from "../../src/server/services/delivery-poller";
import { resolveDeliveryAction } from "../../src/server/adapters/delivery-router";
import {
  APPROVE_ACTION_ID,
  DELIVERY_APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  type SlackAdapter,
  type SlackBlockPayload,
} from "../../src/server/adapters/slack";
import { createFixtureRegistry } from "../../src/extensions/fixture";
import type { WorkItem } from "../../src/store/db";

/**
 * The four fixed personas seeded as emulator members (issue #298). The
 * registry's canonical identities (canary-registry.ts LIVE_IDENTITIES) name
 * these "requester / approver / member / second-member".
 */
const PERSONAS = ["requester", "approver", "member", "second-member"] as const;

/** Org policy: work items auto-approve (the documented create path); model_settings prompts (the approve/deny path). */
const PERSONA_ORG = [
  "tools:",
  "  create_work_item: allow",
  "  list_work_items: allow",
  "  work_item_cancel: allow",
  "  memory.save: allow",
  "  memory.search: allow",
  "  use_model: allow",
  "  model_settings: prompt",
  "approvals:",
  "  always_approve:",
  "    - create_work_item",
  "    - work_item_cancel",
  "",
].join("\n");

const CALLBACK_PORT = process.env.BOTTEGA_CALLBACK_PORT;
beforeAll(() => {
  process.env.BOTTEGA_CALLBACK_PORT = "0";
});
afterAll(() => {
  if (CALLBACK_PORT === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
  else process.env.BOTTEGA_CALLBACK_PORT = CALLBACK_PORT;
});

/** Recorded copy of an approval/delivery prompt the router posted (blocks retained for the button value). */
interface PostedPrompt {
  text: string;
  spaceId: string;
  blocks?: SlackBlockPayload[];
  ts?: string;
}

/**
 * A Slack adapter view that RECORDS every approval prompt it posts before
 * forwarding to a backing adapter. The SlackApprovalRouter must be passed as
 * the harness's `approve` router at boot (so emulated clicks route to it), but
 * the backing `h.adapter` only exists once the harness boots — so the delegate
 * is late-bound: construct it (and the router) before boot, pass
 * `approve: router`, then `bind(h.adapter)` after. This keeps the prompt on
 * the real emulator (observable via `h.messages()`) while letting the test
 * extract the button value deterministically.
 */
function makePromptRecordingAdapter(prompts: PostedPrompt[]) {
  let adapterRef: SlackAdapter | null = null;
  const delegate: Pick<SlackAdapter, "postMessage" | "updateMessage"> = {
    async postMessage(spaceId, text, opts) {
      prompts.push({ text, spaceId, blocks: opts?.blocks });
      const ts = await adapterRef!.postMessage(spaceId, text, opts);
      prompts[prompts.length - 1]!.ts = ts;
      return ts;
    },
    async updateMessage(spaceId, ts, text, opts) {
      await adapterRef!.updateMessage(spaceId, ts, text, opts);
    },
  };
  return {
    delegate,
    bind(adapter: SlackAdapter) {
      adapterRef = adapter;
    },
  };
}

/** Polls a predicate until it is truthy or the timeout elapses (the harness wait pattern). */
async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 10_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await fn();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(50);
  }
}

/** The request id from an approval prompt's blocks (the approve/deny button value). */
function promptRequestId(p: PostedPrompt): string {
  const value = actionButtonValue(p, (id) => id === APPROVE_ACTION_ID || id === DENY_ACTION_ID);
  if (!value) throw new Error("approval prompt carries no approve/deny button value in its blocks");
  return value;
}

/** The button `value` whose action_id matches, across the prompt's action blocks. */
function actionButtonValue(p: PostedPrompt, matches: (actionId: string) => boolean): string | undefined {
  for (const block of p.blocks ?? []) {
    if (block.type !== "actions") continue;
    for (const element of block.elements ?? []) {
      if (
        element.type === "button" &&
        element.action_id !== undefined &&
        matches(element.action_id) &&
        element.value !== undefined
      ) {
        return element.value;
      }
    }
  }
  return undefined;
}

describe("persona matrix: requester submits → approver approves → member observes the delivery post (issue #298)", () => {
  test("requester's item is created with their principal; the approver's emulated click approves the write-tier prompt (actor = approver); the member sees the delivery post that the approver resolves", async () => {
    const prompts: PostedPrompt[] = [];
    const recorder = makePromptRecordingAdapter(prompts);
    const router = new SlackApprovalRouter({ adapter: recorder.delegate, timeoutMs: 60_000 });
    const h = await bootHarness({
      slackUsers: [...PERSONAS],
      orgConfigYaml: PERSONA_ORG,
      registry: createFixtureRegistry(),
      approve: router,
    });
    recorder.bind(h.adapter);
    try {
      const requesterId = h.slack.user("requester")!;
      const approverId = h.slack.user("approver")!;
      const channel = h.slack.channelId("ops")!;
      const spaceId = `slack:${channel}`;
      const space = await h.store.getOrCreateSpace({ platform: "slack", channel_id: channel });

      // Step 1 — requester submits a work item; the durable row + created audit
      // carry the requester principal.
      const item: WorkItem = await h.store.createWorkItem({
        space_id: space.id,
        requester: requesterId,
        description: "persona matrix fixture task",
        delivery: "git",
      });
      const created = await h.store.listAudit({ space: space.id, event_type: WORK_ITEM_CREATED_EVENT });
      expect(JSON.parse(created[created.length - 1]!.payload)).toMatchObject({ id: item.id });
      expect(created[created.length - 1]!.actor).toBe(requesterId);

      // Step 2 — approver receives an approval prompt for a write-tier action
      // (model_settings is `prompt`). The prompt lands on the emulator.
      const gate = evaluatePolicyGate(
        { loadPolicy: (sid) => loadSpacePolicy(h.orgPolicy, h.store, sid), audit: h.audit, router, timeoutMs: 60_000 },
        { tool: "model_settings", args: { set: { reasoning_effort: "low" } }, spaceId, actor: requesterId },
      );
      const prompt = await waitFor(() => prompts[0], 10_000, "the approval prompt to post");
      await waitFor(
        () => h.messages(channel).some((m) => m.text.includes("Approval required") || m.text.includes("model_settings")),
        10_000,
        "the approval prompt in the emulator message log",
      );
      const requested = await h.store.listAudit({ space: spaceId, event_type: APPROVAL_REQUESTED_EVENT });
      expect(requested.length).toBeGreaterThanOrEqual(1);

      // Step 3 — the approver approves via an emulated action through the real
      // Bolt #44 seam; the approval row is attributed to the approver principal.
      await h.deliverAction({
        actionId: APPROVE_ACTION_ID,
        value: promptRequestId(prompt),
        channelId: channel,
        messageTs: prompt.ts ?? "1.000001",
        user: approverId,
      });
      await expect(gate).resolves.toMatchObject({ allowed: true });
      const resolved = await waitFor(
        async () => {
          const rows = await h.store.listAudit({ space: spaceId, event_type: APPROVAL_RESOLVED_EVENT });
          return rows.length > 0 ? rows : undefined;
        },
        10_000,
        "approval.resolved",
      );
      // The approval payload records the APPROVER principal as the deciding
      // actor (the audit row's `actor` field is the requester who initiated the
      // gate; the router's resolution carries the clicking principal).
      expect(JSON.parse(resolved![resolved!.length - 1]!.payload)).toMatchObject({
        approved: true,
        approver: approverId,
      });

      // Step 4 — the member observes the delivery post: the executor's
      // delivery.pending marker → the real poller posts the PR + approve prompt
      // into the shared channel; the approver's decision resolves the delivery.
      await h.audit.appendAudit({
        space_id: space.id,
        actor: "executor",
        event_type: "work_item.delivery_pending",
        payload: JSON.stringify({ id: item.id, pr_url: "https://github.com/acme/persona/pull/1", summary: "persona fixture delivery" }),
      });
      const announced = await pollPendingDeliveries(h.store, h.adapter);
      expect(announced).toBe(1);
      // The member (any persona in the channel) observes the posted delivery prompt
      // (the poller posts through the harness adapter into the shared channel).
      await waitFor(
        () => (h.messages(channel).some((m) => m.text.includes("PR ready")) ? true : undefined),
        10_000,
        "the delivery-approval prompt in the emulator message log",
      );
      // The delivery button value IS the work item id (buildDeliveryBlocks
      // keys the resolver on it, issue #149) — mirroring the canary.
      const handled = await resolveDeliveryAction(
        { store: h.store, adapter: h.adapter },
        {
          actionId: DELIVERY_APPROVE_ACTION_ID,
          value: item.id,
          spaceId,
          principal: approverId,
          messageTs: "1.000002",
        },
      );
      expect(handled).toBe(true);
      const deliveryResolved = await waitFor(
        async () => {
          const rows = await h.store.listAudit({ space: spaceId, event_type: DELIVERY_RESOLVED_EVENT });
          return rows.length > 0 ? rows : undefined;
        },
        10_000,
        "delivery.resolved",
      );
      // The delivery resolution's audit actor IS the clicking approver
      // (delivery-router writes actor: a.principal).
      expect(deliveryResolved![deliveryResolved!.length - 1]!.actor).toBe(approverId);
    } finally {
      await h.cleanup();
    }
  }, 30_000);
});

describe("persona matrix: second-member cannot approve someone else's request (fail-closed authz, issue #298)", () => {
  test("a request settles once (first decision wins): after the approver resolves, the second-member's click on the same prompt is ignored and never attributes an approval to them", async () => {
    const prompts: PostedPrompt[] = [];
    const recorder = makePromptRecordingAdapter(prompts);
    const router = new SlackApprovalRouter({ adapter: recorder.delegate, timeoutMs: 60_000 });
    const h = await bootHarness({
      slackUsers: [...PERSONAS],
      orgConfigYaml: PERSONA_ORG,
      registry: createFixtureRegistry(),
      approve: router,
    });
    recorder.bind(h.adapter);
    try {
      const requesterId = h.slack.user("requester")!;
      const approverId = h.slack.user("approver")!;
      const secondId = h.slack.user("second-member")!;
      const channel = h.slack.channelId("ops")!;
      const spaceId = `slack:${channel}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: channel });

      const gate = evaluatePolicyGate(
        { loadPolicy: (sid) => loadSpacePolicy(h.orgPolicy, h.store, sid), audit: h.audit, router, timeoutMs: 60_000 },
        { tool: "model_settings", args: { set: { reasoning_effort: "high" } }, spaceId, actor: requesterId },
      );
      const prompt = await waitFor(() => prompts[0], 10_000, "the approval prompt to post");
      const requestId = promptRequestId(prompt);

      // The approver approves first (their action is the requester's request,
      // not another principal's — a single principal cannot forge another).
      await h.deliverAction({
        actionId: APPROVE_ACTION_ID,
        value: requestId,
        channelId: channel,
        messageTs: prompt.ts ?? "1.000001",
        user: approverId,
      });
      await expect(gate).resolves.toMatchObject({ allowed: true });
      // The deciding principal is the approver (the router's resolution records
      // the clicking principal in the payload's `approver`; the row's `actor` is
      // the requester who initiated the gate).
      const attrs = async () =>
        (await h.store.listAudit({ space: spaceId, event_type: APPROVAL_RESOLVED_EVENT })).map((r) => {
          // SAFETY: approval.resolved payloads are flat JSON objects carrying
          // the approved/approver fields (audit-events.ts + gate.ts write them);
          // only the `approver` field is read, so a malformed payload fails the
          // attribution assertions loudly instead of passing vacuously.
          return JSON.parse(r.payload) as { approver?: string | null };
        });
      const afterApprover = await waitFor(
        async () => {
          const a = await attrs();
          return a.some((p) => p.approver === approverId) ? a.length : undefined;
        },
        10_000,
        "the approver's resolution to land",
      );

      // The second-member clicks approve on the SAME (now settled) prompt.
      await h.deliverAction({
        actionId: APPROVE_ACTION_ID,
        value: requestId,
        channelId: channel,
        messageTs: prompt.ts ?? "1.000001",
        user: secondId,
      });
      await new Promise((r) => setTimeout(r, 150));

      // Fail-closed: the request is already settled — the second-member's click
      // is ignored, no second approval row is written, and the second-member is
      // never attributed as an approver of the requester's request.
      const afterSecond = await attrs();
      expect(afterSecond).toHaveLength(afterApprover!);
      expect(afterSecond.map((p) => p.approver)).not.toContain(secondId);
      expect(afterSecond.map((p) => p.approver)).toContain(approverId);
    } finally {
      await h.cleanup();
    }
  }, 30_000);

  test("a delivery click from a foreign space fails closed — never writes delivery.resolved for the second principal", async () => {
    const h = await bootHarness({
      slackUsers: [...PERSONAS],
      orgConfigYaml: PERSONA_ORG,
      registry: createFixtureRegistry(),
    });
    try {
      const requesterId = h.slack.user("requester")!;
      const memberId = h.slack.user("member")!;
      const channel = h.slack.channelId("ops")!;
      const spaceId = `slack:${channel}`;
      const space = await h.store.getOrCreateSpace({ platform: "slack", channel_id: channel });
      const item: WorkItem = await h.store.createWorkItem({
        space_id: space.id,
        requester: requesterId,
        description: "foreign space delivery fixture",
        delivery: "git",
      });
      await h.audit.appendAudit({
        space_id: space.id,
        actor: "executor",
        event_type: "work_item.delivery_pending",
        payload: JSON.stringify({ id: item.id, pr_url: "https://github.com/acme/persona/pull/2", summary: "fixture" }),
      });
      await pollPendingDeliveries(h.store, h.adapter);

      // A member click from a foreign space (slack:C999) is ignored — fail closed.
      const handled = await resolveDeliveryAction(
        { store: h.store, adapter: h.adapter },
        {
          actionId: DELIVERY_APPROVE_ACTION_ID,
          value: item.id,
          spaceId: "slack:C999",
          principal: memberId,
          messageTs: "1.000002",
        },
      );
      expect(handled).toBe(false);
      expect(await h.store.listAudit({ space: spaceId, event_type: DELIVERY_RESOLVED_EVENT })).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  }, 30_000);
});

describe("persona matrix: cross-persona policy (read-tier visible, write-tier needs the right principal, issue #298)", () => {
  test("read-tier work-item queue is shared across personas; the write-tier prompt resolves with the ACTUAL clicking principal", async () => {
    const prompts: PostedPrompt[] = [];
    const recorder = makePromptRecordingAdapter(prompts);
    const router = new SlackApprovalRouter({ adapter: recorder.delegate, timeoutMs: 60_000 });
    const h = await bootHarness({
      slackUsers: [...PERSONAS],
      orgConfigYaml: PERSONA_ORG,
      registry: createFixtureRegistry(),
      approve: router,
    });
    recorder.bind(h.adapter);
    try {
      const requesterId = h.slack.user("requester")!;
      const channel = h.slack.channelId("ops")!;
      const spaceId = `slack:${channel}`;
      const space = await h.store.getOrCreateSpace({ platform: "slack", channel_id: channel });

      // Read-tier: a requester-created item sits in the shared queue that any
      // persona can read (list_work_items is read-tier, issue #159). The list
      // audit row is written per viewer principal by the tool definition.
      const item: WorkItem = await h.store.createWorkItem({
        space_id: space.id,
        requester: requesterId,
        description: "cross-persona policy read",
        delivery: "chat",
      });
      expect((await h.store.listWorkItems({ space_id: space.id })).some((i) => i.id === item.id)).toBe(true);

      // Write-tier: a model_settings prompt resolves with the ACTUAL clicking
      // principal — a requester-triggered write that the approver denies records
      // the approver as the actor, never the requester.
      const gate = evaluatePolicyGate(
        { loadPolicy: (sid) => loadSpacePolicy(h.orgPolicy, h.store, sid), audit: h.audit, router, timeoutMs: 60_000 },
        { tool: "model_settings", args: { set: { reasoning_effort: "low" } }, spaceId, actor: requesterId },
      );
      const prompt = await waitFor(() => prompts[0], 10_000, "the write-tier prompt to post");
      await h.deliverAction({
        actionId: DENY_ACTION_ID,
        value: promptRequestId(prompt),
        channelId: channel,
        messageTs: prompt.ts ?? "1.000001",
        user: h.slack.user("approver")!,
      });
      await expect(gate).resolves.toMatchObject({ allowed: false });
      const resolved = await waitFor(
        async () => {
          const rows = await h.store.listAudit({ space: spaceId, event_type: APPROVAL_RESOLVED_EVENT });
          return rows.length > 0 ? rows : undefined;
        },
        10_000,
        "approval.resolved for the write-tier deny",
      );
      // The write-tier prompt resolved with the ACTUAL clicking principal: the
      // approver who denied is the payload's `approver` (the row's `actor` is
      // the requester who initiated the gate).
      expect(JSON.parse(resolved![resolved!.length - 1]!.payload)).toMatchObject({
        approved: false,
        approver: h.slack.user("approver")!,
      });
    } finally {
      await h.cleanup();
    }
  }, 30_000);
});
