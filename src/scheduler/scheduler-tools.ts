/** Human-approved scheduler administration tools (issues #86, #220, #308). */
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import type { AuditModule } from "../policy/audit";
import {
  SCHEDULER_JOB_CREATED_EVENT,
  SCHEDULER_JOB_DELETED_EVENT,
  SCHEDULER_JOB_PAUSED_EVENT,
  SCHEDULER_JOB_RESUMED_EVENT,
  SCHEDULER_JOB_UPDATED_EVENT,
  SCHEDULER_RUN_REQUESTED_EVENT,
} from "../store/audit-events";
import type { Store } from "../store/db";
import { errorMessage, toolError } from "../tools/helpers";
import { parseCron } from "./cron";
import { schedulerJobMetadata } from "./store";
import {
  DURABLE_ACTION_NAMES,
  type DurableSchedulerActionName,
  type SchedulerActionRegistry,
  type SchedulerJob,
} from "./types";

/**
 * The scheduler action-name schema (issue #341), derived from the single
 * source of truth `DURABLE_ACTION_NAMES` in types.ts — so job-creation
 * validation, the registry type, and the space-scoping lookup never drift
 * from each other. Worker-only actions are deliberately not acceptable as
 * durable job actions and are absent here.
 */
const schedulerActionSchema = z.enum(DURABLE_ACTION_NAMES);

export const createSchedulerJobArgsSchema = z
  .object({
    action: schedulerActionSchema,
    /** The job's identity in the user's own words ("daily repository digest"). */
    description: z.string().optional(),
    /** Natural-language schedule for the user-facing reply ("every day at 10:00"). */
    schedule: z.string().optional(),
    cron: z.string(),
    /**
     * Action-specific string parameters. For `send_message`, the message body
     * is `text` (not `content`); the scheduler runner passes this unchanged to
     * the registered action.
     */
    params: z.record(z.string(), z.string()).optional(),
    space: z.string().optional(),
  })
  .refine(
    (value) => value.action !== "send_message" || Boolean(value.params?.text?.trim()),
    "send_message params.text is required",
  );
export const listSchedulerJobsArgsSchema = z.object({});
export const updateSchedulerJobArgsSchema = z
  .object({
    id: z.string().min(1),
    expected_revision: z.number().int().positive(),
    action: schedulerActionSchema.optional(),
    cron: z.string().optional(),
    params: z.record(z.string(), z.string()).optional(),
  })
  .refine((value) => value.action !== undefined || value.cron !== undefined || value.params !== undefined, {
    message: "update requires at least one supplied field",
  })
  .refine(
    (value) => value.action !== "send_message" || value.params === undefined || Boolean(value.params.text?.trim()),
    "send_message params.text is required",
  );
const schedulerJobRevisionArgs = {
  id: z.string().min(1),
  expected_revision: z.number().int().positive(),
};
export const pauseSchedulerJobArgsSchema = z.object(schedulerJobRevisionArgs);
export const resumeSchedulerJobArgsSchema = pauseSchedulerJobArgsSchema;
export const runSchedulerJobNowArgsSchema = z.object({
  ...schedulerJobRevisionArgs,
  invocation_id: z
    .string()
    .transform((value) => value.trim())
    .refine(
      (value) => value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(value),
      "invocation_id must be 1-200 letters, numbers, dots, colons, underscores, or dashes",
    )
    .optional(),
});
export const deleteSchedulerJobArgsSchema = z.object({ id: z.string().min(1) });

/** True for actions that target a space; org_pulse is the only org-wide (space-less) action. */
const SPACE_SCOPED_ACTIONS = {
  standup_digest: true,
  reflection: true,
  org_pulse: false,
  recurring_work: true,
  ingest_poll: true,
  kb_ingest: true,
  send_message: true,
  governance_digest: true,
  weekly_memory_review: true,
} satisfies Record<DurableSchedulerActionName, boolean>;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface SchedulerToolOptions {
  actor?: string;
  now?: () => number;
  /**
   * Secondary authority seam for a space session that targets an org-wide
   * or foreign-space row. Server wiring routes this through the existing
   * approval gate. Absent means fail closed. An unpinned MCP caller is
   * already governed by its org policy gate and has no conversation space.
   */
  authorizeCrossSpace?: (request: {
    tool: string;
    invocationId: string;
    sessionSpaceId: string;
    targetSpaceId: string | null;
  }) => Promise<boolean>;
  /** Optional Slack renderer. Only the current space's rows are passed. */
  renderList?: (spaceId: string, jobs: SchedulerJob[]) => Promise<void>;
}

