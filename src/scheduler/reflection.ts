import type { AuditRow, WorkItemState } from "../store/db";
import {
  DIGEST_FAILED_EVENT,
  EXTENSION_CALL_EVENT,
  MEMORY_WRITE_EVENT,
  MESSAGE_DROPPED_EVENT,
  WORK_ITEM_FAILED_EVENT,
  WORK_ITEM_TRANSITION_EVENT,
} from "../store/audit-events";
import { errorMessage } from "../tools/helpers";
import { sha256Hex } from "../tools/memory";
import { proactiveEnabled } from "./proactive-config";
import type { SchedulerAction } from "./types";

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

function objectPayload(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function evidenceSummary(encoded: string): string[] {
  try {
    const value: unknown = JSON.parse(encoded);
    if (!Array.isArray(value)) return [];
    const summaries: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const evidence = entry as Record<string, unknown>;
      const detail = typeof evidence.url === "string" ? evidence.url : evidence.text;
      if (typeof detail === "string" && detail.trim()) summaries.push(detail.trim());
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
    const payload = objectPayload(row.payload);
    if (payload?.to !== "done") continue;
    const id = typeof payload.id === "string" ? payload.id : null;
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
    const payload = objectPayload(row.payload);
    const id = typeof payload?.id === "string" ? payload.id : `audit ${row.id}`;
    const reason = typeof payload?.error === "string" ? payload.error : "failure recorded";
    parts.push(`${id} failed: ${reason}`);
  }
  return parts.length > 0 ? { topic: "blocked", content: `Blocked or failed today: ${parts.join("; ")}.` } : null;
}

function errorReflection(auditRows: AuditRow[]): ReflectionEntry | null {
  const signals: string[] = [];
  const digestFailures = auditRows.filter((row) => row.event_type === DIGEST_FAILED_EVENT);
  if (digestFailures.length > 0) {
    const reasons = digestFailures
      .map((row) => objectPayload(row.payload)?.reason)
      .filter((reason): reason is string => typeof reason === "string" && reason.length > 0);
    signals.push(`${digestFailures.length} digest.failed${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}`);
  }
  const droppedMessages = auditRows.filter((row) => row.event_type === MESSAGE_DROPPED_EVENT);
  if (droppedMessages.length > 0) signals.push(`${droppedMessages.length} message_dropped`);

  const extensionFailures: string[] = [];
  for (const row of auditRows) {
    if (row.event_type !== EXTENSION_CALL_EVENT) continue;
    const payload = objectPayload(row.payload);
    if (payload?.decision !== "deny" && payload?.decision !== "error") continue;
    const extension = typeof payload.extension === "string" ? payload.extension : "unknown extension";
    const tool = typeof payload.tool === "string" ? payload.tool : "unknown tool";
    extensionFailures.push(`${payload.decision} ${extension}/${tool}`);
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
        .all(spaceId, since) as ReflectionWorkItem[];

      const entries = [
        finishedReflection(items, auditRows),
        blockedReflection(items, auditRows),
        errorReflection(auditRows),
        volumeReflection(auditRows),
      ].filter((entry): entry is ReflectionEntry => entry !== null);

      for (const entry of entries) {
        const memory = await ctx.memoryProvider.save({
          scope: "org",
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
      try {
        await ctx.audit.appendAudit({
          space_id: spaceId || null,
          actor: "scheduler",
          event_type: DIGEST_FAILED_EVENT,
          payload: { reason },
        });
      } catch (auditError) {
        ctx.log(`reflection failed (${reason}); failure audit also failed: ${errorMessage(auditError)}`);
      }
    }
  },
};
