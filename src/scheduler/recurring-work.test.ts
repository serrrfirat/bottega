import { afterEach, describe, expect, test } from "bun:test";
import type { MemoryProvider } from "../memory/types";
import { createAudit, type AuditModule } from "../policy/audit";
import { SCHEDULER_ERROR_EVENT, WORK_ITEM_CREATED_EVENT } from "../store/audit-events";
import { createStore, type AuditRow, type Store, type WorkItem } from "../store/db";
import { KNOWN_ACTIONS } from "./actions";
import { recurringWorkAction } from "./recurring-work";
import { createSchedulerJobArgsSchema } from "./scheduler-tools";
import type { SchedulerActionContext } from "./types";

type AuditInput = Parameters<AuditModule["appendAudit"]>[0];

const stores: Store[] = [];

const unusedMemory: MemoryProvider = {
  async save() {
    throw new Error("recurring work must not save memory");
  },
  async search() {
    return [];
  },
};

afterEach(() => {
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
      throw new Error("recurring work must not post directly");
    },
    async loadPolicy() {
      throw new Error("recurring work must not load policy directly");
    },
    log(line) {
      logs.push(line);
    },
    now: () => Date.UTC(2026, 7, 17, 12),
  };
}

function payload(row: AuditRow): Record<string, unknown> {
  return JSON.parse(row.payload) as Record<string, unknown>;
}

function fakeContext(options: { createError?: Error } = {}): {
  ctx: SchedulerActionContext;
  createCalls: Array<Parameters<Store["createWorkItem"]>[0]>;
  audits: AuditInput[];
} {
  const createCalls: Array<Parameters<Store["createWorkItem"]>[0]> = [];
  const audits: AuditInput[] = [];
  const store = {
    async createWorkItem(input: Parameters<Store["createWorkItem"]>[0]) {
      createCalls.push(input);
      if (options.createError) throw options.createError;
      return { id: "wi_fake" } as WorkItem;
    },
  } as unknown as Store;
  const audit: AuditModule = {
    async appendAudit(entry) {
      audits.push(entry);
      return audits.length;
    },
    async listAudit() {
      return [];
    },
  };
  return { ctx: context(store, audit), createCalls, audits };
}

describe("recurringWorkAction", () => {
  test("exports the typed recurring-work scheduler surface", () => {
    expect(recurringWorkAction.name).toBe("recurring_work");
    expect(KNOWN_ACTIONS).toContain("recurring_work");
    expect(
      createSchedulerJobArgsSchema.parse({
        action: "recurring_work",
        cron: "0 9 * * 1",
        params: { space: "slack:C1", description: "Prepare the weekly ops report" },
      }).action,
    ).toBe("recurring_work");
  });

  test("creates exactly one extension item and relies on the store's creation audit", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_OPS" });

    await recurringWorkAction.run(
      { space: `  ${space.id}  `, description: "  Prepare the weekly ops report  ", requester: "U_OPS" },
      context(store, audit),
    );

    const rows = await audit.listAudit({ event_type: WORK_ITEM_CREATED_EVENT });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.space_id).toBe(space.id);
    expect(rows[0]?.actor).toBe("U_OPS");
    const created = payload(rows[0]!);
    expect(created.requester).toBe("U_OPS");
    const item = await store.getWorkItem(created.id as string);
    expect(item).toMatchObject({
      space_id: space.id,
      requester: "U_OPS",
      description: "Prepare the weekly ops report",
      delivery: "extension",
      state: "open",
      repo: null,
    });
  });

  test("defaults the requester to scheduler", async () => {
    const { ctx, createCalls } = fakeContext();

    await recurringWorkAction.run({ space: "slack:C1", description: "Sync CRM contacts" }, ctx);

    expect(createCalls).toEqual([
      {
        space_id: "slack:C1",
        requester: "scheduler",
        description: "Sync CRM contacts",
        delivery: "extension",
      },
    ]);
  });

  const invalidCases: Array<{ label: string; params: Record<string, string>; error: string }> = [
    { label: "missing space", params: { description: "Prepare report" }, error: "space is required" },
    { label: "blank space", params: { space: "  ", description: "Prepare report" }, error: "space is required" },
    { label: "missing description", params: { space: "slack:C1" }, error: "description is required" },
    { label: "blank description", params: { space: "slack:C1", description: "\t" }, error: "description is required" },
  ];

  for (const invalid of invalidCases) {
    test(`fails closed for ${invalid.label}`, async () => {
      const { ctx, createCalls, audits } = fakeContext();

      await expect(recurringWorkAction.run(invalid.params, ctx)).resolves.toBeUndefined();

      expect(createCalls).toHaveLength(0);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actor: "scheduler:recurring_work",
        event_type: SCHEDULER_ERROR_EVENT,
        payload: { action: "recurring_work", error: invalid.error },
      });
    });
  }

  test("audits a creation failure and never throws it past the scheduler runner", async () => {
    const { ctx, createCalls, audits } = fakeContext({ createError: new Error("database unavailable") });

    await expect(
      recurringWorkAction.run({ space: "slack:C1", description: "Sync CRM contacts" }, ctx),
    ).resolves.toBeUndefined();

    expect(createCalls).toHaveLength(1);
    expect(audits).toEqual([
      {
        space_id: "slack:C1",
        actor: "scheduler:recurring_work",
        event_type: SCHEDULER_ERROR_EVENT,
        payload: {
          action: "recurring_work",
          error: "failed to create recurring work item: database unavailable",
        },
      },
    ]);
  });

  test("creates one item per manual fire; scheduler skip policy prevents accidental replay", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C_CRM" });
    const params = { space: space.id, description: "Sync CRM contacts" };

    await recurringWorkAction.run(params, context(store, audit));
    await recurringWorkAction.run(params, context(store, audit));

    const rows = await audit.listAudit({ event_type: WORK_ITEM_CREATED_EVENT });
    expect(rows).toHaveLength(2);
    const ids = rows.map((row) => payload(row).id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(await store.getWorkItem(id as string)).toMatchObject({
        delivery: "extension",
        description: "Sync CRM contacts",
        requester: "scheduler",
      });
    }
  });
});
