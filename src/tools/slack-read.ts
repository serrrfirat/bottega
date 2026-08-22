/**
 * slack_read (issue #340): the owned-space Slack read tool. Lets the space
 * agent hydrate context it needs to answer — a past reply, an in-flight
 * thread, the messages right before the turn — WITHOUT the runtime
 * auto-injecting history into every turn (the decision for issue #305:
 * keep the model's turn history + prefix cached; hydrate on demand).
 *
 * Scopes itself to the CALLER's own channel, by construction:
 * 1. The space id derives from the session context (issue #66 convention).
 * 2. The adapter derives the channel from that space id via
 *    `channelFromSpaceId`.
 * No channel selector ever reaches the tool, the wire, or the result.
 *
 * A missing history scope surfaces as a loud {@link SlackMissingReadScopeError}
 * baked into a {@link toolError} result — never a crash, never a fabricated
 * empty list (fail closed). Registered read-tier in the policy table.
 */
import type { AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import {
  READ_HISTORY_DEFAULT_LIMIT,
  SlackMissingReadScopeError,
  type SlackReadMessage,
} from "../server/adapters/slack";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import { toolError } from "./helpers";

export const slackReadArgsSchema = z
  .object({
    /** Read the full thread rooted at this message ts (conversations.replies, no `limit` — issue #215). */
    thread_ts: z.string().min(1).optional(),
    /** Cap the returned messages (history `limit`; bounds a thread read client-side). Max 100. */
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export interface SlackReadToolOpts {
  /**
   * The owned-space thread read (conversations.replies). The channel is
   * derived from the space id by the adapter — the tool never names a
   * channel. Optional (the adapter's read surface is optional); when absent
   * the thread branch fails closed with a clear diagnostic.
   */
  readThread?: (spaceId: string, threadTs: string) => Promise<SlackReadMessage[]>;
  /**
   * The owned-space history read (conversations.history): recent messages
   * in the space's own channel, channel derived from the space id. Optional
   * like readThread; the history branch fails closed when absent.
   */
  readHistory?: (spaceId: string, opts?: { limit?: number }) => Promise<SlackReadMessage[]>;
}

/**
 * The slack_read tool as an SDK {@link ToolDefinition} (issue #340): reads
 * the CALLING session's own Slack channel — a thread when `thread_ts` is
 * given, otherwise the recent top-level history. Read-tier via the policy
 * table. Own-channel by construction: the channel is always derived from
 * the session's space id; the tool accepts no channel selector. Fail
 * closed: an absent read seam, no session context, a missing history
 * scope, or any adapter failure returns a diagnostic — never a fabricated
 * or misleading empty "no messages" result.
 */
export function slackReadToolDefinition(opts: SlackReadToolOpts): ToolDefinition<typeof slackReadArgsSchema> {
  const tool: ToolDefinition<typeof slackReadArgsSchema> = {
    name: "slack_read",
    label: "Read Slack channel context",
    description:
      "Reads the current conversation's Slack channel to hydrate context from past messages. " +
      "With `thread_ts`, reads that thread (parent + replies, oldest first); without it, reads the recent " +
      "top-level history (up to `limit`, default 50). Returns plain-text messages with their author and " +
      "timestamp. Read-only: never mutates Slack. Scope-bound to this conversation's own channel — it " +
      "cannot read any other channel.",
    parameters: slackReadArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      // The channel is ALWAYS derived from the session's space id — there
      // is no channel argument (own-channel by construction). Fail closed
      // if the session context is missing.
      const spaceId = sessionIdFromFilePath(ctx?.sessionManager?.getSessionFile?.());
      if (!spaceId) {
        return toolError(
          "slack_read: could not resolve this conversation's space (no session context). " +
            "The channel is always derived from the session — there is no channel argument.",
        );
      }
      try {
        let messages: SlackReadMessage[];
        if (params.thread_ts !== undefined) {
          // Issue #215: conversations.replies sends NO `limit` (rejected on
          // some tiers); a caller `limit` bounds the result client-side.
          if (!opts.readThread) {
            return toolError("slack_read: the wired Slack adapter has no thread-read surface (readThread).");
          }
          const thread = await opts.readThread(spaceId, params.thread_ts);
          messages = params.limit !== undefined ? thread.slice(0, params.limit) : thread;
        } else {
          if (!opts.readHistory) {
            return toolError("slack_read: the wired Slack adapter has no history-read surface (readHistory).");
          }
          messages = await opts.readHistory(spaceId, { limit: params.limit ?? READ_HISTORY_DEFAULT_LIMIT });
        }
        return { content: [{ type: "text", text: JSON.stringify(messages) }] };
      } catch (err) {
        // Fail closed + loud: a missing history scope names the scope to
        // grant; any other failure is surfaced verbatim — never a crash,
        // never a fabricated empty list.
        if (err instanceof SlackMissingReadScopeError) return toolError(err.message);
        return toolError(`slack_read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
  return tool;
}