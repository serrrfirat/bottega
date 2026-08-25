/**
 * Executor tests (issue #11): the claim loop, the delivery protocol, and
 * the boot-time crash recovery, exercised against the real store, a real
 * git remote (local bare repo), and the emulate.dev GitHub emulator.
 *
 * The agent engine is faked (FakeDriver): sessions here are about the
 * executor's lifecycle, not the model. The emulator's PR records carry the
 * authenticated user resolved from the Bearer token, which is how the
 * "token from the FILE, never env" contract is asserted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "@emulators/core";
import githubPlugin, { seedFromConfig } from "@emulators/github";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type SpaceModelSettings, type Store, type WorkItem, type WorkItemState } from "./store/db";
import {
  DELIVERY_COMPLETED_EVENT,
  DELIVERY_PENDING_EVENT,
  DELIVERY_REQUESTED_EVENT,
  DELIVERY_RESOLVED_EVENT,
  EXTENSION_CALL_EVENT,
  JOB_CLAIMED_EVENT,
  JOB_COMPLETED_EVENT,
  JOB_FAILED_EVENT,
  JOB_UNCLAIMED_EVENT,
  MEMORY_WRITE_EVENT,
  OUTBOX_POSTED_EVENT,
  WORK_ITEM_PIN_APPLIED_EVENT,
  WORK_ITEM_TRANSITION_EVENT,
} from "./store/audit-events";
import { consumeOutboxWatermarked } from "./store/outbox";
import type { OutboxRow } from "./store/outbox";
import { workItemJobPayloadSchema, type WorkerJob } from "./worker/envelope";
import { inProcessSandboxRunner } from "./worker/run-job-test-fabric";
import type { SandboxRunner } from "./worker/run-job";
import {
  EXECUTOR_TOOLS,
  prepareExecutor,
  runExecutor,
  waitForDeliveryApproval,
  type DeliveryApproval,
  type DeliveryInfo,
  type ExecutorDeps,
  type ExtensionWorkerToolset,
} from "./executor";
import { WORKSPACE_MARKER_FILE } from "./worker/workspace-lifecycle";
import { resolveDeliveryAction } from "./server/adapters/delivery-router";
import { pollPendingDeliveries } from "./server/services/delivery-poller";
import { postPendingOutboxRows } from "./server/services/outbox-post-seam";
import {
  DELIVERY_APPROVE_ACTION_ID,
  DELIVERY_DENY_ACTION_ID,
  type SlackAction,
  type SlackAdapter,
} from "./server/adapters/slack";
import { createAudit } from "./policy/audit";
import { createSqliteMemoryProvider } from "./memory/sqlite";
import { DenyRouter } from "./policy/approval-router";
import { defaultPolicy } from "./policy/config";
import { createExtensionRuntime, type ExtensionRuntime } from "./extensions/runtime";
import { createExtensionRegistry } from "./extensions/registry";
import { extensionToolDefinitions } from "./extensions/tools";
import { createFixtureRegistry, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL } from "./extensions/fixture";
import { resolveMemoryProvider } from "./server/memory-provider";
import { memoryToolDefinitions } from "./tools/memory";
import type { Skill, ToolDefinition, TodoPhase } from "@oh-my-pi/pi-coding-agent";
import type { AgentDriver, AgentSessionDriver, AgentTurnOptions, DriverEvent, DriverEventData, ModelRole, ModelRoleSwitchResult } from "./server/drivers/agent-driver";
import { z } from "zod";

// --- Fakes ------------------------------------------------------------------

/** Evidence notes the store appends to a work item (transitionWorkItem / markStaleWorkItems). */
const urlEvidenceSchema = z.object({ kind: z.string(), url: z.string() });
const textEvidenceSchema = z.object({ kind: z.string(), text: z.string() });
/** Done-transition results written by the executor (git/chat deliveries). */
const prResultSchema = z.object({ pr_url: z.string(), summary: z.string() });
const prUrlSchema = z.object({ pr_url: z.string() });
/** Audit payload shapes written by the executor/server. */
const markerPayloadSchema = z.object({ id: z.string().optional() }).catch({ id: undefined });
/** The GitHub emulator's PR record (head/base/user), asserted per test. */
const emulatorPrSchema = z.object({
  head: z.object({ ref: z.string() }),
  base: z.object({ ref: z.string() }),
  user: z.object({ login: z.string() }),
});

/** Session driver double: records createSession opts, streams one canned message per prompt. */
class FakeSession implements AgentSessionDriver {
  prompts: string[] = [];
  /** setModelRole calls with the settings the session would resolve them against (issue #185). */
  readonly setModelRoleCalls: Array<{ role: ModelRole; settings: SpaceModelSettings }> = [];
  constructor(
    readonly opts: {
      spaceId: string;
      transcriptDir: string;
      cwd: string;
      allowTools: readonly string[];
      getModelSettings?: (spaceId: string) => Promise<SpaceModelSettings>;
      /** Work-item task-level skills injected through the driver seam (issues #234/#235). */
      skills?: readonly Skill[];
    },
    private readonly failure: Error | null,
    private readonly emittedError: string | null,
    private readonly messageText: string,
    private readonly onPrompt: (() => Promise<void>) | null,
  ) {}

  async setModelRole(role: ModelRole): Promise<ModelRoleSwitchResult> {
    const settings = (await this.opts.getModelSettings?.(this.opts.spaceId)) ?? {};
    this.setModelRoleCalls.push({ role, settings });
    return { applied: true, role, model: settings.model ?? null, thinking_level: settings.reasoning_effort ?? null };
  }

  async prompt(text: string, _opts?: AgentTurnOptions): Promise<void> {
    this.prompts.push(text);
    if (this.failure) throw this.failure;
    this.emit("turn_start", { spaceId: this.opts.spaceId });
    await this.onPrompt?.();
    this.emit("message", { spaceId: this.opts.spaceId, text: this.messageText });
    if (this.emittedError) this.emit("error", { spaceId: this.opts.spaceId, message: this.emittedError });
    this.emit("turn_end", { spaceId: this.opts.spaceId });
  }
  async abort(): Promise<void> {}
  isStreaming(): boolean {
    return false;
  }
  /** No todo plan (issue #228): the executor's item sessions stay internal. */
  getTodoPhases(): TodoPhase[] {
    return [];
  }
  on(event: DriverEvent, cb: (data: DriverEventData) => void): () => void {
    const set = (this.listeners[event] ??= new Set());
    set.add(cb);
    return () => set.delete(cb);
  }
  async dispose(): Promise<void> {}
  emit(event: DriverEvent, data: DriverEventData): void {
    for (const cb of this.listeners[event] ?? []) cb(data);
  }
  private readonly listeners: Record<string, Set<(data: DriverEventData) => void>> = {};
}

class FakeDriver implements AgentDriver {
  sessions: FakeSession[] = [];
  /** When set, the next session's prompt throws it (failure-path tests). */
  failure: Error | null = null;
  /** When set, the next session emits the driver's asynchronous error event. */
  emittedError: string | null = null;
  messageText = "implemented the requested change";
  onPrompt: (() => Promise<void>) | null = null;

  async createSession(opts: {
    spaceId: string;
    transcriptDir: string;
    onOutput: (spaceId: string, text: string) => void;
    cwd?: string;
    allowTools?: readonly string[];
    getModelSettings?: (spaceId: string) => Promise<SpaceModelSettings>;
    skills?: readonly Skill[];
  }): Promise<AgentSessionDriver> {
    const session = new FakeSession(
      {
        spaceId: opts.spaceId,
        transcriptDir: opts.transcriptDir,
        cwd: opts.cwd ?? process.cwd(),
        allowTools: opts.allowTools ?? [],
        getModelSettings: opts.getModelSettings,
        skills: opts.skills,
      },
      this.failure,
      this.emittedError,
      this.messageText,
      this.onPrompt,
    );
    this.sessions.push(session);
    return session;
  }
}

// --- Fixture -----------------------------------------------------------------

interface Fixture {
  dir: string;
  store: Store;
  spaceId: string;
  /** The executor's git remote for acme/sandbox (local bare repo). */
  bareRepo: string;
  /** The executor's git remote for acme/tooling (local bare repo). */
  toolingBareRepo: string;
  /** Base URL of the GitHub emulator (PR creation). */
  emulatorBase: string;
  /** The PAT that lives ONLY in the token file (0600). */
  pat: string;
  tokenFile: string;
  askpassScript: string;
  orgConfigDir: string;
  transcriptsDir: string;
  workspacesDir: string;
  driver: FakeDriver;
  deliveries: Array<{ item: WorkItem; delivery: DeliveryInfo }>;
  approvals: DeliveryApproval | null;
  cleanup(): void;
}

function runGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

const PAT = "github_pat_executor_test_secret_123";

