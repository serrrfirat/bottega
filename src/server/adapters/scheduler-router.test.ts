import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudit } from "../../policy/audit";
import type { SchedulerInvocation } from "../../scheduler/types";
import { SCHEDULER_JOB_PAUSED_EVENT, SCHEDULER_RUN_REQUESTED_EVENT } from "../../store/audit-events";
import { createStore, type Store } from "../../store/db";
import {
  buildSchedulerBlocks,
  createSchedulerRunNowFeedback,
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
  const posts: Array<{ spaceId: string; text: string }> = [];
  const value = {
    postMessage: async (spaceId: string, text: string) => {
      posts.push({ spaceId, text });
      return `status-${posts.length}`;
    },
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
  return { value, updates, posts };
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
  test("posts visible working feedback for a run-now click", async () => {
    const db = store();
    const audit = createAudit(db);
    const slack = adapter();
    const job = await db.createSchedulerJob({
      action: "send_message",
      cron: "0 9 * * *",
      params: { text: "Reminder" },
      spaceId: "slack:C1",
      createdBy: "U1",
    });
    let request: { invocationId: string; action: string; spaceId: string; statusMessageTs: string } | undefined;

    await resolveSchedulerAction(
      {
        store: db,
        audit,
        adapter: slack.value,
        now: () => 1_800_000_000_000,
        onRunNowRequested: (value) => {
          request = value;
        },
      },
      click(SCHEDULER_RUN_NOW_ACTION_ID, schedulerActionValue(job)),
    );

    expect(slack.posts).toEqual([{ spaceId: "slack:C1", text: expect.stringMatching(/working/i) }]);
    expect(request).toEqual({
      action: "send_message",
      invocationId: `slack:1700.0001:${SCHEDULER_RUN_NOW_ACTION_ID}:${job.id}:1`,
      spaceId: "slack:C1",
      statusMessageTs: "status-1",
    });
  });

  test("updates the same working message with one terminal outcome even if completion races registration", async () => {
    const slack = adapter();
    const feedback = createSchedulerRunNowFeedback(slack.value);
    const invocation: SchedulerInvocation = {
      id: "slack:1700.0001:bottega_scheduler_run_now:sj_1:1",
      jobId: "sj_1",
      action: "send_message",
      params: { content: "Daily digest" },
      spaceId: "slack:C1",
      source: "manual",
      scheduledFor: null,
      requestedAt: 1_800_000_000_000,
      jobRevision: 1,
      status: "completed",
      claimedAt: 1_800_000_000_001,
      completedAt: 1_800_000_000_002,
      result: "error",
      error: "text is required",
    };
    await feedback.onInvocationComplete(invocation);
    await feedback.register({
      invocationId: invocation.id,
      action: invocation.action,
      spaceId: "slack:C1",
      statusMessageTs: "status-1",
    });
    expect(slack.updates).toEqual([
      {
        spaceId: "slack:C1",
        ts: "status-1",
        text: expect.stringContaining("text is required"),
        blocks: [],
      },
    ]);
  });

  test("updates a registered working message on successful completion", async () => {
    const slack = adapter();
    const feedback = createSchedulerRunNowFeedback(slack.value);
    const invocation: SchedulerInvocation = {
      id: "slack:1700.0001:bottega_scheduler_run_now:sj_2:1",
      jobId: "sj_2",
      action: "send_message",
      params: { text: "Daily digest" },
      spaceId: "slack:C1",
      source: "manual",
      scheduledFor: null,
      requestedAt: 1_800_000_000_000,
      jobRevision: 1,
      status: "completed",
      claimedAt: 1_800_000_000_001,
      completedAt: 1_800_000_000_002,
      result: "ok",
    };
    await feedback.register({
      invocationId: invocation.id,
      action: invocation.action,
      spaceId: "slack:C1",
      statusMessageTs: "status-2",
    });
    await feedback.onInvocationComplete(invocation);
    expect(slack.updates).toEqual([
      {
        spaceId: "slack:C1",
        ts: "status-2",
        text: expect.stringContaining("completed"),
        blocks: [],
      },
    ]);
  });
  test("reports queued feedback for recurring agent work instead of false completion", async () => {
    const slack = adapter();
    const feedback = createSchedulerRunNowFeedback(slack.value);
    const invocation: SchedulerInvocation = {
      id: "slack:1700.0001:bottega_scheduler_run_now:sj_recurring:1",
      jobId: "sj_recurring",
      action: "recurring_work",
      params: {
        content: "Compose and post a compact daily digest",
        description: "Daily digest",
        space: "slack:C1",
      },
      spaceId: "slack:C1",
      source: "manual",
      scheduledFor: null,
      requestedAt: 1_800_000_000_000,
      jobRevision: 1,
      status: "completed",
      claimedAt: 1_800_000_000_001,
      completedAt: 1_800_000_000_002,
      result: "ok",
    };
    await feedback.onInvocationComplete(invocation);
    await feedback.register({
      invocationId: invocation.id,
      action: invocation.action,
      spaceId: "slack:C1",
      statusMessageTs: "status-recurring",
    });

    expect(slack.updates).toEqual([
      {
        spaceId: "slack:C1",
        ts: "status-recurring",
        text: expect.stringContaining("Run now queued — agent work continues and will post here when finished"),
        blocks: [],
      },
    ]);
    expect(slack.updates[0]?.text).not.toContain("Run now completed");
  });


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
    expect(slack.posts).toHaveLength(1);
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
