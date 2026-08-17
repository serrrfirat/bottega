/**
 * Executor: containerized work-item delivery runner (issues #11 and #129).
 *
 * One claim loop, one agent session per executable work item, no
 * orchestration framework. Boots with stale-run recovery (#10), then routes:
 *
 *   git       → workspace → agent → push → PR → review → done | blocked
 *   extension → memory/extension agent → external object → done | blocked
 *   chat      → returned to open for the space agent
 *
 * Credential boundary: the git PAT lives in a FILE (default
 * data/secrets/github-pat, mode 0600, env-overridable via
 * EXECUTOR_GIT_TOKEN_FILE). It never enters the environment or the image:
 * git reads it through a generated GIT_ASKPASS helper, and the GitHub API
 * request reads the same file. A mode other than 0600 fails boot closed
 * (org setting allow_loose_pat opts out, local dev only). The PAT value
 * also never reaches tests via env (asserted in executor.test.ts).
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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recoverStaleWorkItems, type Store, type SpaceModelSettings, type WorkItem } from "./store/db";
import {
  DELIVERY_COMPLETED_EVENT,
  DELIVERY_PENDING_EVENT,
  DELIVERY_RESOLVED_EVENT,
  WORK_ITEM_FAILED_EVENT,
  WORK_ITEM_PIN_APPLIED_EVENT,
} from "./store/audit-events";
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
import type { SecretFileBoundaryOpts } from "./extensions/boundary";
import { extensionToolDefinitions } from "./extensions/tools";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpBinding } from "./extensions/manifest";
import { memoryToolDefinitions } from "./tools/memory";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { parseYamlSubset, type YamlNode } from "./yaml-subset";

/**
 * Work-item session tool allowlist: file/code tools + bash. Git runs through
 * bash — the SDK exposes no standalone git tools (`github` is the gh-CLI
 * wrapper and needs its own auth, so it stays out).
 */
