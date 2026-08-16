/**
 * Policy types + loader (issue #6).
 *
 * Org floor comes from `config.yml` (repo root, or `BOTTEGA_CONFIG_DIR`);
 * spaces tighten it via `spaces.policy_json` (JSON overlay, only ever
 * tightens). Strict validation: anything malformed denies — never silently
 * allows. A missing config.yml is a fail-closed default policy (everything
 * denies unless explicitly allowed).
 *
 * `approvals` keys: `timeout_minutes` (ask-human timeout, default 5),
 * `required_for_org_change` (reserved), and `always_approve` (issue #45) —
 * an allowlist of exec-tier tools that skip the ask-human prompt when their
 * policy action is `allow`; known tool names only, unknown names fail the
 * policy closed. The space overlay can only remove entries from that list.
 *
 * `extensions` keys (issue #56): `allow`/`deny` id lists (empty = no
 * restriction; non-empty allow = only those ids usable; deny wins over
 * allow) and `org_credentials: allow|deny` (org-credential usage in `auto`
 * resolution, default allow). The overlay tightens: it removes from the
 * org allowlist, adds to the org deny list, and clamps org_credentials
 * like response_mode. Ids are format-validated here and existence-validated
 * against the registry at the gate (unknown id → fail closed).
 *
 * YAML: deliberately dependency-free — parsed by the shared YAML-subset
 * parser (src/yaml-subset.ts). Anything outside that subset is a
 * structural error that fails the whole policy closed. A subset parser is
 * safe here because denial is the default for everything it cannot
 * understand.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION_ID_RE } from "../extensions/manifest";
import type { Store } from "../store/db";
import { parseYamlSubset, type YamlNode } from "../yaml-subset";

export type Tier = "read" | "write" | "exec";
export type PolicyAction = "allow" | "deny" | "prompt";
export type Decision = "allow" | "deny" | "ask-human";

/** Space-agent driver selected by the org config (`agent.driver`, issue #26). */
export type AgentDriverName = "acp" | "omp-sdk";
export const DEFAULT_AGENT_DRIVER: AgentDriverName = "omp-sdk";
/**
 * Per-space response mode (issue #55): when the agent acts at all.
 * - `always`: every non-bot message is a turn (today's behavior).
 * - `mention`: only messages that @mention the bot (or DMs) become turns.
 * - `request-only`: everything is forwarded for context coherence, but the
 *   agent is told to act only on explicit requests.
 */
export type ResponseMode = "always" | "mention" | "request-only";

export const DEFAULT_RESPONSE_MODE: ResponseMode = "always";

/**
 * Per-space org-credential usage (issue #56): whether `auto` credential
 * resolution may use org-scoped credentials in this space. Default allow —
 * org usage is gated at connect by approval anyway.
 */
export type OrgCredentialsMode = "allow" | "deny";
export const DEFAULT_ORG_CREDENTIALS: OrgCredentialsMode = "allow";

export const DEFAULT_TIMEOUT_MINUTES = 5;
export const DEFAULT_REQUIRED_APPROVERS = 1;
export const DEFAULT_UNKNOWN_ACTION: PolicyAction = "deny";

/** Tightening order for response modes: always → mention → request-only. */
const RESPONSE_MODE_STRICTNESS: Record<ResponseMode, number> = {
  always: 0,
  mention: 1,
  "request-only": 2,
};

const RESPONSE_MODE_VALUES: readonly ResponseMode[] = ["always", "mention", "request-only"];

function normalizeResponseMode(value: unknown): ResponseMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (RESPONSE_MODE_VALUES as readonly string[]).includes(normalized)
    ? (normalized as ResponseMode)
    : undefined;
}

/** The stricter of two response modes (mention/request-only tighten; always is the floor). */
export function stricterResponseMode(a: ResponseMode, b: ResponseMode): ResponseMode {
  return RESPONSE_MODE_STRICTNESS[b] > RESPONSE_MODE_STRICTNESS[a] ? b : a;
}

/** Tightening order for org-credential usage: allow → deny. */
const ORG_CREDENTIALS_STRICTNESS: Record<OrgCredentialsMode, number> = { allow: 0, deny: 1 };
const ORG_CREDENTIALS_VALUES: readonly OrgCredentialsMode[] = ["allow", "deny"];

