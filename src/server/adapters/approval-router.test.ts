/**
 * Hermetic tests for the Slack-backed approval router (issue #44): a fake
 * adapter captures the posted prompt and the outcome rewrite, and the
 * full policy-gate loop (extension + router + buttons) runs against a real
 * store so the audit rows are asserted end to end.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { createStore, type Space } from "../../store/db";
import { createAudit } from "../../policy/audit";
import { parseOrgConfigYaml } from "../../policy/config";
import createPolicyExtension from "../../policy/extension";
import type { ApprovalRouter } from "../../policy/approval-router";
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  type SlackAction,
  type SlackAdapter,
} from "./slack";
import {
  ARGS_SUMMARY_MAX_CHARS,
  SlackApprovalRouter,
  buildApprovalBlocks,
} from "./approval-router";

interface Posted {
  spaceId: string;
  text: string;
  blocks?: unknown[];
}

function fakeAdapter(overrides?: { failPost?: boolean; onPosted?: () => void }): {
  adapter: Pick<SlackAdapter, "postMessage" | "updateMessage">;
  posted: Posted[];
  updated: { spaceId: string; ts: string; text: string }[];
} {
  const posted: Posted[] = [];
  const updated: { spaceId: string; ts: string; text: string }[] = [];
  return {
    posted,
    updated,
    adapter: {
      async postMessage(spaceId, text, opts) {
        if (overrides?.failPost) throw new Error("slack down");
        posted.push({ spaceId, text, blocks: opts?.blocks });
        overrides?.onPosted?.();
        return `ts-${posted.length}`;
      },
      async updateMessage(spaceId, ts, text) {
        updated.push({ spaceId, ts, text });
      },
    },
  };
}

interface Block {
  type: string;
  text?: { type: string; text: string };
  elements?: { type: string; text?: { type: string; text: string }; action_id?: string; value?: string; style?: string }[];
}

function actionBlocks(posted: Posted[]): Block[] {
  return (posted[0].blocks as Block[] | undefined) ?? [];
}

function buttonsFrom(posted: Posted[]): { actionId: string; value: string; style?: string }[] {
  const actions = actionBlocks(posted).find((b) => b.type === "actions");
  return (actions?.elements ?? [])
    .filter((e) => e.action_id !== undefined && e.value !== undefined)
    .map((e) => ({ actionId: e.action_id!, value: e.value!, style: e.style }));
}

function requestIdFrom(posted: Posted[]): string {
  return buttonsFrom(posted)[0].value;
}

/** Request id of the i-th posted prompt (0-based). */
function requestIdAt(posted: Posted[], i: number): string {
  const actions = (posted[i].blocks as Block[] | undefined)?.find((b) => b.type === "actions");
  return actions?.elements?.find((e) => e.value !== undefined)?.value ?? "";
}

function click(actionId: string, value: string, overrides: Partial<SlackAction> = {}): SlackAction {
  return { actionId, value, spaceId: "slack:C1", principal: "U42", messageTs: "1.1", ...overrides };
}

const REQUEST = {
  tool: "create_work_item",
  args: { title: "add login", description: "..." },
  reason: "exec-tier tool requires human approval",
  spaceId: "slack:C1",
  actor: "agent",
};

