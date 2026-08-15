/**
 * Slack adapter integration tests against the emulate.dev Slack emulator
 * (@emulators/slack). Boots a real HTTP server running the emulator and
 * drives `createSlackAdapter` at it via `clientOptions.slackApiUrl`, proving
 * the outbound Web API path works end to end without touching the real Slack
 * API.
 *
 * Emulator coverage (issue #18):
 * - Emulated: Web API — chat.postMessage (text + thread_ts passthrough),
 *   chat.update (issue #40), auth.test, token auth via Bearer header.
 * - NOT emulated: Socket Mode and inbound event delivery (README "Current
 *   Limits"). The socket connection cannot be pointed at the emulator, so
 *   inbound handling stays covered by the pure-function tests for
 *   normalizeMessage/buildPostMessageArgs; `start()` is never called here.
 * - Still needs a real workspace: Socket Mode delivery, app_mention/message
 *   routing, and Slack-side delivery guarantees.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "@emulators/core";
import slackPlugin, { getSlackStore, seedFromConfig } from "@emulators/slack";
import { createSlackAdapter, spaceIdFromChannel } from "./slack";

const BOT_TOKEN = "xoxb-bottega-local-test";

/**
 * Boots the Slack emulator on an ephemeral port, seeded with a workspace,
 * one channel, one user, and a bot token. Same shape as the executor tests'
 * GitHub emulator fixture: probe for a free port, then serve the emulator
 * app on it.
 */
function bootSlackEmulator() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);

  const emu = createServer(slackPlugin, { baseUrl: `http://127.0.0.1:${port}` });
  seedFromConfig(emu.store, emu.baseUrl, {
    team: { name: "Bottega Workspace" },
    users: [{ name: "developer" }],
    channels: [{ name: "ops" }],
    tokens: [{ token: BOT_TOKEN, user: "developer" }],
  });

  const http = Bun.serve({ port, fetch: emu.app.fetch });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store: emu.store,
    stop() {
      http.stop(true);
    },
  };
}

describe("slack adapter against @emulators/slack", () => {
  const emu = bootSlackEmulator();
  const slack = getSlackStore(emu.store);
  // Channel ids are random per emulator run; derive the seeded id from the
  // store rather than hardcoding it.
  const opsChannel = slack.channels.findOneBy("name", "ops")!.channel_id;

  const adapter = createSlackAdapter({
    appToken: "xapp-local-test-token",
    botToken: BOT_TOKEN,
    onMessage: async () => {},
    clientOptions: { slackApiUrl: `${emu.baseUrl}/api` },
  });

  test("postMessage delivers channel + text to the emulator", async () => {
    await adapter.postMessage(spaceIdFromChannel(opsChannel), "hello from bottega");

    const messages = slack.messages.all().filter((m) => m.channel_id === opsChannel);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("hello from bottega");
    // The emulator attributes the message to the token's seeded user.
    expect(messages[0].user).toBe(slack.users.findOneBy("name", "developer")!.user_id);
  });

  test("postMessage resolves with the created message ts", async () => {
    const ts = await adapter.postMessage(spaceIdFromChannel(opsChannel), "ts check");

    expect(ts).toBeDefined();
    const msg = slack.messages.all().find((m) => m.channel_id === opsChannel && m.ts === ts)!;
    expect(msg.text).toBe("ts check");
  });

  test("thread replies pass thread_ts through to the emulator", async () => {
    await adapter.postMessage(spaceIdFromChannel(opsChannel), "parent message");
    const parent = slack.messages
      .all()
      .find((m) => m.channel_id === opsChannel && m.text === "parent message")!;
    expect(parent.ts).toBeDefined();

    await adapter.postMessage(spaceIdFromChannel(opsChannel), "thread reply", {
      threadTs: parent.ts,
    });

    const reply = slack.messages
      .all()
      .find((m) => m.channel_id === opsChannel && m.thread_ts === parent.ts);
    expect(reply?.text).toBe("thread reply");

    // The emulator maintains the parent's thread bookkeeping.
    const updated = slack.messages
      .all()
      .find((m) => m.channel_id === opsChannel && m.ts === parent.ts)!;
    expect(updated.reply_count).toBe(1);
    expect(updated.reply_users).toContain(reply!.user);
  });

  test("updateMessage edits an existing message in place (chat.update)", async () => {
    await adapter.postMessage(spaceIdFromChannel(opsChannel), "before update");
    const original = slack.messages
      .all()
      .find((m) => m.channel_id === opsChannel && m.text === "before update")!;
    expect(original.ts).toBeDefined();
    const before = slack.messages.all().filter((m) => m.channel_id === opsChannel).length;

    await adapter.updateMessage(spaceIdFromChannel(opsChannel), original.ts, "after update");

    const updated = slack.messages
      .all()
      .find((m) => m.channel_id === opsChannel && m.ts === original.ts)!;
    expect(updated.text).toBe("after update");
    // Same message row — the edit replaced the text, it did not add a message.
    expect(slack.messages.all().filter((m) => m.channel_id === opsChannel)).toHaveLength(before);
  });

  test("auth.test resolves the seeded bot token against the emulator", async () => {
    // Installed @emulators/slack@0.9.0 routes auth.test on POST only (GET
    // 404s), and its seed ignores the configured team name.
    const res = await fetch(`${emu.baseUrl}/api/auth.test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BOT_TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; user: string; team_id: string };
    expect(body.ok).toBe(true);
    expect(body.user).toBe("developer");
    expect(body.team_id).toBe("T000000001");
  });
});
