import { z } from "zod";
import type { AuditModule } from "../../policy/audit";
import { describeCron } from "../../scheduler/scheduler-tools";
import { schedulerJobMetadata } from "../../scheduler/store";
import type { SchedulerJob } from "../../scheduler/types";
import {
  SCHEDULER_JOB_PAUSED_EVENT,
  SCHEDULER_JOB_RESUMED_EVENT,
  SCHEDULER_RUN_REQUESTED_EVENT,
} from "../../store/audit-events";
import type { Store } from "../../store/db";
import {
  SCHEDULER_PAUSE_ACTION_ID,
  SCHEDULER_RESUME_ACTION_ID,
  SCHEDULER_RUN_NOW_ACTION_ID,
  type SlackAction,
  type SlackAdapter,
} from "./slack";

type SchedulerButton = {
  type: "button";
  text: { type: "plain_text"; text: string };
  action_id: string;
  value: string;
  style?: "primary" | "danger";
}

export type SchedulerBlock = {
  type: "header" | "section" | "actions" | "divider";
  text?: { type: "plain_text" | "mrkdwn"; text: string };
  elements?: SchedulerButton[];
}

function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function schedulerActionValue(job: Pick<SchedulerJob, "id" | "revision">): string {
  return JSON.stringify({ id: job.id, revision: job.revision });
}

const schedulerActionValueSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

type SchedulerActionValue = z.infer<typeof schedulerActionValueSchema>;

function parseSchedulerActionValue(value: string): SchedulerActionValue | null {
  let payload: z.input<typeof schedulerActionValueSchema>;
  try {
    payload = JSON.parse(value);
  } catch {
    return null;
  }
  const parsed = schedulerActionValueSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

function utcTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** Pure deterministic Slack state renderer. Jobs must already be authority-scoped. */
export function buildSchedulerBlocks(jobs: readonly SchedulerJob[]): SchedulerBlock[] {
  const blocks: SchedulerBlock[] = [
    { type: "header", text: { type: "plain_text", text: "Schedules" } },
  ];
  if (jobs.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "No schedules in this space." } });
    return blocks;
  }
  for (const [index, job] of jobs.entries()) {
    if (index > 0) blocks.push({ type: "divider" });
    const description = escapeMrkdwn(job.params.description?.trim() || job.action);
    const state = job.enabled ? "enabled" : "paused";
    const last = job.lastFiredAt === null ? "never" : `${utcTimestamp(job.lastFiredAt)} (${job.lastResult ?? "unknown"})`;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${description}* — *${state}*\n` +
          `${escapeMrkdwn(describeCron(job.cron))} · next ${utcTimestamp(job.nextFireAt)} · last ${last}\n` +
          `\`${escapeMrkdwn(job.id)}\` · revision ${job.revision}`,
      },
    });
    const toggle: SchedulerButton = job.enabled
      ? {
          type: "button",
          text: { type: "plain_text", text: "Pause" },
          action_id: SCHEDULER_PAUSE_ACTION_ID,
          value: schedulerActionValue(job),
        }
      : {
          type: "button",
          text: { type: "plain_text", text: "Resume" },
          action_id: SCHEDULER_RESUME_ACTION_ID,
          value: schedulerActionValue(job),
          style: "primary",
        };
    blocks.push({
      type: "actions",
      elements: [
        toggle,
        {
          type: "button",
          text: { type: "plain_text", text: "Run now" },
          action_id: SCHEDULER_RUN_NOW_ACTION_ID,
          value: schedulerActionValue(job),
        },
      ],
    });
  }
  return blocks;
}

export interface SchedulerActionDeps {
  store: Store;
  audit: AuditModule;
  adapter: SlackAdapter;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Resolves one same-space schedule control. Revision checks make stale or
 * repeated state-change clicks no-ops; run-now derives a stable invocation
 * identity from the rendered message so concurrent retries enqueue once.
 */
export async function resolveSchedulerAction(deps: SchedulerActionDeps, action: SlackAction): Promise<boolean> {
  if (
    action.actionId !== SCHEDULER_PAUSE_ACTION_ID &&
    action.actionId !== SCHEDULER_RESUME_ACTION_ID &&
    action.actionId !== SCHEDULER_RUN_NOW_ACTION_ID
  ) {
    return false;
  }
  const value = parseSchedulerActionValue(action.value);
  if (!value) return false;
  const before = await deps.store.getSchedulerJob(value.id);
  if (!before || before.spaceId !== action.spaceId || before.revision !== value.revision) return false;
  const now = deps.now ?? Date.now;
  let changed = false;
  if (action.actionId === SCHEDULER_PAUSE_ACTION_ID) {
    if (!before.enabled) return false;
    const after = await deps.store.pauseSchedulerJob(before.id, value.revision);
    await deps.audit.appendAudit({
      space_id: after.spaceId,
      actor: action.principal,
      event_type: SCHEDULER_JOB_PAUSED_EVENT,
      payload: {
        invocation_id: `slack:${action.messageTs}:${action.actionId}:${before.id}:${value.revision}`,
        before: schedulerJobMetadata(before),
        after: schedulerJobMetadata(after),
      },
    });
    changed = true;
  } else if (action.actionId === SCHEDULER_RESUME_ACTION_ID) {
    if (before.enabled) return false;
    const after = await deps.store.resumeSchedulerJob(before.id, value.revision, now());
    await deps.audit.appendAudit({
      space_id: after.spaceId,
      actor: action.principal,
      event_type: SCHEDULER_JOB_RESUMED_EVENT,
      payload: {
        invocation_id: `slack:${action.messageTs}:${action.actionId}:${before.id}:${value.revision}`,
        before: schedulerJobMetadata(before),
        after: schedulerJobMetadata(after),
      },
    });
    changed = true;
  } else {
    const invocationId = `slack:${action.messageTs}:${action.actionId}:${before.id}:${value.revision}`;
    const enqueued = await deps.store.enqueueSchedulerRunNow({
      jobId: before.id,
      expectedRevision: value.revision,
      invocationId,
      requestedAt: now(),
    });
    if (enqueued.created) {
      await deps.audit.appendAudit({
        space_id: before.spaceId,
        actor: action.principal,
        event_type: SCHEDULER_RUN_REQUESTED_EVENT,
        payload: {
          invocation_id: invocationId,
          before: schedulerJobMetadata(before),
          after: { ...schedulerJobMetadata(before), pending_invocation_id: invocationId },
        },
      });
    }
    changed = enqueued.created;
  }

  if (changed) {
    const jobs = (await deps.store.listSchedulerJobs()).filter((job) => job.spaceId === action.spaceId);
    try {
      await deps.adapter.updateMessage(action.spaceId, action.messageTs, "Schedules", {
        blocks: buildSchedulerBlocks(jobs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      (deps.log ?? console.error)(`scheduler controls: state changed but Slack refresh failed: ${message}`);
    }
  }
  return true;
}
