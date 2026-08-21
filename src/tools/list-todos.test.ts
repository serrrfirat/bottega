/**
 * list_todos tests (issue #228): the read-tier snapshot assembles the
 * space's live state — work items (the same query list_work_items runs),
 * in-progress count (the space's visible work-item queue), pending
 * approvals (the router's outstanding prompts), scheduled jobs (the same
 * query list_scheduler_jobs runs), and the "🛠 Agent's plan" section (the
 * session's live todo via the driver's getTodoPhases pull seam — the same
 * renderer the presenter's in-place plan message uses). Empty-tolerant:
 * an empty space assembles empty sections with "no active plan", never an
 * error.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, type AgentToolResult, type ExtensionContext, type TodoPhase } from "@oh-my-pi/pi-coding-agent";
import { createStore, type Store } from "../store/db";
import { DenyRouter } from "../policy/approval-router";
import { listTodosToolDefinition, listTodosArgsSchema } from "./list-todos";

const ListTodosSnapshotSchema = z.object({
  work_items: z.object({
    count: z.number(),
    in_progress: z.number(),
    items: z.array(z.object({
      id: z.string(),
      description: z.string(),
      state: z.string(),
      assignee: z.string().nullable(),
      created: z.number(),
    })),
  }),
  pending_approvals: z.array(z.object({ tool: z.string() })),
  scheduled_jobs: z.array(z.object({
    action: z.string(),
    cron: z.string(),
  })),
  plan: z.object({
    active: z.boolean(),
    steps_total: z.number().optional(),
    steps_completed: z.number().optional(),
    current: z.string().optional(),
    message: z.string(),
  }),
});
type ListTodosSnapshot = z.infer<typeof ListTodosSnapshotSchema>;

const dir = mkdtempSync(join(tmpdir(), "bottega-list-todos-"));
const stores: Store[] = [];
function freshStore(): Store {
  const s = createStore(join(dir, `store-${stores.length}.db`));
  stores.push(s);
  return s;
}

afterAll(() => {
  for (const s of stores) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function toolFor(
  store: Store,
  opts: {
    pendingApprovals?: (spaceId: string) => ReadonlyArray<{ tool: string }>;
    getTodoPhases?: (spaceId: string) => TodoPhase[];
  } = {},
) {
  return listTodosToolDefinition(store, opts);
}

function ctxFor(spaceId: string): ExtensionContext {
  // SAFETY: the tool reads only sessionManager.getSessionFile(); the
  // widened return matches the SDK's contract, other members untouched.
  return {
    sessionManager: { getSessionFile: (): string | undefined => join("/tmp/sessions", `${spaceId}.jsonl`) },
  } as ExtensionContext;
}

async function resultOf(res: AgentToolResult): Promise<ListTodosSnapshot> {
  expect(res.isError).not.toBe(true);
  const content = res.content[0];
  if (content?.type !== "text") throw new Error("expected a text tool result");
  return ListTodosSnapshotSchema.parse(JSON.parse(content.text));
}

/** A long plan (3 steps across 2 phases) — the same shape the presenter renders. */
const PLAN: TodoPhase[] = [
  {
    name: "Research",
    tasks: [
      { content: "Read the repo", status: "completed" },
      { content: "Draft the section", status: "in_progress" },
    ],
  },
  { name: "Land", tasks: [{ content: "Push + PR", status: "pending" }] },
];

describe("list_todos registration", () => {
  test("registers as a read-tier tool with a space-aware description", () => {
    const tool = toolFor(freshStore());
    expect(tool.name).toBe("list_todos");
    expect(tool.approval).toBe("read");
    expect(tool.label.length).toBeGreaterThan(0);
    expect(tool.description).toContain("work items");
    expect(tool.description).toContain("scheduled jobs");
    expect(tool.description).toContain("pending approvals");
    expect(tool.description).toContain("Agent's plan");
  });

  test("the args schema accepts an optional space", () => {
    expect(listTodosArgsSchema.safeParse({}).success).toBe(true);
    expect(listTodosArgsSchema.safeParse({ space: "slack:C9" }).success).toBe(true);
  });
});

