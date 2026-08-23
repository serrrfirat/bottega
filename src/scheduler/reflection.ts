import type { AuditRow, WorkItemState } from "../store/db";
import {
  DIGEST_FAILED_EVENT,
  EXTENSION_CALL_EVENT,
  MEMORY_WRITE_EVENT,
  MESSAGE_DROPPED_EVENT,
  WORK_ITEM_FAILED_EVENT,
  WORK_ITEM_TRANSITION_EVENT,
} from "../store/audit-events";
import { errorMessage, sha256Hex } from "../tools/helpers";
import { proactiveEnabled } from "./proactive-config";
import { auditDigestFailure } from "./digest-helpers";
import type { SchedulerAction } from "./types";
import { z } from "zod";

const DAY_MS = 86_400_000;

type ReflectionWorkItem = {
  id: string;
  state: WorkItemState;
  description: string;
  requester: string;
  evidence: string;
  pr_url: string | null;
};

type ReflectionEntry = {
  topic: "finished" | "blocked" | "errors" | "volume";
  content: string;
};

/** Audit payload schemas: the shapes our own audit calls write (see store/audit-events). */
const jsonValueSchema = z.json();
const transitionPayloadSchema = z.object({
  to: z.string(),
  id: z.string().optional().catch(undefined),
});
const failedPayloadSchema = z.object({
  id: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
});
const digestFailedPayloadSchema = z.object({
  reason: z.string().optional(),
});
const extensionCallPayloadSchema = z.object({
  decision: z.enum(["deny", "error"]),
  extension: z.string().catch("unknown extension"),
  tool: z.string().catch("unknown tool"),
});
const evidenceEntrySchema = z.object({
  url: z.string().optional().catch(undefined),
  text: z.string().optional(),
});

