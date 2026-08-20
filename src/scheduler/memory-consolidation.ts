/**
 * Scheduled memory consolidation (issue #272, epic #229 P2): the LLM leg of
 * SQLite memory consolidation runs IN THE WORKER, never in the server
 * process. The server's sqlite-gated trigger (src/server/services/
 * memory-consolidation-trigger.ts) enqueues a `scheduled` worker job with
 * action `memory_consolidation`; the executor dispatches it and THIS action
 * runs the real pipeline (maintainMemory) against the job-scoped store with
 * the model-call seam provided by the executor job context. The compaction
 * threshold (compactAfter) lives in the pipeline, so the trigger semantics
 * are unchanged — only WHERE the LLM leg runs moved.
 *
 * The action is worker-only: the server registry never registers it (an
 * in-process memory_consolidation scheduler row would run the removed
 * side-session pattern), so a DB-patched scheduler row fails closed as an
 * unknown action instead of silently no-oping.
 */
import { randomUUID } from "node:crypto";
import { maintainMemory } from "../memory/consolidation";
import type { Store } from "../store/db";
import type { SchedulerAction } from "./types";

const ACTION_NAME = "memory_consolidation" as const;

/**
 * Enqueues one scheduled memory-consolidation worker job (the server
 * trigger's dispatch). Org-wide (no space): consolidation covers the org
 * pool plus every principal pool, so the completion row is space-less — the
 * server seam consumes it and audits the fail-closed (no target channel);
 * the audit trail is the evidence.
 */
export async function dispatchMemoryConsolidationJob(store: Store): Promise<string> {
  const id = `mc_${randomUUID()}`;
  await store.enqueueJob({ id, kind: "scheduled", payload: { action: ACTION_NAME }, spaceId: null });
  return id;
}

/**
 * The registered worker-side action. Reads the model call from the job
 * context (the executor wires it over its driver) and fails loudly when a
 * process that cannot run the LLM leg — the server — ever fires it.
 * Returns the per-pool ConsolidationResult[] so the completion outbox row
 * + audit carry what actually happened.
 */
export function memoryConsolidationAction(): SchedulerAction {
  return {
    name: ACTION_NAME,
    async run(_params, ctx) {
      const modelCall = ctx.consolidationModelCall;
      if (!modelCall) {
        throw new Error(
          "memory_consolidation requires the executor's consolidation model call — " +
            "the server never runs this action in-process (issue #272)",
        );
      }
      return maintainMemory(ctx.store.getDb(), modelCall);
    },
  };
}
