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
import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "@emulators/core";
import githubPlugin, { seedFromConfig } from "@emulators/github";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type SpaceModelSettings, type Store, type WorkItem, type WorkItemState } from "./store/db";
import {
  DELIVERY_COMPLETED_EVENT,
  DELIVERY_PENDING_EVENT,
  DELIVERY_REQUESTED_EVENT,
  DELIVERY_RESOLVED_EVENT,
  EXTENSION_CALL_EVENT,
  WORK_ITEM_PIN_APPLIED_EVENT,
  WORK_ITEM_TRANSITION_EVENT,
} from "./store/audit-events";
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
import { resolveDeliveryAction } from "./server/adapters/delivery-router";
import { pollPendingDeliveries } from "./server/services/delivery-poller";
import {
  DELIVERY_APPROVE_ACTION_ID,
  DELIVERY_DENY_ACTION_ID,
  type SlackAction,
  type SlackAdapter,
} from "./server/adapters/slack";
import { createAudit } from "./policy/audit";
import { DenyRouter } from "./policy/approval-router";
import { defaultPolicy } from "./policy/config";
import { createExtensionRuntime, type ExtensionRuntime } from "./extensions/runtime";
import { createExtensionRegistry } from "./extensions/registry";
import { extensionToolDefinitions } from "./extensions/tools";
import { createFixtureRegistry, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL } from "./extensions/fixture";
import { resolveMemoryProvider } from "./server/memory-provider";
import { memoryToolDefinitions } from "./tools/memory";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { AgentDriver, AgentSessionDriver, AgentTurnOptions, ModelRole, ModelRoleSwitchResult } from "./server/drivers/agent-driver";