function makeFixture(approval: DeliveryApproval | null = { approver: "U_HUMAN" }): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "bottega-exec-"));
  const store = createStore(join(dir, "store.db"));

  // Seeded local bare repos (the executor's remotes), each main with one
  // commit: acme/sandbox (the default in most tests) + acme/tooling (so the
  // allowlist has more than one entry and item.repo routing is observable).
  const seedBare = (name: string, content: string): string => {
    const seedWork = join(dir, `seed-${name}`);
    mkdirSync(seedWork, { recursive: true });
    runGit(["init", "-b", "main"], seedWork);
    runGit(["config", "user.email", "seed@example.com"], seedWork);
    runGit(["config", "user.name", "seed"], seedWork);
    writeFileSync(join(seedWork, "README.md"), content);
    runGit(["add", "README.md"], seedWork);
    runGit(["commit", "-m", "init"], seedWork);
    const bare = join(dir, "bare", "acme", `${name}.git`);
    mkdirSync(join(dir, "bare", "acme"), { recursive: true });
    runGit(["clone", "--bare", seedWork, bare]);
    rmSync(seedWork, { recursive: true, force: true });
    return bare;
  };
  const bareRepo = seedBare("sandbox", "# sandbox\n");
  const toolingBareRepo = seedBare("tooling", "# tooling\n");

  // Org config: the repo ALLOWLIST (issue #47) + git base (file:// so
  // clone/push stay local). Routing comes from item.repo, not this list.
  const orgConfigDir = join(dir, "config");
  mkdirSync(orgConfigDir, { recursive: true });
  writeFileSync(
    join(orgConfigDir, "org.yml"),
    `git_base_url: "file://${join(dir, "bare")}"\nrepos:\n  - "acme/sandbox"\n  - "acme/tooling"\n`,
  );

  // The PAT file: mode 0600, like the deployment contract.
  const tokenFile = join(dir, "secrets", "github-pat");
  mkdirSync(join(dir, "secrets"), { recursive: true });
  writeFileSync(tokenFile, `${PAT}\n`);
  chmodSync(tokenFile, 0o600);

  // GitHub emulator seeded with the same repo; the PAT resolves to bottega-bot.
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  const emu = createServer(githubPlugin, {
    baseUrl: `http://127.0.0.1:${port}`,
    tokens: { [PAT]: { login: "bottega-bot", id: 1, scopes: ["repo"] } },
  });
  seedFromConfig(emu.store, emu.baseUrl, {
    users: [{ login: "bottega-bot" }],
    orgs: [{ login: "acme" }],
    repos: [
      { owner: "acme", name: "sandbox", default_branch: "main" },
      { owner: "acme", name: "tooling", default_branch: "main" },
    ],
  });
  const http = Bun.serve({ port, fetch: emu.app.fetch });
  const emulatorBase = `http://127.0.0.1:${port}`;

  const driver = new FakeDriver();
  const deliveries: Fixture["deliveries"] = [];

  // Env contract (issue #67): runtime knobs are SETTINGS, not env vars —
  // the fixture seeds the org settings blob (DB wins over config/org.yml),
  // and the PAT stays a FILE (only the file path is env). Save prior env
  // values so tests stay isolated.
  const saved = {
    tokenFile: process.env.EXECUTOR_GIT_TOKEN_FILE,
  };
  store.setOrgSettings({
    workspaces_dir: join(dir, "workspaces"),
    git_base_url: `file://${join(dir, "bare")}`,
    api_base_url: emulatorBase,
    repos: ["acme/sandbox", "acme/tooling"],
  });
  process.env.EXECUTOR_GIT_TOKEN_FILE = tokenFile;

  const fixture: Fixture = {
    dir,
    store,
    spaceId: "slack:C1",
    bareRepo,
    toolingBareRepo,
    emulatorBase,
    pat: PAT,
    tokenFile,
    askpassScript: join(dir, "secrets", "git-askpass.sh"),
    orgConfigDir,
    transcriptsDir: join(dir, "transcripts"),
    workspacesDir: join(dir, "workspaces"),
    driver,
    deliveries,
    approvals: approval,
    cleanup() {
      http.stop(true);
      store.close();
      process.env.EXECUTOR_GIT_TOKEN_FILE = saved.tokenFile;
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return fixture;
}

function makeDeps(fx: Fixture, overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    store: fx.store,
    sandboxRunner: inProcessSandboxRunner(),
    memoryProvider: resolveMemoryProvider(fx.store.getOrgSettings(), fx.store.getDb()),
    driver: fx.driver,
    orgConfigDir: fx.orgConfigDir,
    transcriptDir: fx.transcriptsDir,
    pollIntervalMs: 10,
    onDelivery: async (item, delivery) => {
      fx.deliveries.push({ item, delivery });
      return fx.approvals;
    },
    ...overrides,
  };
}

function makeExtensionToolset(
  fx: Fixture,
  runtime: ExtensionRuntime = {
    execute: async () => ({ ok: true, content: [{ type: "text", text: "fixture tool completed" }] }),
  },
): ExtensionWorkerToolset {
  const audit = createAudit(fx.store);
  const registry = createFixtureRegistry();
  return {
    memoryTools: memoryToolDefinitions(
      resolveMemoryProvider(fx.store.getOrgSettings(), fx.store.getDb()),
      { audit },
    ),
    extensionTools: extensionToolDefinitions(registry.list(), {
      runtime,
      getCaller: () => "executor",
    }),
  };
}

function makeExtensionDeps(
  fx: Fixture,
  toolset: ExtensionWorkerToolset = makeExtensionToolset(fx),
): ExecutorDeps {
  return makeDeps(fx, {
    getExtensionWorkerToolset: () => toolset,
    extensionSessionTimeoutMs: 1_000,
  });
}

