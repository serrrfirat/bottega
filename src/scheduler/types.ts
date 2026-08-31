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
import type { ConsolidationModelCall, ConsolidationResult } from "../memory/consolidation";
import type { PolicyConfig } from "../policy/config";
import type { SlackBlockPayload } from "../server/adapters/slack";

/**
 * Single source of truth for the scheduler action names (issue #86, #341).
 * The only runtime list of durable job actions; worker-only actions are
 * declared separately and widen the union below without becoming createable
 * scheduler rows. Add a durable action here + a handler in the registry the
 * server builds.
 */
export const DURABLE_ACTION_NAMES = [
  "standup_digest",
  "reflection",
  "org_pulse",
  "recurring_work",
  "ingest_poll",
  "kb_ingest",
  "send_message",
  "governance_digest",
  "weekly_memory_review",
] as const;

/**
 * Worker-only action (issue #272): enqueued by the server as a `scheduled`
 * worker job, never created as a durable scheduler row. It appears in the
 * action-name union so worker registries can register it, but is excluded
 * from durable job creation (create/update schemas and KNOWN_ACTIONS).
 */
export const WORKER_ONLY_ACTION = "memory_consolidation" as const;

/**
 * The typed action registry names (issue #86): no generic scripting, every
 * scheduled action is a statically known handler — the durable set plus any
 * worker-only action.
 */
export type SchedulerActionName = (typeof DURABLE_ACTION_NAMES)[number] | typeof WORKER_ONLY_ACTION;

/** Just the durable (createable) action names — the worker-only action excluded. */
export type DurableSchedulerActionName = (typeof DURABLE_ACTION_NAMES)[number];

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
  /** Compare-and-swap revision for operator mutations. Fires do not change it. */
  revision: number;
}

/** One durable execution claimed by the scheduler runner. */
export interface SchedulerInvocation {
  /** Caller-supplied idempotency identity for manual runs; deterministic occurrence id for cron runs. */
  id: string;
  jobId: string;
  action: SchedulerActionName;
  params: Record<string, string>;
  spaceId: string | null;
  source: "scheduled" | "manual";
  scheduledFor: number | null;
  requestedAt: number;
  jobRevision: number;
  status: "pending" | "running" | "completed";
  claimedAt: number | null;
  completedAt: number | null;
  result: "ok" | "error" | null;
  /** Failure detail delivered to completion observers; not persisted in the invocation row. */
  error?: string;
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
  /** SlackAdapter.postMessage-compatible (spaceId, text[, opts.blocks]) → message ts. */
  postMessage: (spaceId: string, text: string, opts?: { blocks?: SlackBlockPayload[] }) => Promise<string | undefined>;
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
  /**
   * The disposable-job-container seam for SQLite memory consolidation
   * (issue #101): when the action runs inside a stateless job container (no
   * SQLite handle), the container wires this to the supervisor's RPC-routed
   * `maintainMemory` (LLM leg remoted back into the worker). Absent (real
   * store / in-process / child-process lanes), the action falls back to
   * `maintainMemory(ctx.store.getDb(), modelCall)`.
   */
  runMemoryConsolidation?: () => Promise<ConsolidationResult[]>;
}

/** JSON-serializable result emitted by the worker-only consolidation action. */
export type SchedulerActionResult = void | ConsolidationResult[];

/**
 * One registered scheduled action. `run` must never throw past the runner's
 * audit. The return value is the worker dispatch's outbox result (issue
 * #272): in-process scheduler actions ignore it; the executor job body
 * serializes it into the completion outbox row + audit.
 */
export interface SchedulerAction {
  name: SchedulerActionName;
  run(params: Record<string, string>, ctx: SchedulerActionContext): Promise<SchedulerActionResult>;
}

/** Action registry: name → handler. Unknown names fail closed. */
export type SchedulerActionRegistry = Map<SchedulerActionName, SchedulerAction>;
