/**
 * Work item tools (issue #10): the space agent's queue surface.
 *
 * Creation and cancellation are exec-tier: they cross human approval before
 * running. Chat completion is write-tier because the visible answer already
 * happened in-channel; the tool only records completion. Listing is
 * read-tier (issue #159): the human-facing queue, state-filterable, with
 * the assignee (who owns each item).
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
import { WORK_ITEM_LIST_EVENT } from "../store/audit-events";
import {
  DEFAULT_MODEL_CATALOG_DIR,
  listAvailableModels,
  resolveModelPin,
  type ModelCatalogEntry,
} from "../models/model-pin";
import { errorMessage, toolError } from "./helpers";
import { SKILL_NAME_RE } from "../server/skills";
import type { Store } from "../store/db";

/** The list_work_items audit payload: the optional state filter + the returned count (issue #159). */
interface WorkItemListAuditPayload {
  state?: string;
  count: number;
}

export interface WorkItemsExtensionOpts {
  /** Actor for tool calls (requester default, audit rows, cancel authorization). Default "agent". */
  actor?: string;
  /** Org floor policy; the space overlay's `approvers` list authorizes cancels. */
  orgPolicy: PolicyConfig;
  /**
   * Agent dir whose model catalog validates create_work_item model pins
   * (issue #185). Default "data/omp-agent" (the server/executor default).
   */
  agentDir?: string;
  /**
   * Model-catalog seam (issue #185 tests): resolves the AVAILABLE models a
   * model pin may name. Defaults to the SDK registry over `agentDir` (the
   * same catalog the sessions see).
   */
  listModels?: (agentDir: string) => Promise<ModelCatalogEntry[]>;
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

/**
 * The provider of a model ref (issue #244): a provider-qualified ref
 * ("openai-codex/gpt-5.6-luna") names its provider; a bare id, a role ref,
 * or an empty/unset value carries none (undefined → the normal resolution
 * rules stand). Matches the canary's defaultModelProviderFor split at the
 * last "/".
 */
function providerOfModelRef(modelRef: string | undefined): string | undefined {
  if (!modelRef) return undefined;
  const slash = modelRef.lastIndexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) return undefined;
  return modelRef.slice(0, slash);
}

