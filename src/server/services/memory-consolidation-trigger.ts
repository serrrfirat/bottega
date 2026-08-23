/**
 * Server-side memory consolidation trigger (issues #272, #155, and #321):
 * a provider that reports explicit consolidation gets a scheduled
 * memory_consolidation WORKER job at boot and every 6 hours. The LLM leg
 * runs in the executor, never in this process. A provider that consolidates
 * on save needs no scheduled pass. An unsupported configured provider fails
 * loudly instead of looking like a successful maintenance no-op.
 */
import { errorMessage } from "../../tools/helpers";
import { dispatchMemoryConsolidationJob } from "../../scheduler/memory-consolidation";
import type { MemoryProvider } from "../../memory/types";
import type { Store } from "../../store/db";
import { makeSingleFlightLoop } from "./single-flight-loop";

/** The server-side cadence, preserved from the pre-#272 in-process run. */
export const DEFAULT_CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface MemoryConsolidationTriggerDeps {
  store: Store;
  /** Capability reporting is the only provider behavior this trigger reads. */
  memoryProvider: Pick<MemoryProvider, "capabilities">;
  log?: (line: string) => void;
}

export interface MemoryConsolidationTrigger {
  /**
   * One pass. Returns a job id when explicit consolidation is enqueued, or
   * null only when consolidation is provider-managed on save or another fire
   * is already running. An unsupported configured provider rejects.
   */
  fire(): Promise<string | null>;
  /** Fires the boot pass immediately and starts the 6-hour interval. */
  start(): void;
  stop(): void;
}

/**
 * Builds the trigger. `start()` fires the boot pass (matching the old
 * runMemoryMaintenance() at boot) and arms the cadence. The cadence is the
 * single-flight loop shared with the delivery poller and the outbox post
 * seam (issue #341 finding 6): an immediate first pass, then one chained
 * pass at a time scheduled from the END of the previous one, so an
 * overlapping pass cannot enqueue a consolidation job a second time. A
 * throwing pass is logged, never allowed to stop the chain.
 */
export function createMemoryConsolidationTrigger(
  deps: MemoryConsolidationTriggerDeps,
  opts: { intervalMs?: number } = {},
): MemoryConsolidationTrigger {
  let inFlight: Promise<string | null> | undefined;

  const fire = async (): Promise<string | null> => {
    const mode = deps.memoryProvider.capabilities.consolidation;
    if (mode === "unsupported") {
      throw new Error(
        "configured memory provider does not support required consolidation",
      );
    }
    if (mode === "on-save" || inFlight) return null;
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

  // One cadence tick is one fire; fires are themselves deduped, so a slow
  // pass never overlaps the next tick. tick must not throw — fire's only
  // rejection (an unsupported provider) is rejected up front by start(), but
  // keep the chain alive anyway, exactly like the sibling loops.
  const loop = makeSingleFlightLoop({
    tick: async () => {
      try {
        await fire();
      } catch (error) {
        deps.log?.(`[memory-consolidation] enqueue failed: ${errorMessage(error)}`);
      }
    },
    intervalMs: opts.intervalMs ?? DEFAULT_CONSOLIDATION_INTERVAL_MS,
  });

  return {
    fire,
    start() {
      const mode = deps.memoryProvider.capabilities.consolidation;
      if (mode === "unsupported") {
        throw new Error(
          "configured memory provider does not support required consolidation",
        );
      }
      if (mode === "on-save") return;
      loop.start();
    },
    stop() {
      loop.stop();
    },
  };
}
