import { App, SocketModeReceiver, type AppOptions } from "@slack/bolt";
import { WebClient, type ChatAppendStreamArguments, type ChatPostMessageArguments, type ChatStartStreamArguments, type ChatStopStreamArguments, type FilesInfoResponse } from "@slack/web-api";
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
  files?: Array<{ id: string; name: string; mimeType: string; size: number }>;
}

/**
 * One thinking-step card for the native thinking panel (issue #168).
 * Mirrors the `task_update` chunk the Slack API accepts TODAY (flat
 * `id`/`title`/`status` shape — the nested `task: { task_id, ... }` form
 * from the early 2025 docs is gone). Slack types stay inside the adapter;
 * the presenter only sees this normalized shape. Statuses: `in_progress`
 * opens a card, `complete` checks it off.
 */
export interface SlackStreamTask {
  id: string;
  title: string;
  status: "in_progress" | "complete";
  /** Rendered as the card's code block; must stay under Slack's 256-char task chunk cap. */
  output?: string;
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
  /** Downloads a Slack file and returns its normalized metadata and bytes. */
  downloadFile(
    fileId: string,
  ): Promise<{ name: string; mimeType: string; size: number; bytes: Uint8Array }>;
  /** Uploads bytes to a Slack channel and resolves with the created file id. */
  uploadFile(
    spaceId: string,
    name: string,
    mimeType: string,
    content: Uint8Array,
  ): Promise<string | undefined>;
  /**
   * Adds a reaction to the message at `ts` (receipt ack, issue #119).
   * `name` is the emoji name without colons, default `eyes` (👀). Callers
   * treat failures as non-fatal — a missing `reactions:write` scope
   * surfaces as a logged error, never a blocked turn.
   */
  addReaction(spaceId: string, ts: string, name?: string): Promise<void>;
  /** Removes the reaction from the message at `ts` once the reply lands (issue #119). */
  removeReaction(spaceId: string, ts: string, name?: string): Promise<void>;
  /**
   * Opens a streaming message (chat.startStream, issue #168) — the
   * Slack-native thinking panel. `openingText` streams as the first
   * markdown_text chunk (the thinking phrase becomes the stream opening).
   * Slack streams are ALWAYS threaded replies (`thread_ts` required), so
   * the caller supplies the inbound message ts — channels thread under it
   * as today, DMs become threaded only while streaming is active. Resolves
   * with the stream's message ts once the stream opens. Throws when the
   * workspace/app lacks the Agents feature (or the call fails); the
   * failure is remembered for the boot so callers fall back to the
   * phrase+edit path without retrying per message.
   */
  startStream(
    spaceId: string,
    opts: { threadTs: string; openingText: string },
  ): Promise<string | undefined>;
  /** Appends a markdown_text chunk to the stream at `ts` (chat.appendStream). */
  appendText(spaceId: string, ts: string, text: string): Promise<void>;
  /** Appends one thinking-step card to the stream at `ts` (chat.appendStream task_update). */
  appendTask(spaceId: string, ts: string, task: SlackStreamTask): Promise<void>;
  /**
   * Finalizes the stream at `ts` (chat.stopStream). `text` — the turn's
   * final reply — renders as the final mrkdwn section block below the
   * thinking panel; omit it to finalize with what was already streamed.
   */
  stopStream(spaceId: string, ts: string, text?: string): Promise<void>;
  /**
   * Whether the workspace/app supports chat streaming (issue #168).
   * Feature-detected once per boot: true until the first startStream
   * failure flips it false for the rest of the process. Callers check it
   * BEFORE opening a stream so an unsupported workspace never pays the
   * failed call more than once.
   */
  streamingSupported(): boolean;
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
 * Returns `null` for anything unparseable (missing channel/user/ts and
 * neither text nor files, non-object payloads, bot messages) instead of
 * throwing — the caller drops and logs those.
 */
export function normalizeMessage(event: unknown): SlackMessage | null {
  if (typeof event !== "object" || event === null) return null;
  const raw = event as Record<string, unknown>;
  if (isBotMessage(raw)) return null;
  const { channel, user, text, ts } = raw;
  const hasFiles = Array.isArray(raw.files) && raw.files.length > 0;
  const files: NonNullable<SlackMessage["files"]> = [];
  if (Array.isArray(raw.files)) {
    for (const file of raw.files) {
      if (typeof file !== "object" || file === null) continue;
      if (
        !("id" in file) ||
        typeof file.id !== "string" ||
        !("name" in file) ||
        typeof file.name !== "string" ||
        !("mimetype" in file) ||
        typeof file.mimetype !== "string" ||
        !("size" in file) ||
        typeof file.size !== "number"
      ) {
        continue;
      }
      files.push({ id: file.id, name: file.name, mimeType: file.mimetype, size: file.size });
    }
  }
  if (
    typeof channel !== "string" ||
    typeof user !== "string" ||
    typeof ts !== "string" ||
    (typeof text !== "string" && !hasFiles)
  ) {
    return null;
  }
  return {
    spaceId: spaceIdFromChannel(channel),
    principal: user,
    text: typeof text === "string" ? text : "",
    ts,
    ...(files.length > 0 ? { files } : {}),
  };
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

/**
 * Slack caps task_update / plan_update chunk text at 256 characters
 * (docs.slack.dev/reference/methods/chat.startStream); longer output is
 * truncated so a redacted args card never 400s the whole stream.
 */
export const STREAM_TASK_OUTPUT_MAX = 256;

/**
 * Retry policy for the dedicated stream client (issue #181): NO retries.
 * The @slack/web-api default (`tenRetriesInAboutThirtyMinutes`) retries ANY
 * failure — including the `ok:false` PlatformError a workspace without the
 * Agents feature returns — for ~30 minutes, silently hanging the turn.
 * Stream calls must fail fast: one attempt, the per-boot cache flips, the
 * phrase+edit fallback takes over.
 */
export const STREAM_RETRY_CONFIG = { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1, randomize: false };

/** Bounds every stream call (boot probe included): a hung connection fails fast, never blocks a turn. */
export const STREAM_CALL_TIMEOUT_MS = 10_000;

/** The markdown_text chunk: streamed reply text (issue #168). */
export interface StreamMarkdownChunk {
  type: "markdown_text";
  text: string;
}

/** The task_update chunk: one thinking-step card (issue #168). */
export interface StreamTaskUpdateChunk {
  type: "task_update";
  id: string;
  title: string;
  status: "in_progress" | "complete";
  output?: string;
}

export type StreamChunk = StreamMarkdownChunk | StreamTaskUpdateChunk;

/** The markdown_text chunk: streamed reply text (issue #168). */
export function markdownChunk(text: string): StreamMarkdownChunk {
  return { type: "markdown_text", text: renderSlackText(text) };
}

/** The task_update chunk: one thinking-step card (issue #168). */
export function taskUpdateChunk(task: SlackStreamTask): StreamTaskUpdateChunk {
  const output = task.output === undefined ? undefined : task.output.slice(0, STREAM_TASK_OUTPUT_MAX);
  return output === undefined
    ? { type: "task_update", id: task.id, title: task.title, status: task.status }
    : { type: "task_update", id: task.id, title: task.title, status: task.status, output };
}

/**
 * Maps adapter arguments onto `chat.startStream` arguments (issue #168).
 * Pure so the outbound rendering is testable without a live Slack
 * connection. Streams are always threaded replies; `recipient_team_id` is
 * required when streaming outside a DM (channels) — supplied by the real
 * adapter from auth.test, absent for DMs.
 */
export function buildStartStreamArgs(
  spaceId: string,
  opts: { threadTs: string; openingText: string },
  teamId?: string,
): { channel: string; thread_ts: string; recipient_team_id?: string; chunks: StreamMarkdownChunk[] } {
  const channel = channelFromSpaceId(spaceId);
  return {
    channel,
    thread_ts: opts.threadTs,
    // Channels (C/G) require the team id; DMs reject it. The presenter
    // decides the thread ts; the adapter owns the Slack-side requirement.
    ...(isDmChannel(channel) ? {} : teamId !== undefined ? { recipient_team_id: teamId } : {}),
    chunks: [markdownChunk(opts.openingText)],
  };
}

/** Maps adapter arguments onto a `chat.appendStream` markdown_text append. */
export function buildAppendTextArgs(
  spaceId: string,
  ts: string,
  text: string,
): { channel: string; ts: string; chunks: StreamMarkdownChunk[] } {
  return { channel: channelFromSpaceId(spaceId), ts, chunks: [markdownChunk(text)] };
}

/** Maps adapter arguments onto a `chat.appendStream` task_update append. */
export function buildAppendTaskArgs(
  spaceId: string,
  ts: string,
  task: SlackStreamTask,
): { channel: string; ts: string; chunks: StreamTaskUpdateChunk[] } {
  return { channel: channelFromSpaceId(spaceId), ts, chunks: [taskUpdateChunk(task)] };
}

/**
 * Maps adapter arguments onto `chat.stopStream` arguments (issue #168).
 * The turn's final reply renders as the final mrkdwn section block below
 * the thinking panel; omitted → the stream finalizes with what was already
 * appended.
 */
export function buildStopStreamArgs(
  spaceId: string,
  ts: string,
  text?: string,
): { channel: string; ts: string; blocks?: Array<{ type: "section"; text: { type: "mrkdwn"; text: string } }> } {
  return {
    channel: channelFromSpaceId(spaceId),
    ts,
    ...(text !== undefined
      ? { blocks: [{ type: "section" as const, text: { type: "mrkdwn" as const, text: renderSlackText(text) } }] }
      : {}),
  };
}

/**
 * The `error` code on a @slack/web-api PlatformError payload
 * (`{ ok: false, error: "…", needed?, provided? }`), when the thrown value
 * carries one. Runtime-narrowed: unknown shapes read as undefined.
 */
function streamErrorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== "object" || !("data" in err)) return undefined;
  const data = err.data;
  if (data === null || typeof data !== "object" || !("error" in data)) return undefined;
  return typeof data.error === "string" ? data.error : undefined;
}

