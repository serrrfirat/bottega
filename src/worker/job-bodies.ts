/**
 * Per-kind JOB BODIES for the worker job bus (epic #170, epic #229 P1).
 *
 * This module is the LEAF of the worker dependency chain it exists to break:
 *
 *     job-bodies.ts  <-  run-job.ts  <-  executor.ts
 *
 * that is, executor.ts imports from run-job.ts, and run-job.ts imports from
 * job-bodies.ts — never the reverse. Every function that EXECUTES a claimed
 * job kind lives here: the executor-side bodies (processItem, runKbJob,
 * runIngestPollJob), the delivery helpers they call (deliver, openPullRequest,
 * waitForDeliveryApproval), and the sandbox-side isolated bodies
 * (runIsolatedJobBody, runJobSandboxBody, runScheduledJobBody) plus the
 * self-bookkeeping they share (completeSelf/failSelf/failJobSelf, SandboxStore,
 * unstickWorkItem). The shared executor types (ExecutorDeps, ExecutorConfig,
 * JobRunOutcome, SandboxRunner, SandboxStore) are declared HERE so both
 * consumers import them without a cycle. The supervisor (runJobInSandbox) and
 * the job container's Docker/child machinery stay in run-job.ts; the
 * composition root stays in executor.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store, AuditCursor, SpaceModelSettings, WorkItem } from "../store/db";
import {
  DELIVERY_COMPLETED_EVENT,
  DELIVERY_PENDING_EVENT,
  DELIVERY_RESOLVED_EVENT,
  JOB_COMPLETED_EVENT,
  JOB_FAILED_EVENT,
  WORK_ITEM_FAILED_EVENT,
  WORK_ITEM_PIN_APPLIED_EVENT,
} from "../store/audit-events";
import { postOutboxRow, type OutboxWrite } from "../store/outbox";
import { kbJobPayloadSchema, ingestPollJobPayloadSchema, scheduledJobPayloadSchema, workItemJobPayloadSchema, type WorkerJob } from "./envelope";
import type { Poller } from "../ingest/types";
import { getWatermarkedPoller } from "../ingest/registry";
import { createAudit, redact, type AuditModule } from "../policy/audit";
import { loadKbConfig } from "../kb/config";
import { ingestSource } from "../kb/ingest";
import type { MemoryProvider } from "../memory/types";
import type { ConsolidationModelCall, ConsolidationResult } from "../memory/consolidation";
import type { SchedulerActionName, SchedulerActionRegistry } from "../scheduler/types";
import { createJobScopedStore, jobScopeFromEnvelope } from "./scoped-store";
import { resolveWorkItemSkills } from "../server/skills";
import { MODEL_ROLE_REFS, asRoleRef } from "../models/model-pin";
import type { AgentDriver, AgentSessionDriver, ModelRole } from "../server/drivers/agent-driver";
import type { Skill, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { WorkspaceLifecycle } from "./workspace-lifecycle";
import type { JobResourceCaps } from "./caps";

// Shared timing/branch constants used by the job bodies.
export const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
/** Delivery-approval wait poll interval (issue #149): the default onDelivery re-reads the audit trail this often. */
const DEFAULT_DELIVERY_POLL_INTERVAL_MS = 2000;
const BASE_BRANCH = "main";

// ---------------------------------------------------------------------------
// Shared schemas, tool allowlist, and executor dependency types.
// ---------------------------------------------------------------------------
const driverMessageSchema = z.object({ text: z.string() });
/** The session driver "error" event payload: { spaceId, message }. */
const driverErrorSchema = z.object({ message: z.string() });
/** Stored work-item skill pins must be a non-empty JSON string array. */
const itemSkillsSchema = z.array(z.string()).min(1);

/**
 * Work-item session tool allowlist: file/code tools + bash. Git runs through
 * bash — the SDK exposes no standalone git tools (`github` is the gh-CLI
 * wrapper and needs its own auth, so it stays out).
 */
export const EXECUTOR_TOOLS = ["read", "write", "glob", "grep", "bash"] as const;

/**
 * Work-item task-level skills (issues #234/#235, Tier 3): resolves the
 * client-given pins plus the deterministic kind default at claim. An item
 * with explicit skills uses them; otherwise git-delivery items always carry
 * the builtin `pr_review` (review-the-diff loop, #87), extension items get
 * none (documented v1 behavior). {@link resolveWorkItemSkills} merges the
 * space tier + builtin tier, space shadowing builtin, and skip-logs unknown
 * names so one bad pin never blocks a job. Fail-closed: a parse-failed
 * `skills` cell falls back to the kind default, never to a crash.
 */
async function resolveItemSkills(item: WorkItem): Promise<Skill[]> {
  const defaulted = (): string[] => (item.delivery === "git" ? ["pr_review"] : []);
  const itemSkills = (() => {
    if (!item.skills || item.skills.length === 0) return defaulted();
    try {
      const parsed = itemSkillsSchema.safeParse(JSON.parse(item.skills));
      return parsed.success ? parsed.data : defaulted();
    } catch {
      return defaulted();
    }
  })();
  return resolveWorkItemSkills(item.space_id, itemSkills);
}

export interface DeliveryInfo {
  prUrl: string;
  summary: string;
}

export interface DeliveryApproval {
  /** Human (or user group) that approved delivery; recorded on the review transition. */
  approver: string;
}

/**
 * The executor driver's two custom-tool lanes. Memory definitions are
 * wrapped by the driver's policy gate; extension definitions stay in the
 * driver's customTools lane because the extension runtime gates them.
 */
export interface ExtensionWorkerToolset {
  memoryTools: ToolDefinition[];
  extensionTools: ToolDefinition[];
}

