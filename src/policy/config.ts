/**
 * Policy types + loader (issue #6).
 *
 * Org floor comes from `config.yml` (repo root, or `BOTTEGA_CONFIG_DIR`);
 * spaces tighten it via `spaces.policy_json` (JSON overlay, only ever
 * tightens). Strict validation: anything malformed denies — never silently
 * allows. A missing config.yml is a fail-closed default policy (everything
 * denies unless explicitly allowed).
 *
 * YAML: deliberately dependency-free — parsed by the shared YAML-subset
 * parser (src/yaml-subset.ts). Anything outside that subset is a
 * structural error that fails the whole policy closed. A subset parser is
 * safe here because denial is the default for everything it cannot
 * understand.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store/db";
import { parseYamlSubset, type YamlNode } from "../yaml-subset";

export type Tier = "read" | "write" | "exec";
export type PolicyAction = "allow" | "deny" | "prompt";
export type Decision = "allow" | "deny" | "ask-human";

export const DEFAULT_TIMEOUT_MINUTES = 5;
export const DEFAULT_REQUIRED_APPROVERS = 1;
export const DEFAULT_UNKNOWN_ACTION: PolicyAction = "deny";

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
  errors: string[];
  warnings: string[];
}

export function defaultPolicy(): PolicyConfig {
  return {
    ok: true,
    tools: {},
    unknownAction: DEFAULT_UNKNOWN_ACTION,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    requiredApprovers: DEFAULT_REQUIRED_APPROVERS,
    approvers: [],
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
  return (ACTION_VALUES as readonly string[]).includes(normalized) ? (normalized as PolicyAction) : undefined;
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
    // Every section must be a block mapping; a scalar or sequence section
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
  return { ...p, tools: { ...p.tools }, errors: [...p.errors], warnings: [...p.warnings] };
}

/**
 * Merges the space overlay (`spaces.policy_json`) onto the org floor.
 * The overlay can only tighten; an unparseable overlay fails the space closed.
 */
export function applySpaceOverlay(org: PolicyConfig, policyJson: string): PolicyConfig {
  const trimmed = policyJson?.trim() ?? "";
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
