/**
 * Canary journeys (issue #71): the e2e user journeys with the REAL model.
 *
 * Same stack as tests/e2e/harness.ts (real driver, store, policy gate,
 * memory provider, work items, Slack adapter — emulated boundaries are only
 * Slack outbound, the filesystem, and the GitHub emulator), but the
 * session's model is the REAL provider: `bootHarness({ realModel: true })`
 * installs the deployment model catalog (config/omp/models.yml) into the
 * temp agent dir, so agent turns hit the real gateway instead of the
 * scripted stub. The default model is the NEAR one (near/zai-org/GLM-5.1-FP8).
 * The opencode-go primary is usable too since the driver flattens dotted
 * tool names at the session boundary (issue #78); both paths pass, and
 * CANARY_MODEL_REF overrides to switch providers.
 *
 * Assertions are SEMANTIC end-states — the real model decides its own tool
 * calls, so exact tool sequences are never asserted:
 *   - chat:      a DM gets a real non-empty reply (thinking phrase →
 *                in-place update flow)
 *   - memory:    "remember that <fact>" → a memory row exists containing
 *                the fact (searched back through the real provider)
 *   - work item: "create a work item to fix X in <repo>" → an open work
 *                item exists with the repo (auto-approve router; the model
 *                must call create_work_item)
 *   - CANARY_FULL=1: the executor end-to-end — the REAL model implementation
 *                turn in a cloned workspace → PR via the GitHub emulator
 *                (slow; opt-in)
 *
 * Failures are deterministic: every journey captures the session transcript
 * (the model's actual output) into the assertion error for diagnosis.
 * Timeouts are generous — real model latency, not stub latency.
 *
 * NOT part of the default suite: the file name does not match bun's test
 * globs (`*.test.ts`, `*_test.ts`, `*.spec.ts`, `*_spec.ts`), so `bun test`
 * ignores it; `bun run canary` (scripts/canary.sh) targets it explicitly.
 * NEVER wired into CI — real model calls cost money and are non-deterministic.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "@emulators/core";
import githubPlugin, { seedFromConfig } from "@emulators/github";
import { CHURN_MESSAGE, THINKING_PHRASES } from "../../src/server/services/space-service";
import { runExecutor } from "../../src/executor";
import { resolveMemoryProvider } from "../../src/server/memory-provider";
import { bootHarness, type Harness } from "../e2e/harness";
import type { Store, WorkItem, WorkItemState } from "../../src/store/db";

/**
 * Canary org policy: fail-closed by default, so the config EXPLICITLY
 * allows every tool the real model may reach for — the memory/work-item
 * tools of the journeys plus the gated builtins (read/write/bash/...) the
 * model uses while deciding. create_work_item is exec-tier, so
 * always_approve keeps it from parking on an approval prompt (the auto-
 * approve router would resolve it anyway; this keeps the audit clean).
 */
const ORG_CONFIG = [
  "tools:",
  "  memory.save: allow",
  "  memory.search: allow",
  "  create_work_item: allow",
  "  read: allow",
  "  glob: allow",
  "  grep: allow",
  "  ast_grep: allow",
  "  web_search: allow",
  "  task: allow",
  "  write: allow",
  "  edit: allow",
  "  bash: allow",
  "approvals:",
  "  always_approve:",
  "    - create_work_item",
  "",
].join("\n");

