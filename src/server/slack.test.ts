import { describe, expect, test } from "bun:test";
import {
  buildPostMessageArgs,
  channelFromSpaceId,
  createSlackAdapter,
  isBotMessage,
  normalizeMessage,
  spaceIdFromChannel,
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

describe("createSlackAdapter", () => {
  test("returns an adapter exposing postMessage, start and stop", () => {
    const adapter = createSlackAdapter({
      appToken: "xapp-test-token",
      botToken: "xoxb-test-token",
      onMessage: async () => {},
    });
    expect(typeof adapter.postMessage).toBe("function");
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.stop).toBe("function");
  });
});
