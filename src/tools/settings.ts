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
 *   loose-PAT dev override, memory backend URL, onboarding space id
 *   (issue #116: the space that receives the boot-time onboarding guide),
 *   secrets_backend (issue #190: the credential vault backend — omp-broker
 *   default, or a 1Password Connect server; the Connect token stays in
 *   .env).
 *   Set merges partially over
 *   the current blob; validation is fail-closed (setOrgSettings throws on
 *   invalid input and writes nothing).
 * - `space`: get/set the per-space policy overlay (spaces.policy_json) —
 *   the knobs the overlay supports: response_mode (clamped to the org
 *   floor's strictness at read), extensions.allow (ids to REMOVE from the
 *   org floor allowlist), extensions.deny (ids to ADD),
 *   extensions.org_credentials (clamped like response_mode), and
 *   proactive.standup / proactive.reflection (the scheduler's per-space
 *   opt-in, issue #150). Per-space MODEL knobs live in the model_settings
 *   tool (issue #64) — the smallest split with that tool, no duplicate
 *   surface.
 *
 * Get (no `set`): returns the stored blob (or null) plus the EFFECTIVE
 * policy for the scope (file floor + DB + overlay), so the agent sees what
 * actually governs, not just what is stored.
 */
import type { ExtensionFactory, AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { Store } from "../store/db";
import { type OrgSettings, type OrgSettingsInput } from "../store/org-settings";
import { SETTINGS_CHANGED_EVENT } from "../store/audit-events";
import { loadOrgPolicy, loadSpacePolicy, type PolicyConfig } from "../policy/config";
import type { ApprovalRouter } from "../policy/approval-router";
import { evaluatePolicyGate } from "../policy/gate";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import { regenerateModelsConfig } from "../models/generate";
import { errorMessage, toolError } from "./helpers";
import type { AuditModule } from "../policy/audit";
import { join } from "node:path";

/**
 * Synthetic exec-tier tool name for the org-write approver gate (issue
 * #151): org-scope `set` calls cross the shared decision table under this
 * name (TIER_BY_TOOL → exec), so they route ask-human through the approval
 * router like every exec-tier tool. Never a user-visible tool.
 */
export const SETTINGS_ORG_WRITE_TOOL = "settings_org_write";

export interface SettingsToolsExtensionOpts {
  /** Audit module; every successful set appends a `settings.changed` row. */
  audit?: Pick<AuditModule, "appendAudit">;
  /** Actor recorded on audit rows; defaults to "agent". */
  actor?: string;
  /**
   * Policy gate for org-scope writes (issue #151): every org-scope `set`
   * call crosses the shared decision table as an exec-tier call
   * (SETTINGS_ORG_WRITE_TOOL) and routes ask-human through the approval
   * router — the same approver flow as exec-tier tools, so an org write
   * that loosens the policy floor (always_approve, extensions) can never
   * land without a human approver. The gate audits
   * policy.decision/approval.requested/approval.resolved via `audit`.
   * Absent → org-scope writes fail closed (rejected); the approval seam
   * must be wired before org writes exist.
   */
  gate?: {
    loadPolicy: (spaceId: string | undefined) => Promise<PolicyConfig>;
    router: ApprovalRouter;
    /** Ask-human timeout in ms; defaults to the policy's approvals.timeout_minutes. */
    timeoutMs?: number;
    /** Executor-session scope (issue #11); see decidePolicyCall. */
    preApproved?: boolean;
  };
  /**
   * The deployment agent dir (issue #207): when set, every successful
   * org-scope write regenerates the agent-dir models.yml catalog from the
   * updated settings, so a fresh session resolves the new default model
   * instead of a boot-stale catalog. Unset → no regeneration (the boot
   * still regenerates; catalog staleness is bounded by the next boot).
   */
  agentDir?: string;
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
  proactive: z
    .object({
      standup: z.boolean().optional(),
      reflection: z.boolean().optional(),
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
  onboarding: z
    .object({
      space_id: z.string().optional(),
    })
    .optional(),
  secrets_backend: z
    .object({
      type: z.enum(["omp-broker", "1password-connect"]),
      connect_url: z.string().optional(),
      mapping: z
        .record(
          z.string(),
          z.object({
            vault: z.string().min(1),
            item: z.string().min(1),
            field: z.string().min(1),
            type: z.enum(["api_key", "oauth"]).optional(),
          }),
        )
        .optional(),
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
const SPACE_SETTABLE_KEYS = ["response_mode", "extensions", "proactive"] as const;

/**
 * The stored policy overlay's value type: arbitrary JSON. Unknown keys are
 * preserved verbatim on re-save (the settings tool only ever rewrites the
 * keys it manages).
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Stored-overlay guard: returns the value as a JSON record when it is an
 * object (arrays included, matching the old typeof-object check), else an
 * empty record so a malformed stored value is replaced, never merged.
 */
function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || value === undefined || !(value instanceof Object)) return {};
  // SAFETY: the instanceof guard just excluded null/primitives; a JSON value that is an object is an array or a plain record.
  return value as Record<string, JsonValue>;
}

/** Effective-policy view for the agent: the governing knobs, not the stored blob. */
function policyView(policy: PolicyConfig) {
  return {
    ok: policy.ok,
    timeout_minutes: policy.timeoutMinutes,
    always_approve: policy.alwaysApprove,
    response_mode: policy.responseMode,
    memory_injection: { enabled: policy.memory.injection.enabled, max_entries: policy.memory.injection.maxEntries },
    extensions: {
      allow: policy.extensionsAllow,
      deny: policy.extensionsDeny,
      org_credentials: policy.orgCredentials,
    },
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
        ...(baseInjection?.enabled !== undefined ? { enabled: baseInjection.enabled } : undefined),
        ...(baseInjection?.max_entries !== undefined ? { max_entries: baseInjection.max_entries } : undefined),
        ...(partial.memory.injection?.enabled !== undefined ? { enabled: partial.memory.injection.enabled } : undefined),
        ...(partial.memory.injection?.max_entries !== undefined
          ? { max_entries: partial.memory.injection.max_entries }
          : undefined),
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
  if (partial.onboarding !== undefined) {
    out.onboarding = { ...base.onboarding, ...partial.onboarding };
  }
  if (partial.secrets_backend !== undefined) {
    out.secrets_backend = { ...base.secrets_backend, ...partial.secrets_backend };
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
        : undefined),
      ...(settings.approvals.alwaysApprove !== undefined ? { always_approve: settings.approvals.alwaysApprove } : undefined),
    };
  }
  if (settings.responseMode !== undefined) input.response_mode = settings.responseMode;
  if (settings.memoryInjection !== undefined) {
    input.memory = {
      injection: {
        ...(settings.memoryInjection.enabled !== undefined ? { enabled: settings.memoryInjection.enabled } : undefined),
        ...(settings.memoryInjection.maxEntries !== undefined
          ? { max_entries: settings.memoryInjection.maxEntries }
          : undefined),
      },
    };
  }
  if (settings.extensions !== undefined) {
    input.extensions = {
      ...(settings.extensions.allow !== undefined ? { allow: settings.extensions.allow } : undefined),
      ...(settings.extensions.deny !== undefined ? { deny: settings.extensions.deny } : undefined),
      ...(settings.extensions.orgCredentials !== undefined
        ? { org_credentials: settings.extensions.orgCredentials }
        : undefined),
    };
  }
  if (settings.repos !== undefined) input.repos = settings.repos;
  if (settings.models !== undefined) {
    input.models = {
      ...(settings.models.default !== undefined ? { default: settings.models.default } : undefined),
      ...(settings.models.fast !== undefined ? { fast: settings.models.fast } : undefined),
      ...(settings.models.reasoning !== undefined ? { reasoning: settings.models.reasoning } : undefined),
      ...(settings.models.effort !== undefined ? { effort: settings.models.effort } : undefined),
    };
  }
  if (settings.workspacesDir !== undefined) input.workspaces_dir = settings.workspacesDir;
  if (settings.gitBaseUrl !== undefined) input.git_base_url = settings.gitBaseUrl;
  if (settings.apiBaseUrl !== undefined) input.api_base_url = settings.apiBaseUrl;
  if (settings.allowLoosePat !== undefined) input.allow_loose_pat = settings.allowLoosePat;
  if (settings.memoryBackend?.baseUrl !== undefined) {
    input.memory_backend = { base_url: settings.memoryBackend.baseUrl };
  }
  if (settings.onboarding?.spaceId !== undefined) {
    input.onboarding = { space_id: settings.onboarding.spaceId };
  }
  if (settings.secretsBackend !== undefined) {
    input.secrets_backend = {
      type: settings.secretsBackend.type,
      ...(settings.secretsBackend.connectUrl !== undefined ? { connect_url: settings.secretsBackend.connectUrl } : undefined),
      ...(settings.secretsBackend.mapping !== undefined ? { mapping: settings.secretsBackend.mapping } : undefined),
    };
  }
  return input;
}

export type SettingsToolDefinition = ToolDefinition<typeof settingsArgsSchema>;

/**
 * The settings tool as an SDK {@link ToolDefinition} (issue #69): one source
 * shared by the in-session extension surface and the driver's gatedTools
 * path. Restricted SDK sessions (restrictToolNames) drop extension-registered
 * tools entirely, so the definition rides the custom-tools path in such
 * sessions; the extension registers the same definition for unrestricted
 * sessions.
 */
export function settingsToolDefinitions(store: Store, opts: SettingsToolsExtensionOpts = {}): ToolDefinition[] {
  const actor = opts.actor ?? "agent";
  const definition: SettingsToolDefinition = {
    name: "settings",
    label: "Read or change bottega settings",
    description:
      "Reads or changes the durable org/per-space settings (the DB, not config files — the DB is the " +
      "source of truth; config files are defaults). Write-tier: prompts for approval in non-yolo modes. " +
      "ORG-scope writes additionally require a human approver (routed through the approval flow like " +
      "exec-tier tools); the effective policy clamps always_approve and extensions to tighten-only " +
      "relative to the config-file floor. " +
      "Org scope knobs: approvals.timeout_minutes / always_approve, response_mode, " +
      "memory.injection.enabled / max_entries, extensions.allow / deny / org_credentials, repos " +
      "(owner/repo allowlist), models.default / fast / reasoning / effort, workspaces_dir, " +
      "git_base_url, api_base_url, allow_loose_pat, memory_backend.base_url, onboarding.space_id " +
      "(the space that receives the boot-time onboarding guide), secrets_backend (the credential " +
      "vault backend: type omp-broker [default] or 1password-connect with connect_url + a mapping " +
      "of \"provider:identityKey\" to {vault, item, field}; the Connect token itself stays in .env " +
      "as OP_CONNECT_TOKEN — secrets never enter settings). Space scope knobs " +
      "the policy overlay): response_mode, extensions.allow (ids to REMOVE from the org floor " +
      "allowlist), extensions.deny (ids to ADD), extensions.org_credentials, " +
      "proactive.standup / proactive.reflection (the scheduler's per-space opt-in). Omit `set` to read: " +
      "returns the stored settings plus the effective policy. Per-space model knobs live in the " +
      "model_settings tool.",
    parameters: settingsArgsSchema,
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      try {
        if (params.set !== undefined && Object.keys(params.set).length === 0) {
          return toolError("settings set requires at least one field");
        }
        if (params.scope !== "space" && params.set?.proactive !== undefined) {
          return toolError('proactive is a space-scope knob — set it with scope: "space"');
        }
        const spaceId = sessionIdFromFilePath(ctx?.sessionManager?.getSessionFile());
        if (params.scope === "space") {
          return await handleSpace(store, opts, actor, params);
        }
        return await handleOrg(store, opts, actor, params, spaceId);
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };
  return [definition];
}

export function settingsToolsExtension(store: Store, opts: SettingsToolsExtensionOpts = {}): ExtensionFactory {
  return (pi) => {
    for (const definition of settingsToolDefinitions(store, opts)) pi.registerTool(definition);
  };
}

async function handleOrg(
  store: Store,
  opts: SettingsToolsExtensionOpts,
  actor: string,
  params: z.infer<typeof settingsArgsSchema>,
  spaceId: string | undefined,
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
  // Org-scope writes are approver-gated (issue #151): they cross the
  // shared decision table as an exec-tier call (SETTINGS_ORG_WRITE_TOOL),
  // so ask-human routes through the approval router — the same flow as
  // every exec-tier tool. An org write that loosens the policy floor
  // (always_approve, extensions) can never land without a human approver.
  // Fail closed: no gate (or no audit seam) → org writes are rejected, the
  // approval router never bypassed.
  if (!opts.gate || !opts.audit) {
    return toolError("org-scope settings writes are not enabled in this deployment (approval gate not wired)");
  }
  const outcome = await evaluatePolicyGate(
    {
      loadPolicy: opts.gate.loadPolicy,
      // The gate only uses appendAudit; the settings.changed audit below
      // writes through the same module.
      // SAFETY: the gate calls only appendAudit on this module, which opts.audit (Pick<AuditModule, "appendAudit">) already provides; listAudit is never invoked here.
      audit: opts.audit as AuditModule,
      router: opts.gate.router,
      timeoutMs: opts.gate.timeoutMs,
      preApproved: opts.gate.preApproved,
    },
    {
      tool: SETTINGS_ORG_WRITE_TOOL,
      args: { scope: "org", set: params.set },
      spaceId,
      actor,
    },
  );
  if (!outcome.allowed) return toolError(outcome.blockReason);
  const before = current !== null ? orgSettingsToInput(current) : {};
  const merged = mergeSettingsInput(before, params.set);
  const after = store.setOrgSettings(merged);
  // Issue #207: keep the SDK catalog in lockstep with the settings — the
  // agent-dir models.yml is boot-generated, so an org-scope update would
  // otherwise leave a fresh session resolving against a boot-stale catalog
  // and fail closed onto the stale pin. Idempotent: no model ids → null.
  if (opts.agentDir !== undefined) {
    regenerateModelsConfig(after, join(opts.agentDir, "models.yml"));
  }
  await opts.audit.appendAudit({
    actor,
    event_type: SETTINGS_CHANGED_EVENT,
    payload: JSON.parse(JSON.stringify({ scope: "org", actor, before, after: orgSettingsToInput(after) })),
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
    let overlay = null;
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
    if (!SPACE_SETTABLE_KEYS.some((k) => k === key)) {
      return toolError(
        `space scope cannot set '${key}' — space knobs are limited to ${SPACE_SETTABLE_KEYS.join(", ")} ` +
          "(use org scope or the model_settings tool for the rest)",
      );
    }
  }
  // SAFETY: stored policy_json is a JSON object (applySpaceOverlay validates it as such on every read); unknown keys are preserved verbatim below.
  const before: Record<string, JsonValue> = space.policy_json.trim()
    ? (JSON.parse(space.policy_json) as Record<string, JsonValue>)
    : {};
  const merged = { ...before };
  if (params.set.response_mode !== undefined) merged["response_mode"] = params.set.response_mode;
  if (params.set.extensions !== undefined) {
    const existing = jsonRecord(merged["extensions"]);
    merged["extensions"] = { ...existing, ...params.set.extensions };
  }
  if (params.set.proactive !== undefined) {
    const existing = jsonRecord(merged["proactive"]);
    merged["proactive"] = { ...existing, ...params.set.proactive };
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
