import { auditSchedulerError } from "./digest-helpers";
import type { SchedulerAction } from "./types";

const ACTION_NAME = "recurring_work" as const;
const ACTOR = "scheduler:recurring_work";

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
      await auditSchedulerError(ctx, null, ACTION_NAME, ACTOR, "space is required");
      return;
    }
    if (!description) {
      await auditSchedulerError(ctx, space, ACTION_NAME, ACTOR, "description is required");
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
      await auditSchedulerError(ctx, space, ACTION_NAME, ACTOR, `failed to create recurring work item: ${detail}`);
    }
  },
};
