import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runExecutor, type ExecutorConfig, type ExecutorDeps } from "../executor";
import { jobEgressDomains, hostFromBaseUrl, BASE_EGRESS_DOMAINS } from "../egress/generate";
import type { IngestEvent, Poller } from "../ingest/types";
import { createAudit } from "../policy/audit";
import { postPendingOutboxRows } from "../server/services/outbox-post-seam";
import { createStore, type Store } from "../store/db";
import { INGEST_POLL_DISPATCH_EVENT, WORK_ITEM_CREATED_EVENT } from "../store/audit-events";
import { consumeOutboxWatermarked } from "../store/outbox";
import type { OutboxRow } from "../store/outbox";
import { resolveKindCaps, type JobResourceCaps } from "./caps";
import { createJobScopedStore, jobScopeFromEnvelope, ScopedStoreAccessError } from "./scoped-store";
import type { WorkerJob } from "./envelope";
import type { SchedulerAction, SchedulerActionName, SchedulerActionRegistry } from "../scheduler/types";
import {
  inProcessSandboxRunner,
  runJobInSandbox,
  runJobSandboxBody,
  runScheduledJobBody,
  unstickWorkItem,
  SANDBOX_EXIT_COMPLETED,
  SANDBOX_EXIT_FAILED,
  SANDBOX_EXIT_REQUEUE,
  type SandboxRunner,
} from "./run-job";
import { JOB_COMPLETED_EVENT, JOB_FAILED_EVENT } from "../store/audit-events";

const stores: Store[] = [];
const dirs: string[] = [];

const failedAuditPayloadSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    error: z.string(),
    sandbox_crash: z.boolean().optional(),
  })
  .passthrough();

const TEST_CAPS = { timeoutMs: 60_000, memoryMb: 64 } satisfies JobResourceCaps;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "bottega-worker-"));
  dirs.push(dir);
  const store = createStore(join(dir, "store.db"));
  stores.push(store);
  return store;
}

describe("job-scoped store facade (issue #101)", () => {
  test("forwards own rows and DENIES cross-job rows loudly", async () => {
    const store = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    const item = await store.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "mine",
      delivery: "git",
      repo: "acme/sandbox",
    });
    const scope = { jobId: "job_1", workItemId: item.id };
    const scoped = createJobScopedStore(store, scope);

    // Own rows forward unchanged.
    await scoped.claimWorkItemById(item.id, "executor");
    expect((await scoped.getWorkItem(item.id))?.assignee).toBe("executor");

    // Another job's row is a loud deny, never a silent no-op.
    expect(() => scoped.getJob("job_other")).toThrow(ScopedStoreAccessError);
    expect(() => scoped.completeJob("job_other")).toThrow(ScopedStoreAccessError);
    expect(() => scoped.getWorkItem("item_other")).toThrow(ScopedStoreAccessError);
    expect(() => scoped.transitionWorkItem("item_other", "open", "working")).toThrow(ScopedStoreAccessError);

    // The sandbox may not enqueue, claim, or sweep — that is the boss loop's
    // job. The facade's get-trap replaces these with loud denies at RUNTIME.
    // SAFETY: createJobScopedStore proxies the original Store and exposes these
    // boss-only names solely as throwing deny functions; the test invokes only
    // those functions and assumes no other hidden Store member.
    const sandbox = scoped as Pick<Store, "enqueueJob" | "claimNextJob" | "markStaleWorkItems">;
    expect(() => sandbox.enqueueJob({ id: "j", kind: "git", payload: {} })).toThrow(ScopedStoreAccessError);
    expect(() => sandbox.claimNextJob(60_000)).toThrow(ScopedStoreAccessError);
    expect(() => sandbox.markStaleWorkItems()).toThrow(ScopedStoreAccessError);
  });

  test("two concurrent scopes cannot read or mutate each other's rows", async () => {
    const store = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_CONCURRENT" });
    const [first, second] = await Promise.all([
      store.createWorkItem({ space_id: space.id, requester: "U1", description: "first", delivery: "git" }),
      store.createWorkItem({ space_id: space.id, requester: "U2", description: "second", delivery: "git" }),
    ]);
    const firstStore = createJobScopedStore(store, { jobId: first.id, workItemId: first.id });
    const secondStore = createJobScopedStore(store, { jobId: second.id, workItemId: second.id });

    const claims = await Promise.all([
      firstStore.claimWorkItemById(first.id, "executor:first"),
      secondStore.claimWorkItemById(second.id, "executor:second"),
    ]);

    expect(claims.map((item) => item?.id).sort()).toEqual([first.id, second.id].sort());
    expect(() => firstStore.getWorkItem(second.id)).toThrow(ScopedStoreAccessError);
    expect(() => secondStore.transitionWorkItem(first.id, "claimed", "working")).toThrow(ScopedStoreAccessError);
  });

  test("jobScopeFromEnvelope re-derives ONLY the job's own item, failing closed", () => {
    const git: WorkerJob = {
      id: "job_1",
      kind: "git",
      payload: { workItemId: "item_1" },
      spaceId: "s",
      attempts: 0,
      leaseUntil: 0,
      status: "queued",
    };
    expect(jobScopeFromEnvelope(git)).toEqual({ jobId: "job_1", workItemId: "item_1" });
    // A git job that fails to name its item gets NO work-item scope at all.
    expect(jobScopeFromEnvelope({ ...git, kind: "git", payload: {} })).toEqual({
      jobId: "job_1",
      workItemId: null,
    });
    expect(jobScopeFromEnvelope({ ...git, kind: "kb", payload: {} })).toEqual({ jobId: "job_1", workItemId: null });
    // Scheduled jobs (issue #272) own no store work item — the facade's
    // work-item guards are inert, and the job row guard is the firewall.
    expect(jobScopeFromEnvelope({ ...git, kind: "scheduled", payload: { action: "memory_consolidation" } })).toEqual({
      jobId: "job_1",
      workItemId: null,
    });
  });
});

