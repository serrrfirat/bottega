import { describe, expect, test } from "bun:test";
import { App, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import type { ResponseMode } from "../../policy/config";
import {
  APPROVE_ACTION_ID,
  DELIVERY_APPROVE_ACTION_ID,
  DELIVERY_DENY_ACTION_ID,
  DENY_ACTION_ID,
  buildAppendTaskArgs,
  buildAppendTextArgs,
  buildPostMessageArgs,
  buildStartStreamArgs,
  buildStopStreamArgs,
  buildUpdateMessageArgs,
  channelFromSpaceId,
  createSlackAdapter,
  isBotMessage,
  isDmChannel,
  isStreamingCapabilityError,
  markdownChunk,
  normalizeActionEvent,
  isMentionedMessage,
  normalizeMessage,
  probeStreamingSupport,
  registerActionHandler,
  registerMessageHandler,
  renderSlackText,
  spaceIdFromChannel,
  STREAM_RETRY_CONFIG,
  STREAM_TASK_OUTPUT_MAX,
  taskUpdateChunk,
  type SlackAction,
  type MessageHandlerOptions,
  type SlackMessage,
} from "./slack";

/** Arbitrary JSON values (Slack event bodies are parsed JSON of unknown shape). */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

describe("space id derivation", () => {
  test("channel id maps to slack:<channel_id>", () => {
    expect(spaceIdFromChannel("C123ABC")).toBe("slack:C123ABC");
  });

  test("space id maps back to the channel id", () => {
    expect(channelFromSpaceId("slack:C123ABC")).toBe("C123ABC");
  });

  test("unprefixed ids pass through unchanged", () => {
    expect(channelFromSpaceId("C123ABC")).toBe("C123ABC");
  });
});

describe("isDmChannel", () => {
  test("true for D-prefixed direct-message channel ids", () => {
    expect(isDmChannel("D123ABC")).toBe(true);
  });

  test("false for public channels (C) and private groups (G)", () => {
    expect(isDmChannel("C123ABC")).toBe(false);
    expect(isDmChannel("G123ABC")).toBe(false);
  });

  test("false for unprefixed ids", () => {
    expect(isDmChannel("123ABC")).toBe(false);
  });
});

describe("isBotMessage (pure bot-message predicate)", () => {
  test("true when bot_id is present and the identity is unknown (fail closed)", () => {
    expect(isBotMessage({ bot_id: "B999", user: "U123" })).toBe(true);
  });

  test("true for the bot_message subtype", () => {
    expect(isBotMessage({ subtype: "bot_message", user: "U123" })).toBe(true);
  });

  test("true for the adapter's own bot user id (its own replies)", () => {
    expect(isBotMessage({ bot_id: "B999", user: "U0BOT" }, "U0BOT")).toBe(true);
  });

  test("false for a real user's API-posted message carrying bot_id (issue #204)", () => {
    expect(isBotMessage({ bot_id: "B999", user: "U0B9QUPCTJ5" }, "U0BQCUUHYMB")).toBe(false);
  });

  test("false for a plain user message", () => {
    expect(isBotMessage({ user: "U123", text: "hi" })).toBe(false);
  });
});

describe("isMentionedMessage (issue #55 mention filter)", () => {
  test("channel messages must @mention the bot", () => {
    expect(isMentionedMessage("hello <@U0BOT> how are you", "C123ABC", "U0BOT")).toBe(true);
    expect(isMentionedMessage("just chatter about the deploy", "C123ABC", "U0BOT")).toBe(false);
  });

  test("the <@U0XXX|display> mention form matches too", () => {
    expect(isMentionedMessage("<@U0BOT|bottega> take this", "C123ABC", "U0BOT")).toBe(true);
  });

  test("DMs always pass, mention or not", () => {
    expect(isMentionedMessage("plain dm text", "D123ABC", "U0BOT")).toBe(true);
    expect(isMentionedMessage("", "D123ABC", "U0BOT")).toBe(true);
  });

  test("an unknown bot id passes everything (pre-start fallback)", () => {
    expect(isMentionedMessage("unjudgeable chatter", "C123ABC", undefined)).toBe(true);
  });
});

describe("normalizeMessage", () => {
  const channelEvent = {
    type: "message",
    channel: "C123ABC",
    user: "U456",
    text: "hello bottega",
    ts: "1723700000.000100",
  };

  test("maps a channel message to a SlackMessage", () => {
    expect(normalizeMessage(channelEvent)).toEqual({
      spaceId: "slack:C123ABC",
      principal: "U456",
      text: "hello bottega",
      ts: "1723700000.000100",
    });
  });

  test("thread replies share the channel space in v1", () => {
    expect(normalizeMessage({ ...channelEvent, thread_ts: "1723700000.000100" })).toEqual({
      spaceId: "slack:C123ABC",
      principal: "U456",
      text: "hello bottega",
      ts: "1723700000.000100",
    });
  });

  test("maps file_share attachments and accepts empty text", () => {
    expect(
      normalizeMessage({
        ...channelEvent,
        subtype: "file_share",
        text: "",
        files: [
          { id: "F123", name: "notes.txt", mimetype: "text/plain", size: 12 },
          { id: "F456", name: "data.csv", mimetype: "text/csv", size: 34 },
          { name: "missing-id.txt", mimetype: "text/plain", size: 1 },
        ],
      }),
    ).toEqual({
      spaceId: "slack:C123ABC",
      principal: "U456",
      text: "",
      ts: "1723700000.000100",
      files: [
        { id: "F123", name: "notes.txt", mimeType: "text/plain", size: 12 },
        { id: "F456", name: "data.csv", mimeType: "text/csv", size: 34 },
      ],
    });
  });

  test("accepts a file_share event with no text", () => {
    expect(
      normalizeMessage({
        type: "message",
        subtype: "file_share",
        channel: "C123ABC",
        user: "U456",
        ts: "1723700000.000100",
        files: [{ id: "F123", name: "notes.txt", mimetype: "text/plain", size: 12 }],
      }),
    ).toMatchObject({ text: "", files: [{ id: "F123", name: "notes.txt" }] });
  });

  test("drops bot-authored file_share messages", () => {
    expect(
      normalizeMessage({
        ...channelEvent,
        subtype: "file_share",
        bot_id: "B999",
        files: [{ id: "F123", name: "notes.txt", mimetype: "text/plain", size: 12 }],
      }),
    ).toBeNull();
  });


  test("drops bot messages", () => {
    expect(normalizeMessage({ ...channelEvent, bot_id: "B999" })).toBeNull();
    expect(normalizeMessage({ ...channelEvent, subtype: "bot_message" })).toBeNull();
  });

  test("delivers a real user's API-posted message carrying bot_id (canary as_user, issue #204)", () => {
    // Slack stamps `bot_id` on any chat.postMessage from the app — including
    // the QA canary's `as_user: true` posts; the human's `user` id is what
    // makes it a user message, not a bot's.
    expect(
      normalizeMessage(
        { ...channelEvent, channel: "C0BQFD757NZ", user: "U0B9QUPCTJ5", bot_id: "B0BQNN4CLAY", text: "canary ping" },
        "U0BQCUUHYMB",
      ),
    ).toEqual({ spaceId: "slack:C0BQFD757NZ", principal: "U0B9QUPCTJ5", text: "canary ping", ts: "1723700000.000100" });
  });

  test("drops messages missing required fields", () => {
    expect(normalizeMessage({ ...channelEvent, text: undefined })).toBeNull();
    expect(normalizeMessage({ type: "message", channel: "C123ABC" })).toBeNull();
  });

  test("drops non-object payloads without throwing", () => {
    expect(normalizeMessage(null)).toBeNull();
    expect(normalizeMessage("nope")).toBeNull();
    expect(normalizeMessage(42)).toBeNull();
    expect(normalizeMessage(undefined)).toBeNull();
  });
});

describe("normalizeActionEvent", () => {
  const action = { type: "button", action_id: APPROVE_ACTION_ID, value: "req-1" };
  const body = {
    type: "block_actions",
    channel: { id: "C123ABC" },
    user: { id: "U456" },
    message: { ts: "1723700000.000100" },
  };

  test("maps a block-action click to a SlackAction", () => {
    expect(normalizeActionEvent(action, body)).toEqual({
      actionId: APPROVE_ACTION_ID,
      value: "req-1",
      spaceId: "slack:C123ABC",
      principal: "U456",
      messageTs: "1723700000.000100",
    });
  });

  test("deny buttons normalize the same way", () => {
    expect(
      normalizeActionEvent({ ...action, action_id: DENY_ACTION_ID }, body)?.actionId,
    ).toBe(DENY_ACTION_ID);
  });

  test("drops payloads missing the action id or value", () => {
    expect(normalizeActionEvent({ type: "button" }, body)).toBeNull();
    expect(normalizeActionEvent({ type: "button", action_id: APPROVE_ACTION_ID }, body)).toBeNull();
    expect(normalizeActionEvent(null, body)).toBeNull();
  });

  test("drops payloads missing channel/user/message context", () => {
    expect(normalizeActionEvent(action, { type: "block_actions" })).toBeNull();
    const { channel: _channel, ...noChannel } = body;
    expect(normalizeActionEvent(action, noChannel)).toBeNull();
    expect(normalizeActionEvent(action, { ...body, user: {} })).toBeNull();
    expect(normalizeActionEvent(action, { ...body, message: {} })).toBeNull();
    expect(normalizeActionEvent(action, null)).toBeNull();
  });
});

describe("inbound block-action routing through the real Bolt router (issue #44)", () => {
  // Hermetic inbound, same shape as the message tests: Bolt's
  // App.processEvent routes a block_actions body to the registered "action"
  // listener with no socket connection and no Slack API calls (the
  // authorize hook is an injected local double).
  function bootApp(onAction: (a: SlackAction) => Promise<void>) {
    const logged: string[] = [];
    const app = new App({
      appToken: "xapp-test-token",
      signingSecret: "test-signing-secret",
      tokenVerificationEnabled: false,
      authorize: async () => ({ botToken: "xoxb-test-token" }),
      logger: {
        info: (...args: unknown[]) => void logged.push(args.join(" ")),
        debug: () => {},
        warn: () => {},
        error: () => {},
        getLevel: () => LogLevel.INFO,
        setLevel: () => {},
        setName: () => {},
      },
    });
    registerActionHandler(app, onAction);
    return {
      logged,
      async deliver(body: Record<string, JsonValue>) {
        await app.processEvent({ body, ack: async () => {} });
      },
    };
  }

  const approveBody = {
    type: "block_actions",
    team: { id: "T1" },
    channel: { id: "C123" },
    user: { id: "U1" },
    message: { ts: "1723700000.000100" },
    actions: [{ type: "button", action_id: APPROVE_ACTION_ID, value: "req-1" }],
  };

  test("delivers an approve click to onAction, normalized to the space", async () => {
    const received: SlackAction[] = [];
    const { deliver } = bootApp(async (a) => { received.push(a); });

    await deliver(approveBody);

    expect(received).toEqual([
      {
        actionId: APPROVE_ACTION_ID,
        value: "req-1",
        spaceId: "slack:C123",
        principal: "U1",
        messageTs: "1723700000.000100",
      },
    ]);
  });

  test("delivers a deny click to onAction", async () => {
    const received: SlackAction[] = [];
    const { deliver } = bootApp(async (a) => { received.push(a); });

    await deliver({ ...approveBody, actions: [{ type: "button", action_id: DENY_ACTION_ID, value: "req-2" }] });

    expect(received.map((a) => a.actionId)).toEqual([DENY_ACTION_ID]);
    expect(received[0].value).toBe("req-2");
  });

  test("delivers delivery-approval clicks to onAction (issue #149)", async () => {
    const received: SlackAction[] = [];
    const { deliver } = bootApp(async (a) => { received.push(a); });

    await deliver({
      ...approveBody,
      actions: [{ type: "button", action_id: DELIVERY_APPROVE_ACTION_ID, value: "wi_1" }],
    });
    await deliver({
      ...approveBody,
      actions: [{ type: "button", action_id: DELIVERY_DENY_ACTION_ID, value: "wi_2" }],
    });

    expect(received.map((a) => a.actionId)).toEqual([DELIVERY_APPROVE_ACTION_ID, DELIVERY_DENY_ACTION_ID]);
    expect(received[0].value).toBe("wi_1");
    expect(received[1].value).toBe("wi_2");
  });

  test("unrelated action ids do not reach onAction", async () => {
    const received: SlackAction[] = [];
    const { deliver } = bootApp(async (a) => { received.push(a); });

    await deliver({ ...approveBody, actions: [{ type: "button", action_id: "some_other_button", value: "x" }] });

    expect(received).toHaveLength(0);
  });

  test("unparseable action payloads are dropped and logged, not thrown", async () => {
    const received: SlackAction[] = [];
    const { deliver, logged } = bootApp(async (a) => { received.push(a); });

    await expect(
      deliver({ ...approveBody, actions: [{ type: "button", action_id: APPROVE_ACTION_ID }] }),
    ).resolves.toBeUndefined();

    expect(received).toHaveLength(0);
    expect(logged.some((l) => l.includes("dropping action event"))).toBe(true);
  });
});

describe("buildPostMessageArgs", () => {
  test("maps space id and text to chat.postMessage args", () => {
    expect(buildPostMessageArgs("slack:C123ABC", "hello")).toEqual({
      channel: "C123ABC",
      text: "hello",
    });
  });

  test("passes thread_ts through when provided", () => {
    expect(
      buildPostMessageArgs("slack:C123ABC", "hello", { threadTs: "1723700000.000100" }),
    ).toEqual({
      channel: "C123ABC",
      text: "hello",
      thread_ts: "1723700000.000100",
    });
  });

  test("passes interactive blocks through when provided (issue #44)", () => {
    const blocks = [{ type: "actions", elements: [] }];
    expect(buildPostMessageArgs("slack:C123ABC", "hello", { blocks })).toEqual({
      channel: "C123ABC",
      text: "hello",
      blocks,
    });
  });
});

describe("buildUpdateMessageArgs", () => {
  test("maps space id, ts and text to chat.update args", () => {
    expect(buildUpdateMessageArgs("slack:C123ABC", "1723700000.000100", "updated")).toEqual({
      channel: "C123ABC",
      ts: "1723700000.000100",
      text: "updated",
    });
  });

  test("unprefixed space ids pass through unchanged", () => {
    expect(buildUpdateMessageArgs("D123ABC", "1.1", "updated")).toEqual({
      channel: "D123ABC",
      ts: "1.1",
      text: "updated",
    });
  });
});

describe("renderSlackText (Markdown → Slack mrkdwn, issue #84)", () => {
  test("md **bold** renders as Slack *bold*", () => {
    expect(renderSlackText("this is **important** text")).toBe("this is *important* text");
  });

  test("headings become bold lines (Slack has no headings)", () => {
    expect(renderSlackText("## Summary\nbody")).toBe("*Summary*\nbody");
    expect(renderSlackText("# Title\n## Sub\n### Deep")).toBe("*Title*\n*Sub*\n*Deep*");
  });

  test("md line bullets become Slack • bullets", () => {
    expect(renderSlackText("- one\n- two")).toBe("• one\n• two");
    expect(renderSlackText("* one\n+ two")).toBe("• one\n• two");
  });

  test("indented sub-bullets keep their indent", () => {
    expect(renderSlackText("- top\n  - nested")).toBe("• top\n  • nested");
  });

  test("md [label](url) links become Slack <url|label>", () => {
    expect(renderSlackText("see [docs](https://example.com) today")).toBe(
      "see <https://example.com|docs> today",
    );
  });

  test("horizontal rules are dropped, not shown raw", () => {
    expect(renderSlackText("a\n---\nb")).toBe("a\n\nb");
  });

  test("fenced code blocks pass through verbatim", () => {
    const md = "before\n```\n# not a heading\n- not a bullet\n```\nafter";
    expect(renderSlackText(md)).toBe("before\n```\n# not a heading\n- not a bullet\n```\nafter");
  });

  test("inline code passes through verbatim", () => {
    expect(renderSlackText("run `git -b **x**` now")).toBe("run `git -b **x**` now");
  });

  test("already-correct Slack mrkdwn is not corrupted", () => {
    expect(renderSlackText("*bold* _italic_ <https://example.com|link> <@U123>")).toBe(
      "*bold* _italic_ <https://example.com|link> <@U123>",
    );
  });

  test("plain text with no markup passes through", () => {
    expect(renderSlackText("hello world")).toBe("hello world");
  });
});

describe("stream arg builders (issue #168)", () => {
  test("buildStartStreamArgs: channels carry the required recipient_team_id; DMs omit it", () => {
    expect(buildStartStreamArgs("slack:C123ABC", { threadTs: "1.1", openingText: "Thinking…" }, "T123")).toEqual({
      channel: "C123ABC",
      thread_ts: "1.1",
      recipient_team_id: "T123",
      chunks: [{ type: "markdown_text", text: "Thinking…" }],
    });
    expect(buildStartStreamArgs("slack:D123ABC", { threadTs: "1.1", openingText: "Thinking…" }, "T123")).toEqual({
      channel: "D123ABC",
      thread_ts: "1.1",
      chunks: [{ type: "markdown_text", text: "Thinking…" }],
    });
  });

  test("buildStartStreamArgs: no team id yet → channels omit recipient_team_id (startStream fails once, then falls back)", () => {
    expect(buildStartStreamArgs("slack:C123ABC", { threadTs: "1.1", openingText: "x" }, undefined)).toEqual({
      channel: "C123ABC",
      thread_ts: "1.1",
      chunks: [{ type: "markdown_text", text: "x" }],
    });
  });

  test("markdownChunk renders Slack mrkdwn, taskUpdateChunk keeps the flat task_update shape", () => {
    expect(markdownChunk("see [docs](https://x.dev)")).toEqual({
      type: "markdown_text",
      text: "see <https://x.dev|docs>",
    });
    expect(taskUpdateChunk({ id: "step-1", title: "bash — allowed (exec)", status: "in_progress", output: '{"command":"ls"}' })).toEqual({
      type: "task_update",
      id: "step-1",
      title: "bash — allowed (exec)",
      status: "in_progress",
      output: '{"command":"ls"}',
    });
    expect(taskUpdateChunk({ id: "step-2", title: "x", status: "complete" })).toEqual({
      type: "task_update",
      id: "step-2",
      title: "x",
      status: "complete",
    });
  });

  test("task_update output is capped at 256 chars so a long args card never 400s the stream", () => {
    const long = "x".repeat(500);
    const chunk = taskUpdateChunk({ id: "s", title: "t", status: "in_progress", output: long });
    expect(chunk.output).toHaveLength(STREAM_TASK_OUTPUT_MAX);
    expect(chunk.output).toBe("x".repeat(STREAM_TASK_OUTPUT_MAX));
  });

  test("buildAppendTextArgs / buildAppendTaskArgs / buildStopStreamArgs map to appendStream/stopStream arguments", () => {
    expect(buildAppendTextArgs("slack:C1", "ts-1", "more")).toEqual({
      channel: "C1",
      ts: "ts-1",
      chunks: [{ type: "markdown_text", text: "more" }],
    });
    expect(buildAppendTaskArgs("slack:C1", "ts-1", { id: "s", title: "t", status: "complete" })).toEqual({
      channel: "C1",
      ts: "ts-1",
      chunks: [{ type: "task_update", id: "s", title: "t", status: "complete" }],
    });
    expect(buildStopStreamArgs("slack:C1", "ts-1", "final reply")).toEqual({
      channel: "C1",
      ts: "ts-1",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "final reply" } }],
    });
    expect(buildStopStreamArgs("slack:C1", "ts-1")).toEqual({ channel: "C1", ts: "ts-1" });
  });
});

