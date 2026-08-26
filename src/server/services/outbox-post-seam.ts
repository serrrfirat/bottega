/**
 * Server post seam (epic #170 item 3, issue #187): the worker→server
 * delivery leg. The executor container never holds Slack tokens (credential
 * boundary, issue #9) — it signals a completed job by writing an outbox row
 * (src/store/outbox.ts, the Wave-1 seam). THIS module is the server side:
 * it polls {@link consumeOutboxWatermarked} on the delivery-poller cadence,
 * posts each consumed row's result to the row's space via the Slack
 * adapter, and audits `outbox.posted`. A failed post is audited
 * `outbox.failed` and requeued for a bounded number of attempts
 * ({@link DEFAULT_OUTBOX_MAX_POST_ATTEMPTS}, tracked in the row's
 * `attempts` column), then marked failed (terminal). The same tick routes
 * {@link nudgeUnclaimedOutboxRows} to the Slack nudge: a completed row no
 * consumer picked up within the TTL surfaces as `job.unclaimed` + a visible
 * post — fail-loud (epic #170), exactly once (the row is terminal).
 *
 * Crash-window decision — at-most-once per row, per the Wave-1 contract:
 * `consumeOutboxWatermarked` marks the row posted ATOMICALLY at consume
 * time, BEFORE this seam's Slack post. A crash between the consume and the
 * post drops that delivery — the row is never re-read (posted rows are
 * filtered by status), so the result never duplicates. That is the
 * deliberate trade: the alternative (post-then-mark) can double-post on a
 * crash or retry, and a duplicate user-facing post is worse than a rare
 * lost one. The gap is diagnosable, not silent: the row's posted_at lands
 * without a matching `outbox.posted` audit row (written only after a
 * successful post), and one id threads enqueue → claim → run → outbox →
 * post. The retry path is restart-safe: a requeued row is simply pending
 *
 * The consumer cursor: every pass consumes from a FRESH cursor (no
 * watermark state) — the Wave-1 consumer marks rows posted atomically, so
 * the row status, not cursor memory, is the dedupe across passes and
 * restarts (the Wave-1 consumer contract). A fresh cursor also keeps the
 * bounded-retry requeue sound: a requeued row (pending again, created_at
 * bumped to now so it never reads stale while retrying) is picked up
 * regardless of any cursor position.
 */
import { z } from "zod";
import { issueCard, openWorkReviewButton, retryWithContextButton, type SlackBlock } from "../adapters/blocks";
import { OUTBOX_FAILED_EVENT, OUTBOX_POSTED_EVENT } from "../../store/audit-events";
import type { Store } from "../../store/db";
import {
  consumeOutboxWatermarked,
  failOutboxRow,
  nudgeUnclaimedOutboxRows,
  requeueOutboxRow,
  type OutboxRow,
} from "../../store/outbox";
import type { SlackAdapter } from "../adapters/slack";
import { dispatchIngestEvent } from "../../ingest/dispatch";
import { createAudit } from "../../policy/audit";
import { startReactiveCore } from "../../events/reactive";
import type { ReactiveBehavior } from "../../events/reactive";

/** Post-seam pass interval. Default 5000 ms — the delivery poller's cadence. */
export const DEFAULT_OUTBOX_POST_INTERVAL_MS = 5000;

/** Bounded post retries per outbox row. Default 5 — the job bus's attempt bound. */
export const DEFAULT_OUTBOX_MAX_POST_ATTEMPTS = 5;

export interface OutboxPostSeamDeps {
  /** Full store: the watermarked consumer, the audit sink, and the row helpers. */
  store: Store;
  /** Only postMessage is used; a full SlackAdapter also satisfies this. */
  adapter: Pick<SlackAdapter, "postMessage">;
  /** Pass interval. Default 5000 ms. */
  intervalMs?: number;
  /** Bounded post retries per row. Default 5. */
  maxPostAttempts?: number;
  /** Unclaimed TTL for the nudge leg. Default: the store seam's 5-minute TTL. */
  olderThanMs?: number;
  log?: (line: string) => void;
}

export interface OutboxPostSeam {
  start(): void;
  stop(): void;
}