describe("per-job egress subsets (issue #101)", () => {
  const BASE: string[] = [...BASE_EGRESS_DOMAINS];

  test("git jobs get the repo + tunnel hosts; default-deny holds without them", () => {
    expect(jobEgressDomains("git")).toEqual(BASE);
    expect(jobEgressDomains("git", { repoHost: "github.com", tunnelHost: "tunnel.example" })).toEqual([
      ...BASE,
      "github.com",
      "tunnel.example",
    ]);
    expect(hostFromBaseUrl("https://github.com/acme/sandbox")).toBe("github.com");
  });

  test("extension/kb subsets add only their declared hosts; ingest_poll adds none", () => {
    expect(jobEgressDomains("extension", { extensionHosts: ["mcp.linear.app", "api.notion.com"] })).toEqual([
      ...BASE,
      "mcp.linear.app",
      "api.notion.com",
    ]);
    expect(jobEgressDomains("kb", { kbHosts: ["kb.example"] })).toEqual([...BASE, "kb.example"]);
    expect(jobEgressDomains("ingest_poll")).toEqual(BASE);
  });
});

describe("resource caps (issue #101)", () => {
  test("documented defaults apply; org overrides are layered and clamped fail-closed", () => {
    const git = resolveKindCaps("git", null);
    expect(git).toEqual({ timeoutMs: 30 * 60_000, memoryMb: 256 });

    // A sane org override is honored...
    expect(resolveKindCaps("git", { git: { timeoutMinutes: 5, memoryMb: 128 } })).toEqual({
      timeoutMs: 5 * 60_000,
      memoryMb: 128,
    });
    // ...but floors hold: below-minimum values fall back to the default.
    expect(resolveKindCaps("git", { git: { timeoutMinutes: 0, memoryMb: 8 } })).toEqual(git);
    // The extension default is 15m / 512MB; the scheduled kind (issue #272)
    // has its own caps entry — never the git fallback.
    expect(resolveKindCaps("extension", null).timeoutMs).toBe(15 * 60_000);
    expect(resolveKindCaps("scheduled", null)).toEqual({ timeoutMs: 30 * 60_000, memoryMb: 512 });
    // Unknown kinds still resolve to git's caps.
    expect(resolveKindCaps("no_such_kind", null)).toEqual(git);
  });
});

