import { afterAll, describe, expect, test } from "bun:test";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudit, type AuditModule } from "../policy/audit";
import { isKnownTool, resolveTier } from "../policy/config";
import {
  SCHEDULER_JOB_CREATED_EVENT,
  SCHEDULER_JOB_DELETED_EVENT,
} from "../store/audit-events";
import { createStore, type Store } from "../store/db";
import { buildRegistry } from "./actions";
import { nextCronFire } from "./cron";
import {
  createSchedulerJobArgsSchema,
  deleteSchedulerJobArgsSchema,
  schedulerToolDefinitions,
} from "./scheduler-tools";
import type { SchedulerActionRegistry, SchedulerJob } from "./types";

const dir = mkdtempSync(join(tmpdir(), "bottega-scheduler-store-"));
const stores: Store[] = [];

afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const store = createStore(join(dir, `${stores.length}.db`));
  stores.push(store);
  return store;
}

/** The session-file → space-id ctx seam (issue #220): the file name IS the space id. */
function ctxFor(spaceId: string | undefined): ExtensionContext {
  // SAFETY: create_scheduler_job reads only sessionManager.getSessionFile();
  // the rest of ExtensionContext is never touched, so the widened cast is safe.
  return {
    sessionManager: {
      getSessionFile: (): string | undefined =>
        spaceId === undefined ? undefined : join("/tmp/sessions", `${spaceId}.jsonl`),
    },
  } as ExtensionContext;
}

function createToolFor(
  store: Store,
  audit: AuditModule,
  registry: SchedulerActionRegistry,
): ToolDefinition<typeof createSchedulerJobArgsSchema> {
  const create = schedulerToolDefinitions(store, audit, registry).find(
    (definition) => definition.name === "create_scheduler_job",
  ) as ToolDefinition<typeof createSchedulerJobArgsSchema> | undefined;
  if (!create) throw new Error("create_scheduler_job definition missing");
  return create;
}

function textOf(result: AgentToolResult): string {
  return result.content.find((block) => block.type === "text")?.text ?? "";
}

function jobBody(result: AgentToolResult): SchedulerJob & { summary: string } {
  return JSON.parse(textOf(result)) as SchedulerJob & { summary: string };
}

