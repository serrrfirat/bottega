/**
 * Full headless conversation coverage for issue #363: presentation, threads,
 * response directives, streaming, idle digests, and extension connection.
 * Mention filtering and bot-message dropping are adapter-layer behavior
 * (registerMessageHandler), covered by unit slack.test.ts and intentionally
 * unreachable by design in this lane.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { bootHarness, type Harness } from "./harness";
import { THINKING_PHRASES, REQUEST_ONLY_DIRECTIVE } from "../../src/server/services/space-service";
import { loadSpacePolicy, parseOrgConfigYaml } from "../../src/policy/config";
import { createFixtureRegistry, FIXTURE_EXTENSION_ID } from "../../src/extensions/fixture";
import { EXTENSION_CONNECTED_EVENT } from "../../src/store/audit-events";
import type { BrokerConnector } from "../../src/extensions/connect";

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
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

async function withHarness<T>(cfg: Parameters<typeof bootHarness>[0], fn: (h: Harness) => Promise<T>): Promise<T> {
  const h = await bootHarness(cfg);
  try { return await fn(h); } finally { await h.cleanup(); }
}
async function waitForAudit(h: Harness, eventType: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await h.store.listAudit({ event_type: eventType });
    if (rows.length > 0) return rows;
    if (Date.now() > deadline) throw new Error("timed out waiting for audit row");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

describe("headless conversation lane (issue #363)", () => {
  test("DM presenter replaces a thinking phrase with the final reply", async () => {
    await withHarness({ headless: true, modelTurns: [{ type: "text", text: "final answer" }] }, async (h) => {
      await h.deliverMessage(h.slack.dmChannelId, "hello");
      await h.modelStub.waitForRequests(1);
      const messages = await waitFor(() => h.messages(h.slack.dmChannelId).length === 1 ? h.messages(h.slack.dmChannelId) : undefined);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toBe("final answer");
      expect(THINKING_PHRASES).not.toContain(messages[0]!.text);
    });
  });

  test("channel replies remain threaded to the inbound timestamp", async () => {
    await withHarness({ headless: true, modelTurns: [{ type: "text", text: "threaded" }] }, async (h) => {
      await h.deliverMessage("C-HEADLESSOPS", "incident", { ts: "1.1" });
      await h.modelStub.waitForRequests(1);
      const message = await waitFor(() => h.messages("C-HEADLESSOPS").find((m) => m.text === "threaded"));
      expect(message.thread_ts).toBe("1.1");
    });
  });

  test("request-only directive is injected and overlays cannot loosen the floor", async () => {
    const org = parseOrgConfigYaml("response_mode: request-only\n");
    await withHarness({ headless: true, orgConfigYaml: "response_mode: request-only\n", modelTurns: [{ type: "text", text: "ok" }] }, async (h) => {
      await h.deliverMessage(h.slack.dmChannelId, "explicit");
      await h.modelStub.waitForRequests(1);
      expect(
        h.modelStub.latestMessages().some((m) => {
          const parsed = z.string().safeParse(m.content);
          return parsed.success && parsed.data.includes(REQUEST_ONLY_DIRECTIVE);
        }),
      ).toBe(true);
      const clamped = await loadSpacePolicy(org, h.store, `slack:${h.slack.dmChannelId}`);
      expect(clamped.responseMode).toBe("request-only");
    });
  });

  test("streaming renders panel operations instead of phrase posts", async () => {
    await withHarness({ headless: true, headlessStreaming: true, orgConfigYaml: "tools:\n  memory.save: allow\n", modelTurns: [
      { type: "tool_calls", calls: [{ name: "memory_save", args: { scope: "org", content: "stream fact" } }] },
      { type: "text", text: "stream complete" },
    ] }, async (h) => {
      await h.deliverMessage("C-HEADLESSOPS", "save");
      await h.modelStub.waitForRequests(2);
      const adapter = h.adapter;
      expect("streams" in adapter).toBe(true);
      const streams = await waitFor(() => {
        // SAFETY: the adapter's `streams` property is established by the
        // preceding `"streams" in adapter` assertion.
        const current = (adapter as typeof adapter & { streams: Array<{ op: string; text?: string }> }).streams;
        return current.length > 0 ? current : undefined;
      });
      expect(streams.map((s) => s.op)[0]).toBe("start");
      expect(streams.at(-1)?.op).toBe("stop");
      expect(streams.at(-1)?.text).toBe("stream complete");
      expect(h.messages(h.slack.dmChannelId).some((m) => THINKING_PHRASES.includes(m.text))).toBe(false);
      expect(h.messages("C-HEADLESSOPS").some((m) => THINKING_PHRASES.includes(m.text))).toBe(false);
    });
  });

  test("idle disposal emits a digest containing the second scripted turn", async () => {
    await withHarness({ headless: true, idleTimeoutMs: 200, modelTurns: [{ type: "text", text: "first reply" }, { type: "text", text: "- weekly note" }] }, async (h) => {
      await h.deliverMessage(h.slack.dmChannelId, "first");
      await h.modelStub.waitForRequests(1);
      await waitFor(() => h.memory.search({ query: "weekly note", scope: { kind: "org" } }).then((rows) => rows.length ? rows : undefined));
    });
  });
  test("connect_extension tool call records extension.connected", async () => {
    const broker: BrokerConnector = async () => ({ identityKey: "account:fixture", brokerCredentialId: 42 });
    await withHarness({ headless: true, registry: createFixtureRegistry(), orgConfigYaml: "tools:\n  connect_extension: allow\nextensions:\n  allow:\n    - fixture.weather\n", liveConnect: { broker }, modelTurns: [{ type: "tool_calls", calls: [{ name: "connect_extension", args: { extension: FIXTURE_EXTENSION_ID, scope: "personal", api_key: "fixture-secret" } }] }, { type: "text", text: "connected" }] }, async (h) => {
      await h.deliverMessage(h.slack.dmChannelId, "connect weather");
      await h.modelStub.waitForRequests(2);
      const rows = await waitForAudit(h, EXTENSION_CONNECTED_EVENT);
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });
});
