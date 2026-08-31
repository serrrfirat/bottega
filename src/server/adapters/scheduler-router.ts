import { z } from "zod";
import type { AuditModule } from "../../policy/audit";
import { describeCron } from "../../scheduler/scheduler-tools";
import { schedulerJobMetadata } from "../../scheduler/store";
import type { SchedulerInvocation, SchedulerJob } from "../../scheduler/types";
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
  type SlackBlockPayload,
} from "./slack";
import { escapeMrkdwn, resolveBlockAction } from "./block-flow";

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
export function buildSchedulerBlocks(jobs: readonly SchedulerJob[]): SlackBlockPayload[] {
  const blocks: SlackBlockPayload[] = [
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
    const toggle = job.enabled
      ? {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "Pause" },
          action_id: SCHEDULER_PAUSE_ACTION_ID,
          value: schedulerActionValue(job),
        }
      : {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "Resume" },
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

export interface SchedulerRunNowRequest {
  invocationId: string;
  action: SchedulerInvocation["action"];
  spaceId: string;
  statusMessageTs: string;
}

export interface SchedulerActionDeps {
  store: Store;
  audit: AuditModule;
  adapter: SlackAdapter;
  now?: () => number;
  log?: (line: string) => void;
  onRunNowRequested?: (request: SchedulerRunNowRequest) => Promise<void> | void;
}

const SCHEDULER_FEEDBACK_CACHE_LIMIT = 256;

interface SchedulerRunNowCompletion {
  action: SchedulerInvocation["action"];
  result: "ok" | "error";
  error?: string;
}

export interface SchedulerRunNowFeedback {
  register(request: SchedulerRunNowRequest): Promise<void>;
  onInvocationComplete(invocation: SchedulerInvocation): Promise<void>;
}

/**
 * Correlates a Slack run-now status message with the runner's durable
 * completion callback. Completion can race the Slack post, so a just-finished
 * Slack-originated invocation is held until its status message is registered.
 */
export function createSchedulerRunNowFeedback(
  adapter: Pick<SlackAdapter, "updateMessage">,
  log: (line: string) => void = console.error,
): SchedulerRunNowFeedback {
  const pending = new Map<string, SchedulerRunNowRequest>();
  const completedBeforeRegistration = new Map<string, SchedulerRunNowCompletion>();

  const update = async (request: SchedulerRunNowRequest, completion: SchedulerRunNowCompletion): Promise<void> => {
    const text =
      completion.result === "error"
        ? `Run now failed — ${escapeMrkdwn(completion.error?.trim() || "scheduler action failed")} (${request.invocationId})`
        : request.action === "recurring_work"
          ? `Run now queued — agent work continues and will post here when finished (${request.invocationId})`
          : `Run now completed — ${request.invocationId}`;
    try {
      await adapter.updateMessage(request.spaceId, request.statusMessageTs, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`scheduler controls: terminal feedback failed: ${message}`);
    }
  };

  return {
    async register(request) {
      const completion = completedBeforeRegistration.get(request.invocationId);
      if (completion !== undefined) {
        completedBeforeRegistration.delete(request.invocationId);
        await update(request, completion);
        return;
      }
      pending.set(request.invocationId, request);
    },
    async onInvocationComplete(invocation) {
      const completion: SchedulerRunNowCompletion = {
        action: invocation.action,
        result: invocation.result === "error" ? "error" : "ok",
        ...(invocation.error === undefined ? {} : { error: invocation.error }),
      };
      const request = pending.get(invocation.id);
      if (request !== undefined) {
        pending.delete(invocation.id);
        await update(request, completion);
        return;
      }
      // Only Slack-originated manual runs can later register a status message;
      // scheduled runs and tool-originated manual runs need no in-memory hold.
      if (invocation.source !== "manual" || !invocation.id.startsWith("slack:")) return;
      completedBeforeRegistration.set(invocation.id, completion);
      while (completedBeforeRegistration.size > SCHEDULER_FEEDBACK_CACHE_LIMIT) {
        const oldest = completedBeforeRegistration.keys().next().value;
        if (oldest === undefined) break;
        completedBeforeRegistration.delete(oldest);
      }
    },
  };
}

/**
 * Resolves one same-space schedule control. Revision checks make stale or
 * repeated state-change clicks no-ops; run-now derives a stable invocation
 * identity from the rendered message so concurrent retries enqueue once.
 */
export async function resolveSchedulerAction(deps: SchedulerActionDeps, action: SlackAction): Promise<boolean> {
  let before: SchedulerJob | undefined;
  return resolveBlockAction(
    (line) => (deps.log ?? console.error)(line),
    action,
    {
      // Owned scheduler controls only; other action ids are ignored silently.
      owns: (a) =>
        a.actionId === SCHEDULER_PAUSE_ACTION_ID ||
        a.actionId === SCHEDULER_RESUME_ACTION_ID ||
        a.actionId === SCHEDULER_RUN_NOW_ACTION_ID,
      // All scheduler ignores are silent (no log line), matching the original.
      guard: async (a) => {
        const value = parseSchedulerActionValue(a.value);
        if (!value) return "";
        const job = await deps.store.getSchedulerJob(value.id);
        if (!job || job.spaceId !== a.spaceId || job.revision !== value.revision) return "";
        // Repeated state-change clicks are no-ops: a pause on an already
        // paused job (or a resume on an enabled one) changes nothing.
        if (a.actionId === SCHEDULER_PAUSE_ACTION_ID && !job.enabled) return "";
        if (a.actionId === SCHEDULER_RESUME_ACTION_ID && job.enabled) return "";
        before = job;
        return null;
      },
      settle: async (a) => {
        const job = before!;
        const value = parseSchedulerActionValue(a.value)!;
        const now = deps.now ?? Date.now;
        let changed = false;
        if (a.actionId === SCHEDULER_PAUSE_ACTION_ID) {
          const after = await deps.store.pauseSchedulerJob(job.id, value.revision);
          await deps.audit.appendAudit({
            space_id: after.spaceId,
            actor: a.principal,
            event_type: SCHEDULER_JOB_PAUSED_EVENT,
            payload: {
              invocation_id: `slack:${a.messageTs}:${a.actionId}:${job.id}:${value.revision}`,
              before: schedulerJobMetadata(job),
              after: schedulerJobMetadata(after),
            },
          });
          changed = true;
        } else if (a.actionId === SCHEDULER_RESUME_ACTION_ID) {
          const after = await deps.store.resumeSchedulerJob(job.id, value.revision, now());
          await deps.audit.appendAudit({
            space_id: after.spaceId,
            actor: a.principal,
            event_type: SCHEDULER_JOB_RESUMED_EVENT,
            payload: {
              invocation_id: `slack:${a.messageTs}:${a.actionId}:${job.id}:${value.revision}`,
              before: schedulerJobMetadata(job),
              after: schedulerJobMetadata(after),
            },
          });
          changed = true;
        } else {
          const invocationId = `slack:${a.messageTs}:${a.actionId}:${job.id}:${value.revision}`;
          const enqueued = await deps.store.enqueueSchedulerRunNow({
            jobId: job.id,
            expectedRevision: value.revision,
            invocationId,
            requestedAt: now(),
          });
          if (enqueued.created) {
            await deps.audit.appendAudit({
              space_id: job.spaceId,
              actor: a.principal,
              event_type: SCHEDULER_RUN_REQUESTED_EVENT,
              payload: {
                invocation_id: invocationId,
                before: schedulerJobMetadata(job),
                after: { ...schedulerJobMetadata(job), pending_invocation_id: invocationId },
              },
            });
            const description = escapeMrkdwn(job.params.description?.trim() || job.action);
            try {
              const statusMessageTs = await deps.adapter.postMessage(
                a.spaceId,
                `Run now working — ${description}`,
              );
              if (statusMessageTs !== undefined) {
                await deps.onRunNowRequested?.({ invocationId, action: job.action, spaceId: a.spaceId, statusMessageTs });
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              (deps.log ?? console.error)(`scheduler controls: working feedback failed: ${message}`);
            }
          }
          changed = enqueued.created;
        }
        // Acknowledged even when nothing changed (a concurrent run-now that
        // did not enqueue is still a handled click), but only a state change
        // triggers a rewrite.
        return { outcome: { changed } };
      },
      // Refresh the posted control panel only when state actually changed.
      rewrite: async (a, outcome) => {
        if (!outcome.changed) return;
        const jobs = (await deps.store.listSchedulerJobs()).filter((job) => job.spaceId === a.spaceId);
        try {
          await deps.adapter.updateMessage(a.spaceId, a.messageTs, "Schedules", {
            blocks: buildSchedulerBlocks(jobs),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          (deps.log ?? console.error)(`scheduler controls: state changed but Slack refresh failed: ${message}`);
        }
      },
    },
  );
}