interface SchedulerJobSummary extends SchedulerJob {
  summary: string;
}

interface SchedulerRunNowResult {
  invocationId: string;
  enqueued: boolean;
  status: "pending" | "running" | "completed";
  jobId: string;
}

interface SchedulerDeleteResult {
  id: string;
  deleted: true;
}

type SchedulerToolResultPayload =
  | SchedulerJob
  | SchedulerJob[]
  | SchedulerJobSummary
  | SchedulerRunNowResult
  | SchedulerDeleteResult;

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


function sessionSpaceId(ctx: ExtensionContext | undefined): string | undefined {
  return sessionIdFromFilePath(ctx?.sessionManager?.getSessionFile());
}

async function authorizeJob(
  options: SchedulerToolOptions,
  toolName: string,
  invocationId: string,
  sessionSpace: string | undefined,
  targetSpace: string | null,
): Promise<boolean> {
  if (sessionSpace === undefined || targetSpace === sessionSpace) return true;
  if (!options.authorizeCrossSpace) return false;
  return options.authorizeCrossSpace({
    tool: toolName,
    invocationId,
    sessionSpaceId: sessionSpace,
    targetSpaceId: targetSpace,
  });
}

function result(value: SchedulerToolResultPayload): AgentToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/**
 * Loads a scheduler job and asserts the caller may reach it, collapsing the
 * getSchedulerJob + not-found + cross-space authorization prologue that every
 * single-job tool used to repeat (issue #341). Returns the job or throws with
 * the exact error shapes those tools surfaced, so the shared try/catch in the
 * execute handlers turns them into identical toolError results.
 */
async function resolveAuthorizedJob(
  store: Store,
  options: SchedulerToolOptions,
  name: string,
  toolCallId: string,
  spaceId: string | undefined,
  jobId: string,
): Promise<SchedulerJob> {
  const before = await store.getSchedulerJob(jobId);
  if (!before) throw new Error(`scheduler job not found: ${jobId}`);
  if (!(await authorizeJob(options, name, toolCallId, spaceId, before.spaceId))) {
    throw new Error("scheduler job belongs to a foreign space or org scope; org approval is required");
  }
  return before;
}

