import { App, type AppOptions } from "@slack/bolt";
// Bun's undici shim lacks the `ping` export that @slack/socket-mode calls for
// WebSocket keepalive (`undici_1.ping(this.websocket, ...)` via CJS require —
// a call-time property read, so patching the exports object is effective).
// Without this, Socket Mode connections die with "Failed to send ping".
import undici from "undici";

if (typeof (undici as { ping?: unknown }).ping !== "function") {
  (undici as unknown as { ping: (ws: WebSocket, data?: Uint8Array) => void }).ping = (
    ws,
    data,
  ) => {
    (ws as WebSocket & { ping?: (d?: Uint8Array) => void }).ping?.(data);
  };
}

/**
 * Protocol-only Slack adapter (Socket Mode).
 *
 * Validates and normalizes inbound message events, and renders outbound
 * messages. It never touches the store or sessions directly — inbound
 * messages go to the `onMessage` callback, outbound goes through
 * `postMessage`. Replies in threads are supported via `opts.threadTs`
 * passthrough to `chat.postMessage` (v1: threads share the channel space,
 * so no per-thread space ids).
 */

export interface SlackMessage {
  spaceId: string;
  principal: string;
  text: string;
  ts: string;
}

export interface SlackAdapter {
  postMessage(spaceId: string, text: string, opts?: { threadTs?: string }): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const SPACE_PREFIX = "slack:";

/** Space id scheme: `slack:<channel_id>` (threads share the channel space in v1). */
export function spaceIdFromChannel(channelId: string): string {
  return `${SPACE_PREFIX}${channelId}`;
}

/** Inverse of {@link spaceIdFromChannel}; unprefixed ids pass through unchanged. */
export function channelFromSpaceId(spaceId: string): string {
  return spaceId.startsWith(SPACE_PREFIX) ? spaceId.slice(SPACE_PREFIX.length) : spaceId;
}

/**
 * Pure bot-message predicate. Bot-authored messages carry a `bot_id`, and
 * Slack's own bot messages use the `bot_message` subtype.
 */
export function isBotMessage(event: Record<string, unknown>): boolean {
  return event.bot_id !== undefined || event.subtype === "bot_message";
}

/**
 * Normalizes a raw Slack message event into a {@link SlackMessage}.
 *
 * Returns `null` for anything unparseable (missing channel/user/text/ts,
 * non-object payloads, bot messages) instead of throwing — the caller drops
 * and logs those.
 */
export function normalizeMessage(event: unknown): SlackMessage | null {
  if (typeof event !== "object" || event === null) return null;
  const raw = event as Record<string, unknown>;
  if (isBotMessage(raw)) return null;
  const { channel, user, text, ts } = raw;
  if (
    typeof channel !== "string" ||
    typeof user !== "string" ||
    typeof text !== "string" ||
    typeof ts !== "string"
  ) {
    return null;
  }
  return { spaceId: spaceIdFromChannel(channel), principal: user, text, ts };
}

/**
 * Maps adapter arguments onto `chat.postMessage` arguments. Pure so the
 * outbound rendering is testable without a live Slack connection.
 */
export function buildPostMessageArgs(
  spaceId: string,
  text: string,
  opts?: { threadTs?: string },
): { channel: string; text: string; thread_ts?: string } {
  const args: { channel: string; text: string; thread_ts?: string } = {
    channel: channelFromSpaceId(spaceId),
    text,
  };
  if (opts?.threadTs !== undefined) {
    args.thread_ts = opts.threadTs;
  }
  return args;
}

/**
 * Socket Mode delivers `message` events for all channel types the app is
 * scoped for (channels, groups, ims). Unparseable events and bot-authored
 * messages are dropped and logged, never thrown. Exported so the inbound
 * wiring is testable hermetically through the real Bolt router
 * (`App.processEvent`, issue #29); the adapter installs it on its app.
 */
export function registerMessageHandler(
  app: Pick<App, "event">,
  onMessage: (m: SlackMessage) => Promise<void>,
): void {
  app.event("message", async ({ event, logger }) => {
    const message = normalizeMessage(event);
    if (!message) {
      logger.info("slack: dropping message event (unparseable or bot-authored)");
      return;
    }
    await onMessage(message);
  });
}

export function createSlackAdapter(opts: {
  appToken: string;
  botToken: string;
  onMessage: (m: SlackMessage) => Promise<void>;
  /**
   * WebClient options passthrough. Tests point the Web API at an emulator
   * (e.g. @emulators/slack) via `clientOptions.slackApiUrl`; production
   * callers omit it and Bolt talks to the real Slack API.
   */
  clientOptions?: AppOptions["clientOptions"];
}): SlackAdapter {
  const app = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
    // Bolt fires an unawaited auth.test at construction when this is on (the
    // token-verification default), leaving an unhandled rejection if the
    // token is bad. Socket-mode connect still authenticates via the app
    // token; auth failures surface as Bolt error events.
    tokenVerificationEnabled: false,
    ...(opts.clientOptions !== undefined ? { clientOptions: opts.clientOptions } : {}),
  });

  registerMessageHandler(app, opts.onMessage);

  return {
    async postMessage(spaceId, text, postOpts) {
      await app.client.chat.postMessage(buildPostMessageArgs(spaceId, text, postOpts));
    },
    start: async () => {
      await app.start();
    },
    stop: async () => {
      await app.stop();
    },
  };
}