function normalizeOrgCredentials(value: unknown): OrgCredentialsMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (ORG_CREDENTIALS_VALUES as readonly string[]).includes(normalized)
    ? (normalized as OrgCredentialsMode)
    : undefined;
}

/** The stricter of two org-credential modes (deny tightens; allow is the floor). */
export function stricterOrgCredentials(a: OrgCredentialsMode, b: OrgCredentialsMode): OrgCredentialsMode {
  return ORG_CREDENTIALS_STRICTNESS[b] > ORG_CREDENTIALS_STRICTNESS[a] ? b : a;
}

/** Whether the space policy allows using org-scoped credentials (extensions.org_credentials, default allow). */
export function orgCredentialsAllowed(policy: PolicyConfig): boolean {
  return policy.orgCredentials === "allow";
}

/** Capability tier per known OMP tool. Unknown/malformed names resolve to exec. */
const TIER_BY_TOOL: Record<string, Tier> = {
  read: "read",
  glob: "read",
  grep: "read",
  ast_grep: "read",
  web_search: "read",
  inspect_image: "read",
  lsp: "read",
  write: "write",
  edit: "write",
  bash: "exec",
  task: "exec",
  create_work_item: "exec",
  work_item_cancel: "exec",
  // Memory tools (issue #22): save mutates durable state (write — prompts
  // in non-yolo modes), search only queries (read).
  "memory.save": "write",
  "memory.search": "read",
};

export interface MemoryInjectionConfig {
  /** Master switch for turn-start memory injection (issue #42). Default true. */
  enabled: boolean;
  /** Max memory entries per injected message. Default 5, capped at 20. */
  maxEntries: number;
}

export interface PolicyConfig {
  /** Structural validity. False → every decision denies (fail closed). */
  ok: boolean;
  /** Explicit per-tool actions; malformed entries are pinned to "deny". */
  tools: Record<string, PolicyAction>;
  /** Default action for tools without an entry (the `unknown` key). */
  unknownAction: PolicyAction;
  /** Ask-human timeout for the approval router. */
  timeoutMinutes: number;
  /** Approvers required for org-level changes (consumed by the Slack router, later issue). */
  requiredApprovers: number;
  /** Space approvers (issue #33): the overlay's `approvers` list; org floor default is none. */
  approvers: string[];
  /**
   * Always-approve opt-in (issue #45): exec-tier tools listed here skip the
   * ask-human prompt when their policy action is `allow` (explicit deny/
   * prompt and unknown tools still win). Org floor only — the space overlay
   * can only remove entries. Auto-approvals audit `approval.resolved` with
   * `approver: "policy"`.
   */
  alwaysApprove: string[];
  /** Memory-context injection settings (issue #42); org floor only — the overlay cannot change them. */
  memory: { injection: MemoryInjectionConfig };

  /** Space-agent driver (`agent.driver` in config.yml, issue #26). Default omp-sdk; acp is opt-in. */
  agentDriver: AgentDriverName;
  /** Response mode (issue #55): when the space agent acts; org floor default is `always`. */
  responseMode: ResponseMode;
  /**
   * Extension allowlist (issue #56): the org floor's `extensions.allow`
   * list. Empty = no allow restriction (the registry is the base
   * allowlist); non-empty = only the listed extension ids may be used.
   * The space overlay can only remove entries.
   */
  extensionsAllow: string[];
  /**
   * Extension deny list (issue #56): ids never usable, deny wins over
   * allow. The space overlay can only add entries.
   */
  extensionsDeny: string[];
  /** Org-credential usage (issue #56): `extensions.org_credentials`, default allow; overlay can only tighten. */
  orgCredentials: OrgCredentialsMode;
  errors: string[];
  warnings: string[];
}

/** `memory.injection.max_entries` default and ceiling (search caps at 20). */
export const DEFAULT_MEMORY_INJECTION_MAX_ENTRIES = 5;
export const MEMORY_INJECTION_MAX_ENTRIES_CAP = 20;