describe("createSlackAdapter", () => {
  test("returns an adapter exposing messages, files, reactions, start and stop", () => {
    const adapter = createSlackAdapter({
      appToken: "xapp-test-token",
      botToken: "xoxb-test-token",
      onMessage: async () => {},
    });
    expect(adapter.postMessage).toEqual(expect.any(Function));
    expect(adapter.updateMessage).toEqual(expect.any(Function));
    expect(adapter.addReaction).toEqual(expect.any(Function));
    expect(adapter.removeReaction).toEqual(expect.any(Function));
    expect(adapter.downloadFile).toEqual(expect.any(Function));
    expect(adapter.uploadFile).toEqual(expect.any(Function));
    expect(adapter.start).toEqual(expect.any(Function));
    expect(adapter.stop).toEqual(expect.any(Function));
  });
});

// ---------------------------------------------------------------------------
// Streaming robustness (issue #181): fast capability probe + fail-fast
// stream calls that never hit the SDK's ~30-minute retry policy and flip
// the per-boot cache on ANY failure.
// ---------------------------------------------------------------------------

describe("streaming capability probe (issue #181)", () => {
  test("scope/token-level errors prove the workspace cannot stream", () => {
    expect(isStreamingCapabilityError({ data: { error: "missing_required_scope", needed: "assistant:write" } })).toBe(true);
    expect(isStreamingCapabilityError({ data: { error: "not_allowed_token_type" } })).toBe(true);
    expect(isStreamingCapabilityError({ data: { error: "invalid_auth" } })).toBe(true);
  });

  test("channel-level errors mean the token CAN stream (the dummy channel was rejected, not the feature)", () => {
    expect(isStreamingCapabilityError({ data: { error: "channel_not_found" } })).toBe(false);
    expect(isStreamingCapabilityError({ data: { error: "invalid_arguments" } })).toBe(false);
    expect(isStreamingCapabilityError({ data: { error: "invalid_ts" } })).toBe(false);
    expect(isStreamingCapabilityError(new Error("network down"))).toBe(false);
    expect(isStreamingCapabilityError(undefined)).toBe(false);
  });

  test("the stream client is configured with NO retries — a failure must arrive fast, never a ~30-minute retry storm", () => {
    expect(STREAM_RETRY_CONFIG.retries).toBe(0);
  });

  test("probeStreamingSupport: a scope error reports unsupported with the code as evidence", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => Response.json({ ok: false, error: "missing_required_scope", needed: "assistant:write", provided: "chat:write" }),
    });
    const client = new WebClient("xoxb-probe-token", {
      slackApiUrl: `http://127.0.0.1:${server.port}/api`,
      retryConfig: STREAM_RETRY_CONFIG,
    });
    try {
      expect(await probeStreamingSupport(client, "T123")).toEqual({ supported: false, error: "missing_required_scope" });
    } finally {
      server.stop();
    }
  });

  test("probeStreamingSupport: a channel-level error means supported — the probe posted nothing and the panel can stream", async () => {
    let startStreamHits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        startStreamHits += 1;
        return Response.json({ ok: false, error: "channel_not_found" });
      },
    });
    const client = new WebClient("xoxb-probe-token", {
      slackApiUrl: `http://127.0.0.1:${server.port}/api`,
      retryConfig: STREAM_RETRY_CONFIG,
    });
    try {
      expect(await probeStreamingSupport(client, "T123")).toEqual({ supported: true });
      expect(startStreamHits).toBe(1); // exactly one attempt: fail fast
    } finally {
      server.stop();
    }
  });
});