describe("scheduler job store (issue #86)", () => {
  test("creates and round-trips a durable job", async () => {
    const store = freshStore();
    const job = await store.createSchedulerJob({
      action: "standup_digest",
      cron: "0 9 * * 1-5",
      params: { format: "short" },
      spaceId: "slack:C1",
      createdBy: "U1",
    });

    expect(job.id).toMatch(/^sj_/);
    expect(job.action).toBe("standup_digest");
    expect(job.params).toEqual({ format: "short" });
    expect(job.spaceId).toBe("slack:C1");
    expect(job.createdBy).toBe("U1");
    expect(job.nextFireAt).toBe(nextCronFire(job.cron, job.createdAt));
    expect(job.lastFiredAt).toBeNull();
    expect(job.lastResult).toBeNull();
    expect(job.enabled).toBe(true);
    expect(await store.getSchedulerJob(job.id)).toEqual(job);
    expect(await store.listSchedulerJobs()).toEqual([job]);
  });

  test("rejects unknown actions and malformed cron without writing", async () => {
    const store = freshStore();
    await expect(
      store.createSchedulerJob({ action: "shell", cron: "* * * * *", createdBy: "U1" }),
    ).rejects.toThrow(/unknown scheduler action/i);
    await expect(
      store.createSchedulerJob({ action: "reflection", cron: "not cron", createdBy: "U1" }),
    ).rejects.toThrow(/invalid cron/i);
    expect(await store.listSchedulerJobs()).toEqual([]);
  });

  test("deletes jobs and reports whether a row existed", async () => {
    const store = freshStore();
    const job = await store.createSchedulerJob({ action: "reflection", cron: "0 0 * * *", createdBy: "U1" });
    expect(await store.deleteSchedulerJob(job.id)).toBe(true);
    expect(await store.deleteSchedulerJob(job.id)).toBe(false);
    expect(await store.getSchedulerJob(job.id)).toBeNull();
  });

  test("updates next fire, marks a result, and toggles enabled", async () => {
    const store = freshStore();
    const job = await store.createSchedulerJob({ action: "org_pulse", cron: "0 * * * *", createdBy: "U1" });
    const manualNext = Date.UTC(2030, 0, 1, 12, 0);
    await store.updateSchedulerNextFire(job.id, manualNext);
    expect((await store.getSchedulerJob(job.id))?.nextFireAt).toBe(manualNext);

    const firedAt = Date.UTC(2030, 0, 1, 12, 0);
    await store.markSchedulerFired(job.id, "error", firedAt);
    const fired = await store.getSchedulerJob(job.id);
    expect(fired?.lastFiredAt).toBe(firedAt);
    expect(fired?.lastResult).toBe("error");
    expect(fired?.nextFireAt).toBe(nextCronFire(job.cron, firedAt));

    await store.setSchedulerJobEnabled(job.id, false);
    expect((await store.getSchedulerJob(job.id))?.enabled).toBe(false);
    await expect(store.updateSchedulerNextFire("sj_missing", manualNext)).rejects.toThrow(/not found/i);
  });

  test("rejects duplicate action registrations", () => {
    const action = { name: "reflection" as const, run: async () => {} };
    expect(() => buildRegistry([action, action])).toThrow(/duplicate scheduler action/i);
  });

  test("scheduler administration tools are known at their intended policy tiers", () => {
    expect(isKnownTool("create_scheduler_job")).toBe(true);
    expect(resolveTier("create_scheduler_job")).toBe("exec");
    expect(resolveTier("list_scheduler_jobs")).toBe("read");
    expect(isKnownTool("delete_scheduler_job")).toBe(true);
    expect(resolveTier("delete_scheduler_job")).toBe("exec");
  });

  test("admin tools validate the registry and audit create/delete rows", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const registry = buildRegistry([
      { name: "standup_digest", run: async () => {} },
    ]);
    const definitions = schedulerToolDefinitions(store, audit, registry);
    // SAFETY: schedulerToolDefinitions registers these two tools by name;
    // find() narrows to the union of all definitions, and the registered
    // ones are exactly the create/delete definitions with these schemas.
    const create = definitions.find((definition) => definition.name === "create_scheduler_job") as
      | ToolDefinition<typeof createSchedulerJobArgsSchema>
      | undefined;
    // SAFETY: same invariant as create — delete_scheduler_job is registered
    // with the delete args schema by schedulerToolDefinitions.
    const remove = definitions.find((definition) => definition.name === "delete_scheduler_job") as
      | ToolDefinition<typeof deleteSchedulerJobArgsSchema>
      | undefined;
    if (!create || !remove) throw new Error("scheduler tool definition missing");
    // SAFETY: scheduler tool executes never read their ExtensionContext;
    // undefined stands in for the unused parameter position.
    const unusedContext = undefined as never;

    const unavailable = await create.execute(
      "call-unavailable",
      { action: "reflection", cron: "0 9 * * *" },
      new AbortController().signal,
      () => {},
      unusedContext,
    );
    expect(unavailable.isError).toBe(true);
    expect(await store.listSchedulerJobs()).toEqual([]);
    expect(await audit.listAudit()).toEqual([]);

    const result = await create.execute(
      "call-create",
      { action: "standup_digest", cron: "0 9 * * *", params: { style: "brief" }, space: "slack:C1" },
      new AbortController().signal,
      () => {},
      unusedContext,
    );
    expect(result.isError).not.toBe(true);
    const job = (await store.listSchedulerJobs())[0];
    expect(job?.createdBy).toBe("agent");

    const deleted = await remove.execute(
      "call-delete",
      { id: job!.id },
      new AbortController().signal,
      () => {},
      unusedContext,
    );
    expect(deleted.isError).not.toBe(true);

    const rows = await audit.listAudit();
    expect(rows.map((row) => row.event_type)).toEqual([
      SCHEDULER_JOB_CREATED_EVENT,
      SCHEDULER_JOB_DELETED_EVENT,
    ]);
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      id: job!.id,
      action: "standup_digest",
      cron: "0 9 * * *",
      space_id: "slack:C1",
    });
    expect(JSON.parse(rows[1]!.payload)).toEqual({ id: job!.id });
  });
});

