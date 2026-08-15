import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { run as executorRun } from "./executor";
import { DenyRouter } from "./policy/approval-router";
import { defaultPolicy } from "./policy/config";
import createPolicyExtension from "./policy/extension";
import { main as serverMain } from "./server/index";

test("server main wires adapter and space service", async () => {
  process.env.SLACK_APP_TOKEN = "xapp-test-token";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  const server = serverMain();
  expect(typeof server.start).toBe("function");
  expect(typeof server.stop).toBe("function");
  await server.stop();
});

test("executor stub runs", () => {
  expect(executorRun()).toBeUndefined();
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