describe("SlackApprovalRouter request", () => {
  test("posts an interactive approval message with approve/deny buttons carrying the request id", async () => {
    const { adapter, posted } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    const promise = router.request(REQUEST);
    const id = requestIdFrom(posted);

    expect(posted).toHaveLength(1);
    expect(posted[0].spaceId).toBe("slack:C1");
    expect(posted[0].text).toContain("create_work_item");
    const sections = actionBlocks(posted).filter((b) => b.type === "section");
    expect(sections.some((s) => s.text?.text.includes("create_work_item"))).toBe(true);
    expect(sections.some((s) => s.text?.text.includes(REQUEST.reason))).toBe(true);
    const buttons = buttonsFrom(posted);
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.actionId).sort()).toEqual([APPROVE_ACTION_ID, DENY_ACTION_ID]);
    expect(buttons[0].value).toBe(id);
    expect(buttons[1].value).toBe(id);
    expect(router.pendingCount).toBe(1);

    await router.handleAction(click(APPROVE_ACTION_ID, id));
    await expect(promise).resolves.toEqual({ approved: true, approver: "U42" });
  });

  test("the args summary in the prompt is redacted", async () => {
    const { adapter, posted } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    void router.request({ ...REQUEST, args: { token: "sk-abcdef1234567890", cmd: "ls" } });
    const sections = actionBlocks(posted).filter((b) => b.type === "section");
    const rendered = sections.map((s) => s.text?.text ?? "").join("\n");
    expect(rendered).not.toContain("sk-abcdef1234567890");
    expect(rendered).toContain("sk-[REDACTED]");
    expect(rendered).toContain("ls");
  });

  test("the args summary is capped at ARGS_SUMMARY_MAX_CHARS", async () => {
    const { adapter, posted } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    void router.request({ ...REQUEST, args: { blob: "x".repeat(ARGS_SUMMARY_MAX_CHARS + 500) } });
    const rendered = actionBlocks(posted)
      .filter((b) => b.type === "section")
      .map((s) => s.text?.text ?? "")
      .join("\n");
    expect(rendered).toContain("[truncated]");
    expect(rendered.length).toBeLessThan(ARGS_SUMMARY_MAX_CHARS + 1000);
  });

  test("postMessage failure denies the request without registering it", async () => {
    const { adapter } = fakeAdapter({ failPost: true });
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    await expect(router.request(REQUEST)).resolves.toEqual({ approved: false });
    expect(router.pendingCount).toBe(0);
  });
});

