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
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
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

export function workItemsExtension(store: Store, opts: WorkItemsExtensionOpts): ExtensionFactory {
  const actor = opts.actor ?? "agent";
  const createSchema = z.object({
    description: z.string(),
    requester: z.string().optional(),
    repo: z.string().optional(),
  });
  const cancelSchema = z.object({ id: z.string() });
  return (pi) => {
    pi.registerTool({
      name: "create_work_item",
      label: "Create work item",
      description:
        "Creates a work item in the space's queue (state: open) that an executor agent can pick up and " +
        "work autonomously. Use it when asked to handle something (e.g. \"@agent handle this\"). " +
        "GitHub issue-URL pickup: when the user shares a GitHub issue URL, derive the repo and issue " +
        "number from the URL and include them; the link is recorded as evidence. " +
        "The optional `repo` (\"owner/repo\") names the repository the task lives in — derive it from the " +
        "URL or the conversation (e.g. \"fix the flaky checkout in bottega\" → repo \"acme/bottega\"); " +
        "omit it when neither says, and the executor will block asking the requester. " +
        "The executor only ever pushes to repos on the allowlist (org settings repos, config/org.yml by default). " +
        "Requires human approval (exec-tier tool).",
      parameters: createSchema,
      approval: "exec",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (!params.description.trim()) return toolError("description must not be empty");
        if (params.repo !== undefined && !params.repo.trim()) {
          return toolError("repo must be a non-empty string when provided");
        }
        const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
        if (!spaceId) return toolError("work items require a space session");

        // Issue-URL pickup (#48): a parseable GitHub issue URL in the
        // description is the source of truth for the repo + issue number.
        // The canonical URL is guaranteed present in the description, the
        // link is recorded as evidence, and the repo is derived into the
        // repo column unless the caller provided one explicitly.
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
            evidence,
            repo: params.repo?.trim() || (parsed ? `${parsed.owner}/${parsed.repo}` : undefined),
          });
          return {
            content: [{ type: "text", text: JSON.stringify({ id: item.id, state: item.state }) }],
          };
        } catch (err) {
          return toolError(errorMessage(err));
        }
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
    });
  };
}
