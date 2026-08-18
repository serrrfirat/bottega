/**
 * Extension manifest contract (issue #50): the typed, declarative shape of a
 * bottega integration. An extension IS this manifest plus a pinned spec
 * snapshot (see registry.ts), a vault binding for its credential schema
 * (later issue), and its policy tier declarations.
 *
 * kind "mcp" = the provider's OFFICIAL MCP server (bottega never implements
 * provider API clients); kind "cli" = a preinstalled CLI in the tools image
 * that bottega shells out to.
 *
 * Validation is fail-closed: malformed manifests are rejected with
 * {@link ExtensionValidationError} and never partially registered.
 */
import { z } from "zod";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@oh-my-pi/pi-coding-agent";

export type ExtensionKind = "mcp" | "cli";
export type ExtensionToolTier = "read" | "write" | "exec";
export type CredentialType = "oauth" | "api_key";
export type McpTransport = "streamable-http" | "stdio";

/**
 * MCP binding: exactly one of serverUrl (official remote server) or command
 * (preinstalled stdio server in the tools image). The transport must match
 * the binding: streamable-http goes with a serverUrl, stdio with a command.
 */
export type McpBinding =
  | { serverUrl: string; command?: never; transport: "streamable-http" }
  | { command: string; serverUrl?: never; transport: "stdio" };

/** CLI binding: the preinstalled binary, fixed args, and optional env delta. */
export interface CliBinding {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Credential schema the vault must satisfy for this extension. `scopes` only
 * applies to oauth; an api_key schema with scopes is malformed.
 */
export interface CredentialSchema {
  type: CredentialType;
  scopes?: string[];
}

/** One declarative tool parameter (converted to a zod schema by the bridge). */
export interface ExtensionToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  description?: string;
  /** Defaults to true: a declared param is required unless marked optional. */
  required?: boolean;
}

/**
 * One tool surface entry. `tier` feeds both the SDK approval tier and policy.
 *
 * `name` is bottega's model-facing surface (the SDK definition name, policy
 * names, audit trail). `providerName` — when present — is the tool's ACTUAL
 * wire name on the provider's MCP server (issue #148): hosted official
 * servers expose their own names (e.g. the hosted GitHub MCP rejects
 * `github.search_issues` and uses `search_issues`). Absent → the manifest
 * name is forwarded verbatim (backward compatible).
 */
export interface ExtensionTool {
  name: string;
  /** The provider's wire tool name; defaults to `name` when absent. */
  providerName?: string;
  tier: ExtensionToolTier;
  description: string;
  params: ExtensionToolParam[];
}

/**
 * The extension manifest. Discriminated on `kind`: an mcp extension MUST
 * carry an mcp binding, a cli extension MUST carry a cli binding — the type
 * system and validateManifest agree.
 *
 * `tools` is OPTIONAL (issue #158): absent → the runtime discovers the
 * tool surface from the provider's tools/list at boot (conservative tiers,
 * src/extensions/surface.ts); present (even `[]` — an egress-only
 * extension) → the PINNED, reviewed surface wins and no discovery happens
 * (backward compatible). `tools: []` and absent are distinct states: an
 * empty array is a deliberate pinned "no tools" surface, absent means
 * "discover".
 */
export type ExtensionManifest =
  | {
      id: string;
      label: string;
      vendor: string;
      kind: "mcp";
      mcp: McpBinding;
      cli?: never;
      credentialSchema: CredentialSchema;
      tools?: ExtensionTool[];
      /** Egress allowlist entries (iron-proxy): hostnames, optional `*.` prefix. */
      domains: string[];
    }
  | {
      id: string;
      label: string;
      vendor: string;
      kind: "cli";
      mcp?: never;
      cli: CliBinding;
      credentialSchema: CredentialSchema;
      tools?: ExtensionTool[];
      domains: string[];
    };

/**
 * Project tools registered by bottega itself (server/drivers/agent-driver.ts
 * SPACE_AGENT_TOOLS). An extension tool shadowing one of these would
 * silently replace the built-in in the space agent's toolset, so they are
 * reserved like the SDK built-ins. Keep in sync with SPACE_AGENT_TOOLS.
 */
export const PROJECT_TOOL_NAMES = [
  "create_work_item",
  "work_item_cancel",
  "list_work_items",
  // Todo snapshot (issue #228): read-tier assembly of the space's live
  // state; rides the custom-tools bridge like the work-item tools.
  "list_todos",
  // Connect capability (issue #52): the per-session connect tool rides the
  // custom-tools path (see SPACE_AGENT_TOOLS) — manifest tools must not
  // shadow it.
  "connect_extension",
  "memory.save",
  "memory.search",
  // Settings tool (issue #67): rides the SDK custom-tools path like the
  // memory tools — manifest tools must not shadow it.
  "settings",
  // Admin tools (issue #73): ride the SDK custom-tools path through the
  // driver's policy gate — manifest tools must not shadow them.
  "catalog_browser",
  "stack_health",
  "deploy_info",
  "first_run_wizard",
] as const;

