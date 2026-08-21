import { afterAll, describe, expect, test } from "bun:test";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryProvider } from "../memory/types";
import { createAudit } from "../policy/audit";
import {
  SCHEDULER_FIRE_EVENT,
  SCHEDULER_JOB_PAUSED_EVENT,
  SCHEDULER_JOB_RESUMED_EVENT,
  SCHEDULER_JOB_UPDATED_EVENT,
  SCHEDULER_RUN_REQUESTED_EVENT,
} from "../store/audit-events";
import { createStore, type Store } from "../store/db";
import { buildRegistry } from "./actions";
import { nextCronFire } from "./cron";
import { tickScheduler } from "./runner";
import { schedulerToolDefinitions } from "./scheduler-tools";
import type { SchedulerActionRegistry, SchedulerJob } from "./types";

const dir = mkdtempSync(join(tmpdir(), "bottega-scheduler-lifecycle-"));
const stores: Store[] = [];

const memory: MemoryProvider = {
  save: async () => {
    throw new Error("unused memory save");
  },
  search: async () => [],
};

afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const store = createStore(join(dir, `${stores.length}.db`));
  stores.push(store);
  return store;
}

function context(spaceId: string | undefined): ExtensionContext {
  return {
    sessionManager: {
      getSessionFile: () => (spaceId === undefined ? undefined : join("/tmp/sessions", `${spaceId}.jsonl`)),
    },
  } as ExtensionContext;
}

function tool(definitions: ToolDefinition[], name: string): ToolDefinition {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`missing scheduler tool: ${name}`);
  return definition;
}

async function call(
  definitions: ToolDefinition[],
  name: string,
  args: Record<string, unknown>,
  spaceId: string | undefined,
  invocationId = `call-${name}`,
): Promise<AgentToolResult> {
  return tool(definitions, name).execute(
    invocationId,
    args,
    new AbortController().signal,
    () => {},
    context(spaceId),
  );
}

function body<T>(result: AgentToolResult): T {
  const text = result.content.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("scheduler tool returned no text");
  return JSON.parse(text) as T;
}

function runnerDeps(store: Store, registry: SchedulerActionRegistry, now: () => number) {
  return {
    store,
    audit: createAudit(store),
    registry,
    memoryProvider: memory,
    postMessage: async () => undefined,
    loadPolicy: async () => undefined as never,
    log: () => {},
    now,
  };
}

async function createJob(store: Store, spaceId = "slack:C1"): Promise<SchedulerJob> {
  return store.createSchedulerJob({
    action: "send_message",
    cron: "0 * * * *",
    params: { text: "before" },
    spaceId,
    createdBy: "U1",
  });
}

