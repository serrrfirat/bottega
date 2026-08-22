/**
 * Shared scheduler audit helpers (issue #341, #30): the recurring-work +
 * kb-ingest `auditError` helper and the standup/reflection digest-failure
 * catch block were copy-pasted in each action file, identical except for the
 * action name, actor, and log prefix. Both live here now. Each helper logs a
 * failed failure-audit instead of throwing, so the scheduler runner's outer
 * log always carries the reason.
 */
import { DIGEST_FAILED_EVENT, SCHEDULER_ERROR_EVENT } from "../store/audit-events";
import { errorMessage } from "../tools/helpers";
import type { SchedulerActionContext } from "./types";

/**
 * Appends a `scheduler.error` audit for a scheduler action (issue #341).
 * Used by the recurring-work and kb-ingest actions; both write the same row
 * shape, so this is the single place that pins it.
 */
export async function auditSchedulerError(
  ctx: SchedulerActionContext,
  spaceId: string | null,
  action: string,
  actor: string,
  error: string,
): Promise<void> {
  try {
    await ctx.audit.appendAudit({
      space_id: spaceId,
      actor,
      event_type: SCHEDULER_ERROR_EVENT,
      payload: { action, error },
    });
  } catch (auditFailure) {
    const detail = auditFailure instanceof Error ? auditFailure.message : String(auditFailure);
    ctx.log(`[${action}] failed to audit error: ${detail}`);
  }
}

/**
 * Appends a standard `digest.failed` audit for a space-scoped digest action
 * (issue #341). Used by the standup and reflection actions, which share the
 * same failure shape. A failed failure-audit is logged, never thrown.
 */
export async function auditDigestFailure(
  ctx: SchedulerActionContext,
  spaceId: string | null,
  reason: string,
  logPrefix: string,
): Promise<void> {
  try {
    await ctx.audit.appendAudit({
      space_id: spaceId,
      actor: "scheduler",
      event_type: DIGEST_FAILED_EVENT,
      payload: { reason },
    });
  } catch (auditError) {
    ctx.log(`${logPrefix} failed (${reason}); failure audit also failed: ${errorMessage(auditError)}`);
  }
}