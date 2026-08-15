import { expect, test } from "bun:test";
import { run as executorRun } from "./executor";
import { createExtension } from "./policy/extension";
import { main as serverMain } from "./server";

test("server stub boots and stops", () => {
  const server = serverMain();
  expect(server.port).toBeGreaterThan(0);
  server.stop();
});

test("executor stub runs", () => {
  expect(executorRun()).toBeUndefined();
});

test("extension factory returns the extension", () => {
  expect(createExtension()).toEqual({ name: "bottega" });
});
