/**
 * slack_read tests (issue #340): the owned-space Slack read tool, exercised
 * through its `execute` caller surface against a HERMETIC fake Slack Web
 * API (Bun.serve, form-encoded POST — the @slack/web-api transport) — no
 * live network, no credentials.
 *
 * Covers:
 * - conversations.replies wire shape `{ channel, ts }` with NO `limit`
 *   (issue #215) returns the parent + replies;
 * - conversations.history wire shape `{ channel, limit }` returns recent
 *   top-level messages;
 * - missing_scope degrades to a loud diagnostic (fail closed, no fabricated
 *   data);
 * - own-channel by construction: the tool accepts no channel selector and
 *   the channel is always derived from the session's space id;
 * - REGRESSION #305: with a prior bot post seeded in the stub, a drive of
 *   `execute` retrieves that post verbatim — the read capability that did
 *   not exist on main.
 */
import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { join } from "node:path";
import { createSlackAdapter, type SlackAdapter } from "../server/adapters/slack";
import { slackReadArgsSchema, slackReadToolDefinition } from "./slack-read";

/** A seeded message the fake Slack API returns (the bot's own prior post). */
interface FakeMessage {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
}

interface FakeSlackApi {
  /** Recorded conversations.replies params (`undefined` until called). */
  readonly repliesParams?: { channel: string; ts: string; hasLimit: boolean };
  /** Recorded conversations.history params (`undefined` until called). */
  readonly historyParams?: { channel: string; limit: string | null };
  /** The fake's base URL for the adapter's clientOptions. */
  baseUrl: string;
  server: Server;
  stop(): void;
}

/**
 * Boots a fake Slack Web API serving conversations.replies / .history.
 * `seed` is the message list returned for BOTH calls unless a `missingScope`
 * flag returns `ok:false` `missing_scope` for every read, mirroring an app
 * whose token lacks channels:history/groups:history/im:history.
 */
function bootSlackApi(options: { messages: FakeMessage[]; missingScope?: string }): FakeSlackApi {
  const state: { repliesParams?: FakeSlackApi["repliesParams"]; historyParams?: FakeSlackApi["historyParams"] } = {};
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const form = new URLSearchParams(await request.text());
      if (options.missingScope) {
        return Response.json({ ok: false, error: "missing_scope", needed: options.missingScope });
      }
      if (url.pathname === "/api/conversations.replies") {
        state.repliesParams = {
          channel: form.get("channel") ?? "",
          ts: form.get("ts") ?? "",
          hasLimit: form.has("limit"),
        };
        return Response.json({
          ok: true,
          messages: options.messages.map((m) => ({ ts: m.ts, text: m.text, user: m.user, bot_id: m.bot_id })),
        });
      }
      if (url.pathname === "/api/conversations.history") {
        state.historyParams = {
          channel: form.get("channel") ?? "",
          limit: form.get("limit"),
        };
        return Response.json({
          ok: true,
          messages: options.messages.map((m) => ({ ts: m.ts, text: m.text, user: m.user, bot_id: m.bot_id })),
        });
      }
      return Response.json({ ok: false, error: "method_not_found" }, { status: 404 });
    },
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
    get repliesParams() {
      return state.repliesParams;
    },
    get historyParams() {
      return state.historyParams;
    },
    stop: () => server.stop(true),
  };
}

/** The read surface of a real adapter wired to the fake API, plus an opts builder. */
function adapterFor(api: FakeSlackApi): SlackAdapter {
  return createSlackAdapter({
    appToken: "xapp-slack-read-test-token",
    botToken: "xoxb-slack-read-test-token",
    onMessage: async () => {},
    clientOptions: { slackApiUrl: `${api.baseUrl}/api` },
  });
}

/** Builds an ExtensionContext whose session file names the space id (issue #66 convention). */
function ctxFor(spaceId: string): ExtensionContext {
  const ctx = {
    sessionManager: { getSessionFile: () => join("/tmp/sessions", `${spaceId}.jsonl`) },
  };
  // SAFETY: slack_read resolves the space id only via sessionManager.getSessionFile().
  return ctx as unknown as ExtensionContext;
}

/** The text content of a tool result (throws when it is not a text block). */
function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (!block || block.type !== "text" || block.text === undefined) throw new Error("tool did not return text");
  return block.text;
}

/** The first bot-authored post the #305 regression retrieves (verbatim contract). */
const BOT_POST = {
  ts: "1.000001",
  text: "Implemented the flaky-canary fix — here is the diff link: <https://example.com/p/123>",
  bot_id: "BOTA",
};

describe("slack_read registration (issue #340)", () => {
  test("exposes thread_ts and limit knobs and no channel selector", () => {
    const keys = Object.keys(slackReadArgsSchema.shape);
    expect(keys).toContain("thread_ts");
    expect(keys).toContain("limit");
    // Own-channel by construction: there is NO channel argument.
    expect(keys).not.toContain("channel");
    expect(keys).not.toContain("channel_id");
  });
});

