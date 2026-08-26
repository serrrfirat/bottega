import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudit } from "../../policy/audit";
import { SCHEDULER_JOB_PAUSED_EVENT, SCHEDULER_RUN_REQUESTED_EVENT } from "../../store/audit-events";
import { createStore, type Store } from "../../store/db";
import {
  buildSchedulerBlocks,
  resolveSchedulerAction,
  schedulerActionValue,
} from "./scheduler-router";
import {
  SCHEDULER_PAUSE_ACTION_ID,
  SCHEDULER_RESUME_ACTION_ID,
  SCHEDULER_RUN_NOW_ACTION_ID,
  type SlackAction,
  type SlackAdapter,
} from "./slack";

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): Store {
  const dir = mkdtempSync(join(tmpdir(), "bottega-scheduler-slack-"));
  dirs.push(dir);
  const value = createStore(join(dir, "test.db"));
  stores.push(value);
  return value;
}

function adapter() {
  const updates: Array<{ spaceId: string; ts: string; text: string; blocks: unknown[] }> = [];
  const value = {
    postMessage: async () => undefined,
    updateMessage: async (spaceId, ts, text, options) => {
      updates.push({ spaceId, ts, text, blocks: options?.blocks ?? [] });
    },
    downloadFile: async () => { throw new Error("unused"); },
    uploadFile: async () => undefined,
    addReaction: async () => {},
    removeReaction: async () => {},
    startStream: async () => undefined,
    appendText: async () => {},
    appendTask: async () => {},
    stopStream: async () => {},
    isChannelMember: async () => true,
    postEphemeral: async () => {},
    streamingSupported: () => false,
    start: async () => {},
    stop: async () => {},
  } satisfies SlackAdapter;
  return { value, updates };
}

function click(actionId: string, value: string): SlackAction {
  return {
    actionId,
    value,
    spaceId: "slack:C1",
    principal: "U42",
    messageTs: "1700.0001",
  };
}

describe("Slack scheduler controls (issue #308)", () => {
  test("renders deterministic enabled/paused state with only valid controls", async () => {
    const db = store();
    const enabled = await db.createSchedulerJob({
      action: "send_message",
      cron: "0 9 * * 1-5",
      params: { description: "Daily status" },
      spaceId: "slack:C1",
      createdBy: "U1",
    });
    const paused = await db.createSchedulerJob({
      action: "reflection",
      cron: "0 17 * * *",
      params: { description: "Reflect" },
      spaceId: "slack:C1",
      createdBy: "U1",
    });
    const pausedRow = await db.pauseSchedulerJob(paused.id, paused.revision);

    const blocks = buildSchedulerBlocks([enabled, pausedRow]);
    const actions = blocks.filter((block) => block.type === "actions");
    expect(actions).toHaveLength(2);
    expect(actions[0]?.elements?.map((element) => element.action_id)).toEqual([
      SCHEDULER_PAUSE_ACTION_ID,
      SCHEDULER_RUN_NOW_ACTION_ID,
    ]);
    expect(actions[1]?.elements?.map((element) => element.action_id)).toEqual([
      SCHEDULER_RESUME_ACTION_ID,
      SCHEDULER_RUN_NOW_ACTION_ID,
    ]);
    expect(JSON.stringify(blocks)).toContain("Daily status");
    expect(JSON.stringify(blocks)).toContain(`revision ${enabled.revision}`);
    expect(JSON.stringify(blocks)).toContain("paused");
  });

  test("same-space pause and repeated run clicks settle once and rerender current state", async () => {
    const db = store();
    const audit = createAudit(db);
    const slack = adapter();
    const now = Date.UTC(2026, 7, 21, 12);
    const job = await db.createSchedulerJob({
      action: "send_message",
      cron: "0 9 * * *",
      spaceId: "slack:C1",
      createdBy: "U1",
    });

    const pauseValue = schedulerActionValue(job);
    expect(await resolveSchedulerAction({ store: db, audit, adapter: slack.value, now: () => now }, click(SCHEDULER_PAUSE_ACTION_ID, pauseValue))).toBe(true);
    expect(await resolveSchedulerAction({ store: db, audit, adapter: slack.value, now: () => now }, click(SCHEDULER_PAUSE_ACTION_ID, pauseValue))).toBe(false);
    const pauseRows = await audit.listAudit({ event_type: SCHEDULER_JOB_PAUSED_EVENT });
    expect(pauseRows).toHaveLength(1);
    expect(pauseRows[0]!.actor).toBe("U42");

    const paused = await db.getSchedulerJob(job.id);
    const runValue = schedulerActionValue(paused!);
    const runClick = click(SCHEDULER_RUN_NOW_ACTION_ID, runValue);
    const [first, second] = await Promise.all([
      resolveSchedulerAction({ store: db, audit, adapter: slack.value, now: () => now }, runClick),
      resolveSchedulerAction({ store: db, audit, adapter: slack.value, now: () => now }, runClick),
    ]);
    expect([first, second]).toEqual([true, true]);
    expect(await db.listSchedulerInvocations({ jobId: job.id })).toHaveLength(1);
    expect(await audit.listAudit({ event_type: SCHEDULER_RUN_REQUESTED_EVENT })).toHaveLength(1);
    expect(slack.updates.length).toBeGreaterThanOrEqual(2);
  });

  test("ignores foreign-space, missing, stale, and unknown action clicks", async () => {
    const db = store();
    const audit = createAudit(db);
    const slack = adapter();
    const job = await db.createSchedulerJob({
      action: "send_message",
      cron: "0 9 * * *",
      spaceId: "slack:C2",
      createdBy: "U1",
    });
    const deps = { store: db, audit, adapter: slack.value, now: () => 1_800_000_000_000 };
    expect(await resolveSchedulerAction(deps, click(SCHEDULER_PAUSE_ACTION_ID, schedulerActionValue(job)))).toBe(false);
    expect(await resolveSchedulerAction(deps, click("bottega_scheduler_invalid", schedulerActionValue(job)))).toBe(false);
    expect(await resolveSchedulerAction(deps, click(SCHEDULER_RUN_NOW_ACTION_ID, "not-json"))).toBe(false);
    expect(await db.listSchedulerInvocations()).toEqual([]);
    expect(slack.updates).toEqual([]);
  });
});
