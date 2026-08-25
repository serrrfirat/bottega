/**
 * M4 seed behavior (issue #356): the stale-procedure alert. A space skill
 * (a written procedure) whose latest revision is old and has never been
 * read since is probably rotting — the behavior posts one alert to the
 * space and records `procedure.stale_alerted` as the dedupe marker. This
 * is the extensibility proof of the reactive core: a new proactive-brain
 * feature is ONE behavior registration, zero new plumbing.
 */
import { z } from "zod";
import {
  PROCEDURE_STALE_ALERTED_EVENT,
  SPACE_SKILL_CREATED_EVENT,
  SPACE_SKILL_READ_EVENT,
} from "../../store/audit-events";
import type { Store } from "../../store/db";
import type { ReactiveBehavior } from "../../events/reactive";
import type { SlackAdapter } from "../adapters/slack";

/** A procedure unread for longer than this is flagged. Default 30 days. */
export const DEFAULT_PROCEDURE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Sweep once a day. */
export const PROCEDURE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const nameSchema = z.object({ name: z.string() });

export interface StaleProcedureAlertDeps {
  store: Pick<Store, "listAudit" | "appendAudit">;
  adapter: Pick<SlackAdapter, "postMessage">;
  staleAfterMs?: number;
}

/**
 * The stale-procedure-alert behavior: a daily sweep over the ledger.
 * Registration is the feature — no poller, no lifecycle, no plumbing.
 */
export function staleProcedureAlertBehavior(deps: StaleProcedureAlertDeps): ReactiveBehavior {
  return {
    id: "stale-procedure-alert",
    events: [],
    sweepIntervalMs: PROCEDURE_SWEEP_INTERVAL_MS,
    sweep: async () => {
      const staleAfterMs = deps.staleAfterMs ?? DEFAULT_PROCEDURE_STALE_AFTER_MS;
      const cutoff = Date.now() - staleAfterMs;
      const [created, reads, alerted] = await Promise.all([
        deps.store.listAudit({ event_type: SPACE_SKILL_CREATED_EVENT }),
        deps.store.listAudit({ event_type: SPACE_SKILL_READ_EVENT }),
        deps.store.listAudit({ event_type: PROCEDURE_STALE_ALERTED_EVENT }),
      ]);
      // Per procedure (space:name): latest revision, read, and alert
      // timestamps. A procedure is stale only while its LATEST revision is
      // old, unread, and unalerted — any newer revision, read, or prior
      // alert suppresses it.
      interface ProcedureTimes {
        created: number;
        read: number;
        alerted: number;
      }
      const latest = new Map<string, ProcedureTimes>();
      const touch = (rows: Awaited<ReturnType<typeof deps.store.listAudit>>, field: keyof ProcedureTimes): void => {
        for (const row of rows) {
          const key = procedureKey(row.space_id, nameOf(row));
          const entry = latest.get(key) ?? { created: 0, read: 0, alerted: 0 };
          entry[field] = Math.max(entry[field], row.ts);
          latest.set(key, entry);
        }
      };
      touch(created, "created");
      touch(reads, "read");
      touch(alerted, "alerted");
      for (const [key, times] of latest) {
        // Keys are JSON-encoded [spaceId, name] by procedureKey below —
        // space ids themselves carry colons ("slack:C123"), so string
        // splitting is not an option.
        // SAFETY: every key in this map was written by procedureKey as JSON [spaceId, name].
        const decoded = JSON.parse(key) as [string, string];
        const spaceId = decoded[0];
        const procedureName = decoded[1];
        if (!spaceId || !procedureName) continue;
        if (times.created >= cutoff || times.read > times.created || times.alerted > times.created) continue;
        await deps.adapter.postMessage(
          spaceId,
          `Procedure "${procedureName}" has not been used in ${Math.floor(staleAfterMs / 86_400_000)} days — review or retire it?`,
        );
        await deps.store.appendAudit({
          space_id: spaceId,
          actor: "server",
          event_type: PROCEDURE_STALE_ALERTED_EVENT,
          payload: JSON.stringify({
            name: procedureName,
            age_days: Math.floor((Date.now() - times.created) / 86_400_000),
          }),
        });
      }
    },
  };
}

/** Decodes a skill name at the audit-row boundary; malformed rows never alert. */
function nameOf(row: { payload: string }): string {
  try {
    return nameSchema.parse(JSON.parse(row.payload)).name;
  } catch {
    return "";
  }
}

/** JSON-encoded [spaceId, name]: space ids carry colons, so no string splitting. */
function procedureKey(spaceId: string | null, name: string): string {
  return JSON.stringify([spaceId ?? "", name]);
}