export interface ExecutorDeps {
  store: SandboxStore;
  /**
   * The org memory provider (the kb job kind's write target — shared
   * chain, same provider the server and extension sessions resolve,
   * issue #172). The kb worker saves parsed chunks as org-scope memories.
   */
  memoryProvider: MemoryProvider;
  /**
   * Driver factory (lazy): constructed once per process over the extension
   * worker toolset (which resolves tools-less manifest surfaces, issue
   * #158) — so it may be async. Consumers await it.
   */
  driver: AgentDriver | Promise<AgentDriver>;
  /** Directory holding org.yml (repos + git base). Default "config". */
  orgConfigDir?: string;
  /** Claim-loop poll interval. Default 2000 ms. */
  pollIntervalMs?: number;
  /** Transcript dir passed to the driver (one JSONL per work item). Default data/transcripts. */
  transcriptDir?: string;
  /**
   * Agent dir the driver was constructed with (issue #80 boot guard). The
   * driver installs it as the process-global dir; the guard verifies the
   * registry resolves an available model from its catalog. Default
   * "data/omp-agent" (the executor's deployment agent dir).
   */
  agentDir?: string;
  /**
   * Process-scoped extension worker tools. Production supplies a lazy,
   * memoized getter so the registry/runtime/provider are built once.
   */
  /**
   * Extension worker toolset provider; memoized per process. Accepts a
   * sync or async value — the toolset is built over the registry (which
   * may resolve a tools-less manifest's surface, issue #158).
   */
  getExtensionWorkerToolset?: () => ExtensionWorkerToolset | Promise<ExtensionWorkerToolset>;
  /** Headless extension-session timeout. Default: the 30-minute stale-run window. */
  extensionSessionTimeoutMs?: number;
  /**
   * Delivery approval seam: called with the opened PR, resolves the human
   * decision. `null` → delivery denied (item blocked). Absent → the
   * default hook ({@link waitForDeliveryApproval}): polls the audit trail
   * for the server's `delivery.resolved` marker and resolves with the
   * recorded decision. Headless/executor-only runs with no server to
   * resolve fail closed — the wait times out (the stale-run window) and
   * denies, so the item lands in `blocked` instead of hanging at `working`
   * forever.
   */
  onDelivery?: (item: WorkItem, delivery: DeliveryInfo) => Promise<DeliveryApproval | null>;
  /**
   * Delivery-approval wait poll interval (issue #149): how often the
   * default onDelivery wait re-reads the audit trail for the server's
   * `delivery.resolved` marker. Default 2000 ms.
   */
  deliveryPollIntervalMs?: number;
  /** Job-claim lease (epic #170): how long a claimed job stays owned before another worker may reclaim it. Default: the stale-run window. */
  jobLeaseMs?: number;
  /** Max claim attempts before a job fails closed with audit job.failed (epic #170). Default 5. */
  maxJobAttempts?: number;
  /** Requeue backoff base; doubles per attempt up to jobBackoffMaxMs (epic #170). Default 5 s. */
  jobBackoffMs?: number;
  /** Requeue backoff ceiling. Default 5 min. */
  jobBackoffMaxMs?: number;
  /** Unclaimed TTL: a queued job never claimed within this window is failed with audit job.unclaimed + the nudge hook (epic #170). Default: the stale-run window. */
  jobUnclaimedTtlMs?: number;
  /** How often the claim loop sweeps for unclaimed jobs. Default 60 s. */
  jobSweepIntervalMs?: number;
  /**
   * Nudge hook for unclaimed jobs (epic #170). The worker holds no Slack
   * tokens (credential boundary), so the default surfaces the audit row +
   * a log line; Wave 2 wires the server-side onboarding nudge to the
   * job.unclaimed rows.
   */
  onUnclaimed?: (job: WorkerJob) => void | Promise<void>;
  /**
   * Mandatory per-job isolation boundary. Production supplies the real
   * child-process launcher; tests may inject a hermetic runner. Missing
   * wiring refuses executor startup — no job kind has an in-process
   * fallback.
   */
  sandboxRunner?: SandboxRunner;
  /** Optional boot-time isolation-boundary proof (issue #344): awaited by
   * runExecutor AFTER prepareExecutor, so the credential boundary (the PAT
   * guard) stays the first fail-closed check. Production wires the Docker
   * sandbox probe; a failed spawn must surface loudly here — the old
   * pre-guard placement hung forever inside a bare container. Absent
   * (tests, embedded hosts) → no live probe; an injected sandboxRunner
   * owns its own boundary proof.
   */
  bootProbe?: () => Promise<void>;
  /** SQLite database path mounted for the sandbox child. Production always sets this explicitly. */
  dbPath?: string;
  /**
   * Poller factories for the ingest_poll job kind (issue #101): one per
   * provider key, each returning a fresh poller. Defaults to the live
   * registry with a durable ingest watermark. Tests inject fakes.
   */
  ingestPollers?: Record<string, () => Poller>;
  /**
   * The scheduled-action registry the `scheduled` job kind dispatches
   * through (issue #272, epic #229 P2). Defaults to the executor's own
   * registry of worker-runnable actions (memory_consolidation). An action
   * absent from the registry fails its job LOUDLY naming it — never a
   * silent no-op. Tests inject custom/empty registries.
   */
  scheduledActions?: SchedulerActionRegistry;
  /**
   * The consolidation model-call seam (issue #272): how a
   * `memory_consolidation` scheduled job drives the LLM leg. Defaults to a
   * side session over the executor's driver — the model call runs in the
   * WORKER process, never the server (the server only enqueues the job).
   * Tests stub it.
   */
  consolidationModelCall?: ConsolidationModelCall;
  /**
   * The disposable-job-container seam for SQLite memory consolidation
   * (issue #101): wired by the RPC lane to route the DB leg of
   * `maintainMemory` supervisor-side (the container holds no SQLite handle)
   * with the LLM leg remoted back into the worker. Absent in the
   * in-process/child-process lanes, which use `maintainMemory(getDb())`.
   */
  runMemoryConsolidation?: () => Promise<ConsolidationResult[]>;
}

