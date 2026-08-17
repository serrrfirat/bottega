import { SCHEDULER_ERROR_EVENT } from "../store/audit-events";
import type { SchedulerAction, SchedulerActionContext } from "./types";

const ACTION_NAME = "recurring_work" as const;
const ACTOR = "scheduler:recurring_work";

async function auditError(
  ctx: SchedulerActionContext,
  spaceId: string | null,
  error: string,
): Promise<void> {
  try {
    await ctx.audit.appendAudit({
      space_id: spaceId,
      actor: ACTOR,
      event_type: SCHEDULER_ERROR_EVENT,
      payload: { action: ACTION_NAME, error },
    });
  } catch (auditFailure) {
    const detail = auditFailure instanceof Error ? auditFailure.message : String(auditFailure);
    ctx.log(`[${ACTION_NAME}] failed to audit error: ${detail}`);
  }
}

/**
 * Dispatches recurring non-code work through the work-item queue (issue #131).
 * The queue supplies claim, transition audit, stale recovery, and the extension
 * worker's policy/tool enforcement. That worker completes and audits delivery,
 * or blocks with evidence, instead of creating a second execution path here.
 */
export const recurringWorkAction: SchedulerAction = {
  name: ACTION_NAME,
  async run(params, ctx) {
    const space = params.space?.trim() ?? "";
    const description = params.description?.trim() ?? "";

    if (!space) {
      await auditError(ctx, null, "space is required");
      return;
    }
    if (!description) {
      await auditError(ctx, space, "description is required");
      return;
    }

    const requester = params.requester ?? "scheduler";
    try {
      // createWorkItem owns the single work_item.created audit row.
      await ctx.store.createWorkItem({
        space_id: space,
        requester,
        description,
        delivery: "extension",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await auditError(ctx, space, `failed to create recurring work item: ${detail}`);
    }
  },
};
