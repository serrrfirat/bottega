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
import type { ApprovalResolution, ApprovalRouter } from "../../policy/approval-router";
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  type SlackAction,
  type SlackAdapter,
  type SlackBlockPayload,
} from "./slack";
import {
  ARGS_ROW_VALUE_MAX,
  ARGS_SECTION_TEXT_MAX,
  FAILURE_MEMORY_MAX,
  SLACK_SECTION_TEXT_MAX,
  SlackApprovalRouter,
  buildApprovalBlocks,
} from "./approval-router";

interface Posted {
  spaceId: string;
  text?: string;
  blocks?: SlackBlockPayload[];
}

interface FakeAdapterHarness {
  adapter: Pick<SlackAdapter, "postMessage" | "updateMessage">;
  posted: Posted[];
  updated: { spaceId: string; ts: string; text?: string }[];
}

function fakeAdapter(overrides?: { failPost?: boolean; onPosted?: () => void }): FakeAdapterHarness {
  const posted: Posted[] = [];
  const updated: { spaceId: string; ts: string; text?: string }[] = [];
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

function actionBlocks(posted: Posted[]): SlackBlockPayload[] {
  return posted[0]?.blocks ?? [];
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
  return buttonsFrom(posted.slice(i, i + 1))[0]?.value ?? "";
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

  test("space-skill mutation approvals show hash-and-size diffs without document or file bodies", async () => {
    const { adapter, posted } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });
    const document = "---\nname: review\ndescription: Private.\n---\nNever put this procedure in Slack.\n";

    void router.request({
      ...REQUEST,
      tool: "update_space_skill",
      args: {
        name: "review",
        expected_revision: "a".repeat(64),
        document,
        companion_files: { "scripts/run.sh": { encoding: "text", content: "never put this script in Slack" } },
      },
    });
    const rendered = actionBlocks(posted)
      .filter((block) => block.type === "section")
      .map((block) => block.text?.text ?? "")
      .join("\n");
    expect(rendered).not.toContain("Never put this procedure");
    expect(rendered).not.toContain("never put this script");
    expect(rendered).toContain("SKILL.md");
    expect(rendered).toContain("Companion scripts/run.sh");
    expect(rendered).toContain("replace");
    expect(rendered).toContain("omitted old files are deleted");
    expect(rendered).toContain("sha256");
    expect(rendered).toContain("a".repeat(64));
  });

  test("an oversized arg value is elided at the per-row cap with an ellipsis (issue #277)", async () => {
    const { adapter, posted } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    void router.request({ ...REQUEST, args: { blob: "x".repeat(ARGS_ROW_VALUE_MAX + 500) } });
    const rendered = actionBlocks(posted)
      .filter((b) => b.type === "section")
      .map((s) => s.text?.text ?? "")
      .join("\n");
    // The value is cut at ARGS_ROW_VALUE_MAX with an ellipsis — not the raw,
    // full-length blob.
    expect(rendered).not.toContain("x".repeat(ARGS_ROW_VALUE_MAX + 500));
    expect(rendered).toContain(`${"x".repeat(ARGS_ROW_VALUE_MAX)}…`);
  });

  test("postMessage failure denies the request without registering it", async () => {
    const { adapter } = fakeAdapter({ failPost: true });
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    await expect(router.request(REQUEST)).resolves.toEqual({ approved: false });
    expect(router.pendingCount).toBe(0);
  });
});