export function defaultPolicy(): PolicyConfig {
  return {
    ok: true,
    tools: {},
    unknownAction: DEFAULT_UNKNOWN_ACTION,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    requiredApprovers: DEFAULT_REQUIRED_APPROVERS,
    approvers: [],
    alwaysApprove: [],
    memory: { injection: { enabled: true, maxEntries: DEFAULT_MEMORY_INJECTION_MAX_ENTRIES } },

    agentDriver: DEFAULT_AGENT_DRIVER,
    responseMode: DEFAULT_RESPONSE_MODE,
    extensionsAllow: [],
    extensionsDeny: [],
    orgCredentials: DEFAULT_ORG_CREDENTIALS,
    errors: [],
    warnings: [],
  };
}

/**
 * The decision table (tier × policy action × known tool).
 *
 * - policy deny → deny
 * - unknown tool (not in the tier table) → deny, whatever the policy says
 * - policy prompt → ask-human
 * - exec tier → ask-human even when policy allows (never fail open on exec)
 * - everything else → allow
 */
export function decideToolCall(input: {
  tier: Tier;
  action: PolicyAction;
  toolKnown: boolean;
}): { decision: Decision; reason: string } {
  if (input.action === "deny") return { decision: "deny", reason: "policy denies the tool" };
  if (!input.toolKnown) return { decision: "deny", reason: "tool is not in the known tool table" };
  if (input.action === "prompt") return { decision: "ask-human", reason: "policy requires a human prompt" };
  if (input.tier === "exec") return { decision: "ask-human", reason: "exec-tier tool requires human approval" };
  return { decision: "allow", reason: "allowed by policy" };
}

/**
 * The extension allowlist decision (issue #56), resolved BEFORE tier and
 * approval logic:
 * - an id in `extensions.deny` denies (deny wins over allow);
 * - when `extensions.allow` is non-empty, only the listed ids are allowed;
 * - both empty → no restriction (the registry is the base allowlist).
 */
export function decideExtensionCall(
  policy: PolicyConfig,
  extensionId: string,
): { decision: "allow" | "deny"; reason: string } {
  if (policy.extensionsDeny.includes(extensionId)) {
    return {
      decision: "deny",
      reason: `extension '${extensionId}' is denied by this space's policy (extensions.deny)`,
    };
  }
  if (policy.extensionsAllow.length > 0 && !policy.extensionsAllow.includes(extensionId)) {
    return {
      decision: "deny",
      reason: `extension '${extensionId}' is not in this space's extension allowlist (extensions.allow)`,
    };
  }
  return { decision: "allow", reason: "extension is allowed by this space's policy" };
}

/**
 * The first id in `extensions.allow`/`extensions.deny` that is not a known
 * (registered) extension id — a structural error that fails the policy
 * closed (issue #56). Returns undefined when every listed id is known.
 */
export function unknownExtensionId(policy: PolicyConfig, knownIds: readonly string[]): string | undefined {
  for (const id of [...policy.extensionsAllow, ...policy.extensionsDeny]) {
    if (!knownIds.includes(id)) return id;
  }
  return undefined;
}

/**
 * The gate decision for one tool call, shared by every policy surface
 * (in-process extension, ACP permission handler — issue #26): an invalid
 * policy denies everything, then the extension allowlist (issue #56) when
 * the call belongs to an extension, then the tier × action table applies.
 * The executor's preApproved scope (issue #11) lets an allowlisted exec-tier
 * tool run on the work item's pickup approval; explicit prompt/deny and
 * unknown tools are never bypassed. `autoApproved` marks an
 * always_approve decision (issue #45) so the caller can audit it as
 * resolved-by-policy.
 */
