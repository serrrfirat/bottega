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
import type { SlackBlockPayload } from "../server/adapters/slack";
import {
  SCHEDULER_ERROR_EVENT,
  SCHEDULER_FIRE_EVENT,
  SCHEDULER_MISSED_EVENT,
} from "../store/audit-events";
import type { Store } from "../store/db";
import { errorMessage, withTimeout } from "../tools/helpers";
import { nextCronFire } from "./cron";
import type {
  SchedulerActionContext,
  SchedulerActionRegistry,
  SchedulerInvocation,
  SchedulerJob,
} from "./types";

export const DEFAULT_SCHEDULER_POLL_INTERVAL_MS = 5000;
export const DEFAULT_SCHEDULER_FIRE_TIMEOUT_MS = 60_000;

export interface SchedulerTickDeps {
  store: Store;
  audit: AuditModule;
  registry: SchedulerActionRegistry;
  memoryProvider: MemoryProvider;
  postMessage: (spaceId: string, text: string, opts?: { blocks?: SlackBlockPayload[] }) => Promise<string | undefined>;
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

async function auditError(
  deps: SchedulerTickDeps,
  execution: Pick<SchedulerJob, "id" | "action" | "spaceId">,
  error: string,
  invocationId?: string,
): Promise<void> {
  await deps.audit.appendAudit({
    space_id: execution.spaceId,
    actor: "scheduler",
    event_type: SCHEDULER_ERROR_EVENT,
    payload: {
      id: execution.id,
      action: execution.action,
      error,
      ...(invocationId !== undefined ? { invocation_id: invocationId } : undefined),
    },
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

  // First durably enqueue each due cron occurrence. The store snapshots the
  // row and advances next_fire_at in one immediate transaction. An edit or
  // pause that wins first prevents this stale occurrence claim; a claim that
  // wins first keeps its snapshot while the edit affects future occurrences.
  for (const job of jobs) {
    if (!job.enabled) continue;
    const action = deps.registry.get(job.action);
    if (!action) {
      await auditError(deps, job, `unknown scheduler action: ${job.action}`);
      await deps.store.setSchedulerJobEnabled(job.id, false);
      continue;
    }
    if (deps.firstTick && job.nextFireAt < fireTime) {
      try {
        const advanced = await deps.store.skipSchedulerOccurrence(
          job.id,
          job.nextFireAt,
          nextCronFire(job.cron, fireTime),
        );
        if (advanced) {
          await deps.audit.appendAudit({
            space_id: job.spaceId,
            actor: "scheduler",
            event_type: SCHEDULER_MISSED_EVENT,
            payload: { id: job.id, action: job.action, scheduled_for: job.nextFireAt },
          });
        }
      } catch (error) {
        await auditError(deps, job, errorMessage(error));
        await deps.store.setSchedulerJobEnabled(job.id, false);
      }
      continue;
    }
    if (job.nextFireAt <= fireTime) {
      await deps.store.claimScheduledSchedulerInvocation(job.id, job.nextFireAt, fireTime);
    }
  }

  // Manual and cron occurrences share this ordinary durable claim/fire path.
  let invocation: SchedulerInvocation | null;
  while ((invocation = await deps.store.claimNextSchedulerInvocation(fireTime)) !== null) {
    const action = deps.registry.get(invocation.action);
    let fireResult: "ok" | "error" = "ok";
    if (!action) {
      fireResult = "error";
      await auditError(
        deps,
        { id: invocation.jobId, action: invocation.action, spaceId: invocation.spaceId },
        `unknown scheduler action: ${invocation.action}`,
        invocation.id,
      );
    } else {
      try {
        const invocationParams = { ...invocation.params };
        if (invocationParams.space === undefined && invocation.spaceId !== null) {
          invocationParams.space = invocation.spaceId;
        }
        const timeoutMs = deps.fireTimeoutMs ?? DEFAULT_SCHEDULER_FIRE_TIMEOUT_MS;
        await withTimeout(
          action.run(invocationParams, context),
          timeoutMs,
          `scheduler action timed out after ${timeoutMs}ms`,
        );
      } catch (error) {
        fireResult = "error";
        await auditError(
          deps,
          { id: invocation.jobId, action: invocation.action, spaceId: invocation.spaceId },
          errorMessage(error),
          invocation.id,
        );
      }
    }
    await deps.audit.appendAudit({
      space_id: invocation.spaceId,
      actor: "scheduler",
      event_type: SCHEDULER_FIRE_EVENT,
      payload: {
        id: invocation.jobId,
        action: invocation.action,
        space_id: invocation.spaceId,
        result: fireResult,
        invocation_id: invocation.id,
        source: invocation.source,
        ...(invocation.scheduledFor !== null ? { scheduled_for: invocation.scheduledFor } : undefined),
      },
    });
    await deps.store.completeSchedulerInvocation(invocation.id, fireResult, fireTime);
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
