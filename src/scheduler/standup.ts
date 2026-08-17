import { pruneDigestMemories } from "../memory/sqlite";
import { DIGEST_FAILED_EVENT, MEMORY_WRITE_EVENT } from "../store/audit-events";
import type { WorkItemState } from "../store/db";
import { sha256Hex } from "../tools/memory";
import { errorMessage } from "../tools/helpers";
import { DIGEST_CAP } from "../server/services/space-service";
import { proactiveEnabled } from "./proactive-config";
import type { SchedulerAction } from "./types";

const DAY_MS = 86_400_000;

type DigestRow = {
  id: string;
  state: WorkItemState;
  description: string;
  requester: string;
  pr_url: string | null;
};

function itemLine(item: DigestRow): string {
  const pullRequest = item.pr_url ? ` — ${item.pr_url}` : "";
  return `- ${item.id} [${item.state}] ${item.description} (requester: ${item.requester})${pullRequest}`;
}

/** Daily behavior-derived standup digest for explicitly opted-in spaces (#92). */
export const standupDigestAction: SchedulerAction = {
  name: "standup_digest",
  async run(params, ctx) {
    const spaceId = params.space ?? "";
    try {
      const space = await ctx.store.getSpace(spaceId);
      if (!space) throw new Error(`space not found: ${spaceId || "<missing>"}`);
      if (!proactiveEnabled(space.policy_json, "standup")) return;

      const policy = await ctx.loadPolicy(spaceId);
      if (policy.responseMode !== "always") return;

      const now = ctx.now();
      const currentDayStart = Math.floor(now / DAY_MS) * DAY_MS;
      const previousDayStart = currentDayStart - DAY_MS;
      // SAFETY: the SELECT above projects exactly the DigestRow columns
      // (id, state, description, requester, pr_url) in order; sqlite maps
      // each row to that shape.
      const rows = ctx.store
        .getDb()
        .query(
          `SELECT id, state, description, requester,
                  CASE
                    WHEN json_valid(result) AND json_type(result, '$.pr_url') = 'text'
                    THEN json_extract(result, '$.pr_url')
                    ELSE NULL
                  END AS pr_url
           FROM work_items
           WHERE space_id = ?
             AND ((state = 'done' AND updated_at >= ? AND updated_at < ?)
               OR state IN ('open', 'claimed', 'working', 'review', 'blocked'))
           ORDER BY updated_at, id`,
        )
        .all(spaceId, previousDayStart, currentDayStart) as DigestRow[];

      const finished = rows.filter((row) => row.state === "done");
      const open = rows.filter((row) =>
        row.state === "open" || row.state === "claimed" || row.state === "working" || row.state === "review",
      );
      const blocked = rows.filter((row) => row.state === "blocked");
      const sections = [
        `Standup for ${spaceId}: ${finished.length} finished yesterday; ${open.length} still open; ${blocked.length} blocked.`,
      ];
      if (finished.length > 0) sections.push("Finished yesterday:\n" + finished.map(itemLine).join("\n"));
      if (open.length > 0) sections.push("Still open:\n" + open.map(itemLine).join("\n"));
      if (blocked.length > 0) sections.push("Blocked:\n" + blocked.map(itemLine).join("\n"));
      const digest = sections.join("\n\n");

      await ctx.postMessage(spaceId, digest);
      const memory = await ctx.memoryProvider.save({
        scope: "org",
        content: digest,
        metadata: {
          kind: "digest",
          space: spaceId,
          since: String(previousDayStart),
          until: String(now),
        },
      });
      await ctx.audit.appendAudit({
        space_id: spaceId,
        actor: "scheduler",
        event_type: MEMORY_WRITE_EVENT,
        payload: {
          scope: "org",
          principal: null,
          id: memory.id,
          content_hash: sha256Hex(digest),
        },
      });
      pruneDigestMemories(ctx.store.getDb(), spaceId, DIGEST_CAP);
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
        ctx.log(`standup digest failed (${reason}); failure audit also failed: ${errorMessage(auditError)}`);
      }
    }
  },
};
