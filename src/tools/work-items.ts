/**
 * Work item tools (issue #10): the space agent's queue surface.
 *
 * Both tools are exec-tier: the OMP approval tier defaults to exec when
 * omitted, and the bottega policy gate (issue #6) resolves unknown tools to
 * exec — so every call crosses a human approval before it runs.
 *
 * Pickup is explicit: the agent creates a work item when asked (e.g.
 * "@agent handle this"). The tools are identical in every space; cancel
 * authorization comes from the space policy's `approvers` list (issue #33).
 */
import type { ExtensionFactory, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import { channelFromSpaceId } from "../server/adapters/slack";
import { loadSpacePolicy, type PolicyConfig } from "../policy/config";
import { errorMessage, toolError } from "./helpers";
import type { Store } from "../store/db";

export interface WorkItemsExtensionOpts {
  /** Actor for tool calls (requester default, audit rows, cancel authorization). Default "agent". */
  actor?: string;
  /** Org floor policy; the space overlay's `approvers` list authorizes cancels. */
  orgPolicy: PolicyConfig;
}

/**
 * Extracts a GitHub issue reference from free text (issue #48): the repo and
 * issue number come straight from the URL, so pickup is deterministic instead
 * of left to whatever the model happens to notice. Accepts http(s) or bare
 * github.com/... forms, a trailing slash, and query params, embedded anywhere
 * in the text. PR links are NOT issue links and return null (v1: they stay in
 * the description as context).
 */
export function parseGithubIssueUrl(text: string): { owner: string; repo: string; issueNumber: number } | null {
  const match = text.match(
    /(?:^|[^A-Za-z0-9_-])github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)/,
  );
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, issueNumber: Number(match[3]!) };
}

export const createWorkItemArgsSchema = z.object({
  description: z.string(),
  requester: z.string().optional(),
  repo: z.string().optional(),
  delivery: z.enum(["git", "extension", "chat"]).optional(),
});
export const cancelWorkItemArgsSchema = z.object({ id: z.string() });

/**
 * The work item tools as SDK {@link ToolDefinition}s (issue #69): one source
 * shared by the in-session extension surface and the driver's gatedTools
 * path. Restricted SDK sessions (restrictToolNames) drop extension-registered
 * tools entirely, so the definitions ride the custom-tools path in such
 * sessions; the extension registers the same definitions for unrestricted
 * sessions.
 */
export function workItemToolDefinitions(
  store: Store,
  opts: WorkItemsExtensionOpts,
): ToolDefinition[] {
  const actor = opts.actor ?? "agent";

  const create: ToolDefinition<typeof createWorkItemArgsSchema> = {
    name: "create_work_item",
    label: "Create work item",
    description:
      "Creates a delivery-neutral work item in the space's queue (state: open) for autonomous handling. " +
      "Use it when asked to handle something (e.g. \"@agent handle this\"). " +
      "Set `delivery` to `git` (default) for repository work, `extension` for work through the space's " +
      "connected extensions, or `chat` for an answer delivered in-channel. Extension and chat items do " +
      "not create an external repository object and do not need `repo`. " +
      "For git delivery, optional `repo` (\"owner/repo\") names the task repository; derive it from a " +
      "GitHub issue URL or the conversation. When any description contains a GitHub issue URL, the link " +
      "is recorded as evidence; repo derivation from that URL applies only to git delivery. " +
      "Git delivery can only push to repos on the allowlist (org settings repos, config/org.yml by default). " +
      "Requires human approval (exec-tier tool).",
    parameters: createWorkItemArgsSchema,
    approval: "exec",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!params.description.trim()) return toolError("description must not be empty");
      const delivery = params.delivery ?? "git";
      if (delivery === "git" && params.repo !== undefined && !params.repo.trim()) {
        return toolError("repo must be a non-empty string when provided");
      }
      const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!spaceId) return toolError("work items require a space session");
      // The space row is the FK parent of work items and the audit trail,
      // but no server path creates it eagerly — the session file is the
      // only durable space record until a row exists. Create it lazily so
      // the first tool call in a space works (E2E journey 2 finding).
      await store.getOrCreateSpace({ platform: "slack", channel_id: channelFromSpaceId(spaceId) });

      // Issue-URL pickup (#48, #128): every delivery kind preserves a
      // parseable URL as evidence. Only git delivery derives the repo; the
      // canonical URL remains in the description for durable context.
      let description = params.description;
      let evidence: Array<{ kind: string; url: string }> | undefined;
      const parsed = parseGithubIssueUrl(description);
      if (parsed) {
        const canonical = `https://github.com/${parsed.owner}/${parsed.repo}/issues/${parsed.issueNumber}`;
        if (!description.includes(canonical)) description = `${description.trimEnd()}\n${canonical}`;
        evidence = [{ kind: "issue_url", url: canonical }];
      }

      try {
        const item = await store.createWorkItem({
          space_id: spaceId,
          requester: params.requester ?? actor,
          description,
          delivery,
          evidence,
          repo:
            delivery === "git"
              ? params.repo?.trim() || (parsed ? `${parsed.owner}/${parsed.repo}` : undefined)
              : undefined,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ id: item.id, state: item.state }) }],
        };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  const cancel: ToolDefinition<typeof cancelWorkItemArgsSchema> = {
    name: "work_item_cancel",
    label: "Cancel work item",
    description:
      "Cancels a work item by id, moving it to aborted (from open, claimed, working, or review). " +
      "Only the requester or a space approver (space policy \"approvers\" list) may cancel. " +
      "Requires human approval (exec-tier tool).",
    parameters: cancelWorkItemArgsSchema,
    approval: "exec",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const item = await store.getWorkItem(params.id);
      if (!item) return toolError(`work item not found: ${params.id}`);
      const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile()) ?? item.space_id;
      const policy = await loadSpacePolicy(opts.orgPolicy, store, spaceId);
      // Fail closed: a malformed space policy has no approvers, so only
      // the requester can cancel.
      if (actor !== item.requester && !policy.approvers.includes(actor)) {
        return toolError("cancel requires the requester or a space approver");
      }
      try {
        const aborted = await store.transitionWorkItem(item.id, item.state, "aborted", { by: actor });
        return {
          content: [{ type: "text", text: JSON.stringify({ id: aborted.id, state: aborted.state }) }],
        };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  return [create, cancel];
}

export function workItemsExtension(store: Store, opts: WorkItemsExtensionOpts): ExtensionFactory {
  return (pi) => {
    for (const definition of workItemToolDefinitions(store, opts)) pi.registerTool(definition);
  };
}
