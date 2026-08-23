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
import type { OrgJobCaps } from "../worker/caps";
import { z } from "zod";

export const MEMORY_INJECTION_MAX_ENTRIES_CAP = 20;

/** Validated org settings — camelCase; an absent field means "not set in the blob". */
export interface OrgApprovalsSettings {
  timeoutMinutes?: number;
  /** Minutes a pending ask-human approval sits before a nudge is posted (issue #109); default 30. */
  approvalNudgeMinutes?: number;
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

/** Voice-note transcription knobs (issue #96). Base URL/model override the NEAR defaults. */
export interface OrgVoiceTranscriptionSettings {
  /** NEAR-compatible transcriptions API base; unset → the NEAR default. */
  baseUrl?: string;
  /** Transcription model; unset → the NEAR default. */
  model?: string;
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
  /**
   * Per-kind per-job resource caps (issue #101): override the documented
   * worker defaults in src/worker/caps.ts. Consumed by the executor's
   * sandbox supervisor.
   */
  caps?: OrgJobCaps;
  /** Workspace root for work-item checkouts; consumed by the executor (Part B). */
  workspacesDir?: string;
  /** Git base URL for clones/pushes; overrides config/org.yml (Part B). */
  gitBaseUrl?: string;
  /** GitHub REST API base for PR creation (Part B). */
  apiBaseUrl?: string;
  /** Local-dev only: tolerate a PAT file mode other than 0600 (Part B). */
  allowLoosePat?: boolean;
  /**
   * Slack live-turn Stop control (issue #315): when true the boot wires the
   * turn presenter to mount a "Running — do you want to stop this turn?"
   * Stop button (bottega_stop) on each in-flight turn. DEFAULT OFF — the
   * machinery stays intact but is disabled until an org opts in via
   * `turn_stop_control: true`.
   */
  turnStopControl?: boolean;
  /** Voice-note transcription knobs (issue #96); unset → NEAR defaults. */
  voice?: { transcription?: OrgVoiceTranscriptionSettings };
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
    /** Minutes a pending ask-human approval sits before a nudge posts (issue #109); default 30. */
    approval_nudge_minutes?: number;
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
  /** Per-kind per-job resource caps (issue #101): timeout_ms/memory_mb per kind. */
  caps?: {
    git?: { timeout_minutes?: number; memory_mb?: number };
    extension?: { timeout_minutes?: number; memory_mb?: number };
    kb?: { timeout_minutes?: number; memory_mb?: number };
    ingest_poll?: { timeout_minutes?: number; memory_mb?: number };
  };
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
  /** Enable the Slack live-turn Stop control (issue #315); default off. */
  turn_stop_control?: boolean;
  /** Voice-note transcription knobs (issue #96); unset → NEAR defaults. */
  voice?: {
    transcription?: { base_url?: string; model?: string };
  };
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

const RESPONSE_MODE_VALUES = ["always", "mention", "request-only"] as const;
const ORG_CREDENTIALS_VALUES = ["allow", "deny"] as const;

/** A JSON-decoded value before any org-settings contract is applied. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema = z.json();
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

function normalizeEnum<T extends string>(value: JsonValue, values: readonly [T, ...T[]]): T | undefined {
  const parsed = z.string().trim().toLowerCase().pipe(z.enum(values)).safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data;
}

/** A positive integer, or undefined when not a number. */
function positiveInt(value: JsonValue): number | undefined {
  const parsed = z.number().int().min(1).safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data;
}

/** A list of well-formed extension ids, or undefined when malformed. */
function extensionIdList(value: JsonValue): string[] | undefined {
  const parsed = z.array(z.string().regex(EXTENSION_ID_RE)).safeParse(value);
  if (!parsed.success) return undefined;
  return [...new Set(parsed.data)];
}

/** A list of known tool names (approvals.always_approve), or undefined when malformed. */
function toolNameList(value: JsonValue): string[] | undefined {
  const parsed = z.array(z.string().refine(isKnownTool)).safeParse(value);
  if (!parsed.success) return undefined;
  return [...new Set(parsed.data)];
}

/** A list of owner/repo strings, or undefined when malformed. */
function repoList(value: JsonValue): string[] | undefined {
  const parsed = z.array(z.string().regex(/^[^/]+\/[^/]+$/)).safeParse(value);
  if (!parsed.success) return undefined;
  return [...new Set(parsed.data)];
}

/** One 1Password location entry in `secrets_backend.mapping` (issue #190). */
const secretsMappingEntrySchema = z.object({
  vault: z.string().trim().min(1),
  item: z.string().trim().min(1),
  field: z.string().trim().min(1),
  type: z.enum(["api_key", "oauth"]).optional(),
});

/**
 * Validates `secrets_backend.mapping` (issue #190): a flat
 * `"provider:identityKey" → {vault, item, field[, type]}` map. Every entry
 * must be a well-formed 1Password location; `type` is optional and must be
 * a known credential kind. Returns undefined when malformed (fail closed).
 */
function parseSecretsBackendMapping(value: JsonValue): Record<string, SecretsBackendMappingEntry> | undefined {
  const parsed = z
    .record(z.string().refine((key) => key.trim() !== ""), secretsMappingEntrySchema)
    .safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data;
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
    // SAFETY: JSON.parse rejects with a SyntaxError (an Error subclass), so the
    // caught value always carries a message.
    out.errors.push(`invalid JSON: ${(err as Error).message}`);
    return out;
  }
  const blobResult = jsonObjectSchema.safeParse(doc);
  if (!blobResult.success) {
    out.ok = false;
    out.errors.push("settings must be a JSON object");
    return out;
  }
  const blob = blobResult.data;
  const fail = (message: string): void => {
    out.ok = false;
    out.errors.push(message);
  };