/** Returns the canonical custom tools for durable scheduler administration. */
export function schedulerToolDefinitions(
  store: Store,
  audit: AuditModule,
  registry: SchedulerActionRegistry,
  options: SchedulerToolOptions = {},
): ToolDefinition[] {
  const actor = options.actor ?? "agent";
  const now = options.now ?? Date.now;

  const create: ToolDefinition<typeof createSchedulerJobArgsSchema> = {
    name: "create_scheduler_job",
    label: "Create scheduler job",
    description:
      "Creates a durable recurring UTC cron job. Space-scoped actions default to this conversation. " +
      "An explicit foreign space or org-wide action requires org authority. " +
      "For send_message, params.text is the message body (never params.content). Requires human approval.",
    parameters: createSchedulerJobArgsSchema,
    approval: "exec",
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      try {
        parseCron(params.cron);
        if (!registry.has(params.action)) return toolError(`scheduler action is not registered: ${params.action}`);
        const currentSpace = sessionSpaceId(ctx);
        const spaceScoped = SPACE_SCOPED_ACTIONS[params.action] === true;
        let spaceId: string | null = null;
        let derivedSpace = false;
        if (spaceScoped) {
          const explicit = params.space?.trim();
          if (explicit) {
            spaceId = explicit;
          } else {
            if (currentSpace === undefined) {
              return toolError(
                `cannot create a ${params.action} job without a destination: pass \`space\` or run this tool inside the target space conversation`,
              );
            }
            spaceId = currentSpace;
            derivedSpace = true;
          }
        }
        if (!(await authorizeJob(options, create.name, toolCallId, currentSpace, spaceId))) {
          return toolError("scheduler job belongs to a foreign space or org scope; org approval is required");
        }
        const jobParams = { ...params.params };
        if (params.description !== undefined) jobParams.description = params.description;
        if (params.schedule !== undefined) jobParams.schedule = params.schedule;
        if (spaceScoped && spaceId !== null) jobParams.space = spaceId;
        const job = await store.createSchedulerJob({
          action: params.action,
          cron: params.cron,
          params: jobParams,
          spaceId,
          createdBy: actor,
          createdAt: now(),
        });
        await audit.appendAudit({
          space_id: job.spaceId,
          actor,
          event_type: SCHEDULER_JOB_CREATED_EVENT,
          payload: {
            id: job.id,
            action: job.action,
            cron: job.cron,
            invocation_id: toolCallId,
            before: null,
            after: schedulerJobMetadata(job),
            ...(job.spaceId !== null ? { space_id: job.spaceId } : undefined),
          },
        });
        const scheduleLabel = jobParams.schedule?.trim() || describeCron(params.cron);
        const descriptionLabel = jobParams.description?.trim() || params.action;
        const destinationLabel =
          job.spaceId === null ? "org-wide" : derivedSpace ? "this conversation" : `space ${job.spaceId}`;
        return result({ ...job, summary: `${scheduleLabel} → ${destinationLabel}: ${descriptionLabel}` });
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  const list: ToolDefinition<typeof listSchedulerJobsArgsSchema> = {
    name: "list_scheduler_jobs",
    label: "List scheduler jobs",
    description: "Lists deterministic schedule state, revision, next/last fire, and enabled state for this space.",
    parameters: listSchedulerJobsArgsSchema,
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      try {
        const currentSpace = sessionSpaceId(ctx);
        const all = await store.listSchedulerJobs();
        const jobs = currentSpace === undefined ? all : all.filter((job) => job.spaceId === currentSpace);
        if (currentSpace !== undefined && options.renderList) await options.renderList(currentSpace, jobs);
        return result(jobs);
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  const update: ToolDefinition<typeof updateSchedulerJobArgsSchema> = {
    name: "update_scheduler_job",
    label: "Update scheduler job",
    description:
      "Changes only supplied action, cron, or parameter fields. Requires the current revision. " +
      "For send_message, params.text is the message body (never params.content).",
    parameters: updateSchedulerJobArgsSchema,
    approval: "exec",
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      try {
        const before = await resolveAuthorizedJob(store, options, update.name, toolCallId, sessionSpaceId(ctx), params.id);
        if (params.action !== undefined && !registry.has(params.action)) {
          return toolError(`scheduler action is not registered: ${params.action}`);
        }
        const resultingAction = params.action ?? before.action;
        const resultingParams = params.params ?? before.params;
        if (resultingAction === "send_message" && !resultingParams.text?.trim()) {
          return toolError("send_message params.text is required");
        }
        if (
          params.action !== undefined &&
          SPACE_SCOPED_ACTIONS[params.action] !== (before.spaceId !== null)
        ) {
          return toolError("scheduler action scope cannot change between space and org");
        }
        if (params.cron !== undefined) parseCron(params.cron);
        const after = await store.updateSchedulerJob({
          id: params.id,
          expectedRevision: params.expected_revision,
          now: now(),
          ...(params.action !== undefined ? { action: params.action } : undefined),
          ...(params.cron !== undefined ? { cron: params.cron } : undefined),
          ...(params.params !== undefined ? { params: params.params } : undefined),
        });
        await audit.appendAudit({
          space_id: after.spaceId,
          actor,
          event_type: SCHEDULER_JOB_UPDATED_EVENT,
          payload: {
            invocation_id: toolCallId,
            before: schedulerJobMetadata(before),
            after: schedulerJobMetadata(after),
          },
        });
        return result(after);
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  const pause: ToolDefinition<typeof pauseSchedulerJobArgsSchema> = {
    name: "pause_scheduler_job",
    label: "Pause scheduler job",
    description: "Pauses future scheduled claims without deleting the job or its history. Requires the current revision.",
    parameters: pauseSchedulerJobArgsSchema,
    approval: "exec",
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      try {
        const before = await resolveAuthorizedJob(store, options, pause.name, toolCallId, sessionSpaceId(ctx), params.id);
        const after = await store.pauseSchedulerJob(params.id, params.expected_revision);
        await audit.appendAudit({
          space_id: after.spaceId,
          actor,
          event_type: SCHEDULER_JOB_PAUSED_EVENT,
          payload: { invocation_id: toolCallId, before: schedulerJobMetadata(before), after: schedulerJobMetadata(after) },
        });
        return result(after);
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  const resume: ToolDefinition<typeof resumeSchedulerJobArgsSchema> = {
    name: "resume_scheduler_job",
    label: "Resume scheduler job",
    description: "Resumes a paused job and computes its next fire from the resume time. Requires the current revision.",
    parameters: resumeSchedulerJobArgsSchema,
    approval: "exec",
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      try {
        const before = await resolveAuthorizedJob(store, options, resume.name, toolCallId, sessionSpaceId(ctx), params.id);
        const after = await store.resumeSchedulerJob(params.id, params.expected_revision, now());
        await audit.appendAudit({
          space_id: after.spaceId,
          actor,
          event_type: SCHEDULER_JOB_RESUMED_EVENT,
          payload: { invocation_id: toolCallId, before: schedulerJobMetadata(before), after: schedulerJobMetadata(after) },
        });
        return result(after);
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  const runNow: ToolDefinition<typeof runSchedulerJobNowArgsSchema> = {
    name: "run_scheduler_job_now",
    label: "Run scheduler job now",
    description: "Enqueues one ordinary durable execution without changing the recurring cron or next fire.",
    parameters: runSchedulerJobNowArgsSchema,
    approval: "exec",
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      try {
        const before = await resolveAuthorizedJob(store, options, runNow.name, toolCallId, sessionSpaceId(ctx), params.id);
        if (!registry.has(before.action)) return toolError(`scheduler action is not registered: ${before.action}`);
        const invocationId = params.invocation_id?.trim() || (toolCallId !== "0" ? toolCallId : `si_${randomUUID()}`);
        const enqueued = await store.enqueueSchedulerRunNow({
          jobId: before.id,
          expectedRevision: params.expected_revision,
          invocationId,
          requestedAt: now(),
        });
        if (enqueued.created) {
          await audit.appendAudit({
            space_id: before.spaceId,
            actor,
            event_type: SCHEDULER_RUN_REQUESTED_EVENT,
            payload: {
              invocation_id: invocationId,
              before: schedulerJobMetadata(before),
              after: { ...schedulerJobMetadata(before), pending_invocation_id: invocationId },
            },
          });
        }
        return result({
          invocationId,
          enqueued: enqueued.created,
          status: enqueued.invocation.status,
          jobId: before.id,
        });
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  const remove: ToolDefinition<typeof deleteSchedulerJobArgsSchema> = {
    name: "delete_scheduler_job",
    label: "Delete scheduler job",
    description: "Permanently deletes a durable recurring job by id. Requires human approval.",
    parameters: deleteSchedulerJobArgsSchema,
    approval: "exec",
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      try {
        const before = await resolveAuthorizedJob(store, options, remove.name, toolCallId, sessionSpaceId(ctx), params.id);
        const deleted = await store.deleteSchedulerJob(params.id);
        if (!deleted) return toolError(`scheduler job not found: ${params.id}`);
        await audit.appendAudit({
          space_id: before.spaceId,
          actor,
          event_type: SCHEDULER_JOB_DELETED_EVENT,
          payload: {
            id: params.id,
            invocation_id: toolCallId,
            before: schedulerJobMetadata(before),
            after: null,
          },
        });
        return result({ id: params.id, deleted: true });
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  return [create, list, update, pause, resume, runNow, remove];
}