async function executeExtensionTool(tool: ToolDefinition, params: { city: string }, spaceId: string): Promise<void> {
  const result = await tool.execute(
    "test-call",
    // SAFETY: the fixture tool's zod schema accepts exactly { city: string }; the
    // generic ToolDefinition params type is wider than the concrete fixture schema.
    params as never,
    new AbortController().signal,
    () => {},
    // SAFETY: the fixture tool reads only ctx.sessionManager.getSessionFile(); the
    // rest of ExtensionContext is never touched by the extension's execute.
    {
      sessionManager: {
        getSessionFile: () => join("/tmp", `${spaceId}.jsonl`),
      },
    } as never,
  );
  if (result.isError) {
    const message = result.content
      .filter((block): block is Extract<(typeof result.content)[number], { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    throw new Error(message || "extension tool failed");
  }
}

/** Runs the executor loop and aborts it once the item settles. */
async function runUntil(fx: Fixture, itemId: string, state: WorkItemState, deps: ExecutorDeps): Promise<WorkItem> {
  const ac = new AbortController();
  const run = runExecutor(deps, ac.signal);
  try {
    return await waitForState(fx.store, itemId, state);
  } finally {
    ac.abort();
    await run;
  }
}

/** Test-only retry reset: production retry re-dispatches the same durable item id. */
function resetBlockedItemForRetry(fx: Fixture, itemId: string, repo?: string): void {
  fx.store
    .getDb()
    .run(
      "UPDATE work_items SET state = 'open', repo = COALESCE(?, repo), approvals = '[]', evidence = '[]', result = NULL, updated_at = ? WHERE id = ?",
      [repo ?? null, Date.now(), itemId],
    );
  fx.store
    .getDb()
    .run(
      "UPDATE worker_jobs SET status = 'queued', attempts = 0, lease_until = NULL, updated_at = ? WHERE id = ?",
      [Date.now(), itemId],
    );
}

async function waitForState(store: Store, id: string, state: WorkItemState, timeoutMs = 10_000): Promise<WorkItem> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const item = await store.getWorkItem(id);
    if (item?.state === state) return item;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${id} to reach ${state} (last: ${item?.state})`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

/** Waits for a worker job to reach a bus status (epic #170). */
async function waitForJobStatus(store: Store, id: string, status: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await jobStatus(store, id)) === status) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for job ${id} to reach ${status} (last: ${await jobStatus(store, id)})`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

/** The worker_jobs.status column for a job (the envelope itself carries no bus status). */
function jobStatus(store: Store, id: string): Promise<string | null> {
  // SAFETY: SELECT status returns a row with exactly one string column.
  const row = store.getDb().query("SELECT status AS s FROM worker_jobs WHERE id = ?").get(id) as { s: string } | null;
  return Promise.resolve(row?.s ?? null);
}

/** Waits for an audit row whose payload names the job/item id (epic #170). */
async function waitForJobAudit(store: Store, eventType: string, id: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await store.listAudit({ event_type: eventType });
    if (rows.some((row) => markerPayloadSchema.parse(JSON.parse(row.payload)).id === id)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${eventType} of ${id}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

describe("claim loop", () => {
  test("delivers an item end to end: open → claimed → working → review → done with pr_url", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "add a health check endpoint",
        repo: "acme/sandbox",
        delivery: "git",
      });

      const done = await runUntil(fx, item.id, "done", makeDeps(fx));

      // Result: pr_url + summary, approvals recorded, evidence written.
      const result = prResultSchema.parse(JSON.parse(done.result!));
      expect(result.pr_url).toContain(`/acme/sandbox/pull/1`);
      expect(result.summary).toBe("implemented the requested change");
      expect(JSON.parse(done.approvals)).toEqual([{ approver: "U_HUMAN", at: expect.any(Number) }]);
      const evidence = z.array(urlEvidenceSchema).parse(JSON.parse(done.evidence));
      expect(evidence).toHaveLength(1);
      expect(evidence[0].url).toContain(result.pr_url);

      // Every transition was performed by the executor and audited.
      const transitions = await fx.store.listAudit({ event_type: WORK_ITEM_TRANSITION_EVENT });
      expect(transitions.map((t) => JSON.parse(t.payload))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "claimed", to: "working", by: "executor" }),
          expect.objectContaining({ from: "working", to: "review", by: "executor" }),
          expect.objectContaining({ from: "review", to: "done", by: "executor" }),
        ]),
      );

      // The delivery seam saw the PR; a delivery_pending marker was audited.
      expect(fx.deliveries).toHaveLength(1);
      expect(fx.deliveries[0].delivery.prUrl).toBe(result.pr_url);
      const pending = await fx.store.listAudit({ event_type: DELIVERY_PENDING_EVENT });
      expect(pending).toHaveLength(1);
      expect(JSON.parse(pending[0].payload)).toMatchObject({ id: item.id, pr_url: result.pr_url });

      // GitHub API: PR exists with bottega/<id> head against main, created by
      // the user the PAT from the FILE resolves to (proves Bearer auth).
      const pr = await fetch(`${fx.emulatorBase}/repos/acme/sandbox/pulls/1`, {
        headers: { Authorization: `Bearer ${fx.pat}` },
      })
        .then((r) => r.json())
        .then((body) => emulatorPrSchema.parse(body));
      expect(pr.head.ref).toBe(`bottega/${item.id}`);
      expect(pr.base.ref).toBe("main");
      expect(pr.user.login).toBe("bottega-bot");

      // Git delivery: the branch was pushed to the remote.
      const refs = runGit(["--git-dir", fx.bareRepo, "for-each-ref", "--format=%(refname:short)"]);
      expect(refs).toContain(`bottega/${item.id}`);

      // Session ran in the item's workspace with the work allowlist.
      expect(fx.driver.sessions).toHaveLength(1);
      const session = fx.driver.sessions[0];
      expect(session.opts.spaceId).toBe(item.id);
      expect(session.opts.cwd).toBe(join(fx.workspacesDir, item.id));
      expect(session.opts.transcriptDir).toBe(fx.transcriptsDir);
      expect(session.opts.allowTools).toEqual([...EXECUTOR_TOOLS]);
      expect(session.prompts[0]).toContain(item.description);
      // Success cleanup: the workspace is removed, the transcript stays.
      expect(existsSync(join(fx.workspacesDir, item.id))).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("session failure blocks the item with evidence and keeps the workspace for forensics", async () => {
    const fx = makeFixture();
    try {
      fx.driver.failure = new Error("agent crashed: exit code 42");
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "do the thing",
        repo: "acme/sandbox",
      });

      const blocked = await runUntil(fx, item.id, "blocked", makeDeps(fx));

      const evidence = z.array(urlEvidenceSchema).parse(JSON.parse(blocked.evidence));
      expect(evidence).toHaveLength(1);
      expect(evidence[0].kind).toBe("note");
      expect(evidence[0].url).toContain("exit code 42");
      expect(fx.deliveries).toHaveLength(0);
      // Forensics: the workspace is kept, no PR was opened.
      expect(existsSync(join(fx.workspacesDir, item.id))).toBe(true);
      const pulls = await fetch(`${fx.emulatorBase}/repos/acme/sandbox/pulls`, {
        headers: { Authorization: `Bearer ${fx.pat}` },
      }).then((r) => r.json()).then((body) => z.array(z.unknown()).parse(body));
      expect(pulls).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("an unmarked item directory blocks before git and preserves its sentinel", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1-unmarked" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "do not delete foreign data",
        repo: "acme/sandbox",
      });
      const workspace = join(fx.workspacesDir, item.id);
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "sentinel"), "foreign");

      const blocked = await runUntil(fx, item.id, "blocked", makeDeps(fx));

      expect(readFileSync(join(workspace, "sentinel"), "utf8")).toBe("foreign");
      expect(fx.driver.sessions).toHaveLength(0);
      const evidence = z.array(urlEvidenceSchema).parse(JSON.parse(blocked.evidence));
      expect(evidence[0].url).toContain(workspace);
      expect(evidence[0].url).toMatch(/marker.*missing/i);
      expect(evidence[0].url).not.toContain(PAT);
    } finally {
      fx.cleanup();
    }
  });

  test("a marker-matched retry replaces the retained workspace for the same item and repository", async () => {
    const fx = makeFixture();
    try {
      fx.driver.failure = new Error(`agent failed with ${PAT}`);
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1-retry" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "retry safely",
        repo: "acme/sandbox",
      });

      const first = await runUntil(fx, item.id, "blocked", makeDeps(fx));
      const workspace = join(fx.workspacesDir, item.id);
      const markerPath = join(workspace, ".git", WORKSPACE_MARKER_FILE);
      expect(existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      expect(marker).toMatchObject({
        workItemId: item.id,
        repository: "acme/sandbox",
        creationId: expect.any(String),
      });
      expect(JSON.stringify(marker)).not.toContain(PAT);
      expect(first.evidence).not.toContain(PAT);
      expect(first.evidence).toContain("[REDACTED]");
      writeFileSync(join(workspace, "old-sentinel"), "replace me");

      resetBlockedItemForRetry(fx, item.id);
      fx.driver.failure = null;
      const done = await runUntil(fx, item.id, "done", makeDeps(fx));

      expect(done.state).toBe("done");
      expect(existsSync(workspace)).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("a retry with a different repository blocks and leaves the retained workspace untouched", async () => {
    const fx = makeFixture();
    try {
      fx.driver.failure = new Error("first attempt failed");
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1-mismatch" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "do not cross repositories",
        repo: "acme/sandbox",
      });
      await runUntil(fx, item.id, "blocked", makeDeps(fx));
      const workspace = join(fx.workspacesDir, item.id);
      writeFileSync(join(workspace, "sentinel"), "keep");

      resetBlockedItemForRetry(fx, item.id, "acme/tooling");
      fx.driver.failure = null;
      const blocked = await runUntil(fx, item.id, "blocked", makeDeps(fx));

      expect(readFileSync(join(workspace, "sentinel"), "utf8")).toBe("keep");
      expect(fx.driver.sessions).toHaveLength(1);
      const evidence = z.array(urlEvidenceSchema).parse(JSON.parse(blocked.evidence));
      expect(evidence[0].url).toContain(workspace);
      expect(evidence[0].url).toMatch(/repository.*does not match/i);
    } finally {
      fx.cleanup();
    }
  });

  test("a symlinked item workspace blocks and never touches the symlink target", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1-symlink" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "reject linked workspaces",
        repo: "acme/sandbox",
      });
      const outside = join(fx.dir, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "sentinel"), "keep");
      mkdirSync(fx.workspacesDir, { recursive: true });
      symlinkSync(outside, join(fx.workspacesDir, item.id));

      const blocked = await runUntil(fx, item.id, "blocked", makeDeps(fx));

      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("keep");
      expect(fx.driver.sessions).toHaveLength(0);
      const evidence = z.array(urlEvidenceSchema).parse(JSON.parse(blocked.evidence));
      expect(evidence[0].url).toMatch(/symbolic link/i);
    } finally {
      fx.cleanup();
    }
  });

  test("an escaped database item id blocks before git and leaves the outside path untouched", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1-escape" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "reject path escape",
        repo: "acme/sandbox",
      });
      const escapedId = "../outside-workspace";
      fx.store
        .getDb()
        .run("UPDATE worker_jobs SET id = ?, payload = ? WHERE id = ?", [
          escapedId,
          JSON.stringify({ workItemId: escapedId }),
          item.id,
        ]);
      fx.store.getDb().run("UPDATE work_items SET id = ? WHERE id = ?", [escapedId, item.id]);
      const outside = join(fx.workspacesDir, escapedId);
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "sentinel"), "keep");

      const blocked = await runUntil(fx, escapedId, "blocked", makeDeps(fx));

      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("keep");
      expect(fx.driver.sessions).toHaveLength(0);
      const evidence = z.array(urlEvidenceSchema).parse(JSON.parse(blocked.evidence));
      expect(evidence[0].url).toMatch(/direct child/i);
    } finally {
      fx.cleanup();
    }
  });

  test("success cleanup with a mismatched marker blocks instead of reporting done or deleting", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1-cleanup-authority" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "verify before cleanup",
        repo: "acme/sandbox",
      });
      const workspace = join(fx.workspacesDir, item.id);
      const deps = makeDeps(fx, {
        onDelivery: async () => {
          const markerPath = join(workspace, ".git", WORKSPACE_MARKER_FILE);
          const marker = JSON.parse(readFileSync(markerPath, "utf8"));
          writeFileSync(markerPath, JSON.stringify({ ...marker, repository: "acme/tooling" }));
          writeFileSync(join(workspace, "sentinel"), "keep");
          return { approver: "U_HUMAN" };
        },
      });

      const blocked = await runUntil(fx, item.id, "blocked", deps);

      expect(readFileSync(join(workspace, "sentinel"), "utf8")).toBe("keep");
      expect(blocked.state).toBe("blocked");
      expect(blocked.result).toBeNull();
      const evidence = z.array(urlEvidenceSchema).parse(JSON.parse(blocked.evidence));
      expect(evidence[0].url).toMatch(/marker repository.*does not match/i);
    } finally {
      fx.cleanup();
    }
  });

  test("denied delivery approval blocks the item (PR stays open on the remote)", async () => {
    const fx = makeFixture(null);
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "ship it",
        repo: "acme/sandbox",
      });

      const blocked = await runUntil(fx, item.id, "blocked", makeDeps(fx));

      expect(fx.deliveries).toHaveLength(1);
      expect(JSON.parse(blocked.evidence)[0].url).toContain("approval denied");
      expect(JSON.parse(blocked.approvals)).toEqual([]);
      expect(existsSync(join(fx.workspacesDir, item.id, ".git", WORKSPACE_MARKER_FILE))).toBe(true);
      // The PR itself was still opened before the approval request.
      const pulls = await fetch(`${fx.emulatorBase}/repos/acme/sandbox/pulls`, {
        headers: { Authorization: `Bearer ${fx.pat}` },
      })
        .then((r) => r.json())
        .then((body) => z.array(z.object({ number: z.number() })).parse(body));
      expect(pulls).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  test("boot recovery blocks items stuck in claimed/working (crash hygiene)", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({ space_id: space.id, requester: "U1", description: "stale run" });
      await fx.store.claimWorkItemById(item.id);
      await fx.store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
      // Age the row 31 minutes so boot recovery sees it as stale (the store
      // is a plain SQLite file; WAL allows a second connection).
      const db = new Database(join(fx.dir, "store.db"));
      try {
        db.run("UPDATE work_items SET updated_at = ? WHERE id = ?", [Date.now() - 31 * 60_000, item.id]);
      } finally {
        db.close();
      }

      const blocked = await runUntil(fx, item.id, "blocked", makeDeps(fx));

      const evidence = z.array(textEvidenceSchema).parse(JSON.parse(blocked.evidence));
      expect(evidence[0].text).toBe("interrupted by restart");
      expect(fx.driver.sessions).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("honors item.repo: the conversation-derived repo drives clone, branch, and PR", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "tune the tooling script",
        repo: "acme/tooling",
      });

      const done = await runUntil(fx, item.id, "done", makeDeps(fx));

      // The PR went to the item's repo, not the first allowlisted one.
      const result = prUrlSchema.parse(JSON.parse(done.result!));
      expect(result.pr_url).toContain(`/acme/tooling/pull/1`);
      // The branch landed on the tooling remote and nowhere near sandbox.
      const toolingRefs = runGit(["--git-dir", fx.toolingBareRepo, "for-each-ref", "--format=%(refname:short)"]);
      expect(toolingRefs).toContain(`bottega/${item.id}`);
      const sandboxRefs = runGit(["--git-dir", fx.bareRepo, "for-each-ref", "--format=%(refname:short)"]);
      expect(sandboxRefs).not.toContain(`bottega/${item.id}`);
    } finally {
      fx.cleanup();
    }
  });

  test("an item without a repo blocks with 'repo not specified' evidence (fail closed)", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "fix the flaky checkout",
      });

      const blocked = await runUntil(fx, item.id, "blocked", makeDeps(fx));

      const evidence = z.array(urlEvidenceSchema).parse(JSON.parse(blocked.evidence));
      expect(evidence).toHaveLength(1);
      expect(evidence[0].url).toBe("repo not specified — ask the requester");
      // The gate fires before any git work: no session, no workspace, no delivery.
      expect(fx.driver.sessions).toHaveLength(0);
      expect(existsSync(join(fx.workspacesDir, item.id))).toBe(false);
      expect(fx.deliveries).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("a repo outside the allowlist blocks with evidence naming the violation", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "ship it",
        repo: "evil/corp",
      });

      const blocked = await runUntil(fx, item.id, "blocked", makeDeps(fx));

      const evidence = z.array(urlEvidenceSchema).parse(JSON.parse(blocked.evidence));
      expect(evidence[0].url).toContain('"evil/corp"');
      expect(evidence[0].url).toContain("allowlist");
      expect(fx.driver.sessions).toHaveLength(0);
      expect(fx.deliveries).toHaveLength(0);
      // No PR was opened anywhere.
      const pulls = await fetch(`${fx.emulatorBase}/repos/acme/sandbox/pulls`, {
        headers: { Authorization: `Bearer ${fx.pat}` },
      }).then((r) => r.json()).then((body) => z.array(z.unknown()).parse(body));
      expect(pulls).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("an empty allowlist boots fine and blocks every item until repos are configured", async () => {
    const fx = makeFixture();
    try {
      // Settings repos=[] is a legal allowlist (empty → no pushes); the
      // file's repos would only apply when the blob has no repos key.
      fx.store.setOrgSettings({
        workspaces_dir: join(fx.dir, "workspaces"),
        api_base_url: fx.emulatorBase,
        repos: [],
      });
      writeFileSync(join(fx.orgConfigDir, "org.yml"), `git_base_url: "file://${join(fx.dir, "bare")}"\n`);
      const cfg = await prepareExecutor(makeDeps(fx));
      expect(cfg.repoAllowlist).toEqual([]);

      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "do the thing",
        repo: "acme/sandbox",
      });

      const blocked = await runUntil(fx, item.id, "blocked", makeDeps(fx));

      const evidence = z.array(urlEvidenceSchema).parse(JSON.parse(blocked.evidence));
      expect(evidence[0].url).toContain("allowlist");
      expect(fx.driver.sessions).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });
});