export function decidePolicyCall(
  policy: PolicyConfig,
  toolName: string,
  preApproved = false,
  extensionId?: string,
): { decision: Decision; reason: string; autoApproved: boolean } {
  if (!policy.ok) return { decision: "deny", reason: `policy invalid: ${policy.errors[0] ?? "parse error"}`, autoApproved: false };
  // Extension allowlist (issue #56): resolved BEFORE tier/approval — a
  // denied extension never reaches the approval ladder or credential
  // resolution (the #53 runtime consumes this decision).
  if (extensionId !== undefined) {
    const ext = decideExtensionCall(policy, extensionId);
    if (ext.decision === "deny") return { decision: "deny", reason: ext.reason, autoApproved: false };
  }
  const action = toolAction(policy, toolName);
  if (preApproved && isKnownTool(toolName) && resolveTier(toolName) === "exec" && action === "allow") {
    return { decision: "allow", reason: "pre-approved executor session (work item pickup approval)", autoApproved: false };
  }
  // Always-approve opt-in (issue #45): a listed known tool with an allow
  // action skips the ask-human prompt. Explicit deny/prompt still win (only
  // `allow` reaches this branch) and unknown tools can never be listed
  // (config validation fails closed), so decideToolCall's deny stays intact.
  if (action === "allow" && policy.alwaysApprove.includes(toolName)) {
    return { decision: "allow", reason: "auto-approved by policy (approvals.always_approve)", autoApproved: true };
  }
  const { decision, reason } = decideToolCall({ tier: resolveTier(toolName), action, toolKnown: isKnownTool(toolName) });
  return { decision, reason, autoApproved: false };
}

export function resolveTier(toolName: string): Tier {
  return TIER_BY_TOOL[toolName] ?? "exec";
}

export function isKnownTool(toolName: string): boolean {
  return toolName in TIER_BY_TOOL;
}

/** Explicit policy entry for the tool, else the `unknown` default. */
export function toolAction(policy: PolicyConfig, toolName: string): PolicyAction {
  return policy.tools[toolName] ?? policy.unknownAction;
}

const ACTION_VALUES: readonly PolicyAction[] = ["allow", "deny", "prompt"];

function normalizeAction(value: unknown): PolicyAction | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return ACTION_VALUES.find((action) => action === normalized);
}

/** A list of well-formed extension ids, or undefined when malformed (fail closed). */
function extensionIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !EXTENSION_ID_RE.test(raw)) return undefined;
    ids.push(raw);
  }
  return [...new Set(ids)];
}

function structuralError(policy: PolicyConfig, message: string): PolicyConfig {
  policy.ok = false;
  policy.errors.push(message);
  return policy;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return n >= 1 ? n : undefined;
}

/** YAML-subset scalars are strings; "true"/"false" map to booleans, anything else is invalid. */
function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

