/**
 * Org settings schema + validator (issue #67, Part A).
 *
 * The org_settings table holds ONE row (id=1) with a JSON blob of org
 * knobs. The blob's keys mirror config.yml so the DB-first policy merge is
 * a straight override of the file floor (src/policy/config.ts
 * applyOrgSettings). Secrets never live here — credentials stay in .env and
 * the broker vault.
 *
 * Validation is fail-closed: ANY malformed knob (wrong type, unknown key,
 * bad enum value, unknown tool/extension id) makes the whole blob invalid
 * (`ok: false` + errors). The store helpers throw OrgSettingsParseError on
 * an invalid blob, and the policy loader fails the org policy closed —
 * a typo'd knob must never silently fall back to looser file values.
 * The one leniency mirrors config.yml: `memory.injection.max_entries` over
 * the cap is clamped with a warning (same cap, same semantics).
 *
 * `repos` and `models` are validated here but not consumed by the policy
 * loader yet (Part B consumes them: boot-time models.yml generation and
 * the executor's repo allowlist).
 */
import { EXTENSION_ID_RE } from "../extensions/manifest";
import type { CredentialType } from "../extensions/manifest";
import { isKnownTool } from "../policy/config";
import type { OrgCredentialsMode, ResponseMode } from "../policy/config";

export const MEMORY_INJECTION_MAX_ENTRIES_CAP = 20;

/** Validated org settings — camelCase; an absent field means "not set in the blob". */
export interface OrgApprovalsSettings {
  timeoutMinutes?: number;
  alwaysApprove?: string[];
}

export interface OrgMemorySettings {
  enabled?: boolean;
  maxEntries?: number;
}

export interface OrgExtensionsSettings {
  allow?: string[];
  deny?: string[];
  orgCredentials?: OrgCredentialsMode;
}

export interface OrgModelsSettings {
  default?: string;
  fast?: string;
  reasoning?: string;
  effort?: string;
}

/**
 * One 1Password location a credential's secret is served from (issue #190):
 * `secrets_backend.mapping["<provider>:<identityKey>"]` points the
 * credential row's provider + identity key at a Connect vault/item/field.
 * The field's value is the secret payload; `field` matches the Connect
 * item field by id OR label. `type` declares the credential kind the
 * stored secret represents (default `api_key`; oauth refresh stays with
 * the omp-broker backend).
 */
export interface SecretsBackendMappingEntry {
  vault: string;
  item: string;
  field: string;
  type?: CredentialType;
}

/**
 * The org's secret-vault backend selection (issue #190), consumed by the
 * extension credential boundary at boot. `connect_url` + `mapping` are
 * only consumed when `type` is `1password-connect` (they are carried but
 * inert under `omp-broker`, so an org can switch back without first
 * deleting them); the Connect access token itself is a secret and stays in
 * env/.env (`OP_CONNECT_TOKEN`), never in the blob.
 */
export interface OrgSecretsBackendSettings {
  type: "omp-broker" | "1password-connect";
  /** 1password-connect: the Connect server base URL (e.g. http://op-connect:8080). */
  connectUrl?: string;
  /** 1password-connect: "provider:identityKey" → the 1Password vault/item/field. */
  mapping?: Record<string, SecretsBackendMappingEntry>;
}

export interface OrgSettings {
  /** False = at least one knob is malformed; the blob must not be used. */
  ok: boolean;
  errors: string[];
  warnings: string[];
  approvals?: OrgApprovalsSettings;
  responseMode?: ResponseMode;
  memoryInjection?: OrgMemorySettings;
  extensions?: OrgExtensionsSettings;
  /** Repo allowlist (owner/repo); consumed by the executor (Part B wiring). */
  repos?: string[];
  /** Model defaults (default/fast/reasoning + effort); consumed by models.yml generation (Part B). */
  models?: OrgModelsSettings;
  /** Workspace root for work-item checkouts; consumed by the executor (Part B). */
  workspacesDir?: string;
  /** Git base URL for clones/pushes; overrides config/org.yml (Part B). */
  gitBaseUrl?: string;
  /** GitHub REST API base for PR creation (Part B). */
  apiBaseUrl?: string;
  /** Local-dev only: tolerate a PAT file mode other than 0600 (Part B). */
  allowLoosePat?: boolean;
  /** Memory backend URL (mem0); unset → SQLite memory (Part B). */
  memoryBackend?: { baseUrl?: string };
  /**
   * Proactive onboarding (issue #116): the space id (e.g. "slack:C123")
   * that receives the boot-time guided setup post. Unset → no boot post
   * (the in-conversation nudge still applies).
   */
  onboarding?: { spaceId?: string };
  /** Secret-vault backend for the extension credential boundary (issue #190). */
  secretsBackend?: OrgSecretsBackendSettings;
}

