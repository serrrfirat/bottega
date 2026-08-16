import { App, SocketModeReceiver, type AppOptions } from "@slack/bolt";
import type { ChatPostMessageArguments } from "@slack/web-api";
import type { ResponseMode } from "../../policy/config";
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
 * so no per-thread space ids). `updateMessage` rewrites an already-posted
 * message in place (`chat.update`), so a thinking phrase can become the
 * final reply without a second message.
 */

export interface SlackMessage {
  spaceId: string;
  principal: string;
  text: string;
  ts: string;
}

/** Approval button action ids (issue #44); the buttons and the router's action handler share these. */
export const APPROVE_ACTION_ID = "bottega_approve";
export const DENY_ACTION_ID = "bottega_deny";

/**
 * A normalized interactive-component event (issue #44): a block-action
 * button click carries the button's `action_id` and `value` (the approval
 * request id), plus the channel/user/message the click happened on.
 */
export interface SlackAction {
  actionId: string;
  value: string;
  spaceId: string;
  principal: string;
  messageTs: string;
}

export interface SlackAdapter {
  /** Posts a message; resolves with the created message ts (undefined when the API omits it). */
  postMessage(
    spaceId: string,
    text: string,
    opts?: { threadTs?: string; blocks?: unknown[] },
  ): Promise<string | undefined>;
  /** Replaces the text of an already-posted message (chat.update). */
  updateMessage(spaceId: string, ts: string, text: string): Promise<void>;
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
 * Direct-message channels use `D`-prefixed ids; public channels are `C`,
 * private groups `G`. DMs read naturally as a plain message, so replies
 * there skip threading (issue #40).
 */
export function isDmChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

/**
 * Pure bot-message predicate. Bot-authored messages carry a `bot_id`, and
 * Slack's own bot messages use the `bot_message` subtype.
 */
export function isBotMessage(event: Record<string, unknown>): boolean {
  return event.bot_id !== undefined || event.subtype === "bot_message";
}

/**
 * Mention-mode inbound predicate (issue #55): true for DMs (a DM is always a
 * direct request) and for channel messages whose text @mentions the bot.
 * Slack renders a mention as `<@U0XXX>` or `<@U0XXX|display>` — the prefix
 * match covers both forms. With no known bot id (pre-start) nothing can be
 * judged, so everything passes rather than silently dropping messages.
 */
export function isMentionedMessage(
  text: string,
  channelId: string,
  botUserId: string | undefined,
): boolean {
  if (isDmChannel(channelId)) return true;
  if (!botUserId) return true;
  return text.includes(`<@${botUserId}`);
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
 * Normalizes a Bolt block-action payload into a {@link SlackAction}.
 *
 * `action` is the clicked element (carries `action_id` + `value`); `body` is
 * the full interactive payload (carries channel/user/message context).
 * Returns `null` for anything unparseable instead of throwing — the caller
 * drops and logs those.
 */
export function normalizeActionEvent(action: unknown, body: unknown): SlackAction | null {
  if (typeof action !== "object" || action === null) return null;
  if (typeof body !== "object" || body === null) return null;
  const a = action as Record<string, unknown>;
  const b = body as Record<string, unknown>;
  const channel = b.channel as Record<string, unknown> | undefined;
  const user = b.user as Record<string, unknown> | undefined;
  const message = b.message as Record<string, unknown> | undefined;
  if (typeof a.action_id !== "string" || typeof a.value !== "string") return null;
  if (typeof channel?.id !== "string" || typeof user?.id !== "string" || typeof message?.ts !== "string") {
    return null;
  }
  return {
    actionId: a.action_id,
    value: a.value,
    spaceId: spaceIdFromChannel(channel.id),
    principal: user.id,
    messageTs: message.ts,
  };
}

/**
 * Renders Markdown-ish agent text as Slack mrkdwn (issue #84). Applied at
 * the post/update boundary so everything the adapter sends renders in Slack
 * instead of showing raw Markdown (`**bold**`, `# heading`, `- bullet`,
 * `[label](url)`, `---`).
 *
 * Scope rule: rewrite ONLY constructs whose Markdown form Slack renders
 * wrong and whose Slack form differs. Everything Slack already renders
 * correctly — `` `inline code` ``, ``` fenced blocks, `> quotes`, ~strike~,
 * single-marker `*bold*`/`_italic_`, `<@mention>`s, `:emoji:` — passes
 * through untouched. Single asterisks are deliberately not rewritten
 * (md-em vs Slack bold is ambiguous; corrupting correct Slack bold would be
 * worse than leaving md-em unrendered).
 */
export function renderSlackText(markdown: string): string {
  // Code (inline + fenced) is already valid Slack; protect it from the
  // line transforms so `-`/`*`/`#`/`---` inside code stay verbatim.
  const protectedChunks: string[] = [];
  const masked = markdown.replace(/```[\s\S]*?```|`[^`\n]+`/g, (chunk) => {
    protectedChunks.push(chunk);
    return `\u0000${protectedChunks.length - 1}\u0000`;
  });
  const converted = masked
    // **bold** → *bold* (md strong; Slack would show the ** literally).
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    // # heading → *heading* (Slack has no headings; bold is the closest).
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    // - / * / + line bullets → Slack's • bullets (leading indent kept).
    .replace(/^([ \t]*)[-+*][ \t]+(.+)$/gm, "$1• $2")
    // [label](url) → <url|label>.
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "<$2|$1>")
    // Standalone --- / *** / ___ rules → dropped (Slack shows the raw line).
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "");
  return converted.replace(
    /\u0000(\d+)\u0000/g,
    (_, index: string) => protectedChunks[Number(index)]!,
  );
}

/**
 * Maps adapter arguments onto `chat.postMessage` arguments. Pure so the
 * outbound rendering is testable without a live Slack connection. Text is
 * rendered to Slack mrkdwn (issue #84) before it leaves the adapter.
 */
export function buildPostMessageArgs(
  spaceId: string,
  text: string,
  opts?: { threadTs?: string; blocks?: unknown[] },
): { channel: string; text: string; thread_ts?: string; blocks?: unknown[] } {
  return {
    channel: channelFromSpaceId(spaceId),
    text: renderSlackText(text),
    ...(opts?.threadTs !== undefined ? { thread_ts: opts.threadTs } : {}),
    ...(opts?.blocks !== undefined ? { blocks: opts.blocks } : {}),
  };
}

/**
 * Maps adapter arguments onto `chat.update` arguments. Pure so the
 * in-place edit rendering is testable without a live Slack connection. Text
 * is rendered to Slack mrkdwn (issue #84) before it leaves the adapter.
 */
export function buildUpdateMessageArgs(
  spaceId: string,
  ts: string,
  text: string,
): { channel: string; ts: string; text: string } {
  return { channel: channelFromSpaceId(spaceId), ts, text: renderSlackText(text) };
}

export interface MessageHandlerOptions {
  /**
   * Per-space response mode (issue #55); defaults to `always` (today's
   * behavior). In `mention` spaces, channel messages that do not @mention
   * the bot are dropped before they reach the agent (no turn, no audit
   * noise); DMs always pass.
   */
  responseModeFor?: (spaceId: string) => ResponseMode | Promise<ResponseMode>;
  /** Current bot user id; undefined until the adapter resolves it at start(). */
  botUserId?: () => string | undefined;
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
  opts: MessageHandlerOptions = {},
): void {
  app.event("message", async ({ event, logger }) => {
    const message = normalizeMessage(event);
    if (!message) {
      logger.info("slack: dropping message event (unparseable or bot-authored)");
      return;
    }
    const mode = (await opts.responseModeFor?.(message.spaceId)) ?? "always";
    if (
      mode === "mention" &&
      !isMentionedMessage(message.text, channelFromSpaceId(message.spaceId), opts.botUserId?.())
    ) {
      logger.info("slack: dropping unmentioned channel message (response_mode=mention)");
      return;
    }
    await onMessage(message);
  });
}

/**
 * Routes block-action clicks (`bottega_approve` / `bottega_deny`, issue
 * #44) to `onAction`. Unparseable payloads are dropped and logged, never
 * thrown. Exported so the inbound wiring is testable hermetically through
 * the real Bolt router (`App.processEvent`, issue #29); the adapter
 * installs it on its app when `onAction` is provided.
 */
export function registerActionHandler(
  app: Pick<App, "action">,
  onAction: (a: SlackAction) => Promise<void>,
): void {
  app.action(/^bottega_(approve|deny)$/, async ({ action, body, ack, logger }) => {
    // Ack first: Slack retries unacked interactive payloads.
    await ack();
    const normalized = normalizeActionEvent(action, body);
    if (!normalized) {
      logger.info("slack: dropping action event (unparseable)");
      return;
    }
    await onAction(normalized);
  });
}

export function createSlackAdapter(opts: {
  appToken: string;
  botToken: string;
  onMessage: (m: SlackMessage) => Promise<void>;
  /** Interactive-component handler (approval buttons, issue #44); optional so headless callers omit it. */
  onAction?: (a: SlackAction) => Promise<void>;
  /**
   * WebClient options passthrough. Tests point the Web API at an emulator
   * (e.g. @emulators/slack) via `clientOptions.slackApiUrl`; production
   * callers omit it and Bolt talks to the real Slack API.
   */
  clientOptions?: AppOptions["clientOptions"];
  /**
   * Per-space response mode (issue #55); defaults to `always`. The mention
   * filter applies per message, so the mode is resolved fresh for each
   * inbound message (mode changes apply immediately for mention spaces).
   */
  responseModeFor?: (spaceId: string) => ResponseMode | Promise<ResponseMode>;
}): SlackAdapter {
  // Bolt's default socket-mode wiring pings Slack from the client every
  // ~1.6s and disconnects after 4 unanswered pings (monitorPingToSlack).
  // Under Bun, Slack's Socket Mode server never pongs our client pings, so
  // that monitor always kills the connection ~7s after (re)connect. Use an
  // explicit receiver with a 24h clientPingTimeout — the client-ping monitor
  // effectively never fires. Health checking continues via Bolt's
  // server-ping monitor (Slack pings us; Bun auto-pongs).
  const receiver = new SocketModeReceiver({
    appToken: opts.appToken,
    clientPingTimeout: 24 * 60 * 60 * 1000,
  });
  const app = new App({
    token: opts.botToken,
    receiver,
    // Bolt fires an unawaited auth.test at construction when this is on (the
    // token-verification default), leaving an unhandled rejection if the
    // token is bad. Socket-mode connect still authenticates via the app
    // token; auth failures surface as Bolt error events.
    tokenVerificationEnabled: false,
    clientOptions: opts.clientOptions,
  });

  // Resolved once at start via auth.test; the mention filter matches
  // `<@U0XXX>` in channel text and no event can arrive before the socket
  // connects.
  let botUserId: string | undefined;

  registerMessageHandler(app, opts.onMessage, {
    responseModeFor: opts.responseModeFor,
    botUserId: () => botUserId,
  });
  if (opts.onAction !== undefined) {
    registerActionHandler(app, opts.onAction);
  }

  return {
    async postMessage(spaceId, text, postOpts) {
      // blocks are built by the approval router as plain JSON; chat.postMessage
      // wants Slack's Block[] union — the shape is checked by the builder.
      const args = buildPostMessageArgs(spaceId, text, postOpts) as ChatPostMessageArguments;
      const res = await app.client.chat.postMessage(args);
      return res.ts;
    },
    async updateMessage(spaceId, ts, text) {
      await app.client.chat.update(buildUpdateMessageArgs(spaceId, ts, text));
    },
    start: async () => {
      // The bot's user id (issue #55): auth.test needs only the bot token
      // and is always allowed. A failed lookup leaves the id unset — mention
      // mode then passes everything rather than dropping messages it cannot
      // judge.
      try {
        const auth = await app.client.auth.test();
        if (auth.ok && typeof auth.user_id === "string") botUserId = auth.user_id;
      } catch (err) {
        console.error("[slack] failed to resolve bot user id (mention filtering disabled):", err);
      }
      await app.start();
    },
    stop: async () => {
      await app.stop();
    },
  };
}
