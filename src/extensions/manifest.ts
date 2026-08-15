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

/** One tool surface entry. `tier` feeds both the SDK approval tier and policy. */
export interface ExtensionTool {
  name: string;
  tier: ExtensionToolTier;
  description: string;
  params: ExtensionToolParam[];
}

/**
 * The extension manifest. Discriminated on `kind`: an mcp extension MUST
 * carry an mcp binding, a cli extension MUST carry a cli binding — the type
 * system and validateManifest agree.
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
      tools: ExtensionTool[];
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
      tools: ExtensionTool[];
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
  "memory.save",
  "memory.search",
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

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DOMAIN_RE = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ExtensionValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalStringArray(record: Record<string, unknown>, field: string): string[] | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new ExtensionValidationError(`${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function validateCredentialSchema(value: unknown): CredentialSchema {
  if (!isRecord(value) || (value["type"] !== "oauth" && value["type"] !== "api_key")) {
    throw new ExtensionValidationError("credentialSchema.type must be \"oauth\" or \"api_key\"");
  }
  const scopes = optionalStringArray(value, "scopes");
  if (scopes !== undefined && value["type"] === "api_key") {
    throw new ExtensionValidationError("credentialSchema.scopes only applies to oauth credentials");
  }
  return value["type"] === "oauth"
    ? { type: "oauth", ...(scopes !== undefined ? { scopes } : {}) }
    : { type: "api_key" };
}

function validateMcpBinding(value: unknown): McpBinding {
  if (!isRecord(value)) {
    throw new ExtensionValidationError("mcp binding must be an object");
  }
  const serverUrl = value["serverUrl"];
  const command = value["command"];
  const hasServerUrl = typeof serverUrl === "string" && serverUrl.trim() !== "";
  const hasCommand = typeof command === "string" && command.trim() !== "";
  if (hasServerUrl === hasCommand) {
    throw new ExtensionValidationError("mcp binding requires exactly one of serverUrl or command");
  }
  const transport = value["transport"];
  if (transport !== "streamable-http" && transport !== "stdio") {
    throw new ExtensionValidationError("mcp.transport must be \"streamable-http\" or \"stdio\"");
  }
  if (hasServerUrl) {
    if (transport !== "streamable-http") {
      throw new ExtensionValidationError("mcp serverUrl bindings must use transport \"streamable-http\"");
    }
    let parsed: URL;
    try {
      parsed = new URL(serverUrl as string);
    } catch {
      throw new ExtensionValidationError("mcp.serverUrl must be a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ExtensionValidationError("mcp.serverUrl must be an http(s) URL");
    }
    return { serverUrl: serverUrl as string, transport: "streamable-http" };
  }
  if (transport !== "stdio") {
    throw new ExtensionValidationError("mcp command bindings must use transport \"stdio\"");
  }
  return { command: command as string, transport: "stdio" };
}

function validateCliBinding(value: unknown): CliBinding {
  if (!isRecord(value)) {
    throw new ExtensionValidationError("cli binding must be an object");
  }
  const command = requiredString(value, "command");
  const args = optionalStringArray(value, "args");
  const env = value["env"];
  if (env !== undefined) {
    if (!isRecord(env) || Object.values(env).some((entry) => typeof entry !== "string")) {
      throw new ExtensionValidationError("cli.env must be a string-to-string mapping");
    }
  }
  return {
    command,
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env: env as Record<string, string> } : {}),
  };
}

function validateTools(value: unknown): ExtensionTool[] {
  if (!Array.isArray(value)) {
    throw new ExtensionValidationError("tools must be an array");
  }
  const tools: ExtensionTool[] = [];
  const seenNames = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new ExtensionValidationError("each tool must be an object");
    }
    const name = requiredString(entry, "name");
    if (!NAME_RE.test(name)) {
      throw new ExtensionValidationError(`tool name "${name}" must match ${NAME_RE.source}`);
    }
    if (RESERVED_TOOL_NAMES.includes(name)) {
      throw new ExtensionValidationError(`tool name "${name}" is reserved by the runtime`);
    }
    if (seenNames.has(name)) {
      throw new ExtensionValidationError(`duplicate tool name "${name}"`);
    }
    seenNames.add(name);
    const tier = entry["tier"];
    if (tier !== "read" && tier !== "write" && tier !== "exec") {
      throw new ExtensionValidationError(`tool "${name}" tier must be \"read\", \"write\", or \"exec\"`);
    }
    const description = requiredString(entry, "description");
    const params = validateParams(entry["params"], name);
    tools.push({ name, tier, description, params });
  }
  return tools;
}

function validateParams(value: unknown, toolName: string): ExtensionToolParam[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ExtensionValidationError(`tool "${toolName}" params must be an array`);
  }
  const params: ExtensionToolParam[] = [];
  const seenNames = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new ExtensionValidationError(`tool "${toolName}" params entries must be objects`);
    }
    const name = requiredString(entry, "name");
    if (seenNames.has(name)) {
      throw new ExtensionValidationError(`tool "${toolName}" has duplicate param "${name}"`);
    }
    seenNames.add(name);
    const type = entry["type"];
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new ExtensionValidationError(
        `tool "${toolName}" param "${name}" type must be \"string\", \"number\", or \"boolean\"`,
      );
    }
    const description = entry["description"];
    if (description !== undefined && (typeof description !== "string" || description.trim() === "")) {
      throw new ExtensionValidationError(`tool "${toolName}" param "${name}" description must be a non-empty string`);
    }
    const required = entry["required"];
    if (required !== undefined && typeof required !== "boolean") {
      throw new ExtensionValidationError(`tool "${toolName}" param "${name}" required must be a boolean`);
    }
    params.push({
      name,
      type,
      ...(description !== undefined ? { description } : {}),
      ...(required !== undefined ? { required } : {}),
    });
  }
  return params;
}

function validateDomains(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new ExtensionValidationError("domains must be an array of non-empty strings");
  }
  for (const domain of value as string[]) {
    if (!DOMAIN_RE.test(domain)) {
      throw new ExtensionValidationError(
        `domain "${domain}" must be a hostname or \"*.\"-prefixed wildcard (no scheme, port, or trailing dot)`,
      );
    }
  }
  return [...(value as string[])];
}

/**
 * Validates an untrusted manifest (snapshot JSON, catalog response) and
 * returns a typed manifest. Throws {@link ExtensionValidationError} on the
 * first problem — malformed manifests fail closed, never partially register.
 */