/** Raw snake_case blob shape accepted by setOrgSettings (mirrors config.yml keys). */
export interface OrgSettingsInput {
  approvals?: {
    timeout_minutes?: number;
    always_approve?: string[];
  };
  response_mode?: ResponseMode;
  memory?: {
    injection?: {
      enabled?: boolean;
      max_entries?: number;
    };
  };
  extensions?: {
    allow?: string[];
    deny?: string[];
    org_credentials?: OrgCredentialsMode;
  };
  repos?: string[];
  models?: {
    default?: string;
    fast?: string;
    reasoning?: string;
    effort?: string;
  };
  workspaces_dir?: string;
  git_base_url?: string;
  api_base_url?: string;
  allow_loose_pat?: boolean;
  memory_backend?: { base_url?: string };
  /** Proactive onboarding (issue #116): space id for the boot-time guide. */
  onboarding?: { space_id?: string };
  /** Secret-vault backend for the extension credential boundary (issue #190). */
  secrets_backend?: {
    type: string;
    connect_url?: string;
    mapping?: Record<string, { vault: string; item: string; field: string; type?: string }>;
  };
}

/** Thrown by the store helpers when the settings blob is malformed (fail closed). */
export class OrgSettingsParseError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`org_settings: ${errors.join("; ")}`);
    this.name = "OrgSettingsParseError";
    this.errors = errors;
  }
}

const RESPONSE_MODE_VALUES: readonly string[] = ["always", "mention", "request-only"];
const ORG_CREDENTIALS_VALUES: readonly string[] = ["allow", "deny"];

function normalizeEnum(value: unknown, values: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return values.includes(normalized) ? normalized : undefined;
}

/** A positive integer, or undefined when not a number. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** A list of well-formed extension ids, or undefined when malformed. */
function extensionIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !EXTENSION_ID_RE.test(raw)) return undefined;
    ids.push(raw);
  }
  return [...new Set(ids)];
}

/** A list of known tool names (approvals.always_approve), or undefined when malformed. */
function toolNameList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !isKnownTool(raw)) return undefined;
    names.push(raw);
  }
  return [...new Set(names)];
}

/** A list of owner/repo strings, or undefined when malformed. */
function repoList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const repos: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !/^[^/]+\/[^/]+$/.test(raw)) return undefined;
    repos.push(raw);
  }
  return [...new Set(repos)];
}

/**
 * Validates `secrets_backend.mapping` (issue #190): a flat
 * `"provider:identityKey" → {vault, item, field[, type]}` map. Every entry
 * must be a well-formed 1Password location; `type` is optional and must be
 * a known credential kind. Returns undefined when malformed (fail closed).
 */
function parseSecretsBackendMapping(value: unknown): Record<string, SecretsBackendMappingEntry> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, SecretsBackendMappingEntry> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim() === "") return undefined;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const entry = raw as Record<string, unknown>;
    const vault = entry["vault"];
    const item = entry["item"];
    const field = entry["field"];
    if (typeof vault !== "string" || vault.trim() === "") return undefined;
    if (typeof item !== "string" || item.trim() === "") return undefined;
    if (typeof field !== "string" || field.trim() === "") return undefined;
    let type: CredentialType | undefined;
    if (entry["type"] !== undefined) {
      if (entry["type"] !== "api_key" && entry["type"] !== "oauth") return undefined;
      type = entry["type"];
    }
    out[key] = { vault: vault.trim(), item: item.trim(), field: field.trim(), ...(type !== undefined ? { type } : {}) };
  }
  return out;
}

/**
 * Validates an org settings blob. Fail closed: any malformed knob is an
 * error and the whole blob is invalid. Returns the validated (camelCase)
 * shape with only the knobs the blob actually sets.
 */