/**
 * Tool names the runtime reserves: SDK built-ins (an extension tool would
 * REPLACE the built-in in the session tool registry) plus bottega's own
 * project tools. Manifest tools must not shadow any of these.
 */
export const RESERVED_TOOL_NAMES: readonly string[] = [
  ...Object.keys(BUILTIN_TOOLS),
  ...Object.keys(HIDDEN_TOOLS),
  ...PROJECT_TOOL_NAMES,
];

export class ExtensionValidationError extends Error {
  constructor(message: string) {
    super(`extension manifest invalid: ${message}`);
    this.name = "ExtensionValidationError";
  }
}

/** Identifier charset shared by extension ids and tool names. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** Extension id format (shared with the policy parser, issue #56). */
export const EXTENSION_ID_RE = NAME_RE;
const DOMAIN_RE = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * Environment variable names that carry credentials. The CLI credential
 * boundary (issue #58) is the iron-proxy, never the environment: bottega
 * strips these from the env it passes to spawned CLIs, and a manifest that
 * declares one in `cli.env` is rejected (fail closed). A name pattern is a
 * guard, not a vault — the proxy remains the actual authorization boundary.
 */
export const CREDENTIAL_ENV_RE =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|CREDENTIAL|AUTHORIZATION)(?:_|$)/i;

function isCredentialEnvKey(name: string): boolean {
  return CREDENTIAL_ENV_RE.test(name);
}

/** Any value a JSON document can hold — untrusted manifest-shaped input (catalog response, snapshot record). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Untrusted manifest-shaped object. */
export type JsonObject = { [key: string]: JsonValue };

/** Canonical record guard for untrusted manifest-shaped input (shared with the tool generator, issue #157). */
export function isRecord(value: JsonValue): value is JsonObject {
  // A record is a non-array object. Object.prototype.toString distinguishes
  // plain objects from arrays, null, and primitives without a `typeof` check.
  return Object.prototype.toString.call(value) === "[object Object]";
}

/** Throws the manifest's canonical fail-closed validation error. */
function fail(message: string): never {
  throw new ExtensionValidationError(message);
}

function requiredString(record: JsonObject, field: string): string {
  const parsed = z.string().safeParse(record[field]);
  if (!parsed.success || parsed.data.trim() === "") {
    fail(`${field} must be a non-empty string`);
  }
  return parsed.data;
}

function optionalStringArray(record: JsonObject, field: string): string[] | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  const parsed = z.array(z.string()).safeParse(value);
  if (!parsed.success || parsed.data.some((entry) => entry.trim() === "")) {
    fail(`${field} must be an array of non-empty strings`);
  }
  return parsed.data;
}

/** The field's string value, or null when absent or blank (mirrors the binding's presence checks). */
function optionalNonEmptyString(value: JsonValue): string | null {
  const parsed = z.string().safeParse(value);
  if (!parsed.success || parsed.data.trim() === "") return null;
  return parsed.data;
}

function validateCredentialSchema(value: JsonValue): CredentialSchema {
  if (!isRecord(value) || (value["type"] !== "oauth" && value["type"] !== "api_key")) {
    fail("credentialSchema.type must be \"oauth\" or \"api_key\"");
  }
  const scopes = optionalStringArray(value, "scopes");
  if (scopes !== undefined && value["type"] === "api_key") {
    fail("credentialSchema.scopes only applies to oauth credentials");
  }
  return value["type"] === "oauth"
    ? { type: "oauth", ...(scopes !== undefined ? { scopes } : undefined) }
    : { type: "api_key" };
}

