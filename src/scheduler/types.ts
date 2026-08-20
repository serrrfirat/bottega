/**
 * Scheduler contracts (issue #86) — the shared surface every proactive
 * action (standup #92, reflection #93, org pulse #90) implements against.
 *
 * The scheduler core (store + cron + runner) is action-agnostic: actions
 * register in a typed registry, and an unknown action name fails closed
 * (job creation rejected; a job whose action vanished never fires and the
 * runner audits `scheduler.error`).
 *
 * Handlers never touch the scheduler_jobs table: they receive a context
 * with the read seams they need (store, audit, memory, posting) and their
 * own `params` + `spaceId` from the job.
 */
import type { Store } from "../store/db";
import type { AuditModule } from "../policy/audit";
import type { MemoryProvider } from "../memory/types";
import type { ConsolidationModelCall } from "../memory/consolidation";
import type { PolicyConfig } from "../policy/config";

/**
 * The typed action registry names (issue #86): no generic scripting, every
 * scheduled action is a statically known handler. Add a name here + a
 * handler in the registry the server builds.
 */
export type SchedulerActionName =
  | "standup_digest"
  | "reflection"
  | "org_pulse"
  | "recurring_work"
  | "ingest_poll"
  | "kb_ingest"
  | "send_message"
  | "memory_consolidation";

/**
 * A durable scheduler job (issue #86). Stored in the `scheduler_jobs`
 * table; `nextFireAt` advances on every fire, so a restart never
 * double-fires and missed windows are detectable (skip policy, audited).
 */
export interface SchedulerJob {
  /** "sj_<uuid>". */
  id: string;
  action: SchedulerActionName;
  /** 5-field cron: `minute hour dom month dow`. */
  cron: string;
  /** Action-specific config; JSON object in the row. */
  params: Record<string, string>;
  /** Target space (null for org-wide jobs like the pulse). */
  spaceId: string | null;
  createdBy: string;
  createdAt: number;
  nextFireAt: number;
  lastFiredAt: number | null;
  lastResult: "ok" | "error" | null;
  enabled: boolean;
}

/**
 * Everything a scheduled action may touch. The server wires real deps
 * (store, audit module, memory provider, Slack posting); tests inject
 * fakes. Handlers get NO write access to scheduler_jobs and no agent
 * session by default — the context is the whole capability surface.
 */
export interface SchedulerActionContext {
  store: Store;
  audit: AuditModule;
  memoryProvider: MemoryProvider;
  /** SlackAdapter.postMessage-compatible (spaceId, text) → message ts. */
  postMessage: (spaceId: string, text: string) => Promise<string | undefined>;
  /** Effective (org floor + space overlay) policy for a space. */
  loadPolicy: (spaceId: string) => Promise<PolicyConfig>;
  log: (line: string) => void;
  /** Injectable clock (ms epoch) for hermetic time-skipping tests. */
  now: () => number;
  /**
   * The consolidation model-call seam (issue #272): how a
   * `memory_consolidation` scheduled job drives the LLM leg. Present ONLY
   * in the executor job context — the server never wires it (the server
   * enqueues the job instead of running side sessions). Actions that need
   * it fail loudly when absent.
   */
  consolidationModelCall?: ConsolidationModelCall;
}

/**
 * One registered scheduled action. `run` must never throw past the runner's
 * audit. The return value is the worker dispatch's outbox result (issue
 * #272): in-process scheduler actions ignore it; the executor job body
 * serializes it into the completion outbox row + audit.
 */
export interface SchedulerAction {
  name: SchedulerActionName;
  run(params: Record<string, string>, ctx: SchedulerActionContext): Promise<void | unknown>;
}

/** Action registry: name → handler. Unknown names fail closed. */
export type SchedulerActionRegistry = Map<SchedulerActionName, SchedulerAction>;
