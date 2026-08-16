/**
 * Model tools (issue #64): the agent's chat surface for per-space model
 * configuration.
 *
 * model_settings is write-tier: it mutates durable per-space settings
 * (`spaces.settings`), so it prompts in non-yolo approval modes (the policy
 * gate, issue #6, resolves it via TIER_BY_TOOL → write). Reading (no `set`
 * argument) is the same tool — get-only calls are still write-tier by tool
 * name; the settings themselves are not sensitive. Every successful set
 * appends a `model.settings_changed` audit row carrying {before, after, by}.
 *
 * use_model is write-tier too: it mutates the live session's model for the
 * NEXT turn through the driver's per-session `setModelRole` hook (issue
 * #64). The extension reaches the live session through the
 * SessionModelRoleRegistry the server wires (SpaceService registers each
 * live session; dispose unregisters it). Role → concrete model comes from
 * the space's settings (see resolveRoleTarget). Every switch appends a
 * `model.switched` audit row carrying {role, model, thinking_level, by}.
 *
 * ACP sessions cannot switch models mid-session (the agent's own config
 * governs there) — the registry surfaces the driver's documented
 * not-supported result as a tool error.
 */
import type { ExtensionFactory, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { sessionIdFromFilePath, type ModelRole, type SessionModelRoleRegistry } from "../server/drivers/agent-driver";
import type { AuditModule } from "../policy/audit";
import { MODEL_SETTINGS_CHANGED_EVENT, MODEL_SWITCHED_EVENT } from "../store/audit-events";
import type { Store, SpaceModelSettings } from "../store/db";
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
      "With no `set` argument, returns the current settings. `set` writes a partial update: " +
      "`model` (the space's default model id), `reasoning_effort` (off|low|medium|high — the " +
      "thinking effort for the reasoning role and the space's default effort), `fast_model` " +
      "and `reasoning_model` (model ids for the fast/reasoning roles; unset slots fall back to " +
      "`model`). Model ids are the ids the session lists (e.g. \"deepseek-v4-flash\"). " +
      "Write-tier: prompts for approval in non-yolo modes.",
    parameters: modelSettingsSchema,
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!spaceId) return toolError("model settings require a space session");
      const before = await store.getSpaceSettings(spaceId);
      if (!params.set) {
        return { content: [{ type: "text", text: JSON.stringify(before) }] };
      }
      if (Object.keys(params.set).length === 0) {
        return toolError("model_settings set requires at least one field");
      }
      // Normalize: whitespace-only strings are rejected (the schema's
      // min(1) only bounds length), everything else is trimmed before
      // persist so settings never store padded ids.
      const after: SpaceModelSettings & Record<string, string | undefined> = { ...before };
      for (const [key, raw] of Object.entries(params.set)) {
        if (typeof raw !== "string") continue; // reasoning_effort enum value
        const trimmed = raw.trim();
        if (!trimmed) return toolError(`model_settings ${key} must not be empty`);
        after[key] = trimmed;
      }
      try {
        await store.updateSpaceSettings(spaceId, after);
        await opts.audit?.appendAudit({
          actor,
          space_id: spaceId,
          event_type: MODEL_SETTINGS_CHANGED_EVENT,
          payload: { before, after, by: actor },
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
        const outcome = await opts.modelRoles.switchRole(spaceId, params.role as ModelRole);
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