describe("ingest_poll split: worker fetches, server dispatch+post stays in-process (issue #101)", () => {
  test("the worker writes an ingest_poll outbox row; the seam dispatches + posts with the server adapter", async () => {
    const store = freshStore();
    const dir = mkdtempSync(join(tmpdir(), "bottega-seam-"));
    dirs.push(dir);
    mkdirSync(join(dir, "config"), { recursive: true });
    mkdirSync(join(dir, "transcripts"), { recursive: true });
    // resolveConfig loads the repo allowlist from org.yml on every boot — the
    // executor authorizes pushes from here, so the fixture must seed it.
    Bun.write(join(dir, "config", "org.yml"), 'git_base_url: "https://github.com"\nrepos:\n  - "acme/sandbox"\n');
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_POLL" });

    const event: IngestEvent = {
      provider: "github",
      eventType: "mention",
      occurredAt: "2026-08-19T00:00:00.000Z",
      payload: {
        kind: "mention",
        repo: "acme/sandbox",
        number: 12,
        isPullRequest: false,
        title: "polled mention",
        url: "https://github.com/acme/sandbox/issues/12",
        body: "can you look",
        author: "U2",
        updatedAt: "2026-08-19T00:00:00.000Z",
      },
    };
    const poller: Poller = { poll: async () => [event] };
    const deps: ExecutorDeps = {
      sandboxRunner: inProcessSandboxRunner(),
      store,
      // SAFETY: ingest_poll execution never enters a memory-provider path.
      memoryProvider: undefined as never,
      // SAFETY: ingest_poll execution never enters an agent-driver path.
      driver: undefined as never,
      orgConfigDir: join(dir, "config"),
      transcriptDir: join(dir, "transcripts"),
      pollIntervalMs: 10,
      ingestPollers: { github: () => poller },
      onDelivery: async () => null,
    };

    await store.enqueueJob({ id: "poll_1", kind: "ingest_poll", payload: { provider: "github" }, spaceId: space.id });
    // Fail-closed boot guard (executor.resolveConfig): a mode-0600 git PAT
    // FILE must exist — never env/image. data/secrets/github-pat is a local
    // dev artifact that CI runners don't have, so this hermetic seam test
    // provisions its own PAT in the temp dir and points the executor at it.
    // The guard still runs (the file must exist and be 0600); the test just
    // stops depending on ambient repo secrets.
    const patFile = join(dir, "secrets", "github-pat");
    mkdirSync(dirname(patFile), { recursive: true });
    writeFileSync(patFile, "ghp_local_test_pat", { mode: 0o600 });
    const prevTokenEnv = process.env.EXECUTOR_GIT_TOKEN_FILE;
    process.env.EXECUTOR_GIT_TOKEN_FILE = patFile;
    const ac = new AbortController();
    const run = runExecutor(deps, ac.signal);
    try {
      await waitFor(() => jobStatus(store, "poll_1").then((s) => s === "completed"));
    } finally {
      if (prevTokenEnv === undefined) delete process.env.EXECUTOR_GIT_TOKEN_FILE;
      else process.env.EXECUTOR_GIT_TOKEN_FILE = prevTokenEnv;
      ac.abort();
      await run.catch(() => {});
    }

    // The worker's fetch/validate leg wrote its ingest_poll outbox row.
    // Inspect WITHOUT advancing the watermark — the seam must be the one
    // that consumes it.
    // SAFETY: This fixed SELECT returns the declared outbox columns, and the
    // outbox schema stores payload as text; get may return null only when the
    // preceding executor run failed, which the assertions intentionally expose.
    const pollRow = store
      .getDb()
      .query("SELECT id, kind, space, payload, status AS status FROM outbox WHERE kind = 'ingest_poll'")
      .get() as OutboxRow & { payload: string };
    expect(pollRow).toBeTruthy();
    expect(pollRow.kind).toBe("ingest_poll");
    expect(pollRow.id).toBe("poll_1");
    expect(pollRow.space).toBe(space.id);
    expect(JSON.parse(pollRow.payload)).toMatchObject({ state: "completed", result: { provider: "github" } });

    // Dispatch + post stay in-process on the SERVER side (the token holder):
    // the seam re-validates and creates the work item + posts via the adapter.
    const posts: Array<{ spaceId: string; text: string }> = [];
    const pass = await postPendingOutboxRows(store, {
      postMessage: async (spaceId: string, text: string) => {
        posts.push({ spaceId, text });
        return "ts_1";
      },
    });
    expect(pass.posted).toBe(1);
    const audit = createAudit(store);
    const dispatched = await audit.listAudit({ event_type: INGEST_POLL_DISPATCH_EVENT });
    expect(dispatched).toHaveLength(1);
    expect(await audit.listAudit({ event_type: WORK_ITEM_CREATED_EVENT })).toHaveLength(1);
    expect(posts).toEqual([
      { spaceId: space.id, text: expect.stringContaining("GitHub mention: polled mention") },
    ]);

    // Consumed rows are never re-read.
    expect((await consumeOutboxWatermarked(store)).rows).toEqual([]);
  });
});

