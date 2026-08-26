/**
 * Headless lane (issue #360): the REAL bottega stack driven through the
 * normalized inbound seam with NO Slack anywhere.
 *
 * `bootHarness({ headless: true })` swaps the Slack boundary (emulator +
 * Bolt app + tokens, or the live Socket Mode adapter) for a fake in-process
 * SlackAdapter:
 *   - inbound  → deliverMessage/deliverAction call the REAL
 *                spaceService.handleInboundMessage / ApprovalRouter handler
 *                directly (the same production seams the Slack adapter
 *                invokes after normalization) — no Slack event, no socket.
 *   - outbound → the fake adapter records postMessage/updateMessage in
 *                memory, read via harness.messages().
 *
 * Everything else is the production stack: real SQLite store + audit,
 * real policy gate, real OMP SDK driver against the model stub, real
 * memory provider, real work-item tools. The point of this suite is to
 * prove the whole conversation functionality is reachable as a separate,
 * Slack-free lane — the API-shaped surface that runs headlessly.
 */
import { describe, expect, test } from "bun:test";
import { bootHarness, type Harness, type StubTurn } from "./harness";
import { workItemsExtension } from "../../src/tools/work-items";
import { parseOrgConfigYaml } from "../../src/policy/config";
import type { ToolDefinition, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Store } from "../../src/store/db";

/** Polls a predicate until truthy (assert pattern for async effects). */
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

/** create_work_item tool definitions for the headless work-item journey. */
function workItemCustomTools(orgConfigYaml: string): {
  customTools: ToolDefinition[];
  bindStore(store: Store): void;
} {
  const orgPolicy = parseOrgConfigYaml(orgConfigYaml);
  let storeRef: Store | null = null;
  const storeProxy = new Proxy({} as Store, {
    get: (_target, prop: PropertyKey) => {
      if (storeRef === null) throw new Error("work item tools used before the harness store was bound");
      return (storeRef as unknown as Record<PropertyKey, unknown>)[prop];
    },
  }) as Store;
  const defs: ToolDefinition[] = [];
  workItemsExtension(storeProxy, { orgPolicy })({
    registerTool: (t: ToolDefinition) => void defs.push(t),
  } as unknown as ExtensionAPI);
  return {
    customTools: defs.map((def) => ({ ...def, __isToolDefinition: true }) as unknown as ToolDefinition),
    bindStore(store: Store) {
      storeRef = store;
    },
  };
}

const WORK_ITEM_CONFIG = [
  "tools:",
  "  create_work_item: allow",
  "  memory.save: allow",
  "approvals:",
  "  always_approve:",
  "    - create_work_item",
  "",
].join("\n");

/** Resolves the first open work item for a space via the real audit trail. */
async function findOpenItem(h: Harness, spaceId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await h.store.listAudit({ space: spaceId, event_type: "work_item.created" });
    const ids = rows.map((r) => (JSON.parse(r.payload) as { id: string }).id);
    for (const id of ids) {
      const item = await h.store.getWorkItem(id);
      if (item) return item;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the work item to be created");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

describe("headless lane (issue #360): no Slack surface", () => {
  test("boots with zero Slack: no Bolt app, no emulator, no tokens", async () => {
    const h = await bootHarness({
      headless: true,
      modelTurns: [{ type: "text", text: "ok" }],
    });
    try {
      // The in-process fake adapter has no network address.
      expect(h.slack.baseUrl).toBe("");
      // No Bolt app was ever constructed — the lane is Slack-free by
      // construction, not merely unused.
      expect(h.app).toBeUndefined();
      // The harness adapter is the headless fake (implements SlackAdapter).
      expect(typeof h.adapter.postMessage).toBe("function");
      expect(h.adapter).not.toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  test("refuses headless combined with realSlack (mutually exclusive modes)", async () => {
    await expect(
      bootHarness({ headless: true, realSlack: true, slackTokens: undefined as never }),
    ).rejects.toThrow(/mutually exclusive/);
  });
});

describe("headless lane (issue #360): conversation functionality via the API seam", () => {
  test("message → real space agent → memory.save tool call → reply captured, no Slack", async () => {
    const turns: StubTurn[] = [
      {
        type: "tool_calls",
        calls: [{ name: "memory_save", args: { scope: "org", content: "the build runs with bun test" } }],
      },
      { type: "text", text: "saved it" },
    ];
    const h = await bootHarness({
      headless: true,
      orgConfigYaml: "tools:\n  memory.save: allow\n",
      modelTurns: turns,
    });
    try {
      const dm = h.slack.dmChannelId;
      // The space-id prefix stays Slack-shaped (space-id derivation reads
      // it), but the message never touches a Slack API.
      await h.deliverMessage(dm, "remember: the build runs with bun test");
      await h.modelStub.waitForRequests(2);

      // The tool call executed through the real provider + policy gate.
      const found = await h.memory.search({ query: "build", scope: { kind: "org" } });
      expect(found.map((e) => e.content)).toContain("the build runs with bun test");
      const audit = await h.audit.listAudit({});
      expect(audit.filter((r) => r.event_type === "policy.decision").length).toBeGreaterThanOrEqual(1);
      expect(audit.filter((r) => r.event_type === "memory.write").length).toBeGreaterThanOrEqual(1);

      // The outbound reply was captured by the headless fake adapter.
      const reply = await waitFor(() => h.messages(dm).find((m) => m.text === "saved it"));
      expect(reply).toBeDefined();
      // The reply principal is the headless bot identity, not a Slack id.
      expect(reply!.user).toBe("U-headless-bot");
    } finally {
      await h.cleanup();
    }
  });

  test("message → create_work_item → item in the real store; approval action resolves headlessly", async () => {
    const turns: StubTurn[] = [
      {
        type: "tool_calls",
        calls: [{ name: "create_work_item", args: { description: "fix the flaky checkout" } }],
      },
      { type: "text", text: "created the work item" },
    ];
    let resolved: { approved: boolean; approver?: string } | undefined;
    const router = {
      // ask-human tool calls auto-approve so the journey flows; the action
      // resolution below is the headless approval-click equivalent.
      async request() {
        return { approved: true, approver: "U-headless-human" };
      },
      async handleAction(a: { actionId: string; value: string; principal: string }) {
        // In the emulator lane this is a Slack block-action click; headless
        // it is the same resolution path driven directly by deliverAction.
        resolved = { approved: true, approver: a.principal };
      },
    };
    const tools = workItemCustomTools(WORK_ITEM_CONFIG);
    const h = await bootHarness({
      headless: true,
      orgConfigYaml: WORK_ITEM_CONFIG,
      modelTurns: turns,
      customTools: tools.customTools,
      approve: router,
    });
    tools.bindStore(h.store);
    try {
      const dm = h.slack.dmChannelId;
      await h.deliverMessage(dm, "fix the flaky checkout");
      await h.modelStub.waitForRequests(2);

      const item = await findOpenItem(h, `slack:${dm}`);
      expect(item.state).toBe("open");

      // Deliver an approval action through the headless seam; the router's
      // handleAction is invoked directly (no Bolt button click).
      await h.deliverAction({ actionId: "bottega_approve", value: item.id, channelId: dm, messageTs: "1.1" });
      expect(resolved).toEqual({ approved: true, approver: "U-headless-human" });

      const reply = await waitFor(() => h.messages(dm).find((m) => m.text === "created the work item"));
      expect(reply).toBeDefined();
    } finally {
      await h.cleanup();
    }
  });
});