describe("work-item task-level skills (issues #234/#235)", () => {
  test("injects explicitly pinned skills into the git item session", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "review the diff and land it",
        repo: "acme/sandbox",
        skills: ["pr_review"],
      });

      await runUntil(fx, item.id, "done", makeDeps(fx));

      const session = fx.driver.sessions[0];
      expect(session.opts.skills?.map((s) => s.name)).toEqual(["pr_review"]);
      // The injected skill resolves `skill://pr_review` against its own dir.
      expect(session.opts.skills![0].baseDir).toContain("pr_review");
    } finally {
      fx.cleanup();
    }
  });

  test("git-delivery items inject the pr_review builtin by default", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "ship the change",
        repo: "acme/sandbox",
      });

      await runUntil(fx, item.id, "done", makeDeps(fx));

      const session = fx.driver.sessions[0];
      expect(session.opts.skills?.map((s) => s.name)).toEqual(["pr_review"]);
    } finally {
      fx.cleanup();
    }
  });

  test("extension-delivery items carry no skills (documented v1 behavior)", async () => {
    const fx = makeFixture();
    try {
      fx.driver.messageText =
        'Task complete.\n{"url":"https://linear.example/issue/OPS-42","summary":"Created the operations ticket"}';
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "create a Linear ticket",
        delivery: "extension",
      });

      await runUntil(fx, item.id, "done", makeExtensionDeps(fx));

      const session = fx.driver.sessions[0];
      expect(session.opts.skills?.length ?? 0).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  test("a corrupt skills cell falls back to the kind default (fail closed)", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "review the diff",
        repo: "acme/sandbox",
      });
      // Poison the cell below the store API, as a legacy or manual row would.
      const db = new Database(join(fx.dir, "store.db"));
      try {
        db.run("UPDATE work_items SET skills = ? WHERE id = ?", ["not-json", item.id]);
      } finally {
        db.close();
      }

      await runUntil(fx, item.id, "done", makeDeps(fx));

      // The parse failed → the git default (`pr_review`) applies, never a crash.
      const session = fx.driver.sessions[0];
      expect(session.opts.skills?.map((s) => s.name)).toEqual(["pr_review"]);
    } finally {
      fx.cleanup();
    }
  });

  test("a pinned unknown skill is skipped without failing the job", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "review the diff",
        repo: "acme/sandbox",
        skills: ["pr_review", "no_such_skill_xyz"],
      });

      await runUntil(fx, item.id, "done", makeDeps(fx));

      const session = fx.driver.sessions[0];
      expect(session.opts.skills?.map((s) => s.name)).toEqual(["pr_review"]);
    } finally {
      fx.cleanup();
    }
  });

  test("a space-authored skill shadows the same-named builtin", async () => {
    const fx = makeFixture();
    const root = join(fx.dir, "skills-root");
    const prev = process.env.BOTTEGA_SKILLS_DIR;
    try {
      process.env.BOTTEGA_SKILLS_DIR = root;
      mkdirSync(join(root, "slack:C1", "pr_review"), { recursive: true });
      writeFileSync(
        join(root, "slack:C1", "pr_review", "SKILL.md"),
        "---\nname: pr_review\ndescription: the space's own review loop\n---\nDo the space review.\n",
      );
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "review the diff",
        repo: "acme/sandbox",
      });

      await runUntil(fx, item.id, "done", makeDeps(fx));

      const session = fx.driver.sessions[0];
      expect(session.opts.skills).toHaveLength(1);
      expect(session.opts.skills![0].name).toBe("pr_review");
      expect(session.opts.skills![0].source).toBe("space:slack:C1");
    } finally {
      if (prev === undefined) delete process.env.BOTTEGA_SKILLS_DIR;
      else process.env.BOTTEGA_SKILLS_DIR = prev;
      fx.cleanup();
    }
  });
});

describe("delivery routing (issue #129)", () => {
  test("extension delivery completes without git and audits the external object", async () => {
    const fx = makeFixture();
    try {
      fx.driver.messageText =
        'Task complete.\n{"url":"https://linear.example/issue/OPS-42","summary":"Created the operations ticket"}';
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "create a Linear ticket for the outage follow-up",
        delivery: "extension",
      });

      const done = await runUntil(fx, item.id, "done", makeExtensionDeps(fx));

      expect(JSON.parse(done.result!)).toEqual({
        url: "https://linear.example/issue/OPS-42",
        summary: "Created the operations ticket",
      });
      expect(fx.deliveries).toHaveLength(0);
      expect(existsSync(join(fx.workspacesDir, item.id))).toBe(false);

      const transitions = await fx.store.listAudit({ event_type: WORK_ITEM_TRANSITION_EVENT });
      expect(transitions.map((row) => JSON.parse(row.payload))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "claimed", to: "working", by: "executor" }),
          expect.objectContaining({ from: "working", to: "done", by: "executor" }),
        ]),
      );
      const completed = await fx.store.listAudit({ event_type: DELIVERY_COMPLETED_EVENT });
      expect(completed).toHaveLength(1);
      expect(JSON.parse(completed[0].payload)).toEqual({
        id: item.id,
        kind: "extension",
        url: "https://linear.example/issue/OPS-42",
        summary: "Created the operations ticket",
      });

      expect(fx.driver.sessions).toHaveLength(1);
      const session = fx.driver.sessions[0];
      expect(session.opts.spaceId).toBe(space.id);
      expect(session.opts.transcriptDir).toBe(join(fx.transcriptsDir, item.id));
      expect(session.opts.allowTools).toEqual([
        "memory.save",
        "memory.search",
        "memory.forget",
        FIXTURE_EXTENSION_TOOL,
      ]);
      expect(session.prompts[0]).toContain(`work item ${item.id}`);
      expect(session.prompts[0]).toContain(`space ${space.id}`);
      expect(session.prompts[0]).toContain(item.description);
      expect(session.prompts[0]).toContain('{"url": "<external object URL or empty string>", "summary": "<deliverable summary>"}');
    } finally {
      fx.cleanup();
    }
  });

  test("an extension envelope without a URL blocks under the delivery model", async () => {
    const fx = makeFixture();
    try {
      fx.driver.messageText = '{"summary":"Updated the external record"}';
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "update the customer record",
        delivery: "extension",
      });

      const blocked = await runUntil(fx, item.id, "blocked", makeExtensionDeps(fx));

      expect(JSON.parse(blocked.evidence)[0].url).toContain("result.url");
      expect(await fx.store.listAudit({ event_type: DELIVERY_COMPLETED_EVENT })).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("a missing JSON envelope blocks with non-empty evidence", async () => {
    const fx = makeFixture();
    try {
      fx.driver.messageText = "finished the external task but forgot the result envelope";
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "create the external object",
        delivery: "extension",
      });

      const blocked = await runUntil(fx, item.id, "blocked", makeExtensionDeps(fx));

      expect(JSON.parse(blocked.evidence)[0].url).toMatch(/JSON envelope/);
      expect(blocked.result).toBeNull();
      expect(await fx.store.listAudit({ event_type: DELIVERY_COMPLETED_EVENT })).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("an extension session throw blocks with evidence", async () => {
    const fx = makeFixture();
    try {
      fx.driver.failure = new Error("extension worker transport crashed");
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "update the external object",
        delivery: "extension",
      });

      const blocked = await runUntil(fx, item.id, "blocked", makeExtensionDeps(fx));

      expect(JSON.parse(blocked.evidence)[0].url).toContain("transport crashed");
      expect(await fx.store.listAudit({ event_type: DELIVERY_COMPLETED_EVENT })).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("an emitted extension session error blocks with evidence", async () => {
    const fx = makeFixture();
    try {
      fx.driver.messageText = '{"url":"https://attio.example/records/1","summary":"Updated the contact"}';
      fx.driver.emittedError = "model stream failed after output";
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "update the Attio contact",
        delivery: "extension",
      });

      const blocked = await runUntil(fx, item.id, "blocked", makeExtensionDeps(fx));

      expect(JSON.parse(blocked.evidence)[0].url).toContain("model stream failed");
      expect(await fx.store.listAudit({ event_type: DELIVERY_COMPLETED_EVENT })).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("chat items are never claimed by the worker — they stay open for the space agent (epic #170)", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "reply in the current conversation",
        delivery: "chat",
      });
      // Chat has no worker job: no envelope row is ever enqueued.
      expect(await fx.store.getJob(item.id)).toBeNull();

      const ac = new AbortController();
      const run = runExecutor(makeDeps(fx), ac.signal);
      // Give the claim loop enough polls to act on anything claimable.
      await Bun.sleep(300);
      ac.abort();
      await run;

      expect((await fx.store.getWorkItem(item.id))?.state).toBe("open");
      expect(fx.driver.sessions).toHaveLength(0);
      // The worker never touched the item: no transition audits at all.
      const transitions = await fx.store.listAudit({ event_type: WORK_ITEM_TRANSITION_EVENT });
      expect(transitions).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("an older chat item does not block a newer extension delivery", async () => {
    const fx = makeFixture();
    try {
      fx.driver.messageText =
        '{"url":"https://linear.example/issue/OPS-43","summary":"Created the queued ticket"}';
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const chat = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "reply later in chat",
        delivery: "chat",
      });
      const extension = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "create the queued external ticket",
        delivery: "extension",
      });

      const done = await runUntil(fx, extension.id, "done", makeExtensionDeps(fx));

      expect(JSON.parse(done.result!)).toMatchObject({ url: "https://linear.example/issue/OPS-43" });
      expect((await fx.store.getWorkItem(chat.id))?.state).toBe("open");
    } finally {
      fx.cleanup();
    }
  });

  test("an unknown extension call blocks and audits the runtime error", async () => {
    const fx = makeFixture();
    try {
      const audit = createAudit(fx.store);
      const runtime = createExtensionRuntime({
        registry: createExtensionRegistry(),
        store: fx.store,
        audit,
        orgPolicy: defaultPolicy(),
        router: DenyRouter,
      });
      const toolset = makeExtensionToolset(fx, runtime);
      fx.driver.onPrompt = () =>
        executeExtensionTool(toolset.extensionTools[0], { city: "Istanbul" }, fx.spaceId);
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "call an unknown extension",
        delivery: "extension",
      });

      const blocked = await runUntil(fx, item.id, "blocked", makeExtensionDeps(fx, toolset));

      expect(JSON.parse(blocked.evidence)[0].url).toContain("not registered");
      const calls = await fx.store.listAudit({ event_type: EXTENSION_CALL_EVENT });
      expect(calls.map((row) => JSON.parse(row.payload))).toContainEqual({
        extension: FIXTURE_EXTENSION_ID,
        tool: FIXTURE_EXTENSION_TOOL,
        actor: "executor",
        credential_id: null,
        decision: "error",
        call_id: null,
      });
    } finally {
      fx.cleanup();
    }
  });

  test("a denied extension call blocks and audits the denial", async () => {
    const fx = makeFixture();
    try {
      const audit = createAudit(fx.store);
      const registry = createFixtureRegistry();
      const runtime = createExtensionRuntime({
        registry,
        store: fx.store,
        audit,
        orgPolicy: { ...defaultPolicy(), extensionsDeny: [FIXTURE_EXTENSION_ID] },
        router: DenyRouter,
      });
      const toolset = makeExtensionToolset(fx, runtime);
      fx.driver.onPrompt = () =>
        executeExtensionTool(toolset.extensionTools[0], { city: "Istanbul" }, fx.spaceId);
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "call a denied extension",
        delivery: "extension",
      });

      const blocked = await runUntil(fx, item.id, "blocked", makeExtensionDeps(fx, toolset));

      expect(JSON.parse(blocked.evidence)[0].url).toContain("denied");
      const calls = await fx.store.listAudit({ event_type: EXTENSION_CALL_EVENT });
      expect(calls.map((row) => JSON.parse(row.payload))).toContainEqual({
        extension: FIXTURE_EXTENSION_ID,
        tool: FIXTURE_EXTENSION_TOOL,
        actor: "executor",
        credential_id: null,
        decision: "deny",
        call_id: null,
      });
    } finally {
      fx.cleanup();
    }
  });
});

