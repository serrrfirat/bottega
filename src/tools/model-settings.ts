/**
 * Model tools (issue #64): the agent's chat surface for per-space model
 * configuration.
 *
 * model_settings is write-tier: it mutates durable per-space settings
 * (`spaces.settings`), so it prompts in non-yolo approval modes (the policy
 * gate, issue #6, resolves it via TIER_BY_TOOL → write). Reading (no `set`
 * argument) is the same tool — get-only calls are still write-tier by tool
 * name; the settings themselves are not sensitive. The get also returns
 * `available_models`, the deployment's model catalog grouped by provider
 * (issue #192) — the same catalog create_work_item model pins resolve
 * against (issue #185), so the agent can see which provider serves which
 * model and answer provider-aware asks ("the near deepseek"). Every
 * successful set appends a `model.settings_changed` audit row carrying
 * {before, after, by}.
 *
 * use_model is write-tier too: it mutates the live session's model for the
 * NEXT turn through the driver's per-session `setModelRole` hook (issue
 * #64). The extension reaches the live session through the
 * SessionModelRoleRegistry the server wires (SpaceService registers each
 * live session; dispose unregisters it). Role → concrete model comes from
 * the space's settings (see resolveRoleTarget). Every switch appends a
 * `model.switched` audit row carrying {role, model, thinking_level, by}.
 *
 * Sessions that cannot switch models mid-session (the agent's own config
 * governs there) surface the driver's documented not-supported result as a
 * tool error.
 */
import type { ExtensionFactory, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { sessionIdFromFilePath, type SessionModelRoleRegistry } from "../server/drivers/agent-driver";
import type { AuditModule } from "../policy/audit";
import { MODEL_SETTINGS_CHANGED_EVENT, MODEL_SWITCHED_EVENT } from "../store/audit-events";
import type { Store, SpaceModelSettings } from "../store/db";
import {
  DEFAULT_MODEL_CATALOG_DIR,
  listAvailableModels,
  MODEL_ROLE_REFS,
  type ModelCatalogEntry,
} from "../models/model-pin";
import { errorMessage, toolError } from "./helpers";

export interface ModelToolsExtensionOpts {
  /** Audit module; every successful set/switch appends a row. */
  audit?: Pick<AuditModule, "appendAudit">;
  /**
   * Live-session registry for `use_model`. Absent → use_model reports the
   * switch as unavailable (no live session can be resolved).
   */
  modelRoles?: SessionModelRoleRegistry;
  /** Actor recorded on audit rows; defaults to "agent". */
  actor?: string;
  /**
   * Agent dir whose model catalog the get surface lists (issue #192).
   * Default "data/omp-agent" (the server/executor default).
   */
  agentDir?: string;
  /**
   * Model-catalog seam (issue #192 tests): resolves the AVAILABLE models
   * the get returns grouped by provider. Defaults to the SDK registry over
   * `agentDir` — the same catalog the sessions see and create_work_item
   * model pins resolve against (issue #185).
   */
  listModels?: (agentDir: string) => Promise<ModelCatalogEntry[]>;
}

/** Thinking-effort values the space may pin; mirrors the store's ModelThinkingLevel. */
export const MODEL_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

const settingsSchema = z.object({
  model: z.string().min(1).optional(),
  reasoning_effort: z.enum(MODEL_THINKING_LEVELS).optional(),
  fast_model: z.string().min(1).optional(),
  reasoning_model: z.string().min(1).optional(),
});

const modelSettingsSchema = z.object({
  /** Partial settings to write; omitted → read the current settings. */
  set: settingsSchema.optional(),
});

const useModelSchema = z.object({
  role: z.enum(["default", "fast", "reasoning"]),
});

/** Argument shapes of the model tools; exported for tests (mirrors memory.ts). */
export { modelSettingsSchema, useModelSchema };

/**
 * Groups the available-model catalog by provider (issue #192), providers
 * and model ids sorted for deterministic output.
 */
export function groupModelsByProvider(
  catalog: ModelCatalogEntry[],
): Array<{ provider: string; models: Array<{ id: string; name: string }> }> {
  const byProvider = new Map<string, Array<{ id: string; name: string }>>();
  for (const m of catalog) {
    const models = byProvider.get(m.provider) ?? [];
    models.push({ id: m.id, name: m.name });
    byProvider.set(m.provider, models);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, models]) => ({ provider, models: models.sort((a, b) => a.id.localeCompare(b.id)) }));
}

/**
 * The model tools as SDK {@link ToolDefinition}s (issue #69): one source
 * shared by the in-session extension surface and the driver's gatedTools
 * path. Restricted SDK sessions (restrictToolNames) drop extension-registered
 * tools entirely, so the definitions ride the custom-tools path in such
 * sessions; the extension registers the same definitions for unrestricted
 * sessions.
 */