/** The outbox payload the executor writes on completion: {state, result}. */
const outboxPayloadSchema = z.object({
  state: z.string().optional(),
  result: z.unknown().optional(),
});

/** Known result fields for the one-line render (display only; unknown shapes fall back). */
const resultSummarySchema = z
  .object({
    summary: z.string().optional(),
    pr_url: z.string().optional(),
    url: z.string().optional(),
    source: z.string().optional(),
    count: z.number().optional(),
  })
  .passthrough();

/**
 * The work_item notification payload (issue #159): the executor writes one
 * outbox row per blocked/review landing; the seam posts it as a short line.
 */
const workItemNotificationSchema = z
  .object({
    state: z.enum(["blocked", "review"]),
    workItemId: z.string(),
    description: z.string(),
    evidence: z.string().optional(),
    /** Optional link (e.g. a PR or issue URL) rendered in the issue card. */
    link: z.string().optional(),
  })
  .passthrough();

/**
 * The ingest_poll outcome payload (issue #101): the worker's split
 * fetch/validate leg ships ONLY validated events in the result's `events`
 * array; this seam re-validates per event (defense in depth) then dispatches
 * in-process — dispatch + Slack post stay server-side (the server holds the
 * Slack tokens).
 */
const ingestEventSchema = z.object({
  provider: z.enum(["github", "linear"]),
  eventType: z.string(),
  payload: z.unknown(),
  occurredAt: z.string(),
});

const ingestPollOutcomeSchema = z.object({
  state: z.string().optional(),
  result: z
    .object({
      provider: z.string(),
      events: z.array(ingestEventSchema).default([]),
    })
    .optional(),
});

