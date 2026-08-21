/** SQLite row mapping for durable scheduler jobs (issue #86). */
import { z } from "zod";
import type { SchedulerActionName, SchedulerInvocation, SchedulerJob } from "./types";

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
  revision: number;
}

export interface SchedulerInvocationRow {
  id: string;
  job_id: string;
  action: string;
  params: string;
  space_id: string | null;
  source: "scheduled" | "manual";
  scheduled_for: number | null;
  requested_at: number;
  job_revision: number;
  status: "pending" | "running" | "completed";
  claimed_at: number | null;
  completed_at: number | null;
  result: "ok" | "error" | null;
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
    // SAFETY: Both scheduler execution paths look this value up in the live
    // registry and reject a missing handler before invoking it, so a removed
    // database action name remains inert.
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
    revision: row.revision,
  };
}

/** Converts a durable execution row into the runner's typed claim. */
export function schedulerInvocationFromRow(row: SchedulerInvocationRow): SchedulerInvocation {
  return {
    id: row.id,
    jobId: row.job_id,
    // SAFETY: Claimed invocations also go through the live registry lookup;
    // an unknown database action produces an error result and is never run.
    action: row.action as SchedulerActionName,
    params: parseParams(row.id, row.params),
    spaceId: row.space_id,
    source: row.source,
    scheduledFor: row.scheduled_for,
    requestedAt: row.requested_at,
    jobRevision: row.job_revision,
    status: row.status,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    result: row.result,
  };
}

export interface SchedulerJobAuditMetadata {
  id: string;
  action: SchedulerActionName;
  cron: string;
  space_id: string | null;
  enabled: boolean;
  revision: number;
  next_fire_at: number;
  params_keys: string[];
}

/** Secret-free metadata for lifecycle audit before/after fields. */
export function schedulerJobMetadata(job: SchedulerJob): SchedulerJobAuditMetadata {
  return {
    id: job.id,
    action: job.action,
    cron: job.cron,
    space_id: job.spaceId,
    enabled: job.enabled,
    revision: job.revision,
    next_fire_at: job.nextFireAt,
    params_keys: Object.keys(job.params).sort(),
  };
}
