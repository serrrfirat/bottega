/**
 * Settings tool (issue #67 Part B): the agent's surface for the durable
 * org/per-space settings — DB is the source of truth, NOT agent-editable
 * YAML (fail-closed parsing + secrets exposure make that the anti-pattern).
 *
 * `settings` is write-tier: it mutates durable org policy, so it prompts in
 * non-yolo approval modes (the policy gate, issue #6, resolves it via
 * TIER_BY_TOOL → write). Every successful set appends a `settings.changed`
 * audit row carrying {scope, actor, before, after} — the before/after
 * blobs, never secrets (the settings blob holds no credentials; the audit
 * module redacts defensively anyway).
 *
 * Scope:
 * - `org` (default): get/set the org settings blob (org_settings row) —
 *   approval timeouts, always_approve, response_mode, memory injection,
 *   extensions allow/deny/org_credentials, repo allowlist, model defaults
 *   (default/fast/reasoning + effort), workspaces dir, git/api base URLs,
 *   loose-PAT dev override, memory backend URL. Set merges partially over
 *   the current blob; validation is fail-closed (setOrgSettings throws on
 *   invalid input and writes nothing).
 * - `space`: get/set the per-space policy overlay (spaces.policy_json) —
 *   the knobs the overlay supports: response_mode (clamped to the org
 *   floor's strictness at read), extensions.allow (ids to REMOVE from the
 *   org floor allowlist), extensions.deny (ids to ADD), and
 *   extensions.org_credentials (clamped like response_mode). Per-space
 *   MODEL knobs live in the model_settings tool (issue #64) — the smallest
 *   split with that tool, no duplicate surface.
 *
 * Get (no `set`): returns the stored blob (or null) plus the EFFECTIVE
 * policy for the scope (file floor + DB + overlay), so the agent sees what
 * actually governs, not just what is stored.
 */
import type { ExtensionFactory, AgentToolResult } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { Store } from "../store/db";
import { type OrgSettings, type OrgSettingsInput } from "../store/org-settings";
import { SETTINGS_CHANGED_EVENT } from "../store/audit-events";
import { loadOrgPolicy, loadSpacePolicy, type PolicyConfig } from "../policy/config";
import { errorMessage, toolError } from "./helpers";
import type { AuditModule } from "../policy/audit";

export interface SettingsToolsExtensionOpts {
  /** Audit module; every successful set appends a `settings.changed` row. */
  audit?: Pick<AuditModule, "appendAudit">;
  /** Actor recorded on audit rows; defaults to "agent". */
  actor?: string;
}

/** Org-scope settable knobs — snake_case, mirrors the stored blob (OrgSettingsInput). */
export const settingsSetSchema = z.object({
  approvals: z
    .object({
      timeout_minutes: z.number().int().min(1).max(1440).optional(),
      always_approve: z.array(z.string()).optional(),
    })
    .optional(),
  response_mode: z.enum(["always", "mention", "request-only"]).optional(),
  memory: z
    .object({
      injection: z
        .object({
          enabled: z.boolean().optional(),
          max_entries: z.number().int().min(1).max(20).optional(),
        })
        .optional(),
    })
    .optional(),
  extensions: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      org_credentials: z.enum(["allow", "deny"]).optional(),
    })
    .optional(),
  repos: z.array(z.string()).optional(),
  models: z
    .object({
      default: z.string().optional(),
      fast: z.string().optional(),
      reasoning: z.string().optional(),
      effort: z.string().optional(),
    })
    .optional(),
  workspaces_dir: z.string().optional(),
  git_base_url: z.string().optional(),
  api_base_url: z.string().optional(),
  allow_loose_pat: z.boolean().optional(),
  memory_backend: z
    .object({
      base_url: z.string().optional(),
    })
    .optional(),
});
export type SettingsSetInput = z.infer<typeof settingsSetSchema>;

/** Tool args: scope + optional `set` partial (absent = get). */
export const settingsArgsSchema = z.object({
  scope: z.enum(["org", "space"]).default("org"),
  /** Space id (e.g. "slack:C123") — required when scope is "space". */
  space: z.string().optional(),
  /** Partial knobs to set; omitted → get the current settings. */
  set: settingsSetSchema.optional(),
});

/** The overlay keys the space scope may set (issue #67; mirrors applySpaceOverlay). */
const SPACE_SETTABLE_KEYS = ["response_mode", "extensions"] as const;

/** Effective-policy view for the agent: the governing knobs, not the stored blob. */
function policyView(policy: PolicyConfig): Record<string, unknown> {
  return {
    ok: policy.ok,
    timeout_minutes: policy.timeoutMinutes,
    response_mode: policy.responseMode,
    memory_injection: { enabled: policy.memory.injection.enabled, max_entries: policy.memory.injection.maxEntries },
    extensions: {
      allow: policy.extensionsAllow,
      deny: policy.extensionsDeny,
      org_credentials: policy.orgCredentials,
    },
    agent_driver: policy.agentDriver,
  };
}