function validateMcpBinding(value: JsonValue): McpBinding {
  if (!isRecord(value)) {
    fail("mcp binding must be an object");
  }
  const serverUrl = optionalNonEmptyString(value["serverUrl"]);
  const command = optionalNonEmptyString(value["command"]);
  const hasServerUrl = serverUrl !== null;
  const hasCommand = command !== null;
  if (hasServerUrl === hasCommand) {
    fail("mcp binding requires exactly one of serverUrl or command");
  }
  const transport = value["transport"];
  if (transport !== "streamable-http" && transport !== "stdio") {
    fail("mcp.transport must be \"streamable-http\" or \"stdio\"");
  }
  if (serverUrl !== null) {
    if (transport !== "streamable-http") {
      fail("mcp serverUrl bindings must use transport \"streamable-http\"");
    }
    let parsed: URL;
    try {
      parsed = new URL(serverUrl);
    } catch {
      fail("mcp.serverUrl must be a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      fail("mcp.serverUrl must be an http(s) URL");
    }
    return { serverUrl, transport: "streamable-http" };
  }
  if (transport !== "stdio") {
    fail("mcp command bindings must use transport \"stdio\"");
  }
  // SAFETY: hasServerUrl is false here, so the exactly-one check above
  // guarantees hasCommand — command is a non-empty string at this point.
  const stdioCommand = command as string;
  if (isBareInteractiveCommand(stdioCommand)) {
    // Issue #205: a bare interactive runner/shell has no MCP server to run.
    // Spawning it drops the client into an stdin shell/REPL, so the MCP
    // JSON-RPC bytes are EXECUTED as shell commands (`sh: line 1:
    // method:initialize: command not found` every boot) and the handshake
    // never completes (60s timeout). The manifest carries no args — the
    // command must exec the actual server binary directly.
    fail(
      `mcp.command "${stdioCommand}" is an interactive package runner/shell that cannot serve ` +
        "MCP over stdio without a target; pin the actual server binary as the command",
    );
  }
  return { command: stdioCommand, transport: "stdio" };
}

/**
 * Commands that, spawned with NO args, fall back to an interactive stdin
 * shell/REPL (or a package prompt) instead of speaking MCP — the exact
 * malformed-exec hazard of issue #205 (MCP JSON-RPC executed as shell
 * commands). Matched by basename so absolute paths (`/usr/local/bin/npx`)
 * are covered too. A real server binary (e.g. `linear-mcp`) is never in
 * this set; a runner with explicit args is not representable in the
 * manifest (McpBinding has no args), so the bare form is rejected.
 */
const BARE_INTERACTIVE_COMMANDS = new Set([
  "npx",
  "bunx",
  "npm",
  "pnpm",
  "yarn",
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "perl",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
]);

function isBareInteractiveCommand(command: string): boolean {
  const base = command.trim().split(/[\\/]/).at(-1) ?? "";
  return BARE_INTERACTIVE_COMMANDS.has(base);
}

function validateCliBinding(value: JsonValue): CliBinding {
  if (!isRecord(value)) {
    fail("cli binding must be an object");
  }
  const command = requiredString(value, "command");
  const args = optionalStringArray(value, "args");
  let env: Record<string, string> | undefined;
  if (value["env"] !== undefined) {
    const rawEnv = value["env"];
    if (!isRecord(rawEnv)) {
      fail("cli.env must be a string-to-string mapping");
    }
    const parsedEnv = z.record(z.string(), z.string()).safeParse(rawEnv);
    if (!parsedEnv.success) {
      fail("cli.env must be a string-to-string mapping");
    }
    env = parsedEnv.data;
    const credentialKey = Object.keys(env).find(isCredentialEnvKey);
    if (credentialKey !== undefined) {
      fail(
        `cli.env key "${credentialKey}" looks like a credential — CLIs never receive credentials via env (iron-proxy boundary only)`,
      );
    }
  }
  return {
    command,
    ...(args !== undefined ? { args } : undefined),
    ...(env !== undefined ? { env } : undefined),
  };
}

function validateTools(value: JsonValue): ExtensionTool[] {
  if (!Array.isArray(value)) {
    fail("tools must be an array");
  }
  const tools: ExtensionTool[] = [];
  const seenNames = new Set<string>();
  for (const rawEntry of value) {
    if (!isRecord(rawEntry)) {
      fail("each tool must be an object");
    }
    const name = requiredString(rawEntry, "name");
    if (!NAME_RE.test(name)) {
      fail(`tool name "${name}" must match ${NAME_RE.source}`);
    }
    if (RESERVED_TOOL_NAMES.includes(name)) {
      fail(`tool name "${name}" is reserved by the runtime`);
    }
    if (seenNames.has(name)) {
      fail(`duplicate tool name "${name}"`);
    }
    seenNames.add(name);
    // providerName (issue #148): the provider's wire tool name, absent →
    // fall back to the manifest name. Same identifier charset as the
    // manifest name, fail closed on anything else.
    let providerName: string | undefined;
    if (rawEntry["providerName"] !== undefined) {
      const parsed = z.string().safeParse(rawEntry["providerName"]);
      if (!parsed.success || parsed.data.trim() === "") {
        fail(`tool "${name}" providerName must be a non-empty string`);
      }
      if (!NAME_RE.test(parsed.data)) {
        fail(`tool "${name}" providerName "${parsed.data}" must match ${NAME_RE.source}`);
      }
      providerName = parsed.data;
    }
    const tier = rawEntry["tier"];
    if (tier !== "read" && tier !== "write" && tier !== "exec") {
      fail(`tool "${name}" tier must be "read", "write", or "exec"`);
    }
    const description = requiredString(rawEntry, "description");
    const params = validateParams(rawEntry["params"], name);
    tools.push({
      name,
      ...(providerName !== undefined ? { providerName } : undefined),
      tier,
      description,
      params,
    });
  }
  return tools;
}

function validateParams(value: JsonValue, toolName: string): ExtensionToolParam[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(`tool "${toolName}" params must be an array`);
  }
  const params: ExtensionToolParam[] = [];
  const seenNames = new Set<string>();
  for (const rawEntry of value) {
    if (!isRecord(rawEntry)) {
      fail(`tool "${toolName}" params entries must be objects`);
    }
    const name = requiredString(rawEntry, "name");
    if (seenNames.has(name)) {
      fail(`tool "${toolName}" has duplicate param "${name}"`);
    }
    seenNames.add(name);
    const type = z.enum(["string", "number", "boolean"]).safeParse(rawEntry["type"]);
    if (!type.success) {
      fail(`tool "${toolName}" param "${name}" type must be "string", "number", or "boolean"`);
    }
    let description: string | undefined;
    if (rawEntry["description"] !== undefined) {
      const parsed = z.string().safeParse(rawEntry["description"]);
      if (!parsed.success || parsed.data.trim() === "") {
        fail(`tool "${toolName}" param "${name}" description must be a non-empty string`);
      }
      description = parsed.data;
    }
    let required: boolean | undefined;
    if (rawEntry["required"] !== undefined) {
      const parsed = z.boolean().safeParse(rawEntry["required"]);
      if (!parsed.success) {
        fail(`tool "${toolName}" param "${name}" required must be a boolean`);
      }
      required = parsed.data;
    }
    params.push({
      name,
      type: type.data,
      ...(description !== undefined ? { description } : undefined),
      ...(required !== undefined ? { required } : undefined),
    });
  }
  return params;
}

