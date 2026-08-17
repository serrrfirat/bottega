/**
 * Durable scheduled-action runner (issue #86).
 *
 * Boot uses an explicit skip policy, not catch-up: on the first successful
 * tick, every occurrence strictly before boot time is audited as missed and
 * the job advances to its next future occurrence. The runner never replays a
 * backlog of actions after downtime.
 */
import type { MemoryProvider } from "../memory/types";
import type { AuditModule } from "../policy/audit";
import type { PolicyConfig } from "../policy/config";
import {
  SCHEDULER_ERROR_EVENT,
  SCHEDULER_FIRE_EVENT,
  SCHEDULER_MISSED_EVENT,
} from "../store/audit-events";
import type { Store } from "../store/db";
import { errorMessage } from "../tools/helpers";
import { nextCronFire } from "./cron";
import type {
  SchedulerActionContext,
  SchedulerActionRegistry,
  SchedulerJob,
} from "./types";

export const DEFAULT_SCHEDULER_POLL_INTERVAL_MS = 5000;
export const DEFAULT_SCHEDULER_FIRE_TIMEOUT_MS = 60_000;

export interface SchedulerTickDeps {
  store: Store;
  audit: AuditModule;
  registry: SchedulerActionRegistry;
  memoryProvider: MemoryProvider;
  postMessage: (spaceId: string, text: string) => Promise<string | undefined>;
  loadPolicy: (spaceId: string) => Promise<PolicyConfig>;
  log: (line: string) => void;
  now: () => number;
  /** True only for the first successful pass after process boot. */
  firstTick?: boolean;
  fireTimeoutMs?: number;
}

export interface SchedulerDeps extends Omit<SchedulerTickDeps, "now" | "firstTick"> {
  now?: () => number;
  pollIntervalMs?: number;
}

export interface Scheduler {
  start(): void;
  stop(): void;
}

/** Rejects after a bounded duration; the underlying action promise cannot be cancelled. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`scheduler action timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function auditError(deps: SchedulerTickDeps, job: SchedulerJob, error: string): Promise<void> {
  await deps.audit.appendAudit({
    space_id: job.spaceId,
    actor: "scheduler",
    event_type: SCHEDULER_ERROR_EVENT,
    payload: { id: job.id, action: job.action, error },
  });
}

/** Runs one deterministic scheduler pass. Tests call this directly with an injected clock. */
export async function tickScheduler(deps: SchedulerTickDeps): Promise<void> {
  const fireTime = deps.now();
  const context: SchedulerActionContext = {
    store: deps.store,
    audit: deps.audit,
    memoryProvider: deps.memoryProvider,
    postMessage: deps.postMessage,
    loadPolicy: deps.loadPolicy,
    log: deps.log,
    now: deps.now,
  };
  const jobs = await deps.store.listSchedulerJobs();

  for (const job of jobs) {
    if (!job.enabled) continue;
    const action = deps.registry.get(job.action);
    if (!action) {
      await auditError(deps, job, `unknown scheduler action: ${job.action}`);
      await deps.store.setSchedulerJobEnabled(job.id, false);
      continue;
    }

    if (deps.firstTick && job.nextFireAt < fireTime) {
      await deps.audit.appendAudit({
        space_id: job.spaceId,
        actor: "scheduler",
        event_type: SCHEDULER_MISSED_EVENT,
        payload: { id: job.id, action: job.action, scheduled_for: job.nextFireAt },
      });
      try {
        await deps.store.updateSchedulerNextFire(job.id, nextCronFire(job.cron, fireTime));
      } catch (err) {
        await auditError(deps, job, errorMessage(err));
        await deps.store.setSchedulerJobEnabled(job.id, false);
      }
      continue;
    }
    if (job.nextFireAt > fireTime) continue;

    let result: "ok" | "error" = "ok";
    try {
      await withTimeout(action.run(job.params, context), deps.fireTimeoutMs ?? DEFAULT_SCHEDULER_FIRE_TIMEOUT_MS);
    } catch (err) {
      result = "error";
      await auditError(deps, job, errorMessage(err));
    }
    await deps.audit.appendAudit({
      space_id: job.spaceId,
      actor: "scheduler",
      event_type: SCHEDULER_FIRE_EVENT,
      payload: { id: job.id, action: job.action, space_id: job.spaceId, result },
    });
    await deps.store.markSchedulerFired(job.id, result, fireTime);
  }
}

/** Background loop around {@link tickScheduler}. The first pass runs immediately. */
export function startScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_SCHEDULER_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let firstTick = true;

  const tick = async (): Promise<void> => {
    try {
      await tickScheduler({ ...deps, now, firstTick });
      firstTick = false;
    } catch (err) {
      deps.log(`scheduler: tick failed: ${errorMessage(err)}`);
    }
    // Chain from the end so a slow action can never overlap another pass
    // and execute the same still-due row twice.
    if (running && timer === null) {
      timer = setTimeout(() => {
        timer = null;
        void tick();
      }, pollIntervalMs);
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      firstTick = true;
      void tick();
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
