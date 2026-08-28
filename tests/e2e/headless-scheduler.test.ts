/**
 * Headless scheduler journeys for issue #363: exercise durable cron claims,
 * admin lifecycle controls, worker outbox delivery, and reactive effects
 * against the real store/audit/memory stack with only Slack kept in-process.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ReactiveCore } from "../../src/events/reactive";
import { buildRegistry } from "../../src/scheduler/actions";
import { tickScheduler, type SchedulerTickDeps } from "../../src/scheduler/runner";
import { sendMessageAction } from "../../src/scheduler/send-message";
import { schedulerToolDefinitions } from "../../src/scheduler/scheduler-tools";
import type { SchedulerAction, SchedulerActionRegistry } from "../../src/scheduler/types";
import {
  SCHEDULER_ERROR_EVENT,
  SCHEDULER_FIRE_EVENT,
} from "../../src/store/audit-events";
import { postOutboxRow } from "../../src/store/outbox";
import { postPendingOutboxRows } from "../../src/server/services/outbox-post-seam";
import { createMemoryReactiveStorage, startReactiveCore } from "../../src/events/reactive";
import { bootHarness, type Harness } from "./harness";
import type { JsonObject } from "../../src/extensions/manifest";

const SPACE_ID = "slack:C-HEADLESSOPS";
const CHANNEL_ID = "C-HEADLESSOPS";
const BASE_TIME = Date.UTC(2026, 7, 27, 12, 0, 0);

const jsonObjectSchema = z.record(z.string(), z.unknown());
const schedulerJobSchema = z
  .object({
    id: z.string(),
    revision: z.number(),
    enabled: z.boolean(),
    nextFireAt: z.number(),
  })
  .passthrough();
const runNowSchema = z.object({
  invocationId: z.string(),
  enqueued: z.boolean(),
  status: z.enum(["pending", "running", "completed"]),
  jobId: z.string(),
});

type SchedulerCallArgs = {
  id?: string;
  expected_revision?: number;
  action?: string;
  description?: string;
  schedule?: string;
  cron?: string;
  params?: Record<string, string>;
  space?: string;
  invocation_id?: string;
};

type OutboxStatusRow = { status: string; attempts: number; posted_at: number | null };

function schedulerDeps(
  h: Harness,
  registry: SchedulerActionRegistry,
  now: () => number,
): SchedulerTickDeps {
  return {
    store: h.store,
    audit: h.audit,
    registry,
    memoryProvider: h.memory,
    postMessage: (spaceId, text, opts) => h.adapter.postMessage(spaceId, text, opts),
    loadPolicy: async () => h.orgPolicy,
    log: () => {},
    now,
  };
}
function context(spaceId: string): ExtensionContext {
  // SAFETY: the scheduler tool context only reads sessionManager.getSessionFile;
  // this minimal fixture intentionally implements that dependency.
  return {
    sessionManager: {
      getSessionFile: () => `/tmp/headless-scheduler/${spaceId}.jsonl`,
    },
  } as ExtensionContext;
}

function tool(definitions: ToolDefinition[], name: string): ToolDefinition {
  const found = definitions.find((definition) => definition.name === name);
  if (!found) throw new Error(`missing scheduler tool: ${name}`);
  return found;
}

async function callTool(
  definitions: ToolDefinition[],
  name: string,
  args: SchedulerCallArgs,
  spaceId = SPACE_ID,
  invocationId = `headless-${name}`,
): Promise<AgentToolResult> {
  return tool(definitions, name).execute(
    invocationId,
    args,
    new AbortController().signal,
    () => {},
    context(spaceId),
  );
}

function toolBody<T>(result: AgentToolResult, schema: z.ZodType<T>): T {
  const part = result.content.find((candidate) => candidate.type === "text");
  if (!part || part.type !== "text") throw new Error("scheduler tool returned no text");
  return schema.parse(JSON.parse(part.text));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const waiter = Promise.withResolvers<void>();
  const poll = (): void => {
    if (predicate()) {
      waiter.resolve();
      return;
    }
    if (Date.now() >= deadline) {
      waiter.reject(new Error("timed out waiting for headless scheduler effect"));
      return;
    }
    setTimeout(poll, 5);
  };
  poll();
  await waiter.promise;
}

function auditPayload(row: { payload: string }): JsonObject {
  // SAFETY: the scheduler audit payload schema validates the parsed response
  // as a JSON object before projecting it into the shared JSON domain.
  return jsonObjectSchema.parse(JSON.parse(row.payload)) as JsonObject;
}

describe("headless scheduler and outbox (issue #363)", () => {
  test("fires send_message at its cron occurrence and does not duplicate a cadence", async () => {
    const h = await bootHarness({ headless: true });
    try {
      const job = await h.store.createSchedulerJob({
        action: "send_message",
        cron: "*/5 * * * *",
        params: { text: "headless scheduled reminder" },
        spaceId: SPACE_ID,
        createdBy: "U-headless-human",
        createdAt: BASE_TIME,
      });
      const registry = buildRegistry([sendMessageAction]);
      let now = BASE_TIME;
      let fired = false;
      for (let i = 0; i < 100; i += 1) {
        await tickScheduler(schedulerDeps(h, registry, () => now));
        const messages = h.messages(CHANNEL_ID);
        if (messages.some((message) => message.text === "headless scheduled reminder")) {
          fired = true;
          break;
        }
        now += 60_000;
      }
      expect(fired).toBe(true);
      expect(h.messages(CHANNEL_ID).filter((message) => message.text === "headless scheduled reminder")).toHaveLength(1);
      expect((await h.store.getSchedulerJob(job.id))?.lastResult).toBe("ok");
      const fireRows = await h.audit.listAudit({ event_type: SCHEDULER_FIRE_EVENT });
      expect(fireRows).toHaveLength(1);
      expect(auditPayload(fireRows[0]!)).toMatchObject({ action: "send_message", result: "ok", source: "scheduled" });

      await tickScheduler(schedulerDeps(h, registry, () => now));
      expect(h.messages(CHANNEL_ID).filter((message) => message.text === "headless scheduled reminder")).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  test("disables an unknown action and audits the scheduler error without posting", async () => {
    const h = await bootHarness({ headless: true });
    try {
      h.store
        .getDb()
        .query(
          `INSERT INTO scheduler_jobs
           (id, action, cron, params, space_id, created_by, created_at, next_fire_at, enabled)
           VALUES (?, ?, ?, '{}', ?, ?, ?, ?, 1)`,
        )
        .run("sj_headless_unknown", "removed_headless_action", "* * * * *", SPACE_ID, "U-headless-human", BASE_TIME - 1_000, BASE_TIME);

      await tickScheduler(schedulerDeps(h, buildRegistry([]), () => BASE_TIME));

      expect((await h.store.getSchedulerJob("sj_headless_unknown"))?.enabled).toBe(false);
      expect(h.messages(CHANNEL_ID)).toEqual([]);
      const errors = await h.audit.listAudit({ event_type: SCHEDULER_ERROR_EVENT });
      expect(errors).toHaveLength(1);
      expect(auditPayload(errors[0]!)).toEqual({
        id: "sj_headless_unknown",
        action: "removed_headless_action",
        error: "unknown scheduler action: removed_headless_action",
      });
    } finally {
      await h.cleanup();
    }
  });

  test("keeps a throwing action enabled and records an error for each resumable occurrence", async () => {
    const h = await bootHarness({ headless: true });
    try {
      const throwingAction: SchedulerAction = {
        name: "reflection",
        run: async () => {
          throw new Error("headless action failed");
        },
      };
      h.store
        .getDb()
        .query(
          `INSERT INTO scheduler_jobs
           (id, action, cron, params, space_id, created_by, created_at, next_fire_at, enabled)
           VALUES (?, ?, ?, '{}', ?, ?, ?, ?, 1)`,
        )
        .run("sj_headless_throwing", "reflection", "* * * * *", SPACE_ID, "U-headless-human", BASE_TIME - 1_000, BASE_TIME);
      const registry = buildRegistry([throwingAction]);

      await tickScheduler(schedulerDeps(h, registry, () => BASE_TIME));
      const afterFirst = await h.store.getSchedulerJob("sj_headless_throwing");
      expect(afterFirst).toMatchObject({ enabled: true, lastResult: "error", nextFireAt: BASE_TIME + 60_000 });
      expect(h.messages(CHANNEL_ID)).toEqual([]);

      await tickScheduler(schedulerDeps(h, registry, () => BASE_TIME + 60_000));
      expect((await h.store.getSchedulerJob("sj_headless_throwing"))?.enabled).toBe(true);
      expect(await h.audit.listAudit({ event_type: SCHEDULER_ERROR_EVENT })).toHaveLength(2);
    } finally {
      await h.cleanup();
    }
  });

  test("runs now, honors pause and resume, then deletes through scheduler admin tools", async () => {
    const h = await bootHarness({ headless: true });
    try {
      const registry = buildRegistry([sendMessageAction]);
      let adminNow = BASE_TIME;
      const definitions = schedulerToolDefinitions(h.store, h.audit, registry, {
        actor: "U-headless-human",
        now: () => adminNow,
      });
      const created = toolBody(
        await callTool(
          definitions,
          "create_scheduler_job",
          { action: "send_message", cron: "0 * * * *", params: { text: "admin lifecycle message" } },
          SPACE_ID,
          "create-headless-job",
        ),
        schedulerJobSchema,
      );
      expect(created.enabled).toBe(true);

      const runNow = toolBody(
        await callTool(
          definitions,
          "run_scheduler_job_now",
          { id: created.id, expected_revision: created.revision, invocation_id: "headless-run-now" },
          SPACE_ID,
          "run-headless-job",
        ),
        runNowSchema,
      );
      expect(runNow).toMatchObject({ enqueued: true, status: "pending", jobId: created.id });
      await tickScheduler(schedulerDeps(h, registry, () => BASE_TIME));
      expect(h.messages(CHANNEL_ID).filter((message) => message.text === "admin lifecycle message")).toHaveLength(1);

      const paused = toolBody(
        await callTool(
          definitions,
          "pause_scheduler_job",
          { id: created.id, expected_revision: created.revision },
          SPACE_ID,
          "pause-headless-job",
        ),
        schedulerJobSchema,
      );
      await tickScheduler(schedulerDeps(h, registry, () => BASE_TIME + 60 * 60_000));
      expect(h.messages(CHANNEL_ID).filter((message) => message.text === "admin lifecycle message")).toHaveLength(1);
      adminNow = BASE_TIME + 2 * 60 * 60_000;

      const resumed = toolBody(
        await callTool(
          definitions,
          "resume_scheduler_job",
          { id: created.id, expected_revision: paused.revision },
          SPACE_ID,
          "resume-headless-job",
        ),
        schedulerJobSchema,
      );
      await tickScheduler(schedulerDeps(h, registry, () => resumed.nextFireAt));
      expect(h.messages(CHANNEL_ID).filter((message) => message.text === "admin lifecycle message")).toHaveLength(2);

      const deleted = await callTool(
        definitions,
        "delete_scheduler_job",
        { id: created.id },
        SPACE_ID,
        "delete-headless-job",
      );
      expect(deleted.isError).not.toBe(true);
      expect(await h.store.getSchedulerJob(created.id)).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  test("posts scheduled outbox rows once and consumes them idempotently", async () => {
    const h = await bootHarness({ headless: true });
    try {
      const createdAt = BASE_TIME;
      postOutboxRow(
        h.store,
        {
          id: "headless-scheduled-outbox",
          kind: "scheduled",
          payload: { state: "done", result: { summary: "queued scheduled result" } },
          space: SPACE_ID,
        },
        { now: () => createdAt },
      );

      const first = await postPendingOutboxRows(h.store, h.adapter, { now: () => createdAt + 1_000 });
      expect(first).toEqual({ posted: 1, nudged: 0 });
      expect(h.messages(CHANNEL_ID).map((message) => message.text)).toEqual(["scheduled Done: queued scheduled result"]);
      // SAFETY: this SELECT projects exactly the OutboxStatusRow columns and
      // aliases them to the fields asserted below.
      const row = h.store.getDb().query("SELECT status, attempts, posted_at FROM outbox WHERE id = ?").get("headless-scheduled-outbox") as OutboxStatusRow;
      expect(row.status).toBe("posted");

      const second = await postPendingOutboxRows(h.store, h.adapter, { now: () => createdAt + 2_000 });
      expect(second).toEqual({ posted: 0, nudged: 0 });
      expect(h.messages(CHANNEL_ID)).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  test("reactive core posts an effect for a newly appended matching audit event and stops cleanly", async () => {
    const h = await bootHarness({ headless: true });
    let core: ReactiveCore | undefined;
    try {
      core = startReactiveCore(
        h.store,
        [
          {
            id: "headless-scheduler-effect",
            events: [SCHEDULER_FIRE_EVENT],
            react: async (row) => {
              await h.adapter.postMessage(SPACE_ID, `reactive effect for audit ${row.id}`);
              return { handled: true };
            },
          },
        ],
        { intervalMs: 5, storage: createMemoryReactiveStorage() },
      );
      core.start();
      await h.audit.appendAudit({
        space_id: SPACE_ID,
        actor: "headless-test",
        event_type: SCHEDULER_FIRE_EVENT,
        payload: { action: "send_message", result: "ok" },
      });
      await waitFor(() => h.messages(CHANNEL_ID).some((message) => message.text.startsWith("reactive effect for audit ")));
      expect(h.messages(CHANNEL_ID)).toHaveLength(1);
    } finally {
      core?.stop();
      await h.cleanup();
    }
  });
});
