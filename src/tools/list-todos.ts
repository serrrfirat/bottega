/**
 * list_todos (issue #228): the on-demand snapshot of a space's live state —
 * one sectioned read assembling the buckets the agent already exposes
 * individually:
 *
 *   - work items (the same store query list_work_items runs),
 *   - in-progress count (the space's visible work-item queue, state
 *     "working"),
 *   - pending approvals (the approval router's outstanding prompts, when
 *     the router exposes them — the Slack-backed router does),
 *   - scheduled jobs (the same store query list_scheduler_jobs runs),
 *   - the "🛠 Agent's plan" section (the session's live todo via the
 *     driver's getTodoPhases pull seam — the same renderer the presenter
 *     uses for the in-place plan message, so the two surfaces never
 *     drift).
 *
 * Read-tier: the policy table resolves it to read, and the definition
 * carries `approval: "read"`. Empty-tolerant — "no active plan" is normal,
 * never an error.
 */
import type { AgentToolResult, TodoPhase, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import { renderTodoPlan, todoProgress } from "../server/services/slack-turn-presenter";
import type { Store } from "../store/db";
import { errorMessage, toolError } from "./helpers";

export const listTodosArgsSchema = z.object({
  /** Space id ("slack:C123") whose snapshot to read; defaults to this conversation's space. */
  space: z.string().optional(),
});

export interface ListTodosExtensionOpts {
  /**
   * The approval router's outstanding prompts (issue #228): filters the
   * router's pendingPrompts query to the target space. Absent (headless
   * routers deny immediately and hold nothing) → zero pending approvals.
   */
  pendingApprovals?: (spaceId: string) => ReadonlyArray<{ tool: string }>;
  /**
   * The live session's todo plan (issue #228, pull path): the driver's
   * getTodoPhases for the target space. Absent → no plan section ("no
   * active plan" is normal).
   */
  getTodoPhases?: (spaceId: string) => TodoPhase[];
}

interface ListTodosPlan {
  active: boolean;
  steps_total?: number;
  steps_completed?: number;
  current?: string;
  message: string;
}

/**
 * The list_todos tool as an SDK {@link ToolDefinition} (issue #228): rides
 * the session toolset's gated custom-tools bridge like the work-item and
 * scheduler tools.
 */
export function listTodosToolDefinition(store: Store, opts: ListTodosExtensionOpts = {}): ToolDefinition {
  const tool: ToolDefinition<typeof listTodosArgsSchema> = {
    name: "list_todos",
    label: "List the space's live state",
    description:
      "Assembles the space's current state in one snapshot: work items (id, description, state, assignee, " +
      "created — the same queue list_work_items reads), the in-progress count (work items currently being " +
      "worked), pending approvals (tool calls waiting on a human approve/deny), scheduled jobs (the same " +
      "list list_scheduler_jobs reads), and the agent's live todo plan ('🛠 Agent's plan' — the phased " +
      "plan the todo tool maintains, with the current step). Read-only — use it to answer \"what's " +
      "happening\", \"anything waiting on me\", or \"what are you working on\" in one call. Optional `space` " +
      "reads another space's snapshot, defaulting to this conversation's space.",
    parameters: listTodosArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      const spaceId = params.space?.trim() || sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!spaceId) return toolError("list_todos requires a space session");
      try {
        // Work items: the SAME store query list_work_items runs (issue
        // #159) — one source of truth for the space's visible queue.
        const items = await store.listWorkItems({ space_id: spaceId });
        const workItems = items.map((item) => ({
          id: item.id,
          description: item.description,
          state: item.state,
          assignee: item.assignee,
          created: item.created_at,
        }));
        const inProgress = items.filter((item) => item.state === "working").length;
        // Pending approvals: the router's outstanding prompts for this
        // space; absent seam → none pending (headless contexts deny fast).
        const approvals = (opts.pendingApprovals?.(spaceId) ?? []).map((prompt) => ({ tool: prompt.tool }));
        // Scheduled jobs: the SAME store query list_scheduler_jobs runs.
        const jobs = await store.listSchedulerJobs();
        // The live todo plan: the driver's pull seam (getTodoPhases); the
        // same renderer the presenter's in-place plan message uses.
        const phases = opts.getTodoPhases?.(spaceId) ?? [];
        const progress = todoProgress(phases);
        const plan: ListTodosPlan = {
          active: phases.flatMap((phase) => phase.tasks).length > 0,
          message: renderTodoPlan(phases),
        };
        if (progress !== undefined) {
          plan.steps_total = progress.total;
          plan.steps_completed = progress.index - 1;
          plan.current = progress.current;
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                work_items: { count: workItems.length, in_progress: inProgress, items: workItems },
                pending_approvals: approvals,
                scheduled_jobs: jobs,
                plan,
              }),
            },
          ],
        };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };
  return tool;
}
