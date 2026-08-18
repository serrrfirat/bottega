/** Human-approved scheduler administration tools (issue #86; free-form surface #220). */
import type { AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import type { AuditModule } from "../policy/audit";
import {
  SCHEDULER_JOB_CREATED_EVENT,
  SCHEDULER_JOB_DELETED_EVENT,
} from "../store/audit-events";
import type { Store } from "../store/db";
import { errorMessage, toolError } from "../tools/helpers";
import { parseCron } from "./cron";
import type { SchedulerActionName, SchedulerActionRegistry } from "./types";

export const createSchedulerJobArgsSchema = z.object({
  action: z.enum(["standup_digest", "reflection", "org_pulse", "recurring_work", "ingest_poll", "kb_ingest", "send_message"]),
  /** The job's identity in the user's own words ("daily repository digest"). */
  description: z.string().optional(),
  /** Natural-language schedule for the user-facing reply ("every day at 10:00"). */
  schedule: z.string().optional(),
  cron: z.string(),
  params: z.record(z.string(), z.string()).optional(),
  space: z.string().optional(),
});
export const listSchedulerJobsArgsSchema = z.object({});
export const deleteSchedulerJobArgsSchema = z.object({ id: z.string() });

/** True for actions that target a space; org_pulse is the only org-wide (space-less) action. */
const SPACE_SCOPED_ACTIONS: Record<SchedulerActionName, boolean> = {
  standup_digest: true,
  reflection: true,
  org_pulse: false,
  recurring_work: true,
  ingest_poll: true,
  kb_ingest: true,
  send_message: true,
};

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Renders common 5-field cron shapes in user terms ("daily at 10:00 UTC",
 * "every 5 minutes"); falls back to the raw expression for anything else.
 */
export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, dom, month, dow] = fields;
  const at = (label: string): string | undefined => {
    if (minute !== "0" || !/^\d{1,2}$/.test(hour)) return undefined;
    return `${label} at ${hour.padStart(2, "0")}:00 UTC`;
  };
  if (month === "*" && dom === "*") {
    if (dow === "*") {
      const daily = at("daily");
      if (daily !== undefined) return daily;
    }
    if (dow === "1-5") {
      const weekdays = at("weekdays");
      if (weekdays !== undefined) return weekdays;
    }
    if (/^\d$/.test(dow)) {
      const named = at(`${WEEKDAY_NAMES[Number(dow)]}s`);
      if (named !== undefined) return named;
    }
  }
  if (dow === "*" && dom === "*" && month === "*" && minute === "0" && hour === "*") return "every hour";
  if (dow === "*" && dom === "*" && month === "*" && hour === "*" && /^(\*|\*\/\d+)$/.test(minute)) {
    const step = minute === "*" ? 1 : Number(minute.slice(2));
    return step === 1 ? "every minute" : `every ${step} minutes`;
  }
  return cron;
}

/**
 * Returns the custom SDK tools for durable scheduler administration.
 * Create/delete intentionally remain exec-tier by default, so they always
 * use the human-approval path. Listing is the only read-tier capability.
 */