/** Parses and validates the org `config.yml` text. Structural problems fail the whole policy. */
export function parseOrgConfigYaml(text: string): PolicyConfig {
  const policy = defaultPolicy();
  // Tabs are outside the supported YAML subset (they silently change
  // indentation semantics); reject them like any other structural error.
  if (text.includes("\t")) return structuralError(policy, "tabs are not supported");

  let doc: Record<string, YamlNode>;
  try {
    doc = parseYamlSubset(text);
  } catch (err) {
    return structuralError(policy, `config.yml: ${(err as Error).message}`);
  }

  for (const [name, node] of Object.entries(doc)) {
    // Scalar top-level section: the org floor response mode (issue #55).
    // Invalid values warn and keep today's `always` default — a behavior
    // toggle, not a permission, so nothing denies.
    if (name === "response_mode") {
      const mode = normalizeResponseMode(node);
      if (mode) {
        policy.responseMode = mode;
      } else {
        const shown = typeof node === "string" ? node : "<non-scalar>";
        policy.warnings.push(
          `response_mode: invalid value '${shown}' — using default '${DEFAULT_RESPONSE_MODE}'`,
        );
      }
      continue;
    }
    // Every other section must be a block mapping; a scalar or sequence section
    // (e.g. `tools: nope`) is a structural error.
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      return structuralError(policy, `section '${name}' must be a block mapping`);
    }
    const entries = node as Record<string, YamlNode>;
    if (name === "tools") {
      for (const [tool, rawValue] of Object.entries(entries)) {
        const action = normalizeAction(rawValue);
        if (!action) {
          const shown = typeof rawValue === "string" ? rawValue : "<non-scalar>";
          policy.errors.push(`tools.${tool}: invalid action '${shown}' (allow|deny|prompt) — denying`);
          policy.tools[tool] = "deny";
          continue;
        }
        if (tool === "unknown") {
          policy.unknownAction = action;
          continue;
        }
        policy.tools[tool] = action;
      }
    } else if (name === "approvals") {
      const timeout = parsePositiveInt(scalarOrUndefined(entries.timeout_minutes));
      if (timeout !== undefined) {
        policy.timeoutMinutes = timeout;
      } else if (entries.timeout_minutes !== undefined) {
        policy.warnings.push("approvals.timeout_minutes: invalid — using default");
      }
      const required = parsePositiveInt(scalarOrUndefined(entries.required_for_org_change));
      if (required !== undefined) {
        policy.requiredApprovers = required;
      } else if (entries.required_for_org_change !== undefined) {
        policy.warnings.push("approvals.required_for_org_change: invalid — using default");
      }
      // always_approve (issue #45): an opt-in allowlist of exec-tier tools
      // that skip the ask-human prompt. Known tool names only — an unknown
      // name is a structural error (fail closed), because a typo here would
      // otherwise silently enable nothing while looking intentional.
      if (entries.always_approve !== undefined) {
        const list = entries.always_approve;
        if (!Array.isArray(list)) {
          return structuralError(policy, "approvals.always_approve must be a list of tool names");
        }
        const names: string[] = [];
        for (const raw of list) {
          if (typeof raw !== "string" || !isKnownTool(raw)) {
            return structuralError(policy, `approvals.always_approve: unknown tool '${String(raw)}'`);
          }
          names.push(raw);
        }
        policy.alwaysApprove = names;
      }
    } else if (name === "memory") {
      const injection = entries.injection;
      if (injection !== undefined) {
        // `memory:` with a nested `injection:` mapping; anything else is structural.
        if (typeof injection !== "object" || injection === null || Array.isArray(injection)) {
          return structuralError(policy, "memory.injection must be a block mapping");
        }
        const inj = injection as Record<string, YamlNode>;
        const enabled = parseBoolean(scalarOrUndefined(inj.enabled));
        if (enabled !== undefined) {
          policy.memory.injection.enabled = enabled;
        } else if (inj.enabled !== undefined) {
          policy.warnings.push("memory.injection.enabled: invalid (true|false) — using default");
        }
        const maxEntries = parsePositiveInt(scalarOrUndefined(inj.max_entries));
        if (maxEntries !== undefined) {
          if (maxEntries > MEMORY_INJECTION_MAX_ENTRIES_CAP) {
            policy.warnings.push(`memory.injection.max_entries: ${maxEntries} capped at ${MEMORY_INJECTION_MAX_ENTRIES_CAP}`);
          }
          policy.memory.injection.maxEntries = Math.min(maxEntries, MEMORY_INJECTION_MAX_ENTRIES_CAP);
        } else if (inj.max_entries !== undefined) {
          policy.warnings.push("memory.injection.max_entries: invalid — using default");
        }
      }
    } else if (name === "agent") {
      // Space-agent driver selection (issue #26). The flip is opt-in:
      // anything unrecognized keeps the safe omp-sdk default with a warning.
      const driver = scalarOrUndefined(entries.driver);
      if (driver === "acp" || driver === "omp-sdk") {
        policy.agentDriver = driver;
      } else if (entries.driver !== undefined) {
        policy.warnings.push(`agent.driver: invalid '${driver ?? "<non-scalar>"}' (acp|omp-sdk) — using default omp-sdk`);
      }
      for (const key of Object.keys(entries)) {
        if (key !== "driver") policy.warnings.push(`agent.${key}: unknown key ignored`);
      }
    } else if (name === "extensions") {
      // Extension policy (issue #56): `allow`/`deny` id lists and the
      // org-credential usage knob. Malformed lists fail the policy closed
      // (a typo would otherwise silently change what may run); existence
      // against the registry is validated at the gate (unknownExtensionId).
      const allow = extensionIdList(entries.allow);
      if (allow !== undefined) {
        policy.extensionsAllow = allow;
      } else if (entries.allow !== undefined) {
        return structuralError(policy, "extensions.allow must be a list of extension ids");
      }
      const deny = extensionIdList(entries.deny);
      if (deny !== undefined) {
        policy.extensionsDeny = deny;
      } else if (entries.deny !== undefined) {
        return structuralError(policy, "extensions.deny must be a list of extension ids");
      }
      // org_credentials: a usage knob like response_mode (issue #55) — an
      // invalid value warns and keeps the allow default.
      const orgCreds = scalarOrUndefined(entries.org_credentials);
      if (orgCreds !== undefined) {
        const mode = normalizeOrgCredentials(orgCreds);
        if (mode) {
          policy.orgCredentials = mode;
        } else {
          policy.warnings.push(
            `extensions.org_credentials: invalid value '${orgCreds}' — using default '${DEFAULT_ORG_CREDENTIALS}'`,
          );
        }
      }
      for (const key of Object.keys(entries)) {
        if (key !== "allow" && key !== "deny" && key !== "org_credentials") {
          policy.warnings.push(`extensions.${key}: unknown key ignored`);
        }
      }
    } else {
      policy.warnings.push(`unknown section '${name}' ignored`);
    }
  }
  return policy;
}

