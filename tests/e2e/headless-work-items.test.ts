/**
 * Headless work-item journeys (issue #363): exercise work-item creation,
 * human approval, timeout denial, cancellation authorization, chat completion,
 * and fork branching through the real stack with no Slack transport.
 */
import { describe, expect, test } from "bun:test";
import { bootHarness, HEADLESS_HUMAN, type Harness, type HarnessApprovalRouter, type StubTurn } from "./harness";
import { parseOrgConfigYaml } from "../../src/policy/config";
import { workItemsExtension } from "../../src/tools/work-items";
import { SlackApprovalRouter } from "../../src/server/adapters/approval-router";
import { APPROVE_ACTION_ID, type SlackAction } from "../../src/server/adapters/slack";
import { forkWorkItem } from "../../src/work-items/fork";
import {
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_RESOLVED_EVENT,
  WORK_ITEM_FORKED_EVENT,
  WORK_ITEM_TRANSITION_EVENT,
} from "../../src/store/audit-events";
import type { ApprovalRequest, ApprovalResolution } from "../../src/policy/approval-router";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { AuditRow, Store, WorkItem } from "../../src/store/db";

const ORG_CONFIG = [
  "tools:",
  "  create_work_item: allow",
  "  work_item_cancel: allow",
  "  complete_work_item: allow",
  "approvals:",
  "  always_approve:",
  "    - create_work_item",
  "    - work_item_cancel",
  "    - complete_work_item",
  "",
].join("\n");
const ASK_CONFIG = ["tools:", "  create_work_item: allow", ""].join("\n");

/** The SDK extension factory needs a store that is available only after boot. */
function workItemCustomTools(orgConfigYaml: string, actor = "agent") {
  const orgPolicy = parseOrgConfigYaml(orgConfigYaml);
  let storeRef: Store | null = null;
  // SAFETY: the proxy target is intentionally empty; every property read is
  // redirected to the store bound after boot.
  const storeProxy = new Proxy({} as Store, {
    get: (_target, prop: PropertyKey) => {
      if (storeRef === null) throw new Error("work item tools used before the harness store was bound");
      // SAFETY: the proxy key is supplied by the Store consumer and is
      // narrowed to the Store property domain before access.
      return storeRef[prop as keyof Store];
    },
  }) as Store;
  const defs: ToolDefinition[] = [];
  // SAFETY: the fixture registration callback receives exactly the extension
  // API shape consumed by workItemsExtension.
  workItemsExtension(storeProxy, { orgPolicy, actor })({
    registerTool: (tool: ToolDefinition) => void defs.push(tool),
  } as ExtensionAPI);
  return {
    // SAFETY: adding the marker preserves every ToolDefinition field; the
    // harness consumes the resulting object through the same tool contract.
    customTools: defs.map((def) => ({ ...def, __isToolDefinition: true }) as ToolDefinition),
    bindStore(store: Store) {
      storeRef = store;
    },
  };
}

/** Poll an observable surface without introducing a fixed-duration sleep. */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