export const EXECUTOR_TOOLS = ["read", "write", "glob", "grep", "bash"] as const;

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
  store: Store;
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
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
/** Delivery-approval wait poll interval (issue #149): the default onDelivery re-reads the audit trail this often. */
const DEFAULT_DELIVERY_POLL_INTERVAL_MS = 2000;
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
  // Issue #201: seed the provider keys from the auth-broker vault before
  // the SDK constructs providers — the executor's sessions resolve the
  // same models.yml env names as the server, and the #80 model-key guard
  // below needs the seeded env. Same call as the server and MCP roots.
  await seedBootSecretsFromVault();
  const runtime = await bootstrapRuntime({
    router: DenyRouter,
    ...(opts.mcpTransport !== undefined ? { mcpTransport: opts.mcpTransport } : {}),
    ...(opts.boundary !== undefined ? { boundary: opts.boundary } : {}),
  });
  const { store, audit, orgPolicy } = runtime;
  const agentDir = opts.agentDir ?? "data/omp-agent";
  mkdirSync(agentDir, { recursive: true });
  // Boot-time pin sync (issue #78 recurrence): the SDK reads modelRoles from
  // the agent dir's config.yml; host-dev agent dirs are never re-synced from
  // config/omp, so a stale copy without the pin silently falls back to the
  // provider catalog default (kimi-k2.7-code) — the Console Go 400 path.
  const pinSync = ensureAgentDirModelPin(agentDir);
  if (pinSync === "created" || pinSync === "patched") {
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
interface ExecutorConfig {
  /** Authorization fence (issue #47): the only owner/repo pairs the executor may clone/push to. */
  repoAllowlist: string[];
  gitBaseUrl: string;
  apiBaseUrl: string;
  workspacesDir: string;
  transcriptDir: string;
  tokenFile: string;
  askpassScript: string;
}

/** Boot: resolve config, recover stale runs (#10), install the askpass helper. */
export async function prepareExecutor(deps: ExecutorDeps): Promise<ExecutorConfig> {
  const cfg = resolveConfig(deps);
  await recoverStaleWorkItems(deps.store, DEFAULT_STALE_AFTER_MS);
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
  while (!signal?.aborted) {
    let item: WorkItem | null = null;
    try {
      item = await deps.store.claimNextWorkItem();
    } catch (err) {
      console.log(`claim failed: ${(err as Error).message}`);
      await Bun.sleep(pollIntervalMs);
      continue;
    }
    if (!item) {
      await Bun.sleep(pollIntervalMs);
      continue;
    }
    await processItem(deps, cfg, item);
    // A chat item returns to open. Yield before it can be observed again so
    // an otherwise chat-only queue never becomes a synchronous hot loop.
    if (item.delivery === "chat") await Bun.sleep(pollIntervalMs);
  }
}

/** Full lifecycle of one claimed item. Never throws: failures land the item in blocked. */
async function processItem(deps: ExecutorDeps, cfg: ExecutorConfig, item: WorkItem): Promise<void> {
  if (item.delivery === "chat") {
    try {
      await deps.store.transitionWorkItem(item.id, "claimed", "open", { by: "executor" });
      console.log(`[${item.id}] chat delivery is handled by the space agent`);
    } catch (err) {
      console.log(`[${item.id}] chat handoff failed (item no longer claimed): ${(err as Error).message}`);
    }
    return;
  }

  try {
    await deps.store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
  } catch (err) {
    // Someone else moved the item between claim and start (e.g. aborted).
    console.log(`[${item.id}] start failed (item no longer claimed): ${(err as Error).message}`);
    return;
  }
  try {
    if (item.delivery === "extension") {
      await extensionWorkerPath(deps, cfg, item);
      return;
    }

    const workspace = join(cfg.workspacesDir, item.id);
    // Repo gate (issue #47): the repo comes from the conversation, the
    // allowlist is the authorization fence. Fail closed before any git work.
    const repo = item.repo;
    if (!repo) {
      await deps.store.transitionWorkItem(item.id, "working", "blocked", {
        evidence: "repo not specified — ask the requester",
        by: "executor",
      });
      console.log(`[${item.id}] blocked: repo not specified`);
      return;
    }
    if (!cfg.repoAllowlist.includes(repo)) {
      await deps.store.transitionWorkItem(item.id, "working", "blocked", {
        evidence: `repo "${repo}" is not on the executor allowlist (org settings repos, config/org.yml by default)`,
        by: "executor",
      });
      console.log(`[${item.id}] blocked: repo ${repo} not on the allowlist`);
      return;
    }
    console.log(`[${item.id}] working (${repo}, workspace ${workspace})`);
    await setupWorkspace(cfg, item, repo, workspace);
    const summary = await runAgentSession(deps, cfg, item, workspace);
    await deliver(deps, cfg, item, workspace, summary);
    // Delivered: drop the checkout (the transcript stays for the audit trail).
    rmSync(workspace, { recursive: true, force: true });
  } catch (err) {
    // Failure: git workspaces are kept for forensics; every delivery kind
    // lands the item in blocked with evidence — never silently dropped.
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[${item.id}] blocked: ${message}`);
    try {
      await deps.store.transitionWorkItem(item.id, "working", "blocked", {
        evidence: `executor failed: ${message.slice(0, 2000)}`,
        by: "executor",
      });
    } catch (transitionErr) {
      await deps.store.appendAudit({
        space_id: item.space_id,
        actor: "executor",
        event_type: WORK_ITEM_FAILED_EVENT,
        payload: JSON.stringify({ id: item.id, error: message }),
      });
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
  const session = await (await deps.driver).createSession({
    spaceId: item.space_id,
    transcriptDir: join(cfg.transcriptDir, item.id),
    allowTools,
    onOutput: (_spaceId, text) => console.log(`[${item.id}] extension agent: ${text}`),
    getModelSettings: async () => sessionSettings,
  });
  let finalOutput = "";
  let sessionError: Error | null = null;
  const offMessage = session.on("message", (data) => {
    const text = (data as { text?: unknown } | null)?.text;
    if (typeof text === "string") finalOutput = text;
  });
  const offError = session.on("error", (data) => {
    const text = (data as { message?: unknown } | null)?.message;
    sessionError = new Error(typeof text === "string" ? text : "extension worker session error");
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
    ...(delivery.url ? { url: delivery.url } : {}),
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
      ...(delivery.url ? { url: delivery.url } : {}),
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      validationError = "envelope must be an object";
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.summary !== "string" || record.summary.trim() === "") {
      validationError = "summary must be a non-empty string";
      continue;
    }
    if (record.url !== undefined && typeof record.url !== "string") {
      validationError = "url must be a string when present";
      continue;
    }
    const url = typeof record.url === "string" ? record.url.trim() : "";
    return {
      ...(url ? { url } : {}),
      summary: record.summary.trim(),
    };
  }
  throw new Error(`extension worker output missing a valid JSON envelope (${validationError})`);
}

async function setupWorkspace(cfg: ExecutorConfig, item: WorkItem, repo: string, workspace: string): Promise<void> {
  mkdirSync(cfg.workspacesDir, { recursive: true });
  // Fresh per item: a crashed run may have left a checkout behind.
  rmSync(workspace, { recursive: true, force: true });
  // The askpass contract covers every authenticated git operation: cloning
  // a private org repo needs the PAT just like the push does.
  await git(["clone", `${cfg.gitBaseUrl}/${repo}.git`, workspace], {
    env: { GIT_ASKPASS: cfg.askpassScript, EXECUTOR_GIT_TOKEN_FILE: cfg.tokenFile },
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
  const settings = await store.getSpaceSettings(item.space_id);
  if (item.model === null && item.reasoning_effort === null) return settings;
  return {
    ...settings,
    ...(item.reasoning_effort !== null ? { reasoning_effort: item.reasoning_effort } : {}),
    ...(item.model !== null && item.model !== "fast" && item.model !== "reasoning" ? { model: item.model } : {}),
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
  const session = await (await deps.driver).createSession({
    spaceId: item.id,
    transcriptDir: cfg.transcriptDir,
    cwd: workspace,
    allowTools: EXECUTOR_TOOLS,
    onOutput: (_spaceId, text) => console.log(`[${item.id}] agent: ${text}`),
    getModelSettings: async () => sessionSettings,
  });
  let summary = "";
  let sessionError: Error | null = null;
  const offMessage = session.on("message", (data) => {
    const text = (data as { text?: unknown } | null)?.text;
    if (typeof text === "string") summary = text;
  });
  const offError = session.on("error", (data) => {
    const text = (data as { message?: unknown } | null)?.message;
    sessionError = new Error(typeof text === "string" ? text : "agent session error");
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

function parseDeliveryResolution(raw: string): DeliveryResolutionPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as DeliveryResolutionPayload) : null;
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
 * FIRST recorded decision wins (listAudit returns rows in ts order).
 *
 * Headless/executor-only runs (no server to resolve) fail closed on the
 * timeout: null → the item lands in `blocked`, never a silent hang at
 * `working`.
 */
export async function waitForDeliveryApproval(
  store: Pick<Store, "listAudit">,
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
    const rows = await store.listAudit({ event_type: DELIVERY_RESOLVED_EVENT });
    for (const row of rows) {
      const payload = parseDeliveryResolution(row.payload);
      if (payload === null || payload.id !== item.id) continue;
      // First recorded decision wins.
      if (payload.approved === true && typeof payload.approver === "string") {
        log(`[${item.id}] delivery approved by <@${payload.approver}>`);
        return { approver: payload.approver };
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
  workspace: string,
  summary: string,
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
  const parsed = (await res.json()) as { html_url?: unknown };
  if (typeof parsed.html_url !== "string" || parsed.html_url.length === 0) {
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
function loadRepoAllowlist(dir: string): { repos: string[]; gitBaseUrl: string } {
  let gitBaseUrl = "https://github.com";
  let repos: string[] = [];
  // Missing org.yml is a loud boot error: an executor without config cannot
  // authorize any push.
  const text = readFileSync(join(dir, "org.yml"), "utf8");
  let doc: Record<string, YamlNode>;
  try {
    doc = parseYamlSubset(text);
  } catch (err) {
    throw new Error(`config/org.yml: ${(err as Error).message}`);
  }
  const base = doc["git_base_url"];
  if (base !== undefined) {
    if (typeof base !== "string") throw new Error("config/org.yml: git_base_url must be a string");
    gitBaseUrl = base;
  }
  const reposNode = doc["repos"];
  if (reposNode !== undefined) {
    if (!Array.isArray(reposNode)) throw new Error("config/org.yml: repos must be a list of owner/repo strings");
    repos = reposNode.map((r) => {
      if (typeof r !== "string") throw new Error("config/org.yml: repos must be a list of owner/repo strings");
      return r;
    });
  }
  // Keep only well-formed owner/repo entries: anything else can never match
  // an item's repo and would only muddy the fence.
  return { repos: repos.filter((r) => /^[^/]+\/[^/]+$/.test(r)), gitBaseUrl };
}

function resolveConfig(deps: ExecutorDeps): ExecutorConfig {
  // Issue #67: runtime knobs live in the org settings blob (DB is the
  // source of truth); config/org.yml is the default/fallback, parsed only
  // when settings do NOT cover the keys it provides (repos or git base) —
  // a settings-driven deployment never depends on the file. A malformed
  // blob fails the executor boot closed (getOrgSettings throws).
  const settings = deps.store.getOrgSettings();
  const needsFile = settings?.repos === undefined || settings?.gitBaseUrl === undefined;
  const fileConfig = needsFile
    ? loadRepoAllowlist(deps.orgConfigDir ?? DEFAULT_ORG_CONFIG_DIR)
    : { repos: [] as string[], gitBaseUrl: "https://github.com" };
  const repos = settings?.repos ?? fileConfig.repos;
  const gitBaseUrl = (settings?.gitBaseUrl ?? fileConfig.gitBaseUrl).replace(/\/+$/, "");
  const apiBaseUrl = (settings?.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const workspacesDir =
    settings?.workspacesDir ?? (existsSync("/workspaces") ? "/workspaces" : "data/workspaces");
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
  const boot = await bootExecutorRuntime();
  const { store } = boot.runtime;
  let driver: AgentDriver | Promise<AgentDriver> | undefined;
  const executorDeps: ExecutorDeps = {
    store,
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
