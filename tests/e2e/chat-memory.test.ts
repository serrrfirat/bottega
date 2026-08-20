/**
 * E2E journey 1 (issue #66): chat + memory over the real stack.
 *
 * Covers, in order: DM → thinking phrase posted → answer replaces it in
 * place (stub model text) → scripted memory.save → memory.search tool calls
 * round-trip through the real policy gate + SQLite provider → turn-start
 * memory injection includes a seeded org entry → digest-on-idle on session
 * dispose → response mode `mention` drops unmentioned channel chatter
 * without ever cold-starting a session.
 *
 * Every leg drives the REAL components from tests/e2e/harness.ts — only the
 * model, Slack, and the filesystem are emulated.
 */
import { describe, expect, test } from "bun:test";
import { THINKING_PHRASES } from "../../src/server/services/space-service";
import { bootHarness, type StubTurn } from "./harness";

/** Polls `fn` until it returns a truthy value; fails the test on timeout. */
async function waitFor<T>(fn: () => T | undefined | null | Promise<T | undefined | null>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(20);
  }
}

describe("e2e journey 1: chat + memory", () => {
  test(
    "a DM turn posts a thinking phrase and replaces it in place with the model reply",
    async () => {
      const h = await bootHarness({ modelTurns: [{ type: "text", text: "the answer is 42" }] });
      try {
        // The turn runs inside deliverMessage; poll for the phrase while it
        // is in flight (it lives from turn_start until the reply lands).
        const pending = h.deliverMessage(h.slack.dmChannelId, "hello bot");
        const phrase = await waitFor(() => h.messages(h.slack.dmChannelId).find((m) => THINKING_PHRASES.includes(m.text)));
        expect(phrase).toBeDefined();
        await pending;

        // The reply replaced the phrase in place: exactly one message row
        // in the DM, its text the final answer (chat.update mutates, never
        // a second post).
        const reply = await waitFor(() => {
          const msgs = h.messages(h.slack.dmChannelId);
          return msgs.length === 1 && msgs[0]!.text === "the answer is 42" ? msgs[0] : undefined;
        });
        expect(reply.text).toBe("the answer is 42");
        expect(h.messages(h.slack.dmChannelId)).toHaveLength(1);
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "scripted memory.save and memory.search tool calls round-trip through the real gate and SQLite provider",
    async () => {
      const turns: StubTurn[] = [
        {
          type: "tool_calls",
          // Session-facing names are flattened (issue #78): the opencode-go
          // gateway 400s dotted tool names, so the driver registers
          // gateway-safe names and the gate/audit keep the canonical ones.
          calls: [{ name: "memory_save", args: { scope: "org", content: "the build runs with bun test" } }],
        },
        {
          type: "tool_calls",
          calls: [{ name: "memory_search", args: { scope: "org", query: "build" } }],
        },
        { type: "text", text: "saved and found" },
      ];
      const h = await bootHarness({
        // Fail-closed default policy denies unlisted tools; the gate is
        // live on the custom-tools bridge (issue #69), so the journey
        // explicitly allows the memory tools it scripts.
        orgConfigYaml: "tools:\n  memory.save: allow\n  memory.search: allow\n",
        modelTurns: turns,
      });
      try {
        await h.deliverMessage(h.slack.dmChannelId, "remember: the build runs with bun test");
        // Request 1 = save call, 2 = search call, 3 = final text.
        await h.modelStub.waitForRequests(3);

        const found = await h.memory.search({ query: "build", scope: { kind: "org" } });
        expect(found.map((e) => e.content)).toContain("the build runs with bun test");

        // The tool calls executed through the real provider and were
        // audited with a content hash, never the content. The policy gate
        // rides the driver's custom-tools bridge (issue #69), so every
        // call also wrote a `policy.decision` row.
        const audit = await h.audit.listAudit({});
        expect(audit.filter((r) => r.event_type === "policy.decision").length).toBeGreaterThanOrEqual(2);
        expect(audit.filter((r) => r.event_type === "memory.write").length).toBeGreaterThanOrEqual(1);
        const writeRow = audit.find((r) => r.event_type === "memory.write")!;
        expect(writeRow.payload).not.toContain("bun test");

        const reply = await waitFor(() => h.messages(h.slack.dmChannelId).find((m) => m.text === "saved and found"));
        expect(reply).toBeDefined();
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "turn-start injection includes a seeded org memory entry",
    async () => {
      const h = await bootHarness({ modelTurns: [{ type: "text", text: "injected" }] });
      try {
        // Org memories flagged `inject` ride the cold start (the first
        // turn's start) into the model's context via the driver's
        // appendSystemPrompt seam; the harness lists them through the real
        // provider and renders with the extension's own renderer.
        await h.memory.save({ scope: { kind: "org" }, content: "the team deploys on Tuesdays", metadata: { inject: "1" } });
        await h.deliverMessage(h.slack.dmChannelId, "deploy");
        await h.modelStub.waitForRequests(1);

        const messages = h.modelStub.latestMessages();
        // String(x) === x holds exactly when x is a string — the memory
        // injection rides the system prompt's text content, so only a
        // string-content system message qualifies.
        const system = messages.find((m) => m.role === "system" && String(m.content) === m.content);
        expect(system).toBeDefined();
        expect(String(system!.content)).toContain("Relevant memory:");
        expect(String(system!.content)).toContain("the team deploys on Tuesdays");
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "digest-on-idle summarizes the conversation into org memory on dispose; the next message cold-starts",
    async () => {
      const h = await bootHarness({
        idleTimeoutMs: 500,
        modelTurns: [
          { type: "text", text: "first reply" },
          { type: "text", text: "- digest summary of the conversation" },
        ],
      });
      const spaceId = `slack:${h.slack.dmChannelId}`;
      try {
        await h.deliverMessage(h.slack.dmChannelId, "hello");
        await h.modelStub.waitForRequests(1);
        expect(h.messages(h.slack.dmChannelId).length).toBe(1); // phrase replaced by "first reply"

        // Idle timer fires → dispose runs a silent summary turn (request 2)
        // and saves it as an org digest memory.
        await h.modelStub.waitForRequests(2, 10_000);
        const digests = await waitFor(async () => {
          const entries = await h.memory.search({
            query: "",
            scope: { kind: "org" },
            metadata: { kind: "digest", space: spaceId },
          });
          return entries.length > 0 ? entries : undefined;
        });
        expect(digests[0]!.content).toBe("- digest summary of the conversation");
        expect(digests[0]!.metadata.until).toBeTruthy();
        // The digest turn was silent: no extra channel message appeared.
        expect(h.messages(h.slack.dmChannelId).length).toBe(1);

        // Let the dispose settle, then a new message cold-starts a fresh
        // session (request 3) and replies normally.
        await Bun.sleep(100);
        await h.deliverMessage(h.slack.dmChannelId, "again");
        await h.modelStub.waitForRequests(3);
        const reply = await waitFor(() => h.messages(h.slack.dmChannelId).find((m) => m.text === "first reply"));
        expect(reply).toBeDefined();
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "mention response mode drops unmentioned channel chatter without a turn; mentions get replies",
    async () => {
      const h = await bootHarness({
        modelTurns: [{ type: "text", text: "hello channel" }],
        spacePolicy: { ops: JSON.stringify({ response_mode: "mention" }) },
      });
      const ops = h.slack.channelId("ops")!;
      try {
        // Unmentioned channel message: dropped before any session work — no
        // model request, nothing posted.
        await h.deliverMessage(ops, "good morning everyone");
        expect(h.modelStub.requests).toHaveLength(0);
        expect(h.messages(ops)).toHaveLength(0);

        // Mentioned message drives a real turn; the reply threads under it.
        await h.deliverMessage(ops, `<@${h.slack.user("bottega")}> hello`);
        await h.modelStub.waitForRequests(1);
        const reply = await waitFor(() => h.messages(ops).find((m) => m.text === "hello channel"));
        expect(reply).toBeDefined();
        expect(reply!.thread_ts).toBeTruthy();
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "outbound adapter assertions resolve through the emulator store (typed helper contract)",
    async () => {
      const h = await bootHarness({ modelTurns: [{ type: "text", text: "hi" }] });
      try {
        await h.deliverMessage(h.slack.dmChannelId, "ping");
        await h.modelStub.waitForRequests(1);
        // The reply update lands a beat after the turn; poll for the
        // replaced-in-place message.
        const reply = await waitFor(() => h.messages(h.slack.dmChannelId).find((m) => m.text === "hi"));
        expect(reply).toBeDefined();
        expect(h.messages(h.slack.dmChannelId)).toHaveLength(1);
        expect(h.messages("C-NOPE")).toHaveLength(0);
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );
});

describe("e2e harness contract (issue #66)", () => {
  test("bootHarness exposes the typed parts and cleans up idempotently", async () => {
    const h = await bootHarness();
    try {
      expect(h.store).toBeDefined();
      expect(h.audit).toBeDefined();
      expect(h.memory).toBeDefined();
      expect(h.driver).toBeDefined();
      expect(h.spaceService).toBeDefined();
      expect(h.adapter).toBeDefined();
      expect(h.app).toBeDefined();
      expect(h.modelStub.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      expect(h.slack.dmChannelId).toMatch(/^D/);
      expect(h.slack.channelId("ops")).toBeTruthy();
      expect(h.slack.user("owner")).toBeTruthy();
      expect(h.extensionRegistry.list().length).toBeGreaterThan(0);
    } finally {
      await h.cleanup();
      await h.cleanup(); // idempotent
    }
  });
});
