/**
 * Executor: containerized worker for bottega's job bus (issues #11, #129,
 * epic #170).
 *
 * One claim loop over the typed job envelope (kind: git | extension | kb |
 * scheduled) — no orchestration framework. Boots with stale-run recovery
 * (#10) and the fail-loud unclaimed sweep (#170), then routes:
 *
 *   git       → work item → workspace → agent → push → PR → review → done | blocked
 *   extension → work item → memory/extension agent → external object → done | blocked
 *   kb        → fail-closed stub until Wave 2 (never a silent no-op)
 *   scheduled → fail-closed stub until Wave 2 dispatchers land
 *
 * chat items are NOT worker jobs: the space agent handles them in-session
 * (epic #170 — conversation stays server-side).
 *
 * Job lifecycle (one envelope id across enqueue → claim → run → outbox →
 * post): the store's atomic claim UPDATE (lease expiry) hands the worker a
 * job; completion writes an outbox row (the worker→server signal) + audit
 * job.completed; failure requeues with bounded exponential backoff and
 * fails closed after max attempts (audit job.failed); a job no worker
 * claimed within its TTL surfaces as audit job.unclaimed + nudge.
 *
 * Credential boundary: the git PAT lives in a FILE (default
 * data/secrets/github-pat, mode 0600, env-overridable via
 * EXECUTOR_GIT_TOKEN_FILE). It never enters the environment or the image:
 * git reads it through a generated GIT_ASKPASS helper, and the GitHub API
 * request reads the same file. A mode other than 0600 fails boot closed
 * (org setting allow_loose_pat opts out, local dev only). The PAT value
 * also never reaches tests via env (asserted in executor.test.ts). The
 * worker holds no Slack tokens — server posts happen through the outbox.
 *
 * Runtime knobs (issue #67): repo allowlist, git/api base URLs, workspaces
 * dir, and allow_loose_pat live in the org settings blob (DB — source of
 * truth); config/org.yml stays the default/fallback.
 *
 * Git delivery approval contract: after the PR is opened the executor writes a
 * `work_item.delivery_pending` audit marker, then calls the `onDelivery`
 * seam. The server posts the PR + an interactive approve/deny prompt (the
 * delivery poller), records the human's decision as `delivery.resolved`
 * (the delivery router), and the executor's default onDelivery wait reads
 * that row as the approval (issue #149); the executor then records
 * `working → review` with that approval and completes `review → done` (the
 * legal map requires a recorded approval on review, and result.pr_url on
 * done). The default wait is the real hook — the audit trail is the
 * cross-process channel to the server. Headless/executor-only runs with no
 * server to resolve the request fail closed: the wait times out (the
 * stale-run window) and denies, landing the item in `blocked` instead of
 * hanging at `working` forever.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  recoverStaleWorkItems,
  type AuditCursor,
  type Store,
  type SpaceModelSettings,
  type WorkItem,
} from "./store/db";
import {
  DELIVERY_COMPLETED_EVENT,
  DELIVERY_PENDING_EVENT,
  DELIVERY_RESOLVED_EVENT,
  JOB_CLAIMED_EVENT,
  JOB_COMPLETED_EVENT,
  JOB_FAILED_EVENT,
  JOB_UNCLAIMED_EVENT,
  WORK_ITEM_FAILED_EVENT,
  WORK_ITEM_PIN_APPLIED_EVENT,
} from "./store/audit-events";
import { postOutboxRow } from "./store/outbox";
import { kbJobPayloadSchema, ingestPollJobPayloadSchema, scheduledJobPayloadSchema, type WorkerJob } from "./worker/envelope";
import {
  createDockerSandboxRunner,
  probeDockerSandbox,
  runJobInSandbox,
  type SandboxRunner,
  type SandboxStore,
} from "./worker/run-job";
import type { Poller } from "./ingest/types";
import { getWatermarkedPoller } from "./ingest/registry";
import { createAudit, redact } from "./policy/audit";
import { loadKbConfig } from "./kb/config";
import { ingestSource } from "./kb/ingest";
import type { MemoryProvider } from "./memory/types";
import type { ConsolidationModelCall, ConsolidationResult } from "./memory/consolidation";
import { buildRegistry } from "./scheduler/actions";
import { memoryConsolidationAction } from "./scheduler/memory-consolidation";
import type { SchedulerActionRegistry } from "./scheduler/types";
import { DenyRouter } from "./policy/approval-router";
import {
  assertAgentDirModelAvailable,
  createOmpSdkDriver,
  ensureAgentDirModelPin,
  OMP_CONFIG_TEMPLATE,
  type AgentDriver,
  type AgentSessionDriver,
  type ModelRole,
} from "./server/drivers/agent-driver";
import { bootstrapRuntime, type BootstrapRuntime } from "./server/bootstrap-runtime";
import { seedBootSecretsFromVault } from "./server/boot-secrets";
import { syncProxyCredentialsFromEnv } from "./extensions/proxy-seed";
import type { SecretFileBoundaryOpts } from "./extensions/boundary";
import { extensionToolDefinitions } from "./extensions/tools";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpBinding } from "./extensions/manifest";
import { memoryToolDefinitions } from "./tools/memory";
import type { Skill, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { parseYamlSubset, type YamlNode } from "./yaml-subset";
import { resolveWorkItemSkills } from "./server/skills";
import type { ResolvedMemoryProvider } from "./server/memory-provider";
import type { OrgSettings } from "./store/org-settings";
import { defaultWorkspaceRoot, WorkspaceLifecycle } from "./worker/workspace-lifecycle";

/** The session driver "message" event payload: { spaceId, text }. */
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

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
/** Delivery-approval wait poll interval (issue #149): the default onDelivery re-reads the audit trail this often. */
const DEFAULT_DELIVERY_POLL_INTERVAL_MS = 2000;
/** Job-loop defaults (epic #170): lease = stale-run window, bounded requeue with exponential backoff, fail-loud unclaimed sweep. */
const DEFAULT_MAX_JOB_ATTEMPTS = 5;
const DEFAULT_JOB_BACKOFF_MS = 5_000;
const DEFAULT_JOB_BACKOFF_MAX_MS = 5 * 60_000;
const DEFAULT_JOB_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_TRANSCRIPT_DIR = "data/transcripts";
const DEFAULT_ORG_CONFIG_DIR = "config";
const BASE_BRANCH = "main";
const ASKPASS_SCRIPT_NAME = "git-askpass.sh";

