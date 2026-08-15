import { describe, expect, test } from "bun:test";
import { App, type Logger } from "@slack/bolt";
import {
  buildPostMessageArgs,
  buildUpdateMessageArgs,
  channelFromSpaceId,
  createSlackAdapter,
  isBotMessage,
  isDmChannel,
  normalizeMessage,
  registerMessageHandler,
  spaceIdFromChannel,
  type SlackMessage,
} from "./slack";

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
  test("true when bot_id is present", () => {
    expect(isBotMessage({ bot_id: "B999", user: "U123" })).toBe(true);
  });

  test("true for the bot_message subtype", () => {
    expect(isBotMessage({ subtype: "bot_message", user: "U123" })).toBe(true);
  });

  test("false for a plain user message", () => {
    expect(isBotMessage({ user: "U123", text: "hi" })).toBe(false);
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

  test("drops bot messages", () => {
    expect(normalizeMessage({ ...channelEvent, bot_id: "B999" })).toBeNull();
    expect(normalizeMessage({ ...channelEvent, subtype: "bot_message" })).toBeNull();
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

describe("createSlackAdapter", () => {
  test("returns an adapter exposing postMessage, updateMessage, start and stop", () => {
    const adapter = createSlackAdapter({
      appToken: "xapp-test-token",
      botToken: "xoxb-test-token",
      onMessage: async () => {},
    });
    expect(typeof adapter.postMessage).toBe("function");
    expect(typeof adapter.updateMessage).toBe("function");
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.stop).toBe("function");
  });
});

describe("inbound Socket Mode routing through the real Bolt router (issue #29)", () => {
  // Hermetic inbound: Bolt's App.processEvent routes an event_callback body
  // to the registered "message" listener with no socket connection and no
  // Slack API calls — the authorize hook is an injected local double (Bolt's
  // default would run auth.test against the network). The wiring under test
  // (registerMessageHandler) is the exact function createSlackAdapter
  // installs on its app.
  function bootApp(onMessage: (m: SlackMessage) => Promise<void>): {
    logged: string[];
    deliver: (event: Record<string, unknown>) => Promise<void>;
  } {
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
        getLevel: () => 0,
        setLevel: () => {},
        setName: () => {},
      } as unknown as Logger,
    });
    registerMessageHandler(app, onMessage);
    return {
      logged,
      async deliver(event) {
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
});
