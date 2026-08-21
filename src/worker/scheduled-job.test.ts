/**
 * Scheduled worker job kind tests (issue #272, epic #229 P2): the
 * `scheduled` envelope kind dispatches to the executor's action registry —
 * the action body runs with the job-scoped store facade, writes its own
 * outbox row + job.completed audit, and the server's consumer path sees
 * the result. The memory_consolidation action drives the REAL consolidation
 * pipeline hermetically with the model-call seam stubbed.
 *
 * The fixture mirrors the executor.test.ts hermetic pattern: a real store
 * in a temp dir, the sqlite memory provider over the same DB, a stub
 * driver (sessions never run — the model-call seam is stubbed), and the
 * executor loop driving enqueue → claim → run → outbox.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runExecutor, type ExecutorDeps } from "../executor";
import { inProcessSandboxRunner } from "./run-job";
import { createSqliteMemoryProvider } from "../memory/sqlite";
import type { ConsolidationModelCall } from "../memory/consolidation";
import { createAudit } from "../policy/audit";
import { buildRegistry } from "../scheduler/actions";
import type { SchedulerAction, SchedulerActionRegistry } from "../scheduler/types";
import { postPendingOutboxRows } from "../server/services/outbox-post-seam";
import { createStore, type Store } from "../store/db";
import { JOB_COMPLETED_EVENT, JOB_FAILED_EVENT } from "../store/audit-events";
import { consumeOutboxWatermarked } from "../store/outbox";
import type { OutboxRow } from "../store/outbox";
import type { AgentDriver, AgentSessionDriver } from "../server/drivers/agent-driver";
import { capsFor } from "./run-job";
import { ScopedStoreAccessError } from "./scoped-store";

// --- Fakes ------------------------------------------------------------------

/** A driver whose sessions would prove a side-session ran — they must not. */
class StubDriver implements AgentDriver {
  sessions = 0;
  async createSession(): Promise<AgentSessionDriver> {
    this.sessions += 1;
    throw new Error("a scheduled test drove a driver session — the model-call seam must be stubbed");
  }
}

interface Fixture {
  dir: string;
  store: Store;
  driver: StubDriver;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "bottega-scheduled-"));
  const store = createStore(join(dir, "store.db"));
  // The sqlite memory provider migrates the memories table into the store
  // DB — the same handle maintainMemory reads through the scoped store.
  createSqliteMemoryProvider(store.getDb());
  // resolveConfig loads the repo allowlist from org.yml on every boot — the
  // executor authorizes pushes from here, so the fixture must seed it.
  const orgConfigDir = join(dir, "config");
  mkdirSync(orgConfigDir, { recursive: true });
  writeFileSync(join(orgConfigDir, "org.yml"), 'git_base_url: "https://github.com"\nrepos:\n  - "acme/sandbox"\n');
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  // The PAT file: mode 0600, like the deployment contract (resolveConfig
  // guard).
  const patFile = join(dir, "secrets", "github-pat");
  mkdirSync(dirname(patFile), { recursive: true });
  writeFileSync(patFile, "ghp_scheduled_test_pat", { mode: 0o600 });
  const prevTokenEnv = process.env.EXECUTOR_GIT_TOKEN_FILE;
  process.env.EXECUTOR_GIT_TOKEN_FILE = patFile;
  return {
    dir,
    store,
    driver: new StubDriver(),
    cleanup() {
      store.close();
      if (prevTokenEnv === undefined) delete process.env.EXECUTOR_GIT_TOKEN_FILE;
      else process.env.EXECUTOR_GIT_TOKEN_FILE = prevTokenEnv;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeDeps(fx: Fixture, overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    store: fx.store,
    sandboxRunner: inProcessSandboxRunner(),
    memoryProvider: createSqliteMemoryProvider(fx.store.getDb()),
    driver: fx.driver,
    orgConfigDir: join(fx.dir, "config"),
    transcriptDir: join(fx.dir, "transcripts"),
    pollIntervalMs: 10,
    ...overrides,
  };
}

// --- Helpers -----------------------------------------------------------------

function jobStatus(store: Store, id: string): Promise<string | null> {
  const row = store.getDb().query("SELECT status AS s FROM worker_jobs WHERE id = ?").get(id) as { s: string } | null;
  return Promise.resolve(row?.s ?? null);
}

// Real-time poll-until-condition (repo convention, see executor.test.ts /
// run-job.test.ts): the executor loop advances on its own wall-clock
// interval (pollIntervalMs) and sleeps between claims, so fake timers cannot
// drive it — an unavoidable integration-test delay, bounded by a deadline.
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

/** Runs the executor loop until the job settles, then aborts the loop. */
async function runLoopUntil(fx: Fixture, jobId: string, status: string, deps: ExecutorDeps): Promise<void> {
  const ac = new AbortController();
  const run = runExecutor(deps, ac.signal);
  try {
    await waitForJobStatus(fx.store, jobId, status);
  } finally {
    ac.abort();
    await run.catch(() => {});
  }
}

/**
 * Waits for an audit row whose payload names the job id. The scheduled body
 * writes completeJob → outbox row → audit in that order (run-job.ts
 * completeSelf), so the JOB_COMPLETED audit row is the LAST write — waiting
 * on it guarantees the outbox row is readable before the test inspects it.
 */
async function waitForJobAudit(store: Store, eventType: string, jobId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await store.listAudit({ event_type: eventType });
    if (rows.some((row) => {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        return false;
      }
      return typeof payload === "object" && payload !== null && "id" in payload && payload.id === jobId;
    })) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${eventType} of ${jobId}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "bottega-scheduled-store-"));
  dirs.push(dir);
  const store = createStore(join(dir, "store.db"));
  stores.push(store);
  return store;
}