/** Polls `fn` until it returns a truthy value; fails on timeout. */
async function waitFor<T>(
  fn: () => T | undefined | null | Promise<T | undefined | null>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/** The session transcript file for a space (the model's actual output). */
function transcriptTail(h: Harness, spaceId: string): string {
  try {
    const lines = readFileSync(join(h.transcriptDir, `${spaceId}.jsonl`), "utf8").trim().split("\n");
    return lines.slice(-60).join("\n").slice(-12_000);
  } catch {
    return "(no transcript file)";
  }
}

/** Runs `fn` and, on failure, appends the model's session transcript to the error. */
async function withTranscript<T>(h: Harness, spaceId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\n\n--- model transcript (tail) ---\n${transcriptTail(h, spaceId)}`);
  }
}

/** The first work item created in the space (mirror of journey 2's findOpenItem). */
async function waitForOpenWorkItem(h: Harness, spaceId: string, timeoutMs: number): Promise<WorkItem> {
  return waitFor(async () => {
    const rows = await h.store.listAudit({ space: spaceId, event_type: "work_item.created" });
    for (const row of rows) {
      // The creation audit payload is exactly { id } (asserted in journey 2).
      // SAFETY: store.createWorkItem writes this payload as JSON.stringify({ id }).
      const { id } = JSON.parse(row.payload) as { id: string };
      const item = await h.store.getWorkItem(id);
      if (item) return item;
    }
    return undefined;
  }, timeoutMs, "a work item to be created");
}

async function waitForState(
  store: Harness["store"],
  id: string,
  states: WorkItemState[],
  timeoutMs: number,
): Promise<WorkItem> {
  return waitFor(async () => {
    const item = await store.getWorkItem(id);
    return item && states.includes(item.state) ? item : undefined;
  }, timeoutMs, `item ${id} to reach ${states.join("/")}`);
}

// --- GitHub emulator + executor fixture (the #11 pattern, mirror of journey 2) ---

const PAT = "github_pat_canary_secret_789";

function runGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

/** GitHub emulator + seeded acme/sandbox bare repo + PAT. */
function bootGithub() {
  const dir = mkdtempSync(join(tmpdir(), "bottega-canary-gh-"));
  const bare = join(dir, "bare", "acme", "sandbox.git");
  const seedWork = join(dir, "seed");
  mkdirSync(seedWork, { recursive: true });
  runGit(["init", "-b", "main"], seedWork);
  runGit(["config", "user.email", "seed@example.com"], seedWork);
  runGit(["config", "user.name", "seed"], seedWork);
  writeFileSync(join(seedWork, "README.md"), "# sandbox\n");
  runGit(["add", "README.md"], seedWork);
  runGit(["commit", "-m", "init"], seedWork);
  mkdirSync(join(dir, "bare", "acme"), { recursive: true });
  runGit(["clone", "--bare", seedWork, bare]);
  rmSync(seedWork, { recursive: true, force: true });

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
  return {
    dir,
    bare,
    baseUrl: `http://127.0.0.1:${port}`,
    pat: PAT,
    cleanup() {
      http.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Executor fixture (issue #67): runtime knobs are ORG SETTINGS, not env
 * vars — seed the settings blob on the harness store (DB wins over
 * config/org.yml), and the PAT stays a FILE (only the file path is env).
 * Returns a restore fn for the env var.
 */
function setExecutorFixture(store: Store, gh: { dir: string; baseUrl: string; pat: string }): () => void {
  store.setOrgSettings({
    workspaces_dir: join(gh.dir, "workspaces"),
    git_base_url: `file://${join(gh.dir, "bare")}`,
    api_base_url: gh.baseUrl,
    repos: ["acme/sandbox"],
  });
  const tokenFile = join(gh.dir, "secrets", "github-pat");
  mkdirSync(join(gh.dir, "secrets"), { recursive: true });
  writeFileSync(tokenFile, `${gh.pat}\n`);
  chmodSync(tokenFile, 0o600);
  const saved = process.env.EXECUTOR_GIT_TOKEN_FILE;
  process.env.EXECUTOR_GIT_TOKEN_FILE = tokenFile;
  return () => {
    if (saved === undefined) delete process.env.EXECUTOR_GIT_TOKEN_FILE;
    else process.env.EXECUTOR_GIT_TOKEN_FILE = saved;
  };
}

describe("canary journeys with the real model (issue #71)", () => {
  test("chat: a DM gets a real non-empty reply (thinking phrase → in-place update)", async () => {
    const h = await bootHarness({ realModel: true, orgConfigYaml: ORG_CONFIG });
    const dm = h.slack.dmChannelId;
    const spaceId = `slack:${dm}`;
    try {
      await withTranscript(h, spaceId, async () => {
        h.deliverMessage(dm, "hello").catch(() => {});
        // The thinking phrase is posted at turn_start and replaced in place
        // by the real reply: exactly one DM row, its text non-empty and no
        // longer a thinking phrase. The empty-turn churn notice (issue #60)
        // is NOT a reply — a session that only churns failed the journey.
        const reply = await waitFor(
          () => {
            const msgs = h.messages(dm);
            if (msgs.length !== 1) return undefined;
            const text = msgs[0]!.text.trim();
            return text.length > 0 && !THINKING_PHRASES.includes(text) && text !== CHURN_MESSAGE ? msgs[0] : undefined;
          },
          150_000,
          "the real model reply (in place of the thinking phrase)",
        );
        console.log(`[canary] chat: model=${h.modelRef} reply=${JSON.stringify(reply.text)}`);
        expect(reply.text.trim().length).toBeGreaterThan(0);
        expect(h.messages(dm)).toHaveLength(1);
      });
    } finally {
      await h.cleanup();
    }
  }, 180_000);

  test("memory: 'remember that <fact>' persists a row containing the fact", async () => {
    const h = await bootHarness({ realModel: true, orgConfigYaml: ORG_CONFIG });
    const dm = h.slack.dmChannelId;
    const spaceId = `slack:${dm}`;
    const token = `canary-e2e-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await withTranscript(h, spaceId, async () => {
        h.deliverMessage(dm, `remember that ${token} is the marker for this canary run`).catch(() => {});
        // The real model must call memory.save; the row may land in org or
        // user scope — search both scopes for the fact token.
        const found = await waitFor(
          async () => {
            const org = await h.memory.search({ scope: "org", query: token });
            if (org.some((e) => e.content.includes(token))) return org;
            const user = await h.memory.search({ scope: "user", query: token });
            return user.some((e) => e.content.includes(token)) ? user : undefined;
          },
          150_000,
          "a memory row containing the fact",
        );
        console.log(`[canary] memory: model=${h.modelRef} row=${JSON.stringify(found[0]!.content)}`);
        expect(found.some((e) => e.content.includes(token))).toBe(true);
      });
    } finally {
      await h.cleanup();
    }
  }, 180_000);

  test("work item: 'create a work item to fix X in <repo>' opens an item with the repo", async () => {
    const h = await bootHarness({ realModel: true, orgConfigYaml: ORG_CONFIG });
    const dm = h.slack.dmChannelId;
    const spaceId = `slack:${dm}`;
    try {
      await withTranscript(h, spaceId, async () => {
        h.deliverMessage(dm, "create a work item to fix the flaky checkout in acme/sandbox").catch(() => {});
        const item = await waitForOpenWorkItem(h, spaceId, 180_000);
        console.log(`[canary] work item: model=${h.modelRef} id=${item.id} state=${item.state} repo=${item.repo}`);
        expect(item.state).toBe("open");
        expect(item.repo).toBe("acme/sandbox");
      });
    } finally {
      await h.cleanup();
    }
  }, 240_000);

  test("CANARY_FULL=1: executor end-to-end — real model implementation turn → PR via the github emulator", async () => {
    if (process.env.CANARY_FULL !== "1") {
      console.log("[canary] CANARY_FULL leg skipped — set CANARY_FULL=1 to run the executor end-to-end (slow)");
      return;
    }
    const gh = bootGithub();
    const h = await bootHarness({ realModel: true, orgConfigYaml: ORG_CONFIG });
    const restoreEnv = setExecutorFixture(h.store, gh);
    const dm = h.slack.dmChannelId;
    const spaceId = `slack:${dm}`;
    try {
      await withTranscript(h, spaceId, async () => {
        h.deliverMessage(dm, "create a work item to fix the flaky checkout in acme/sandbox").catch(() => {});
        const item = await waitForOpenWorkItem(h, spaceId, 180_000);
        expect(item.state).toBe("open");
        expect(item.repo).toBe("acme/sandbox");

        // Real executor loop: claim → working → clone (PAT via askpass) →
        // REAL model implementation turn → push → PR → delivery approval
        // (auto-approved here — the harness plays the server's onDelivery
        // seam, which prod wires later).
        const ac = new AbortController();
        const run = runExecutor(
          {
            store: h.store,
            memoryProvider: resolveMemoryProvider(h.store.getOrgSettings(), h.store.getDb()),
            driver: h.driver,
            transcriptDir: h.transcriptDir,
            pollIntervalMs: 10,
            onDelivery: async () => ({ approver: "canary" }),
          },
          ac.signal,
        );
        try {
          const settled = await waitForState(h.store, item.id, ["done", "blocked"], 420_000);
          if (settled.state !== "done") {
            throw new Error(`executor leg: item ${item.id} ended ${settled.state} — evidence: ${settled.evidence}`);
          }
          // The done transition's result is exactly { pr_url, summary } (store obligation).
          // SAFETY: the executor writes done results as JSON.stringify({ pr_url, summary }).
          const result = JSON.parse(settled.result!) as { pr_url: string; summary: string };
          console.log(`[canary] executor: model=${h.modelRef} pr=${result.pr_url} summary=${JSON.stringify(result.summary)}`);
          expect(result.pr_url).toContain("/acme/sandbox/pull/");
          // The PR landed on the emulator with the bottega/<id> head (the
          // emulator's shape is { head: { ref } }, asserted in journey 2),
          // and the branch reached the bare remote.
          // SAFETY: the emulator's PR record carries head.ref (asserted in journey 2);
          // extra fields are ignored by the destructuring below.
          const pr = (await fetch(`${gh.baseUrl}/repos/acme/sandbox/pulls/1`, {
            headers: { Authorization: `Bearer ${gh.pat}` },
          }).then((r) => r.json())) as { head: { ref: string } };
          expect(pr.head.ref).toBe(`bottega/${item.id}`);
          const refs = runGit(["--git-dir", gh.bare, "for-each-ref", "--format=%(refname:short)"]);
          expect(refs).toContain(`bottega/${item.id}`);
        } finally {
          ac.abort();
          await run.catch(() => {});
        }
      });
    } finally {
      await h.cleanup();
      gh.cleanup();
      restoreEnv();
    }
  }, 600_000);
});