describe("list_todos snapshot", () => {
  test("assembles every section: work items + in-progress count + approvals + jobs + the plan", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    // Two work items, one being worked: the queue + in-progress count.
    await s.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "Fix the flaky test",
      delivery: "chat",
    });
    const working = await s.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "Draft the launch notes",
      delivery: "chat",
    });
    await s.transitionWorkItem(working.id, "open", "claimed", { by: "agent" });
    await s.transitionWorkItem(working.id, "claimed", "working", { by: "agent" });
    // A durable scheduled job (the list_scheduler_jobs query).
    await s.createSchedulerJob({
      action: "standup_digest",
      cron: "0 9 * * 1-5",
      params: { space: space.id, description: "daily standup" },
      createdBy: "agent",
    });
    const approvals = [{ tool: "create_work_item" }, { tool: "bash" }];
    const tool = toolFor(s, {
      pendingApprovals: (spaceId) => (spaceId === space.id ? approvals : []),
      getTodoPhases: (spaceId) => (spaceId === space.id ? PLAN : []),
    });

    const snapshot = await resultOf(await tool.execute("tc1", {}, undefined, undefined, ctxFor(space.id)));

    // Work items: the same query list_work_items runs — queue + counts.
    expect(snapshot.work_items.count).toBe(2);
    expect(snapshot.work_items.in_progress).toBe(1);
    expect(snapshot.work_items.items.map((i) => i.description).sort()).toEqual([
      "Draft the launch notes",
      "Fix the flaky test",
    ]);
    expect(snapshot.work_items.items.find((i) => i.description === "Draft the launch notes")?.state).toBe("working");
    // Pending approvals: the router's outstanding prompts for THIS space.
    expect(snapshot.pending_approvals).toEqual(approvals);
    // Scheduled jobs: the same query list_scheduler_jobs runs.
    expect(snapshot.scheduled_jobs.map((j) => j.action)).toEqual(["standup_digest"]);
    // The plan: the driver's pull seam + the presenter's exact renderer.
    expect(snapshot.plan).toMatchObject({
      active: true,
      steps_total: 3,
      steps_completed: 1,
      current: "Draft the section",
      message: "🛠 Agent's plan:\n  ✅ 1. Read the repo\n  ⏳ 2. Draft the section\n  ⏳ 3. Push + PR",
    });
  });

  test("empty-tolerant: no data assembles empty sections with 'no active plan', never an error", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C2" });
    const tool = toolFor(s); // no router seam, no session seam

    const res = await tool.execute("tc1", {}, undefined, undefined, ctxFor(space.id));
    const snapshot = await resultOf(res);
    expect(snapshot.work_items).toEqual({ count: 0, in_progress: 0, items: [] });
    expect(snapshot.pending_approvals).toEqual([]);
    expect(snapshot.scheduled_jobs).toEqual([]);
    expect(snapshot.plan).toEqual({
      active: false,
      message: "🛠 Agent's plan:\n  no active plan",
    });
  });

  test("fails without a space session", async () => {
    const tool = toolFor(freshStore());
    // SAFETY: the tool only reads ctx.sessionManager.getSessionFile(); null here means "no session file".
    const noCtx = { sessionManager: { getSessionFile: (): string | undefined | null => null } } as ExtensionContext;
    const res = await tool.execute("tc1", {}, undefined, undefined, noCtx);
    expect(res.isError).toBe(true);
    const content = res.content[0];
    if (content?.type !== "text") throw new Error("expected a text tool result");
    expect(content.text).toMatch(/requires a space session/);
  });

  test("an explicit space reads that space's snapshot (work items + approvals filtered by space)", async () => {
    const s = freshStore();
    const spaceA = await s.getOrCreateSpace({ platform: "slack", channel_id: "C3" });
    const spaceB = await s.getOrCreateSpace({ platform: "slack", channel_id: "C4" });
    await s.createWorkItem({
      space_id: spaceA.id,
      requester: "U1",
      description: "A's item",
      delivery: "chat",
    });
    await s.createWorkItem({
      space_id: spaceB.id,
      requester: "U1",
      description: "B's item",
      delivery: "chat",
    });
    const tool = toolFor(s, {
      pendingApprovals: (spaceId) =>
        [
          { spaceId: spaceA.id, tool: "bash" },
          { spaceId: spaceB.id, tool: "read" },
        ]
          .filter((p) => p.spaceId === spaceId)
          .map((p) => ({ tool: p.tool })),
    });

    const res = await tool.execute("tc1", { space: spaceB.id }, undefined, undefined, ctxFor(spaceA.id));
    const snapshot = await resultOf(res);
    expect(snapshot.work_items.count).toBe(1);
    expect(snapshot.work_items.items[0]!.description).toBe("B's item");
    expect(snapshot.pending_approvals).toEqual([{ tool: "read" }]);
  });
});

// The DenyRouter's pendingPrompts seam is optional: the router contract
// keeps working without it (headless contexts).
describe("ApprovalRouter pendingPrompts seam (issue #228)", () => {
  test("DenyRouter omits pendingPrompts and list_todos treats it as zero pending", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C5" });
    const tool = listTodosToolDefinition(s, {
      // The server wires this exactly like: approvalRouter.pendingPrompts?.() ?? []
      pendingApprovals: (spaceId) =>
        (DenyRouter.pendingPrompts?.() ?? []).filter((p) => p.spaceId === spaceId).map((p) => ({ tool: p.tool })),
    });
    const res = await tool.execute("tc1", {}, undefined, undefined, ctxFor(space.id));
    const snapshot = await resultOf(res);
    expect(snapshot.pending_approvals).toEqual([]);
  });
});