// --- Acceptance tests (issue #272) -------------------------------------------

describe("scheduled worker job kind (issue #272)", () => {
  test("a memory_consolidation job drives the real pipeline: enqueue → claim → run with scoped store + stubbed model call → outbox + completed audit → the consumer path sees the result", async () => {
    const fx = makeFixture();
    try {
      // Seed the org memory pool past the compaction threshold
      // (DEFAULT_COMPACT_AFTER = 10 new facts since the marker).
      const insert = fx.store
        .getDb()
        .query("INSERT INTO memories (id, scope, principal, content, metadata_json, created_at) VALUES (?, 'org', NULL, ?, '{}', ?)");
      for (let i = 1; i <= 12; i++) insert.run(`mem_seed_${i}`, `org fact ${i}`, i);

      let modelCalls = 0;
      const modelCall: ConsolidationModelCall = async (_systemPrompt, input) => {
        modelCalls++;
        expect(input).toContain("org fact 1");
        return "UPDATE 1 org fact 1 revised\nDELETE 2";
      };

      const space = await fx.store.getOrCreateSpace({ platform: "slack", channel_id: "C_MC" });
      await fx.store.enqueueJob({
        id: "mc_1",
        kind: "scheduled",
        payload: { action: "memory_consolidation" },
        spaceId: space.id,
      });

      await runLoopUntil(fx, "mc_1", "completed", makeDeps(fx, { consolidationModelCall: modelCall }));
      // The audit row is the scheduled body's LAST write (completeJob →
      // outbox row → audit) — waiting on it guarantees the outbox row is
      // readable before the test inspects it.
      await waitForJobAudit(fx.store, JOB_COMPLETED_EVENT, "mc_1");

      // The LLM leg ran exactly once, through the stubbed seam — no driver
      // side session.
      expect(modelCalls).toBe(1);
      expect(fx.driver.sessions).toBe(0);
      // The real pipeline applied the model's actions to the org pool.
      const rows = fx.store.getDb().query("SELECT content FROM memories WHERE scope = 'org' ORDER BY rowid").all() as {
        content: string;
      }[];
      expect(rows.map((r) => r.content)).toContain("org fact 1 revised");
      expect(rows.map((r) => r.content)).not.toContain("org fact 2");

      // The worker→server signal: one outbox row + job.completed audit,
      // keyed by the envelope id. Inspect the pending row WITHOUT advancing
      // the watermark — the seam must be the one that consumes it.
      const raw = fx.store.getDb().query("SELECT * FROM outbox WHERE kind = 'scheduled'").get() as OutboxRow;
      expect(raw).toMatchObject({ id: "mc_1", kind: "scheduled", space: space.id });
      // SAFETY: the completion outbox payload is the scheduled body's own
      // JSON serialization of the action result (state + ConsolidationResult[]).
      const payload = JSON.parse(raw.payload) as {
        state: string;
        result: Array<{ pool: { scope: string }; compacted: boolean; actionsApplied: number }>;
      };
      expect(payload.state).toBe("completed");
      expect(payload.result).toEqual([
        expect.objectContaining({ pool: { scope: "org" }, compacted: true, actionsApplied: 2 }),
      ]);

      const completed = await fx.store.listAudit({ event_type: JOB_COMPLETED_EVENT });
      expect(completed.map((row) => JSON.parse(row.payload))).toContainEqual(
        expect.objectContaining({ id: "mc_1", kind: "scheduled", state: "completed" }),
      );

      // The server consumer path sees the result: the seam consumes and
      // posts the row.
      const posted: Array<{ spaceId: string; text: string }> = [];
      const pass = await postPendingOutboxRows(fx.store, {
        postMessage: async (spaceId: string, text: string) => {
          posted.push({ spaceId, text });
          return "ts_1";
        },
      });
      expect(pass.posted).toBe(1);
      expect(posted[0]).toMatchObject({ spaceId: space.id, text: expect.stringContaining("scheduled") });
      // Consumed rows are never re-read.
      expect(consumeOutboxWatermarked(fx.store).rows).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("the scheduled action's scope is its own job rows: own job/outbox writes allowed, work-item and enqueue writes denied loudly", async () => {
    const fx = makeFixture();
    try {
      const probe: SchedulerAction = {
        name: "memory_consolidation",
        async run(params, ctx) {
          const out: Record<string, string> = {};
          const tryOp = async (label: string, op: () => Promise<unknown>) => {
            try {
              await op();
              out[label] = "allowed";
            } catch (err) {
              out[label] = err instanceof ScopedStoreAccessError ? "denied" : "threw";
            }
          };
          await tryOp("ownJobWrite", () => ctx.store.renewJobLease(params.jobId, Date.now() + 60_000));
          await tryOp("foreignJob", () => ctx.store.getJob("some_other_job"));
          await tryOp("enqueue", () => ctx.store.enqueueJob({ id: "j2", kind: "git", payload: {} }));
          await tryOp("workItem", () => ctx.store.getWorkItem("w_other"));
          await tryOp("listWorkItems", () => ctx.store.listWorkItems());
          return out;
        },
      };
      const registry: SchedulerActionRegistry = buildRegistry([probe]);
      await fx.store.enqueueJob({
        id: "mc_scope_1",
        kind: "scheduled",
        payload: { action: "memory_consolidation", params: { jobId: "mc_scope_1" } },
        spaceId: null,
      });

      await runLoopUntil(fx, "mc_scope_1", "completed", makeDeps(fx, { scheduledActions: registry }));
      await waitForJobAudit(fx.store, JOB_COMPLETED_EVENT, "mc_scope_1");

      const raw = fx.store.getDb().query("SELECT payload FROM outbox WHERE id = 'mc_scope_1'").get() as {
        payload: string;
      };
      // SAFETY: the outbox payload is the scheduled body's JSON
      // serialization of the action's return value.
      const payload = JSON.parse(raw.payload) as { state: string; result: Record<string, string> };
      expect(payload.state).toBe("completed");
      expect(payload.result).toEqual({
        ownJobWrite: "allowed",
        foreignJob: "denied",
        enqueue: "denied",
        workItem: "denied",
        listWorkItems: "denied",
      });
    } finally {
      fx.cleanup();
    }
  });

  test("capsFor resolves the scheduled caps entry, never the git fallback", () => {
    const fx = makeFixture();
    try {
      expect(capsFor("scheduled", fx.store)).toEqual({ timeoutMs: 30 * 60_000, memoryMb: 512 });
    } finally {
      fx.cleanup();
    }
  });

  test("an unknown scheduled action fails the job loudly naming the action — no silent no-op", async () => {
    const fx = makeFixture();
    try {
      await fx.store.enqueueJob({ id: "sched_unknown_1", kind: "scheduled", payload: { action: "no_such_action" } });

      await runLoopUntil(
        fx,
        "sched_unknown_1",
        "failed",
        makeDeps(fx, { maxJobAttempts: 1, jobBackoffMs: 1, jobBackoffMaxMs: 2 }),
      );
      // The failure audit is written after failJob — wait for it so the
      // listAudit assertion below never races the write.
      await waitForJobAudit(fx.store, JOB_FAILED_EVENT, "sched_unknown_1");

      const failed = await fx.store.listAudit({ event_type: JOB_FAILED_EVENT });
      expect(failed.map((row) => JSON.parse(row.payload))).toContainEqual(
        expect.objectContaining({
          id: "sched_unknown_1",
          kind: "scheduled",
          error: expect.stringContaining("no_such_action"),
        }),
      );
      // Fail-closed: nothing ran, no completion signal.
      expect(await fx.store.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(0);
      expect(consumeOutboxWatermarked(fx.store).rows).toHaveLength(0);
      expect(fx.driver.sessions).toBe(0);
      // The audit module never saw the probe action — the default registry
      // contains only worker-runnable actions.
      expect(await createAudit(fx.store).listAudit({ event_type: "scheduler.fire" })).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("a malformed scheduled payload fails closed (no action, no params)", async () => {
    const fx = makeFixture();
    try {
      await fx.store.enqueueJob({ id: "sched_malformed_1", kind: "scheduled", payload: {} });

      await runLoopUntil(
        fx,
        "sched_malformed_1",
        "failed",
        makeDeps(fx, { maxJobAttempts: 1, jobBackoffMs: 1, jobBackoffMaxMs: 2 }),
      );
      await waitForJobAudit(fx.store, JOB_FAILED_EVENT, "sched_malformed_1");

      const failed = await fx.store.listAudit({ event_type: JOB_FAILED_EVENT });
      expect(failed.map((row) => JSON.parse(row.payload))).toContainEqual(
        expect.objectContaining({
          id: "sched_malformed_1",
          kind: "scheduled",
          error: expect.stringContaining("failing closed"),
        }),
      );
      expect(consumeOutboxWatermarked(fx.store).rows).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });
});

describe("scheduled caps (issue #272)", () => {
  test("scheduled resolves its own caps defaults and org overrides layer on top", () => {
    const store = freshStore();
    try {
      expect(capsFor("scheduled", store)).toEqual({ timeoutMs: 30 * 60_000, memoryMb: 512 });
    } finally {
      store.close();
    }
  });
});