describe("per-task model pin (issue #185)", () => {
  test("the execution session runs on the pinned model + effort (pin beats space settings)", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "PIN1" });
      // The space prefers a slow model at high effort; the pin must win.
      await fx.store.updateSpaceSettings(space.id, { model: "glm-5.1", reasoning_effort: "high" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "pinned work",
        repo: "acme/sandbox",
        model: "deepseek-v4-flash",
        reasoning_effort: "low",
      });

      await runUntil(fx, item.id, "done", makeDeps(fx));

      // The session resolved the pin via the "default" role against
      // settings merged with the pin (task pin > space settings).
      const session = fx.driver.sessions[0]!;
      expect(session.setModelRoleCalls).toEqual([
        { role: "default", settings: { model: "deepseek-v4-flash", reasoning_effort: "low" } },
      ]);

      // The application was audited with the resolved model + effort.
      const pinAudits = await fx.store.listAudit({ event_type: WORK_ITEM_PIN_APPLIED_EVENT });
      expect(pinAudits).toHaveLength(1);
      expect(JSON.parse(pinAudits[0]!.payload)).toEqual({
        id: item.id,
        role: "default",
        model: "deepseek-v4-flash",
        thinking_level: "low",
        applied: true,
        by: "executor",
      });
    } finally {
      fx.cleanup();
    }
  });

  test("a role-ref pin switches that slot through the space's settings", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "PIN2" });
      await fx.store.updateSpaceSettings(space.id, {
        model: "glm-5.1",
        fast_model: "flash-lite",
        reasoning_effort: "high",
      });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "fast work",
        repo: "acme/sandbox",
        model: "fast",
      });

      await runUntil(fx, item.id, "done", makeDeps(fx));

      const session = fx.driver.sessions[0]!;
      expect(session.setModelRoleCalls).toEqual([
        {
          role: "fast",
          settings: { model: "glm-5.1", fast_model: "flash-lite", reasoning_effort: "high" },
        },
      ]);
      const pinAudits = await fx.store.listAudit({ event_type: WORK_ITEM_PIN_APPLIED_EVENT });
      expect(JSON.parse(pinAudits[0]!.payload)).toMatchObject({ id: item.id, role: "fast", by: "executor" });
    } finally {
      fx.cleanup();
    }
  });

  test("an effort-only pin applies the effort without a model switch", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "PIN3" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "high effort work",
        repo: "acme/sandbox",
        reasoning_effort: "high",
      });

      await runUntil(fx, item.id, "done", makeDeps(fx));

      const session = fx.driver.sessions[0]!;
      // No space model configured: the default role resolves to effort only.
      expect(session.setModelRoleCalls).toEqual([{ role: "default", settings: { reasoning_effort: "high" } }]);
    } finally {
      fx.cleanup();
    }
  });

  test("an unpinned item does not switch the model (no pin, no switch)", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "PIN4" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "plain work",
        repo: "acme/sandbox",
      });

      await runUntil(fx, item.id, "done", makeDeps(fx));

      expect(fx.driver.sessions[0]!.setModelRoleCalls).toEqual([]);
      expect(await fx.store.listAudit({ event_type: WORK_ITEM_PIN_APPLIED_EVENT })).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });
});

describe("org config parsing (issue #33)", () => {
  test("trailing comments and quoted repo entries parse to the correct allowlist and git base", async () => {
    const fx = makeFixture();
    try {
      // Settings without repos/git_base_url → config/org.yml is the
      // fallback source (DB wins only when the keys are set).
      fx.store.setOrgSettings({
        workspaces_dir: join(fx.dir, "workspaces"),
        api_base_url: fx.emulatorBase,
      });
      // Shapes the old line-scanner silently mis-parsed (the comment would
      // have been glued to the repo string, breaking the owner/repo match).
      writeFileSync(
        join(fx.orgConfigDir, "org.yml"),
        `# org repo config\ngit_base_url: "file://${join(fx.dir, "bare")}" # local bare repo\nrepos:\n  - "acme/sandbox" # v1 target\n`,
      );
      const cfg = await prepareExecutor(makeDeps(fx));
      expect(cfg.repoAllowlist).toEqual(["acme/sandbox"]);
      expect(cfg.gitBaseUrl).toBe(`file://${join(fx.dir, "bare")}`);
    } finally {
      fx.cleanup();
    }
  });

  test("an inline-sequence repos entry fails closed with a clear boot error", async () => {
    const fx = makeFixture();
    try {
      // Settings without repos/git_base_url → the file is the fallback
      // source and its malformed flow collection must still fail closed.
      fx.store.setOrgSettings({ workspaces_dir: join(fx.dir, "workspaces"), api_base_url: fx.emulatorBase });
      writeFileSync(join(fx.orgConfigDir, "org.yml"), `git_base_url: "file://${join(fx.dir, "bare")}"\nrepos: ["acme/sandbox"]\n`);
      await expect(prepareExecutor(makeDeps(fx))).rejects.toThrow(/config\/org\.yml: .*flow collections/);
    } finally {
      fx.cleanup();
    }
  });

  test("a malformed repos entry (non-string) fails closed", async () => {
    const fx = makeFixture();
    try {
      fx.store.setOrgSettings({ workspaces_dir: join(fx.dir, "workspaces"), api_base_url: fx.emulatorBase });
      writeFileSync(
        join(fx.orgConfigDir, "org.yml"),
        `git_base_url: "file://${join(fx.dir, "bare")}"\nrepos:\n  - acme/sandbox\n  - broken: entry\n`,
      );
      await expect(prepareExecutor(makeDeps(fx))).rejects.toThrow(/config\/org\.yml: .*owner\/repo strings/);
    } finally {
      fx.cleanup();
    }
  });

  test("settings covering repos + git base never consult the file (settings-only boot)", async () => {
    const fx = makeFixture();
    try {
      // The fixture seeds settings for repos + git_base_url + api_base_url,
      // so a broken org.yml is irrelevant — the DB is the source of truth.
      writeFileSync(join(fx.orgConfigDir, "org.yml"), "this: [is, not, valid, yaml: for: the: subset\n");
      const cfg = await prepareExecutor(makeDeps(fx));
      expect(cfg.repoAllowlist).toEqual(["acme/sandbox", "acme/tooling"]);
      expect(cfg.gitBaseUrl).toBe(`file://${join(fx.dir, "bare")}`);
      expect(cfg.apiBaseUrl).toBe(fx.emulatorBase);
    } finally {
      fx.cleanup();
    }
  });
});