function validateDomains(value: JsonValue): string[] {
  const parsed = z.array(z.string()).safeParse(value);
  if (!parsed.success || parsed.data.some((entry) => entry.trim() === "")) {
    fail("domains must be an array of non-empty strings");
  }
  for (const domain of parsed.data) {
    if (!DOMAIN_RE.test(domain)) {
      fail(
        `domain "${domain}" must be a hostname or "*."-prefixed wildcard (no scheme, port, or trailing dot)`,
      );
    }
  }
  return parsed.data;
}

/**
 * Validates an untrusted manifest (snapshot JSON, catalog response) and
 * returns a typed manifest. Throws {@link ExtensionValidationError} on the
 * first problem — malformed manifests fail closed, never partially register.
 */
export function validateManifest(input: JsonValue): ExtensionManifest {
  if (!isRecord(input)) {
    fail("manifest must be an object");
  }
  const id = requiredString(input, "id");
  if (!NAME_RE.test(id)) {
    fail(`id "${id}" must match ${NAME_RE.source}`);
  }
  const label = requiredString(input, "label");
  const vendor = requiredString(input, "vendor");
  const kind = input["kind"];
  if (kind !== "mcp" && kind !== "cli") {
    fail("kind must be \"mcp\" or \"cli\"");
  }
  const credentialSchema = validateCredentialSchema(input["credentialSchema"]);
  // Tools are OPTIONAL (issue #158): absent → the runtime discovers the
  // surface from the provider's tools/list; present (including `[]` — an
  // egress-only extension) → the pinned surface wins. The typed manifest
  // keeps the distinction: `tools` is absent only when the input omitted it.
  const tools = input["tools"] === undefined ? undefined : validateTools(input["tools"]);
  const domains = validateDomains(input["domains"]);
  if (kind === "mcp") {
    if (input["cli"] !== undefined) {
      fail("an mcp extension must not declare a cli binding");
    }
    if (input["mcp"] === undefined) {
      fail("an mcp extension requires an mcp binding");
    }
    return {
      id,
      label,
      vendor,
      kind: "mcp",
      mcp: validateMcpBinding(input["mcp"]),
      credentialSchema,
      ...(tools !== undefined ? { tools } : undefined),
      domains,
    };
  }
  if (input["mcp"] !== undefined) {
    fail("a cli extension must not declare an mcp binding");
  }
  if (input["cli"] === undefined) {
    fail("a cli extension requires a cli binding");
  }
  return {
    id,
    label,
    vendor,
    kind: "cli",
    cli: validateCliBinding(input["cli"]),
    credentialSchema,
    ...(tools !== undefined ? { tools } : undefined),
    domains,
  };
}
