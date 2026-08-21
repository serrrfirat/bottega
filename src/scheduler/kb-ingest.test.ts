import { afterAll, describe, expect, test } from "bun:test";
import type { MemoryProvider } from "../memory/types";
import { createAudit, type AuditModule } from "../policy/audit";
import { SCHEDULER_ERROR_EVENT } from "../store/audit-events";
import { createStore, type Store } from "../store/db";
import { KNOWN_ACTIONS } from "./actions";
import { kbIngestAction } from "./kb-ingest";
import { createSchedulerJobArgsSchema } from "./scheduler-tools";
import type { SchedulerActionContext } from "./types";
import { z } from "zod";

const stores: Store[] = [];

const unusedMemory: MemoryProvider = {
  capabilities: { consolidation: "unsupported", digestPruning: "unsupported" },
  async pruneDigests() {
    throw new Error("kb ingest action must not prune memory");
  },
  async save() {
    throw new Error("kb ingest action must not save memory (the worker does)");
  },
  async search() {
    return [];
  },
};

afterAll(() => {
  for (const store of stores.splice(0)) store.close();
});

function freshStore(): Store {
  const store = createStore(":memory:");
  stores.push(store);
  return store;
}

function context(store: Store, audit: AuditModule, logs: string[] = []): SchedulerActionContext {
  return {
    store,
    audit,
    memoryProvider: unusedMemory,
    async postMessage() {
      throw new Error("kb ingest action must not post directly");
    },
    async loadPolicy() {
      throw new Error("kb ingest action must not load policy directly");
    },
    log(line) {
      logs.push(line);
    },
    now: () => Date.UTC(2026, 7, 18, 12),
  };
}

function queuedKbJobs(store: Store): Array<{ id: string; payload: { url: string } }> {
  // SAFETY: the SELECT reads exactly the worker_jobs columns the row mapping
  // below uses; the store's enqueueJob is the only writer in these tests.
  const rows = store
    .getDb()
    .query("SELECT id, payload FROM worker_jobs WHERE kind = 'kb' ORDER BY created_at")
    .all() as Array<{ id: string; payload: string }>;
  return rows.map((row) => {
    const parsed = z.object({ url: z.string() }).safeParse(JSON.parse(row.payload));
    if (!parsed.success) throw new Error(`unexpected kb job payload: ${parsed.error.message}`);
    return { id: row.id, payload: parsed.data };
  });
}

describe("kbIngestAction", () => {
  test("exports the typed scheduled kb-refresh surface", () => {
    const action = kbIngestAction({ sources: [] });
    expect(action.name).toBe("kb_ingest");
    expect(KNOWN_ACTIONS).toContain("kb_ingest");
    expect(
      createSchedulerJobArgsSchema.parse({
        action: "kb_ingest",
        cron: "0 6 * * *",
        params: { source: "handbook" },
      }).action,
    ).toBe("kb_ingest");
  });

  test("dispatches one kind=kb job per declared source, payload {url}", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const action = kbIngestAction({
      sources: [
        { id: "handbook", url: "https://docs.example.com/handbook", type: "html" },
        { id: "runbook", url: "https://docs.example.com/runbook", type: "markdown" },
      ],
    });

    await action.run({}, context(store, audit));

    const jobs = queuedKbJobs(store);
    expect(jobs.map((job) => job.payload.url).sort()).toEqual([
      "https://docs.example.com/handbook",
      "https://docs.example.com/runbook",
    ]);
    // Fresh envelope ids: kb_<source>_<uuid>, unique per dispatch.
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
    expect(jobs.every((job) => /^kb_[a-z0-9._-]+_[0-9a-f-]{36}$/.test(job.id))).toBe(true);
    for (const job of jobs) {
      const row = await store.getJob(job.id);
      expect(row).toMatchObject({ kind: "kb", status: "queued" });
      // No space on the envelope → the row's space_id is NULL (org-wide).
      expect(row!.spaceId).toBeUndefined();
    }
  });

  test("params.source narrows the dispatch to one source; params.space threads onto the envelope", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const action = kbIngestAction({
      sources: [
        { id: "handbook", url: "https://docs.example.com/handbook", type: "html" },
        { id: "runbook", url: "https://docs.example.com/runbook", type: "html" },
      ],
    });

    await action.run({ source: "runbook", space: "slack:C1" }, context(store, audit));

    const jobs = queuedKbJobs(store);
    expect(jobs.map((job) => job.payload.url)).toEqual(["https://docs.example.com/runbook"]);
    expect(await store.getJob(jobs[0]!.id)).toMatchObject({ kind: "kb", spaceId: "slack:C1" });
  });

  test("fails closed for an unknown source id — audited, nothing dispatched", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const action = kbIngestAction({
      sources: [{ id: "handbook", url: "https://docs.example.com/handbook", type: "html" }],
    });

    await expect(action.run({ source: "missing" }, context(store, audit))).resolves.toBeUndefined();

    expect(queuedKbJobs(store)).toHaveLength(0);
    const errors = await audit.listAudit({ event_type: SCHEDULER_ERROR_EVENT });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      actor: "scheduler:kb_ingest",
      payload: JSON.stringify({
        action: "kb_ingest",
        error: "failed to dispatch KB ingest: unknown KB source: missing",
      }),
    });
  });

  test("fails closed when no sources are configured — audited, nothing dispatched", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const action = kbIngestAction({ sources: [] });

    await expect(action.run({}, context(store, audit))).resolves.toBeUndefined();

    expect(queuedKbJobs(store)).toHaveLength(0);
    const errors = await audit.listAudit({ event_type: SCHEDULER_ERROR_EVENT });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.payload).toContain("no KB sources configured (config/kb.yml)");
  });

  test("audits an enqueue failure and never throws it past the scheduler runner", async () => {
    const audits: Array<Parameters<AuditModule["appendAudit"]>[0]> = [];
    // SAFETY: the fake implements only enqueueJob — the only Store method
    // kbIngestAction exercises through ctx.store.
    const failingStore = {
      async enqueueJob(_input: Parameters<Store["enqueueJob"]>[0]): Promise<void> {
        throw new Error("database unavailable");
      },
    } as Store;
    const audit: AuditModule = {
      async appendAudit(entry) {
        audits.push(entry);
        return audits.length;
      },
      async listAudit() {
        return [];
      },
    };
    const action = kbIngestAction({
      sources: [{ id: "handbook", url: "https://docs.example.com/handbook", type: "html" }],
    });

    await expect(action.run({}, context(failingStore, audit))).resolves.toBeUndefined();

    expect(audits).toEqual([
      {
        space_id: null,
        actor: "scheduler:kb_ingest",
        event_type: SCHEDULER_ERROR_EVENT,
        payload: { action: "kb_ingest", error: "failed to dispatch KB ingest: database unavailable" },
      },
    ]);
  });

  test("dispatches a fresh job per fire; the scheduler skip policy prevents accidental replay", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const action = kbIngestAction({
      sources: [{ id: "handbook", url: "https://docs.example.com/handbook", type: "html" }],
    });

    await action.run({}, context(store, audit));
    await action.run({}, context(store, audit));

    const jobs = queuedKbJobs(store);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
  });
});