describe("credential hygiene", () => {
  test("the PAT lives only in a 0600 file; the askpass script reads it; env carries no key", async () => {
    const fx = makeFixture();
    try {
      await prepareExecutor(makeDeps(fx));

      expect(statSync(fx.tokenFile).mode & 0o777).toBe(0o600);
      const script = readFileSync(fx.askpassScript, "utf8");
      expect(script).toContain('exec cat "${EXECUTOR_GIT_TOKEN_FILE}"');
      expect(statSync(fx.askpassScript).mode & 0o777).toBe(0o700);

      // Executor env dump: the token value appears nowhere.
      const leaked = Object.entries(process.env).filter(([, v]) => v !== undefined && v.includes(fx.pat));
      expect(leaked).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("a loose PAT file mode fails closed unless settings allow_loose_pat is set", async () => {
    const fx = makeFixture();
    try {
      chmodSync(fx.tokenFile, 0o644);
      await expect(prepareExecutor(makeDeps(fx))).rejects.toThrow(/must be mode 0600/);

      fx.store.setOrgSettings({
        workspaces_dir: join(fx.dir, "workspaces"),
        api_base_url: fx.emulatorBase,
        repos: ["acme/sandbox", "acme/tooling"],
        allow_loose_pat: true,
      });
      await expect(prepareExecutor(makeDeps(fx))).resolves.toMatchObject({ tokenFile: fx.tokenFile });
    } finally {
      fx.cleanup();
    }
  });
});

describe("per-job isolation guard (issues #101/#335)", () => {
  test("prepareExecutor refuses to boot without a sandbox runner", async () => {
    const fx = makeFixture();
    try {
      const { sandboxRunner: _omitted, ...deps } = makeDeps(fx);
      await expect(prepareExecutor(deps)).rejects.toThrow(/refuses to start without per-job isolation/);
    } finally {
      fx.cleanup();
    }
  });
});

describe("delivery approval round trip (issue #149)", () => {
  /** Server-side fakes: the poller's message surface + the resolver's rewrite surface. */
  function serverFakes() {
    const posted: Array<{ spaceId: string; text?: string; blocks?: unknown[] }> = [];
    const updated: Array<{ spaceId: string; ts: string; text?: string }> = [];
    return {
      posted,
      updated,
      adapter: {
        async postMessage(spaceId, text, opts) {
          posted.push({ spaceId, text, ...(opts?.blocks ? { blocks: opts.blocks } : undefined) });
          return "1.000001";
        },
        async updateMessage(spaceId, ts, text) {
          updated.push({ spaceId, ts, text });
        },
      },
    } satisfies {
      adapter: Pick<SlackAdapter, "postMessage" | "updateMessage">;
      posted: Array<{ spaceId: string; text?: string; blocks?: unknown[] }>;
      updated: Array<{ spaceId: string; ts: string; text?: string }>;
    };
  }

  function click(itemId: string, actionId: string): SlackAction {
    return { actionId, value: itemId, spaceId: "slack:C1", principal: "U_HUMAN", messageTs: "1.000001" };
  }

  /** Polls the audit trail for an event whose payload names the item. */
  async function waitForMarker(store: Store, itemId: string, eventType: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await store.listAudit({ event_type: eventType });
      if (rows.some((row) => markerPayloadSchema.parse(JSON.parse(row.payload)).id === itemId)) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${eventType} of ${itemId}`);
      await Bun.sleep(10);
    }
  }

  test("a git-delivered item reaches done via the Slack approval (poller post → click → onDelivery wait → review → done)", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "add a feature",
        repo: "acme/sandbox",
        delivery: "git",
      });

      // The executor container runs with NO injected hook — the default
      // onDelivery wait is the real production wiring (issue #149).
      const deps = makeDeps(fx, { onDelivery: undefined, deliveryPollIntervalMs: 10 });
      const ac = new AbortController();
      const run = runExecutor(deps, ac.signal);
      try {
        // The PR lands and the delivery_pending marker appears.
        await waitForMarker(fx.store, item.id, DELIVERY_PENDING_EVENT);

        // Server side: the poller posts the interactive prompt.
        const { adapter } = serverFakes();
        const posted = await pollPendingDeliveries(fx.store, adapter);
        expect(posted).toBe(1);

        // A human clicks Approve; the server records delivery.resolved.
        const handled = await resolveDeliveryAction(
          { store: fx.store, adapter },
          click(item.id, DELIVERY_APPROVE_ACTION_ID),
        );
        expect(handled).toBe(true);

        const done = await waitForState(fx.store, item.id, "done");
        const result = prResultSchema.parse(JSON.parse(done.result!));
        expect(result.pr_url).toContain(`/acme/sandbox/pull/1`);
        expect(JSON.parse(done.approvals)).toEqual([{ approver: "U_HUMAN", at: expect.any(Number) }]);

        // The documented path: working → review → done, by the executor.
        const transitions = await fx.store.listAudit({ event_type: WORK_ITEM_TRANSITION_EVENT });
        expect(transitions.map((row) => JSON.parse(row.payload))).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ from: "working", to: "review", by: "executor" }),
            expect.objectContaining({ from: "review", to: "done", by: "executor" }),
          ]),
        );

        // The whole decision is on the trail: announced → resolved.
        const requested = await fx.store.listAudit({ event_type: DELIVERY_REQUESTED_EVENT });
        expect(requested).toHaveLength(1);
        const resolved = await fx.store.listAudit({ event_type: DELIVERY_RESOLVED_EVENT });
        expect(resolved).toHaveLength(1);
        expect(JSON.parse(resolved[0].payload)).toEqual({ id: item.id, approved: true, approver: "U_HUMAN" });
      } finally {
        ac.abort();
        await run;
      }
    } finally {
      fx.cleanup();
    }
  });

  test("a denied delivery blocks the item with evidence (poller post → click deny → blocked)", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "add a feature",
        repo: "acme/sandbox",
        delivery: "git",
      });

      const deps = makeDeps(fx, { onDelivery: undefined, deliveryPollIntervalMs: 10 });
      const ac = new AbortController();
      const run = runExecutor(deps, ac.signal);
      try {
        await waitForMarker(fx.store, item.id, DELIVERY_PENDING_EVENT);

        const { adapter } = serverFakes();
        expect(await pollPendingDeliveries(fx.store, adapter)).toBe(1);

        const handled = await resolveDeliveryAction(
          { store: fx.store, adapter },
          click(item.id, DELIVERY_DENY_ACTION_ID),
        );
        expect(handled).toBe(true);

        const blocked = await waitForState(fx.store, item.id, "blocked");
        expect(JSON.parse(blocked.evidence)[0].url).toContain("approval denied");
        expect(JSON.parse(blocked.approvals)).toEqual([]);

        // The decision is recorded: denied, by the clicking human.
        const resolved = await fx.store.listAudit({ event_type: DELIVERY_RESOLVED_EVENT });
        expect(JSON.parse(resolved[0].payload)).toEqual({ id: item.id, approved: false, approver: "U_HUMAN" });
        // Deny never enters review/done.
        const transitions = await fx.store.listAudit({ event_type: WORK_ITEM_TRANSITION_EVENT });
        expect(transitions.map((row) => JSON.parse(row.payload))).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ from: "working", to: "review", by: "executor" }),
            expect.objectContaining({ from: "review", to: "done", by: "executor" }),
          ]),
        );
      } finally {
        ac.abort();
        await run;
      }
    } finally {
      fx.cleanup();
    }
  });

  test("headless fallback: no server resolution times out and denies (item would land in blocked)", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "add a feature",
        repo: "acme/sandbox",
        delivery: "git",
      });

      const start = Date.now();
      const approval = await waitForDeliveryApproval(
        fx.store,
        item,
        { prUrl: "https://github.com/acme/sandbox/pull/1", summary: "implemented it" },
        { timeoutMs: 60, pollIntervalMs: 5 },
      );

      expect(approval).toBeNull(); // deny → the executor blocks the item
      expect(Date.now() - start).toBeGreaterThanOrEqual(60);
    } finally {
      fx.cleanup();
    }
  });
});

describe("worker job envelope (epic #170)", () => {
  test("a git item rides the envelope end to end: enqueue → claim → run → outbox → post with one id", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "add a health check endpoint",
        repo: "acme/sandbox",
        delivery: "git",
      });
      // createWorkItem enqueued the job with the SAME id as the work item.
      expect(await fx.store.getJob(item.id)).toMatchObject({ id: item.id, kind: "git", attempts: 0 });
      expect(await jobStatus(fx.store, item.id)).toBe("queued");

      await runUntil(fx, item.id, "done", makeDeps(fx));
      await waitForJobStatus(fx.store, item.id, "completed");

      // The executor's claim stamped its identity as the assignee (issue #159).
      expect((await fx.store.getWorkItem(item.id))?.assignee).toBe("executor");

      // Claim + completion are both on the audit trail, keyed by the envelope id.
      const claimed = await fx.store.listAudit({ event_type: JOB_CLAIMED_EVENT });
      expect(claimed.map((row) => JSON.parse(row.payload))).toContainEqual(
        expect.objectContaining({ id: item.id, kind: "git", attempts: 1 }),
      );
      const completed = await fx.store.listAudit({ event_type: JOB_COMPLETED_EVENT });
      expect(completed.map((row) => JSON.parse(row.payload))).toContainEqual(
        expect.objectContaining({ id: item.id, kind: "git", state: "done" }),
      );

      // The outbox row is the worker→server signal: consumable, watermarked,
      // keyed by the same id, carrying the delivery result. The review
      // landing also wrote its one-line notification row (issue #159).
      const { rows, watermark } = consumeOutboxWatermarked(fx.store);
      expect(rows.map((r) => r.kind).sort()).toEqual(["git", "work_item"]);
      const completion = rows.find((r) => r.kind === "git")!;
      expect(completion).toMatchObject({ id: item.id, kind: "git", space: space.id });
      // SAFETY: the completion outbox payload is the executor's own JSON
      // serialization of the git delivery result (state + pr_url/summary).
      const payload = JSON.parse(completion.payload) as { state: string; result: { pr_url: string; summary: string } };
      expect(payload.state).toBe("done");
      expect(payload.result.pr_url).toContain("/acme/sandbox/pull/1");
      expect(payload.result.summary).toBe("implemented the requested change");
      const reviewNotify = rows.find((r) => r.kind === "work_item")!;
      expect(reviewNotify.id).toBe(`${item.id}:review`);
      expect(JSON.parse(reviewNotify.payload)).toMatchObject({ state: "review", workItemId: item.id });
      // Consumed rows are never re-read: the watermark advanced past the row.
      expect(consumeOutboxWatermarked(fx.store, { watermark })).toEqual({ rows: [], watermark });
    } finally {
      fx.cleanup();
    }
  });

  test("a git item completes THROUGH the per-job sandbox runner (issue #101)", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "add a health check endpoint",
        repo: "acme/sandbox",
        delivery: "git",
      });

      await runUntil(fx, item.id, "done", makeDeps(fx, { sandboxRunner: inProcessSandboxRunner() }));
      await waitForJobStatus(fx.store, item.id, "completed");

      // The per-job runner wrote the terminal lifecycle itself (issue #101):
      // one completed audit from the child (no parent duplicate), and the
      // outbox signal carries the delivery result keyed by the envelope id.
      const completed = await fx.store.listAudit({ event_type: JOB_COMPLETED_EVENT });
      expect(completed.map((row) => JSON.parse(row.payload))).toContainEqual(
        expect.objectContaining({ id: item.id, kind: "git", state: "done" }),
      );
      const { rows } = consumeOutboxWatermarked(fx.store);
      expect(rows.map((r) => r.kind).sort()).toEqual(["git", "work_item"]);
      const completion = rows.find((r) => r.kind === "git")!;
      expect(completion).toMatchObject({ id: item.id, kind: "git", space: space.id });
      // SAFETY: the git completion outbox payload is serialized by the
      // executor with a terminal state and delivery result containing pr_url.
      const payload = JSON.parse(completion.payload) as { state: string; result: { pr_url: string } };
      expect(payload.state).toBe("done");
      expect(payload.result.pr_url).toContain("/acme/sandbox/pull/1");
    } finally {
      fx.cleanup();
    }
  });

  test("a sandbox crash fails the job loudly and unsticks the item (issue #101)", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "do the thing",
        repo: "acme/sandbox",
        delivery: "git",
      });
      // Models the child claiming its item, then the sandbox process dying:
      // non-zero exit, no signal, no timeout → the boss loop must fail loud.
      const crashed: SandboxRunner = async (job, ctx) => {
        const parsed = workItemJobPayloadSchema.safeParse(job.payload);
        if (parsed.data) await ctx.deps.store.claimWorkItemById(parsed.data.workItemId);
        return { exitCode: 1, signal: null, timedOut: false };
      };

      await runUntil(fx, item.id, "blocked", makeDeps(fx, { sandboxRunner: crashed }));
      await waitForJobStatus(fx.store, item.id, "failed");

      // Fail-loud: the job.failed audit names the crash and the item is
      // blocked — never stuck at claimed/working, never silently requeued.
      const failed = await fx.store.listAudit({ event_type: JOB_FAILED_EVENT });
      expect(failed.map((row) => JSON.parse(row.payload))).toContainEqual(
        expect.objectContaining({ id: item.id, kind: "git", sandbox_crash: true }),
      );
      expect((await fx.store.getWorkItem(item.id))?.state).toBe("blocked");
      expect((await fx.store.getJob(item.id))?.attempts).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("an extension item completes through the envelope with its outbox result", async () => {
    const fx = makeFixture();
    try {
      fx.driver.messageText =
        'Task complete.\n{"url":"https://linear.example/issue/OPS-44","summary":"Created the envelope ticket"}';
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "create a ticket through the envelope",
        delivery: "extension",
      });

      await runUntil(fx, item.id, "done", makeExtensionDeps(fx));
      await waitForJobStatus(fx.store, item.id, "completed");

      const { rows } = consumeOutboxWatermarked(fx.store);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: item.id, kind: "extension" });
      // SAFETY: the extension outbox payload is the executor's own JSON
      // serialization of the delivery result (state + url/summary).
      const payload = JSON.parse(rows[0].payload) as { state: string; result: { url: string; summary: string } };
      expect(payload).toEqual({
        state: "done",
        result: { url: "https://linear.example/issue/OPS-44", summary: "Created the envelope ticket" },
      });
    } finally {
      fx.cleanup();
    }
  });

  test("a blocked work item completes the job with the blocked outcome (no outbox delivery result)", async () => {
    const fx = makeFixture();
    try {
      fx.driver.failure = new Error("agent crashed: exit code 42");
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "do the thing",
        repo: "acme/sandbox",
      });

      await runUntil(fx, item.id, "blocked", makeDeps(fx));
      await waitForJobStatus(fx.store, item.id, "completed");

      const completed = await fx.store.listAudit({ event_type: JOB_COMPLETED_EVENT });
      expect(JSON.parse(completed[0].payload)).toMatchObject({ id: item.id, kind: "git", state: "blocked" });
      const { rows } = consumeOutboxWatermarked(fx.store);
      // SAFETY: the blocked outbox payload is the executor's own JSON
      // serialization carrying the terminal state.
      const payload = JSON.parse(rows[0].payload) as { state: string };
      expect(payload.state).toBe("blocked");
    } finally {
      fx.cleanup();
    }
  });

  test("a blocked landing posts exactly one notification line through the outbox (issue #159)", async () => {
    const fx = makeFixture();
    try {
      fx.driver.failure = new Error("agent crashed: exit code 42");
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "do the thing",
        repo: "acme/sandbox",
      });

      await runUntil(fx, item.id, "blocked", makeDeps(fx));
      await waitForJobStatus(fx.store, item.id, "completed");

      // The transition notification row rides the outbox (the worker's only
      // channel to the server): one row per landing, keyed by item id +
      // state, carrying the description for the one-line post. Inspect the
      // pending rows directly — the seam pass below consumes them.
      // SAFETY: SELECT * returns the outbox column shape (OutboxRow).
      const pending = fx.store.getDb().query("SELECT * FROM outbox ORDER BY created_at").all() as OutboxRow[];
      expect(pending.map((r) => r.kind).sort()).toEqual(["git", "work_item"]);
      const notify = pending.find((r) => r.kind === "work_item")!;
      expect(notify).toMatchObject({ id: `${item.id}:blocked`, space: space.id });
      expect(JSON.parse(notify.payload)).toMatchObject({
        state: "blocked",
        workItemId: item.id,
        description: "do the thing",
      });

      // The post seam posts exactly ONE line: the notification, never the
      // bare "Blocked" state line from the job-completion row (superseded).
      const posted: Array<{ spaceId: string; text: string }> = [];
      const adapter = { postMessage: async (spaceId: string, text: string) => void posted.push({ spaceId, text }) };
      const pass = await postPendingOutboxRows(fx.store, adapter);
      expect(pass.posted).toBe(1);
      // The one-line notification carries the retained workspace and failure
      // reason so an operator can inspect the exact checkout.
      expect(posted).toEqual([
        {
          spaceId: space.id,
          text:
            `Blocked: do the thing — executor failed; workspace retained or left untouched at ` +
            `"${join(fx.workspacesDir, item.id)}": agent crashed: exit code 42`,
        },
      ]);
      // No audit claim that a bare completion row posted: only the
      // notification row's outbox.posted audit exists.
      expect(await fx.store.listAudit({ event_type: OUTBOX_POSTED_EVENT })).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  test("kb jobs refuse undeclared hosts and scheduled stays a fail-closed stub — never a silent no-op (epic #170)", async () => {
    const fx = makeFixture();
    try {
      // The committed config/kb.yml declares NO sources, so a kb dispatch
      // naming an undeclared host must be refused before any fetch.
      await fx.store.enqueueJob({ id: "kb_job_1", kind: "kb", payload: { url: "https://example.com/page" } });
      await fx.store.enqueueJob({ id: "sched_job_1", kind: "scheduled", payload: { action: "standup_digest" } });

      const ac = new AbortController();
      const run = runExecutor(
        makeDeps(fx, { maxJobAttempts: 1, jobBackoffMs: 1, jobBackoffMaxMs: 2, pollIntervalMs: 10 }),
        ac.signal,
      );
      try {
        await waitForJobStatus(fx.store, "kb_job_1", "failed");
        await waitForJobStatus(fx.store, "sched_job_1", "failed");
      } finally {
        ac.abort();
        await run;
      }

      const failed = await fx.store.listAudit({ event_type: JOB_FAILED_EVENT });
      const payloads = failed.map((row) => JSON.parse(row.payload));
      expect(payloads).toContainEqual(
        expect.objectContaining({
          id: "kb_job_1",
          kind: "kb",
          error: expect.stringContaining("kb job refused: host example.com is not in the declared KB source hosts"),
        }),
      );
      expect(payloads).toContainEqual(
        expect.objectContaining({ id: "sched_job_1", kind: "scheduled" }),
      );
      // Fail-closed: nothing ran, no completion signal, no work items.
      expect(await fx.store.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(0);
      expect(consumeOutboxWatermarked(fx.store).rows).toHaveLength(0);
      expect(fx.driver.sessions).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  // --- kb job kind (epic #170 Wave 2): the real ingest as a claimed job ---

  /** Local stub source for the kb worker's hermetic fetch (BOTTEGA_KB_BASE_URL). */
  const kbSourceStub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/handbook") {
        return new Response(
          "<html><body><h1>Company Handbook</h1><p>Remote work is supported.</p></body></html>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  afterAll(() => kbSourceStub.stop(true));

  /** Writes a temp config/kb.yml declaring one source; returns the temp root. */
  function declaredKbConfig() {
    const dir = mkdtempSync(join(tmpdir(), "bottega-kb-job-"));
    mkdirSync(join(dir, "config"));
    writeFileSync(
      join(dir, "config", "kb.yml"),
      "sources:\n  - id: handbook\n    url: https://docs.example.com/handbook\n    type: html\n",
    );
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /** Points the kb worker's config + fetch base at the hermetic test env for `fn`. */
  async function withKbEnv<T>(configDir: string, baseUrl: string, fn: () => Promise<T>): Promise<T> {
    const savedConfigDir = process.env.BOTTEGA_CONFIG_DIR;
    const savedBaseUrl = process.env.BOTTEGA_KB_BASE_URL;
    process.env.BOTTEGA_CONFIG_DIR = configDir;
    process.env.BOTTEGA_KB_BASE_URL = baseUrl;
    try {
      return await fn();
    } finally {
      if (savedConfigDir === undefined) delete process.env.BOTTEGA_CONFIG_DIR;
      else process.env.BOTTEGA_CONFIG_DIR = savedConfigDir;
      if (savedBaseUrl === undefined) delete process.env.BOTTEGA_KB_BASE_URL;
      else process.env.BOTTEGA_KB_BASE_URL = savedBaseUrl;
    }
  }

  describe("kb job kind — the real ingest as a claimed job (epic #170 Wave 2)", () => {
    test("enqueue → claim → run: fetches the declared source, stores chunks, completes + posts the outbox row", async () => {
      const fx = makeFixture();
      const kb = declaredKbConfig();
      try {
        await withKbEnv(kb.dir, kbSourceStub.url.origin, async () => {
          await fx.store.enqueueJob({
            id: "kb_handbook_job",
            kind: "kb",
            payload: { url: "https://docs.example.com/handbook" },
          });

          const ac = new AbortController();
          const run = runExecutor(
            makeDeps(fx, { maxJobAttempts: 1, jobBackoffMs: 1, jobBackoffMaxMs: 2, pollIntervalMs: 10 }),
            ac.signal,
          );
          try {
            await waitForJobStatus(fx.store, "kb_handbook_job", "completed");
          } finally {
            ac.abort();
            await run;
          }

          // The completion is on the audit trail, keyed by the envelope id.
          const completed = await fx.store.listAudit({ event_type: JOB_COMPLETED_EVENT });
          expect(JSON.parse(completed[0].payload)).toMatchObject({
            id: "kb_handbook_job",
            kind: "kb",
            state: "completed",
            result: { url: "https://docs.example.com/handbook", chunks: expect.any(Number), saved: expect.any(Number) },
          });

          // The worker→server signal: one outbox row carrying the result.
          const { rows } = consumeOutboxWatermarked(fx.store);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ id: "kb_handbook_job", kind: "kb", space: null });
          const outboxPayload = z
            .object({ state: z.string(), result: z.object({ url: z.string(), saved: z.number() }) })
            .safeParse(JSON.parse(rows[0].payload));
          expect(outboxPayload.success).toBe(true);
          if (!outboxPayload.success) throw new Error(`unexpected outbox payload: ${outboxPayload.error.message}`);
          expect(outboxPayload.data.state).toBe("completed");
          expect(outboxPayload.data.result.url).toBe("https://docs.example.com/handbook");
          expect(outboxPayload.data.result.saved).toBeGreaterThanOrEqual(1);

          // The parsed content actually landed in org memory with source metadata.
          const memories = await createSqliteMemoryProvider(fx.store.getDb()).search({
            query: "",
            scope: { kind: "org" },
            metadata: { kind: "kb", source: "handbook" },
            limit: 20,
          });
          expect(memories.length).toBeGreaterThanOrEqual(1);
          expect(memories[0]!.content).toContain("Remote work is supported.");
          const writes = await fx.store.listAudit({ event_type: MEMORY_WRITE_EVENT });
          expect(writes.length).toBeGreaterThanOrEqual(1);
          expect(writes[0]!.actor).toBe("kb_ingest");
        });
      } finally {
        kb.cleanup();
        fx.cleanup();
      }
    });

    test("a malformed kb payload fails the job with the schema reason", async () => {
      const fx = makeFixture();
      try {
        await fx.store.enqueueJob({ id: "kb_malformed", kind: "kb", payload: { url: 42 } });

        const ac = new AbortController();
        const run = runExecutor(
          makeDeps(fx, { maxJobAttempts: 1, jobBackoffMs: 1, jobBackoffMaxMs: 2, pollIntervalMs: 10 }),
          ac.signal,
        );
        try {
          await waitForJobStatus(fx.store, "kb_malformed", "failed");
        } finally {
          ac.abort();
          await run;
        }

        const failed = await fx.store.listAudit({ event_type: JOB_FAILED_EVENT });
        expect(JSON.parse(failed[0].payload)).toMatchObject({
          id: "kb_malformed",
          kind: "kb",
          error: expect.stringContaining("payload must be { url }"),
        });
        expect(await fx.store.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(0);
        expect(consumeOutboxWatermarked(fx.store).rows).toHaveLength(0);
      } finally {
        fx.cleanup();
      }
    });

    test("an undeclared host is refused before any fetch even when a source is declared", async () => {
      const fx = makeFixture();
      const kb = declaredKbConfig();
      try {
        await withKbEnv(kb.dir, kbSourceStub.url.origin, async () => {
          // docs.example.com is declared; evil.example.com is not — refused.
          await fx.store.enqueueJob({
            id: "kb_evil",
            kind: "kb",
            payload: { url: "https://evil.example.com/handbook" },
          });

          const ac = new AbortController();
          const run = runExecutor(
            makeDeps(fx, { maxJobAttempts: 1, jobBackoffMs: 1, jobBackoffMaxMs: 2, pollIntervalMs: 10 }),
            ac.signal,
          );
          try {
            await waitForJobStatus(fx.store, "kb_evil", "failed");
          } finally {
            ac.abort();
            await run;
          }

          const failed = await fx.store.listAudit({ event_type: JOB_FAILED_EVENT });
          expect(JSON.parse(failed[0].payload)).toMatchObject({
            id: "kb_evil",
            kind: "kb",
            error: expect.stringContaining("kb job refused: host evil.example.com is not in the declared KB source hosts"),
          });
          // No fetch happened: nothing was parsed or stored.
          expect(await fx.store.listAudit({ event_type: MEMORY_WRITE_EVENT })).toHaveLength(0);
          expect(consumeOutboxWatermarked(fx.store).rows).toHaveLength(0);
        });
      } finally {
        kb.cleanup();
        fx.cleanup();
      }
    });
  });

  test("a sandbox-owned semantic failure fails closed on its first attempt without replay", async () => {
    const fx = makeFixture();
    try {
      await fx.store.enqueueJob({ id: "kb_retry", kind: "kb", payload: { url: "https://example.com/retry" } });

      const ac = new AbortController();
      const run = runExecutor(
        makeDeps(fx, { maxJobAttempts: 3, jobBackoffMs: 5, jobBackoffMaxMs: 20, pollIntervalMs: 5 }),
        ac.signal,
      );
      try {
        await waitForJobStatus(fx.store, "kb_retry", "failed");
      } finally {
        ac.abort();
        await run;
      }

      // Issue #101 moved every job body into the sandbox. A handled
      // semantic failure owns its terminal lifecycle there and must not be
      // replayed by the parent as though the child had crashed.
      const claimed = await fx.store.listAudit({ event_type: JOB_CLAIMED_EVENT });
      expect(claimed.map((row) => JSON.parse(row.payload).attempts)).toEqual([1]);

      const failed = await fx.store.listAudit({ event_type: JOB_FAILED_EVENT });
      expect(failed).toHaveLength(1);
      const failure = JSON.parse(failed[0].payload);
      expect(failure).toMatchObject({
        id: "kb_retry",
        kind: "kb",
        error: expect.stringContaining("kb job refused"),
      });
      expect(failure.requeued).toBeUndefined();
      expect(await fx.store.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(0);
      expect(consumeOutboxWatermarked(fx.store).rows).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("a job whose work item is mid-flight under another owner requeues and never double-executes", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "owned elsewhere",
        repo: "acme/sandbox",
      });
      // A concurrent owner holds the item mid-flight (e.g. a lease-reclaim race
      // after a crash): claimed → working by someone other than this worker.
      await fx.store.claimWorkItemById(item.id);
      await fx.store.transitionWorkItem(item.id, "claimed", "working", { by: "executor:1" });

      const ac = new AbortController();
      const run = runExecutor(
        makeDeps(fx, { maxJobAttempts: 2, jobBackoffMs: 5, jobBackoffMaxMs: 10, pollIntervalMs: 5 }),
        ac.signal,
      );
      try {
        await waitForJobStatus(fx.store, item.id, "failed");
      } finally {
        ac.abort();
        await run;
      }

      // The item was never double-executed: still working under its owner, no
      // session, no completion signal.
      expect((await fx.store.getWorkItem(item.id))?.state).toBe("working");
      expect(fx.driver.sessions).toHaveLength(0);
      expect(await fx.store.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(0);
      expect(consumeOutboxWatermarked(fx.store).rows).toHaveLength(0);
      const claims = await fx.store.listAudit({ event_type: JOB_CLAIMED_EVENT });
      expect(claims.map((row) => JSON.parse(row.payload).attempts)).toEqual([1, 2]);
      const failed = (await fx.store.listAudit({ event_type: JOB_FAILED_EVENT })).map((row) =>
        JSON.parse(row.payload),
      );
      expect(failed).toHaveLength(2);
      expect(failed[0]).toMatchObject({
        id: item.id,
        kind: "git",
        attempts: 1,
        requeued: true,
        backoff_ms: 5,
        error: expect.stringContaining("sandbox requested requeue"),
      });
      expect(failed[1]).toMatchObject({
        id: item.id,
        kind: "git",
        attempts: 2,
        error: expect.stringContaining("sandbox requested requeue"),
      });
      expect(failed[1].requeued).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  test("a dispatched job with no live worker surfaces as job.unclaimed at boot + nudge", async () => {
    const fx = makeFixture();
    const nudged: WorkerJob[] = [];
    try {
      await fx.store.enqueueJob({ id: "kb_orphan", kind: "kb", payload: { url: "https://example.com/orphan" } });
      // Age the row past the TTL: the executor was down while the job sat
      // queued with no live worker (the exact fail-loud scenario).
      const db = new Database(join(fx.dir, "store.db"));
      try {
        db.run("UPDATE worker_jobs SET updated_at = ? WHERE id = ?", [Date.now() - 1000, "kb_orphan"]);
      } finally {
        db.close();
      }

      const ac = new AbortController();
      const run = runExecutor(
        makeDeps(fx, {
          jobUnclaimedTtlMs: 50,
          jobSweepIntervalMs: 20,
          pollIntervalMs: 10,
          onUnclaimed: (job) => {
            nudged.push(job);
          },
        }),
        ac.signal,
      );
      try {
        await waitForJobAudit(fx.store, JOB_UNCLAIMED_EVENT, "kb_orphan");
      } finally {
        ac.abort();
        await run;
      }

      const unclaimed = await fx.store.listAudit({ event_type: JOB_UNCLAIMED_EVENT });
      expect(JSON.parse(unclaimed[0].payload)).toMatchObject({ id: "kb_orphan", kind: "kb" });
      expect(nudged.map((job) => job.id)).toEqual(["kb_orphan"]);
      expect(await jobStatus(fx.store, "kb_orphan")).toBe("failed");
      // The nudge fires exactly once: the job is terminal, the sweep cannot re-audit it.
      expect(unclaimed).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  test("a lease-expired job is reclaimed and completed by a fresh worker (crash recovery, epic #170)", async () => {
    const fx = makeFixture();
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "survive the crash",
        repo: "acme/sandbox",
      });
      // Simulate a worker that claimed the job and died before running it:
      // the lease is expired, the work item is untouched (open).
      const db = new Database(join(fx.dir, "store.db"));
      try {
        db.run("UPDATE worker_jobs SET status = 'running', lease_until = ?, attempts = 1 WHERE id = ?", [
          Date.now() - 1000,
          item.id,
        ]);
      } finally {
        db.close();
      }

      await runUntil(fx, item.id, "done", makeDeps(fx, { jobLeaseMs: 10_000 }));
      await waitForJobStatus(fx.store, item.id, "completed");

      // The reclaim bumped attempts to 2 — the full lifecycle is on the trail.
      const claimed = await fx.store.listAudit({ event_type: JOB_CLAIMED_EVENT });
      expect(JSON.parse(claimed[0].payload)).toMatchObject({ id: item.id, attempts: 2 });
      // The review notification row (issue #159) + the completion row.
      const { rows } = consumeOutboxWatermarked(fx.store);
      expect(rows.map((r) => r.kind).sort()).toEqual(["git", "work_item"]);
      expect(rows.find((r) => r.kind === "work_item")!.id).toBe(`${item.id}:review`);
    } finally {
      fx.cleanup();
    }
  });
});