function jobStatus(store: Store, id: string): Promise<string | null> {
  // SAFETY: This fixed SELECT aliases the text status column as s; get is null
  // only when no matching worker_jobs row exists.
  const row = store.getDb().query("SELECT status AS s FROM worker_jobs WHERE id = ?").get(id) as { s: string } | null;
  return Promise.resolve(row?.s ?? null);
}

// Real-time poll-until-condition: the executor loop advances on its own
// wall-clock interval (pollIntervalMs), so fake timers cannot drive it —
// an unavoidable integration-test delay, bounded by a deadline.
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(25);
  }
}

// --- issue #302: boss-loop supervisor (runJobInSandbox) and the sandbox's
// own fail-closed legs, at the module boundary with a real temp store. ---

/** Minimal deps: only the store matters to the supervisor + fail-closed legs under test. */
function minDeps(store: Store): ExecutorDeps {
  return {
    store,
    // SAFETY: These supervisor and fail-closed paths never enter a memory-provider operation.
    memoryProvider: undefined as never,
    // SAFETY: These supervisor and fail-closed paths never enter an agent-driver operation.
    driver: undefined as never,
  };
}

/** A job-claim loop config: only jobLeaseMs is consulted by runJobInSandbox. */
function supervisorCfg(): ExecutorConfig {
  // SAFETY: The exercised supervisor branches read only jobLeaseMs; the
  // scheduled body ignores config, and git-body tests stop before processItem.
  return { jobLeaseMs: 60_000 } as ExecutorConfig;
}

/** Creates a git work item, claims its job row (→ running), and moves the item to working — the mid-flight state the supervisor recoveries assume. */
async function claimedRunningJob(store: Store): Promise<{ job: WorkerJob; itemId: string }> {
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_CLAIM" });
  const item = await store.createWorkItem({
    space_id: space.id,
    requester: "U1",
    description: "mid-flight",
    delivery: "git",
    repo: "acme/sandbox",
  });
  const job = await store.claimNextJob(60_000);
  if (!job) throw new Error("expected a claimable job");
  await store.claimWorkItemById(item.id); // open -> claimed
  await store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
  return { job, itemId: item.id };
}

/** Reads and validates job.failed audit payloads as durable evidence. */
async function failedAuditPayloads(store: Store) {
  const rows = await store.listAudit({ event_type: JOB_FAILED_EVENT });
  return rows.map((row) => failedAuditPayloadSchema.parse(JSON.parse(row.payload)));
}