/** Deep merge of a partial set over a base input: objects merge per-key, arrays/scalars replace. */
function mergeSettingsInput(base: OrgSettingsInput, partial: SettingsSetInput): OrgSettingsInput {
  const out: OrgSettingsInput = { ...base };
  if (partial.approvals !== undefined) {
    out.approvals = { ...base.approvals, ...partial.approvals };
  }
  if (partial.response_mode !== undefined) out.response_mode = partial.response_mode;
  if (partial.memory !== undefined) {
    const baseInjection = base.memory?.injection;
    out.memory = {
      injection: {
        ...(baseInjection?.enabled !== undefined ? { enabled: baseInjection.enabled } : {}),
        ...(baseInjection?.max_entries !== undefined ? { max_entries: baseInjection.max_entries } : {}),
        ...(partial.memory.injection?.enabled !== undefined ? { enabled: partial.memory.injection.enabled } : {}),
        ...(partial.memory.injection?.max_entries !== undefined
          ? { max_entries: partial.memory.injection.max_entries }
          : {}),
      },
    };
  }
  if (partial.extensions !== undefined) {
    out.extensions = { ...base.extensions, ...partial.extensions };
  }
  if (partial.repos !== undefined) out.repos = partial.repos;
  if (partial.models !== undefined) {
    out.models = { ...base.models, ...partial.models };
  }
  if (partial.workspaces_dir !== undefined) out.workspaces_dir = partial.workspaces_dir;
  if (partial.git_base_url !== undefined) out.git_base_url = partial.git_base_url;
  if (partial.api_base_url !== undefined) out.api_base_url = partial.api_base_url;
  if (partial.allow_loose_pat !== undefined) out.allow_loose_pat = partial.allow_loose_pat;
  if (partial.memory_backend !== undefined) {
    out.memory_backend = { ...base.memory_backend, ...partial.memory_backend };
  }
  return out;
}

/** Serializes a validated OrgSettings (camelCase) back to the snake_case input shape. */
function orgSettingsToInput(settings: OrgSettings): OrgSettingsInput {
  const input: OrgSettingsInput = {};
  if (settings.approvals !== undefined) {
    input.approvals = {
      ...(settings.approvals.timeoutMinutes !== undefined
        ? { timeout_minutes: settings.approvals.timeoutMinutes }
        : {}),
      ...(settings.approvals.alwaysApprove !== undefined ? { always_approve: settings.approvals.alwaysApprove } : {}),
    };
  }
  if (settings.responseMode !== undefined) input.response_mode = settings.responseMode;
  if (settings.memory?.injection !== undefined) {
    input.memory = {
      injection: {
        ...(settings.memory.injection.enabled !== undefined ? { enabled: settings.memory.injection.enabled } : {}),
        ...(settings.memory.injection.maxEntries !== undefined
          ? { max_entries: settings.memory.injection.maxEntries }
          : {}),
      },
    };
  }
  if (settings.extensions !== undefined) {
    input.extensions = {
      ...(settings.extensions.allow !== undefined ? { allow: settings.extensions.allow } : {}),
      ...(settings.extensions.deny !== undefined ? { deny: settings.extensions.deny } : {}),
      ...(settings.extensions.orgCredentials !== undefined
        ? { org_credentials: settings.extensions.orgCredentials }
        : {}),
    };
  }
  if (settings.repos !== undefined) input.repos = settings.repos;
  if (settings.models !== undefined) {
    input.models = {
      ...(settings.models.default !== undefined ? { default: settings.models.default } : {}),
      ...(settings.models.fast !== undefined ? { fast: settings.models.fast } : {}),
      ...(settings.models.reasoning !== undefined ? { reasoning: settings.models.reasoning } : {}),
      ...(settings.models.effort !== undefined ? { effort: settings.models.effort } : {}),
    };
  }
  if (settings.workspacesDir !== undefined) input.workspaces_dir = settings.workspacesDir;
  if (settings.gitBaseUrl !== undefined) input.git_base_url = settings.gitBaseUrl;
  if (settings.apiBaseUrl !== undefined) input.api_base_url = settings.apiBaseUrl;
  if (settings.allowLoosePat !== undefined) input.allow_loose_pat = settings.allowLoosePat;
  if (settings.memoryBackend?.baseUrl !== undefined) {
    input.memory_backend = { base_url: settings.memoryBackend.baseUrl };
  }
  return input;
}