describe("stream calls fail fast and flip the per-boot cache (issue #181)", () => {
  const BOT_TOKEN = "xoxb-stream-test-token";

  /** Boots the real adapter against a mock Web API that always errors stream calls. */
  function bootStreamlessApi() {
    const hits: Record<string, number> = {};
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const method = url.pathname.replace("/api/", "");
        hits[method] = (hits[method] ?? 0) + 1;
        return Response.json({ ok: false, error: "not_allowed_token_type" });
      },
    });
    const adapter = createSlackAdapter({
      appToken: "xapp-stream-test-token",
      botToken: BOT_TOKEN,
      onMessage: async () => {},
      clientOptions: { slackApiUrl: `http://127.0.0.1:${server.port}/api` },
    });
    return { adapter, hits, server };
  }

  test("startStream: one attempt (no retry), the failure flips streamingSupported for the boot", async () => {
    const { adapter, hits, server } = bootStreamlessApi();
    try {
      expect(adapter.streamingSupported()).toBe(true);
      await expect(adapter.startStream("slack:C1", { threadTs: "1.1", openingText: "Thinking…" })).rejects.toThrow();
      expect(hits["chat.startStream"]).toBe(1); // no SDK retry storm
      expect(adapter.streamingSupported()).toBe(false); // cached per boot
    } finally {
      server.stop();
    }
  });

  test("appendText/appendTask/stopStream failures also flip the cache (fail-fast on every stream call)", async () => {
    const { adapter, hits, server } = bootStreamlessApi();
    try {
      await expect(adapter.appendText("slack:C1", "ts-1", "more")).rejects.toThrow();
      await expect(adapter.appendTask("slack:C1", "ts-1", { id: "s1", title: "t", status: "in_progress" })).rejects.toThrow();
      await expect(adapter.stopStream("slack:C1", "ts-1")).rejects.toThrow();
      expect(hits["chat.appendStream"]).toBe(2);
      expect(hits["chat.stopStream"]).toBe(1);
      expect(adapter.streamingSupported()).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("an explicit streamingSupported override still wins over the cache", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => Response.json({ ok: false, error: "not_allowed_token_type" }),
    });
    const adapter = createSlackAdapter({
      appToken: "xapp-stream-test-token",
      botToken: BOT_TOKEN,
      onMessage: async () => {},
      streamingSupported: () => false, // e2e harness seam (issue #179)
      clientOptions: { slackApiUrl: `http://127.0.0.1:${server.port}/api` },
    });
    try {
      expect(adapter.streamingSupported()).toBe(false);
      // The guard throws BEFORE any network call: a stream-less surface is
      // never even attempted.
      await expect(adapter.startStream("slack:C1", { threadTs: "1.1", openingText: "x" })).rejects.toThrow(
        "chat streaming unsupported",
      );
    } finally {
      server.stop();
    }
  });
});

