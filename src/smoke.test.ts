import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
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
  const server = serverMain();
  expect(typeof server.start).toBe("function");
  expect(typeof server.stop).toBe("function");
  await server.stop();
});

test("server main wires the Slack approval router for space sessions (issue #44)", async () => {
  process.env.SLACK_APP_TOKEN = "xapp-test-token";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  const created: Array<{
    adapter: Pick<SlackAdapter, "postMessage" | "updateMessage">;
    timeoutMs: number;
  }> = [];
  const server = serverMain({
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

  // Exactly one router is created, with the adapter (postMessage/updateMessage)
  // and the policy timeout from approvals.timeout_minutes.
  expect(created).toHaveLength(1);
  expect(created[0].timeoutMs).toBe(DEFAULT_TIMEOUT_MINUTES * 60_000);
  expect(typeof created[0].adapter.postMessage).toBe("function");
  expect(typeof created[0].adapter.updateMessage).toBe("function");
  // The default path constructs the Slack button router itself.
  expect(SlackApprovalRouter.prototype).toBeDefined();
});

test("executor exposes the claim-loop runner and the work tool allowlist", () => {
  expect(typeof runExecutor).toBe("function");
  expect(typeof prepareExecutor).toBe("function");
  expect(EXECUTOR_TOOLS).toEqual(["read", "write", "glob", "grep", "bash"]);
});

test("policy extension factory registers a tool_call gate", () => {
  const events = new Set<string>();
  // Test double: only the registration surface is exercised here.
  const pi = { on: (event: string) => events.add(event) } as unknown as ExtensionAPI;
  const factory = createPolicyExtension({
    orgPolicy: defaultPolicy(),
    audit: { appendAudit: async () => 1, listAudit: async () => [] },
    router: DenyRouter,
    store: { getSpace: async () => null },
  });
  factory(pi);
  expect(events.has("tool_call")).toBe(true);
});
