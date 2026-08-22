/**
 * Usage meter (issue #103): the durable record of model-token consumption
 * per turn, and the read surface for per-space / per-user aggregation.
 *
 * Tokens are NOT recorded anywhere in bottega today (no usage column on
 * transcripts or audit rows), so this module owns the ONE place they land:
 * a `usage.turn` audit event written append-only at each model completion.
 * The audit row carries the price-bearing dimensions directly on the
 * indexed columns (space_id = space, actor = user principal) and the
 * model + token counts in the payload, so aggregation is a plain
 * `listAudit` query over the window — no new table, one `usage.turn`
 * vocabulary entry, and zero extra state to drift.
 *
 * The write half ({@link recordTurnUsage}) is wired by the driver at the
 * composition roots (server + executor) so every turn — chat, work-item,
 * digest, learning side-session — is metered uniformly. Zero-cost turns
 * (a provider returning no usage, e.g. a mocked/virtual model) still write
 * a row with 0/0 so the turn count stays accurate; the payload is
 * payload-capped + redacted like every audit row.
 */

import { z } from "@oh-my-pi/pi-coding-agent";
import type { AuditModule } from "../policy/audit";
import type { Store } from "../store/db";
import { USAGE_TURN_EVENT } from "../store/audit-events";

/**
 * Audit event name for one model completion. Re-exported from the audit
 * vocabulary (the single source of truth), so this module and the
 * operator/read tools agree on the exact event string.
 */
export { USAGE_TURN_EVENT };

/** One model completion: the price-bearing facts of a turn, audited append-only. */
export interface UsageTurn {
  /** The space the model call ran in (audit `space_id`; null for headless/org-level calls). */
  spaceId: string | null;
  /** The user principal that consumed the turn (audit `actor`; "agent" when none). */
  actor: string;
  /** The model id that answered the turn, as the session reported it. */
  model: string;
  /** Input (prompt) tokens consumed, per the provider's usage report. */
  tokensIn: number;
  /** Output (completion) tokens consumed, per the provider's usage report. */
  tokensOut: number;
}

/**
 * Appends one `usage.turn` audit row. Returns the store's new row id.
 * Deliberately fire-and-forget at call sites: a metering write must never
 * fail or delay the turn it records.
 */
export async function recordTurnUsage(audit: AuditModule, turn: UsageTurn): Promise<number> {
  return audit.appendAudit({
    space_id: turn.spaceId,
    actor: turn.actor,
    event_type: USAGE_TURN_EVENT,
    payload: {
      model: turn.model,
      tokensIn: turn.tokensIn,
      tokensOut: turn.tokensOut,
    },
  });
}

/**
 * The driver-side recording seam (issue #103). The OMP session driver is a
 * pure event emitter with no store/audit dependency; the composition roots
 * pass it a callback that records the metered facts through THEIR store.
 * The driver composes the full {@link UsageTurn} (it knows the space and
 * the turn's principal); the recorder only persists it. A driver without a
 * recorder is valid — sessions just don't meter.
 */
export type UsageRecorder = (turn: UsageTurn) => Promise<void>;

/**
 * The subset of an SDK assistant message the meter reads: the model id and
 * the provider's normalized usage report. A structural slice of the SDK's
 * `AssistantMessage` — the driver passes the whole `message_end` message
 * and this type accepts any object carrying `model` + `usage`. Parsed at
 * the driver boundary so a provider that reports anything else yields no
 * row.
 */
export interface UsageReportingMessage {
  /** The model id that answered the turn, as the session listed it. */
  model?: unknown;
  /** The provider's normalized usage report (`Usage`), or null when unreported. */
  usage?: unknown;
}

/** The usage-report slice of an assistant message the meter validates against. */
const assistantUsageSchema = z.object({
  model: z.string().min(1),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    })
    .nullable(),
});

/**
 * Extracts the price-bearing facts from an assistant message's usage
 * report. Returns null when the message carries no usable usage (a
 * non-assistant message, a provider that reported nothing, or a malformed
 * shape) — the caller then skips the row rather than recording a fabricated
 * one. `tokensIn`/`tokensOut` map to the canonical `usage.input` and
 * `usage.output` buckets (the price-bearing prompt/completion counts,
 * excluding cache), per the SDK's normalized Usage type.
 */
export function extractTurnUsage(
  message: UsageReportingMessage | null | undefined,
): { model: string; tokensIn: number; tokensOut: number } | null {
  const parsed = assistantUsageSchema.safeParse(message);
  if (!parsed.success) return null;
  const { model, usage } = parsed.data;
  if (usage === null) return null;
  return { model, tokensIn: usage.input, tokensOut: usage.output };
}

/** One aggregated bucket of the usage summary: a (space, user, model) triple over a window. */
export interface UsageSummaryRow {
  spaceId: string | null;
  actor: string;
  model: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
}

/** The payload shape a `usage.turn` row must parse as to count toward the summary. */
const usagePayloadSchema = z.object({
  model: z.string().min(1),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
});

/**
 * Aggregates `usage.turn` rows over the window `[since, now)` grouped by
 * (space_id, actor, model) — the "by space+user" shape the read surface
 * needs. Only rows whose payload parses as {model, tokensIn, tokensOut} are
 * counted (a malformed/truncated row is skipped, never fatal): this is an
 * aggregation over the durable audit trail, not a second write path, so a
 * redacted or oversized payload can never corrupt the summary.
 *
 * `space` narrows the window to one space (its own user buckets); omitted
 * returns every space's buckets (org-wide rollup for the operator read).
 */
export async function usageSummary(
  store: Pick<Store, "listAudit">,
  opts: { since: number; space?: string },
): Promise<UsageSummaryRow[]> {
  const query: Parameters<Pick<Store, "listAudit">["listAudit"]>[0] = {
    event_type: USAGE_TURN_EVENT,
    since: opts.since,
  };
  if (opts.space !== undefined) query.space = opts.space;
  const rows = await store.listAudit(query);
  const buckets = new Map<string, UsageSummaryRow>();
  for (const row of rows) {
    let text: unknown;
    try {
      text = JSON.parse(row.payload);
    } catch {
      // A durable-audit anomaly (truncated/redacted payload) is skipped,
      // never fatal to the summary.
      continue;
    }
    const payload = usagePayloadSchema.safeParse(text);
    if (!payload.success) continue;
    const { model, tokensIn, tokensOut } = payload.data;
    const key = `${row.space_id ?? "\u0000"}\u0001${row.actor}\u0001${model}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { spaceId: row.space_id, actor: row.actor, model, turns: 0, tokensIn: 0, tokensOut: 0 };
      buckets.set(key, bucket);
    }
    bucket.turns += 1;
    bucket.tokensIn += tokensIn;
    bucket.tokensOut += tokensOut;
  }
  return [...buckets.values()];
}