describe("SlackApprovalRouter resolution", () => {
  test("approve resolves approved with the clicking user as approver and rewrites the message", async () => {
    const { adapter, posted, updated } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    const promise = router.request(REQUEST);
    const id = requestIdFrom(posted);
    await router.handleAction(click(APPROVE_ACTION_ID, id, { principal: "U7" }));

    await expect(promise).resolves.toEqual({ approved: true, approver: "U7" });
    expect(router.pendingCount).toBe(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].spaceId).toBe("slack:C1");
    expect(updated[0].ts).toBe("ts-1");
    expect(updated[0].text).toContain("Approved");
    expect(updated[0].text).toContain("U7");
  });

  test("deny resolves denied with the clicking user and rewrites the message", async () => {
    const { adapter, posted, updated } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    const promise = router.request(REQUEST);
    const id = requestIdFrom(posted);
    await router.handleAction(click(DENY_ACTION_ID, id, { principal: "U9" }));

    await expect(promise).resolves.toEqual({ approved: false, approver: "U9" });
    expect(router.pendingCount).toBe(0);
    expect(updated[0].text).toContain("Denied");
    expect(updated[0].text).toContain("U9");
  });

  test("a second click on the same request is ignored", async () => {
    const { adapter, posted, updated } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    const promise = router.request(REQUEST);
    const id = requestIdFrom(posted);
    await router.handleAction(click(APPROVE_ACTION_ID, id, { principal: "U1" }));
    await router.handleAction(click(DENY_ACTION_ID, id, { principal: "U2" }));

    await expect(promise).resolves.toEqual({ approved: true, approver: "U1" });
    expect(updated).toHaveLength(1);
  });

  test("unknown request ids are ignored without resolving anything", async () => {
    const { adapter, posted, updated } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    let resolved: unknown = "pending";
    const promise = router.request(REQUEST);
    promise.then((r) => {
      resolved = r;
    });
    const id = requestIdFrom(posted);

    await router.handleAction(click(APPROVE_ACTION_ID, "bogus-id"));
    await router.handleAction(click(APPROVE_ACTION_ID, id, { spaceId: "slack:OTHER" }));

    expect(resolved).toBe("pending");
    expect(router.pendingCount).toBe(1);
    expect(updated).toHaveLength(0);

    // The real request still resolves normally afterwards.
    await router.handleAction(click(APPROVE_ACTION_ID, id));
    await expect(promise).resolves.toEqual({ approved: true, approver: "U42" });
  });

  test("clicks from a different channel than the prompt are ignored", async () => {
    const { adapter, posted, updated } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    const promise = router.request(REQUEST);
    const id = requestIdFrom(posted);
    await router.handleAction(click(APPROVE_ACTION_ID, id, { spaceId: "slack:C2" }));

    let resolved = "pending";
    promise.then(() => {
      resolved = "resolved";
    });
    expect(resolved).toBe("pending");
    expect(updated).toHaveLength(0);
    await router.handleAction(click(APPROVE_ACTION_ID, id));
    await expect(promise).resolves.toEqual({ approved: true, approver: "U42" });
  });

  test("timeout denies, evicts the request and rewrites the message", async () => {
    const { adapter, posted, updated } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 30 });

    const promise = router.request(REQUEST);
    expect(router.pendingCount).toBe(1);

    await expect(promise).resolves.toEqual({ approved: false });
    expect(router.pendingCount).toBe(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].spaceId).toBe("slack:C1");
    expect(updated[0].ts).toBe("ts-1");
    expect(updated[0].text).toContain("expired");
    expect(updated[0].text).toContain("create_work_item");
    expect(posted[0].text).toContain("create_work_item");
  });

  test("the registry is bounded: the oldest request is evicted (denied) at capacity", async () => {
    const { adapter, posted, updated } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000, maxPending: 2 });

    const first = router.request(REQUEST);
    const second = router.request({ ...REQUEST, tool: "task" });
    const firstId = requestIdAt(posted, 0);

    // Third request pushes the first out: it resolves denied immediately.
    const third = router.request({ ...REQUEST, tool: "bash" });
    await expect(first).resolves.toEqual({ approved: false });
    expect(updated.some((u) => u.text.includes("evicted"))).toBe(true);
    expect(router.pendingCount).toBe(2);

    // The evicted request's buttons no longer resolve anything.
    await router.handleAction(click(APPROVE_ACTION_ID, firstId));
    expect(router.pendingCount).toBe(2);

    await router.handleAction(click(DENY_ACTION_ID, requestIdAt(posted, 1)));
    await expect(second).resolves.toEqual({ approved: false, approver: "U42" });
    await router.handleAction(click(APPROVE_ACTION_ID, requestIdAt(posted, 2)));
    await expect(third).resolves.toEqual({ approved: true, approver: "U42" });
    expect(router.pendingCount).toBe(0);
  });
});

describe("buildApprovalBlocks", () => {
  test("renders tool, reason, redacted args and both buttons carrying the id", () => {
    const blocks = buildApprovalBlocks(
      { ...REQUEST, args: { api_key: "AKIA1234567890ABCDEF" } },
      "req-123",
    );
    const rendered = (blocks as Block[])
      .filter((b) => b.type === "section")
      .map((s) => s.text?.text ?? "")
      .join("\n");
    expect(rendered).toContain("create_work_item");
    expect(rendered).toContain(REQUEST.reason);
    expect(rendered).toContain("[REDACTED]");
    expect(rendered).not.toContain("AKIA1234567890ABCDEF");
    const buttons = (blocks as Block[])
      .find((b) => b.type === "actions")
      ?.elements?.filter((e) => e.action_id !== undefined && e.value !== undefined);
    expect(buttons?.map((b) => b.value)).toEqual(["req-123", "req-123"]);
    expect(buttons?.map((b) => b.style)).toEqual(["primary", "danger"]);
  });
});

