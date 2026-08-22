/**
 * Periodic memory review (issue #163): a deterministic scheduler action that
 * surfaces the agent's recallable and forgotten/tombstoned memory for a
 * space, gated like the governance digest (per-space proactive opt-in +
 * `response_mode: always`) and audited with aggregate counts only — never
 * memory content.
 *
 * The review renders counts (recallable entries across the readable org +
 * channel scopes, forgotten/tombstoned entries, and the next review date)
 * rather than raw memory text: memory is user data, and the weekly surface
 * is a compact health/summary digest, not a content dump.
 */
import { MEMORY_REVIEW_FAILED_EVENT, MEMORY_REVIEW_POSTED_EVENT } from "../store/audit-events";
import type { AuditModule } from "../policy/audit";
import type { MemoryProvider, MemoryScopeKey } from "../memory/types";
import { proactiveEnabled } from "./proactive-config";
import type { SchedulerAction } from "./types";

const REVIEW_ACTOR = "scheduler:weekly_memory_review";
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

/** The readable scopes a review covers for a space: the org floor + the space's own channel. */
function reviewReadableScopes(spaceId: string): MemoryScopeKey[] {
  return [{ kind: "org" }, { kind: "channel", spaceId }];
}

/** Counts recallable entries in a scope; degrades to a bounded search-estimate when the provider lacks a cheap count. */
async function countRecallable(provider: MemoryProvider, scope: MemoryScopeKey): Promise<number> {
  if (provider.countRecallable) {
    return provider.countRecallable(scope);
  }
  const sampled = await provider.search({ scope, query: "the", limit: 20 });
  return sampled.length;
}

/** Counts tombstones in a scope; returns 0 when the backend has no tombstone count. */
async function countForgotten(provider: MemoryProvider, scope: MemoryScopeKey): Promise<number> {
  if (!provider.countForgotten) return 0;
  try {
    return provider.countForgotten(scope);
  } catch {
    // Backends without tombstones reject loudly; a review must never fail
    // (or leak) because forget is unsupported — treat it as zero.
    return 0;
  }
}

/** Formats a deterministic, redacted weekly review. No memory content appears. */
export function renderMemoryReview(recallable: number, forgotten: number, now: number): string {
  const nextReview = new Date(now + WEEK_MS).toISOString().slice(0, 10);
  const lines = [
    "*Weekly memory review*",
    `_Computed ${new Date(now).toISOString()}_`,
    "",
    `Recallable memory entries: ${recallable}`,
    `Forgotten (tombstoned) memory entries: ${forgotten}`,
    `Next review: ${nextReview}`,
    "",
    "_Counts only — memory content is never echoed in the review._",
  ];
  return lines.join("\n");
}

async function auditFailure(audit: AuditModule, spaceId: string | null, reason: string): Promise<void> {
  try {
    await audit.appendAudit({
      space_id: spaceId,
      actor: REVIEW_ACTOR,
      event_type: MEMORY_REVIEW_FAILED_EVENT,
      payload: { reason },
    });
  } catch {
    // The scheduler runner owns the outer operational log. A failed
    // failure-audit must never become a second delivery attempt.
  }
}

/** Deterministic weekly memory review. No model and no raw memory leaves this action. */
export const memoryReviewAction: SchedulerAction = {
  name: "weekly_memory_review",
  async run(params, ctx) {
    const spaceId = params.space?.trim() ?? "";
    if (!spaceId) {
      await auditFailure(ctx.audit, null, "missing_space");
      return;
    }
    try {
      const space = await ctx.store.getSpace(spaceId);
      if (!space) {
        await auditFailure(ctx.audit, null, "unknown_space");
        return;
      }
      if (!proactiveEnabled(space.policy_json, "memory_review")) return;
      const policy = await ctx.loadPolicy(spaceId);
      if (!policy.ok || policy.responseMode !== "always") return;

      const now = ctx.now();
      const scopes = reviewReadableScopes(spaceId);
      const [recallable, forgotten] = await Promise.all([
        (async () => {
          let total = 0;
          for (const scope of scopes) total += await countRecallable(ctx.memoryProvider, scope);
          return total;
        })(),
        (async () => {
          let total = 0;
          for (const scope of scopes) total += await countForgotten(ctx.memoryProvider, scope);
          return total;
        })(),
      ]);

      const text = renderMemoryReview(recallable, forgotten, now);
      await ctx.postMessage(spaceId, text);
      await ctx.audit.appendAudit({
        space_id: spaceId,
        actor: REVIEW_ACTOR,
        event_type: MEMORY_REVIEW_POSTED_EVENT,
        payload: {
          recallable,
          forgotten,
          next_review: new Date(now + WEEK_MS).toISOString().slice(0, 10),
        },
      });
    } catch {
      await auditFailure(ctx.audit, spaceId, "delivery_failed");
    }
  },
};