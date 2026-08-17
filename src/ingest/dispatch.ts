/**
 * The single shared ingest dispatcher (issue #57): every inbound leg —
 * webhook route and scheduler poller — funnels through
 * {@link dispatchIngestEvent}. The dispatcher is the LAST fail-closed gate:
 * an event that fails validation is audited as `ingest.<leg>.rejected` and
 * NOTHING is created or posted; only a fully validated event reaches the
 * work-item row (the store's existing creation path), the Slack post (the
 * caller's postMessage seam) and the `ingest.<leg>.dispatch` audit row.
 *
 * Validation is deliberately split: the dispatcher owns the envelope
 * (provider, eventType, occurredAt, object payload) and the known event
 * payload schemas (github `mention`); provider legs MAY additionally bound
 * payloads upstream (github/payload.ts) — a buggy or missing upstream gate
 * can never slip an unvalidated event past this one.
 */
import { z } from "zod";
import type { AuditModule } from "../policy/audit";
import {
  INGEST_POLL_DISPATCH_EVENT,
  INGEST_POLL_REJECTED_EVENT,
  INGEST_WEBHOOK_DISPATCH_EVENT,
  INGEST_WEBHOOK_REJECTED_EVENT,
} from "../store/audit-events";
import type { Store } from "../store/db";
import type { IngestEvent } from "./types";

/** Everything the dispatcher needs; both legs adapt their own context to this. */
export interface IngestDispatchContext {
  store: Store;
  audit: AuditModule;
  /** SlackAdapter.postMessage-compatible (spaceId, text) → message ts. */
  postMessage: (spaceId: string, text: string) => Promise<string | undefined>;
  /** Sink for operational lines (e.g. rejection reasons); optional. */
  log?: (line: string) => void;
  /** Which inbound leg produced the event — drives the audit event name. */
  leg: "webhook" | "poll";
  /** Target Slack space for the work item + post (the org channel/DM). */
  spaceId: string;
}

/**
 * The normalized GitHub mention event (issue #57): an issue or pull request
 * that mentions the bot. Produced by the scheduler poller (search API) and
 * by the webhook leg (payload.ts normalizes webhook payloads to this shape).
 */
export const githubMentionPayloadSchema = z.object({
  kind: z.literal("mention"),
  /** "owner/name". */
  repo: z.string().min(1),
  number: z.number().int().positive(),
  isPullRequest: z.boolean(),
  title: z.string().min(1),
  /** https://github.com/<owner>/<repo>/issues/<number> (or /pull/). */
  url: z.string().url(),
  /** The issue/PR body (possibly a bounded snippet). */
  body: z.string(),
  author: z.string().min(1),
  /** ISO 8601 last-updated timestamp from the provider. */
  updatedAt: z.string(),
});
export type GithubMentionPayload = z.infer<typeof githubMentionPayloadSchema>;

const INGEST_PROVIDERS = ["github", "linear"] as const;

/** The event envelope, parsed at the dispatcher boundary (fail-closed gate). */
const ingestEnvelopeSchema = z.object({
  provider: z.enum(INGEST_PROVIDERS, {
    error: (issue) => `unknown provider: ${String(issue.input)}`,
  }),
  eventType: z.string().min(1, "eventType must be a non-empty string"),
  occurredAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "occurredAt is not a parseable timestamp",
  }),
  payload: z.record(z.string(), z.unknown(), { error: "payload must be a JSON object" }),
});

type Validation = { ok: true } | { ok: false; reason: string };

/** Envelope + known-payload validation. Fail closed: any doubt → rejected. */
function validateEvent(event: IngestEvent): Validation {
  const envelope = ingestEnvelopeSchema.safeParse(event);
  if (!envelope.success) {
    return { ok: false, reason: envelope.error.issues[0]?.message ?? "invalid ingest envelope" };
  }
  if (event.provider === "github" && event.eventType === "mention") {
    const parsed = githubMentionPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => issue.path.join(".") || issue.code);
      return { ok: false, reason: `invalid github mention payload: ${issues.join(", ")}` };
    }
  }
  return { ok: true };
}

/**
 * Dispatches one validated ingest event. Never throws for validation
 * failures (they are audited and dropped); store/post errors DO propagate
 * so the caller's own error path (route 500 / poller loud log) owns them.
 */
export async function dispatchIngestEvent(ctx: IngestDispatchContext, event: IngestEvent): Promise<void> {
  const dispatchEvent = ctx.leg === "webhook" ? INGEST_WEBHOOK_DISPATCH_EVENT : INGEST_POLL_DISPATCH_EVENT;
  const rejectedEvent = ctx.leg === "webhook" ? INGEST_WEBHOOK_REJECTED_EVENT : INGEST_POLL_REJECTED_EVENT;
  const actor = `ingest:${event.provider}`;

  const validation = validateEvent(event);
  if (!validation.ok) {
    ctx.log?.(`[ingest:${ctx.leg}] rejected ${String(event.provider)}/${String(event.eventType)}: ${validation.reason}`);
    await ctx.audit.appendAudit({
      space_id: ctx.spaceId,
      actor,
      event_type: rejectedEvent,
      payload: { provider: event.provider, event_type: event.eventType, reason: validation.reason },
    });
    return;
  }

  if (event.provider === "github" && event.eventType === "mention") {
    // SAFETY: validateEvent ran githubMentionPayloadSchema.safeParse on this
    // payload in the gate above and returned ok — the assertion is the
    // validated narrow view of the event payload.
    const payload = event.payload as GithubMentionPayload;
    const item = await ctx.store.createWorkItem({
      space_id: ctx.spaceId,
      requester: actor,
      description: `GitHub mention in ${payload.repo}#${payload.number}: ${payload.title}\n${payload.url}`,
      delivery: "extension",
      repo: payload.repo,
      evidence: [{ kind: "issue_url", url: payload.url }],
    });
    await ctx.postMessage(
      ctx.spaceId,
      `GitHub mention: ${payload.title} (${payload.repo}#${payload.number}) — ${payload.url}`,
    );
    await ctx.audit.appendAudit({
      space_id: ctx.spaceId,
      actor,
      event_type: dispatchEvent,
      payload: {
        provider: event.provider,
        event_type: event.eventType,
        url: payload.url,
        work_item_id: item.id,
        space_id: ctx.spaceId,
      },
    });
    return;
  }

  // Unknown event types fail closed: nothing dispatches until a schema exists.
  ctx.log?.(`[ingest:${ctx.leg}] rejected unsupported event type ${event.provider}/${event.eventType}`);
  await ctx.audit.appendAudit({
    space_id: ctx.spaceId,
    actor,
    event_type: rejectedEvent,
    payload: { provider: event.provider, event_type: event.eventType, reason: "unsupported event type" },
  });
}