export function schedulerToolDefinitions(
  store: Store,
  audit: AuditModule,
  registry: SchedulerActionRegistry,
): ToolDefinition[] {
  const create: ToolDefinition<typeof createSchedulerJobArgsSchema> = {
    name: "create_scheduler_job",
    label: "Create scheduler job",
    description:
      "Creates a durable recurring UTC cron job from a free-form description. `description` is the " +
      "recurring thing in the user's own words (e.g. \"daily repository digest\") and `schedule` is the " +
      "natural-language schedule (e.g. \"every day at 10:00\"); `cron` is the exact 5-field UTC " +
      "expression (minute hour day-of-month month day-of-week). The typed `action` is internal " +
      "machinery: pick the mechanism that matches the request (send_message for reminders and scheduled " +
      "messages, recurring_work for recurring non-code work, standup_digest/reflection for daily " +
      "digests, kb_ingest for KB refresh, org_pulse for the org-wide weekly pulse). Space-scoped " +
      "actions target `space` when given, otherwise this conversation's space — the destination is " +
      "always bound at creation, never a silent space-less job; org_pulse is org-wide. Requires human " +
      "approval (exec-tier tool).",
    parameters: createSchedulerJobArgsSchema,
    approval: "exec",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      try {
        parseCron(params.cron);
        if (!registry.has(params.action)) {
          return toolError(`scheduler action is not registered: ${params.action}`);
        }
        const spaceScoped = SPACE_SCOPED_ACTIONS[params.action] === true;
        let spaceId: string | null = null;
        let derivedSpace = false;
        if (spaceScoped) {
          const explicit = params.space?.trim();
          if (explicit) {
            spaceId = explicit;
          } else {
            // Destination seam (issue #220): the session file name IS the
            // conversation's space id (e.g. slack:C1.jsonl), the same seam
            // the work-item and object tools use.
            const conversationSpaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
            if (conversationSpaceId === undefined) {
              return toolError(
                `cannot create a ${params.action} job without a destination: pass \`space\` ` +
                  `(e.g. "slack:C123") or run this tool inside the target space conversation so ` +
                  `the destination can be derived`,
              );
            }
            spaceId = conversationSpaceId;
            derivedSpace = true;
          }
        }
        const jobParams: Record<string, string> = { ...(params.params ?? {}) };
        if (params.description !== undefined) jobParams.description = params.description;
        if (params.schedule !== undefined) jobParams.schedule = params.schedule;
        if (spaceScoped && spaceId !== null) jobParams.space = spaceId;
        const job = await store.createSchedulerJob({
          action: params.action,
          cron: params.cron,
          params: jobParams,
          spaceId,
          createdBy: "agent",
        });
        await audit.appendAudit({
          space_id: job.spaceId,
          actor: "agent",
          event_type: SCHEDULER_JOB_CREATED_EVENT,
          payload: {
            id: job.id,
            action: job.action,
            cron: job.cron,
            ...(job.spaceId !== null ? { space_id: job.spaceId } : undefined),
          },
        });
        // User-facing identity (issue #220): description + schedule +
        // destination, never the internal action name.
        const scheduleLabel = jobParams.schedule?.trim() || describeCron(params.cron);
        const descriptionLabel = jobParams.description?.trim() || params.action;
        const destinationLabel =
          job.spaceId === null ? "org-wide" : derivedSpace ? "this conversation" : `space ${job.spaceId}`;
        const summary = `${scheduleLabel} → ${destinationLabel}: ${descriptionLabel}`;
        return { content: [{ type: "text", text: JSON.stringify({ ...job, summary }) }] };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  const list: ToolDefinition<typeof listSchedulerJobsArgsSchema> = {
    name: "list_scheduler_jobs",
    label: "List scheduler jobs",
    description: "Lists durable recurring jobs, including next/last fire state and whether each job is enabled.",
    parameters: listSchedulerJobsArgsSchema,
    approval: "read",
    async execute(): Promise<AgentToolResult> {
      try {
        const jobs = await store.listSchedulerJobs();
        return { content: [{ type: "text", text: JSON.stringify(jobs) }] };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  const remove: ToolDefinition<typeof deleteSchedulerJobArgsSchema> = {
    name: "delete_scheduler_job",
    label: "Delete scheduler job",
    description: "Permanently deletes a durable recurring job by id. Requires human approval (exec-tier tool).",
    parameters: deleteSchedulerJobArgsSchema,
    approval: "exec",
    async execute(_toolCallId, params): Promise<AgentToolResult> {
      try {
        const deleted = await store.deleteSchedulerJob(params.id);
        if (!deleted) return toolError(`scheduler job not found: ${params.id}`);
        await audit.appendAudit({
          actor: "agent",
          event_type: SCHEDULER_JOB_DELETED_EVENT,
          payload: { id: params.id },
        });
        return { content: [{ type: "text", text: JSON.stringify({ id: params.id, deleted: true }) }] };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  return [create, list, remove];
}