/**
 * The extension worker's toolset over the shared runtime chain (issue
 * #172): memory definitions ride the driver's policy gate; extension
 * definitions stay in the driver's customTools lane because the extension
 * runtime runs its own policy gate and must never be double-wrapped.
 */
function buildExecutorWorkerToolset(rt: BootstrapRuntime): ExtensionWorkerToolset {
  return {
    memoryTools: memoryToolDefinitions(rt.memoryProvider, { audit: rt.audit }),
    extensionTools: extensionToolDefinitions(rt.registry.list(), {
      runtime: rt.runtime,
      getCaller: () => "executor",
      surfaces: rt.surfaces,
    }),
  };
}

/** The executor composition root's boot result (issue #172). */
export interface ExecutorBoot {
  /** The shared composition chain — the same pieces every root boots. */
  runtime: BootstrapRuntime;
  /** Memoized extension-worker toolset (memory + extension tools over the boot runtime). */
  getExtensionWorkerToolset(): Promise<ExtensionWorkerToolset>;
  /** Memoized OMP driver over the worker toolset (issue #158). */
  getDriver(): AgentDriver | Promise<AgentDriver>;
}

/**
 * The executor composition root (issue #172, #153 item 2): the boot-time
 * process-scoped resources — the shared runtime chain (bootstrapRuntime:
 * store → audit → org policy → extension registry → surfaces → extension
 * runtime → memory provider, identical to the server and MCP roots), the
 * agent-dir modelRoles pin sync (issue #78), and the memoized
 * worker-toolset/driver getters — exactly what the entrypoint's
 * import.meta.main block runs. Caller-level boot tests
 * (src/executor-boot.test.ts) drive this to observe the worker toolset +
 * pin + model guard, the executor analogue of the server's
 * boot-wiring.test.ts.
 */