describe("scheduler lifecycle caller surface (issue #308)", () => {
  test("discovers all lifecycle tools and applies partial updates with revision protection", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const now = Date.UTC(2026, 7, 21, 12, 34);
    const registry = buildRegistry([{ name: "send_message", run: async () => {} }]);
    const definitions = schedulerToolDefinitions(store, audit, registry, { now: () => now });
    expect(definitions.map((definition) => definition.name)).toEqual([
      "create_scheduler_job",
      "list_scheduler_jobs",
      "update_scheduler_job",
      "pause_scheduler_job",
      "resume_scheduler_job",
      "run_scheduler_job_now",
      "delete_scheduler_job",
    ]);
    const created = await createJob(store);

    const updatedResult = await call(
      definitions,
      "update_scheduler_job",
      { id: created.id, expected_revision: created.revision, cron: "*/15 * * * *" },
      "slack:C1",
      "update-1",
    );
    expect(updatedResult.isError).not.toBe(true);
    const updated = body<SchedulerJob>(updatedResult);
    expect(updated).toMatchObject({
      id: created.id,
      cron: "*/15 * * * *",
      params: { text: "before" },
      revision: created.revision + 1,
      nextFireAt: nextCronFire("*/15 * * * *", now),
    });

    const stale = await call(
      definitions,
      "update_scheduler_job",
      { id: created.id, expected_revision: created.revision, params: { text: "lost" } },
      "slack:C1",
      "update-stale",
    );
    expect(stale.isError).toBe(true);
    expect(stale.content.find((part) => part.type === "text")?.text).toMatch(/stale revision/i);
    expect((await store.getSchedulerJob(created.id))?.params).toEqual({ text: "before" });

    const rows = await audit.listAudit({ event_type: SCHEDULER_JOB_UPDATED_EVENT });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("agent");
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({
      invocation_id: "update-1",
      before: { revision: created.revision },
      after: { revision: created.revision + 1 },
    });
  });

  test("pauses scheduled claims and resumes from the supplied clock", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    let now = Date.UTC(2026, 7, 21, 12, 0);
    let fires = 0;
    const registry = buildRegistry([{ name: "send_message", run: async () => { fires += 1; } }]);
    const definitions = schedulerToolDefinitions(store, audit, registry, { now: () => now });
    const created = await createJob(store);
    await store.updateSchedulerNextFire(created.id, now);

    const pausedResult = await call(
      definitions,
      "pause_scheduler_job",
      { id: created.id, expected_revision: created.revision },
      "slack:C1",
      "pause-1",
    );
    const paused = body<SchedulerJob>(pausedResult);
    expect(paused.enabled).toBe(false);
    await tickScheduler(runnerDeps(store, registry, () => now));
    expect(fires).toBe(0);

    now += 37 * 60_000;
    const resumedResult = await call(
      definitions,
      "resume_scheduler_job",
      { id: created.id, expected_revision: paused.revision },
      "slack:C1",
      "resume-1",
    );
    const resumed = body<SchedulerJob>(resumedResult);
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextFireAt).toBe(nextCronFire(created.cron, now));
    expect((await audit.listAudit({ event_type: SCHEDULER_JOB_PAUSED_EVENT })).length).toBe(1);
    expect((await audit.listAudit({ event_type: SCHEDULER_JOB_RESUMED_EVENT })).length).toBe(1);
  });

  test("run-now deduplicates one invocation through the durable claim/fire path without moving the cron", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const now = Date.UTC(2026, 7, 21, 12, 5);
    let fires = 0;
    const registry = buildRegistry([{ name: "send_message", run: async () => { fires += 1; } }]);
    const definitions = schedulerToolDefinitions(store, audit, registry, { now: () => now });
    const created = await createJob(store);
    const recurringNext = created.nextFireAt;
    const args = {
      id: created.id,
      expected_revision: created.revision,
      invocation_id: "manual-check-1",
    };

    const [first, repeated] = await Promise.all([
      call(definitions, "run_scheduler_job_now", args, "slack:C1", "run-call-1"),
      call(definitions, "run_scheduler_job_now", args, "slack:C1", "run-call-2"),
    ]);
    expect(body<{ invocationId: string }>(first).invocationId).toBe("manual-check-1");
    expect(body<{ invocationId: string }>(repeated).invocationId).toBe("manual-check-1");
    expect((await store.getSchedulerJob(created.id))?.nextFireAt).toBe(recurringNext);

    await tickScheduler(runnerDeps(store, registry, () => now));
    await tickScheduler(runnerDeps(store, registry, () => now));
    expect(fires).toBe(1);
    expect((await store.getSchedulerJob(created.id))?.nextFireAt).toBe(recurringNext);
    expect(await audit.listAudit({ event_type: SCHEDULER_RUN_REQUESTED_EVENT })).toHaveLength(1);
    const fireRows = await audit.listAudit({ event_type: SCHEDULER_FIRE_EVENT });
    expect(fireRows).toHaveLength(1);
    expect(JSON.parse(fireRows[0]!.payload)).toMatchObject({
      id: created.id,
      invocation_id: "manual-check-1",
      source: "manual",
      result: "ok",
    });
  });

  test("a fire claimed before an edit uses its snapshot while the edit changes future fires", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const now = Date.UTC(2026, 7, 21, 12, 0);
    let release: (() => void) | undefined;
    const started = Promise.withResolvers<Record<string, string>>();
    const registry = buildRegistry([
      {
        name: "send_message",
        run: async (params) => {
          started.resolve(params);
          await new Promise<void>((resolve) => { release = resolve; });
        },
      },
    ]);
    const definitions = schedulerToolDefinitions(store, audit, registry, { now: () => now });
    const created = await createJob(store);
    await store.updateSchedulerNextFire(created.id, now);

    const ticking = tickScheduler(runnerDeps(store, registry, () => now));
    expect(await started.promise).toEqual({ text: "before", space: "slack:C1" });
    const current = await store.getSchedulerJob(created.id);
    const editedResult = await call(
      definitions,
      "update_scheduler_job",
      { id: created.id, expected_revision: current!.revision, params: { text: "after" } },
      "slack:C1",
      "edit-during-fire",
    );
    expect(editedResult.isError).not.toBe(true);
    release?.();
    await ticking;
    expect((await store.getSchedulerJob(created.id))?.params).toEqual({ text: "after" });
  });
  test("overlapping runners atomically claim one scheduled occurrence", async () => {
    const path = join(dir, `overlap-${stores.length}.db`);
    const firstStore = createStore(path);
    const secondStore = createStore(path);
    stores.push(firstStore, secondStore);
    const now = Date.UTC(2026, 7, 21, 12);
    let fires = 0;
    const registry = buildRegistry([
      {
        name: "send_message",
        run: async () => {
          fires += 1;
        },
      },
    ]);
    const job = await createJob(firstStore);
    await firstStore.updateSchedulerNextFire(job.id, now);

    await Promise.all([
      tickScheduler(runnerDeps(firstStore, registry, () => now)),
      tickScheduler(runnerDeps(secondStore, registry, () => now)),
    ]);

    expect(fires).toBe(1);
    expect(await firstStore.listSchedulerInvocations({ jobId: job.id })).toHaveLength(1);
  });


  test("fails closed for foreign, deleted, stale, and invalid-action jobs", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const registry = buildRegistry([{ name: "send_message", run: async () => {} }]);
    const definitions = schedulerToolDefinitions(store, audit, registry, { now: () => 1_800_000_000_000 });
    const foreign = await createJob(store, "slack:C2");
    const scopedList = await call(definitions, "list_scheduler_jobs", {}, "slack:C1", "list-own-space");
    expect(body<SchedulerJob[]>(scopedList)).toEqual([]);

    const denied = await call(
      definitions,
      "pause_scheduler_job",
      { id: foreign.id, expected_revision: foreign.revision },
      "slack:C1",
      "foreign-pause",
    );
    expect(denied.isError).toBe(true);
    expect((await store.getSchedulerJob(foreign.id))?.enabled).toBe(true);

    const authorityChecks: string[] = [];
    const authorized = schedulerToolDefinitions(store, audit, registry, {
      now: () => 1_800_000_000_000,
      authorizeCrossSpace: async (request) => {
        authorityChecks.push(`${request.sessionSpaceId}->${request.targetSpaceId}`);
        return true;
      },
    });
    const approvedResult = await call(
      authorized,
      "pause_scheduler_job",
      { id: foreign.id, expected_revision: foreign.revision },
      "slack:C1",
      "org-approved-pause",
    );
    const approved = body<SchedulerJob>(approvedResult);
    expect(approved.enabled).toBe(false);
    expect(authorityChecks).toEqual(["slack:C1->slack:C2"]);

    store.getDb().query("UPDATE scheduler_jobs SET action = 'removed_action' WHERE id = ?").run(foreign.id);
    const invalid = await call(
      definitions,
      "run_scheduler_job_now",
      { id: foreign.id, expected_revision: approved.revision, invocation_id: "invalid-action" },
      "slack:C2",
    );
    expect(invalid.isError).toBe(true);
    expect(await store.listSchedulerInvocations({ jobId: foreign.id })).toEqual([]);

    expect(await store.deleteSchedulerJob(foreign.id)).toBe(true);
    const deleted = await call(
      definitions,
      "resume_scheduler_job",
      { id: foreign.id, expected_revision: approved.revision },
      "slack:C2",
      "deleted-resume",
    );
    expect(deleted.isError).toBe(true);
    expect(await store.listSchedulerInvocations({ jobId: foreign.id })).toEqual([]);
  });
});