describe("Slack file API roundtrips", () => {
  const BOT_TOKEN = "xoxb-file-test-token";
  const DOWNLOAD_BYTES = new TextEncoder().encode("attachment body");

  /** What the file-API stub observed across the roundtrips. */
  interface FileApiState {
    infoFile?: string;
    downloadAuth?: string | null;
    uploadFilename?: string;
    uploadLength?: string;
    uploadChannel?: string;
    uploadedBytes?: Uint8Array;
  }

  /**
   * Extracts the file part's bytes from a multipart/form-data body; returns
   * the raw body when the body is not multipart (defensive: raw uploads).
   */
  function extractMultipartPart(body: Uint8Array, boundary: string | null): Uint8Array {
    if (!boundary) return body;
    const text = new TextDecoder().decode(body);
    const headerEnd = text.indexOf("\r\n\r\n");
    const partEnd = text.indexOf(`\r\n--${boundary}`, headerEnd + 4);
    if (headerEnd < 0 || partEnd < 0) return body;
    return body.slice(headerEnd + 4, partEnd);
  }

  function bootFilesApi() {    let baseUrl = "";
    const state: FileApiState = {};
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/files.info") {
          const form = new URLSearchParams(await request.text());
          state.infoFile = form.get("file") ?? undefined;
          return Response.json({
            ok: true,
            file: {
              id: "F123",
              name: "notes.txt",
              mimetype: "text/plain",
              size: DOWNLOAD_BYTES.byteLength,
              url_private_download: `${baseUrl}/download/F123`,
            },
          });
        }
        if (url.pathname === "/download/F123") {
          state.downloadAuth = request.headers.get("authorization");
          return new Response(DOWNLOAD_BYTES);
        }
        if (url.pathname === "/api/files.getUploadURLExternal") {
          const form = new URLSearchParams(await request.text());
          state.uploadFilename = form.get("filename") ?? undefined;
          state.uploadLength = form.get("length") ?? undefined;
          return Response.json({
            ok: true,
            file_id: "F-UPLOAD",
            upload_url: `${baseUrl}/upload/F-UPLOAD`,
          });
        }
        if (url.pathname === "/upload/F-UPLOAD") {
          // files.uploadV2 posts the chunk as multipart/form-data to the
          // upload URL (observed: 226-byte envelope for a 4-byte file), so
          // extract the embedded file part; the bytes are the contract.
          const raw = new Uint8Array(await request.arrayBuffer());
          const contentType = request.headers.get("content-type") ?? "";
          const boundary = contentType.match(/boundary=(.+)$/)?.[1];
          state.uploadedBytes = extractMultipartPart(raw, boundary ?? null);
          return new Response("ok");
        }
        if (url.pathname === "/api/files.completeUploadExternal") {
          const form = new URLSearchParams(await request.text());
          state.uploadChannel = form.get("channel_id") ?? undefined;
          return Response.json({ ok: true, files: [{ id: "F-UPLOAD" }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    const adapter = createSlackAdapter({
      appToken: "xapp-file-test-token",
      botToken: BOT_TOKEN,
      onMessage: async () => {},
      clientOptions: { slackApiUrl: `${baseUrl}/api` },
    });
    return { adapter, state, server };
  }

  test("downloadFile returns Slack metadata and authenticated bytes", async () => {
    const api = bootFilesApi();
    try {
      const file = await api.adapter.downloadFile("F123");

      expect(file).toEqual({
        name: "notes.txt",
        mimeType: "text/plain",
        size: DOWNLOAD_BYTES.byteLength,
        bytes: DOWNLOAD_BYTES,
      });
      expect(api.state.infoFile).toBe("F123");
      expect(api.state.downloadAuth).toBe(`Bearer ${BOT_TOKEN}`);
    } finally {
      api.server.stop(true);
    }
  });

  test("uploadFile sends the channel, filename, and bytes through files.uploadV2", async () => {
    const api = bootFilesApi();
    const content = new Uint8Array([0, 1, 2, 255]);
    try {
      const id = await api.adapter.uploadFile(
        "slack:C123ABC",
        "artifact.bin",
        "application/octet-stream",
        content,
      );

      expect(id).toBe("F-UPLOAD");
      expect(api.state.uploadChannel).toBe("C123ABC");
      expect(api.state.uploadFilename).toBe("artifact.bin");
      expect(api.state.uploadLength).toBe(String(content.byteLength));
      expect(api.state.uploadedBytes).toEqual(content);
    } finally {
      api.server.stop(true);
    }
  });
});

describe("inbound Socket Mode routing through the real Bolt router (issue #29)", () => {
  // Hermetic inbound: Bolt's App.processEvent routes an event_callback body
  // to the registered "message" listener with no socket connection and no
  // Slack API calls — the authorize hook is an injected local double (Bolt's
  // default would run auth.test against the network). The wiring under test
  // (registerMessageHandler) is the exact function createSlackAdapter
  // installs on its app.
  function bootApp(
    onMessage: (m: SlackMessage) => Promise<void>,
    handlerOpts: MessageHandlerOptions = {},
  ) {
    const logged: string[] = [];
    const app = new App({
      appToken: "xapp-test-token",
      // The default HTTP receiver requires a signing secret at construction;
      // it is never started, so nothing listens or talks to Slack.
      signingSecret: "test-signing-secret",
      tokenVerificationEnabled: false,
      authorize: async () => ({ botToken: "xoxb-test-token" }),
      logger: {
        info: (...args: unknown[]) => void logged.push(args.join(" ")),
        debug: () => {},
        warn: () => {},
        error: () => {},
        getLevel: () => LogLevel.INFO,
        setLevel: () => {},
        setName: () => {},
      },
    });
    registerMessageHandler(app, onMessage, handlerOpts);
    return {
      logged,
      async deliver(event: Record<string, JsonValue>) {
        await app.processEvent({ body: { type: "event_callback", event }, ack: async () => {} });
      },
    };
  }

  test("delivers a user message to onMessage, normalized to the space", async () => {
    const received: SlackMessage[] = [];
    const { deliver } = bootApp(async (m) => { received.push(m); });

    await deliver({ type: "message", channel: "C123", user: "U1", text: "hello", ts: "1.1" });

    expect(received).toEqual([{ spaceId: "slack:C123", principal: "U1", text: "hello", ts: "1.1" }]);
  });

  test("thread replies share the channel space in v1", async () => {
    const received: SlackMessage[] = [];
    const { deliver } = bootApp(async (m) => { received.push(m); });

    await deliver({ type: "message", channel: "C123", user: "U1", text: "reply", ts: "1.2", thread_ts: "1.1" });

    expect(received).toEqual([{ spaceId: "slack:C123", principal: "U1", text: "reply", ts: "1.2" }]);
  });

  test("drops bot-authored messages and logs the drop", async () => {
    const received: SlackMessage[] = [];
    const { deliver, logged } = bootApp(async (m) => { received.push(m); });

    await deliver({ type: "message", channel: "C123", user: "U1", text: "hi", ts: "1.3", bot_id: "B1" });

    expect(received).toHaveLength(0);
    expect(logged.some((l) => l.includes("dropping message event"))).toBe(true);
  });

  test("drops unparseable messages without throwing", async () => {
    const received: SlackMessage[] = [];
    const { deliver, logged } = bootApp(async (m) => { received.push(m); });

    await expect(deliver({ type: "message", channel: "C123" })).resolves.toBeUndefined();

    expect(received).toHaveLength(0);
    expect(logged.some((l) => l.includes("dropping message event"))).toBe(true);
  });

  test("delivers the QA canary's as_user post: bot_id stamped by Slack, human user id (issue #204)", async () => {
    // The exact live shape from the canary's #bottega-qa channel: the real
    // user (firat.sertgoz, U0B9QUPCTJ5) posts via chat.postMessage
    // as_user and Slack stamps the app's bot_id on the event anyway. The
    // adapter must NOT drop it — a real user's post is not bot-authored.
    const received: SlackMessage[] = [];
    const { deliver, logged } = bootApp(async (m) => { received.push(m); }, {
      botUserId: () => "U0BQCUUHYMB",
    });

    await deliver({
      type: "message",
      channel: "C0BQFD757NZ",
      user: "U0B9QUPCTJ5",
      ts: "1786899338.572099",
      bot_id: "B0BQNN4CLAY",
      text: "canary msw1nnws-am4 (channel #bottega-qa): ping — reply with anything",
    });

    expect(received).toEqual([{
      spaceId: "slack:C0BQFD757NZ",
      principal: "U0B9QUPCTJ5",
      text: "canary msw1nnws-am4 (channel #bottega-qa): ping — reply with anything",
      ts: "1786899338.572099",
    }]);
    expect(logged.some((l) => l.includes("dropping message event"))).toBe(false);
  });

  test("still drops the bot's own reply events (loop protection)", async () => {
    const received: SlackMessage[] = [];
    const { deliver, logged } = bootApp(async (m) => { received.push(m); }, {
      botUserId: () => "U0BQCUUHYMB",
    });

    await deliver({
      type: "message",
      channel: "C0BQFD757NZ",
      user: "U0BQCUUHYMB",
      ts: "1786899338.600000",
      bot_id: "B0BQNN4CLAY",
      subtype: "bot_message",
      text: "ok",
    });

    expect(received).toHaveLength(0);
    expect(logged.some((l) => l.includes("dropping message event"))).toBe(true);
  });

  const mentionOpts: MessageHandlerOptions = {
    responseModeFor: async () => "mention" as ResponseMode,
    botUserId: () => "U0BOT",
  };

  test("mention mode: a channel message mentioning the bot is delivered", async () => {
    const received: SlackMessage[] = [];
    const { deliver } = bootApp(async (m) => { received.push(m); }, mentionOpts);

    await deliver({ type: "message", channel: "C123", user: "U1", text: "<@U0BOT> please fix", ts: "2.1" });

    expect(received).toEqual([{ spaceId: "slack:C123", principal: "U1", text: "<@U0BOT> please fix", ts: "2.1" }]);
  });

  test("mention mode: unmentioned channel chatter is dropped and logged (no turn)", async () => {
    const received: SlackMessage[] = [];
    const { deliver, logged } = bootApp(async (m) => { received.push(m); }, mentionOpts);

    await deliver({ type: "message", channel: "C123", user: "U1", text: "did anyone see the game?", ts: "2.2" });

    expect(received).toHaveLength(0);
    expect(logged.some((l) => l.includes("response_mode=mention"))).toBe(true);
  });

  test("mention mode: DMs pass without a mention", async () => {
    const received: SlackMessage[] = [];
    const { deliver } = bootApp(async (m) => { received.push(m); }, mentionOpts);

    await deliver({ type: "message", channel: "D123", user: "U1", text: "quick question", ts: "2.3" });

    expect(received).toEqual([{ spaceId: "slack:D123", principal: "U1", text: "quick question", ts: "2.3" }]);
  });

  test("default mode (always) forwards unmentioned channel messages", async () => {
    const received: SlackMessage[] = [];
    const { deliver } = bootApp(async (m) => { received.push(m); });

    await deliver({ type: "message", channel: "C123", user: "U1", text: "plain chatter", ts: "2.4" });

    expect(received).toEqual([{ spaceId: "slack:C123", principal: "U1", text: "plain chatter", ts: "2.4" }]);
  });
});
