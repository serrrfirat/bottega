/**
 * Executor: containerized work-item runner with git delivery (issue #11).
 *
 * One claim loop, one agent session per work item, no orchestration
 * framework. Boots with stale-run recovery (#10), then per item:
 *
 *   open → claimed (store) → working → [agent session in a fresh workspace]
 *   → push bottega/<id> → PR via GitHub API → review (recorded approval)
 *   → done | blocked
 *
 * Credential boundary: the git PAT lives in a FILE (default
 * data/secrets/github-pat, mode 0600, env-overridable via
 * EXECUTOR_GIT_TOKEN_FILE). It never enters the environment or the image:
 * git reads it through a generated GIT_ASKPASS helper, and the GitHub API
 * request reads the same file. The PAT value also never reaches tests via
 * env (asserted in executor.test.ts).
 *
 * Delivery approval contract: after the PR is opened the executor writes a
 * `work_item.delivery_pending` audit marker, then calls the `onDelivery`
 * seam. The server hook (follow-up, TODO in src/server) posts the PR + an
 * approval request to the space channel and resolves with the human's
 * decision; the executor then records `working → review` with that approval
 * and completes `review → done` (the legal map requires a recorded approval
 * on review, and result.pr_url on done). Without a wired hook the executor
 * logs and waits — the item stays `working` until the space decides or
 * stale recovery blocks it on restart.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createStore, recoverStaleWorkItems, type Store, type WorkItem } from "./store/db";
import { createAudit } from "./policy/audit";
import { DenyRouter } from "./policy/approval-router";
import { loadOrgConfig } from "./policy/config";
import createPolicyExtension from "./policy/extension";
import { createOmpSdkDriver, type AgentDriver } from "./server/agent-driver";
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

export interface ExecutorDeps {
  store: Store;
  driver: AgentDriver;
  /** Directory holding org.yml (repos + git base). Default "config". */
  orgConfigDir?: string;
  /** Claim-loop poll interval. Default 2000 ms. */
  pollIntervalMs?: number;
  /** Stale TTL for boot recovery. Default 30 min. */
  staleAfterMs?: number;
  /** Transcript dir passed to the driver (one JSONL per work item). Default data/transcripts. */
  transcriptDir?: string;
  /**
   * Delivery approval seam: called with the opened PR, resolves the human
   * decision. `null` → delivery denied (item blocked). Absent → the
   * executor logs the pending request and waits indefinitely.
   */
  onDelivery?: (item: WorkItem, delivery: DeliveryInfo) => Promise<DeliveryApproval | null>;
  log?: (line: string) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const DEFAULT_TRANSCRIPT_DIR = "data/transcripts";
const DEFAULT_ORG_CONFIG_DIR = "config";
const BASE_BRANCH = "main";
const ASKPASS_SCRIPT_NAME = "git-askpass.sh";

interface ExecutorConfig {
  /** "owner/repo" — v1 runs every item in the first configured repo. */
  repo: string;
  gitBaseUrl: string;
  apiBaseUrl: string;
  workspacesDir: string;
  transcriptDir: string;
  tokenFile: string;
  askpassScript: string;
  log: (line: string) => void;
}

/** Boot: resolve config, recover stale runs (#10), install the askpass helper. */
export async function prepareExecutor(deps: ExecutorDeps): Promise<ExecutorConfig> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const cfg = resolveConfig(deps, log);
  await recoverStaleWorkItems(deps.store, deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  writeAskpassScript(cfg);
  return cfg;
}

export async function runExecutor(deps: ExecutorDeps, signal?: AbortSignal): Promise<void> {
  const cfg = await prepareExecutor(deps);
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  cfg.log(`executor ready: repo ${cfg.repo}, workspaces ${cfg.workspacesDir}`);
  while (!signal?.aborted) {
    let item: WorkItem | null = null;
    try {
      item = await deps.store.claimNextWorkItem();
    } catch (err) {
      cfg.log(`claim failed: ${(err as Error).message}`);
      await sleep(pollIntervalMs);
      continue;
    }
    if (!item) {
      await sleep(pollIntervalMs);
      continue;
    }
    await processItem(deps, cfg, item);
  }
}

/** Full lifecycle of one claimed item. Never throws: failures land the item in blocked. */
async function processItem(deps: ExecutorDeps, cfg: ExecutorConfig, item: WorkItem): Promise<void> {
  const workspace = join(cfg.workspacesDir, item.id);
  try {
    await deps.store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
  } catch (err) {
    // Someone else moved the item between claim and start (e.g. aborted).
    cfg.log(`[${item.id}] start failed (item no longer claimed): ${(err as Error).message}`);
    return;
  }
  try {
    cfg.log(`[${item.id}] working (${cfg.repo}, workspace ${workspace})`);
    await setupWorkspace(cfg, item, workspace);
    const summary = await runAgentSession(deps, cfg, item, workspace);
    await deliver(deps, cfg, item, workspace, summary);
    // Delivered: drop the checkout (the transcript stays for the audit trail).
    rmSync(workspace, { recursive: true, force: true });
  } catch (err) {
    // Failure: the workspace is kept for forensics; the item is blocked
    // with evidence — never silently dropped.
    const message = err instanceof Error ? err.message : String(err);
    cfg.log(`[${item.id}] blocked: ${message}`);
    try {
      await deps.store.transitionWorkItem(item.id, "working", "blocked", {
        evidence: `executor failed: ${message.slice(0, 2000)}`,
        by: "executor",
      });
    } catch (transitionErr) {
      await deps.store.appendAudit({
        space_id: item.space_id,
        actor: "executor",
        event_type: "work_item.failed",
        payload: JSON.stringify({ id: item.id, error: message }),
      });
    }
  }
}