describe("policy gate end to end with the Slack router (issue #44)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bottega-router-"));
  const store = createStore(join(dir, "test.db"));
  const audit = createAudit(store);
  let space: Space;

  beforeAll(async () => {
    space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

  function makeGate(router: ApprovalRouter): (tool: string, input?: Record<string, unknown>) => Promise<ToolCallEventResult | void> {
    const handlers = new Map<string, ToolCallHandler>();
    const pi = { on: (event: "tool_call", h: ToolCallHandler) => void handlers.set(event, h) } as unknown as ExtensionAPI;
    createPolicyExtension({
      orgPolicy: parseOrgConfigYaml("tools:\n  bash: allow\n  create_work_item: allow\n"),
      audit,
      router,
      store,
    })(pi);
    return async (tool, input = {}) => {
      const ctx = { sessionManager: { getSessionFile: () => join("/tmp/sessions", `${space.id}.jsonl`) } } as ExtensionContext;
      const handler = handlers.get("tool_call")!;
      return handler({ type: "tool_call", toolCallId: "tc1", toolName: tool, input } as ToolCallEvent, ctx);
    };
  }

  async function resolvedAuditRows() {
    const rows = await audit.listAudit({ event_type: "approval.resolved" });
    return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  }

  test("ask-human posts a prompt; Approve lets the tool run and both approvals are audited", async () => {
    const postedSignal = Promise.withResolvers<void>();
    const { adapter, posted, updated } = fakeAdapter({ onPosted: () => postedSignal.resolve() });
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });
    const gate = makeGate(router);
    const requestedBefore = (await audit.listAudit({ event_type: "approval.requested" })).length;

    const pending = gate("create_work_item", { title: "x" });
    await postedSignal.promise; // the gate path runs real async (store reads) before the prompt posts
    const id = requestIdFrom(posted);
    await router.handleAction(click(APPROVE_ACTION_ID, id, { principal: "U42" }));
    const result = await pending;

    expect(result).toBeUndefined(); // tool runs
    expect(posted).toHaveLength(1);
    expect(updated).toHaveLength(1);
    expect(await audit.listAudit({ event_type: "approval.requested" })).toHaveLength(requestedBefore + 1);
    const resolved = await resolvedAuditRows();
    expect(resolved.at(-1)).toMatchObject({ tool: "create_work_item", approved: true, approver: "U42" });
  });

  test("ask-human posts a prompt; Deny blocks the tool and is audited", async () => {
    const postedSignal = Promise.withResolvers<void>();
    const { adapter, posted } = fakeAdapter({ onPosted: () => postedSignal.resolve() });
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });
    const gate = makeGate(router);

    const pending = gate("bash", { command: "ls" });
    await postedSignal.promise;
    const id = requestIdFrom(posted);
    await router.handleAction(click(DENY_ACTION_ID, id, { principal: "U9" }));
    const result = await pending;

    if (typeof result === "object" && result !== null) {
      expect(result.block).toBe(true);
    } else {
      expect.unreachable("expected a block result");
    }
    const resolved = await resolvedAuditRows();
    expect(resolved.at(-1)).toMatchObject({ tool: "bash", approved: false, approver: "U9" });
  });

  test("ask-human with no button click times out to deny", async () => {
    const { adapter, updated } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 30 });
    const gate = makeGate(router);

    const result = await gate("bash", { command: "ls" });

    if (typeof result === "object" && result !== null) {
      expect(result.block).toBe(true);
    } else {
      expect.unreachable("expected a block result");
    }
    expect(updated.some((u) => u.text.includes("expired"))).toBe(true);
    const resolved = await resolvedAuditRows();
    expect(resolved.at(-1)).toMatchObject({ tool: "bash", approved: false });
  });
});

describe("SlackApprovalRouter wiring invariants", () => {
  test("router satisfies the ApprovalRouter request contract", () => {
    const { adapter } = fakeAdapter();
    const router: ApprovalRouter = new SlackApprovalRouter({ adapter });
    expect(typeof router.request).toBe("function");
    expect(typeof (router as SlackApprovalRouter).handleAction).toBe("function");
  });
});