export function parseOrgSettingsJson(text: string): OrgSettings {
  const out: OrgSettings = { ok: true, errors: [], warnings: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    out.ok = false;
    out.errors.push(`invalid JSON: ${(err as Error).message}`);
    return out;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    out.ok = false;
    out.errors.push("settings must be a JSON object");
    return out;
  }
  const blob = doc as Record<string, unknown>;
  const fail = (message: string): void => {
    out.ok = false;
    out.errors.push(message);
  };

  for (const [name, value] of Object.entries(blob)) {
    if (name === "approvals") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("approvals must be an object");
        continue;
      }
      const approvals = value as Record<string, unknown>;
      const parsed: OrgApprovalsSettings = {};
      let sectionOk = true;
      for (const [key, raw] of Object.entries(approvals)) {
        if (key === "timeout_minutes") {
          const n = positiveInt(raw);
          if (n === undefined) {
            sectionOk = false;
            fail("approvals.timeout_minutes must be a positive integer");
          } else {
            parsed.timeoutMinutes = n;
          }
        } else if (key === "always_approve") {
          const names = toolNameList(raw);
          if (names === undefined) {
            sectionOk = false;
            fail("approvals.always_approve must be a list of known tool names");
          } else {
            parsed.alwaysApprove = names;
          }
        } else {
          sectionOk = false;
          fail(`approvals.${key}: unknown key`);
        }
      }
      if (sectionOk) out.approvals = parsed;
    } else if (name === "response_mode") {
      const mode = normalizeEnum(value, RESPONSE_MODE_VALUES);
      if (mode === undefined) {
        fail("response_mode must be one of: always, mention, request-only");
      } else {
        out.responseMode = mode as ResponseMode;
      }
    } else if (name === "memory") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("memory must be an object");
        continue;
      }
      const memory = value as Record<string, unknown>;
      const injection = memory["injection"];
      if (injection === undefined) {
        continue; // `memory: {}` sets nothing
      }
      if (typeof injection !== "object" || injection === null || Array.isArray(injection)) {
        fail("memory.injection must be an object");
        continue;
      }
      const inj = injection as Record<string, unknown>;
      const parsed: OrgMemorySettings = {};
      let sectionOk = true;
      for (const [key, raw] of Object.entries(inj)) {
        if (key === "enabled") {
          if (typeof raw !== "boolean") {
            sectionOk = false;
            fail("memory.injection.enabled must be a boolean");
          } else {
            parsed.enabled = raw;
          }
        } else if (key === "max_entries") {
          const n = positiveInt(raw);
          if (n === undefined) {
            sectionOk = false;
            fail("memory.injection.max_entries must be a positive integer");
          } else {
            if (n > MEMORY_INJECTION_MAX_ENTRIES_CAP) {
              out.warnings.push(
                `memory.injection.max_entries: ${n} capped at ${MEMORY_INJECTION_MAX_ENTRIES_CAP}`,
              );
            }
            parsed.maxEntries = Math.min(n, MEMORY_INJECTION_MAX_ENTRIES_CAP);
          }
        } else {
          sectionOk = false;
          fail(`memory.injection.${key}: unknown key`);
        }
      }
      if (sectionOk) out.memoryInjection = parsed;
    } else if (name === "extensions") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("extensions must be an object");
        continue;
      }
      const extensions = value as Record<string, unknown>;
      const parsed: OrgExtensionsSettings = {};
      let sectionOk = true;
      for (const [key, raw] of Object.entries(extensions)) {
        if (key === "allow") {
          const ids = extensionIdList(raw);
          if (ids === undefined) {
            sectionOk = false;
            fail("extensions.allow must be a list of extension ids");
          } else {
            parsed.allow = ids;
          }
        } else if (key === "deny") {
          const ids = extensionIdList(raw);
          if (ids === undefined) {
            sectionOk = false;
            fail("extensions.deny must be a list of extension ids");
          } else {
            parsed.deny = ids;
          }
        } else if (key === "org_credentials") {
          const mode = normalizeEnum(raw, ORG_CREDENTIALS_VALUES);
          if (mode === undefined) {
            sectionOk = false;
            fail("extensions.org_credentials must be one of: allow, deny");
          } else {
            parsed.orgCredentials = mode as OrgCredentialsMode;
          }
        } else {
          sectionOk = false;
          fail(`extensions.${key}: unknown key`);
        }
      }
      if (sectionOk) out.extensions = parsed;
    } else if (name === "repos") {
      const repos = repoList(value);
      if (repos === undefined) {
        fail("repos must be a list of owner/repo strings");
      } else {
        out.repos = repos;
      }
    } else if (name === "models") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("models must be an object");
        continue;
      }
      const models = value as Record<string, unknown>;
      const parsed: OrgModelsSettings = {};
      let sectionOk = true;
      for (const [key, raw] of Object.entries(models)) {
        if (key === "default" || key === "fast" || key === "reasoning" || key === "effort") {
          if (typeof raw !== "string" || raw.trim() === "") {
            sectionOk = false;
            fail(`models.${key} must be a non-empty string`);
          } else {
            parsed[key] = raw.trim();
          }
        } else {
          sectionOk = false;
          fail(`models.${key}: unknown key`);
        }
      }
      if (sectionOk) out.models = parsed;
    } else if (name === "workspaces_dir" || name === "git_base_url" || name === "api_base_url") {
      if (typeof value !== "string" || value.trim() === "") {
        fail(`${name} must be a non-empty string`);
      } else if (name === "workspaces_dir") {
        out.workspacesDir = value.trim();
      } else if (name === "git_base_url") {
        out.gitBaseUrl = value.trim();
      } else {
        out.apiBaseUrl = value.trim();
      }
    } else if (name === "allow_loose_pat") {
      if (typeof value !== "boolean") {
        fail("allow_loose_pat must be a boolean");
      } else {
        out.allowLoosePat = value;
      }
    } else if (name === "memory_backend") {
      // The backend URL (mem0) — issue #67 env pruning moved the knob out
      // of env. An EMPTY base_url clears the setting (SQLite fallback),
      // mirroring the old MEM0_BASE_URL= contract; `memory_backend: {}`
      // sets nothing.
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("memory_backend must be an object");
        continue;
      }
      const backend = value as Record<string, unknown>;
      let sectionOk = true;
      for (const [key, raw] of Object.entries(backend)) {
        if (key === "base_url") {
          if (typeof raw !== "string") {
            sectionOk = false;
            fail("memory_backend.base_url must be a string");
          } else if (raw.trim() !== "") {
            out.memoryBackend = { baseUrl: raw.trim() };
          }
        } else {
          sectionOk = false;
          fail(`memory_backend.${key}: unknown key`);
        }
      }
      if (!sectionOk) out.memoryBackend = undefined;
    } else if (name === "onboarding") {
      // Proactive onboarding (issue #116): the space id that receives the
      // boot-time guided setup post. An EMPTY space_id clears the setting
      // (no boot post), mirroring memory_backend.base_url; `onboarding: {}`
      // sets nothing.
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("onboarding must be an object");
        continue;
      }
      const onboarding = value as Record<string, unknown>;
      let sectionOk = true;
      for (const [key, raw] of Object.entries(onboarding)) {
        if (key === "space_id") {
          if (typeof raw !== "string") {
            sectionOk = false;
            fail("onboarding.space_id must be a string");
          } else if (raw.trim() !== "") {
            out.onboarding = { spaceId: raw.trim() };
          }
        } else {
          sectionOk = false;
          fail(`onboarding.${key}: unknown key`);
        }
      }
      if (!sectionOk) out.onboarding = undefined;
    } else if (name === "secrets_backend") {
      // Secret-vault backend for the extension credential boundary (issue
      // #190). Unknown types, a 1password-connect backend missing its
      // connect_url/mapping, or a malformed mapping all fail the whole
      // blob closed — a deployment must never silently keep the default
      // backend after configuring one that cannot work.
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("secrets_backend must be an object");
        continue;
      }
      const backend = value as Record<string, unknown>;
      const rawType = backend["type"];
      if (rawType !== "omp-broker" && rawType !== "1password-connect") {
        fail("secrets_backend.type must be one of: omp-broker, 1password-connect");
        continue;
      }
      const parsed: OrgSecretsBackendSettings = { type: rawType };
      let sectionOk = true;
      for (const [key, raw] of Object.entries(backend)) {
        if (key === "type") {
          continue;
        } else if (key === "connect_url") {
          if (typeof raw !== "string" || raw.trim() === "") {
            sectionOk = false;
            fail("secrets_backend.connect_url must be a non-empty string (the Connect server base URL)");
          } else {
            parsed.connectUrl = raw.trim();
          }
        } else if (key === "mapping") {
          const mapping = parseSecretsBackendMapping(raw);
          if (mapping === undefined) {
            sectionOk = false;
            fail('secrets_backend.mapping must map "provider:identityKey" to {vault, item, field[, type]}');
          } else {
            parsed.mapping = mapping;
          }
        } else {
          sectionOk = false;
          fail(`secrets_backend.${key}: unknown key`);
        }
      }
      if (rawType === "1password-connect") {
        if (parsed.connectUrl === undefined) {
          sectionOk = false;
          fail("secrets_backend.connect_url is required for type 1password-connect");
        }
        if (parsed.mapping === undefined) {
          sectionOk = false;
          fail("secrets_backend.mapping is required for type 1password-connect");
        }
      }
      if (sectionOk) out.secretsBackend = parsed;
    } else {
      fail(`unknown key '${name}'`);
    }
  }
  return out;
}
