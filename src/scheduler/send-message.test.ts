import { afterEach, describe, expect, test } from "bun:test";
import type { AuditModule } from "../policy/audit";
import { createAudit } from "../policy/audit";
import { SCHEDULER_ERROR_EVENT } from "../store/audit-events";
import { createStore, type Store } from "../store/db";
import { buildRegistry, KNOWN_ACTIONS } from "./actions";
import { tickScheduler, type SchedulerTickDeps } from "./runner";
import { createSchedulerJobArgsSchema } from "./scheduler-tools";
import { sendMessageAction } from "./send-message";
import type { SchedulerActionContext } from "./types";

type AuditInput = Parameters<AuditModule["appendAudit"]>[0];

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function freshStore(): Store {
  const store = createStore(":memory:");
  stores.push(store);
  return store;
}

function context(overrides: { postError?: Error } = {}) {
  const postCalls: Array<[string, string]> = [];
  const audits: AuditInput[] = [];
  const ctx: SchedulerActionContext = {
    store: freshStore(),
    audit: {
      async appendAudit(entry) {
        audits.push(entry);
        return audits.length;
      },
      async listAudit() {
        return [];
      },
    },
    memoryProvider: {
      async save() {
        throw new Error("send_message must not save memory");
      },
      async search() {
        return [];
      },
    },
    async postMessage(spaceId, text) {
      if (overrides.postError) throw overrides.postError;
      postCalls.push([spaceId, text]);
      return "msg_1";
    },
    async loadPolicy() {
      throw new Error("send_message must not load policy");
    },
    log() {},
    now: () => Date.UTC(2026, 7, 17, 12),
  };
  return { ctx, postCalls, audits };
}

describe("sendMessageAction (issue #220)", () => {
  test("exports the typed send_message scheduler surface", () => {
    expect(sendMessageAction.name).toBe("send_message");
    expect(KNOWN_ACTIONS).toContain("send_message");
    expect(
      createSchedulerJobArgsSchema.parse({
        action: "send_message",
        cron: "0 15 * * *",
        params: { text: "Time for your afternoon standup", space: "slack:C1" },
      }).action,
    ).toBe("send_message");
  });

  test("posts the message text directly to the bound space (no executor round-trip)", async () => {
    const { ctx, postCalls } = context();

    await sendMessageAction.run({ text: "Remind me to hydrate", space: "slack:C1" }, ctx);

    expect(postCalls).toEqual([["slack:C1", "Remind me to hydrate"]]);
  });

  test("fires through the runner and posts to the job's bound space when params omit space", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const fireTime = Date.UTC(2026, 7, 17, 15, 0);
    const postCalls: Array<[string, string]> = [];
    const registry = buildRegistry([sendMessageAction]);
    const job = await store.createSchedulerJob({
      action: "send_message",
      cron: "0 15 * * *",
      params: { text: "Reminder: hydrate" },
      spaceId: "slack:C2",
      createdBy: "U1",
    });
    await store.updateSchedulerNextFire(job.id, fireTime);

    const deps: SchedulerTickDeps = {
      store,
      audit,
      registry,
      memoryProvider: {
        async save() {
          throw new Error("unused memory save");
        },
        async search() {
          return [];
        },
      },
      async postMessage(spaceId, text) {
        postCalls.push([spaceId, text]);
        return "msg_1";
      },
      // SAFETY: send_message never resolves a policy.
      loadPolicy: async () => undefined as never,
      log() {},
      now: () => fireTime,
    };
    await tickScheduler(deps);

    expect(postCalls).toEqual([["slack:C2", "Reminder: hydrate"]]);
    expect((await store.getSchedulerJob(job.id))?.lastResult).toBe("ok");
  });

  test("fails closed for missing text or space without posting", async () => {
    const { ctx, postCalls, audits } = context();

    await sendMessageAction.run({ space: "slack:C1" }, ctx);
    await sendMessageAction.run({ text: "Lonely message" }, ctx);

    expect(postCalls).toEqual([]);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actor: "scheduler:send_message",
      event_type: SCHEDULER_ERROR_EVENT,
      payload: { action: "send_message", error: "text is required" },
    });
    expect(audits[1]).toMatchObject({
      actor: "scheduler:send_message",
      event_type: SCHEDULER_ERROR_EVENT,
      payload: { action: "send_message", error: "space is required" },
    });
  });

  test("audits a posting failure and never throws it past the runner", async () => {
    const { ctx, postCalls, audits } = context({ postError: new Error("slack unavailable") });

    await expect(sendMessageAction.run({ text: "Hello", space: "slack:C1" }, ctx)).resolves.toBeUndefined();

    expect(postCalls).toEqual([]);
    expect(audits).toEqual([
      {
        space_id: "slack:C1",
        actor: "scheduler:send_message",
        event_type: SCHEDULER_ERROR_EVENT,
        payload: { action: "send_message", error: "failed to post scheduled message: slack unavailable" },
      },
    ]);
  });
});