export function modelToolsDefinitions(
  store: Store,
  opts: ModelToolsExtensionOpts,
): ToolDefinition[] {
  const actor = opts.actor ?? "agent";

  const settingsTool: ToolDefinition<typeof modelSettingsSchema> = {
    name: "model_settings",
    label: "Per-space model settings",
    description:
      "Reads or updates this space's model settings, which persist per space and are audited. " +
      "With no `set` argument, returns the current settings plus `available_models` — the " +
      "deployment's available model catalog grouped by provider ([{provider, models: [{id, " +
      "name}]}]), the same catalog create_work_item model pins resolve against (issue #185). " +
      "Call it first when asked what models can be used or when a request names a provider or " +
      "provider-aware asks resolve to THAT provider's model (a \"near deepseek\" ask is " +
      "the near provider's deepseek, not opencode-go's) and exact ids like " +
      "\"deepseek-ai/DeepSeek-V4-Flash\" resolve as-is. `set` writes a partial update: " +
      "`model` (the space's default model id), `reasoning_effort` (off|low|medium|high — the " +
      "thinking effort for the reasoning role and the space's default effort), `fast_model` " +
      "and `reasoning_model` (model ids for the fast/reasoning roles; unset slots fall back to " +
      "`model`). Model ids are the ids `available_models` lists (e.g. \"deepseek-v4-flash\"). " +
      "Write-tier: prompts for approval in non-yolo modes.",
    parameters: modelSettingsSchema,
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!spaceId) return toolError("model settings require a space session");
      const before = await store.getSpaceSettings(spaceId);
      if (!params.set) {
        try {
          const catalog = await (opts.listModels ?? listAvailableModels)(opts.agentDir ?? DEFAULT_MODEL_CATALOG_DIR);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ...before, available_models: groupModelsByProvider(catalog) }),
              },
            ],
          };
        } catch (err) {
          return toolError(errorMessage(err));
        }
      }
      if (Object.keys(params.set).length === 0) {
        return toolError("model_settings set requires at least one field");
      }
      // Normalize: whitespace-only strings are rejected (the schema's
      // min(1) only bounds length), everything else is trimmed before
      // persist so settings never store padded ids.
      const after: SpaceModelSettings & Record<string, string | undefined> = { ...before };
      for (const [key, raw] of Object.entries(params.set)) {
        // Every settable knob is a string (model ids and the reasoning_effort enum value alike).
        const trimmed = raw.trim();
        if (!trimmed) return toolError(`model_settings ${key} must not be empty`);
        // Issue #243: the model-id slots must never hold a model ROLE ref
        // ("fast"/"reasoning"). A settings value is an ID the turn-start
        // re-apply routes through the resolver; a role-ref word there is a
        // config error that the driver's best-effort re-apply would silently
        // swallow ("resolved to a role ref, not a model id") instead of
        // applying — fail loudly to the caller now rather than dead-end the
        // default on the next turn.
        if (
          (key === "model" || key.endsWith("_model")) &&
          (MODEL_ROLE_REFS as readonly string[]).includes(trimmed.toLowerCase())
        ) {
          return toolError(
            `model_settings ${key} names the role ref '${trimmed}' — a model ROLE, not a model id; ` +
              `set ${key} to one of the deployment's available model ids (use use_model to switch roles)`,
          );
        }
        after[key] = trimmed;
      }
      try {
        await store.updateSpaceSettings(spaceId, after);
        await opts.audit?.appendAudit({
          actor,
          space_id: spaceId,
          event_type: MODEL_SETTINGS_CHANGED_EVENT,
          payload: JSON.parse(JSON.stringify({ before, after, by: actor })),
        });
        return { content: [{ type: "text", text: JSON.stringify(after) }] };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  const useModelTool: ToolDefinition<typeof useModelSchema> = {
    name: "use_model",
    label: "Switch model role for the next turn",
    description:
      "Switches the agent's model role for the NEXT turn: `default` (the space's `model` setting " +
      "at the space's default effort), `fast` (the space's `fast_model` — or its `model` when " +
      "unset — at low effort; use for simple tasks), or `reasoning` (the space's `reasoning_model` " +
      "— or its `model` when unset — at the space's `reasoning_effort`, default high; use for hard " +
      "tasks). Natural-language requests like \"use the fast model for this\" map to " +
      "use_model {role: \"fast\"}. Configure slots with the model_settings tool; without settings " +
      "nothing switches. Write-tier: prompts for approval in non-yolo modes.",
    parameters: useModelSchema,
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!spaceId) return toolError("use_model requires a space session");
      if (!opts.modelRoles) {
        return toolError("model role switching is not wired in this deployment");
      }
      try {
        const outcome = await opts.modelRoles.switchRole(spaceId, params.role);
        if (!outcome.ok) return toolError(outcome.error);
        const { result } = outcome;
        await opts.audit?.appendAudit({
          actor,
          space_id: spaceId,
          event_type: MODEL_SWITCHED_EVENT,
          payload: {
            role: result.role,
            model: result.model,
            thinking_level: result.thinking_level,
            by: actor,
          },
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  return [settingsTool, useModelTool];
}

export function modelToolsExtension(store: Store, opts: ModelToolsExtensionOpts): ExtensionFactory {
  return (pi) => {
    for (const definition of modelToolsDefinitions(store, opts)) pi.registerTool(definition);
  };
}