/** A scalar node's string value; non-scalar nodes (mappings/sequences) are undefined. */
function scalarOrUndefined(value: YamlNode | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Loads the org floor: `config.yml` in `dir`, `BOTTEGA_CONFIG_DIR`, or the repo root. */
export function loadOrgConfig(dir?: string): PolicyConfig {
  const configDir = dir ?? process.env.BOTTEGA_CONFIG_DIR ?? process.cwd();
  let text: string;
  try {
    text = readFileSync(join(configDir, "config.yml"), "utf8");
  } catch (err) {
    if (isEnoent(err)) return defaultPolicy();
    return structuralError(defaultPolicy(), `config.yml: ${(err as Error).message}`);
  }
  return parseOrgConfigYaml(text);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

const STRICTNESS: Record<PolicyAction, number> = { allow: 0, prompt: 1, deny: 2 };

function stricter(a: PolicyAction, b: PolicyAction): PolicyAction {
  return STRICTNESS[b] > STRICTNESS[a] ? b : a;
}

function clonePolicy(p: PolicyConfig): PolicyConfig {
  return {
    ...p,
    tools: { ...p.tools },
    memory: { injection: { ...p.memory.injection } },
    errors: [...p.errors],
    warnings: [...p.warnings],
  };
}

/**
 * Merges the space overlay (`spaces.policy_json`) onto the org floor.
 * The overlay can only tighten; an unparseable overlay fails the space closed.
 */
export function applySpaceOverlay(org: PolicyConfig, policyJson: string): PolicyConfig {
  const trimmed = policyJson.trim();
  if (!trimmed || !org.ok) return org;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return structuralError(defaultPolicy(), `spaces.policy_json: invalid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return structuralError(defaultPolicy(), "spaces.policy_json: must be an object");
  }
  // JSON.parse output, validated to a plain object above.
  const overlay = parsed as Record<string, unknown>;

  const out = clonePolicy(org);

  const toolsEntry = overlay["tools"];
  if (toolsEntry !== undefined) {
    if (typeof toolsEntry !== "object" || toolsEntry === null || Array.isArray(toolsEntry)) {
      return structuralError(defaultPolicy(), "spaces.policy_json: tools must be an object");
    }
    for (const [tool, rawValue] of Object.entries(toolsEntry)) {
      const action = normalizeAction(rawValue);
      if (!action) {
        out.errors.push(`overlay tools.${tool}: invalid action — denying`);
        out.tools[tool] = "deny";
        continue;
      }
      if (tool === "unknown") {
        out.unknownAction = stricter(out.unknownAction, action);
        continue;
      }
      out.tools[tool] = stricter(out.tools[tool] ?? out.unknownAction, action);
    }
  }

  const approversEntry = overlay["approvers"];
  if (approversEntry !== undefined) {
    if (!Array.isArray(approversEntry) || approversEntry.some((a) => typeof a !== "string")) {
      return structuralError(defaultPolicy(), "spaces.policy_json: approvers must be an array of strings");
    }
    out.approvers = [...approversEntry];
  }

  // always_approve (issue #45): the overlay lists tools to REMOVE from the
  // org floor list — the overlay can only tighten, never add entries. A
  // name the org floor does not list is a no-op (removal can only fail in
  // the safe direction); malformed values are a structural error.
  const alwaysApproveEntry = overlay["always_approve"];
  if (alwaysApproveEntry !== undefined) {
    if (!Array.isArray(alwaysApproveEntry) || alwaysApproveEntry.some((t) => typeof t !== "string")) {
      return structuralError(defaultPolicy(), "spaces.policy_json: always_approve must be an array of strings");
    }
    const removed = new Set(alwaysApproveEntry as string[]);
    out.alwaysApprove = out.alwaysApprove.filter((tool) => !removed.has(tool));
  }

  // Response mode (issue #55): the overlay may change it, but the tighten
  // rule still applies — a looser overlay value is clamped to the org floor
  // (mirrors the tools rule above), and an invalid value cannot tighten, so
  // the org floor stands with a warning.
  const responseModeEntry = overlay["response_mode"];
  if (responseModeEntry !== undefined) {
    const mode = normalizeResponseMode(responseModeEntry);
    if (!mode) {
      const shown = typeof responseModeEntry === "string" ? responseModeEntry : "<non-scalar>";
      out.warnings.push(`overlay response_mode: invalid value '${shown}' — keeping org floor '${out.responseMode}'`);
    } else {
      out.responseMode = stricterResponseMode(out.responseMode, mode);
    }
  }

  // Extension policy (issue #56): the overlay can only tighten — `allow`
  // lists ids to REMOVE from the org floor allowlist, `deny` lists ids to
  // ADD to the org deny list, and `org_credentials` clamps like
  // response_mode. Malformed entries are a structural error (fail closed).
  const extensionsEntry = overlay["extensions"];
  if (extensionsEntry !== undefined) {
    if (typeof extensionsEntry !== "object" || extensionsEntry === null || Array.isArray(extensionsEntry)) {
      return structuralError(defaultPolicy(), "spaces.policy_json: extensions must be an object");
    }
    const ext = extensionsEntry as Record<string, unknown>;
    const allowEntry = ext["allow"];
    if (allowEntry !== undefined) {
      const ids = extensionIdList(allowEntry);
      if (!ids) {
        return structuralError(defaultPolicy(), "spaces.policy_json: extensions.allow must be a list of extension ids");
      }
      // Removal can only fail in the safe direction: ids the org floor does
      // not list are no-ops, and the overlay can never add entries.
      const removed = new Set(ids);
      out.extensionsAllow = out.extensionsAllow.filter((id) => !removed.has(id));
    }
    const denyEntry = ext["deny"];
    if (denyEntry !== undefined) {
      const ids = extensionIdList(denyEntry);
      if (!ids) {
        return structuralError(defaultPolicy(), "spaces.policy_json: extensions.deny must be a list of extension ids");
      }
      out.extensionsDeny = [...new Set([...out.extensionsDeny, ...ids])];
    }
    const orgCredsEntry = ext["org_credentials"];
    if (orgCredsEntry !== undefined) {
      const mode = normalizeOrgCredentials(orgCredsEntry);
      if (!mode) {
        const shown = typeof orgCredsEntry === "string" ? orgCredsEntry : "<non-scalar>";
        out.warnings.push(
          `overlay extensions.org_credentials: invalid value '${shown}' — keeping org floor '${out.orgCredentials}'`,
        );
      } else {
        out.orgCredentials = stricterOrgCredentials(out.orgCredentials, mode);
      }
    }
  }

  return out;
}

/**
 * The effective policy for a space session: the org floor with the space's
 * `spaces.policy_json` overlay applied. Shared by the policy gate and the
 * work-item tools so both read the same per-space policy (issue #33).
 */
export async function loadSpacePolicy(
  org: PolicyConfig,
  store: Pick<Store, "getSpace">,
  spaceId: string | undefined,
): Promise<PolicyConfig> {
  if (!spaceId) return org;
  const space = await store.getSpace(spaceId);
  return applySpaceOverlay(org, space?.policy_json ?? "");
}
