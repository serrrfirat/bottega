/**
 * GitHub webhook payload validation + bounding (issue #57): the mention
 * event shape — a comment on an issue/PR whose body @mentions the bot —
 * validated, bounded, and normalized to the framework's canonical
 * {@link GithubMentionPayload} (the SAME shape the scheduler poller
 * produces, so the shared dispatcher's single github `mention` schema
 * serves both legs). Fail closed: anything that is not a well-formed,
 * bounded mention event is rejected (or acknowledged-and-skipped for valid
 * but non-actionable deliveries like GitHub's `ping`), never dispatched.
 *
 * Validation happens AFTER signature verification (the route order): the
 * signature authenticates the sender, this module bounds + shapes what
 * the authenticated sender is allowed to inject.
 */
import { z } from "zod";
import { isRecord, type JsonValue } from "../../extensions/manifest";
import type { GithubMentionPayload } from "../dispatch";
import type { IngestEvent } from "../types";

/** Raw webhook body cap (bytes): generous for GitHub payloads, small enough to bound memory. */
export const MAX_WEBHOOK_RAW_BODY_BYTES = 1_048_576; // 1 MiB

/** Normalized comment-body cap (chars): the work item / Slack post text stays bounded. */
export const MAX_COMMENT_BODY_CHARS = 4_000;

const TRUNCATION_MARKER = "\n…[truncated]";

/** The parse outcome: dispatchable mention | valid-but-skipped | malformed (rejected). */
export type GitHubMentionParse =
  | { ok: true; actionable: true; payload: GithubMentionPayload }
  | { ok: true; actionable: false; reason: "ping" | "not_a_mention" | "unsupported_action" }
  | { ok: false; status: 400 | 422; reason: "malformed" | "missing_fields" };

/** The bot's GitHub login, @mentioned in comment bodies (overridable per deployment). */
export const DEFAULT_BOT_LOGIN = "bottega";

/** The raw mention event fields, validated at the webhook boundary (issue #57). */
const commentFieldsSchema = z.object({
  body: z.string().min(1),
  html_url: z.string().min(1),
  created_at: z.string().optional(),
});
const targetFieldsSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().min(1),
  title: z.string().min(1),
});
const rawMentionEventSchema = z.object({
  action: z.string().min(1),
  comment: commentFieldsSchema,
  sender: z.object({ login: z.string().min(1) }),
  repository: z.object({ full_name: z.string().min(1), html_url: z.string().min(1) }),
  issue: targetFieldsSchema.optional(),
  pull_request: targetFieldsSchema.optional(),
});

/** Cuts the comment body to the cap, appending the truncation marker (bounding). */
function boundBody(body: string): string {
  if (body.length <= MAX_COMMENT_BODY_CHARS) return body;
  return body.slice(0, MAX_COMMENT_BODY_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** Case-insensitive word-boundary mention check: `@<login>` anywhere in the body. */
function mentionsBot(body: string, botLogin: string): boolean {
  const escaped = botLogin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\W)@${escaped}(?=$|\\W)`, "i").test(body);
}

/**
 * Validates + bounds a parsed GitHub webhook payload. `raw` is the
 * JSON-parsed body (the route rejects unparseable JSON before this).
 *
 * Fail-closed outcomes:
 * - not an object / wrong field types / missing required fields →
 *   `{ok: false}` (the route writes `ingest.webhook.rejected`).
 * - GitHub's `ping` probe, a non-`created` action, or a comment that does
 *   not @mention the bot → `{ok: true, actionable: false}` (valid
 *   delivery, nothing to do — acknowledged, never rejected).
 * - a well-formed mention → the canonical, bounded mention payload the
 *   shared dispatcher consumes.
 */
export function parseGitHubMentionEvent(
  raw: JsonValue,
  opts: { botLogin?: string } = {},
): GitHubMentionParse {
  const botLogin = opts.botLogin ?? DEFAULT_BOT_LOGIN;
  if (!isRecord(raw)) return { ok: false, status: 400, reason: "malformed" };

  // GitHub's configuration probe: {zen, hook_id}. A valid, non-actionable
  // delivery — acknowledge so the webhook registers, never dispatch.
  if (z.string().safeParse(raw.zen).success && z.number().finite().safeParse(raw.hook_id).success) {
    return { ok: true, actionable: false, reason: "ping" };
  }

  // The mention shape, validated at the boundary: any doubt → missing_fields
  // (fail closed). The target is PR comments' top-level pull_request, or the
  // issue timeline's `issue` — both carry the number/html_url/title shape.
  const parsed = rawMentionEventSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 422, reason: "missing_fields" };
  const { action, comment, sender, repository, pull_request, issue } = parsed.data;
  const target = pull_request ?? issue;
  if (target === undefined) return { ok: false, status: 422, reason: "missing_fields" };

  if (action !== "created") {
    return { ok: true, actionable: false, reason: "unsupported_action" };
  }
  if (!mentionsBot(comment.body, botLogin)) {
    return { ok: true, actionable: false, reason: "not_a_mention" };
  }

  const payload: GithubMentionPayload = {
    kind: "mention",
    repo: repository.full_name,
    number: target.number,
    isPullRequest: pull_request !== undefined,
    title: target.title,
    url: target.html_url,
    body: boundBody(comment.body),
    author: sender.login,
    updatedAt: comment.created_at || new Date().toISOString(),
  };
  return { ok: true, actionable: true, payload };
}

/**
 * Builds the dispatchable {@link IngestEvent} from a validated mention
 * payload — the canonical `mention` eventType the shared dispatcher serves
 * (the wire event type rides the rejected-audit trail).
 */
export function githubMentionEvent(payload: GithubMentionPayload): IngestEvent {
  return {
    provider: "github",
    eventType: "mention",
    payload,
    occurredAt: payload.updatedAt,
  };
}
