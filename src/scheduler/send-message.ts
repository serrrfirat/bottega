/**
 * Deterministic scheduled message action (issue #220): fires and posts the
 * message directly to the bound space through the scheduler context's
 * postMessage seam — no executor round-trip. This is the mechanism behind
 * "remind me at 3pm" requests. The runner audits the fire itself; this
 * handler audits its own failures before throwing so the runner records an
 * error completion and can surface it to a waiting Slack user.
 */
import { SCHEDULER_ERROR_EVENT } from "../store/audit-events";
import type { SchedulerAction, SchedulerActionContext } from "./types";

const ACTION_NAME = "send_message" as const;
const ACTOR = "scheduler:send_message";

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

/** Posts params.text to params.space (job.spaceId threaded in by the runner). */
export const sendMessageAction: SchedulerAction = {
  name: ACTION_NAME,
  async run(params, ctx) {
    const text = params.text?.trim() ?? "";
    const space = params.space?.trim() ?? "";

    if (!text) {
      await auditError(ctx, space || null, "text is required");
      throw new Error("text is required");
    }
    if (!space) {
      await auditError(ctx, null, "space is required");
      throw new Error("space is required");
    }
    try {
      await ctx.postMessage(space, text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const reason = `failed to post scheduled message: ${detail}`;
      await auditError(ctx, space, reason);
      throw new Error(reason, { cause: error });
    }
  },
};
