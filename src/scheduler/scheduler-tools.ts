/** Human-approved scheduler administration tools (issue #86). */
import type { AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { AuditModule } from "../policy/audit";
import {
  SCHEDULER_JOB_CREATED_EVENT,
  SCHEDULER_JOB_DELETED_EVENT,
} from "../store/audit-events";
import type { Store } from "../store/db";
import { errorMessage, toolError } from "../tools/helpers";
import { parseCron } from "./cron";
import type { SchedulerActionRegistry } from "./types";

export const createSchedulerJobArgsSchema = z.object({
  action: z.enum(["standup_digest", "reflection", "org_pulse", "recurring_work"]),
  cron: z.string(),
  params: z.record(z.string(), z.string()).optional(),
  space: z.string().optional(),
});
export const listSchedulerJobsArgsSchema = z.object({});
export const deleteSchedulerJobArgsSchema = z.object({ id: z.string() });

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
      "Creates a durable recurring UTC cron job for a registered proactive action. " +
      "The cron has five fields: minute hour day-of-month month day-of-week. " +
      "Requires human approval (exec-tier tool).",
    parameters: createSchedulerJobArgsSchema,
    approval: "exec",
    async execute(_toolCallId, params): Promise<AgentToolResult> {
      try {
        parseCron(params.cron);
        if (!registry.has(params.action)) {
          return toolError(`scheduler action is not registered: ${params.action}`);
        }
        const job = await store.createSchedulerJob({
          action: params.action,
          cron: params.cron,
          params: params.params,
          spaceId: params.space,
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
            ...(job.spaceId !== null ? { space_id: job.spaceId } : {}),
          },
        });
        return { content: [{ type: "text", text: JSON.stringify(job) }] };
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
