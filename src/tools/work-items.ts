/**
 * Work item tools (issue #10): the space agent's queue surface.
 *
 * Both tools are exec-tier: the OMP approval tier defaults to exec when
 * omitted, and the bottega policy gate (issue #6) resolves unknown tools to
 * exec — so every call crosses a human approval before it runs.
 *
 * Pickup model: explicit by default. The agent creates a work item when
 * asked (e.g. "@agent handle this"); in spaces whose policy sets
 * `pickup.auto: true` the agent MAY also self-trigger on actionable
 * messages — the tools themselves are identical either way.
 */
import type { AgentToolResult, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { sessionIdFromFilePath } from "../server/agent-driver";
import type { Store } from "../store/db";

export interface WorkItemsExtensionOpts {
  /** Actor for tool calls (requester default, audit rows, cancel authorization). Default "agent". */
  actor?: string;
}

export function workItemsExtension(store: Store, opts: WorkItemsExtensionOpts = {}): ExtensionFactory {
  const actor = opts.actor ?? "agent";
  const createSchema = z.object({
    description: z.string(),
    requester: z.string().optional(),
  });
  const cancelSchema = z.object({ id: z.string() });
  return (pi) => {
    pi.registerTool({
      name: "create_work_item",
      label: "Create work item",
      description:
        "Creates a work item in the space's queue (state: open) that an executor agent can pick up and " +
        "work autonomously. Use it when asked to handle something (e.g. \"@agent handle this\"); in spaces " +
        "with pickup.auto enabled in the space policy you MAY also create work items proactively for " +
        "actionable messages. Requires human approval (exec-tier tool).",
      parameters: createSchema,
      approval: "exec",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (!params.description.trim()) return toolError("description must not be empty");
        const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
        if (!spaceId) return toolError("work items require a space session");
        const item = await store.createWorkItem({
          space_id: spaceId,
          requester: params.requester ?? actor,
          description: params.description,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ id: item.id, state: item.state }) }],
        };
      },
    });

    pi.registerTool({
      name: "work_item_cancel",
      label: "Cancel work item",
      description:
        "Cancels a work item by id, moving it to aborted (from open, claimed, working, or review). " +
        "Only the requester or a space approver (space policy \"approvers\" list) may cancel. " +
        "Requires human approval (exec-tier tool).",
      parameters: cancelSchema,
      approval: "exec",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const item = await store.getWorkItem(params.id);
        if (!item) return toolError(`work item not found: ${params.id}`);
        const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile()) ?? item.space_id;
        const approvers = await approversFor(store, spaceId);
        if (actor !== item.requester && !approvers.has(actor)) {
          return toolError("cancel requires the requester or a space approver");
        }
        try {
          const aborted = await store.transitionWorkItem(item.id, item.state, "aborted", { by: actor });
          return {
            content: [{ type: "text", text: JSON.stringify({ id: aborted.id, state: aborted.state }) }],
          };
        } catch (err) {
          return toolError((err as Error).message);
        }
      },
    });
  };
}

/** The space overlay's `approvers` list (fail closed: none when absent or malformed). */
async function approversFor(store: Pick<Store, "getSpace">, spaceId: string): Promise<ReadonlySet<string>> {
  const space = await store.getSpace(spaceId);
  if (!space) return new Set();
  try {
    const parsed: unknown = JSON.parse(space.policy_json);
    const list = (parsed as { approvers?: unknown } | null)?.approvers;
    return new Set(Array.isArray(list) ? list.filter((a): a is string => typeof a === "string") : []);
  } catch {
    return new Set();
  }
}

function toolError(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