describe("approval prompt payload preview (issue #160)", () => {
  test("a create_work_item prompt shows the item's args in the posted message — the payload, not just the tool name", async () => {
    const { adapter, posted } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    void router.request({
      tool: "create_work_item",
      args: {
        title: "Fix the flaky login test",
        repo: "acme/sandbox",
        description: "The session cookie is never set on first load",
      },
      reason: "exec-tier tool requires human approval",
      spaceId: "slack:C1",
      actor: "agent",
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain("Approval required for create_work_item");
    expect(posted[0]!.text).toContain("Fix the flaky login test");
    expect(posted[0]!.text).toContain("The session cookie is never set on first load");
    expect(posted[0]!.text).toContain("acme/sandbox");
  });

  test("a prompt whose args carry a secret-shaped value redacts it in the posted message", async () => {
    const { adapter, posted } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    void router.request({ ...REQUEST, args: { api_key: "AKIA1234567890ABCDEF", command: "ls" } });

    expect(posted[0]!.text).toContain("[REDACTED]");
    expect(posted[0]!.text).not.toContain("AKIA1234567890ABCDEF");
    // Non-secret payload stays visible so the approval is still informed.
    expect(posted[0]!.text).toContain("ls");
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

    let resolved: "pending" | ApprovalResolution = "pending";
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
    expect(updated.some((u) => u.text?.includes("evicted") ?? false)).toBe(true);
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
  test("renders tool, reason, humanized {label, value} rows and both buttons carrying the id (issue #277)", () => {
    const blocks = buildApprovalBlocks(
      { ...REQUEST, args: { api_key: "AKIA1234567890ABCDEF", due_date: "2026-08-20", addTeams: ["a", "b"] } },
      "req-123",
    );
    const rendered = blocks
      .filter((b) => b.type === "section")
      .map((s) => s.text?.text ?? "")
      .join("\n");
    expect(rendered).toContain("create_work_item");
    expect(rendered).toContain(REQUEST.reason);
    // camelCase / snake_case keys become spaced title words.
    expect(rendered).toContain("*Api key:*");
    expect(rendered).toContain("*Due date:* 2026-08-20");
    expect(rendered).toContain("*Add teams:*");
    expect(rendered).toContain("[\"a\",\"b\"]");
    // Secret-shaped values are redacted, never shown verbatim.
    expect(rendered).toContain("[REDACTED]");
    expect(rendered).not.toContain("AKIA1234567890ABCDEF");
    const buttons = blocks
      .find((b) => b.type === "actions")
      ?.elements?.filter((e) => e.action_id !== undefined && e.value !== undefined);
    expect(buttons?.map((b) => b.value)).toEqual(["req-123", "req-123"]);
    expect(buttons?.map((b) => b.style)).toEqual(["primary", "danger"]);
  });

  test("empty values are elided from the card ('' / [] / {} / empty set)", () => {
    const blocks = buildApprovalBlocks(
      { ...REQUEST, args: { title: "keep me", empty: "", none: [], obj: {}, set: new Set(), keep: "also" } },
      "req-123",
    );
    const rendered = blocks
      .filter((b) => b.type === "section")
      .map((s) => s.text?.text ?? "")
      .join("\n");
    expect(rendered).toContain("*Title:* keep me");
    expect(rendered).toContain("*Keep:* also");
    // Empty values never render a row.
    expect(rendered).not.toContain("Empty:");
    expect(rendered).not.toContain("None:");
    expect(rendered).not.toContain("Obj:");
    expect(rendered).not.toContain("Set:");
  });

  test("more than ARGS_ROW_MAX fields render a '… and N more fields' note", () => {
    const args: Record<string, string> = {};
    for (let i = 0; i < 15; i += 1) args[`field_${i}`] = `v${i}`;
    const blocks = buildApprovalBlocks({ ...REQUEST, args }, "req-123");
    const rendered = blocks
      .filter((b) => b.type === "section")
      .map((s) => s.text?.text ?? "")
      .join("\n");
    expect(rendered).toContain("… and 3 more fields");
  });

  test("a remembered confirmed-write failure is surfaced on the card (issue #277)", () => {
    const blocks = buildApprovalBlocks(REQUEST, "req-123", "write-blob: disk full");
    const rendered = blocks
      .filter((b) => b.type === "section")
      .map((s) => s.text?.text ?? "")
      .join("\n");
    expect(rendered).toContain("*Last confirmed write failed:* write-blob: disk full");
  });

  test("dense rows and a long failure sticker stay under Slack's section text cap (issue #277)", () => {
    // A payload pushing max-size values in many rows would, uncapped, blow
    // past Slack's 3000-char section limit and reject the whole card (the
    // approval would then auto-deny). The rendered sections must stay bounded.
    const args: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) args[`field_${i}`] = "x".repeat(ARGS_ROW_VALUE_MAX);
    const blocks = buildApprovalBlocks({ ...REQUEST, args }, "req-123", "y".repeat(10_000));

    const sectionTexts = blocks
      .filter((b) => b.type === "section")
      .map((s) => (s.text?.text ?? "").length);

    expect(sectionTexts.length).toBeGreaterThan(0);
    // Every section stays within Slack's limit; the row budget also never
    // climbs past its own, smaller cap.
    expect(Math.max(...sectionTexts)).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX);
    expect(Math.max(...sectionTexts)).toBeLessThan(ARGS_SECTION_TEXT_MAX + 64);

    // And the failure banner reason was truncated, not echoed in full.
    const rendered = blocks
      .filter((b) => b.type === "section")
      .map((s) => s.text?.text ?? "")
      .join("\n");
    expect(rendered).toContain("*Last confirmed write failed:*");
    const ys = (rendered.match(/y/g) ?? []).length;
    expect(ys).toBeGreaterThan(0);
    expect(ys).toBeLessThan(10_000); // the 10k 'y' reason was truncated, not echoed in full
  });

  test("an empty args payload omits the would-be-write section", () => {
    const blocks = buildApprovalBlocks({ ...REQUEST, args: {} }, "req-123");
    const rendered = blocks
      .filter((b) => b.type === "section")
      .map((s) => s.text?.text ?? "")
      .join("\n");
    expect(rendered).not.toContain("Would-be write");
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

  /** Fields on approval.resolved audit payloads that these tests read. */
  interface ApprovalAuditPayload {
    tool?: string;
    approved?: boolean;
    approver?: string;
  }

  function makeGate(router: ApprovalRouter): (tool: string, input?: Record<string, string>) => Promise<ToolCallEventResult | void> {
    const handlers = new Map<string, ToolCallHandler>();
    // SAFETY: createPolicyExtension registers tool handlers through pi.on only;
    // the double implements exactly that surface and the extension never reads
    // the rest of ExtensionAPI during registration.
    const pi = { on: (event: "tool_call", h: ToolCallHandler) => void handlers.set(event, h) } as ExtensionAPI;
    createPolicyExtension({
      orgPolicy: parseOrgConfigYaml("tools:\n  bash: allow\n  create_work_item: allow\n"),
      audit,
      router,
      store,
    })(pi);
    return async (tool, input = {}) => {
      // SAFETY: the gate handler only reads sessionManager.getSessionFile() on
      // this path; the double provides it and nothing else is touched.
      const ctx = { sessionManager: { getSessionFile: () => join("/tmp/sessions", `${space.id}.jsonl`) } } as ExtensionContext;
      const handler = handlers.get("tool_call")!;
      // SAFETY: the literal carries the type/toolCallId/toolName/input fields
      // the policy extension reads; the union's per-toolName input narrowing
      // cannot be composed statically from a string tool name.
      return handler({ type: "tool_call", toolCallId: "tc1", toolName: tool, input } as ToolCallEvent, ctx);
    };
  }

  async function resolvedAuditRows() {
    const rows = await audit.listAudit({ event_type: "approval.resolved" });
    // SAFETY: approval.resolved payloads are flat JSON objects carrying the
    // tool/approved/approver fields these tests read.
    return rows.map((r) => JSON.parse(r.payload) as ApprovalAuditPayload);
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

    if (result !== undefined && result !== null) {
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

    if (result !== undefined && result !== null) {
      expect(result.block).toBe(true);
    } else {
      expect.unreachable("expected a block result");
    }
    expect(updated.some((u) => u.text?.includes("expired") ?? false)).toBe(true);
    const resolved = await resolvedAuditRows();
    expect(resolved.at(-1)).toMatchObject({ tool: "bash", approved: false });
  });

  test("a confirmed write that fails posts the failure to the thread and a later card surfaces it (issue #277)", async () => {
    const postedSignal = Promise.withResolvers<void>();
    const steps: Array<{ spaceId?: string; taskId: string; title: string; status: string; output?: string }> = [];
    const { adapter, posted } = fakeAdapter({ onPosted: () => postedSignal.resolve() });
    const router = new SlackApprovalRouter({
      adapter,
      timeoutMs: 60_000,
      // The presenter/step seam: a confirmed write that fails posts through
      // the SAME sink tool steps use — never a parallel messaging API.
      onToolStep: (step) => steps.push(step),
    });
    const gate = makeGate(router);

    // A write-tier tool is approved by a human…
    const pending = gate("create_work_item", { title: "x" });
    await postedSignal.promise;
    const id = requestIdFrom(posted);
    await router.handleAction(click(APPROVE_ACTION_ID, id, { principal: "U42" }));
    await pending;

    // …then its execution fails: the caller reports the failure to the router.
    router.recordConfirmedWriteFailure("slack:C1", "create_work_item", "duplicate work item");

    // The failure is posted back through the step emit seam as a VALID step
    // lifecycle — opened in_progress then completed, sharing one taskId — so
    // the phrase/stream renderer surfaces a visible failure instead of
    // swallowing an orphaned complete card (issue #277).
    const failureSteps = steps.filter((s) => s.title.includes("confirmed write failed"));
    expect(failureSteps).toHaveLength(2);
    expect(failureSteps.map((s) => s.status)).toEqual(["in_progress", "complete"]);
    // Shared taskId: the complete checks off the card the in_progress opened.
    expect(failureSteps[0].taskId).toBe(failureSteps[1].taskId);
    expect(failureSteps[0].spaceId).toBe("slack:C1");
    for (const s of failureSteps) expect(s.output).toContain("duplicate work item");

    // A later approval card for the same tool surfaces the remembered failure.
    void router.request({ ...REQUEST, args: { title: "y" } });
    // Await the second post landing (the fake posts synchronously in postMessage).
    for (let i = 0; i < 20 && posted.length < 2; i += 1) {
      await Promise.resolve();
    }
    expect(posted).toHaveLength(2);
    const rendered = (posted[1]?.blocks ?? [])
      .filter((b) => b.type === "section")
      .map((s) => s.text?.text ?? "")
      .join("\n");
    expect(rendered).toContain("*Last confirmed write failed:* duplicate work item");
  });

  test("the confirmed-write-failure memory is bounded and evicts the oldest (issue #277)", async () => {
    const { adapter } = fakeAdapter();
    const router = new SlackApprovalRouter({ adapter, timeoutMs: 60_000 });

    // Record one failure per distinct tool, past the cap.
    for (let i = 0; i < FAILURE_MEMORY_MAX + 20; i += 1) {
      router.recordConfirmedWriteFailure("slack:C1", `tool_${i}`, `boom ${i}`);
    }
    expect(router.failureMemorySize).toBeLessThanOrEqual(FAILURE_MEMORY_MAX);
    // The NEWEST failure is still remembered…
    expect(router.lastConfirmedWriteFailure("slack:C1", `tool_${FAILURE_MEMORY_MAX + 19}`)).toBe(`boom ${FAILURE_MEMORY_MAX + 19}`);
    // …and the OLDEST (tool_0) was evicted.
    expect(router.lastConfirmedWriteFailure("slack:C1", "tool_0")).toBeUndefined();
  });
});

describe("SlackApprovalRouter wiring invariants", () => {
  test("router satisfies the ApprovalRouter request contract", () => {
    const { adapter } = fakeAdapter();
    const router: ApprovalRouter = new SlackApprovalRouter({ adapter });
    expect(router.request).toEqual(expect.any(Function));
    // SAFETY: handleAction is not part of the ApprovalRouter contract; the
    // concrete SlackApprovalRouter instance exposes it for the router wiring.
    expect((router as SlackApprovalRouter).handleAction).toEqual(expect.any(Function));
  });
});