async function waitForAsync<T>(probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

type CreatedPayload = { id: string };
type TransitionPayload = { id: string; from: string; to: string; by: string };
type ApprovalPayload = { tool: string; approved: boolean; approver: string | null };
type ForkPayload = { id: string; forked_from: string; note?: string; by: string };

function createdPayload(row: AuditRow): CreatedPayload {
  // SAFETY: this audit event is serialized by the work-item creation path with
  // the exact payload shape asserted by CreatedPayload.
  return JSON.parse(row.payload) as CreatedPayload;
}

function transitionPayload(row: AuditRow): TransitionPayload {
  // SAFETY: transition audit rows are emitted with these four fields.
  return JSON.parse(row.payload) as TransitionPayload;
}

function approvalPayload(row: AuditRow): ApprovalPayload {
  // SAFETY: approval audit rows are emitted with this decision payload.
  return JSON.parse(row.payload) as ApprovalPayload;
}

function forkPayload(row: AuditRow): ForkPayload {
  // SAFETY: fork audit rows are emitted with this source/child payload.
  return JSON.parse(row.payload) as ForkPayload;
}

async function findOpenItem(harness: Harness, spaceId: string): Promise<WorkItem> {
  return waitForAsync(async () => {
    const rows = await harness.store.listAudit({ space: spaceId, event_type: "work_item.created" });
    for (const row of rows) {
      const item = await harness.store.getWorkItem(createdPayload(row).id);
      if (item !== null) return item;
    }
    return undefined;
  });
}

/** Install the production Slack router after boot while keeping boot wiring lazy. */
function lazyApprovalRouter() {
  let router: SlackApprovalRouter | undefined;
  const approval: HarnessApprovalRouter = {
    request(request: ApprovalRequest): Promise<ApprovalResolution> {
      if (router === undefined) throw new Error("approval router used before it was bound");
      return router.request(request);
    },
    handleAction(action: SlackAction): Promise<void> {
      return router?.handleAction(action) ?? Promise.resolve();
    },
  };
  return {
    approval,
    bind(next: SlackApprovalRouter) {
      router = next;
    },
  };
}

type ApprovalPrompt = { requestId: string; messageTs: string };

/** Capture the request id and message ts carried by the real approval blocks. */
type ApprovalCapture = { prompt: Promise<ApprovalPrompt>; seen: ApprovalPrompt[] };

function captureApprovalPrompt(harness: Harness): ApprovalCapture {
  const seen: ApprovalPrompt[] = [];
  const originalPost = harness.adapter.postMessage.bind(harness.adapter);
  let resolvePrompt: ((prompt: ApprovalPrompt) => void) | undefined;
  const prompt = new Promise<ApprovalPrompt>((resolve) => {
    resolvePrompt = resolve;
  });
  harness.adapter.postMessage = async (spaceId, text, opts) => {
    const ts = await originalPost(spaceId, text, opts);
    const action = opts?.blocks
      ?.flatMap((block) => block.elements ?? [])
      .find((element) => element.action_id === APPROVE_ACTION_ID && element.value !== undefined);
    if (ts !== undefined && action?.value !== undefined) {
      const captured = { requestId: action.value, messageTs: ts };
      seen.push(captured);
      resolvePrompt?.(captured);
    }
    return ts;
  };
  return { prompt, seen };
}

describe("headless work items (issue #363)", () => {
  test("human approval creates an open item and rewrites the same prompt message", async () => {
    const tools = workItemCustomTools(ORG_CONFIG);
    const lazy = lazyApprovalRouter();
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "create_work_item", args: { description: "fix the checkout" } }] },
      { type: "text", text: "created" },
    ];
    const harness = await bootHarness({
      headless: true,
      orgConfigYaml: ASK_CONFIG,
      modelTurns: turns,
      approve: lazy.approval,
    });
    tools.bindStore(harness.store);
    const router = new SlackApprovalRouter({ adapter: harness.adapter, audit: harness.audit, timeoutMs: 5_000 });
    lazy.bind(router);
    const promptCapture = captureApprovalPrompt(harness);
    const dm = harness.slack.dmChannelId;
    const before = harness.messages(dm).length;
    try {
      const turn = harness.deliverMessage(dm, "fix the checkout");
      await harness.modelStub.waitForRequests(1);
      const prompt = await promptCapture.prompt;
      expect(harness.messages(dm).length).toBeGreaterThan(before);
      expect(harness.messages(dm).find((message) => message.ts === prompt.messageTs)?.text).toContain("Approval required");

      await harness.deliverAction({
        actionId: APPROVE_ACTION_ID,
        value: prompt.requestId,
        channelId: dm,
        messageTs: prompt.messageTs,
        user: HEADLESS_HUMAN,
      });
      await harness.modelStub.waitForRequests(2);
      await turn;

      const item = await findOpenItem(harness, `slack:${dm}`);
      expect(item.state).toBe("open");
      const requested = await harness.store.listAudit({ event_type: APPROVAL_REQUESTED_EVENT });
      const resolved = await harness.store.listAudit({ event_type: APPROVAL_RESOLVED_EVENT });
      // SAFETY: approval-request audit rows are serialized by the approval
      // router with the tool and reason fields asserted below.
      expect(requested.map((row) => JSON.parse(row.payload) as { tool: string; reason: string })).toEqual([
        expect.objectContaining({ tool: "create_work_item", reason: "exec-tier tool requires human approval" }),
      ]);
      expect(resolved.map(approvalPayload)).toEqual([
        { tool: "create_work_item", approved: true, approver: HEADLESS_HUMAN },
      ]);
      const rewritten = await waitFor(() => {
        const message = harness.messages(dm).find((candidate) => candidate.ts === prompt.messageTs);
        return message?.text.includes("Approval resolved") ? message : undefined;
      });
      expect(rewritten.ts).toBe(prompt.messageTs);
      expect(rewritten.text).toContain("Approved");
      expect(rewritten.text).toContain(HEADLESS_HUMAN);
    } finally {
      await harness.cleanup();
    }
  });

  test("unanswered approval times out, denies creation, and rewrites with the timeout outcome", async () => {
    const lazy = lazyApprovalRouter();
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "create_work_item", args: { description: "time-sensitive fix" } }] },
      { type: "text", text: "not created" },
    ];
    const harness = await bootHarness({
      headless: true,
      orgConfigYaml: ASK_CONFIG,
      modelTurns: turns,
      approve: lazy.approval,
    });
    const router = new SlackApprovalRouter({ adapter: harness.adapter, audit: harness.audit, timeoutMs: 50 });
    lazy.bind(router);
    const promptCapture = captureApprovalPrompt(harness);
    const dm = harness.slack.dmChannelId;
    try {
      const turn = harness.deliverMessage(dm, "time-sensitive fix");
      await harness.modelStub.waitForRequests(1);
      const prompt = await promptCapture.prompt;
      await harness.modelStub.waitForRequests(2, 5_000);
      await turn;

      expect(await harness.store.listAudit({ event_type: "work_item.created" })).toHaveLength(0);
      const resolved = await waitForAsync(async () => {
        const rows = await harness.store.listAudit({ event_type: APPROVAL_RESOLVED_EVENT });
        return rows.length > 0 ? rows : undefined;
      });
      expect(resolved.map(approvalPayload)).toEqual([
        { tool: "create_work_item", approved: false, approver: null },
      ]);
      const rewritten = await waitFor(() => {
        const message = harness.messages(dm).find((candidate) => candidate.ts === prompt.messageTs);
        return message?.text.includes("expired") ? message : undefined;
      });
      expect(rewritten.text).toContain("expired");
      expect(rewritten.text).toContain("create_work_item");
    } finally {
      await harness.cleanup();
    }
  });

  test("requester cancellation succeeds while a different principal is denied", async () => {
    const runCancellation = async (actor: string, requester: string, expectedState: "aborted" | "open", expectDenied: boolean) => {
      const tools = workItemCustomTools(ORG_CONFIG, actor);
      const harness = await bootHarness({ headless: true, orgConfigYaml: ORG_CONFIG, customTools: tools.customTools });
      tools.bindStore(harness.store);
      const dm = harness.slack.dmChannelId;
      try {
        harness.modelStub.respond([
          {
            type: "tool_calls",
            calls: [{ name: "create_work_item", args: { description: "cancel me", delivery: "chat", requester } }],
          },
          { type: "text", text: "created" },
        ]);
        const createTurn = harness.deliverMessage(dm, "cancel me", {}, requester);
        await harness.modelStub.waitForRequests(2);
        await createTurn;
        const item = await findOpenItem(harness, `slack:${dm}`);

        harness.modelStub.respond([
          {
            type: "tool_calls",
            calls: [{ name: "work_item_cancel", args: { id: item.id } }],
          },
          { type: "text", text: expectDenied ? "cancel denied" : "cancelled" },
        ]);
        const cancelTurn = harness.deliverMessage(dm, "cancel the work item", {}, actor);
        await harness.modelStub.waitForRequests(4);
        await cancelTurn;

        const finalItem = await harness.store.getWorkItem(item.id);
        expect(finalItem?.state).toBe(expectedState);
        const transitions = (await harness.store.listAudit({ event_type: WORK_ITEM_TRANSITION_EVENT }))
          .map(transitionPayload)
          .filter((row) => row.id === item.id);
        if (expectDenied) {
          expect(transitions.some((row) => row.to === "aborted")).toBe(false);
          expect(harness.modelStub.latestMessages().some((message) => message.role === "tool" && String(message.content).includes("cancel requires the requester"))).toBe(true);
        } else {
          expect(transitions).toEqual(expect.arrayContaining([expect.objectContaining({ from: "open", to: "aborted", by: actor })]));
        }
      } finally {
        await harness.cleanup();
      }
    };

    await runCancellation(HEADLESS_HUMAN, HEADLESS_HUMAN, "aborted", false);
    await runCancellation("U-headless-other", HEADLESS_HUMAN, "open", true);
  });

  test("complete_work_item drives an existing chat item to done through the write-tier tool", async () => {
    const tools = workItemCustomTools(ORG_CONFIG, HEADLESS_HUMAN);
    const harness = await bootHarness({ headless: true, orgConfigYaml: ORG_CONFIG, customTools: tools.customTools });
    tools.bindStore(harness.store);
    const dm = harness.slack.dmChannelId;
    try {
      const space = await harness.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const item = await harness.store.createWorkItem({
        space_id: space.id,
        requester: HEADLESS_HUMAN,
        description: "answer a question",
        delivery: "chat",
      });
      harness.modelStub.respond([
        {
          type: "tool_calls",
          calls: [{ name: "complete_work_item", args: { id: item.id, summary: "answered from the conversation" } }],
        },
        { type: "text", text: "answered from the conversation" },
      ]);
      const turn = harness.deliverMessage(dm, "answer the question", {}, HEADLESS_HUMAN);
      await harness.modelStub.waitForRequests(2);
      await turn;

      const done = await harness.store.getWorkItem(item.id);
      expect(done?.state).toBe("done");
      // SAFETY: a done work item stores its result as the summary object
      // produced by the completion tool.
      expect(JSON.parse(done?.result ?? "{}") as { summary: string }).toEqual({ summary: "answered from the conversation" });
      const transitions = (await harness.store.listAudit({ event_type: WORK_ITEM_TRANSITION_EVENT }))
        .map(transitionPayload)
        .filter((row) => row.id === item.id);
      expect(transitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "open", to: "claimed" }),
          expect.objectContaining({ from: "claimed", to: "working" }),
          expect.objectContaining({ from: "working", to: "done" }),
        ]),
      );
    } finally {
      await harness.cleanup();
    }
  });

  test("forking a done item creates a fresh child and leaves the source untouched", async () => {
    const harness = await bootHarness({ headless: true });
    try {
      const space = await harness.store.getOrCreateSpace({ platform: "slack", channel_id: harness.slack.dmChannelId });
      const source = await harness.store.createWorkItem({
        space_id: space.id,
        requester: HEADLESS_HUMAN,
        description: "finish the release note",
        delivery: "chat",
      });
      await harness.store.transitionWorkItem(source.id, "open", "claimed", { by: HEADLESS_HUMAN });
      await harness.store.transitionWorkItem(source.id, "claimed", "working", { by: HEADLESS_HUMAN });
      const done = await harness.store.transitionWorkItem(source.id, "working", "done", {
        by: HEADLESS_HUMAN,
        result: JSON.stringify({ summary: "released" }),
      });

      const child = await forkWorkItem(
        {
          getWorkItem: harness.store.getWorkItem.bind(harness.store),
          queryAudit: harness.store.queryAudit.bind(harness.store),
          createWorkItem: harness.store.createWorkItem.bind(harness.store),
          transcriptDir: harness.transcriptDir,
        },
        { sourceId: source.id, atTimelineIndex: 1, note: "try again", requester: "U-headless-forker" },
      );

      expect(child.id).not.toBe(source.id);
      expect(child.state).toBe("open");
      expect(child.forked_from).toBe(source.id);
      // SAFETY: forked work items store this timeline/note object in
      // fork_json, written by forkWorkItem.
      expect(JSON.parse(child.fork_json ?? "{}") as { timelineIndex: number; note: string }).toMatchObject({
        timelineIndex: 1,
        note: "try again",
      });
      expect(await harness.store.getWorkItem(source.id)).toEqual(done);
      const forkRows = await harness.store.listAudit({ event_type: WORK_ITEM_FORKED_EVENT });
      expect(forkRows.map(forkPayload)).toEqual([
        expect.objectContaining({ id: child.id, forked_from: source.id, note: "try again", by: "U-headless-forker" }),
      ]);
    } finally {
      await harness.cleanup();
    }
  });
});
