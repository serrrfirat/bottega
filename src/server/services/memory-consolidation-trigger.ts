/**
 * Server-side memory consolidation trigger (issue #272, epic #229 P2): the
 * sqlite-backed server enqueues a `scheduled` memory_consolidation WORKER
 * job at boot and every 6 hours — the LLM leg runs in the executor (the
 * job-context model-call seam), never in this process. The trigger
 * semantics are unchanged (sqlite backend gate + the pipeline's compaction
 * threshold); only WHERE the LLM leg runs moved. The model-call seam is
 * deliberately ABSENT from this module's surface: the trigger's only side
 * effect is the enqueue.
 */
import { errorMessage } from "../../tools/helpers";
import { dispatchMemoryConsolidationJob } from "../../scheduler/memory-consolidation";
import type { Store } from "../../store/db";

/** The server-side cadence, preserved from the pre-#272 in-process run. */
export const DEFAULT_CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface MemoryConsolidationTriggerDeps {
  store: Store;
  /** Only the backend gate is read; the model call is NOT part of this surface. */
  memoryProvider: { backend: "mem0" | "sqlite" };
  log?: (line: string) => void;
}

export interface MemoryConsolidationTrigger {
  /**
   * One pass: enqueue one scheduled job when the backend is sqlite and no
   * pass is already in flight. Returns the job id, or null when skipped
   * (non-sqlite backend or a fire already running).
   */
  fire(): Promise<string | null>;
  /** Fires the boot pass immediately and starts the 6-hour interval. */
  start(): void;
  stop(): void;
}

/**
 * Builds the trigger. `start()` fires the boot pass (matching the old
 * runMemoryMaintenance() at boot) and arms the interval; the in-flight
 * guard keeps two ticks from ever enqueueing concurrently.
 */
export function createMemoryConsolidationTrigger(
  deps: MemoryConsolidationTriggerDeps,
  opts: { intervalMs?: number } = {},
): MemoryConsolidationTrigger {
  let inFlight: Promise<string | null> | undefined;
  let timer: ReturnType<typeof setInterval> | null = null;

  const fire = async (): Promise<string | null> => {
    if (deps.memoryProvider.backend !== "sqlite" || inFlight) return null;
    inFlight = (async () => {
      try {
        const id = await dispatchMemoryConsolidationJob(deps.store);
        deps.log?.(`[memory-consolidation] enqueued scheduled job ${id} — the worker runs the LLM leg`);
        return id;
      } catch (error) {
        deps.log?.(`[memory-consolidation] enqueue failed: ${errorMessage(error)}`);
        return null;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return {
    fire,
    start() {
      if (deps.memoryProvider.backend !== "sqlite") return;
      void fire();
      if (timer !== null) return;
      timer = setInterval(() => {
        void fire();
      }, opts.intervalMs ?? DEFAULT_CONSOLIDATION_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