describe("create_scheduler_job surface (issue #220)", () => {
  test("defaults a space-scoped job's destination to the conversation space from the tool ctx", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const create = createToolFor(
      store,
      audit,
      buildRegistry([{ name: "recurring_work", run: async () => {} }]),
    );

    const result = await create.execute(
      "call-derive",
      {
        action: "recurring_work",
        cron: "0 10 * * *",
        description: "Daily repository digest",
        schedule: "every day at 10:00",
      },
      new AbortController().signal,
      () => {},
      ctxFor("slack:C1"),
    );

    expect(result.isError).not.toBe(true);
    const body = jobBody(result);
    expect(body.spaceId).toBe("slack:C1");
    expect(body.params.space).toBe("slack:C1");
    expect(body.params.description).toBe("Daily repository digest");
    expect(body.summary).toBe("every day at 10:00 → this conversation: Daily repository digest");
    expect(await store.getSchedulerJob(body.id)).toMatchObject({ spaceId: "slack:C1" });
  });

  test("honors an explicit space and presents it in the summary without any ctx", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const create = createToolFor(
      store,
      audit,
      buildRegistry([{ name: "standup_digest", run: async () => {} }]),
    );

    const result = await create.execute(
      "call-explicit",
      { action: "standup_digest", cron: "0 9 * * 1-5", description: "Monday standup", space: "slack:C42" },
      new AbortController().signal,
      () => {},
      ctxFor(undefined),
    );

    expect(result.isError).not.toBe(true);
    const body = jobBody(result);
    expect(body.spaceId).toBe("slack:C42");
    expect(body.summary).toBe("weekdays at 09:00 UTC → space slack:C42: Monday standup");
  });

  test("renders the schedule label from the cron when no schedule hint is given", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const create = createToolFor(
      store,
      audit,
      buildRegistry([{ name: "recurring_work", run: async () => {} }]),
    );

    const result = await create.execute(
      "call-cron-label",
      { action: "recurring_work", cron: "*/5 * * * *", description: "Health check" },
      new AbortController().signal,
      () => {},
      ctxFor("slack:C1"),
    );

    expect(result.isError).not.toBe(true);
    expect(jobBody(result).summary).toBe("every 5 minutes → this conversation: Health check");
  });

  test("fails closed with a clear remedy when the destination is underivable", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const create = createToolFor(
      store,
      audit,
      buildRegistry([{ name: "reflection", run: async () => {} }]),
    );

    const result = await create.execute(
      "call-underivable",
      { action: "reflection", cron: "0 0 * * *" },
      new AbortController().signal,
      () => {},
      ctxFor(undefined),
    );

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/without a destination/);
    expect(text).toMatch(/space/);
    expect(await store.listSchedulerJobs()).toEqual([]);
    expect(await audit.listAudit()).toEqual([]);
  });

  test("keeps org_pulse org-wide even when a space is passed", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const create = createToolFor(
      store,
      audit,
      buildRegistry([{ name: "org_pulse", run: async () => {} }]),
    );

    const result = await create.execute(
      "call-pulse",
      { action: "org_pulse", cron: "0 9 * * 1", space: "slack:C1" },
      new AbortController().signal,
      () => {},
      ctxFor(undefined),
    );

    expect(result.isError).not.toBe(true);
    const body = jobBody(result);
    expect(body.spaceId).toBeNull();
    expect(body.params.space).toBeUndefined();
    expect(body.summary).toBe("Mondays at 09:00 UTC → org-wide: org_pulse");
  });
});