export interface ExecutorConfig {
  /** Authorization fence (issue #47): the only owner/repo pairs the executor may clone/push to. */
  repoAllowlist: string[];
  gitBaseUrl: string;
  apiBaseUrl: string;
  workspacesDir: string;
  transcriptDir: string;
  tokenFile: string;
  askpassScript: string;
  /** Job-loop knobs (epic #170). */
  jobLeaseMs: number;
  maxJobAttempts: number;
  jobBackoffMs: number;
  jobBackoffMaxMs: number;
  jobUnclaimedTtlMs: number;
  jobSweepIntervalMs: number;
}

export interface JobRunOutcome {
  state: string;
  result: unknown;
  /**
   * Issue #101: set when the sandbox wrote the job's terminal lifecycle
   * itself (completeJob + per-job outbox row + audit through the scoped
   * facade) — the parent must NOT duplicate the bookkeeping.
   */
  selfReported?: boolean;
}


// ---------------------------------------------------------------------------
// Executor-side per-kind JOB BODIES.
// ---------------------------------------------------------------------------
export async function runIngestPollJob(deps: ExecutorDeps, job: WorkerJob): Promise<JobRunOutcome> {
  const parsed = ingestPollJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new Error(`job ${job.id} (ingest_poll) payload must be { provider } — failing closed: ${parsed.error.message}`);
  }
  const provider = parsed.data.provider;
  const watermark = {
    getCursor: () => deps.store.getIngestWatermark(provider),
    setCursor: (cursor: string) => deps.store.setIngestWatermark(provider, cursor),
  };
  const factory = deps.ingestPollers?.[provider] ?? (() => getWatermarkedPoller(provider, watermark));
  const events = await factory().poll();
  return { state: "completed", result: { provider, events } };
}

/**
 * Runs a kb job (epic #170 Wave 2): the existing deterministic ingest
 * (fetch + parse + chunk + store) executed as a CLAIMED job against the
 * declared source set. Egress is scoped to the DECLARED source hosts
 * (config/kb.yml — the iron-proxy allowlist is the network-layer
 * enforcement; this validation is the job's own fail-closed gate BEFORE
 * any fetch). The worker never holds Slack tokens and never touches the
 * git PAT (credential boundary, issue #9). Fail-closed contract:
 * malformed payload → schema reject; URL host outside the declared set →
 * refused; URL naming no declared source → fail loud.
 */
export async function runKbJob(deps: ExecutorDeps, job: WorkerJob): Promise<JobRunOutcome> {
  const parsed = kbJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new Error(`job ${job.id} (kb) payload must be { url } — failing closed: ${parsed.error.message}`);
  }
  const payloadUrl = parsed.data.url;
  let requestedUrl: URL;
  try {
    requestedUrl = new URL(payloadUrl);
  } catch {
    throw new Error(`kb job payload url is not a valid URL: ${payloadUrl}`);
  }
  const config = loadKbConfig();
  const declaredHosts = new Set(config.sources.map((source) => new URL(source.url).hostname));
  if (!declaredHosts.has(requestedUrl.hostname)) {
    throw new Error(
      `kb job refused: host ${requestedUrl.hostname} is not in the declared KB source hosts (config/kb.yml)`,
    );
  }
  const source = config.sources.find((candidate) => candidate.url === payloadUrl);
  if (!source) {
    throw new Error(`kb job failed: no declared KB source matches ${payloadUrl} (config/kb.yml)`);
  }
  const result = await ingestSource(deps.memoryProvider, createAudit(deps.store), source);
  return { state: "completed", result };
}


/**
 * Full lifecycle of one claimed work item. Never throws for work failures:
 * they land the item in blocked with evidence (the job then completes with
 * that outcome). Throws only when the item cannot start (still ours but
 * stuck) so the job bus can requeue.
 */
