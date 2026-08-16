import type { MemoryEntry } from "../memory/types";
import { OBSERVER_READ_EVENT } from "../store/audit-events";
import type { SchedulerAction, SchedulerActionContext } from "./types";

const OBSERVER_ACTOR = "scheduler:org_pulse";
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const THEME_MAX_LENGTH = 120;

function sourceLabel(entry: MemoryEntry): string {
  return `${entry.id} (${new Date(entry.createdAt).toISOString().slice(0, 10)})`;
}

function digestTheme(content: string): string {
  const compact = content.replace(/[ \t]+/g, " ").trim();
  const lineEnd = compact.search(/[\r\n]/);
  const firstLine = (lineEnd === -1 ? compact : compact.slice(0, lineEnd)).trim();
  const sentenceEnd = firstLine.search(/[.!?](?:\s|$)/);
  const firstSentence = sentenceEnd === -1 ? firstLine : firstLine.slice(0, sentenceEnd + 1);
  if (firstSentence.length <= THEME_MAX_LENGTH) return firstSentence;
  return `${firstSentence.slice(0, THEME_MAX_LENGTH - 1).trimEnd()}…`;
}

function weeklySummary(reflections: MemoryEntry[], digests: MemoryEntry[]): string {
  const lines = ["*Weekly company-pattern pulse*", "_Org memory from the last 7 days_", ""];

  if (reflections.length === 0 && digests.length === 0) {
    lines.push("No company patterns found in org memory for the last 7 days.");
    return lines.join("\n");
  }

  if (reflections.length > 0) {
    const topics = new Map<string, MemoryEntry[]>();
    for (const reflection of reflections) {
      const topic = reflection.metadata.topic?.trim() || "Other";
      const entries = topics.get(topic);
      if (entries) entries.push(reflection);
      else topics.set(topic, [reflection]);
    }

    lines.push("*Reflection topics*");
    const sortedTopics = [...topics.entries()].sort(([topicA, entriesA], [topicB, entriesB]) => {
      const countOrder = entriesB.length - entriesA.length;
      if (countOrder !== 0) return countOrder;
      return topicA < topicB ? -1 : topicA > topicB ? 1 : 0;
    });
    for (const [topic, entries] of sortedTopics) {
      lines.push(`• ${topic} — ${entries.length} (${entries.map(sourceLabel).join(", ")})`);
    }
  }

  if (digests.length > 0) {
    if (reflections.length > 0) lines.push("");
    lines.push("*Notable digest themes*");
    for (const digest of digests) {
      const theme = digestTheme(digest.content) || "No digest summary";
      lines.push(`• ${theme} — ${sourceLabel(digest)}`);
    }
  }

  return lines.join("\n");
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function auditFailure(
  ctx: SchedulerActionContext,
  pulseSpace: string | null,
  reason: string,
): Promise<void> {
  try {
    await ctx.audit.appendAudit({
      space_id: pulseSpace,
      actor: OBSERVER_ACTOR,
      event_type: OBSERVER_READ_EVENT,
      payload: { error: reason },
    });
  } catch (auditError) {
    ctx.log(`[org_pulse] failed to audit observer failure: ${errorReason(auditError)}`);
  }
}

/** Deterministic, read-only weekly org observer (issue #90). */
export const orgPulseAction: SchedulerAction = {
  name: "org_pulse",
  async run(params, ctx) {
    const pulseSpace = params.pulse_space?.trim() ?? "";

    try {
      if (!pulseSpace) {
        await auditFailure(ctx, null, "pulse_space is required");
        return;
      }

      const space = await ctx.store.getSpace(pulseSpace);
      if (!space) {
        await auditFailure(ctx, null, `pulse space "${pulseSpace}" does not exist`);
        return;
      }

      const reflections = await ctx.memoryProvider.search({
        query: "",
        scope: "org",
        metadata: { kind: "reflection" },
        limit: 20,
      });
      await ctx.audit.appendAudit({
        space_id: pulseSpace,
        actor: OBSERVER_ACTOR,
        event_type: OBSERVER_READ_EVENT,
        payload: { scope: "org", metadata: { kind: "reflection" }, count: reflections.length },
      });

      const digests = await ctx.memoryProvider.search({
        query: "",
        scope: "org",
        metadata: { kind: "digest" },
        limit: 20,
      });
      await ctx.audit.appendAudit({
        space_id: pulseSpace,
        actor: OBSERVER_ACTOR,
        event_type: OBSERVER_READ_EVENT,
        payload: { scope: "org", metadata: { kind: "digest" }, count: digests.length },
      });

      // Keep future-dated or stale provider rows out of this weekly pulse (#90).
      const now = ctx.now();
      const start = now - WEEK_MS;
      const inWindow = (entry: MemoryEntry): boolean => entry.createdAt >= start && entry.createdAt <= now;
      const summary = weeklySummary(reflections.filter(inWindow), digests.filter(inWindow));

      await ctx.postMessage(pulseSpace, summary);
      await ctx.audit.appendAudit({
        space_id: pulseSpace,
        actor: OBSERVER_ACTOR,
        event_type: OBSERVER_READ_EVENT,
        payload: { pulse_space: pulseSpace, posted: true },
      });
    } catch (error) {
      await auditFailure(ctx, pulseSpace || null, errorReason(error));
    }
  },
};
