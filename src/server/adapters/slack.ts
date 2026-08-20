import { App, SocketModeReceiver, type AppOptions } from "@slack/bolt";
import { WebClient, type ChatAppendStreamArguments, type ChatPostMessageArguments, type ChatStartStreamArguments, type ChatStopStreamArguments, type FilesInfoResponse } from "@slack/web-api";
import type { ResponseMode } from "../../policy/config";
import { z } from "zod";
// Bun's undici shim lacks the `ping` export that @slack/socket-mode calls for
// WebSocket keepalive (`undici_1.ping(this.websocket, ...)` via CJS require —
// a call-time property read, so patching the exports object is effective).
// Without this, Socket Mode connections die with "Failed to send ping".
import undici from "undici";

// SAFETY: the undici default export is the module namespace object, and Bun's
// shim omits the `ping` export socket-mode reads via CJS require; the
// assertion only widens the namespace with the optional property patched below.
const undiciModule = undici as { ping?: (ws: WebSocket, data?: Uint8Array) => void };
if (undiciModule.ping === undefined) {
  undiciModule.ping = (ws, data) => {
    // SAFETY: socket-mode's keepalive calls ping(this.websocket, ...) with its
    // `ws` WebSocket instance, which owns ping(); the cast exposes that method
    // on the DOM WebSocket type used here.
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
  /** The inbound message's own Slack ts; the reply/receipt anchor. */
  ts: string;
  /**
   * The ROOT conversation thread when the inbound message is itself a
   * thread reply (the event's `thread_ts`). Undefined for top-level
   * messages. Preserved through to the turn presenter (issue #289) so a
   * threaded request's reply lands in the same conversation thread instead
   * of nesting a new thread under the latest inbound reply.
   */
  threadTs?: string;
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
 * Delivery-approval button action ids (issue #149); the poller's buttons
 * and the server's delivery resolver share these. Distinct from the
 * exec-tier approval ids: the button value carries a WORK ITEM id, not a
 * policy-approval request id, so the two routers never collide.
 */
export const DELIVERY_APPROVE_ACTION_ID = "bottega_delivery_approve";
export const DELIVERY_DENY_ACTION_ID = "bottega_delivery_deny";

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
   * as today, DMs become threaded only while streaming is active. Channel
   * streams REQUIRE the initiating user as `recipient_user_id` (issue
   * #287); without it the request is invalid, so the adapter throws
   * {@link SlackStreamRequestError} WITHOUT calling Slack and streaming
   * stays enabled for later turns that do carry a recipient. Resolves
   * with the stream's message ts once the stream opens. Throws when the
   * workspace/app lacks the Agents feature (or the call fails); a
   * scope/token-level failure is remembered for the boot so callers fall
   * back to the phrase+edit path without retrying per message, while a
   * request-local rejection never disables streaming for the boot.
   */
  startStream(
    spaceId: string,
    opts: { threadTs: string; openingText: string; recipientUserId?: string },
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
   * Feature-detected once per boot: true until a stream call fails with a
   * scope/token-level (capability) error flips it false for the rest of
   * the process. Request-local rejections (missing recipient or thread
   * args, issue #287) never flip it. Callers check it BEFORE opening a
   * stream so an unsupported workspace never pays the failed call more
   * than once.
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
 *
 * `bot_id` alone does NOT mean bot-authored: Slack stamps `bot_id` on ANY
 * message posted through the app's Web API — including a real user's
 * `chat.postMessage` with `as_user: true` (the QA canary's exact inbound
 * shape, issue #204). The event then carries the human's `user` id next to
 * the app's `bot_id`. Only the adapter's OWN bot posts (user id resolved
 * at start()) are bot-authored. When the bot identity is unknown (start()
 * not resolved) fail closed and drop rather than risk an echo loop.
 */
export function isBotMessage(
  event: Record<string, string | undefined>,
  botUserId?: string,
): boolean {
  if (event.subtype === "bot_message") return true;
  if (event.bot_id === undefined) return false;
  return event.user === botUserId || botUserId === undefined;
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

/** Raw Bolt `message` event — the fields this adapter reads; runtime-validated before use. */
interface RawSlackMessageEvent {
  type?: unknown;
  channel?: unknown;
  user?: unknown;
  ts?: unknown;
  text?: unknown;
  subtype?: unknown;
  bot_id?: unknown;
  thread_ts?: unknown;
  files?: unknown;
}

const slackMessageFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimetype: z.string(),
  size: z.number(),
});

/** The `{ files: [{ files: [{ id }] }] }` completion shape files.uploadV2 returns. */
const slackUploadResultSchema = z.object({
  files: z.array(z.object({ files: z.array(z.object({ id: z.string() })) })),
});

const slackMessageEventSchema = z.object({
  channel: z.string(),
  user: z.string(),
  ts: z.string(),
  text: z.string().optional(),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
  thread_ts: z.string().optional(),
  files: z.array(z.unknown()).optional(),
});

/**
 * Normalizes a raw Slack message event into a {@link SlackMessage}.
 *
 * Returns `null` for anything unparseable (missing channel/user/ts and
 * neither text nor files, non-object payloads, bot messages) instead of
 * throwing — the caller drops and logs those.
 *
 * `botUserId` is the adapter's own bot user id (resolved at start()); a
 * real user's API-posted message carries `bot_id` but a human `user`, so
 * bot-authored is decided against this id (issue #204).
 */
export function normalizeMessage(
  event: RawSlackMessageEvent | null | string | number | undefined,
  botUserId?: string,
): SlackMessage | null {
  const parsed = slackMessageEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const { channel, user, text, ts, subtype, bot_id, thread_ts, files } = parsed.data;
  if (isBotMessage({ bot_id, subtype, user }, botUserId)) return null;
  const normalizedFiles: NonNullable<SlackMessage["files"]> = [];
  if (files !== undefined) {
    for (const file of files) {
      const parsedFile = slackMessageFileSchema.safeParse(file);
      if (!parsedFile.success) continue;
      const { id, name, mimetype, size } = parsedFile.data;
      normalizedFiles.push({ id, name, mimeType: mimetype, size });
    }
  }
  if (text === undefined && !(files !== undefined && files.length > 0)) return null;
  return {
    spaceId: spaceIdFromChannel(channel),
    principal: user,
    text: text ?? "",
    ts,
    ...(thread_ts !== undefined ? { threadTs: thread_ts } : undefined),
    ...(normalizedFiles.length > 0 ? { files: normalizedFiles } : undefined),
  };
}

/**
 * Discriminates why a message event is dropped — bot-authored vs
 * unparseable — mirroring {@link normalizeMessage}'s null logic exactly:
 * zod failure or an event with neither text nor files is "unparseable";
 * the adapter's own bot posts (echo loop protection, issue #204) are
 * "bot-authored". `null` means the event is an acceptable inbound message.
 * Pure, so the drop-reason contract is unit-testable: a silent no-turn is
 * attributable from the log line alone (issue #212 follow-up — the legacy
 * combined log could not tell a bot echo from a malformed payload).
 */
export function messageDropReason(
  event: RawSlackMessageEvent | null | string | number | undefined,
  botUserId?: string,
): "bot-authored" | "unparseable" | null {
  const parsed = slackMessageEventSchema.safeParse(event);
  if (!parsed.success) return "unparseable";
  const { text, subtype, bot_id, user, files } = parsed.data;
  if (isBotMessage({ bot_id, subtype, user }, botUserId)) return "bot-authored";
  if (text === undefined && !(files !== undefined && files.length > 0)) return "unparseable";
  return null;
}

/** The unparseable drop detail: the zod failure path, or the empty-message
 * shape when the schema passed (no text and no files). */
function messageDropDetail(event: RawSlackMessageEvent | null | string | number | undefined): string {
  const parsed = slackMessageEventSchema.safeParse(event);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return issue !== undefined ? issue.path.join(".") || "unknown" : "unknown";
  }
  return "no text or files";
}

/** Raw Bolt block-action element — the clicked button; runtime-validated before use. */
interface RawSlackActionElement {
  type?: unknown;
  action_id?: unknown;
  value?: unknown;
}

/** Raw Bolt block_actions payload — the click context; runtime-validated before use. */
interface RawSlackActionBody {
  type?: unknown;
  channel?: { id?: unknown };
  user?: { id?: unknown };
  message?: { ts?: unknown };
}

const slackActionElementSchema = z.object({
  action_id: z.string(),
  value: z.string(),
});

const slackActionBodySchema = z.object({
  channel: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
  message: z.object({ ts: z.string() }),
});

/**
 * Normalizes a Bolt block-action payload into a {@link SlackAction}.
 *
 * `action` is the clicked element (carries `action_id` + `value`); `body` is
 * the full interactive payload (carries channel/user/message context).
 * Returns `null` for anything unparseable instead of throwing — the caller
 * drops and logs those.
 */
export function normalizeActionEvent(
  action: RawSlackActionElement | null,
  body: RawSlackActionBody | null,
): SlackAction | null {
  const element = slackActionElementSchema.safeParse(action);
  if (!element.success) return null;
  const context = slackActionBodySchema.safeParse(body);
  if (!context.success) return null;
  return {
    actionId: element.data.action_id,
    value: element.data.value,
    spaceId: spaceIdFromChannel(context.data.channel.id),
    principal: context.data.user.id,
    messageTs: context.data.message.ts,
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
    // The NUL-placeholder mask is intentional: code chunks are protected
    // with \0 sentinels that cannot appear in user text.
    /\0(\d+)\0/g,
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
) {
  const args = {
    channel: channelFromSpaceId(spaceId),
    text: renderSlackText(text),
    ...(opts?.threadTs !== undefined ? { thread_ts: opts.threadTs } : undefined),
    ...(opts?.blocks !== undefined ? { blocks: opts.blocks } : undefined),
  } satisfies { channel: string; text: string; thread_ts?: string; blocks?: unknown[] };
  return args;
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
) {
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
 * adapter from auth.test, absent for DMs. Channel streams ALSO require
 * the initiating user as `recipient_user_id` (issue #287) — carried by
 * the caller (the presenter threads the inbound message's principal).
 * DMs reject both recipient fields, so they stay absent there.
 */
export function buildStartStreamArgs(
  spaceId: string,
  opts: { threadTs: string; openingText: string; recipientUserId?: string },
  teamId?: string,
) {
  const channel = channelFromSpaceId(spaceId);
  const args = {
    channel,
    thread_ts: opts.threadTs,
    // Channels (C/G) require both the team id and the recipient user id;
    // DMs reject them. The presenter decides the thread ts and the
    // recipient; the adapter owns the Slack-side requirement.
    ...(isDmChannel(channel)
      ? undefined
      : {
          ...(teamId !== undefined ? { recipient_team_id: teamId } : undefined),
          ...(opts.recipientUserId !== undefined ? { recipient_user_id: opts.recipientUserId } : undefined),
        }),
    chunks: [markdownChunk(opts.openingText)],
  } satisfies {
    channel: string;
    thread_ts: string;
    recipient_team_id?: string;
    recipient_user_id?: string;
    chunks: StreamMarkdownChunk[];
  };
  return args;
}

/** Maps adapter arguments onto a `chat.appendStream` markdown_text append. */
export function buildAppendTextArgs(
  spaceId: string,
  ts: string,
  text: string,
) {
  return { channel: channelFromSpaceId(spaceId), ts, chunks: [markdownChunk(text)] };
}

/** Maps adapter arguments onto a `chat.appendStream` task_update append. */
export function buildAppendTaskArgs(
  spaceId: string,
  ts: string,
  task: SlackStreamTask,
) {
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
) {
  const args = {
    channel: channelFromSpaceId(spaceId),
    ts,
    ...(text !== undefined
      ? { blocks: [{ type: "section" as const, text: { type: "mrkdwn" as const, text: renderSlackText(text) } }] }
      : undefined),
  } satisfies {
    channel: string;
    ts: string;
    blocks?: Array<{ type: "section"; text: { type: "mrkdwn"; text: string } }>;
  };
  return args;
}

/** The `{ ok: false, error, needed?, provided? }` PlatformError payload when a thrown value carries one. */
const slackApiErrorSchema = z.object({
  data: z.object({
    error: z.string(),
    needed: z.string().optional(),
    provided: z.string().optional(),
  }),
});

/** A thrown value this adapter can classify: the PlatformError payload, an Error, or nothing. */
type SlackApiError = z.infer<typeof slackApiErrorSchema> | Error | undefined;

/**
 * The `error` code on a @slack/web-api PlatformError payload
 * (`{ ok: false, error: "…", needed?, provided? }`), when the thrown value
 * carries one. Runtime-narrowed: unknown shapes read as undefined.
 */
function streamErrorCode(err: SlackApiError): string | undefined {
  if (err instanceof Error || err === undefined) return undefined;
  return err.data.error;
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
export function isStreamingCapabilityError(err: SlackApiError): boolean {
  const code = streamErrorCode(err);
  return code === "missing_required_scope" || code === "not_allowed_token_type" || code === "invalid_auth";
}

/**
 * A `chat.startStream` request was invalid FOR THIS MESSAGE — not a
 * workspace capability failure (issue #287). Thrown by the adapter when a
 * channel stream call carries no recipient user id: the request could not
 * succeed, so it is never attempted. Callers (the presenter) fall back to
 * phrase+edit for THIS turn; streaming stays enabled for later turns.
 */
export class SlackStreamRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackStreamRequestError";
  }
}

/**
 * Slack `chat.startStream` error codes that mean the REQUEST was invalid
 * for this particular message (missing/invalid recipient, channel, or
 * thread arguments) — never that the workspace cannot stream (issue #287).
 * A failed call carrying one of these must not disable streaming for the
 * boot: the next message with valid arguments can still open a panel.
 */
const STREAM_REQUEST_VALIDATION_CODES = new Set([
  "missing_recipient_user_id",
  "invalid_channel",
  "channel_not_found",
  "not_in_channel",
  "is_in_trash",
  "ts_missing",
  "invalid_ts",
  "thread_not_found",
]);

/**
 * Whether a `chat.startStream` failure was the REQUEST's fault — a missing
 * or invalid recipient/thread argument for THIS message — rather than the
 * workspace's (issue #287). Request-validation failures stay local: the
 * caller falls back to phrase+edit for the turn while the per-boot
 * streaming cache stays enabled. Scope/token-level failures are capability
 * failures (see {@link isStreamingCapabilityError}); everything else keeps
 * the fail-closed cache flip.
 */
export function isStreamRequestValidationError(err: unknown): boolean {
  if (err instanceof SlackStreamRequestError) return true;
  if (err === undefined || typeof err !== "object") return false;
  // @slack/web-api's PlatformError extends Error but ALSO carries the
  // `{ ok, error, ... }` payload on `data` — decode it like the probe
  // does, so a request code on a thrown PlatformError is recognized.
  const parsed = slackApiErrorSchema.safeParse(err);
  if (parsed.success) return STREAM_REQUEST_VALIDATION_CODES.has(parsed.data.data.error);
  return false;
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
      ...(teamId !== undefined ? { recipient_team_id: teamId } : undefined),
      // Channel streams require the recipient user id (issue #287); the
      // probe is a well-formed request that fails only on the bogus
      // channel, so the failure code stays classifiable.
      recipient_user_id: "U00000000",
      chunks: [{ type: "markdown_text", text: "streaming capability probe" }],
    });
    // Unreachable with an invalid channel; fail open regardless.
    return { supported: true };
  } catch (err) {
    // Decode the thrown value at this boundary: the PlatformError payload,
    // an Error, or nothing — everything else is unclassifiable (supported).
    const parsed = slackApiErrorSchema.safeParse(err);
    const apiError: SlackApiError = parsed.success ? parsed.data : err instanceof Error ? err : undefined;
    return isStreamingCapabilityError(apiError)
      ? { supported: false, error: streamErrorCode(apiError) }
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
    const message = normalizeMessage(event, opts.botUserId?.());
    if (!message) {
      // The drop reason tells a bot echo from a malformed payload — a
      // silent no-turn is attributable from the log line alone (issue #212
      // follow-up; the legacy combined line could not).
      const drop = messageDropReason(event, opts.botUserId?.());
      logger.info(
        drop === "bot-authored"
          ? "slack: dropping message event (bot-authored)"
          : `slack: dropping message event (unparseable: ${messageDropDetail(event)})`,
      );
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
    logger.info(`slack: inbound ${message.spaceId} ${message.ts} text=${message.text.slice(0, 60)}`);
    await onMessage(message);
  });
}

/**
 * Routes block-action clicks (exec-tier `bottega_approve` / `bottega_deny`
 * issue #44, and delivery `bottega_delivery_approve` /
 * `bottega_delivery_deny` issue #149) to `onAction`. Unparseable payloads
 * are dropped and logged, never thrown. Exported so the inbound wiring is
 * testable hermetically through the real Bolt router (`App.processEvent`,
 * issue #29); the adapter installs it on its app when `onAction` is
 * provided.
 */
export function registerActionHandler(
  app: Pick<App, "action">,
  onAction: (a: SlackAction) => Promise<void>,
): void {
  app.action(/^bottega_(approve|deny|delivery_approve|delivery_deny)$/, async ({ action, body, ack, logger }) => {
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

/**
 * Socket-mode connection watchdog (issue #237).
 *
 * Why this exists: @slack/socket-mode v3 computes its own reconnection
 * backoff as `clientPingTimeout * consecutiveFailures`. This adapter pins
 * `clientPingTimeout` to 24h (a Bun workaround — under Bun, Slack's Socket
 * Mode server never pongs the client-ping monitor, so Bolt would kill a
 * healthy connection ~7s after (re)connect unless the monitor is silenced
 * with a huge timeout). The SDK's auto-reconnect would therefore wait ~24h
 * after a drop — a full day of dead-silence on the Slack side. We disable
 * the SDK's auto-reconnect (`autoReconnectEnabled: false`: every socket
 * close then surfaces as a `disconnected` event) and drive reconnection
 * ourselves with bounded exponential backoff, logging connect / reconnect /
 * failure with attempt counts and elapsed time.
 */

/** First reconnect comes this soon after a drop (SDK default with the 24h ping timeout: ~24h). */
export const SLACK_RECONNECT_BASE_DELAY_MS = 2_000;
/** Reconnect attempts never space out beyond this. */
export const SLACK_RECONNECT_MAX_DELAY_MS = 60_000;
export const SLACK_RECONNECT_BACKOFF_MULTIPLIER = 2;
/** A boot connect must reach `connected` within this or start() fails loud. */
export const SLACK_BOOT_CONNECT_TIMEOUT_MS = 60_000;

/** The socket-mode client surface the watchdog drives (real value: SocketModeReceiver#client). */
export interface SocketModeClientLike {
  on(event: string, listener: () => void): unknown;
  start(): Promise<unknown>;
}

export interface ReconnectWatchdogTiming {
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

/** connect: lifecycle-up INFO (console.log); failure: drop/retry ERROR (console.error). */
export interface ReconnectWatchdogLog {
  connect: (message: string) => void;
  failure: (message: string) => void;
}

/**
 * Watches a socket-mode client for drops and reconnects with bounded
 * backoff. Backoff scale is injectable so regression tests run on
 * millisecond timers. The returned `dispose()` must run from `stop()`
 * BEFORE the SDK shut-down: it marks the watchdog dormant so the
 * `disconnected` the SDK emits on a manual disconnect can never schedule a
 * reconnect (a stopped adapter stays stopped).
 */
export function watchSocketModeReconnect(
  client: SocketModeClientLike,
  log: ReconnectWatchdogLog,
  timing: ReconnectWatchdogTiming = {},
): { dispose(): void } {
  const baseDelayMs = timing.baseDelayMs ?? SLACK_RECONNECT_BASE_DELAY_MS;
  const maxDelayMs = timing.maxDelayMs ?? SLACK_RECONNECT_MAX_DELAY_MS;
  const multiplier = timing.backoffMultiplier ?? SLACK_RECONNECT_BACKOFF_MULTIPLIER;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Reconnect attempts since the last successful connect (0 while healthy). */
  let attempts = 0;
  let connectedAt: number | undefined;
  let lostAt: number | undefined;

  const backoff = (attempt: number): number =>
    Math.min(baseDelayMs * multiplier ** (attempt - 1), maxDelayMs);

  const handleConnected = (): void => {
    if (disposed) return;
    clearTimeout(timer);
    timer = undefined;
    const reconnectedAfter = attempts;
    const elapsedMs = lostAt !== undefined ? Date.now() - lostAt : 0;
    connectedAt = Date.now();
    lostAt = undefined;
    attempts = 0;
    if (reconnectedAfter > 0) {
      log.connect(
        `[slack] socket connected after ${reconnectedAfter} reconnect attempt(s) (${Math.round(elapsedMs / 1000)}s of reconnection)`,
      );
    } else {
      log.connect("[slack] socket connected");
    }
  };

  const handleDisconnected = (): void => {
    if (disposed) return;
    const attempt = attempts + 1;
    const uptime = connectedAt !== undefined ? Math.max(0, Math.round((Date.now() - connectedAt) / 1000)) : 0;
    lostAt = Date.now();
    log.failure(
      `[slack] socket-mode connection lost after ${uptime}s of uptime — reconnecting in ${backoff(attempt) / 1000}s (attempt ${attempt})`,
    );
    schedule(attempt);
  };

  const schedule = (attempt: number): void => {
    if (disposed) return;
    // Idempotent: a disconnect during an in-flight reconnect attempt can
    // race the attempt's own failure path — both converge on one timer.
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void fire(attempt);
    }, backoff(attempt));
  };

  const fire = async (attempt: number): Promise<void> => {
    if (disposed) return;
    lostAt = lostAt ?? Date.now();
    attempts = attempt;
    try {
      // Resolves once the client reaches `connected` (Slack hello); the
      // connected listener logs and resets the backoff. A drop during the
      // attempt rejects AND re-emits `disconnected` — the schedule() dedupe
      // makes both paths converge on the next bounded attempt.
      await client.start();
    } catch (err) {
      if (disposed) return;
      const detail = err instanceof Error ? err.message : String(err);
      const next = attempt + 1;
      log.failure(
        `[slack] reconnect attempt ${attempt} failed (${detail}) — retrying in ${backoff(next) / 1000}s (attempt ${next})`,
      );
      schedule(next);
    }
  };

  client.on("connected", handleConnected);
  client.on("disconnected", handleDisconnected);

  return {
    dispose(): void {
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
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
    // The SDK's own reconnect delay is clientPingTimeout * consecutiveFailures
    // — 24h with the timeout above, i.e. a full day of dead-silence after any
    // drop (issue #237). Reconnect is driven by the bounded watchdog below
    // instead; disabling auto-reconnect makes every socket close surface as a
    // `disconnected` event the watchdog reacts to.
    autoReconnectEnabled: false,
  });
  // Bounded reconnection on socket death (issue #237): sees the real
  // SocketModeClient's `connected`/`disconnected` lifecycle events and
  // re-drives client.start() with exponential backoff capped far below the
  // SDK's 24h. Logs connect / reconnect / failure with attempts + elapsed.
  const reconnectWatchdog = watchSocketModeReconnect(receiver.client, {
    connect: (message) => console.log(message),
    failure: (message) => console.error(message),
  });
  // When the Web API is pointed at an emulator/test stub
  // (clientOptions.slackApiUrl), a connection failure must fail fast —
  // NEVER enter the @slack/web-api default retry policy
  // (tenRetriesInAboutThirtyMinutes). The emulator is process-local, so a
  // "unreachable" emulator is a broken test (a stop/cleanup race, a
  // stolen port), and the default policy would turn one failed postMessage
  // into ~30 minutes of backoff timers — blocking the awaited delivery
  // announces / digest posts / harness turns and hanging the whole test
  // run. Same rule as the stream client (issue #181): one attempt, fail
  // fast. Production callers omit slackApiUrl and keep the default policy.
  const appClientOptions: AppOptions["clientOptions"] =
    opts.clientOptions !== undefined
      ? { ...opts.clientOptions, retryConfig: opts.clientOptions.retryConfig ?? STREAM_RETRY_CONFIG }
      : undefined;
  const app = new App({
    token: opts.botToken,
    receiver,
    // Bolt fires an unawaited auth.test at construction when this is on (the
    // token-verification default), leaving an unhandled rejection if the
    // token is bad. Socket-mode connect still authenticates via the app
    // token; auth failures surface as Bolt error events.
    tokenVerificationEnabled: false,
    clientOptions: appClientOptions,
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
    ...opts.clientOptions,
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
   * per message. Fail closed: any scope/token-level or unclassifiable
   * failure (missing feature, missing scope, rate limit, network) degrades
   * to the phrase+edit path, and the no-retry stream client guarantees the
   * failure arrives fast instead of a ~30-minute SDK retry storm.
   * Request-local rejections (missing/invalid recipient or thread args,
   * issue #287) never flip the cache: they are the message's fault, not
   * the workspace's, so a later valid request can still open a panel.
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
      // SAFETY: buildPostMessageArgs returns only chat.postMessage fields the
      // builder checked against its args contract; widening to the full SDK
      // args type only adds options this adapter leaves unset.
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
        file?.name === undefined ||
        file.mimetype === undefined ||
        file.size === undefined ||
        file.url_private_download === undefined
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
      // uploadV2's WebAPICallResult is untyped past `ok`; decode the nested
      // completion shape here so the returned file id is a validated string.
      const parsed = slackUploadResultSchema.safeParse(result);
      if (!parsed.success) return undefined;
      const file = parsed.data.files[0]?.files[0];
      return file?.id;
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
      // Channels require the initiating user as recipient_user_id (issue
      // #287): without it the request could never succeed, so it is never
      // attempted — the caller falls back to phrase+edit for THIS turn
      // while streaming stays enabled for later turns with a recipient.
      if (!isDmChannel(channelFromSpaceId(spaceId)) && streamOpts.recipientUserId === undefined) {
        throw new SlackStreamRequestError(
          `slack: chat.startStream needs a recipient_user_id for channel ${channelFromSpaceId(spaceId)} — skipping the stream`,
        );
      }
      try {
        // SAFETY: buildStartStreamArgs emits only chat.startStream fields the
        // builder checked against its args contract; widening to the SDK args
        // type adds only options this adapter leaves unset.
        const args = buildStartStreamArgs(spaceId, streamOpts, teamId) as ChatStartStreamArguments;
        const res = await streamClient.chat.startStream(args);
        return res.ts;
      } catch (err) {
        // A request-local rejection (missing/invalid recipient or thread
        // arguments, issue #287) is the REQUEST's fault, not the
        // workspace's: fall back to phrase+edit for this turn and keep
        // streaming enabled — a later message with valid arguments can
        // still open a panel.
        if (isStreamRequestValidationError(err)) {
          console.error(
            `[slack] chat.startStream rejected this request (${err instanceof Error ? err.message : String(err)}) — ` +
              "falling back to phrase+edit for this turn; streaming stays enabled",
          );
          throw err;
        }
        // Fail closed + cached: any other stream failure degrades the
        // workspace to the phrase+edit path for the rest of the boot. The
        // caller falls back immediately, so no reply is dropped. The
        // dedicated no-retry client guarantees the failure arrives fast —
        // never a ~30-minute SDK retry storm (issue #181).
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
        // SAFETY: buildAppendTextArgs emits only chat.appendStream fields the
        // builder checked against its args contract; widening to the SDK args
        // type adds only options this adapter leaves unset.
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
        // SAFETY: buildAppendTaskArgs emits only chat.appendStream fields the
        // builder checked against its args contract; widening to the SDK args
        // type adds only options this adapter leaves unset.
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
        // SAFETY: buildStopStreamArgs emits only chat.stopStream fields the
        // builder checked against its args contract; widening to the SDK args
        // type adds only options this adapter leaves unset.
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
        if (auth.ok && auth.user_id !== undefined) botUserId = auth.user_id;
        if (auth.ok && auth.team_id !== undefined) teamId = auth.team_id;
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
      // Boot-connect verification (issue #237): `app.start()` resolves only
      // once the socket reaches `connected` (Slack's hello handshake), so
      // resolving is the proof the websocket actually opened — the watchdog
      // logs "[slack] socket connected" at that point. Race it against a
      // bounded timeout so a hung connect (no hello, no close) fails loud
      // instead of silently booting a dead connector for hours.
      let bootTimer: ReturnType<typeof setTimeout> | undefined;
      const connect = app.start();
      const bootDeadline = new Promise<never>((_, reject) => {
        bootTimer = setTimeout(
          () =>
            reject(
              new Error(
                `Socket Mode boot connect timed out after ${SLACK_BOOT_CONNECT_TIMEOUT_MS / 1000}s without reaching connected (issue #237)`,
              ),
            ),
          SLACK_BOOT_CONNECT_TIMEOUT_MS,
        );
      });
      try {
        await Promise.race([connect, bootDeadline]);
      } catch (err) {
        console.error(`[slack] boot connect failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      } finally {
        clearTimeout(bootTimer);
        // Absorb a late rejection from the raced-away connect so it never
        // surfaces as an unhandled rejection; the watchdog still owns any
        // recovery if the socket lands after we gave up on the boot.
        void connect.catch(() => {});
      }
    },
    stop: async () => {
      // Stop the watchdog FIRST: the SDK emits `disconnected` on a manual
      // disconnect, and a stopped adapter must stay stopped (issue #237).
      reconnectWatchdog.dispose();
      await app.stop();
    },
  };
}