/** Parses an audit payload JSON string against an event schema; null when invalid/mismatched. */
function parsePayload<T>(payload: string, schema: z.ZodType<T>): T | null {
  try {
    const result = schema.safeParse(JSON.parse(payload));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** The work_items row the reflection query selects (state filtered to done/blocked by SQL). */
const workItemRowSchema = z.object({
  id: z.string(),
  state: z.enum(["done", "blocked"]),
  description: z.string(),
  requester: z.string(),
  evidence: z.string(),
  pr_url: z.string().nullable(),
});

function evidenceSummary(encoded: string): string[] {
  try {
    const parsed = jsonValueSchema.safeParse(JSON.parse(encoded));
    if (!parsed.success || !Array.isArray(parsed.data)) return [];
    const summaries: string[] = [];
    for (const raw of parsed.data) {
      const entry = evidenceEntrySchema.safeParse(raw);
      if (!entry.success) continue;
      const detail = entry.data.url !== undefined ? entry.data.url : entry.data.text;
      if (detail !== undefined && detail.trim()) summaries.push(detail.trim());
    }
    return summaries;
  } catch {
    return [];
  }
}

function finishedReflection(items: ReflectionWorkItem[], auditRows: AuditRow[]): ReflectionEntry | null {
  const parts = items
    .filter((item) => item.state === "done")
    .map((item) => `${item.id} — ${item.description}${item.pr_url ? ` (${item.pr_url})` : ""}`);
  const knownIds = new Set(items.map((item) => item.id));
  for (const row of auditRows) {
    if (row.event_type !== WORK_ITEM_TRANSITION_EVENT) continue;
    const payload = parsePayload(row.payload, transitionPayloadSchema);
    if (payload === null || payload.to !== "done") continue;
    const id = payload.id;
    if (id && !knownIds.has(id)) {
      knownIds.add(id);
      parts.push(`${id} reached done (audit ${row.id})`);
    } else if (!id && parts.length === 0) {
      parts.push(`a work item reached done (audit ${row.id})`);
    }
  }
  return parts.length > 0 ? { topic: "finished", content: `Finished today: ${parts.join("; ")}.` } : null;
}

function blockedReflection(items: ReflectionWorkItem[], auditRows: AuditRow[]): ReflectionEntry | null {
  const parts = items
    .filter((item) => item.state === "blocked")
    .map((item) => {
      const evidence = evidenceSummary(item.evidence);
      return `${item.id} — ${item.description}${evidence.length > 0 ? `; evidence: ${evidence.join(", ")}` : ""}`;
    });
  for (const row of auditRows) {
    if (row.event_type !== WORK_ITEM_FAILED_EVENT) continue;
    const payload = parsePayload(row.payload, failedPayloadSchema);
    const id = payload?.id ?? `audit ${row.id}`;
    const reason = payload?.error ?? "failure recorded";
    parts.push(`${id} failed: ${reason}`);
  }
  return parts.length > 0 ? { topic: "blocked", content: `Blocked or failed today: ${parts.join("; ")}.` } : null;
}

function errorReflection(auditRows: AuditRow[]): ReflectionEntry | null {
  const signals: string[] = [];
  const digestFailures = auditRows.filter((row) => row.event_type === DIGEST_FAILED_EVENT);
  if (digestFailures.length > 0) {
    const reasons = digestFailures.flatMap((row) => {
      const reason = parsePayload(row.payload, digestFailedPayloadSchema)?.reason;
      return reason !== undefined && reason.length > 0 ? [reason] : [];
    });
    signals.push(`${digestFailures.length} digest.failed${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}`);
  }
  const droppedMessages = auditRows.filter((row) => row.event_type === MESSAGE_DROPPED_EVENT);
  if (droppedMessages.length > 0) signals.push(`${droppedMessages.length} message_dropped`);

  const extensionFailures: string[] = [];
  for (const row of auditRows) {
    if (row.event_type !== EXTENSION_CALL_EVENT) continue;
    const payload = parsePayload(row.payload, extensionCallPayloadSchema);
    if (payload === null) continue;
    extensionFailures.push(`${payload.decision} ${payload.extension}/${payload.tool}`);
  }
  if (extensionFailures.length > 0) {
    signals.push(`${extensionFailures.length} extension.call (${extensionFailures.join(", ")})`);
  }
  return signals.length > 0 ? { topic: "errors", content: `Error signals today: ${signals.join("; ")}.` } : null;
}

function volumeReflection(auditRows: AuditRow[]): ReflectionEntry | null {
  const count = auditRows.filter((row) => row.event_type === "message.in").length;
  if (count === 0) return null;
  return { topic: "volume", content: `The space received ${count} inbound message${count === 1 ? "" : "s"} today.` };
}

/** Deterministic end-of-day learning writer for explicitly opted-in spaces (#93). */
export const reflectionAction: SchedulerAction = {
  name: "reflection",
  async run(params, ctx) {
    const spaceId = params.space ?? "";
    try {
      const space = await ctx.store.getSpace(spaceId);
      if (!space) throw new Error(`space not found: ${spaceId || "<missing>"}`);
      if (!proactiveEnabled(space.policy_json, "reflection")) return;

      const policy = await ctx.loadPolicy(spaceId);
      if (policy.responseMode !== "always") return;

      const now = ctx.now();
      const since = Math.floor(now / DAY_MS) * DAY_MS;
      const date = new Date(since).toISOString().slice(0, 10);
      const auditRows = await ctx.store.listAudit({ space: spaceId, since });
      const items = ctx.store
        .getDb()
        .query(
          `SELECT id, state, description, requester, evidence,
                  CASE
                    WHEN json_valid(result) AND json_type(result, '$.pr_url') = 'text'
                    THEN json_extract(result, '$.pr_url')
                    ELSE NULL
                  END AS pr_url
           FROM work_items
           WHERE space_id = ? AND updated_at >= ? AND state IN ('done', 'blocked')
           ORDER BY updated_at, id`,
        )
        .all(spaceId, since)
        .map((row) => workItemRowSchema.parse(row));

      const entries = [
        finishedReflection(items, auditRows),
        blockedReflection(items, auditRows),
        errorReflection(auditRows),
        volumeReflection(auditRows),
      ].filter((entry): entry is ReflectionEntry => entry !== null);

      for (const entry of entries) {
        const memory = await ctx.memoryProvider.save({
          scope: { kind: "org" },
          content: entry.content,
          metadata: { kind: "reflection", space: spaceId, date, topic: entry.topic },
        });
        await ctx.audit.appendAudit({
          space_id: spaceId,
          actor: "scheduler",
          event_type: MEMORY_WRITE_EVENT,
          payload: {
            scope: "org",
            principal: null,
            id: memory.id,
            content_hash: sha256Hex(entry.content),
          },
        });
      }
    } catch (error) {
      const reason = errorMessage(error);
      await auditDigestFailure(ctx, spaceId || null, reason, "reflection");
    }
  },
};