describe("boss-loop supervisor exit-code contract (issue #302)", () => {
  test("a TIMEOUT tears the run down: job failed loudly, item unstuck, audit names the timeout", async () => {
    const store = freshStore();
    const { job, itemId } = await claimedRunningJob(store);
    const timeoutRunner: SandboxRunner = async () => ({ exitCode: null, signal: null, timedOut: true });

    const outcome = await runJobInSandbox(minDeps(store), supervisorCfg(), job, timeoutRunner);

    // The supervisor maps a timed-out run to a loud failure the sandbox did
    // not write itself — selfReported so the outer loop never doubles it.
    expect(outcome).toEqual({ state: "blocked", result: null, selfReported: true });

    // Durable evidence: the job landed failed, not silently dropped.
    expect(await jobStatus(store, job.id)).toBe("failed");

    // The audit names the timeout explicitly and flags the crash — the
    // operator can tell a timed-out run from a crashed one (issue #149).
    expect((await failedAuditPayloads(store))[0]).toMatchObject({
      id: job.id,
      kind: "git",
      error: "sandbox timeout",
      sandbox_crash: true,
    });

    // The work item never hangs at working: it is unstuck to blocked.
    expect((await store.getWorkItem(itemId))?.state).toBe("blocked");
  });

  test("a signal-killed run fails loudly with the signal named and the item unstuck", async () => {
    const store = freshStore();
    const { job, itemId } = await claimedRunningJob(store);
    const killedRunner: SandboxRunner = async () => ({ exitCode: null, signal: "SIGKILL", timedOut: false });

    const outcome = await runJobInSandbox(minDeps(store), supervisorCfg(), job, killedRunner);

    expect(outcome.state).toBe("blocked");
    expect(await jobStatus(store, job.id)).toBe("failed");
    expect((await failedAuditPayloads(store))[0]).toMatchObject({
      id: job.id,
      error: "sandbox crashed (exit signal SIGKILL)",
      sandbox_crash: true,
    });
    expect((await store.getWorkItem(itemId))?.state).toBe("blocked");
  });

  test("exit 0 and exit 2 map to selfReported done/blocked with NO parent write (the sandbox owns its lifecycle)", async () => {
    // exit 0 → completed; exit 2 → self-failed. In both cases the supervisor
    // must NOT write a second completion/failure — selfReported keeps the
    // outer loop from duplicating the outbox row + audit (issue #101).
    const doneStore = freshStore();
    await doneStore.enqueueJob({ id: "job_done", kind: "git", payload: { workItemId: "wi_done" }, spaceId: "s" });
    const doneJob = await doneStore.claimNextJob(60_000);
    const out0 = await runJobInSandbox(
      minDeps(doneStore),
      supervisorCfg(),
      doneJob!,
      async () => ({ exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false }),
    );
    expect(out0).toEqual({ state: "done", result: null, selfReported: true });
    // The supervisor wrote nothing itself: job row untouched, no audit.
    expect((await doneStore.getJob(doneJob!.id))?.status).toBe("running");
    expect(await doneStore.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(0);
    expect(await doneStore.listAudit({ event_type: JOB_FAILED_EVENT })).toHaveLength(0);

    const failedStore = freshStore();
    await failedStore.enqueueJob({ id: "job_selffailed", kind: "git", payload: { workItemId: "wi_self" }, spaceId: "s" });
    const failedJob = await failedStore.claimNextJob(60_000);
    const out2 = await runJobInSandbox(
      minDeps(failedStore),
      supervisorCfg(),
      failedJob!,
      async () => ({ exitCode: SANDBOX_EXIT_FAILED, signal: null, timedOut: false }),
    );
    expect(out2).toEqual({ state: "blocked", result: null, selfReported: true });
    expect(await failedStore.listAudit({ event_type: JOB_FAILED_EVENT })).toHaveLength(0);
  });

  test("exit 3 (lease-reclaim race) surfaces as a requeue, never a completion — concurrent-claim safety", async () => {
    const store = freshStore();
    const { job } = await claimedRunningJob(store);
    const requeueRunner: SandboxRunner = async () => ({ exitCode: SANDBOX_EXIT_REQUEUE, signal: null, timedOut: false });

    // The supervisor rejects the run so the claim loop requeues with backoff
    // — the item must never be double-executed and never complete here.
    await expect(runJobInSandbox(minDeps(store), supervisorCfg(), job, requeueRunner)).rejects.toThrow(
      /sandbox requested requeue/,
    );
    // No completion signal, no failed audit: the run is purely deferred.
    expect(await store.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(0);
    expect(await store.listAudit({ event_type: JOB_FAILED_EVENT })).toHaveLength(0);
  });
});

describe("runJobSandboxBody fail-closed legs (issue #302)", () => {
  test("a malformed git envelope fails closed before any work — no claim, no release", async () => {
    const store = freshStore();
    const job: WorkerJob = {
      id: "job_malformed",
      kind: "git",
      payload: { notAnId: 42 },
      attempts: 0,
      leaseUntil: 0,
      status: "queued",
    };
    await expect(runJobSandboxBody(minDeps(store), supervisorCfg(), TEST_CAPS, job)).rejects.toThrow(
      /payload must be \{ workItemId \}/,
    );
    // Fail-closed: nothing was claimed, completed, or released.
    expect(await jobStatus(store, job.id)).toBeNull();
    expect(await store.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(0);
  });

  test("a work item already settled elsewhere completes as a no-op with its OWN outbox row (never double-runs)", async () => {
    const store = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_SETTLED" });
    const item = await store.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "already done",
      delivery: "git",
      repo: "acme/sandbox",
    });
    // Settle the item to blocked OUTSIDE the sandbox (another worker failed it).
    await store.claimWorkItemById(item.id);
    await store.transitionWorkItem(item.id, "claimed", "working", { by: "executor:other" });
    await store.transitionWorkItem(item.id, "working", "blocked", { by: "executor:other", evidence: "failed elsewhere" });

    const job: WorkerJob = {
      id: "job_late",
      kind: "git",
      payload: { workItemId: item.id },
      attempts: 0,
      leaseUntil: 0,
      status: "queued",
    };
    const result = await runJobSandboxBody(minDeps(store), supervisorCfg(), TEST_CAPS, job);

    // The late sandbox observes the settlement and completes as a no-op so
    // the server still sees the completion via its own outbox row.
    expect(result).toEqual({ exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false });
    expect((await store.getWorkItem(item.id))?.state).toBe("blocked");
    const { rows } = consumeOutboxWatermarked(store);
    const completion = rows.find((r) => r.id === job.id && r.kind === "git");
    expect(completion).toBeTruthy();
    expect(JSON.parse(completion!.payload)).toMatchObject({ state: "blocked", result: null });
    // The settled item is never re-executed: no session ever ran it.
    expect(await store.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(1);
  });

  test("a lease-reclaim race (item mid-flight under a live owner) requeues instead of running twice", async () => {
    const store = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_RACE" });
    const item = await store.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "claimed elsewhere",
      delivery: "git",
      repo: "acme/sandbox",
    });
    // A live owner holds the item mid-flight (claimed/working under another
    // worker) — the sandbox must NOT double-execute it.
    await store.claimWorkItemById(item.id, "executor:other");
    await store.transitionWorkItem(item.id, "claimed", "working", { by: "executor:other" });

    const job: WorkerJob = {
      id: "job_race",
      kind: "git",
      payload: { workItemId: item.id },
      attempts: 0,
      leaseUntil: 0,
      status: "queued",
    };
    const result = await runJobSandboxBody(minDeps(store), supervisorCfg(), TEST_CAPS, job);

    expect(result).toEqual({ exitCode: SANDBOX_EXIT_REQUEUE, signal: null, timedOut: false });
    expect((await store.getWorkItem(item.id))?.state).toBe("working");
    expect(await store.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(0);
    expect(consumeOutboxWatermarked(store).rows).toHaveLength(0);
  });

  test("a missing work item fails the job loudly through failSelf (blocked item, failed job)", async () => {
    const store = freshStore();
    await store.enqueueJob({ id: "job_missing", kind: "git", payload: { workItemId: "item_does_not_exist" }, spaceId: "s" });
    const job: WorkerJob = {
      id: "job_missing",
      kind: "git",
      payload: { workItemId: "item_does_not_exist" },
      attempts: 0,
      leaseUntil: 0,
      status: "queued",
    };
    const result = await runJobSandboxBody(minDeps(store), supervisorCfg(), TEST_CAPS, job);

    expect(result).toEqual({ exitCode: SANDBOX_EXIT_FAILED, signal: null, timedOut: false });
    expect(await jobStatus(store, job.id)).toBe("failed");
    // The audit names the missing item — durable evidence, never a silent drop.
    expect((await failedAuditPayloads(store))[0]).toMatchObject({ id: job.id, error: expect.stringContaining("not found") });
    // No completion signal: the job failed, nothing completed.
    expect(await store.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(0);
  });
});

describe("unstickWorkItem (issue #302)", () => {
  test("a claimed item is unstuck via claimed->working->blocked; a working item goes straight to blocked", async () => {
    const store = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_UNSTICK" });
    const claimedItem = await store.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "stuck claimed",
      delivery: "git",
      repo: "acme/sandbox",
    });
    await store.claimWorkItemById(claimedItem.id);

    await unstickWorkItem(store, claimedItem.id, "sandbox timeout");
    expect((await store.getWorkItem(claimedItem.id))?.state).toBe("blocked");

    const workingItem = await store.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "stuck working",
      delivery: "git",
      repo: "acme/sandbox",
    });
    await store.claimWorkItemById(workingItem.id);
    await store.transitionWorkItem(workingItem.id, "claimed", "working", { by: "executor" });
    await unstickWorkItem(store, workingItem.id, "sandbox crashed (exit 1)");
    expect((await store.getWorkItem(workingItem.id))?.state).toBe("blocked");
  });

  test("already-terminal items and missing items are left untouched (unstick is a no-op)", async () => {
    const store = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_NOOP" });
    const doneItem = await store.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "already blocked",
      delivery: "git",
      repo: "acme/sandbox",
    });
    await store.claimWorkItemById(doneItem.id);
    await store.transitionWorkItem(doneItem.id, "claimed", "working", { by: "executor" });
    // Working -> blocked is the executor's failure landing; terminal items
    // must be left untouched by unstick.
    await store.transitionWorkItem(doneItem.id, "working", "blocked", { by: "executor", evidence: "done before" });
    await unstickWorkItem(store, doneItem.id, "timeout");
    expect((await store.getWorkItem(doneItem.id))?.state).toBe("blocked");

    // A missing item must not throw — the job already failed loudly and the
    // unstick guard is best-effort.
    await expect(unstickWorkItem(store, "missing_item", "timeout")).resolves.toBeUndefined();
  });
});