export function settingsToolsExtension(store: Store, opts: SettingsToolsExtensionOpts = {}): ExtensionFactory {
  const actor = opts.actor ?? "agent";
  return (pi) => {
    pi.registerTool({
      name: "settings",
      label: "Read or change bottega settings",
      description:
        "Reads or changes the durable org/per-space settings (the DB, not config files — the DB is the " +
        "source of truth; config files are defaults). Write-tier: prompts for approval in non-yolo modes. " +
        "Org scope knobs: approvals.timeout_minutes / always_approve, response_mode, " +
        "memory.injection.enabled / max_entries, extensions.allow / deny / org_credentials, repos " +
        "(owner/repo allowlist), models.default / fast / reasoning / effort, workspaces_dir, " +
        "git_base_url, api_base_url, allow_loose_pat, memory_backend.base_url. Space scope knobs " +
        "(the policy overlay): response_mode, extensions.allow (ids to REMOVE from the org floor " +
        "allowlist), extensions.deny (ids to ADD), extensions.org_credentials. Omit `set` to read: " +
        "returns the stored settings plus the effective policy. Per-space model knobs live in the " +
        "model_settings tool.",
      parameters: settingsArgsSchema,
      approval: "write",
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> {
        try {
          if (params.scope === "space") {
            return await handleSpace(store, opts, actor, params);
          }
          return await handleOrg(store, opts, actor, params);
        } catch (err) {
          return toolError(errorMessage(err));
        }
      },
    });
  };
}

async function handleOrg(
  store: Store,
  opts: SettingsToolsExtensionOpts,
  actor: string,
  params: z.infer<typeof settingsArgsSchema>,
): Promise<AgentToolResult> {
  const current = store.getOrgSettings();
  const orgPolicy = loadOrgPolicy(store);
  if (params.set === undefined) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            scope: "org",
            settings: current !== null ? orgSettingsToInput(current) : null,
            policy: policyView(orgPolicy),
          }),
        },
      ],
    };
  }
  const before = current !== null ? orgSettingsToInput(current) : {};
  const merged = mergeSettingsInput(before, params.set);
  const after = store.setOrgSettings(merged);
  await opts.audit?.appendAudit({
    actor,
    event_type: SETTINGS_CHANGED_EVENT,
    payload: { scope: "org", actor, before, after: orgSettingsToInput(after) },
  });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ scope: "org", settings: orgSettingsToInput(after), policy: policyView(loadOrgPolicy(store)) }),
      },
    ],
  };
}

async function handleSpace(
  store: Store,
  opts: SettingsToolsExtensionOpts,
  actor: string,
  params: z.infer<typeof settingsArgsSchema>,
): Promise<AgentToolResult> {
  const spaceId = params.space;
  if (!spaceId) return toolError("space scope requires `space` (e.g. \"slack:C123\")");
  const space = await store.getSpace(spaceId);
  if (!space) return toolError(`space not found: ${spaceId}`);
  const orgPolicy = loadOrgPolicy(store);
  const effective = await loadSpacePolicy(orgPolicy, store, spaceId);
  if (params.set === undefined) {
    let overlay: unknown = null;
    if (space.policy_json.trim()) {
      try {
        overlay = JSON.parse(space.policy_json);
      } catch {
        overlay = null; // malformed overlay fails the policy closed; surface it as stored-raw
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ scope: "space", space: spaceId, overlay, policy: policyView(effective) }),
        },
      ],
    };
  }
  // The overlay supports a strict subset of the org knobs; anything else is
  // rejected (fail closed — never silently drop a requested change).
  const requested = Object.keys(params.set);
  for (const key of requested) {
    if (!(SPACE_SETTABLE_KEYS as readonly string[]).includes(key)) {
      return toolError(
        `space scope cannot set '${key}' — space knobs are limited to ${SPACE_SETTABLE_KEYS.join(", ")} ` +
          "(use org scope or the model_settings tool for the rest)",
      );
    }
  }
  const before = space.policy_json.trim() ? (JSON.parse(space.policy_json) as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...before };
  if (params.set.response_mode !== undefined) merged["response_mode"] = params.set.response_mode;
  if (params.set.extensions !== undefined) {
    const existing = typeof merged["extensions"] === "object" && merged["extensions"] !== null
      ? (merged["extensions"] as Record<string, unknown>)
      : {};
    merged["extensions"] = { ...existing, ...params.set.extensions };
  }
  const updated = await store.updatePolicy(spaceId, JSON.stringify(merged));
  const updatedEffective = await loadSpacePolicy(loadOrgPolicy(store), store, spaceId);
  await opts.audit?.appendAudit({
    actor,
    space_id: spaceId,
    event_type: SETTINGS_CHANGED_EVENT,
    payload: { scope: "space", space: spaceId, actor, before, after: merged },
  });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          scope: "space",
          space: spaceId,
          overlay: JSON.parse(updated.policy_json),
          policy: policyView(updatedEffective),
        }),
      },
    ],
  };
}
