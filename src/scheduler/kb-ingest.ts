/**
 * Scheduled KB refresh action (epic #170 Wave 2): a durable "kb_ingest"
 * scheduler job (create_scheduler_job, params.source = optional source id,
 * params.space = optional target space) dispatches `kind=kb` worker jobs
 * instead of ingesting in the server process. The containerized worker
 * fetches + parses the untrusted web content with egress scoped to the
 * declared source hosts; this action only enqueues (orchestration).
 */
import { SCHEDULER_ERROR_EVENT } from "../store/audit-events";
import type { KbConfig } from "../kb/config";
import { dispatchKbIngestJobs } from "../kb/dispatch";
import type { SchedulerAction, SchedulerActionContext } from "./types";

const ACTION_NAME = "kb_ingest" as const;
const ACTOR = "scheduler:kb_ingest";

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
 * The registered scheduler action, bound to the DECLARED KB config (the
 * server root loads config/kb.yml at boot; the action dispatches against
 * that same declared set — never an arbitrary URL).
 */
export function kbIngestAction(config: KbConfig): SchedulerAction {
  return {
    name: ACTION_NAME,
    async run(params, ctx) {
      const source = params.source?.trim() || undefined;
      const space = params.space?.trim() || undefined;
      try {
        await dispatchKbIngestJobs(ctx.store, config, { source, spaceId: space ?? null });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await auditError(ctx, space ?? null, `failed to dispatch KB ingest: ${detail}`);
      }
    },
  };
}
