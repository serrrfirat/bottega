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
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./fs-atomic";
import { recoverStaleWorkItems, type Store } from "./store/db";
import {
  JOB_CLAIMED_EVENT,
  JOB_COMPLETED_EVENT,
  JOB_FAILED_EVENT,
  JOB_UNCLAIMED_EVENT,
} from "./store/audit-events";
import { postOutboxRow } from "./store/outbox";
import type { WorkerJob } from "./worker/envelope";
import { createDockerSandboxRunner, probeDockerSandbox, runJobInSandbox } from "./worker/run-job";
import {
  DEFAULT_STALE_AFTER_MS,
  parseScheduledJobPayload,
  type ExecutorDeps,
  type ExecutorConfig,
  type ExtensionWorkerToolset,
  type JobRunOutcome,
} from "./worker/job-bodies";
import { recordTurnUsage } from "./tools/usage-meter";
import type { ConsolidationModelCall } from "./memory/consolidation";
import { buildRegistry } from "./scheduler/actions";
import { memoryConsolidationAction } from "./scheduler/memory-consolidation";
import { DenyRouter } from "./policy/approval-router";
import {
  assertAgentDirModelAvailable,
  createOmpSdkDriver,
  ensureAgentDirModelPin,
  OMP_CONFIG_TEMPLATE,
  type AgentDriver,
  type AgentSessionDriver,
} from "./server/drivers/agent-driver";
import { bootstrapRuntime, type BootstrapRuntime } from "./server/bootstrap-runtime";
import { seedBootSecretsFromVault } from "./server/boot-secrets";
import { agentDirModelDefault, syncProxyCredentialsFromEnv } from "./extensions/proxy-seed";
import type { SecretFileBoundaryOpts } from "./extensions/boundary";
import { extensionToolDefinitions } from "./extensions/tools";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpBinding } from "./extensions/manifest";
import { memoryToolDefinitions } from "./tools/memory";
import { z } from "zod";
import { parseYamlSubset, type YamlNode } from "./yaml-subset";
import type { ResolvedMemoryProvider } from "./server/memory-provider";
import type { OrgSettings } from "./store/org-settings";
import { defaultWorkspaceRoot } from "./worker/workspace-lifecycle";

// Re-export the moved executor JOB BODIES + their shared types from the leaf so
// the public surface callers import from "./executor" is unchanged. Dependency
// stays one-way: job-bodies <- run-job <- executor.
export {
  EXECUTOR_TOOLS,
  waitForDeliveryApproval,
  type DeliveryInfo,
  type DeliveryApproval,
  type ExecutorDeps,
  type ExecutorConfig,
  type JobRunOutcome,
  type ExtensionWorkerToolset,
} from "./worker/job-bodies";

/** The session driver "message" event payload: { spaceId, text }. */

const DEFAULT_POLL_INTERVAL_MS = 2000;
/** Job-loop defaults (epic #170): lease = stale-run window, bounded requeue with exponential backoff, fail-loud unclaimed sweep. */
const DEFAULT_MAX_JOB_ATTEMPTS = 5;
const DEFAULT_JOB_BACKOFF_MS = 5_000;
const DEFAULT_JOB_BACKOFF_MAX_MS = 5 * 60_000;
const DEFAULT_JOB_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_TRANSCRIPT_DIR = "data/transcripts";
const DEFAULT_ORG_CONFIG_DIR = "config";
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
  // Issue #339: resolve the agent dir up front and gate the codex
  // auth/mint leg on its config.yml `modelRoles.default` — the same pin
  // the SDK resolves its default session model from, so a near/DeepSeek
  // default never mints for codex.
  const agentDir = opts.agentDir ?? "data/omp-agent";
  if (opts.skipProxyCredentialSync !== true) {
    await syncProxyCredentialsFromEnv({ activeDefaultModel: agentDirModelDefault(agentDir) });
  }
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
          // Usage meter (issue #103): every executor-driven model completion
          // (work-item turns) lands a `usage.turn` audit row. Fire-and-forget —
          // a metering write never fails or delays the job it records.
          usageRecorder: async (turn) => void recordTurnUsage(audit, turn),
        });
      });
    }
    return driver;
  };
  return { runtime, getExtensionWorkerToolset, getDriver };
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

/** Every durable job kind crosses the mandatory per-job sandbox boundary. */
async function runJob(deps: ExecutorDeps, cfg: ExecutorConfig, job: WorkerJob): Promise<JobRunOutcome> {
  const runner = deps.sandboxRunner;
  if (runner === undefined) {
    throw new Error("sandbox runner unavailable: refusing in-process job execution");
  }
  if (job.kind !== "scheduled") return runJobInSandbox(deps, cfg, job, runner);

  // Fail closed on a malformed scheduled envelope (shared with the sandbox
  // body's runScheduledJobBody); the parsed action never drives execution
  // here — the body re-parses via the same helper.
  parseScheduledJobPayload(job);
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
  writeFileAtomic(
    cfg.askpassScript,
    [
      "#!/bin/sh",
      "# bottega executor git credential helper (issue #11): answers git's",
      "# username/password prompts with the PAT read from the token FILE —",
      "# the token never enters the environment or the image.",
      'exec cat "${EXECUTOR_GIT_TOKEN_FILE}"',
      "",
    ].join("\n"),
    0o700,
  );
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
  // The immutable extension registry that built the job containers' gated
  // toolset (issue #101): the ONLY providers any container may enumerate
  // credentials for. A hostile child cannot name a provider that is not a
  // registered extension for this deployment.
  const sandboxExtensionProviderIds = boot.runtime.registry.list().map((entry) => entry.manifest.id);
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
    extensionProviderIds: sandboxExtensionProviderIds,
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
