/** SQLite row mapping for durable scheduler jobs (issue #86). */
import { z } from "zod";
import type { SchedulerActionName, SchedulerJob } from "./types";

export interface SchedulerJobRow {
  id: string;
  action: string;
  cron: string;
  params: string;
  space_id: string | null;
  created_by: string;
  created_at: number;
  next_fire_at: number;
  last_fired_at: number | null;
  last_result: "ok" | "error" | null;
  enabled: number;
}

const paramsSchema = z.record(z.string(), z.string());

function parseParams(jobId: string, text: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`scheduler job ${jobId} has invalid params JSON`);
  }
  const parsed = paramsSchema.safeParse(value);
  if (!parsed.success) {
    // The zod error names the first failing key; an empty path means the
    // value was not a string-to-string object at all.
    const firstIssue = parsed.error.issues[0];
    if (firstIssue !== undefined && firstIssue.path.length > 0) {
      throw new Error(`scheduler job ${jobId} param '${String(firstIssue.path[0])}' must be a string`);
    }
    throw new Error(`scheduler job ${jobId} params must be an object`);
  }
  return parsed.data;
}

/** Converts SQLite column names and JSON into the public camel-case contract. */
export function schedulerJobFromRow(row: SchedulerJobRow): SchedulerJob {
  return {
    id: row.id,
    // Direct database edits can contain a removed name. The runner still
    // checks the live registry and disables unknown names before execution.
    // SAFETY: row.action is one of the registry names in practice; a removed
    // name survives as a string that the runner treats as unknown and skips.
    action: row.action as SchedulerActionName,
    cron: row.cron,
    params: parseParams(row.id, row.params),
    spaceId: row.space_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    lastResult: row.last_result,
    enabled: row.enabled === 1,
  };
}
