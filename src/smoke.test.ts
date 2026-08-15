import { expect, test } from "bun:test";
import { run as executorRun } from "./executor";
import { createExtension } from "./policy/extension";
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

test("extension factory returns the extension", () => {
  expect(createExtension()).toEqual({ name: "bottega" });
});