/**
 * Whether a chat.startStream failure PROVES the workspace cannot stream
 * (issue #181): a scope/token-level error — the app lacks `assistant:write`
 * or the Agents feature — versus a channel-level error (invalid channel,
 * missing ts), which only means the probe's dummy channel was rejected and
 * the token CAN stream. Fail closed: any error we cannot classify as a
 * scope/token problem counts as supported — the probe is an optimization;
 * the first real stream call still fails fast (no-retry client) and flips
 * the per-boot cache.
 */
export function isStreamingCapabilityError(err: unknown): boolean {
  const code = streamErrorCode(err);
  return code === "missing_required_scope" || code === "not_allowed_token_type" || code === "invalid_auth";
}

/**
 * PRODUCTION streaming feature-detect (issue #181): a FAST, bounded probe —
 * one no-retry `chat.startStream` attempt against a deliberately invalid
 * channel, so a supported workspace fails with a channel-level error and
 * NOTHING is posted, while a workspace missing `assistant:write` / the
 * Agents feature fails with the scope/token error that proves it cannot
 * stream. Runs once at boot; the result is cached per boot (the adapter's
 * `streamingCapable`) and logged with the failure as evidence.
 */
export async function probeStreamingSupport(client: WebClient, teamId: string | undefined): Promise<{
  supported: boolean;
  error?: string;
}> {
  try {
    await client.chat.startStream({
      channel: "C00000000", // deliberately invalid: never opens a visible stream
      thread_ts: "1.000000",
      ...(teamId !== undefined ? { recipient_team_id: teamId } : {}),
      chunks: [{ type: "markdown_text", text: "streaming capability probe" }],
    });
    // Unreachable with an invalid channel; fail open regardless.
    return { supported: true };
  } catch (err) {
    return isStreamingCapabilityError(err)
      ? { supported: false, error: streamErrorCode(err) }
      : { supported: true };
  }
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
   * Streaming-capability override (issue #179): the e2e harness points the
   * real adapter at the Slack emulator, which has no chat.startStream /
   * appendStream surface — its unknown-route 404 makes the WebClient retry
   * for ~30 minutes, hanging the turn's stream open and silently dropping
   * the phrase. Emulator journeys pass `() => false` so the phrase +
   * in-place-edit fallback path is exercised deterministically, exactly as
   * a workspace without the Agents feature would behave. Production
   * callers omit it: the adapter's per-boot capability cache applies.
   */
  streamingSupported?: () => boolean;
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
  /**
   * Dedicated client for chat.startStream/appendStream/stopStream ONLY
   * (issue #181): the @slack/web-api default retry policy
   * (tenRetriesInAboutThirtyMinutes) retries ANY failure — including the
   * `ok:false` PlatformError a workspace without the Agents feature
   * returns — for ~30 minutes, silently hanging the turn. Stream calls
   * never retry: one attempt, fail fast, the per-boot cache flips, the
   * phrase+edit fallback takes over. All other calls keep the default
   * policy on `app.client`.
   */
  const streamClient = new WebClient(opts.botToken, {
    ...(opts.clientOptions ?? {}),
    retryConfig: STREAM_RETRY_CONFIG,
    timeout: STREAM_CALL_TIMEOUT_MS,
  });

  // Resolved once at start via auth.test; the mention filter matches
  // `<@U0XXX>` in channel text and no event can arrive before the socket
  // connects.
  let botUserId: string | undefined;
  /**
   * Team id from auth.test (issue #168): required by chat.startStream when
   * streaming to channels (`recipient_team_id`); absent until start() and
   * never needed for DMs.
   */
  let teamId: string | undefined;
  /**
   * Per-boot streaming capability cache (issue #168/#181): probed once at
   * start() with a fast, bounded capability probe; assumed true until the
   * first stream call failure flips it false for the rest of the process —
   * a workspace without the Agents feature is detected once, never probed
   * per message. Fail closed: any failure (missing feature, missing scope,
   * missing recipient_team_id, rate limit, network) degrades to the
   * phrase+edit path, and the no-retry stream client guarantees the
   * failure arrives fast instead of a ~30-minute SDK retry storm.
   */
  let streamingCapable = true;

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
    async downloadFile(fileId) {
      let info: FilesInfoResponse;
      try {
        info = await app.client.files.info({ file: fileId });
      } catch (cause) {
        throw new Error(`slack: files.info failed for file ${fileId}`, { cause });
      }
      const file = info.file;
      if (
        typeof file?.name !== "string" ||
        typeof file.mimetype !== "string" ||
        typeof file.size !== "number" ||
        typeof file.url_private_download !== "string"
      ) {
        throw new Error(`slack: files.info returned incomplete metadata for file ${fileId}`);
      }
      let response: Response;
      try {
        response = await fetch(file.url_private_download, {
          headers: { Authorization: `Bearer ${opts.botToken}` },
        });
      } catch (cause) {
        throw new Error(`slack: download request failed for file ${fileId}`, { cause });
      }
      if (!response.ok) {
        throw new Error(
          `slack: download request failed for file ${fileId} (${response.status} ${response.statusText})`,
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (cause) {
        throw new Error(`slack: failed to read downloaded file ${fileId}`, { cause });
      }
      return {
        name: file.name,
        mimeType: file.mimetype,
        size: file.size,
        bytes,
      };
    },
    async uploadFile(spaceId, name, _mimeType, content) {
      // files.uploadV2 infers MIME from the filename extension; its binary
      // input is a Buffer rather than the caller-facing Uint8Array.
      const result = await app.client.files.uploadV2({
        channel_id: channelFromSpaceId(spaceId),
        filename: name,
        file: Buffer.from(content),
      });
      if (!("files" in result) || !Array.isArray(result.files)) return undefined;
      const completion = result.files[0];
      if (
        typeof completion !== "object" ||
        completion === null ||
        !("files" in completion) ||
        !Array.isArray(completion.files)
      ) {
        return undefined;
      }
      const file = completion.files[0];
      if (typeof file !== "object" || file === null || !("id" in file)) return undefined;
      return typeof file.id === "string" ? file.id : undefined;
    },
    async addReaction(spaceId, ts, name) {
      await app.client.reactions.add({
        channel: channelFromSpaceId(spaceId),
        name: name ?? "eyes",
        timestamp: ts,
      });
    },
    async removeReaction(spaceId, ts, name) {
      await app.client.reactions.remove({
        channel: channelFromSpaceId(spaceId),
        name: name ?? "eyes",
        timestamp: ts,
      });
    },
    async startStream(spaceId, streamOpts) {
      // Feature-detect once per boot: a known-unsupported workspace never
      // pays another failed call (the first failure flipped the flag). An
      // explicit capability override (issue #179) wins the same way: a
      // workspace reported as streaming-less never attempts the call.
      if (!streamingCapable || (opts.streamingSupported !== undefined && !opts.streamingSupported())) {
        throw new Error("slack: chat streaming unsupported in this workspace (cached from an earlier failure)");
      }
      try {
        const args = buildStartStreamArgs(spaceId, streamOpts, teamId) as ChatStartStreamArguments;
        const res = await streamClient.chat.startStream(args);
        return res.ts;
      } catch (err) {
        // Fail closed + cached: any stream failure degrades the workspace
        // to the phrase+edit path for the rest of the boot. The caller
        // falls back immediately, so no reply is dropped. The dedicated
        // no-retry client guarantees the failure arrives fast — never a
        // ~30-minute SDK retry storm (issue #181).
        streamingCapable = false;
        console.error(
          `[slack] chat.startStream failed (${err instanceof Error ? err.message : String(err)}) — ` +
            "disabling streaming for this boot; falling back to phrase+edit",
        );
        throw err;
      }
    },
    async appendText(spaceId, ts, text) {
      try {
        await streamClient.chat.appendStream(
          buildAppendTextArgs(spaceId, ts, text) as ChatAppendStreamArguments,
        );
      } catch (err) {
        streamingCapable = false;
        console.error(
          `[slack] chat.appendStream (markdown) failed (${err instanceof Error ? err.message : String(err)}) — ` +
            "disabling streaming for this boot; falling back to phrase+edit",
        );
        throw err;
      }
    },
    async appendTask(spaceId, ts, task) {
      try {
        await streamClient.chat.appendStream(
          buildAppendTaskArgs(spaceId, ts, task) as ChatAppendStreamArguments,
        );
      } catch (err) {
        streamingCapable = false;
        console.error(
          `[slack] chat.appendStream (task_update) failed (${err instanceof Error ? err.message : String(err)}) — ` +
            "disabling streaming for this boot; falling back to phrase+edit",
        );
        throw err;
      }
    },
    async stopStream(spaceId, ts, text) {
      try {
        await streamClient.chat.stopStream(buildStopStreamArgs(spaceId, ts, text) as ChatStopStreamArguments);
      } catch (err) {
        streamingCapable = false;
        console.error(
          `[slack] chat.stopStream failed (${err instanceof Error ? err.message : String(err)}) — ` +
            "disabling streaming for this boot; falling back to phrase+edit",
        );
        throw err;
      }
    },
    streamingSupported: () => (opts.streamingSupported !== undefined ? opts.streamingSupported() : streamingCapable),
    start: async () => {
      // The bot's user id (issue #55) and team id (issue #168): auth.test
      // needs only the bot token and is always allowed. A failed lookup
      // leaves both unset — mention mode then passes everything rather
      // than dropping messages it cannot judge, and channel streams omit
      // recipient_team_id (startStream then fails once and flips the
      // streaming cache, degrading to phrase+edit).
      try {
        const auth = await app.client.auth.test();
        if (auth.ok && typeof auth.user_id === "string") botUserId = auth.user_id;
        if (auth.ok && typeof auth.team_id === "string") teamId = auth.team_id;
      } catch (err) {
        console.error("[slack] failed to resolve bot user id (mention filtering disabled):", err);
      }
      // PRODUCTION streaming feature-detect (issue #181): a fast, bounded
      // probe once per boot — cached per boot, logged with evidence. An
      // explicit capability override (issue #179, e2e harness) already IS
      // the decision, so the probe is skipped. The probe needs teamId
      // (recipient_team_id) to make a well-formed channel call: without it
      // the only error would be an arg-level one that discriminates
      // nothing, so skip the probe and let the first real stream call
      // fail fast on the no-retry client instead. A probe that cannot
      // prove "unsupported" leaves the cache at its assumed-true default.
      if (opts.streamingSupported === undefined && teamId !== undefined) {
        const probe = await probeStreamingSupport(streamClient, teamId);
        streamingCapable = probe.supported;
        if (probe.supported) {
          console.log("[slack] streaming supported: chat.startStream capability probe passed — thinking panel enabled");
        } else {
          console.error(
            `[slack] streaming unsupported: ${probe.error ?? "unknown"} — using the phrase+edit fallback for this boot`,
          );
        }
      }
      await app.start();
    },
    stop: async () => {
      await app.stop();
    },
  };
}