export const createWorkItemArgsSchema = z.object({
  description: z.string(),
  requester: z.string().optional(),
  repo: z.string().optional(),
  delivery: z.enum(["git", "extension", "chat"]).optional(),
  /**
   * Per-task model pin (issue #185): a role ref ("fast"/"reasoning") or a
   * friendly model name ("deepseek v4") resolved against the available
   * model catalog at creation, fail closed. Stored on the item.
   */
  model: z.string().optional(),
  /** Per-task thinking-effort pin (issue #185): off/low/medium/high. */
  reasoning_effort: z.enum(["off", "low", "medium", "high"]).optional(),
  /**
   * Explicit task-level skills (issues #234/#235): skill names injected
   * into the item's session at claim — space-authored skills and the
   * committed built-ins (e.g. "pr_review") both resolve. Every name is
   * validated against the skill-name charset here, fail closed: an
   * invalid/unknown name never creates an item whose skills could not load.
   */
  skills: z.array(z.string()).optional(),
});
export const cancelWorkItemArgsSchema = z.object({ id: z.string() });
export const completeWorkItemArgsSchema = z.object({
  id: z.string(),
  summary: z.string(),
});
export const listWorkItemsArgsSchema = z.object({
  /** Narrow the queue to one state (open/claimed/working/review/done/blocked/aborted). */
  state: z.enum(["open", "claimed", "working", "review", "done", "blocked", "aborted"]).optional(),
  /** Space id ("slack:C123") whose queue to read; defaults to this conversation's space. */
  space: z.string().optional(),
});

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
      "Optional `model` pins the model this task runs on: a role ref (\"fast\" or \"reasoning\") or a model name " +
      "(\"deepseek v4\", \"gpt sol\") resolved against the available models at creation — a name that matches no " +
      "available model is rejected and no item is created. Optional `reasoning_effort` (off/low/medium/high) pins " +
      "the thinking effort. The pin overrides the space's model settings for this item's execution only. " +
      "Optional `skills` (list of names) pins the skills injected into this task's session — space-authored skills " +
      "and committed built-ins (e.g. \\\"pr_review\\\", the default for git delivery) both resolve; git delivery carries " +
      "pr_review automatically. " +
      "Requires human approval (exec-tier tool).",
    parameters: createWorkItemArgsSchema,
    approval: "exec",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!params.description.trim()) return toolError("description must not be empty");
      const delivery = params.delivery ?? "git";
      if (delivery === "git" && params.repo !== undefined && !params.repo.trim()) {
        return toolError("repo must be a non-empty string when provided");
      }
      // Per-task model pin (issue #185): role refs pass through; friendly
      // names resolve against the available catalog at creation, fail
      // closed — an unresolvable/ambiguous name never creates the item.
      let model: string | undefined;
      if (params.model !== undefined && !params.model.trim()) {
        return toolError("model must not be empty when provided");
      }
      if (params.model !== undefined) {
        // Issue #244: a bare id served by several providers (gpt-5.6-luna on
        // openai, openai-codex, opencode-go, anthropic) ties and would fail
        // closed even when it is the SPACE's own default id. The space's
        // effective default is provider-qualified ("openai-codex/gpt-5.6-luna"),
        // so tell the resolver to prefer that provider; a bare/unset default
        // carries no preference (normal resolution stands).
        const spaceIdForDefault = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
        const spaceDefault = spaceIdForDefault ? (await store.getEffectiveSpaceSettings(spaceIdForDefault)).model : undefined;
        const preferredProvider = providerOfModelRef(spaceDefault);
        const resolution = resolveModelPin(
          params.model,
          await (opts.listModels ?? listAvailableModels)(opts.agentDir ?? DEFAULT_MODEL_CATALOG_DIR),
          preferredProvider !== undefined ? { preferredProvider } : undefined,
        );
        if (!resolution.ok) return toolError(resolution.error);
        model = resolution.pin.kind === "role" ? resolution.pin.role : resolution.pin.modelId;
      }
      // Task-level skills (issues #234/#235): validate every name against
      // the skill-name charset, fail closed — an invalid name never creates
      // an item whose injected skills could not resolve at claim.
      let skills: string[] | undefined;
      if (params.skills !== undefined) {
        if (params.skills.length === 0) return toolError("skills must be a non-empty list when provided");
        for (const name of params.skills) {
          if (!SKILL_NAME_RE.test(name)) {
            return toolError(
              `invalid skill name '${name}': must match ${SKILL_NAME_RE.source} (letters, digits, '.', '_', '-' — no separators)`,
            );
          }
        }
        skills = [...params.skills];
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
          model,
          reasoning_effort: params.reasoning_effort,
          repo:
            delivery === "git"
              ? params.repo?.trim() || (parsed ? `${parsed.owner}/${parsed.repo}` : undefined)
              : undefined,
          ...(skills !== undefined ? { skills } : undefined),
        });
        // The rendered skill list rides the result so the user SEES the
        // task's injected skills in the same conversation (issues #234/#235).
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: item.id,
                state: item.state,
                ...(model !== undefined ? { model } : undefined),
                ...(params.reasoning_effort !== undefined ? { reasoning_effort: params.reasoning_effort } : undefined),
                ...(skills !== undefined ? { skills } : undefined),
              }),
            },
          ],
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

  const complete: ToolDefinition<typeof completeWorkItemArgsSchema> = {
    name: "complete_work_item",
    label: "Complete chat work item",
    description:
      "Deliver the answer in the channel first, then complete the chat work item with a one-paragraph summary. " +
      "Git and extension work items are completed by the executor; never use this tool for them.",
    parameters: completeWorkItemArgsSchema,
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!params.summary.trim()) return toolError("summary must not be empty");
      const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!spaceId) return toolError("work items require a space session");
      const item = await store.getWorkItem(params.id);
      if (!item) return toolError(`work item not found: ${params.id}`);
      if (item.space_id !== spaceId) return toolError("work item does not belong to this space");
      if (item.delivery !== "chat") {
        return toolError(
          "complete_work_item only completes chat-delivered work items; git and extension items are completed by the executor",
        );
      }
      if (item.state !== "open" && item.state !== "claimed" && item.state !== "working") {
        return toolError(`work item cannot be completed from state ${item.state}`);
      }

      try {
        if (item.state === "open") {
          await store.transitionWorkItem(item.id, "open", "claimed", { by: actor });
          await store.transitionWorkItem(item.id, "claimed", "working", { by: actor });
        } else if (item.state === "claimed") {
          await store.transitionWorkItem(item.id, "claimed", "working", { by: actor });
        }
        const done = await store.transitionWorkItem(item.id, "working", "done", {
          by: actor,
          result: JSON.stringify({ summary: params.summary }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ id: done.id, state: done.state }) }],
        };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  const list: ToolDefinition<typeof listWorkItemsArgsSchema> = {
    name: "list_work_items",
    label: "List work items",
    description:
      "Lists the space's visible work-item queue (issue #159): every item with its id, description, state, " +
      "assignee (who owns it), and creation time, newest first. Optional `state` narrows the queue to one state " +
      "(open/claimed/working/review/done/blocked/aborted); optional `space` (\"slack:C123\") reads another space's " +
      "queue, defaulting to this conversation's space. Read-only — use it to answer \"what are you working on\", " +
      "\"is my task done\", or \"what's blocked\".",
    parameters: listWorkItemsArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spaceId = params.space?.trim() || sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!spaceId) return toolError("work items require a space session");
      try {
        const items = await store.listWorkItems({ space_id: spaceId, state: params.state });
        const visible = items.map((item) => ({
          id: item.id,
          description: item.description,
          state: item.state,
          assignee: item.assignee,
          created: item.created_at,
        }));
        const auditPayload: WorkItemListAuditPayload = { count: visible.length };
        if (params.state !== undefined) auditPayload.state = params.state;
        await store.appendAudit({
          space_id: spaceId,
          actor,
          event_type: WORK_ITEM_LIST_EVENT,
          payload: JSON.stringify(auditPayload),
        });
        return { content: [{ type: "text", text: JSON.stringify({ count: visible.length, items: visible }) }] };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  return [create, list, cancel, complete];
}

export function workItemsExtension(store: Store, opts: WorkItemsExtensionOpts): ExtensionFactory {
  return (pi) => {
    for (const definition of workItemToolDefinitions(store, opts)) pi.registerTool(definition);
  };
}
