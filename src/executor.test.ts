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
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "@emulators/core";
import githubPlugin, { seedFromConfig } from "@emulators/github";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store, type WorkItem, type WorkItemState } from "./store/db";
import { DELIVERY_PENDING_EVENT, WORK_ITEM_TRANSITION_EVENT } from "./store/audit-events";
import {
  EXECUTOR_TOOLS,
  prepareExecutor,
  runExecutor,
  type DeliveryApproval,
  type DeliveryInfo,
  type ExecutorDeps,
} from "./executor";
import type { AgentDriver, AgentSessionDriver, AgentTurnOptions } from "./server/agent-driver";

// --- Fakes ------------------------------------------------------------------

/** Session driver double: records createSession opts, streams one canned message per prompt. */
class FakeSession implements AgentSessionDriver {
  prompts: string[] = [];
  constructor(
    readonly opts: { spaceId: string; transcriptDir: string; cwd: string; allowTools: readonly string[] },
    private readonly failure: Error | null,
    private readonly messageText: string,
  ) {}

  async prompt(text: string, _opts?: AgentTurnOptions): Promise<void> {
    this.prompts.push(text);
    if (this.failure) throw this.failure;
    this.emit("turn_start", {});
    this.emit("message", { spaceId: this.opts.spaceId, text: this.messageText });
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
  messageText = "implemented the requested change";

  async createSession(opts: {
    spaceId: string;
    transcriptDir: string;
    onOutput: (spaceId: string, text: string) => void;
    cwd?: string;
    allowTools?: readonly string[];
  }): Promise<AgentSessionDriver> {
    const session = new FakeSession(
      {
        spaceId: opts.spaceId,
        transcriptDir: opts.transcriptDir,
        cwd: opts.cwd ?? process.cwd(),
        allowTools: opts.allowTools ?? [],
      },
      this.failure,
      this.messageText,
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
  /** The executor's git remote: a local bare repo at bare/acme/sandbox.git. */
  bareRepo: string;
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

  // Seeded local bare repo (the executor's remote), main with one commit.
  const seedWork = join(dir, "seed-work");
  mkdirSync(seedWork, { recursive: true });
  runGit(["init", "-b", "main"], seedWork);
  runGit(["config", "user.email", "seed@example.com"], seedWork);
  runGit(["config", "user.name", "seed"], seedWork);
  writeFileSync(join(seedWork, "README.md"), "# sandbox\n");
  runGit(["add", "README.md"], seedWork);
  runGit(["commit", "-m", "init"], seedWork);
  const bareRepo = join(dir, "bare", "acme", "sandbox.git");
  mkdirSync(join(dir, "bare", "acme"), { recursive: true });
  runGit(["clone", "--bare", seedWork, bareRepo]);
  rmSync(seedWork, { recursive: true, force: true });

  // Org config: repos + git base (file:// so clone/push stay local).
  const orgConfigDir = join(dir, "config");
  mkdirSync(orgConfigDir, { recursive: true });
  writeFileSync(
    join(orgConfigDir, "org.yml"),
    `git_base_url: "file://${join(dir, "bare")}"\nrepos:\n  - "acme/sandbox"\n`,
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
    repos: [{ owner: "acme", name: "sandbox", default_branch: "main" }],
  });
  const http = Bun.serve({ port, fetch: emu.app.fetch });
  const emulatorBase = `http://127.0.0.1:${port}`;

  const driver = new FakeDriver();
  const deliveries: Fixture["deliveries"] = [];

  // Env contract: the token value never enters the environment — only the
  // FILE path does. Save prior values so tests stay isolated.
  const saved = {
    workspaces: process.env.WORKSPACES_DIR,
    tokenFile: process.env.EXECUTOR_GIT_TOKEN_FILE,
    apiUrl: process.env.EXECUTOR_GITHUB_API_URL,
    repos: process.env.EXECUTOR_REPOS,
  };
  process.env.WORKSPACES_DIR = join(dir, "workspaces");
  process.env.EXECUTOR_GIT_TOKEN_FILE = tokenFile;
  process.env.EXECUTOR_GITHUB_API_URL = emulatorBase;
  delete process.env.EXECUTOR_REPOS;

  const fixture: Fixture = {
    dir,
    store,
    spaceId: "slack:C1",
    bareRepo,
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
      process.env.WORKSPACES_DIR = saved.workspaces;
      process.env.EXECUTOR_GIT_TOKEN_FILE = saved.tokenFile;
      process.env.EXECUTOR_GITHUB_API_URL = saved.apiUrl;
      if (saved.repos === undefined) delete process.env.EXECUTOR_REPOS;
      else process.env.EXECUTOR_REPOS = saved.repos;
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
      const item = await fx.store.createWorkItem({ space_id: space.id, requester: "U1", description: "do the thing" });

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
      const item = await fx.store.createWorkItem({ space_id: space.id, requester: "U1", description: "ship it" });

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
});

describe("org config parsing (issue #33)", () => {
  test("trailing comments and quoted repo entries parse to the correct repo and git base", async () => {
    const fx = makeFixture();
    try {
      // Shapes the old line-scanner silently mis-parsed (the comment would
      // have been glued to the repo string, breaking the owner/repo match).
      writeFileSync(
        join(fx.orgConfigDir, "org.yml"),
        `# org repo config\ngit_base_url: "file://${join(fx.dir, "bare")}" # local bare repo\nrepos:\n  - "acme/sandbox" # v1 target\n`,
      );
      const cfg = await prepareExecutor(makeDeps(fx));
      expect(cfg.repo).toBe("acme/sandbox");
      expect(cfg.gitBaseUrl).toBe(`file://${join(fx.dir, "bare")}`);
    } finally {
      fx.cleanup();
    }
  });

  test("an inline-sequence repos entry fails closed with a clear boot error", async () => {
    const fx = makeFixture();
    try {
      writeFileSync(join(fx.orgConfigDir, "org.yml"), `git_base_url: "file://${join(fx.dir, "bare")}"\nrepos: ["acme/sandbox"]\n`);
      await expect(prepareExecutor(makeDeps(fx))).rejects.toThrow(/config\/org\.yml: .*flow collections/);
    } finally {
      fx.cleanup();
    }
  });

  test("a malformed repos entry (non-string) fails closed", async () => {
    const fx = makeFixture();
    try {
      writeFileSync(
        join(fx.orgConfigDir, "org.yml"),
        `git_base_url: "file://${join(fx.dir, "bare")}"\nrepos:\n  - acme/sandbox\n  - broken: entry\n`,
      );
      await expect(prepareExecutor(makeDeps(fx))).rejects.toThrow(/config\/org\.yml: .*owner\/repo strings/);
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

  test("a loose PAT file mode fails closed unless BOTTEGA_ALLOW_LOOSE_PAT=1", async () => {
    const fx = makeFixture();
    try {
      chmodSync(fx.tokenFile, 0o644);
      await expect(prepareExecutor(makeDeps(fx))).rejects.toThrow(/must be mode 0600/);

      process.env.BOTTEGA_ALLOW_LOOSE_PAT = "1";
      await expect(prepareExecutor(makeDeps(fx))).resolves.toMatchObject({ tokenFile: fx.tokenFile });
    } finally {
      delete process.env.BOTTEGA_ALLOW_LOOSE_PAT;
      fx.cleanup();
    }
  });
});