  for (const [name, value] of Object.entries(blob)) {
    if (name === "approvals") {
      const section = jsonObjectSchema.safeParse(value);
      if (!section.success) {
        fail("approvals must be an object");
        continue;
      }
      const parsed: OrgApprovalsSettings = {};
      let sectionOk = true;
      for (const [key, raw] of Object.entries(section.data)) {
        if (key === "timeout_minutes") {
          const n = positiveInt(raw);
          if (n === undefined) {
            sectionOk = false;
            fail("approvals.timeout_minutes must be a positive integer");
          } else {
            parsed.timeoutMinutes = n;
          }
        } else if (key === "approval_nudge_minutes") {
          const n = positiveInt(raw);
          if (n === undefined) {
            sectionOk = false;
            fail("approvals.approval_nudge_minutes must be a positive integer");
          } else {
            parsed.approvalNudgeMinutes = n;
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
        out.responseMode = mode;
      }
    } else if (name === "memory") {
      const section = jsonObjectSchema.safeParse(value);
      if (!section.success) {
        fail("memory must be an object");
        continue;
      }
      const injection = section.data["injection"];
      if (injection === undefined) {
        continue; // `memory: {}` sets nothing
      }
      const injResult = jsonObjectSchema.safeParse(injection);
      if (!injResult.success) {
        fail("memory.injection must be an object");
        continue;
      }
      const parsed: OrgMemorySettings = {};
      let sectionOk = true;
      for (const [key, raw] of Object.entries(injResult.data)) {
        if (key === "enabled") {
          const enabled = z.boolean().safeParse(raw);
          if (!enabled.success) {
            sectionOk = false;
            fail("memory.injection.enabled must be a boolean");
          } else {
            parsed.enabled = enabled.data;
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
      const section = jsonObjectSchema.safeParse(value);
      if (!section.success) {
        fail("extensions must be an object");
        continue;
      }
      const parsed: OrgExtensionsSettings = {};
      let sectionOk = true;
      for (const [key, raw] of Object.entries(section.data)) {
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
            parsed.orgCredentials = mode;
          }
        } else {
          sectionOk = false;
          fail(`extensions.${key}: unknown key`);
        }
      }
      if (sectionOk) out.extensions = parsed;
    } else if (name === "caps") {
      // Per-kind resource caps (issue #101): a nested section whose keys are
      // kind names, each an optional {timeout_minutes, memory_mb}. Mirrors
      // the approvals/memory.injection tail pattern (unknown knob fails the
      // section, a malformed section fails the whole blob).
      const section = jsonObjectSchema.safeParse(value);
      if (!section.success) {
        fail("caps must be an object");
        continue;
      }
      const parsed: OrgJobCaps = {};
      let sectionOk = true;
      for (const [kind, raw] of Object.entries(section.data)) {
        if (kind !== "git" && kind !== "extension" && kind !== "kb" && kind !== "ingest_poll" && kind !== "scheduled") {
          sectionOk = false;
          fail(`caps.${kind}: unknown kind`);
          continue;
        }
        const kindResult = jsonObjectSchema.safeParse(raw);
        if (!kindResult.success) {
          sectionOk = false;
          fail(`caps.${kind} must be an object`);
          continue;
        }
        const knob: NonNullable<OrgJobCaps[typeof kind]> = {};
        for (const [key, rawKnob] of Object.entries(kindResult.data)) {
          if (key === "timeout_minutes") {
            const n = positiveInt(rawKnob);
            if (n === undefined) {
              sectionOk = false;
              fail(`caps.${kind}.timeout_minutes must be a positive integer`);
            } else {
              knob.timeoutMinutes = n;
            }
          } else if (key === "memory_mb") {
            const n = positiveInt(rawKnob);
            if (n === undefined) {
              sectionOk = false;
              fail(`caps.${kind}.memory_mb must be a positive integer`);
            } else {
              knob.memoryMb = n;
            }
          } else {
            sectionOk = false;
            fail(`caps.${kind}.${key}: unknown key`);
          }
        }
        parsed[kind] = knob;
      }
      if (sectionOk) out.caps = parsed;
    } else if (name === "repos") {
      const repos = repoList(value);
      if (repos === undefined) {
        fail("repos must be a list of owner/repo strings");
      } else {
        out.repos = repos;
      }
    } else if (name === "models") {
      const section = jsonObjectSchema.safeParse(value);
      if (!section.success) {
        fail("models must be an object");
        continue;
      }
      const parsed: OrgModelsSettings = {};
      let sectionOk = true;
      for (const [key, raw] of Object.entries(section.data)) {
        if (key === "default" || key === "fast" || key === "reasoning" || key === "effort") {
          const str = z.string().trim().min(1).safeParse(raw);
          if (!str.success) {
            sectionOk = false;
            fail(`models.${key} must be a non-empty string`);
          } else {
            parsed[key] = str.data;
          }
        } else {
          sectionOk = false;
          fail(`models.${key}: unknown key`);
        }
      }
      if (sectionOk) out.models = parsed;
    } else if (name === "workspaces_dir" || name === "git_base_url" || name === "api_base_url") {
      const str = z.string().trim().min(1).safeParse(value);
      if (!str.success) {
        fail(`${name} must be a non-empty string`);
      } else if (name === "workspaces_dir") {
        out.workspacesDir = str.data;
      } else if (name === "git_base_url") {
        out.gitBaseUrl = str.data;
      } else {
        out.apiBaseUrl = str.data;
      }
    } else if (name === "allow_loose_pat") {
      const flag = z.boolean().safeParse(value);
      if (!flag.success) {
        fail("allow_loose_pat must be a boolean");
      } else {
        out.allowLoosePat = flag.data;
      }
    } else if (name === "turn_stop_control") {
      const flag = z.boolean().safeParse(value);
      if (!flag.success) {
        fail("turn_stop_control must be a boolean");
      } else {
        out.turnStopControl = flag.data;
      }
    } else if (name === "voice") {
      // Voice-note transcription knobs (issue #96). A nested transcription
      // section whose base_url/model are optional non-empty strings; the
      // NEAR defaults apply when either is absent. `voice: {}` sets nothing.
      const section = jsonObjectSchema.safeParse(value);
      if (!section.success) {
        fail("voice must be an object");
        continue;
      }
      if (section.data["transcription"] === undefined) {
        continue; // `voice: {}` sets nothing
      }
      const transResult = jsonObjectSchema.safeParse(section.data["transcription"]);
      if (!transResult.success) {
        fail("voice.transcription must be an object");
        continue;
      }
      const parsed: OrgVoiceTranscriptionSettings = {};
      let sectionOk = true;
      for (const [key, raw] of Object.entries(transResult.data)) {
        if (key === "base_url" || key === "model") {
          const str = z.string().trim().min(1).safeParse(raw);
          if (!str.success) {
            sectionOk = false;
            fail(`voice.transcription.${key} must be a non-empty string`);
          } else if (key === "base_url") {
            parsed.baseUrl = str.data;
          } else {
            parsed.model = str.data;
          }
        } else {
          sectionOk = false;
          fail(`voice.transcription.${key}: unknown key`);
        }
      }
      if (sectionOk) out.voice = { transcription: parsed };
    } else if (name === "memory_backend") {
      // The backend URL (mem0) — issue #67 env pruning moved the knob out
      // of env. An EMPTY base_url clears the setting (SQLite fallback),
      // mirroring the old MEM0_BASE_URL= contract; `memory_backend: {}`
      // sets nothing.
      const section = jsonObjectSchema.safeParse(value);
      if (!section.success) {
        fail("memory_backend must be an object");
        continue;
      }
      let sectionOk = true;
      for (const [key, raw] of Object.entries(section.data)) {
        if (key === "base_url") {
          const str = z.string().safeParse(raw);
          if (!str.success) {
            sectionOk = false;
            fail("memory_backend.base_url must be a string");
          } else if (str.data.trim() !== "") {
            out.memoryBackend = { baseUrl: str.data.trim() };
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
      const section = jsonObjectSchema.safeParse(value);
      if (!section.success) {
        fail("onboarding must be an object");
        continue;
      }
      let sectionOk = true;
      for (const [key, raw] of Object.entries(section.data)) {
        if (key === "space_id") {
          const str = z.string().safeParse(raw);
          if (!str.success) {
            sectionOk = false;
            fail("onboarding.space_id must be a string");
          } else if (str.data.trim() !== "") {
            out.onboarding = { spaceId: str.data.trim() };
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
      // closed — a deployment must never silently keep the default
      // backend after configuring one that cannot work.
      const section = jsonObjectSchema.safeParse(value);
      if (!section.success) {
        fail("secrets_backend must be an object");
        continue;
      }
      const rawType = z.enum(["omp-broker", "1password-connect"]).safeParse(section.data["type"]);
      if (!rawType.success) {
        fail("secrets_backend.type must be one of: omp-broker, 1password-connect");
        continue;
      }
      const parsed: OrgSecretsBackendSettings = { type: rawType.data };
      let sectionOk = true;
      for (const [key, raw] of Object.entries(section.data)) {
        if (key === "type") {
          continue;
        } else if (key === "connect_url") {
          const str = z.string().trim().min(1).safeParse(raw);
          if (!str.success) {
            sectionOk = false;
            fail("secrets_backend.connect_url must be a non-empty string (the Connect server base URL)");
          } else {
            parsed.connectUrl = str.data;
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
      if (rawType.data === "1password-connect") {
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
