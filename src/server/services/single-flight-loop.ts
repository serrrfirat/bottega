/**
 * A single-flight polling loop shared by the delivery poller and the outbox
 * post seam (issue #341): an immediate first pass, then one chained pass at
 * a time scheduled from the END of the previous one, so a slow in-flight pass
 * never overlaps the next tick (issue #70).
 *
 * `tick` runs one pass and is responsible for its own error logging (a
 * throwing tick would stop the chain, so callers wrap their pass in a
 * try/catch exactly as the two original loops did — one bad pass must not
 * kill the loop; the next interval retries from scratch on whatever the
 * caller dedupes on). The loop owns only the cadence and the in-flight
 * guard; it never assumes what a pass does.
 */
export interface SingleFlightLoop {
  start(): void;
  stop(): void;
}

export interface MakeSingleFlightLoopOpts {
  /** Runs exactly one pass; must handle its own errors and never throw. */
  tick: () => Promise<void>;
  /** Ms between the END of one pass and the start of the next. Default 5000. */
  intervalMs?: number;
}

/**
 * A background loop whose first pass runs immediately and whose subsequent
 * passes chain from the end of each one — the single-flight pattern both the
 * delivery poller and the outbox post seam share (issue #341). `stop()`
 * clears the pending timer so no further pass can start after it returns.
 */
export function makeSingleFlightLoop(opts: MakeSingleFlightLoopOpts): SingleFlightLoop {
  const intervalMs = opts.intervalMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const run = async (): Promise<void> => {
    await opts.tick();
    // Chain the next pass from the END of this one: an overlapping pass
    // (a fixed-interval timer while tick is still in flight) would re-read
    // state before the previous pass recorded its terminal rows and act a
    // second time. The next pass starts only after this one finished.
    if (running && timer === null) {
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, intervalMs);
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      void run(); // the nearest work is already pending: pass immediately
    },
    stop() {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}