export async function bootExecutorRuntime(opts: {
  agentDir?: string;
  /** Database opened by this composition root. Sandbox children pass the one allowlisted database mount. */
  dbPath?: string;
  /**
   * Sandbox-child isolation (#101/#338): when set, this root boots over the
   * provided job-scoped store RPC client instead of opening `dbPath` — the
   * job container never touches the shared bottega.db bytes. Mutually
   * exclusive with `dbPath`.
   */
  store?: Store;
  /** Injected scoped memory provider for the sandbox child (no shared-db handle). */
  memoryProvider?: ResolvedMemoryProvider;
  /**
   * Injected, already-scoped org settings for the sandbox child (issue
   * #101): avoids synchronous store reads over the async RPC socket when
   * `store` is an RPC client. The supervisor serializes its parsed
   * settings into the job request.
   */
  orgSettings?: OrgSettings | null;
  /** Skip the global extension-registry merge (denied by the sandbox store RPC allowlist). */
  skipRuntimeRegistryMerge?: boolean;
  /** Secret env names a sandbox child must never seed into its process. */
  skipBootSecretEnvNames?: readonly string[];
  /** Sandbox children inherit no secret env and must not contact the boot vault. */
  skipBootSecretSeed?: boolean;
  /** Sandbox children never rewrite the process-external proxy credential mount. */
  skipProxyCredentialSync?: boolean;
  /** MCP transport seam for tools-less manifest discovery (test seam; also threaded into the runtime). */
  mcpTransport?: (binding: McpBinding) => Transport;
  /**
   * Egress-boundary override (issue #191): proxy-control / secrets-dir
   * overrides threaded into the shared chain's credential boundary (see
   * {@link BootstrapRuntimeDeps.boundary}). The composition-root parity
   * test pins an absolute temp secrets dir so its authorize() probes never
   * touch the live data/proxy-secrets. Unset → the deployment defaults.
   */
  boundary?: SecretFileBoundaryOpts;
} = {}): Promise<ExecutorBoot> {
  // Issue #201: seed the boot secrets (Slack tokens + webhook secret) from
  // the auth-broker vault before the SDK constructs providers — the
  // executor's sessions resolve the same models.yml as the server, and the
  // #80 model-key guard below needs the seeded env. Same call as the
  // server and MCP roots. Issue #208: then push the provider credentials
  // into the proxy (the app process never holds them — models.yml carries
  // the placeholder, the proxy injects the real key at egress).
  if (opts.skipBootSecretSeed !== true) {
    await seedBootSecretsFromVault(
      opts.skipBootSecretEnvNames === undefined ? undefined : { skipEnvNames: opts.skipBootSecretEnvNames },
    );
  }
  if (opts.skipProxyCredentialSync !== true) await syncProxyCredentialsFromEnv();
  const runtime = await bootstrapRuntime({
    router: DenyRouter,
    ...(opts.dbPath !== undefined ? { dbPath: opts.dbPath } : undefined),
    ...(opts.store !== undefined ? { store: opts.store } : undefined),
    ...(opts.memoryProvider !== undefined ? { memoryProvider: opts.memoryProvider } : undefined),
    ...(opts.orgSettings !== undefined ? { orgSettings: opts.orgSettings } : undefined),
    ...(opts.skipRuntimeRegistryMerge === true ? { skipRuntimeRegistryMerge: true } : undefined),
    ...(opts.mcpTransport !== undefined ? { mcpTransport: opts.mcpTransport } : undefined),
    ...(opts.boundary !== undefined ? { boundary: opts.boundary } : undefined),
  });
  const { store, audit, orgPolicy } = runtime;
  const agentDir = opts.agentDir ?? "data/omp-agent";
  mkdirSync(agentDir, { recursive: true });
  // Boot-time pin sync (issue #78 recurrence, staleness #207): the SDK
  // reads modelRoles from the agent dir's config.yml; host-dev agent dirs
  // are never re-synced from config/omp, so a stale copy without the pin
  // silently falls back to the provider catalog default (kimi-k2.7-code) —
  // the Console Go 400 path. A stale existing pin is corrected in place,
  // unless the org settings override the default (#125: the operator's own
  // agent-dir pin is then inert and must not be clobbered).
  const pinSync = ensureAgentDirModelPin(agentDir, OMP_CONFIG_TEMPLATE, {
    orgDefault: opts.orgSettings !== undefined ? opts.orgSettings?.models?.default : runtime.store.getOrgSettings()?.models?.default,
  });
  if (pinSync === "created" || pinSync === "patched" || pinSync === "updated") {
    console.log(
      `bottega executor: agent-dir config.yml ${pinSync} — modelRoles pin synced from ${OMP_CONFIG_TEMPLATE}`,
    );
  }
  // One registry/runtime/provider/toolset per executor process. The getter
  // defers construction until runExecutor resolves the driver, then shares
  // the exact same definitions with session routing.
  let cachedWorkerToolset: Promise<ExtensionWorkerToolset> | undefined;
  const getExtensionWorkerToolset = (): Promise<ExtensionWorkerToolset> => {
    if (cachedWorkerToolset === undefined) {
      cachedWorkerToolset = Promise.resolve(buildExecutorWorkerToolset(runtime));
    }
    return cachedWorkerToolset;
  };
  let driver: AgentDriver | Promise<AgentDriver> | undefined;
  const getDriver = (): AgentDriver | Promise<AgentDriver> => {
    if (driver === undefined) {
      // The driver getter is async-capable (the toolset resolves surfaces
      // for tools-less manifests, issue #158); memoize the resolved value.
      driver = getExtensionWorkerToolset().then((workerTools) => {
        // Pre-approved session: the work item's pickup approval IS the
        // authorization for allowlisted exec-tier built-ins. Memory tools
        // ride this driver gate. Extension definitions stay in customTools
        // because createExtensionRuntime runs its own policy gate and must
        // never be double-wrapped.
        return createOmpSdkDriver({
          agentDir,
          customTools: workerTools.extensionTools,
          gate: {
            orgPolicy,
            audit,
            router: DenyRouter,
            store,
            preApproved: true,
            tools: workerTools.memoryTools,
          },
        });
      });
    }
    return driver;
  };
  return { runtime, getExtensionWorkerToolset, getDriver };
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

/** Boot: require isolation, resolve config, recover stale runs, sweep unclaimed jobs, and install askpass. */
export async function prepareExecutor(deps: ExecutorDeps): Promise<ExecutorConfig> {
  if (deps.sandboxRunner === undefined) {
    throw new Error("sandbox runner unavailable: executor refuses to start without per-job isolation");
  }
  const cfg = resolveConfig(deps);
  await recoverStaleWorkItems(deps.store, DEFAULT_STALE_AFTER_MS);
  // Epic #170 fail-loud: a dispatched job no worker claimed within its TTL
  // becomes a visible job.unclaimed audit + nudge — a scheduled job
  // silently never posting is the worst failure mode of the worker design.
  await sweepUnclaimedJobs(deps, cfg);
  writeAskpassScript(cfg);
  return cfg;
}

export async function runExecutor(deps: ExecutorDeps, signal?: AbortSignal): Promise<void> {
  const cfg = await prepareExecutor(deps);
  // The production dependency is a lazy getter. Resolve it before the
  // model-registry guard because createOmpSdkDriver installs agentDir as
  // process-global state used by that guard.
  await deps.driver;
  // Boot-time guard (issue #80), same fail-fast as the server: the driver
  // installed the agent dir as the process-global dir at construction, so
  // verify the registry resolves an available model from ITS catalog before
  // the claim loop starts — a clear boot error, never "No model selected"
  // mid-implementation. Runs after prepareExecutor so the PAT guard (the
  // credential boundary, issue #9) stays the first fail-closed check.
  await assertAgentDirModelAvailable(deps.agentDir ?? "data/omp-agent");
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  console.log(`executor ready: allowlist ${cfg.repoAllowlist.join(", ") || "(empty — no pushes until configured)"}, workspaces ${cfg.workspacesDir}`);
  let lastSweep = Date.now();
  while (!signal?.aborted) {
    // Fail-loud cadence (epic #170): sweep for unclaimed jobs periodically;
    // prepareExecutor already swept once at boot.
    if (Date.now() - lastSweep >= cfg.jobSweepIntervalMs) {
      await sweepUnclaimedJobs(deps, cfg);
      lastSweep = Date.now();
    }
    let job: WorkerJob | null = null;
    try {
      job = await deps.store.claimNextJob(cfg.jobLeaseMs);
    } catch (err) {
      console.log(`claim failed: ${err instanceof Error ? err.message : String(err)}`);
      await Bun.sleep(pollIntervalMs);
      continue;
    }
    if (!job) {
      await Bun.sleep(pollIntervalMs);
      continue;
    }
    await processJob(deps, cfg, job);
  }
}

/**
 * One claimed job's full lifecycle (epic #170): audit the claim, route by
 * kind, then complete → outbox row + audit job.completed, or fail → bounded
 * requeue with backoff (max attempts then job.failed). Never throws: the job
 * bus absorbs every failure loudly. The outbox row (id = the envelope id) is
 * the worker→server signal; the audit rows are pure evidence.
 */
async function processJob(deps: ExecutorDeps, cfg: ExecutorConfig, job: WorkerJob): Promise<void> {
  await deps.store.appendAudit({
    space_id: job.spaceId ?? null,
    actor: "executor",
    event_type: JOB_CLAIMED_EVENT,
    payload: JSON.stringify({ id: job.id, kind: job.kind, attempts: job.attempts, lease_until: job.leaseUntil ?? null }),
  });
  let outcome: JobRunOutcome | null = null;
  try {
    outcome = await runJob(deps, cfg, job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (job.attempts >= cfg.maxJobAttempts) {
      await deps.store.failJob(job.id);
      await deps.store.appendAudit({
        space_id: job.spaceId ?? null,
        actor: "executor",
        event_type: JOB_FAILED_EVENT,
        payload: JSON.stringify({ id: job.id, kind: job.kind, error: message.slice(0, 2000), attempts: job.attempts }),
      });
      console.log(`[${job.id}] job failed after ${job.attempts} attempts (${job.kind}): ${message}`);
      return;
    }
    const backoffMs = Math.min(cfg.jobBackoffMs * 2 ** (job.attempts - 1), cfg.jobBackoffMaxMs);
    await deps.store.requeueJob(job.id, backoffMs);
    await deps.store.appendAudit({
      space_id: job.spaceId ?? null,
      actor: "executor",
      event_type: JOB_FAILED_EVENT,
      payload: JSON.stringify({
        id: job.id,
        kind: job.kind,
        error: message.slice(0, 2000),
        attempts: job.attempts,
        requeued: true,
        backoff_ms: backoffMs,
      }),
    });
    console.log(`[${job.id}] job attempt ${job.attempts} failed (${job.kind}): ${message} — requeued in ${backoffMs} ms`);
    return;
  }
  if (outcome.selfReported) {
    // Issue #101: the sandbox already wrote the job's terminal lifecycle
    // (completeJob + its own outbox row + audit) through the scoped
    // facade — completing again would double the outbox signal.
    console.log(`[${job.id}] sandbox self-reported ${outcome.state} (${job.kind})`);
    return;
  }
  await deps.store.completeJob(job.id);
  // The worker→server signal (epic #170): one outbox row per completed job,
  // keyed by the SAME envelope id so the server's watermarked consumer can
  // join it to the audit trail. The server never scans audit as a queue.
  postOutboxRow(deps.store, {
    id: job.id,
    kind: job.kind,
    payload: { state: outcome.state, result: outcome.result ?? null },
    space: job.spaceId ?? null,
  });
  await deps.store.appendAudit({
    space_id: job.spaceId ?? null,
    actor: "executor",
    event_type: JOB_COMPLETED_EVENT,
    payload: JSON.stringify({ id: job.id, kind: job.kind, state: outcome.state, result: outcome.result ?? null }),
  });
  console.log(`[${job.id}] job completed (${job.kind}, ${outcome.state})`);
}

/** What a job's run produced: the terminal state + the delivery result (if any). */
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

/** Every durable job kind crosses the mandatory per-job sandbox boundary. */
async function runJob(deps: ExecutorDeps, cfg: ExecutorConfig, job: WorkerJob): Promise<JobRunOutcome> {
  const runner = deps.sandboxRunner;
  if (runner === undefined) {
    throw new Error("sandbox runner unavailable: refusing in-process job execution");
  }
  if (job.kind !== "scheduled") return runJobInSandbox(deps, cfg, job, runner);

  const parsed = scheduledJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new Error(`scheduled job payload must be { action, ... } — failing closed: ${parsed.error.message}`);
  }
  const scheduledDeps: ExecutorDeps = {
    ...deps,
    scheduledActions: deps.scheduledActions ?? buildRegistry([memoryConsolidationAction()]),
    consolidationModelCall: deps.consolidationModelCall ?? createDefaultConsolidationModelCall(deps.driver),
  };
  return runJobInSandbox(scheduledDeps, cfg, job, runner);
}

/**
 * The default consolidation model call (issue #272): a driver side session
 * with no tools — the same shape the server used before the move, but bound
 * to the EXECUTOR's driver so the LLM leg runs in the worker process. The
 * driver resolves lazily on first call. Tests stub the seam instead.
 */
export function createDefaultConsolidationModelCall(driver: AgentDriver | Promise<AgentDriver>): ConsolidationModelCall {
  let consolidationSequence = 0;
  return async (systemPrompt, input) => {
    const resolved = await driver;
    let reply: string | undefined;
    let sideSession: AgentSessionDriver | undefined;
    let offMessage: (() => void) | undefined;
    try {
      sideSession = await resolved.createSession({
        spaceId: `memory-consolidation:${++consolidationSequence}`,
        transcriptDir: "data/memory-consolidation",
        allowTools: [],
        appendSystemPrompt: systemPrompt,
        onOutput: (_spaceId, text) => {
          if (text.trim()) reply = text;
        },
      });
      offMessage = sideSession.on("message", (data) => {
        // The driver emits { spaceId, text } payloads; parse at the event
        // boundary so only string text is captured (defensive against other
        // message shapes).
        const text = z.object({ text: z.string().optional() }).safeParse(data);
        if (text.success && text.data.text && text.data.text.trim()) reply = text.data.text;
      });
      await sideSession.prompt(input);
      return reply;
    } finally {
      offMessage?.();
      if (sideSession) {
        try {
          await sideSession.dispose();
        } catch (error) {
          console.error("[memory-consolidation] side-session dispose failed:", error);
        }
      }
    }
  };
}

/**
 * Runs an ingest_poll job (issue #101): the split fetch/validate leg of the
 * scheduler's poll pipeline runs IN THE WORKER (mirrors the kb pattern) —
 * fetch + validate over a watermarked poller, then hand the validated
 * events to the outbox so the server's in-process seam does dispatch + post
 * (the server holds the Slack tokens). The durable watermark rides the job
 * envelope's space and is persisted via the store's ingest_watermark rows
 * (getIngestWatermark/setIngestWatermark), so a crash re-polls from the
 * last boundary instead of re-fetching the world.
 */
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

/**
 * Fail-loud unclaimed sweep (epic #170): jobs no worker claimed within
 * their TTL are failed and surfaced — audit job.unclaimed + the nudge hook.
 * The worker holds no Slack tokens, so the nudge is the audit row + a log
 * line + the injectable seam; the server-side onboarding nudge wires to
 * these rows in Wave 2.
 */
async function sweepUnclaimedJobs(deps: ExecutorDeps, cfg: ExecutorConfig): Promise<void> {
  const jobs = await deps.store.markUnclaimedJobs(cfg.jobUnclaimedTtlMs);
  for (const job of jobs) {
    await deps.store.appendAudit({
      space_id: job.spaceId ?? null,
      actor: "executor",
      event_type: JOB_UNCLAIMED_EVENT,
      payload: JSON.stringify({ id: job.id, kind: job.kind, reason: "no worker claimed the job within its TTL" }),
    });
    console.log(`[${job.id}] job unclaimed (${job.kind}) — no live worker within ${cfg.jobUnclaimedTtlMs} ms`);
    try {
      await deps.onUnclaimed?.(job);
    } catch (err) {
      console.log(`[${job.id}] unclaimed nudge hook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

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
    ...(item.model !== null && item.model !== "fast" && item.model !== "reasoning" ? { model: item.model } : undefined),
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
  if (item.model === "fast" || item.model === "reasoning") return item.model;
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

/**
 * Repo allowlist file default (issue #47): `repos` + `git_base_url` from
 * config/org.yml. The org settings blob (issue #67) overrides BOTH when set
 * — the DB is the source of truth, the file is the default. Parsed by the
 * shared YAML-subset parser and validated — a malformed org.yml is a loud
 * boot error, never a silent mis-parse (trailing comments, inline
 * sequences, and odd indentation previously produced wrong repo/git-base
 * values).
 *
 * This list is an AUTHORIZATION FENCE, not a routing table: work items name
 * their own repo (derived from the conversation + org memory), and the
 * executor refuses anything not listed here. An empty list is a legal boot
 * state — no pushes happen until a repo is configured.
 */
function loadRepoAllowlist(dir: string) {
  let gitBaseUrl = "https://github.com";
  let repos: string[] = [];
  // Missing org.yml is a loud boot error: an executor without config cannot
  // authorize any push.
  const text = readFileSync(join(dir, "org.yml"), "utf8");
  let doc: Record<string, YamlNode>;
  try {
    doc = parseYamlSubset(text);
  } catch (err) {
    throw new Error(`config/org.yml: ${err instanceof Error ? err.message : String(err)}`);
  }
  const base = doc["git_base_url"];
  if (base !== undefined) {
    const parsedBase = z.string().safeParse(base);
    if (!parsedBase.success) throw new Error("config/org.yml: git_base_url must be a string");
    gitBaseUrl = parsedBase.data;
  }
  const reposNode = doc["repos"];
  if (reposNode !== undefined) {
    if (!Array.isArray(reposNode)) throw new Error("config/org.yml: repos must be a list of owner/repo strings");
    repos = reposNode.map((r) => {
      const parsedRepo = z.string().safeParse(r);
      if (!parsedRepo.success) throw new Error("config/org.yml: repos must be a list of owner/repo strings");
      return parsedRepo.data;
    });
  }
  // Keep only well-formed owner/repo entries: anything else can never match
  // an item's repo and would only muddy the fence.
  return { repos: repos.filter((r) => /^[^/]+\/[^/]+$/.test(r)), gitBaseUrl };
}

export function resolveConfig(deps: ExecutorDeps): ExecutorConfig {
  // Issue #67: runtime knobs live in the org settings blob (DB is the
  // source of truth); config/org.yml is the default/fallback, parsed only
  // when settings do NOT cover the keys it provides (repos or git base) —
  // a settings-driven deployment never depends on the file. A malformed
  // blob fails the executor boot closed (getOrgSettings throws).
  const settings = deps.store.getOrgSettings();
  const needsFile = settings?.repos === undefined || settings?.gitBaseUrl === undefined;
  const fileConfig = needsFile
    ? loadRepoAllowlist(deps.orgConfigDir ?? DEFAULT_ORG_CONFIG_DIR)
    : { repos: [], gitBaseUrl: "https://github.com" };
  const repos = settings?.repos ?? fileConfig.repos;
  const gitBaseUrl = (settings?.gitBaseUrl ?? fileConfig.gitBaseUrl).replace(/\/+$/, "");
  const apiBaseUrl = (settings?.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const workspacesDir = settings?.workspacesDir ?? defaultWorkspaceRoot();
  const allowLoosePat = settings?.allowLoosePat ?? false;
  const tokenFile = process.env.EXECUTOR_GIT_TOKEN_FILE ?? "data/secrets/github-pat";
  if (!existsSync(tokenFile)) {
    throw new Error(`git token file not found: ${tokenFile} (install the PAT there, mode 0600 — never env/image)`);
  }
  const tokenMode = statSync(tokenFile).mode & 0o777;
  if (tokenMode !== 0o600) {
    if (!allowLoosePat) {
      throw new Error(
        `git token file ${tokenFile} must be mode 0600 (found ${tokenMode.toString(8)}); ` +
          "set org settings allow_loose_pat to override for local dev only",
      );
    }
    console.log(`warning: ${tokenFile} mode is ${tokenMode.toString(8)} — allow_loose_pat set, continuing`);
  }
  return {
    repoAllowlist: repos,
    gitBaseUrl,
    apiBaseUrl,
    workspacesDir,
    transcriptDir: deps.transcriptDir ?? DEFAULT_TRANSCRIPT_DIR,
    tokenFile,
    askpassScript: join(dirname(tokenFile), ASKPASS_SCRIPT_NAME),
    jobLeaseMs: deps.jobLeaseMs ?? DEFAULT_STALE_AFTER_MS,
    maxJobAttempts: deps.maxJobAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS,
    jobBackoffMs: deps.jobBackoffMs ?? DEFAULT_JOB_BACKOFF_MS,
    jobBackoffMaxMs: deps.jobBackoffMaxMs ?? DEFAULT_JOB_BACKOFF_MAX_MS,
    jobUnclaimedTtlMs: deps.jobUnclaimedTtlMs ?? DEFAULT_STALE_AFTER_MS,
    jobSweepIntervalMs: deps.jobSweepIntervalMs ?? DEFAULT_JOB_SWEEP_INTERVAL_MS,
  };
}

/** Idempotent: (re)writes the askpass helper next to the token file, mode 0700. */
function writeAskpassScript(cfg: ExecutorConfig): void {
  mkdirSync(dirname(cfg.askpassScript), { recursive: true });
  writeFileSync(
    cfg.askpassScript,
    [
      "#!/bin/sh",
      "# bottega executor git credential helper (issue #11): answers git's",
      "# username/password prompts with the PAT read from the token FILE —",
      "# the token never enters the environment or the image.",
      'exec cat "${EXECUTOR_GIT_TOKEN_FILE}"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(cfg.askpassScript, 0o700);
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

if (import.meta.main) {
  const dbPath = process.env.BOTTEGA_DB_PATH ?? "data/bottega.db";
  const boot = await bootExecutorRuntime({ dbPath });
  const { store } = boot.runtime;
  const memoryProvider = boot.runtime.memoryProvider;
  // Production isolation: one disposable Docker container per job. The
  // supervisor RETAINS the real Store + memory provider (single-writer on
  // the data volume, #101) and exposes ONLY job-scoped store/memory ops to
  // the container over a bounded unix-socket RPC (no bottega.db bytes, no
  // shared-root mounts). The job container mounts ONLY its own workspace
  // subdir, its own transcript subdir, the RPC socket dir, the egress CA,
  // and the exact kind-authorized credential material. The supervisor's
  // mount SOURCE paths are the deployment-visible ones when it runs inside
  // a container (BOTTEGA_SANDBOX_*_HOST / volume roots).
  const sandboxWorkspaces = process.env.BOTTEGA_SANDBOX_WORKSPACES_HOST ?? defaultWorkspaceRoot();
  const sandboxTranscripts = process.env.BOTTEGA_SANDBOX_TRANSCRIPTS_HOST ?? "data/transcripts";
  const sandboxVolume = process.env.BOTTEGA_SANDBOX_DATA_VOLUME;
  const sandboxRunner = createDockerSandboxRunner({
    workspacesDir: sandboxWorkspaces,
    transcriptDir: sandboxTranscripts,
    volume: sandboxVolume,
    // Named-volume subpath roots: where the shared `data` volume is mounted
    // in the supervisor for the workspaces and state axes. In compose both are
    // the same volume, mounted at /workspaces and /app/data respectively, so a
    // job workspace /workspaces/<itemId> maps to volume-subpath <itemId> and a
    // transcript dir /app/data/transcripts/<itemId> maps to transcripts/<itemId>.
    volumeWorkspacesRoot: process.env.BOTTEGA_SANDBOX_WORKSPACES_VOLUME_ROOT ?? sandboxWorkspaces,
    volumeStateRoot: process.env.BOTTEGA_SANDBOX_STATE_VOLUME_ROOT ?? (sandboxVolume ? "/app/data" : undefined),
    hostStore: store,
    memoryProvider,
    orgSettings: store.getOrgSettings(),
    gitTokenFile: process.env.EXECUTOR_GIT_TOKEN_FILE,
    brokerTokenFile: process.env.OMP_AUTH_BROKER_TOKEN_FILE,
    network: process.env.BOTTEGA_SANDBOX_NETWORK,
    dns: process.env.BOTTEGA_SANDBOX_DNS ? process.env.BOTTEGA_SANDBOX_DNS.split(",") : undefined,
    proxyUrl: process.env.BOTTEGA_SANDBOX_PROXY_URL,
    caCertHostPath: process.env.BOTTEGA_SANDBOX_CA_CERT_HOST,
    requireDocker: true,
  });
  await probeDockerSandbox({
    workspacesDir: sandboxWorkspaces,
    transcriptDir: sandboxTranscripts,
    volume: sandboxVolume,
    requireDocker: true,
  });
  let driver: AgentDriver | Promise<AgentDriver> | undefined;
  const executorDeps: ExecutorDeps = {
    store,
    dbPath,
    sandboxRunner,
    memoryProvider,
    get driver(): AgentDriver | Promise<AgentDriver> {
      return (driver ??= boot.getDriver());
    },
    getExtensionWorkerToolset: boot.getExtensionWorkerToolset,
    orgConfigDir: "config",
  };
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  process.on("SIGTERM", () => ac.abort());
  runExecutor(executorDeps, ac.signal).catch((err) => {
    console.error("bottega executor: fatal", err);
    process.exit(1);
  });
}