describe("slack_read execution (hermetic, fake Slack Web API)", () => {
  test("reads a thread via conversations.replies with the space's channel, the thread_ts, and NO limit — returning parent + replies", async () => {
    const api = bootSlackApi({
      messages: [
        BOT_POST,
        { ts: "1.000002", text: "a reply from a human", user: "U42" },
        { ts: "1.000003", text: "another reply", user: "U7" },
      ],
    });
    try {
      const adapter = adapterFor(api);
      const tool = slackReadToolDefinition({
        readThread: adapter.readThread!.bind(adapter),
        readHistory: adapter.readHistory!.bind(adapter),
      });
      const result = await tool.execute("tc1", { thread_ts: "1.000001" }, undefined, undefined, ctxFor("slack:C1"));
      expect(result.isError).not.toBe(true);
      // Issue #215 wire shape: channel derived from space, ts passed, NO limit.
      expect(api.repliesParams).toEqual({ channel: "C1", ts: "1.000001", hasLimit: false });
      expect(JSON.parse(resultText(result))).toEqual([
        { ts: "1.000001", user: "BOTA", text: BOT_POST.text, order: 0 },
        { ts: "1.000002", user: "U42", text: "a reply from a human", order: 1 },
        { ts: "1.000003", user: "U7", text: "another reply", order: 2 },
      ]);
    } finally {
      api.stop();
    }
  });

  test("reads recent top-level messages via conversations.history with the space's channel and a default limit", async () => {
    const api = bootSlackApi({ messages: [BOT_POST, { ts: "2.1", text: "later", user: "U42" }] });
    try {
      const adapter = adapterFor(api);
      const tool = slackReadToolDefinition({
        readThread: adapter.readThread!.bind(adapter),
        readHistory: adapter.readHistory!.bind(adapter),
      });
      const result = await tool.execute("tc2", {}, undefined, undefined, ctxFor("slack:C1"));
      expect(result.isError).not.toBe(true);
      expect(api.historyParams).toEqual({ channel: "C1", limit: "50" });
      expect(JSON.parse(resultText(result))).toEqual([
        { ts: "1.000001", user: "BOTA", text: BOT_POST.text, order: 0 },
        { ts: "2.1", user: "U42", text: "later", order: 1 },
      ]);
    } finally {
      api.stop();
    }
  });

  test("a caller `limit` bounds the history read's wire limit and caps a thread read client-side", async () => {
    const api = bootSlackApi({
      messages: [BOT_POST, { ts: "2.1", text: "second", user: "U42" }, { ts: "2.2", text: "third", user: "U7" }],
    });
    try {
      const adapter = adapterFor(api);
      const tool = slackReadToolDefinition({
        readThread: adapter.readThread!.bind(adapter),
        readHistory: adapter.readHistory!.bind(adapter),
      });
      const historyResult = await tool.execute("tc3", { limit: 2 }, undefined, undefined, ctxFor("slack:C1"));
      expect(historyResult.isError).not.toBe(true);
      expect(api.historyParams).toEqual({ channel: "C1", limit: "2" });

      const threadResult = await tool.execute("tc4", { thread_ts: "1.000001", limit: 1 }, undefined, undefined, ctxFor("slack:C2"));
      expect(threadResult.isError).not.toBe(true);
      // replies still sends NO limit (issue #215); the cap applies client-side.
      expect(api.repliesParams).toEqual({ channel: "C2", ts: "1.000001", hasLimit: false });
      expect(JSON.parse(resultText(threadResult))).toEqual([
        { ts: "1.000001", user: "BOTA", text: BOT_POST.text, order: 0 },
      ]);
    } finally {
      api.stop();
    }
  });

  test("missing history scope degrades to a loud diagnostic, never a fabricated result (fail closed)", async () => {
    const api = bootSlackApi({ messages: [BOT_POST], missingScope: "channels:history" });
    try {
      const adapter = adapterFor(api);
      const tool = slackReadToolDefinition({
        readThread: adapter.readThread!.bind(adapter),
        readHistory: adapter.readHistory!.bind(adapter),
      });
      const result = await tool.execute("tc5", {}, undefined, undefined, ctxFor("slack:C1"));
      expect(result.isError).toBe(true);
      const text = resultText(result);
      expect(text).toContain("channels:history");
      expect(text).toContain("slack_read");
      // Fail closed: the diagnostic is NOT a JSON "no messages" array.
      expect(text.startsWith("[")).toBe(false);
    } finally {
      api.stop();
    }
  });

  test("REGRESSION #305: a prior bot post in the channel is retrieved verbatim through execute", async () => {
    const api = bootSlackApi({ messages: [BOT_POST] });
    try {
      const adapter = adapterFor(api);
      const tool = slackReadToolDefinition({
        readThread: adapter.readThread!.bind(adapter),
        readHistory: adapter.readHistory!.bind(adapter),
      });
      // The bot's own prior reply (issue #305: the runtime never saw it —
      // only inbound Socket Mode events). Driving execute must surface it.
      const result = await tool.execute("tc6", { thread_ts: "1.000001" }, undefined, undefined, ctxFor("slack:C1"));
      expect(result.isError).not.toBe(true);
      const messages = JSON.parse(resultText(result)) as Array<{ ts: string; text: string; user: string }>;
      expect(messages[0]).toMatchObject({ ts: BOT_POST.ts, text: BOT_POST.text, user: "BOTA" });
    } finally {
      api.stop();
    }
  });

  test("refuses to read when no session context resolves a space (no channel to read)", async () => {
    const api = bootSlackApi({ messages: [BOT_POST] });
    try {
      const adapter = adapterFor(api);
      const tool = slackReadToolDefinition({
        readThread: adapter.readThread!.bind(adapter),
        readHistory: adapter.readHistory!.bind(adapter),
      });
      // No session-context space → no channel to read; fails closed without
      // ever calling Slack.
      const result = await tool.execute(
        "tc7",
        {},
        undefined,
        undefined,
        { sessionManager: { getSessionFile: () => undefined } } as ExtensionContext,
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("could not resolve this conversation's space");
    } finally {
      api.stop();
    }
  });
});