describe("runScheduledJobBody (issue #302)", () => {
  function actionDeps(store: Store, actions: SchedulerActionRegistry): ExecutorDeps {
    return { ...minDeps(store), scheduledActions: actions };
  }

  function scheduledJob(action: string, params: Record<string, string> | undefined = undefined): WorkerJob {
    return {
      id: "job_sched",
      kind: "scheduled",
      payload: params === undefined ? { action } : { action, params },
      attempts: 0,
      leaseUntil: 0,
      status: "queued",
    };
  }

  test("a successful scheduled action completes through the sandbox: job.completed audit + own outbox row", async () => {
    const store = freshStore();
    const ran: string[] = [];
    const action: SchedulerAction = {
      name: "memory_consolidation",
      run: async (_params, ctx) => {
        ran.push("run");
        await ctx.store.appendAudit({ actor: "sched", event_type: "scheduler.fire", payload: "fired" });
        return { consolidated: 3 };
      },
    };
    const registry = new Map<SchedulerActionName, SchedulerAction>();
    registry.set(action.name, action);

    const result = await runScheduledJobBody(
      actionDeps(store, registry),
      supervisorCfg(),
      TEST_CAPS,
      scheduledJob("memory_consolidation", { spaceId: "s" }),
    );

    expect(result).toEqual({ exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false });
    expect(ran).toEqual(["run"]);
    const completed = await store.listAudit({ event_type: JOB_COMPLETED_EVENT });
    expect(JSON.parse(completed[0].payload)).toMatchObject({ id: "job_sched", kind: "scheduled", state: "completed", result: { consolidated: 3 } });
    const { rows } = consumeOutboxWatermarked(store);
    const completion = rows.find((r) => r.id === "job_sched" && r.kind === "scheduled");
    expect(JSON.parse(completion!.payload)).toMatchObject({ state: "completed", result: { consolidated: 3 } });
  });

  test("an unknown action fails LOUDLY naming it — never a silent no-op (issue #272)", async () => {
    const store = freshStore();
    const registry: SchedulerActionRegistry = new Map();
    // The unknown-action check sits BEFORE the body's try/catch: it throws
    // clean out of the sandbox body so the supervisor crashes the job loudly
    // (job.failed via the boss loop) — never a silent no-op, never a fake
    // completion.
    await expect(
      runScheduledJobBody(actionDeps(store, registry), supervisorCfg(), TEST_CAPS, scheduledJob("standup_digest")),
    ).rejects.toThrow(/unknown action "standup_digest"/);
    // Fail-closed: no completion signal, nothing ran.
    expect(await store.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(0);
    expect(consumeOutboxWatermarked(store).rows).toHaveLength(0);
  });

  test("a scheduled action that posts to Slack or loads a policy fails the job loudly (no tokens, no policy context)", async () => {
    const store = freshStore();
    const action: SchedulerAction = {
      name: "memory_consolidation",
      run: async (_params, ctx) => {
        // The ctx seams are hard guards: the worker holds no Slack tokens
        // and no policy context, so these THROW — the action cannot silently
        // reach the outside world.
        ctx.postMessage("C1", "hi");
        return null;
      },
    };
    const registry = new Map<SchedulerActionName, SchedulerAction>();
    registry.set(action.name, action);
    const result = await runScheduledJobBody(
      actionDeps(store, registry),
      supervisorCfg(),
      TEST_CAPS,
      scheduledJob("memory_consolidation"),
    );
    expect(result.exitCode).toBe(SANDBOX_EXIT_FAILED);
    expect((await failedAuditPayloads(store))[0]).toMatchObject({
      id: "job_sched",
      kind: "scheduled",
      error: expect.stringContaining("no tokens"),
    });
    // The loadPolicy seam is equally locked down.
    const policyAction: SchedulerAction = {
      name: "memory_consolidation",
      run: async (_params, ctx) => {
        // loadPolicy is an async seam → must be awaited for the guard to
        // propagate; an un-awaited rejection would silently complete.
        await ctx.loadPolicy("space_x");
        return null;
      },
    };
    const policyRegistry = new Map<SchedulerActionName, SchedulerAction>();
    policyRegistry.set(policyAction.name, policyAction);
    const policyStore = freshStore();
    const policyResult = await runScheduledJobBody(
      actionDeps(policyStore, policyRegistry),
      supervisorCfg(),
      TEST_CAPS,
      scheduledJob("memory_consolidation"),
    );
    expect(policyResult.exitCode).toBe(SANDBOX_EXIT_FAILED);
    expect((await failedAuditPayloads(policyStore))[0]).toMatchObject({
      error: expect.stringContaining("no policy context"),
    });
  });
});

describe("issue #302: malformed git envelope fails closed through the real claim loop, with audit evidence", () => {
  test("a git job with a malformed payload lands failed via job.failed naming the envelope requirement", async () => {
    const store = freshStore();
    const dir = mkdtempSync(join(tmpdir(), "bottega-malformed-"));
    dirs.push(dir);
    mkdirSync(join(dir, "config"), { recursive: true });
    mkdirSync(join(dir, "transcripts"), { recursive: true });
    Bun.write(join(dir, "config", "org.yml"), 'git_base_url: "https://github.com"\nrepos:\n  - "acme/sandbox"\n');
    const patFile = join(dir, "secrets", "github-pat");
    mkdirSync(dirname(patFile), { recursive: true });
    writeFileSync(patFile, "ghp_local_test_pat", { mode: 0o600 });

    await store.enqueueJob({ id: "j_malformed", kind: "git", payload: { notAnId: 42 }, spaceId: "s" });

    const deps: ExecutorDeps = {
      store,
      sandboxRunner: inProcessSandboxRunner(),
      // SAFETY: A malformed git envelope fails before any memory-provider operation.
      memoryProvider: undefined as never,
      // SAFETY: A malformed git envelope fails before any agent-driver operation.
      driver: undefined as never,
      orgConfigDir: join(dir, "config"),
      transcriptDir: join(dir, "transcripts"),
      pollIntervalMs: 10,
      maxJobAttempts: 1,
      jobBackoffMs: 5,
      jobBackoffMaxMs: 10,
    };
    const prevTokenEnv = process.env.EXECUTOR_GIT_TOKEN_FILE;
    process.env.EXECUTOR_GIT_TOKEN_FILE = patFile;
    const ac = new AbortController();
    const run = runExecutor(deps, ac.signal);
    try {
      await waitFor(() => jobStatus(store, "j_malformed").then((s) => s === "failed"));
    } finally {
      if (prevTokenEnv === undefined) delete process.env.EXECUTOR_GIT_TOKEN_FILE;
      else process.env.EXECUTOR_GIT_TOKEN_FILE = prevTokenEnv;
      ac.abort();
      await run.catch(() => {});
    }

    // Fail-closed: the job failed with the envelope requirement named, and
    // nothing completed or released (no double-execute, no false success).
    expect((await failedAuditPayloads(store))[0]).toMatchObject({
      id: "j_malformed",
      kind: "git",
      error: expect.stringContaining("payload must be { workItemId }"),
    });
    expect(await store.listAudit({ event_type: JOB_COMPLETED_EVENT })).toHaveLength(0);
    expect(consumeOutboxWatermarked(store).rows).toHaveLength(0);
  });
});
