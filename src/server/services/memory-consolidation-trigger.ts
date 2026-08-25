/**
 * Server-side memory consolidation trigger (issues #272, #155, and #321),
 * migrated onto the reactive core as a sweep behavior (issue #356): a
 * provider that reports explicit consolidation gets a scheduled
 * memory_consolidation WORKER job at boot and every 6 hours. The LLM leg
 * runs in the executor, never in this process. A provider that consolidates
 * on save needs no scheduled pass. An unsupported configured provider fails
 * loudly instead of looking like a successful maintenance no-op.
 *
 * There is no MEMORY_BATCH_READY-style ledger event to react to yet — the
 * cadence is the issue #356 retained time-based case — but the bespoke
 * setInterval/single-flight loop is gone: the reactive core owns the
 * lifecycle (immediate first pass, chained cadence from each pass's end,
 * error isolation).
 */
import { errorMessage } from "../../tools/helpers";
import { dispatchMemoryConsolidationJob } from "../../scheduler/memory-consolidation";
import type { MemoryProvider } from "../../memory/types";
import type { ReactiveBehavior } from "../../events/reactive";
import { startReactiveCore } from "../../events/reactive";
import type { Store } from "../../store/db";

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
 * The shared fire logic: enqueues the scheduled consolidation job unless
 * consolidation is provider-managed on save or another fire is still in
 * flight (the guard exists so two cadence ticks can never enqueue a second
 * job while the first fire is pending). An unsupported configured provider
 * rejects instead of looking like a successful maintenance no-op.
 */
function createConsolidationFire(deps: MemoryConsolidationTriggerDeps): () => Promise<string | null> {
  let inFlight: Promise<string | null> | undefined;

  return async (): Promise<string | null> => {
    const mode = deps.memoryProvider.capabilities.consolidation;
    if (mode === "unsupported") {
      throw new Error("configured memory provider does not support required consolidation");
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
}

/**
 * The memory-consolidation behavior (issue #356): a sweep-only registration
 * (no ledger events to tail yet). `sweep` delegates to the shared guarded
 * fire and never throws — a failed enqueue must not kill the cadence chain,
 * exactly like the sibling seams.
 */
export function memoryConsolidationBehavior(
  deps: MemoryConsolidationTriggerDeps,
  fire: () => Promise<string | null> = createConsolidationFire(deps),
): ReactiveBehavior {
  return {
    id: "memory-consolidation-trigger",
    events: [],
    sweepIntervalMs: DEFAULT_CONSOLIDATION_INTERVAL_MS,
    sweep: async () => {
      try {
        await fire();
      } catch (error) {
        deps.log?.(`[memory-consolidation] enqueue failed: ${errorMessage(error)}`);
      }
    },
  };
}

/**
 * Builds the trigger. `start()` fires the boot pass (matching the old
 * runMemoryMaintenance() at boot) and arms the cadence through a
 * single-behavior reactive core. An unsupported configured provider throws
 * on start (and rejects on fire); an on-save provider never starts a loop.
 */
export function createMemoryConsolidationTrigger(
  deps: MemoryConsolidationTriggerDeps,
  opts: { intervalMs?: number } = {},
): MemoryConsolidationTrigger {
  const fire = createConsolidationFire(deps);
  const mode = deps.memoryProvider.capabilities.consolidation;
  if (mode === "on-save" || mode === "unsupported") {
    return {
      fire,
      start() {
        const current = deps.memoryProvider.capabilities.consolidation;
        if (current === "unsupported") {
          throw new Error("configured memory provider does not support required consolidation");
        }
      },
      stop() {},
    };
  }

  const behavior = memoryConsolidationBehavior(deps, fire);
  // The production cadence default lives on the behavior; a caller-provided
  // interval (tests, tuning) overrides it.
  if (opts.intervalMs !== undefined) behavior.sweepIntervalMs = opts.intervalMs;
  const core = startReactiveCore(deps.store, [behavior], {});
  return {
    fire,
    start() {
      const current = deps.memoryProvider.capabilities.consolidation;
      if (current === "unsupported") {
        throw new Error("configured memory provider does not support required consolidation");
      }
      core.start();
    },
    stop() {
      core.stop();
    },
  };
}