export function validateManifest(input: unknown): ExtensionManifest {
  if (!isRecord(input)) {
    throw new ExtensionValidationError("manifest must be an object");
  }
  const id = requiredString(input, "id");
  if (!ID_RE.test(id)) {
    throw new ExtensionValidationError(`id "${id}" must match ${ID_RE.source}`);
  }
  const label = requiredString(input, "label");
  const vendor = requiredString(input, "vendor");
  const kind = input["kind"];
  if (kind !== "mcp" && kind !== "cli") {
    throw new ExtensionValidationError("kind must be \"mcp\" or \"cli\"");
  }
  const credentialSchema = validateCredentialSchema(input["credentialSchema"]);
  const tools = validateTools(input["tools"]);
  const domains = validateDomains(input["domains"]);
  if (kind === "mcp") {
    if (input["cli"] !== undefined) {
      throw new ExtensionValidationError("an mcp extension must not declare a cli binding");
    }
    if (input["mcp"] === undefined) {
      throw new ExtensionValidationError("an mcp extension requires an mcp binding");
    }
    return {
      id,
      label,
      vendor,
      kind: "mcp",
      mcp: validateMcpBinding(input["mcp"]),
      credentialSchema,
      tools,
      domains,
    };
  }
  if (input["mcp"] !== undefined) {
    throw new ExtensionValidationError("a cli extension must not declare an mcp binding");
  }
  if (input["cli"] === undefined) {
    throw new ExtensionValidationError("a cli extension requires a cli binding");
  }
  return {
    id,
    label,
    vendor,
    kind: "cli",
    cli: validateCliBinding(input["cli"]),
    credentialSchema,
    tools,
    domains,
  };
}
