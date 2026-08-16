import { afterAll, describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudit } from "../policy/audit";
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
    const create = definitions.find((definition) => definition.name === "create_scheduler_job") as
      | ToolDefinition<typeof createSchedulerJobArgsSchema>
      | undefined;
    const remove = definitions.find((definition) => definition.name === "delete_scheduler_job") as
      | ToolDefinition<typeof deleteSchedulerJobArgsSchema>
      | undefined;
    if (!create || !remove) throw new Error("scheduler tool definition missing");

    const unavailable = await create.execute(
      "call-unavailable",
      { action: "reflection", cron: "0 9 * * *" },
      new AbortController().signal,
      () => {},
      undefined as never,
    );
    expect(unavailable.isError).toBe(true);
    expect(await store.listSchedulerJobs()).toEqual([]);
    expect(await audit.listAudit()).toEqual([]);

    const result = await create.execute(
      "call-create",
      { action: "standup_digest", cron: "0 9 * * *", params: { style: "brief" }, space: "slack:C1" },
      new AbortController().signal,
      () => {},
      undefined as never,
    );
    expect(result.isError).not.toBe(true);
    const job = (await store.listSchedulerJobs())[0];
    expect(job?.createdBy).toBe("agent");

    const deleted = await remove.execute(
      "call-delete",
      { id: job!.id },
      new AbortController().signal,
      () => {},
      undefined as never,
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