export async function processItem(deps: ExecutorDeps, cfg: ExecutorConfig, item: WorkItem): Promise<WorkItem> {
  try {
    await deps.store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
  } catch (err) {
    const current = await deps.store.getWorkItem(item.id);
    if (current !== null && current.state !== "claimed") {
      // Someone else moved the item between claim and start (aborted/blocked).
      console.log(`[${item.id}] start skipped (item moved to ${current.state}): ${err instanceof Error ? err.message : String(err)}`);
      return current;
    }
    throw new Error(`start failed (item no longer claimable): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    if (item.delivery === "extension") {
      await extensionWorkerPath(deps, cfg, item);
      return (await deps.store.getWorkItem(item.id)) ?? item;
    }

    const workspaceLifecycle = new WorkspaceLifecycle(cfg.workspacesDir);
    const workspace = workspaceLifecycle.workspacePath(item.id);
    // Repo gate (issue #47): the repo comes from the conversation, the
    // allowlist is the authorization fence. Fail closed before any git work.
    const repo = item.repo;
    if (!repo) {
      await deps.store.transitionWorkItem(item.id, "working", "blocked", {
        evidence: "repo not specified — ask the requester",
        by: "executor",
      });
      console.log(`[${item.id}] blocked: repo not specified`);
      return (await deps.store.getWorkItem(item.id)) ?? item;
    }
    if (!cfg.repoAllowlist.includes(repo)) {
      await deps.store.transitionWorkItem(item.id, "working", "blocked", {
        evidence: `repo "${repo}" is not on the executor allowlist (org settings repos, config/org.yml by default)`,
        by: "executor",
      });
      console.log(`[${item.id}] blocked: repo ${repo} not on the allowlist`);
      return (await deps.store.getWorkItem(item.id)) ?? item;
    }
    console.log(`[${item.id}] working (${repo}, workspace ${workspace})`);
    await setupWorkspace(cfg, item, repo, workspaceLifecycle);
    const summary = await runAgentSession(deps, cfg, item, workspace);
    await deliver(deps, cfg, item, repo, workspace, summary, workspaceLifecycle);
    return (await deps.store.getWorkItem(item.id)) ?? item;
  } catch (err) {
    // Failure: git workspaces are kept for forensics; every delivery kind
    // lands the item in blocked with evidence — never silently dropped.
    const message = redact(err instanceof Error ? err.message : String(err));
    console.log(`[${item.id}] blocked: ${message}`);
    const candidateWorkspace = join(cfg.workspacesDir, item.id);
    const evidence = item.delivery === "git" && existsSync(candidateWorkspace)
      ? `executor failed; workspace retained or left untouched at "${candidateWorkspace}": ${message}`
      : `executor failed: ${message}`;
    try {
      await deps.store.transitionWorkItem(item.id, "working", "blocked", {
        evidence: evidence.slice(0, 2000),
        by: "executor",
      });
    } catch {
      await deps.store.appendAudit({
        space_id: item.space_id,
        actor: "executor",
        event_type: WORK_ITEM_FAILED_EVENT,
        payload: JSON.stringify({ id: item.id, error: message }),
      });
    }
    return (await deps.store.getWorkItem(item.id)) ?? item;
  }
}


// ---------------------------------------------------------------------------
// Delivery / extension closure used by processItem.
// ---------------------------------------------------------------------------
interface ExtensionDeliveryResult {
  url?: string;
  summary: string;
}

/**
 * Runs one non-git work item with memory + extension tools. The real space
 * id names the session so extension calls load that space's policy; the
 * per-item transcript subdirectory prevents worker sessions from sharing
 * the space agent's conversation transcript.
 */
async function extensionWorkerPath(
  deps: ExecutorDeps,
  cfg: ExecutorConfig,
  item: WorkItem,
): Promise<void> {
  const toolset = await deps.getExtensionWorkerToolset?.();
  if (!toolset) {
    throw new Error("extension worker tools are not configured");
  }
  const allowTools = [...toolset.memoryTools, ...toolset.extensionTools].map((tool) => tool.name);
  // Issue #185: the pin-merged settings apply to extension deliveries too.
  const sessionSettings = await resolveWorkItemSessionSettings(deps.store, item);
  // issues #234/#235, Tier 3: the task-level skills ride the driver seam so
  // `skill://<name>` resolves inside the extension worker session too.
  const skills = await resolveItemSkills(item);
  if (skills.length > 0) console.log(`[${item.id}] injected skills: ${skills.map((s) => s.name).join(", ")}`);
  const session = await (await deps.driver).createSession({
    spaceId: item.space_id,
    transcriptDir: join(cfg.transcriptDir, item.id),
    allowTools,
    skills,
    onOutput: (_spaceId, text) => console.log(`[${item.id}] extension agent: ${text}`),
    getModelSettings: async () => sessionSettings,
  });
  let finalOutput = "";
  let sessionError: Error | null = null;
  const offMessage = session.on("message", (data) => {
    const parsed = driverMessageSchema.safeParse(data);
    if (parsed.success) finalOutput = parsed.data.text;
  });
  const offError = session.on("error", (data) => {
    const parsed = driverErrorSchema.safeParse(data);
    sessionError = new Error(parsed.success ? parsed.data.message : "extension worker session error");
  });
  try {
    await applyWorkItemModelPin(deps, item, session);
    await promptExtensionWorker(
      session,
      [
        `You are the bottega extension worker for work item ${item.id} in space ${item.space_id}.`,
        "Complete the task using the available tools. The task may require creating or updating an",
        "external object through the connected extensions.",
        "",
        `Work item: ${item.description}`,
        "",
        "Reply with EXACTLY a JSON envelope on the last line, with no markdown fences:",
        '{"url": "<external object URL or empty string>", "summary": "<deliverable summary>"}',
      ].join("\n"),
      deps.extensionSessionTimeoutMs ?? DEFAULT_STALE_AFTER_MS,
    );
    if (sessionError) throw sessionError;
  } finally {
    offMessage();
    offError();
    await session.dispose();
  }

  const delivery = parseExtensionDeliveryEnvelope(finalOutput);
  const result = JSON.stringify({
    ...(delivery.url ? { url: delivery.url } : undefined),
    summary: delivery.summary,
  });
  await deps.store.transitionWorkItem(item.id, "working", "done", { result, by: "executor" });
  await deps.store.appendAudit({
    space_id: item.space_id,
    actor: "executor",
    event_type: DELIVERY_COMPLETED_EVENT,
    payload: JSON.stringify({
      id: item.id,
      kind: "extension",
      ...(delivery.url ? { url: delivery.url } : undefined),
      summary: delivery.summary,
    }),
  });
  console.log(`[${item.id}] extension delivery completed${delivery.url ? `: ${delivery.url}` : ""}`);
}

async function promptExtensionWorker(
  session: AgentSessionDriver,
  prompt: string,
  timeoutMs: number,
): Promise<void> {
  const timeoutError = new Error(`extension worker session timed out after ${timeoutMs} ms`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  try {
    await Promise.race([
      session.prompt(prompt, { streamingBehavior: "followUp" }),
      timeout,
    ]);
  } catch (err) {
    if (err === timeoutError) {
      try {
        await session.abort();
      } catch (abortErr) {
        throw new Error(`${timeoutError.message}; abort failed: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`);
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the last JSON-object line from model output. Prose or markdown
 * before/after the envelope is tolerated, but summary must be non-empty.
 * A missing or blank URL is normalized away; the store's delivery-specific
 * done obligation then rejects it for extension items.
 */
function parseExtensionDeliveryEnvelope(output: string): ExtensionDeliveryResult {
  let validationError = "missing JSON object";
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    const start = line.indexOf("{");
    const end = line.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(start, end + 1));
    } catch {
      validationError = "invalid JSON";
      continue;
    }
    /** The extension delivery envelope: a non-blank summary, optional url. */
    const envelopeSchema = z.object({
      summary: z.string().trim().min(1),
      url: z.string().trim().optional(),
    });
    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      validationError = "envelope must be an object with a non-empty summary and an optional string url";
      continue;
    }
    return {
      ...(envelope.data.url ? { url: envelope.data.url } : undefined),
      summary: envelope.data.summary,
    };
  }
  throw new Error(`extension worker output missing a valid JSON envelope (${validationError})`);
}

async function setupWorkspace(
  cfg: ExecutorConfig,
  item: WorkItem,
  repo: string,
  lifecycle: WorkspaceLifecycle,
): Promise<void> {
  const workspace = await lifecycle.create(item.id, repo, async (destination) => {
    // The askpass contract covers every authenticated git operation: cloning
    // a private org repo needs the PAT just like the push does.
    await git(["clone", `${cfg.gitBaseUrl}/${repo}.git`, destination], {
      env: { GIT_ASKPASS: cfg.askpassScript, EXECUTOR_GIT_TOKEN_FILE: cfg.tokenFile },
    });
  });
  await git(["checkout", "-b", `bottega/${item.id}`], { cwd: workspace });
  // Commit identity for the agent session's commits.
  await git(["config", "user.name", "bottega executor"], { cwd: workspace });
  await git(["config", "user.email", "executor@bottega.invalid"], { cwd: workspace });
}

/**
 * The execution session's model/effort for a work item (issue #185):
 * task pin > space settings > defaults. The pin's explicit model id and
 * effort override the space's settings; a role ref keeps the space slot
 * indirection (its concrete model resolves at execution via the settings
 * below). Unpinned items get the space settings unchanged — the session
 * runs on its agent-dir default unless a pin applies.
 */
async function resolveWorkItemSessionSettings(store: Store, item: WorkItem): Promise<SpaceModelSettings> {
  // Issue #207: the EFFECTIVE settings (space overrides, org-wide
  // models.default fallback) so the executor's sessions resolve the same
  // default the space sessions do — never the stale agent-dir pin.
  const settings = await store.getEffectiveSpaceSettings(item.space_id);
  if (item.model === null && item.reasoning_effort === null) return settings;
  return {
    ...settings,
    ...(item.reasoning_effort !== null ? { reasoning_effort: item.reasoning_effort } : undefined),
    ...(item.model !== null && !MODEL_ROLE_REFS.some((role) => role === item.model) ? { model: item.model } : undefined),
  };
}

/**
 * The role switch that applies the item's pin (issue #185): a role ref
 * switches its own slot; an explicit model id rides the "default" role
 * against the pin-merged settings (resolveRoleTarget's default slot is
 * `model`, which the pin overrides). null = no pin → no switch; the
 * session keeps its default.
 */
function pinSwitchRole(item: WorkItem): ModelRole | null {
  const role = item.model === null ? undefined : asRoleRef(item.model);
  if (role) return role;
  if (item.model !== null || item.reasoning_effort !== null) return "default";
  return null;
}

/**
 * Applies the item's model/effort pin to the execution session BEFORE its
 * first prompt and audits what was applied (issue #185): the resolved
 * model id, thinking level, and whether the switch applied. The session
 * must have been created with getModelSettings resolving the pin-merged
 * settings (resolveWorkItemSessionSettings). A driver without the
 * setModelRole hook reports applied: false — never a silent claim.
 */
async function applyWorkItemModelPin(
  deps: ExecutorDeps,
  item: WorkItem,
  session: AgentSessionDriver,
): Promise<void> {
  const role = pinSwitchRole(item);
  if (role === null) return;
  const result = await session.setModelRole?.(role);
  await deps.store.appendAudit({
    space_id: item.space_id,
    actor: "executor",
    event_type: WORK_ITEM_PIN_APPLIED_EVENT,
    payload: JSON.stringify({
      id: item.id,
      role,
      model: result?.model ?? null,
      thinking_level: result?.thinking_level ?? null,
      applied: result?.applied ?? false,
      by: "executor",
    }),
  });
}

async function runAgentSession(
  deps: ExecutorDeps,
  cfg: ExecutorConfig,
  item: WorkItem,
  workspace: string,
): Promise<string> {
  // Issue #185: the session resolves roles against the pin-merged settings
  // (task pin > space settings > defaults) so the pin applies cleanly.
  const sessionSettings = await resolveWorkItemSessionSettings(deps.store, item);
  // issues #234/#235, Tier 3: the task-level skills (explicit pins + the
  // git pr_review default) ride the driver seam into the item session, so
  // `skill://pr_review` resolves while the agent reviews its own diff.
  const skills = await resolveItemSkills(item);
  if (skills.length > 0) console.log(`[${item.id}] injected skills: ${skills.map((s) => s.name).join(", ")}`);
  const session = await (await deps.driver).createSession({
    spaceId: item.id,
    transcriptDir: cfg.transcriptDir,
    cwd: workspace,
    allowTools: EXECUTOR_TOOLS,
    skills,
    onOutput: (_spaceId, text) => console.log(`[${item.id}] agent: ${text}`),
    getModelSettings: async () => sessionSettings,
  });
  let summary = "";
  let sessionError: Error | null = null;
  const offMessage = session.on("message", (data) => {
    const parsed = driverMessageSchema.safeParse(data);
    if (parsed.success) summary = parsed.data.text;
  });
  const offError = session.on("error", (data) => {
    const parsed = driverErrorSchema.safeParse(data);
    sessionError = new Error(parsed.success ? parsed.data.message : "agent session error");
  });
  try {
    await applyWorkItemModelPin(deps, item, session);
    await session.prompt(
      [
        `You are an autonomous work executor for bottega (work item ${item.id}, space ${item.space_id}).`,
        "The repository is checked out at the workspace root (your working directory). Implement the work item",
        "below, then commit your changes to the current branch with a descriptive commit message.",
        "Do NOT push, open pull requests, or touch anything outside the workspace.",
        "",
        `Work item: ${item.description}`,
      ].join("\n"),
      { streamingBehavior: "followUp" },
    );
    if (sessionError) throw sessionError;
  } finally {
    offMessage();
    offError();
    await session.dispose();
  }
  return summary.trim();
}

export interface DeliveryWaitOpts {
  /**
   * How long the wait holds before denying (headless fallback). Default:
   * the stale-run window ({@link DEFAULT_STALE_AFTER_MS}) — the same bound
   * stale recovery uses, so a run with no server to resolve the request
   * fails closed in-process instead of hanging at `working`.
   */
  timeoutMs?: number;
  /** Poll interval for the server's `delivery.resolved` marker. Default 2000 ms. */
  pollIntervalMs?: number;
  /** Observability seam; defaults to console.log. */
  log?: (line: string) => void;
}

/** Shape of a `delivery.resolved` audit payload (issue #149). */
interface DeliveryResolutionPayload {
  id?: string;
  approved?: boolean;
  approver?: string;
}

/** The delivery.resolved audit payload: {id, approved, approver}. */
const deliveryResolutionSchema = z.object({
  id: z.string().optional(),
  approved: z.boolean().optional(),
  approver: z.string().optional(),
});

function parseDeliveryResolution(raw: string): DeliveryResolutionPayload | null {
  try {
    return deliveryResolutionSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * The executor container's default onDelivery (issue #149): the server
 * cannot reach into this process, so the audit trail is the channel. The
 * server's delivery router records the human's decision as
 * `delivery.resolved` ({id, approved, approver}); this wait polls for that
 * row and resolves with the recorded decision — approved → {approver},
 * denied → null (the executor then blocks the item with evidence). The
 * FIRST recorded decision wins (the indexed cursor walk preserves chronological precedence).
 *
 * Headless/executor-only runs (no server to resolve) fail closed on the
 * timeout: null → the item lands in `blocked`, never a silent hang at
 * `working`.
 */
export async function waitForDeliveryApproval(
  store: Pick<Store, "queryAudit">,
  item: WorkItem,
  delivery: DeliveryInfo,
  opts: DeliveryWaitOpts = {},
): Promise<DeliveryApproval | null> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_DELIVERY_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STALE_AFTER_MS;
  const deadline = Date.now() + timeoutMs;
  log(`[${item.id}] delivery approval pending for ${delivery.prUrl} — waiting for the space's decision`);
  for (;;) {
    let cursor: AuditCursor | null = null;
    let resolution: DeliveryResolutionPayload | null = null;
    do {
      const page = await store.queryAudit({
        event_type: DELIVERY_RESOLVED_EVENT,
        since: item.created_at,
        cursor: cursor ?? undefined,
        limit: 100,
      });
      for (const row of page.rows) {
        const candidate = parseDeliveryResolution(row.payload);
        if (candidate !== null && candidate.id === item.id) resolution = candidate;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    if (resolution !== null) {
      if (resolution.approved === true && resolution.approver !== undefined) {
        log(`[${item.id}] delivery approved by <@${resolution.approver}>`);
        return { approver: resolution.approver };
      }
      log(`[${item.id}] delivery denied — blocking`);
      return null;
    }
    if (Date.now() >= deadline) {
      log(
        `[${item.id}] delivery approval unresolved after ${timeoutMs}ms (no server resolution) — ` +
          "denying (headless fallback)",
      );
      return null;
    }
    await Bun.sleep(pollIntervalMs);
  }
}

/** Push the branch (PAT via the askpass file), open the PR, request delivery approval. */
async function deliver(
  deps: ExecutorDeps,
  cfg: ExecutorConfig,
  item: WorkItem,
  repository: string,
  workspace: string,
  summary: string,
  lifecycle: WorkspaceLifecycle,
): Promise<void> {
  const branch = `bottega/${item.id}`;
  const token = readFileSync(cfg.tokenFile, "utf8").trim();
  await git(["push", "-u", "origin", branch], {
    cwd: workspace,
    env: { GIT_ASKPASS: cfg.askpassScript, EXECUTOR_GIT_TOKEN_FILE: cfg.tokenFile },
  });
  const prUrl = await openPullRequest(cfg, item, branch, token, summary);
  console.log(`[${item.id}] PR opened: ${prUrl}`);

  // Pending-approval marker (audit) — the space reads this to render the request.
  await deps.store.appendAudit({
    space_id: item.space_id,
    actor: "executor",
    event_type: DELIVERY_PENDING_EVENT,
    payload: JSON.stringify({ id: item.id, pr_url: prUrl, summary }),
  });
  const requestApproval =
    deps.onDelivery ??
    ((_item, delivery) =>
      waitForDeliveryApproval(deps.store, _item, delivery, {
        pollIntervalMs: deps.deliveryPollIntervalMs,
        log: (line) => console.log(line),
      }));
  const approval = await requestApproval(item, { prUrl, summary });
  if (!approval) {
    await deps.store.transitionWorkItem(item.id, "working", "blocked", {
      evidence: `delivery approval denied for ${prUrl}`,
      by: "executor",
    });
    return;
  }
  // Cleanup is part of successful delivery. Authority failure happens while
  // the item is still working, so the caller can block it and retain the
  // uncertain path instead of ever reporting success.
  lifecycle.removeOwned(item.id, repository);
  const result = JSON.stringify({ pr_url: prUrl, summary });
  // The legal map (issue #10): review requires a recorded approval; done
  // requires result.pr_url. Both transitions carry their obligations.
  await deps.store.transitionWorkItem(item.id, "working", "review", {
    approval: { approver: approval.approver },
    evidence: `PR opened: ${prUrl}`,
    result,
    by: "executor",
  });
  await deps.store.transitionWorkItem(item.id, "review", "done", { result, by: "executor" });
  console.log(`[${item.id}] delivered: ${prUrl}`);
}

async function openPullRequest(
  cfg: ExecutorConfig,
  item: WorkItem,
  branch: string,
  token: string,
  summary: string,
): Promise<string> {
  const res = await fetch(`${cfg.apiBaseUrl}/repos/${item.repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: `${item.description.slice(0, 100)} (bottega ${item.id})`,
      head: branch,
      base: BASE_BRANCH,
      body: summary || `Work item ${item.id}: ${item.description}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`PR creation failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  }
  /** The GitHub create-pull response: the new PR's html_url. */
  const createdPrSchema = z.object({ html_url: z.string().optional() });
  const parsed = createdPrSchema.parse(await res.json());
  if (parsed.html_url === undefined || parsed.html_url.length === 0) {
    throw new Error("PR creation returned no html_url");
  }
  return parsed.html_url;
}


async function git(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${code}): ${(err.trim() || "no output").slice(0, 2000)}`);
  }
}


// ---------------------------------------------------------------------------
// Sandbox-side per-kind JOB BODIES + the shared sandbox-runner contract.
// ---------------------------------------------------------------------------
export interface SandboxResult {
  /** The child/body exit code. null when the runner died by signal or invalid IPC. */
  exitCode: number | null;
  /** The terminating signal, if any. */
  signal: string | null;
  /** True when the run was torn down by the supervisor's deadline. */
  timedOut: boolean;
  /** True when lease renewal proved that the parent no longer owns the job. */
  leaseLost?: boolean;
  /** Bounded protocol validation failure. Never contains child output beyond the cap. */
  protocolError?: string;
}

/** Per-run context handed to the runner. */
export interface SandboxRunnerContext {
  deps: ExecutorDeps;
  cfg: ExecutorConfig;
  /** The kind's resolved resource caps (org overrides on the defaults). */
  caps: JobResourceCaps;
  /** Aborted by the boss loop when lease renewal fails. The runner must kill the full process tree. */
  signal: AbortSignal;
}

/** The injectable runner seam (tests supply fakes; production supplies the Docker container). */
export type SandboxRunner = (job: WorkerJob, ctx: SandboxRunnerContext) => Promise<SandboxResult>;

/** Exit contract (see module doc). */
export const SANDBOX_EXIT_COMPLETED = 0;
export const SANDBOX_EXIT_FAILED = 2;
export const SANDBOX_EXIT_REQUEUE = 3;


export function parseScheduledJobPayload(job: WorkerJob): z.infer<typeof scheduledJobPayloadSchema> {
  const parsed = scheduledJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // Malformed envelope → loud crash (parent fails the job).
    throw new Error(
      `job ${job.id} (scheduled) payload must be { action, ... } — failing closed: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}


export async function runIsolatedJobBody(
  deps: ExecutorDeps,
  cfg: ExecutorConfig,
  caps: JobResourceCaps,
  job: WorkerJob,
): Promise<SandboxResult> {
  switch (job.kind) {
    case "git":
    case "extension":
      return runJobSandboxBody(deps, cfg, caps, job);
    case "scheduled":
      return runScheduledJobBody(deps, cfg, caps, job);
    case "kb":
    case "ingest_poll": {
      const store = createJobScopedStore(deps.store, jobScopeFromEnvelope(job));
      const audit = createAudit(store);
      try {
        const outcome =
          job.kind === "kb" ? await runKbJob({ ...deps, store }, job) : await runIngestPollJob({ ...deps, store }, job);
        await completeSelf(store, audit, job, outcome);
        return { exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await failJobSelf(store, audit, job, message);
        return { exitCode: SANDBOX_EXIT_FAILED, signal: null, timedOut: false };
      }
    }
  }
}

/**
 * One job's isolated run body: the code that runs inside the sandbox (the
 * job Docker container in production, an injected runner in tests). Re-derives the scope
 * from the envelope id (fail closed: the facade permits ONLY this job's
 * rows), claims the work item, runs the item's full delivery lifecycle, and
 * writes ITS OWN terminal lifecycle (completeJob + own outbox row + audit)
 * through the scoped facade. Never touches the claim loop's global sweep;
 * never touches another job's rows.
 */
export async function runJobSandboxBody(
  deps: ExecutorDeps,
  cfg: ExecutorConfig,
  _caps: JobResourceCaps,
  job: WorkerJob,
): Promise<SandboxResult> {
  const scope = jobScopeFromEnvelope(job);
  const store = createJobScopedStore(deps.store, scope);
  const audit = createAudit(store);

  const parsed = workItemJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // Malformed envelope → loud crash (parent fails the job).
    throw new Error(`job ${job.id} (${job.kind}) payload must be { workItemId } — failing closed`);
  }
  const workItemId = parsed.data.workItemId;

  try {
    const item = await store.claimWorkItemById(workItemId);
    if (item === null) {
      const current = await store.getWorkItem(workItemId);
      if (current === null) {
        throw new Error(`work item ${workItemId} not found`);
      }
      if (current.state === "done" || current.state === "blocked" || current.state === "aborted") {
        // Already settled elsewhere — the sandbox completes as a no-op and
        // writes its own outbox row so the server sees the settlement.
        await completeSelf(store, audit, job, { state: current.state, result: null });
        return { exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false };
      }
      // claimed/working under a live owner (lease-reclaim race): requeue,
      // never double-execute.
      return { exitCode: SANDBOX_EXIT_REQUEUE, signal: null, timedOut: false };
    }

    const settled = await processItem(deps, cfg, item);
    await completeSelf(store, audit, job, {
      state: settled.state,
      result: safeParseJson(settled.result),
    });
    return { exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false };
  } catch (err) {
    // Loud self-fail: the sandbox owns its failure — job.failed audit +
    // the item lands blocked (never stuck at working).
    const message = err instanceof Error ? err.message : String(err);
    await failSelf(store, audit, job, workItemId, message);
    return { exitCode: SANDBOX_EXIT_FAILED, signal: null, timedOut: false };
  }
}

/**
 * One scheduled job's isolated run body (issue #272, epic #229 P2): the
 * dispatcher-dispatch leg. Re-derives the scope from the envelope id (fail
 * closed: the facade permits ONLY this job's rows), resolves the named
 * action in the executor's scheduled-action registry (an unknown action
 * fails LOUDLY naming it — never a silent no-op), runs it against the
 * job-scoped store facade with the model-call seam from the job context,
 * and writes ITS OWN terminal lifecycle (completeJob + own outbox row +
 * audit) through the scoped facade. The action's return value rides the
 * completion outbox row + audit as the result. Worker actions never post to
 * Slack — the outbox seam is the post path — and have no policy context.
 */
export async function runScheduledJobBody(
  deps: ExecutorDeps,
  _cfg: ExecutorConfig,
  _caps: JobResourceCaps,
  job: WorkerJob,
): Promise<SandboxResult> {
  const scope = jobScopeFromEnvelope(job);
  const store = createJobScopedStore(deps.store, scope);
  const audit = createAudit(store);

  const parsed = parseScheduledJobPayload(job);
  const { action: actionName, params } = parsed;
  // SAFETY: scheduledJobPayloadSchema types action as an arbitrary string; the
  // registry is keyed by the statically known SchedulerActionName union, so a
  // name outside it misses the map and the unknown-action throw below fails closed.
  const action = deps.scheduledActions?.get(actionName as SchedulerActionName);
  if (!action) {
    throw new Error(`scheduled job ${job.id} failed: unknown action "${actionName}" — no silent no-op`);
  }

  try {
    const result = await action.run(params, {
      store,
      audit,
      memoryProvider: deps.memoryProvider,
      postMessage: () => {
        throw new Error(
          `scheduled action ${actionName} attempted to post to Slack — the worker holds no tokens; the outbox seam is the post path`,
        );
      },
      loadPolicy: async () => {
        throw new Error(`scheduled action ${actionName} has no policy context in the worker`);
      },
      log: (line) => console.log(`[${job.id}] ${line}`),
      now: Date.now,
      consolidationModelCall: deps.consolidationModelCall,
      ...(deps.runMemoryConsolidation !== undefined ? { runMemoryConsolidation: deps.runMemoryConsolidation } : undefined),
    });
    await completeSelf(store, audit, job, { state: "completed", result: result ?? null });
    return { exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false };
  } catch (err) {
    // Loud self-fail: the action body owns its failure — job.failed audit,
    // no outbox row (the job bus surfaces the failure).
    const message = err instanceof Error ? err.message : String(err);
    await store.failJob(job.id);
    await audit.appendAudit({
      ts: Date.now(),
      space_id: job.spaceId ?? null,
      actor: "executor",
      event_type: JOB_FAILED_EVENT,
      payload: JSON.stringify({ id: job.id, kind: job.kind, error: message.slice(0, 2000) }),
    });
    console.log(`[${job.id}] scheduled job failed (${actionName}): ${message}`);
    return { exitCode: SANDBOX_EXIT_FAILED, signal: null, timedOut: false };
  }
}


export async function unstickWorkItem(store: Store, workItemId: string, reason: string): Promise<void> {
  const evidence = `sandbox crash: ${reason}`;
  const current = await store.getWorkItem(workItemId);
  if (current === null) return;
  if (current.state === "blocked" || current.state === "aborted" || current.state === "done") return;
  try {
    if (current.state === "claimed") {
      await store.transitionWorkItem(workItemId, "claimed", "working", { by: "executor" });
    }
    await store.transitionWorkItem(workItemId, "working", "blocked", { evidence, by: "executor" });
  } catch (err) {
    console.log(
      `[${workItemId}] could not unstick work item (${err instanceof Error ? err.message : String(err)}) — job already failed loudly`,
    );
  }
}

/**
 * A store that may expose a job-scoped `postOutboxRow` (the container's RPC
 * store, whose outbox write is routed supervisor-side so no SQL handle is
 * needed in the container). The real / child-process / in-process stores
 * lack it and write through the module {@link postOutboxRow} directly.
 */
export type SandboxStore = Store & { postOutboxRow?(input: OutboxWrite): Promise<void> };

/** Writes one job-completion outbox row, routing through RPC when available. */
async function writeOutboxRow(store: SandboxStore, input: OutboxWrite): Promise<void> {
  if (store.postOutboxRow !== undefined) {
    await store.postOutboxRow(input);
  } else {
    postOutboxRow(store, input);
  }
}

/** The sandbox's own success bookkeeping: completeJob + one outbox row + audit. */
async function completeSelf(
  store: SandboxStore,
  audit: AuditModule,
  job: WorkerJob,
  outcome: { state: string; result: unknown },
): Promise<void> {
  await store.completeJob(job.id);
  await writeOutboxRow(store, {
    id: job.id,
    kind: job.kind,
    payload: { state: outcome.state, result: outcome.result ?? null },
    space: job.spaceId ?? null,
  });
  await audit.appendAudit({
    ts: Date.now(),
    space_id: job.spaceId ?? null,
    actor: "executor",
    event_type: JOB_COMPLETED_EVENT,
    payload: JSON.stringify({ id: job.id, kind: job.kind, state: outcome.state, result: outcome.result ?? null }),
  });
}

/** The sandbox's own failure bookkeeping: failJob + job.failed audit + item blocked. */
async function failSelf(
  store: SandboxStore,
  audit: AuditModule,
  job: WorkerJob,
  workItemId: string,
  message: string,
): Promise<void> {
  await failJobSelf(store, audit, job, message);
  await unstickWorkItem(store, workItemId, message);
}

/** Failure bookkeeping for isolated kinds that do not own a work-item row. */
async function failJobSelf(store: SandboxStore, audit: AuditModule, job: WorkerJob, message: string): Promise<void> {
  await store.failJob(job.id);
  await audit.appendAudit({
    ts: Date.now(),
    space_id: job.spaceId ?? null,
    actor: "executor",
    event_type: JOB_FAILED_EVENT,
    payload: JSON.stringify({ id: job.id, kind: job.kind, error: message.slice(0, 2000) }),
  });
  console.log(`[${job.id}] sandbox failed the job (${job.kind}): ${message}`);
}

/** One decoded JSON document — the domain of a work item's stored result column. */
type JsonDocument = string | number | boolean | null | JsonDocument[] | { [key: string]: JsonDocument };

/** Parses a work item's result JSON column; null when absent or corrupt. */
function safeParseJson(text: string | null): JsonDocument {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