function parsePayload(raw: string): { state?: string; result?: unknown } | null {
  try {
    const parsed = outboxPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Parses a work_item notification payload exactly once (issue #341 finding 7):
 * the notification fields (workItemId, description) are stripped by the
 * generic completion schema, so the raw payload is validated against the
 * notification shape. Shared by the boundary check, the text render, and the
 * block render so the shape is decoded at the row boundary, not re-parsed at
 * each of the three call sites.
 */
function parseWorkItemNotificationPayload(
  raw: string,
): z.infer<typeof workItemNotificationSchema> | null {
  try {
    const parsed = workItemNotificationSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The payload boundary check for the post seam (issue #159): a work_item
 * row must carry the notification shape — anything else is a worker
 * contract violation and fails closed like a malformed payload.
 */
function parseRowPayload(row: OutboxRow): { state?: string; result?: unknown } | null {
  if (row.kind === "work_item") {
    return parseWorkItemNotificationPayload(row.payload);
  }
  return parsePayload(row.payload);
}

/**
 * The one-line Slack post for a consumed row — display only, never a
 * correctness gate: unknown payloads/results fall back to a state line
 * instead of throwing, so a future worker result shape still posts.
 */
export function renderOutboxMessage(row: OutboxRow): string {
  if (row.kind === "work_item") {
    // The notification fields (workItemId, description) are stripped by the
    // generic completion schema, so parse the raw payload here.
    const payload = parseWorkItemNotificationPayload(row.payload);
    if (payload === null) return row.kind;
    const label = payload.state === "blocked" ? "Blocked" : "Review";
    const bits = [payload.description];
    if (payload.evidence) bits.push(payload.evidence);
    return `${label}: ${bits.join(" — ")}`;
  }
  const payload = parsePayload(row.payload);
  const state = payload?.state ?? "completed";
  const stateText = state === "done" ? "Done" : state === "blocked" ? "Blocked" : state;
  const kindLabel = row.kind === "git" || row.kind === "extension" ? "" : `${row.kind} `;
  const bits: string[] = [];
  const result = resultSummarySchema.safeParse(payload?.result);
  if (result.success) {
    const r = result.data;
    if (r.summary) bits.push(r.summary);
    if (r.pr_url) bits.push(r.pr_url);
    if (r.url) bits.push(r.url);
    if (r.source) bits.push(`source: ${r.source}`);
    if (r.count !== undefined) bits.push(`${r.count} item(s)`);
  }
  return bits.length > 0 ? `${kindLabel}${stateText}: ${bits.join(" — ")}` : `${kindLabel}${stateText}`;
}

/**
 * Block Kit rendering for a consumed row — the issue #279 upgrade of the
 * work_item notification line: the landing renders as an issueCard (state
 * icon + bold description + optional evidence link). Returns undefined for
 * non-work_item rows and for a work_item payload that lacks the card fields
 * (title/state) — those keep the plain-text line as the fallback, never a
 * malformed card. Fail-closed: a card shape is validated by {@link issueCard};
 * an unparseable payload yields undefined (the text fallback), never a block.
 */
export function renderOutboxBlocks(row: OutboxRow): SlackBlock[] | undefined {
  if (row.kind !== "work_item") return undefined;
  const payload = parseWorkItemNotificationPayload(row.payload);
  if (payload === null) return undefined;
  // A whitespace-only description parses the schema but cannot fill the card
  // title; drop to the text fallback rather than let issueCard throw (which
  // postRow would misread as a Slack post failure and retry/terminal-fail).
  if (payload.description.trim().length === 0) return undefined;
  const card = issueCard({
    title: payload.description,
    state: payload.state,
    // The notification payload carries no owner; evidence links when the
    // worker includes a `link` field (passthrough-preserved), else none.
    link: payload.link,
  });
  // A BLOCKED landing carries BOTH issue-#359 controls: "Open review"
  // (ephemeral private review link) and the #358 fast resume. Plain copy
  // only — no event kinds, ids stay inside the button values.
  if (payload.state === "blocked") {
    card.push(openWorkReviewButton(payload.workItemId));
    card.push(retryWithContextButton(payload.workItemId));
  }
  return card;
}

/**
 * The message for one consumed row — null when there is nothing to post.
 * A job-completion row whose state is blocked/review is SUPERSEDED by its
 * transition notification row (issue #159): the executor writes the
 * notification when the item lands, so the bare state line would duplicate
 * it. The row is still consumed (marked posted by the watermarked
 * consumer); it just never posts a second line.
 */
function messageForRow(row: OutboxRow): string | null {
  if (row.kind === "work_item") return renderOutboxMessage(row);
  const payload = parsePayload(row.payload);
  if (payload?.state === "blocked" || payload?.state === "review") return null;
  return renderOutboxMessage(row);
}

export interface OutboxPostPass {
  /** Rows successfully posted (audited outbox.posted). */
  posted: number;
  /** Rows surfaced by the unclaimed sweep (audited job.unclaimed + nudged). */
  nudged: number;
}

/**
 * One post-seam pass: consume the next pending batch (marked posted
 * atomically by the Wave-1 consumer), post each row to its space and audit
 * `outbox.posted`; a failed post audits `outbox.failed` and is requeued
 * within {@link maxPostAttempts} then marked failed (terminal). After the
 * consume, route {@link nudgeUnclaimedOutboxRows} — rows the consume could
 * not reach (stale beyond the TTL) are audited `job.unclaimed` and nudged
 * to Slack. Deliver-then-nudge ordering: a stale row the consume DID reach
 * is delivered, never nudged.
 */
export async function postPendingOutboxRows(
  store: Store,
  adapter: Pick<SlackAdapter, "postMessage">,
  opts: {
    maxPostAttempts?: number;
    olderThanMs?: number;
    now?: () => number;
    log?: (line: string) => void;
  } = {},
): Promise<OutboxPostPass> {
  const maxAttempts = opts.maxPostAttempts ?? DEFAULT_OUTBOX_MAX_POST_ATTEMPTS;
  const log = opts.log ?? (() => {});
  // A FRESH cursor every pass, never a threaded watermark: the Wave-1
  // consumer marks rows posted atomically, so the row status — not cursor
  // memory — is the dedupe across passes and restarts. A fresh cursor also
  // keeps the bounded-retry requeue sound: a requeued row (pending again,
  // created_at bumped to now so it never reads stale while retrying) is
  // picked up regardless of any cursor position — no same-millisecond
  // tiebreak edge against a threaded watermark.
  const { rows } = consumeOutboxWatermarked(store, { now: opts.now });
  let posted = 0;
  for (const row of rows) {
    if (await postRow(store, adapter, row, maxAttempts, opts.now, log)) posted += 1;
  }
  const nudged = await nudgeUnclaimedOutboxRowsToSlack(store, adapter, {
    olderThanMs: opts.olderThanMs,
    now: opts.now,
    log,
  });
  return { posted, nudged };
}

/** Post one consumed row; returns true when posted. Never throws for post failures. */
async function postRow(
  store: Store,
  adapter: Pick<SlackAdapter, "postMessage">,
  row: OutboxRow,
  maxAttempts: number,
  now: (() => number) | undefined,
  log: (line: string) => void,
): Promise<boolean> {
  if (row.kind === "ingest_poll") {
    // Issue #101 split leg: fetch/validate ran in the worker; dispatch +
    // post stay here (in-process, server holds the Slack tokens).
    return postIngestPollRow(store, adapter, row, log);
  }
  if (row.space === null || parseRowPayload(row) === null) {
    // Fail closed: a row with no target space or a malformed payload is
    // never posted and never retried — it is a worker contract violation.
    const reason = row.space === null ? "no space on the outbox row" : "malformed outbox payload";
    const attempts = row.attempts + 1;
    await auditFailed(store, row, reason, attempts);
    failOutboxRow(store, row.id, { attempts });
    log(`outbox post seam: row ${row.id} failed closed (${reason})`);
    return false;
  }
  const text = messageForRow(row);
  if (text === null) {
    // Superseded by the transition notification row (issue #159): the
    // blocked/review state line would duplicate the notification the
    // executor already wrote. The row is consumed (marked posted) with no
    // outbox.posted audit — the diagnosable gap documented in the module
    // header (posted_at without a matching audit row) — and never counts
    // as a posted message.
    return false;
  }
  try {
    const blocks = renderOutboxBlocks(row);
    await adapter.postMessage(row.space, text, blocks !== undefined ? { blocks } : undefined);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const attempts = row.attempts + 1;
    await auditFailed(store, row, error, attempts);
    if (attempts >= maxAttempts) {
      failOutboxRow(store, row.id, { attempts });
      log(`outbox post seam: row ${row.id} failed after ${attempts} attempt(s) — terminal`);
    } else {
      requeueOutboxRow(store, row.id, { now });
      log(`outbox post seam: row ${row.id} post failed (${error}) — retry ${attempts}/${maxAttempts}`);
    }
    return false;
  }
  await store.appendAudit({
    space_id: row.space,
    actor: "server",
    event_type: OUTBOX_POSTED_EVENT,
    payload: JSON.stringify({ id: row.id, kind: row.kind, space: row.space }),
  });
  return true;
}

/**
 * Posts one consumed ingest_poll row (issue #101): parse the worker's
 * validated events, re-validate + dispatch each IN-PROCESS (the server
 * holds the Slack tokens), audit `outbox.posted`. Malformed rows fail
 * closed exactly like the generic branch (audited + terminal). A dispatch
 * error per event propagates to the caller's retry path — the POST seam is
 * the bounded-retry owner, exactly like the generic Slack post branch.
 */
async function postIngestPollRow(
  store: Store,
  adapter: Pick<SlackAdapter, "postMessage">,
  row: OutboxRow,
  log: (line: string) => void,
): Promise<boolean> {
  if (row.space === null) {
    const attempts = row.attempts + 1;
    await auditFailed(store, row, "ingest_poll outbox row has no target space", attempts);
    failOutboxRow(store, row.id, { attempts });
    log(`outbox post seam: ingest_poll row ${row.id} failed closed (no space)`);
    return false;
  }
  const parsed = ingestPollOutcomeSchema.safeParse(parsePayload(row.payload));
  if (!parsed.success) {
    const attempts = row.attempts + 1;
    await auditFailed(store, row, "malformed ingest_poll outbox payload", attempts);
    failOutboxRow(store, row.id, { attempts });
    log(`outbox post seam: ingest_poll row ${row.id} failed closed (malformed payload)`);
    return false;
  }
  const audit = createAudit(store);
  const events = parsed.data.result?.events ?? [];
  for (const event of events) {
    // Defense in depth: dispatchIngestEvent re-validates every event and
    // audits any rejection — nothing unvalidated ever reaches a work item
    // or a Slack post.
    await dispatchIngestEvent(
      { store, audit, postMessage: adapter.postMessage, leg: "poll", spaceId: row.space, log },
      event,
    );
  }
  await store.appendAudit({
    space_id: row.space,
    actor: "server",
    event_type: OUTBOX_POSTED_EVENT,
    payload: JSON.stringify({ id: row.id, kind: row.kind, space: row.space, events: events.length }),
  });
  return true;
}

async function auditFailed(store: Store, row: OutboxRow, error: string, attempts: number): Promise<void> {
  await store.appendAudit({
    space_id: row.space,
    actor: "server",
    event_type: OUTBOX_FAILED_EVENT,
    payload: JSON.stringify({ id: row.id, kind: row.kind, error: error.slice(0, 2000), attempts }),
  });
}

/**
 * The unclaimed nudge leg: surface rows {@link nudgeUnclaimedOutboxRows}
 * found (stale pending rows no consume pass reached) to the row's space as
 * a visible Slack post — the fail-loud guarantee that a completed job whose
 * result never posts is seen, not silent. Returns the number nudged. The
 * `job.unclaimed` audit fires inside the store function exactly once per
 * row (the row is marked failed, terminal); a nudge post that fails is
 * logged, never re-audited — the row is already terminal and a retry would
 * duplicate nothing but a lost post is no worse than the audit row alone.
 */
export async function nudgeUnclaimedOutboxRowsToSlack(
  store: Store,
  adapter: Pick<SlackAdapter, "postMessage">,
  opts: { olderThanMs?: number; now?: () => number; log?: (line: string) => void } = {},
): Promise<number> {
  const log = opts.log ?? (() => {});
  const rows = await nudgeUnclaimedOutboxRows(store, { olderThanMs: opts.olderThanMs, now: opts.now });
  for (const row of rows) {
    if (row.space === null) continue; // no channel; the job.unclaimed audit row is the trail
    try {
      await adapter.postMessage(
        row.space,
        `A job result was not delivered: job ${row.id} (kind ${row.kind}) completed but no consumer posted it in time.`,
      );
    } catch (err) {
      log(`outbox post seam: unclaimed nudge post for ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return rows.length;
}
/**
 * The outbox-post-seam behavior (issue #356): a sweep-driven registration
 * in the reactive core. The outbox table is a status-dedupe QUEUE, not the
 * ledger — its rows carry no audit id to tail — so the pass stays
 * time-based (the issue's retained single-flight case) while borrowing the
 * core's one lifecycle: cadence, immediate first pass, error isolation,
 * stop(). Every pass drains the pending batch from a FRESH cursor and
 * routes the unclaimed nudge leg.
 */
export function outboxPostSeamBehavior(deps: OutboxPostSeamDeps): ReactiveBehavior {
  const log = deps.log ?? (() => {});
  return {
    id: "outbox-post-seam",
    events: [],
    sweep: async () => {
      const pass = await postPendingOutboxRows(deps.store, deps.adapter, {
        maxPostAttempts: deps.maxPostAttempts,
        olderThanMs: deps.olderThanMs,
        log,
      });
      if (pass.posted > 0) log(`outbox post seam: posted ${pass.posted} result(s)`);
      if (pass.nudged > 0) log(`outbox post seam: nudged ${pass.nudged} unclaimed row(s)`);
    },
  };
}

/**
 * Background loop around the {@link outboxPostSeamBehavior} — a
 * single-behavior reactive core (issue #356). First pass runs immediately.
 */
export function startOutboxPostSeam(deps: OutboxPostSeamDeps): OutboxPostSeam {
  const log = deps.log ?? (() => {});
  const intervalMs = deps.intervalMs ?? DEFAULT_OUTBOX_POST_INTERVAL_MS;
  const core = startReactiveCore(deps.store, [outboxPostSeamBehavior(deps)], {
    intervalMs,
    onError: ({ error }) => {
      // One bad pass must not kill the loop; the next tick retries from
      // scratch (a fresh cursor — the row status is the dedupe).
      log(`outbox post seam: pass failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  return {
    start() {
      core.start();
    },
    stop() {
      core.stop();
    },
  };
}
