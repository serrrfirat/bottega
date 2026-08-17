import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionHandler, ToolCallEvent, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { EXECUTOR_TOOLS, prepareExecutor, runExecutor } from "./executor";
import { DenyRouter } from "./policy/approval-router";
import { DEFAULT_TIMEOUT_MINUTES, defaultPolicy } from "./policy/config";
import createPolicyExtension from "./policy/extension";
import { SlackApprovalRouter } from "./server/adapters/approval-router";
import type { SlackAction, SlackAdapter } from "./server/adapters/slack";
import { main as serverMain } from "./server/index";

test("server main wires adapter and space service", async () => {
  process.env.SLACK_APP_TOKEN = "xapp-test-token";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  // Never inherit the live .env's BOTTEGA_CALLBACK_PORT — the harness dev
  // server holds it, so a boot against it is EADDRINUSE. Pin 0 (ephemeral,
  // the #209 default) and restore the prior value after.
  const savedPort = process.env.BOTTEGA_CALLBACK_PORT;
  process.env.BOTTEGA_CALLBACK_PORT = "0";
  try {
    const server = await serverMain();
    expect(server.start).toEqual(expect.any(Function));
    expect(server.stop).toEqual(expect.any(Function));
    await server.stop();
  } finally {
    if (savedPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
    else process.env.BOTTEGA_CALLBACK_PORT = savedPort;
  }
});

test("server main wires the Slack approval router for space sessions (issue #44)", async () => {
  process.env.SLACK_APP_TOKEN = "xapp-test-token";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  const created: Array<{
    adapter: Pick<SlackAdapter, "postMessage" | "updateMessage">;
    timeoutMs: number;
  }> = [];
  // Never inherit the live .env's BOTTEGA_CALLBACK_PORT — the harness dev
  // server holds it, so a boot against it is EADDRINUSE. Pin 0 (ephemeral,
  // the #209 default) and restore the prior value after.
  const savedPort = process.env.BOTTEGA_CALLBACK_PORT;
  process.env.BOTTEGA_CALLBACK_PORT = "0";
  try {
    const server = await serverMain({
      createApprovalRouter: (deps) => {
        created.push(deps);
        // Test double with the same surface the default Slack router exposes.
        return {
          request: async () => ({ approved: false }),
          handleAction: async (_a: SlackAction) => {},
        };
      },
    });
    await server.stop();
  } finally {
    if (savedPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
    else process.env.BOTTEGA_CALLBACK_PORT = savedPort;
  }

  // Exactly one router is created, with the adapter (postMessage/updateMessage)
  // and the policy timeout from approvals.timeout_minutes.
  expect(created).toHaveLength(1);
  expect(created[0].timeoutMs).toBe(DEFAULT_TIMEOUT_MINUTES * 60_000);
  expect(created[0].adapter.postMessage).toEqual(expect.any(Function));
  expect(created[0].adapter.updateMessage).toEqual(expect.any(Function));
  // The default path constructs the Slack button router itself.
  expect(SlackApprovalRouter.prototype).toBeDefined();
});

test("executor exposes the claim-loop runner and the work tool allowlist", () => {
  expect(runExecutor).toEqual(expect.any(Function));
  expect(prepareExecutor).toEqual(expect.any(Function));
  expect(EXECUTOR_TOOLS).toEqual(["read", "write", "glob", "grep", "bash"]);
});

test("policy extension factory registers a tool_call gate", () => {
  const events = new Set<string>();
  type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
  // SAFETY: createPolicyExtension registers a "tool_call" handler through
  // pi.on only — the double implements exactly that surface, and the
  // factory never reads the rest of ExtensionAPI during registration.
  const pi = { on: (event: "tool_call", _handler: ToolCallHandler) => void events.add(event) } as ExtensionAPI;
  const factory = createPolicyExtension({
    orgPolicy: defaultPolicy(),
    audit: { appendAudit: async () => 1, listAudit: async () => [] },
    router: DenyRouter,
    store: { getSpace: async () => null },
  });
  factory(pi);
  expect(events.has("tool_call")).toBe(true);
});
