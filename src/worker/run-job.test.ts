import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExecutor, type ExecutorDeps } from "../executor";
import { jobEgressDomains, hostFromBaseUrl, BASE_EGRESS_DOMAINS } from "../egress/generate";
import type { IngestEvent, Poller } from "../ingest/types";
import { createAudit } from "../policy/audit";
import { postPendingOutboxRows } from "../server/services/outbox-post-seam";
import { createStore, type Store } from "../store/db";
import { INGEST_POLL_DISPATCH_EVENT, WORK_ITEM_CREATED_EVENT } from "../store/audit-events";
import { consumeOutboxWatermarked } from "../store/outbox";
import type { OutboxRow } from "../store/outbox";
import { resolveKindCaps } from "./caps";
import { createJobScopedStore, jobScopeFromEnvelope, ScopedStoreAccessError } from "./scoped-store";
import type { WorkerJob } from "./envelope";

const stores: Store[] = [];
const dirs: string[] = [];

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
    // job. The facade's get-trap replaces these with loud denies at RUNTIME,
    // so the test calls them through a narrow cast that accepts any shape.
    const sandbox = scoped as unknown as {
      enqueueJob: (input: object) => never;
      claimNextJob: (leaseMs: number) => never;
      markStaleWorkItems: (...args: unknown[]) => never;
    };
    expect(() => sandbox.enqueueJob({ id: "j", kind: "git", payload: {} })).toThrow(ScopedStoreAccessError);
    expect(() => sandbox.claimNextJob(60_000)).toThrow(ScopedStoreAccessError);
    expect(() => sandbox.markStaleWorkItems()).toThrow(ScopedStoreAccessError);
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
    // The extension default is 15m / 512MB; unknown kinds resolve to git's caps.
    expect(resolveKindCaps("extension", null).timeoutMs).toBe(15 * 60_000);
    expect(resolveKindCaps("scheduled", null)).toEqual(git);
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
      store,
      // SAFETY: ingest_poll jobs never touch memory or a driver — stubs.
      memoryProvider: undefined as never,
      driver: undefined as never,
      orgConfigDir: join(dir, "config"),
      transcriptDir: join(dir, "transcripts"),
      pollIntervalMs: 10,
      ingestPollers: { github: () => poller },
      onDelivery: async () => null,
    };

    await store.enqueueJob({ id: "poll_1", kind: "ingest_poll", payload: { provider: "github" }, spaceId: space.id });
    const ac = new AbortController();
    const run = runExecutor(deps, ac.signal);
    try {
      await waitFor(() => jobStatus(store, "poll_1").then((s) => s === "completed"));
    } finally {
      ac.abort();
      await run.catch(() => {});
    }

    // The worker's fetch/validate leg wrote its ingest_poll outbox row.
    // Inspect WITHOUT advancing the watermark — the seam must be the one
    // that consumes it.
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
