/** SQLite row mapping for durable scheduler jobs (issue #86). */
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

function parseParams(jobId: string, text: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`scheduler job ${jobId} has invalid params JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`scheduler job ${jobId} params must be an object`);
  }
  const params: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`scheduler job ${jobId} param '${key}' must be a string`);
    params[key] = entry;
  }
  return params;
}

/** Converts SQLite column names and JSON into the public camel-case contract. */
export function schedulerJobFromRow(row: SchedulerJobRow): SchedulerJob {
  return {
    id: row.id,
    // Direct database edits can contain a removed name. The runner still
    // checks the live registry and disables unknown names before execution.
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