async function setupWorkspace(cfg: ExecutorConfig, item: WorkItem, workspace: string): Promise<void> {
  mkdirSync(cfg.workspacesDir, { recursive: true });
  // Fresh per item: a crashed run may have left a checkout behind.
  rmSync(workspace, { recursive: true, force: true });
  await git(["clone", `${cfg.gitBaseUrl}/${cfg.repo}.git`, workspace]);
  await git(["checkout", "-b", `bottega/${item.id}`], { cwd: workspace });
  // Commit identity for the agent session's commits.
  await git(["config", "user.name", "bottega executor"], { cwd: workspace });
  await git(["config", "user.email", "executor@bottega.invalid"], { cwd: workspace });
}

async function runAgentSession(
  deps: ExecutorDeps,
  cfg: ExecutorConfig,
  item: WorkItem,
  workspace: string,
): Promise<string> {
  const session = await deps.driver.createSession({
    spaceId: item.id,
    transcriptDir: cfg.transcriptDir,
    cwd: workspace,
    allowTools: EXECUTOR_TOOLS,
    onOutput: (_spaceId, text) => cfg.log(`[${item.id}] agent: ${text}`),
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
  cfg.log(`[${item.id}] PR opened: ${prUrl}`);

  // Pending-approval marker (audit) — the space reads this to render the request.
  await deps.store.appendAudit({
    space_id: item.space_id,
    actor: "executor",
    event_type: "work_item.delivery_pending",
    payload: JSON.stringify({ id: item.id, pr_url: prUrl, summary }),
  });
  const requestApproval =
    deps.onDelivery ??
    ((_item, delivery) => {
      cfg.log(
        `[${_item.id}] delivery approval pending for ${delivery.prUrl} — ` +
          "server onDelivery hook not wired (follow-up; see src/server TODO)",
      );
      const { promise } = Promise.withResolvers<DeliveryApproval | null>();
      return promise;
    });
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
  cfg.log(`[${item.id}] delivered: ${prUrl}`);
}

async function openPullRequest(
  cfg: ExecutorConfig,
  item: WorkItem,
  branch: string,
  token: string,
  summary: string,
): Promise<string> {
  const res = await fetch(`${cfg.apiBaseUrl}/repos/${cfg.repo}/pulls`, {
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
 * Org repo config: `repos` + `git_base_url` from config/org.yml
 * (EXECUTOR_REPOS overrides). Parsed by the shared YAML-subset parser and
 * validated — a malformed org.yml is a loud boot error, never a silent
 * mis-parse (trailing comments, inline sequences, and odd indentation
 * previously produced wrong repo/git-base values).
 */
function loadOrgRepos(dir: string): { repos: string[]; gitBaseUrl: string } {
  let gitBaseUrl = "https://github.com";
  let repos: string[] = [];
  // Missing org.yml is a loud boot error: an executor with no repo is misconfigured.
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
  const envRepos = process.env.EXECUTOR_REPOS;
  if (envRepos) {
    repos = envRepos
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
  }
  return { repos, gitBaseUrl };
}

function resolveConfig(deps: ExecutorDeps, log: (line: string) => void): ExecutorConfig {
  const { repos, gitBaseUrl } = loadOrgRepos(deps.orgConfigDir ?? DEFAULT_ORG_CONFIG_DIR);
  const repo = repos.find((r) => /^[^/]+\/[^/]+$/.test(r));
  if (!repo) throw new Error(`no valid owner/repo configured (config/org.yml or EXECUTOR_REPOS)`);
  const workspacesDir = process.env.WORKSPACES_DIR ?? (existsSync("/workspaces") ? "/workspaces" : "data/workspaces");
  const tokenFile = process.env.EXECUTOR_GIT_TOKEN_FILE ?? "data/secrets/github-pat";
  if (!existsSync(tokenFile)) {
    throw new Error(`git token file not found: ${tokenFile} (install the PAT there, mode 0600 — never env/image)`);
  }
  const tokenMode = statSync(tokenFile).mode & 0o777;
  if (tokenMode !== 0o600) log(`warning: ${tokenFile} mode is ${tokenMode.toString(8)}, expected 600`);
  return {
    repo,
    gitBaseUrl: gitBaseUrl.replace(/\/+$/, ""),
    apiBaseUrl: (process.env.EXECUTOR_GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    workspacesDir,
    transcriptDir: deps.transcriptDir ?? DEFAULT_TRANSCRIPT_DIR,
    tokenFile,
    askpassScript: join(dirname(tokenFile), ASKPASS_SCRIPT_NAME),
    log,
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

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

if (import.meta.main) {
  const store = createStore();
  const audit = createAudit(store);
  const orgPolicy = loadOrgConfig();
  mkdirSync("data/omp-agent", { recursive: true });
  // Pre-approved session: the work item's pickup approval IS the
  // authorization for allowlisted exec-tier tools (bash) inside the
  // workspace; unknown tools still deny and every decision audits.
  const driver = createOmpSdkDriver({
    agentDir: "data/omp-agent",
    extensions: [createPolicyExtension({ orgPolicy, audit, router: DenyRouter, store, preApproved: true })],
  });
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  process.on("SIGTERM", () => ac.abort());
  runExecutor({ store, driver, orgConfigDir: "config" }, ac.signal).catch((err) => {
    console.error("bottega executor: fatal", err);
    process.exit(1);
  });
}