// --- Fakes ------------------------------------------------------------------

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
    this.emit("turn_start", {});
    await this.onPrompt?.();
    this.emit("message", { spaceId: this.opts.spaceId, text: this.messageText });
    if (this.emittedError) this.emit("error", { message: this.emittedError });
    this.emit("turn_end", {});
  }
  async abort(): Promise<void> {}
  isStreaming(): boolean {
    return false;
  }
  on(event: "message" | "turn_start" | "turn_end" | "error", cb: (data: unknown) => void): () => void {
    const set = (this.listeners[event] ??= new Set());
    set.add(cb);
    return () => set.delete(cb);
  }
  async dispose(): Promise<void> {}
  emit(event: "message" | "turn_start" | "turn_end" | "error", data: unknown): void {
    for (const cb of this.listeners[event] ?? []) cb(data);
  }
  private readonly listeners: Record<string, Set<(data: unknown) => void>> = {};
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
  }): Promise<AgentSessionDriver> {
    const session = new FakeSession(
      {
        spaceId: opts.spaceId,
        transcriptDir: opts.transcriptDir,
        cwd: opts.cwd ?? process.cwd(),
        allowTools: opts.allowTools ?? [],
        getModelSettings: opts.getModelSettings,
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

async function executeExtensionTool(tool: ToolDefinition, params: Record<string, unknown>, spaceId: string): Promise<void> {
  const result = await tool.execute(
    "test-call",
    params as never,
    new AbortController().signal,
    () => {},
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

async function waitForTransition(
  store: Store,
  from: WorkItemState,
  to: WorkItemState,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await store.listAudit({ event_type: WORK_ITEM_TRANSITION_EVENT });
    if (rows.some((row) => {
      const payload = JSON.parse(row.payload) as { from?: string; to?: string };
      return payload.from === from && payload.to === to;
    })) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for transition ${from} -> ${to}`);
    await Bun.sleep(10);
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
      const result = JSON.parse(done.result!) as { pr_url: string; summary: string };
      expect(result.pr_url).toContain(`/acme/sandbox/pull/1`);
      expect(result.summary).toBe("implemented the requested change");
      expect(JSON.parse(done.approvals)).toEqual([{ approver: "U_HUMAN", at: expect.any(Number) }]);
      const evidence = JSON.parse(done.evidence) as Array<{ kind: string; url: string }>;
      expect(evidence).toHaveLength(1);
      expect(evidence[0].url).toContain(result.pr_url);

      // Every transition was performed by the executor and audited.
      const transitions = await fx.store.listAudit({ event_type: WORK_ITEM_TRANSITION_EVENT });
      expect(transitions.map((t) => JSON.parse(t.payload))).toEqual(
        expect.arrayContaining([
          { from: "claimed", to: "working", by: "executor" },
          { from: "working", to: "review", by: "executor" },
          { from: "review", to: "done", by: "executor" },
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
      }).then((r) => r.json() as Promise<{ head: { ref: string }; base: { ref: string }; user: { login: string } }>);
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

      const evidence = JSON.parse(blocked.evidence) as Array<{ kind: string; url: string }>;
      expect(evidence).toHaveLength(1);
      expect(evidence[0].kind).toBe("note");
      expect(evidence[0].url).toContain("exit code 42");
      expect(fx.deliveries).toHaveLength(0);
      // Forensics: the workspace is kept, no PR was opened.
      expect(existsSync(join(fx.workspacesDir, item.id))).toBe(true);
      const pulls = await fetch(`${fx.emulatorBase}/repos/acme/sandbox/pulls`, {
        headers: { Authorization: `Bearer ${fx.pat}` },
      }).then((r) => r.json() as Promise<unknown[]>);
      expect(pulls).toHaveLength(0);
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
      // The PR itself was still opened before the approval request.
      const pulls = await fetch(`${fx.emulatorBase}/repos/acme/sandbox/pulls`, {
        headers: { Authorization: `Bearer ${fx.pat}` },
      }).then((r) => r.json() as Promise<Array<{ number: number }>>);
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
      await fx.store.claimNextWorkItem();
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

      const evidence = JSON.parse(blocked.evidence) as Array<{ kind: string; text: string }>;
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
      const result = JSON.parse(done.result!) as { pr_url: string };
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

      const evidence = JSON.parse(blocked.evidence) as Array<{ kind: string; url: string }>;
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

      const evidence = JSON.parse(blocked.evidence) as Array<{ kind: string; url: string }>;
      expect(evidence[0].url).toContain('"evil/corp"');
      expect(evidence[0].url).toContain("allowlist");
      expect(fx.driver.sessions).toHaveLength(0);
      expect(fx.deliveries).toHaveLength(0);
      // No PR was opened anywhere.
      const pulls = await fetch(`${fx.emulatorBase}/repos/acme/sandbox/pulls`, {
        headers: { Authorization: `Bearer ${fx.pat}` },
      }).then((r) => r.json() as Promise<unknown[]>);
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

      const evidence = JSON.parse(blocked.evidence) as Array<{ kind: string; url: string }>;
      expect(evidence[0].url).toContain("allowlist");
      expect(fx.driver.sessions).toHaveLength(0);
    } finally {
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
          { from: "claimed", to: "working", by: "executor" },
          { from: "working", to: "done", by: "executor" },
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

  test("chat delivery returns claimed items to open and logs the handoff", async () => {
    const fx = makeFixture();
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((message?: unknown, ...args: unknown[]) => {
      lines.push([message, ...args].map(String).join(" "));
    });
    try {
      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await fx.store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "reply in the current conversation",
        delivery: "chat",
      });
      const ac = new AbortController();
      const run = runExecutor(makeDeps(fx), ac.signal);
      try {
        await waitForTransition(fx.store, "claimed", "open");
      } finally {
        ac.abort();
        await run;
      }

      expect((await fx.store.getWorkItem(item.id))?.state).toBe("open");
      expect(fx.driver.sessions).toHaveLength(0);
      expect(lines.some((line) => line.includes("chat delivery is handled by the space agent"))).toBe(true);
      const transitions = await fx.store.listAudit({ event_type: WORK_ITEM_TRANSITION_EVENT });
      expect(transitions.map((row) => JSON.parse(row.payload))).not.toEqual(
        expect.arrayContaining([{ from: "working", to: "blocked", by: "executor" }]),
      );
    } finally {
      log.mockRestore();
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
      const leaked = Object.entries(process.env).filter(([, v]) => typeof v === "string" && v.includes(fx.pat));
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

describe("delivery approval round trip (issue #149)", () => {
  /** Server-side fakes: the poller's message surface + the resolver's rewrite surface. */
  function serverFakes(): {
    adapter: Pick<SlackAdapter, "postMessage" | "updateMessage">;
    posted: Array<{ spaceId: string; text: string; blocks?: unknown[] }>;
    updated: Array<{ spaceId: string; ts: string; text: string }>;
  } {
    const posted: Array<{ spaceId: string; text: string; blocks?: unknown[] }> = [];
    const updated: Array<{ spaceId: string; ts: string; text: string }> = [];
    return {
      posted,
      updated,
      adapter: {
        async postMessage(spaceId, text, opts) {
          posted.push({ spaceId, text, ...(opts?.blocks ? { blocks: opts.blocks } : {}) });
          return "1.000001";
        },
        async updateMessage(spaceId, ts, text) {
          updated.push({ spaceId, ts, text });
        },
      },
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
      if (rows.some((row) => (JSON.parse(row.payload) as { id?: string }).id === itemId)) return;
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
        const result = JSON.parse(done.result!) as { pr_url: string; summary: string };
        expect(result.pr_url).toContain(`/acme/sandbox/pull/1`);
        expect(JSON.parse(done.approvals)).toEqual([{ approver: "U_HUMAN", at: expect.any(Number) }]);

        // The documented path: working → review → done, by the executor.
        const transitions = await fx.store.listAudit({ event_type: WORK_ITEM_TRANSITION_EVENT });
        expect(transitions.map((row) => JSON.parse(row.payload))).toEqual(
          expect.arrayContaining([
            { from: "working", to: "review", by: "executor" },
            { from: "review", to: "done", by: "executor" },
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
            { from: "working", to: "review", by: "executor" },
            { from: "review", to: "done", by: "executor" },
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
