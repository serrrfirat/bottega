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

export type ExtensionKind = "mcp" | "cli" | "openapi";
export type ExtensionToolTier = "read" | "write" | "exec";
export type CredentialType = "oauth" | "api_key";
export type McpTransport = "streamable-http" | "stdio";
/** Static credential scheme for OpenAPI extensions (issue #345 V1 scope). */
export type OpenApiAuthScheme = "bearer" | "apiKeyHeader";

/**
 * OpenAPI extension binding (issue #345): the spec URL and the static auth
 * scheme iron-proxy injects at egress. V1 scope is STATIC credentials only
 * (bearer / apiKeyHeader); OAuth-protected REST APIs stay out of V1 — they
 * are exactly what hosted MCP already covers.
 */
export interface OpenApiBinding {
  /** The HTTPS OpenAPI 3.x spec URL (validated at pin time). */
  specUrl: string;
  auth: {
    scheme: OpenApiAuthScheme;
    /** The header name for the `apiKeyHeader` scheme (e.g. X-Api-Key). */
    headerName?: string;
    /** Human label for the credential provisioning prompt. */
    credentialLabel?: string;
  };
}

/**
 * MCP binding: exactly one of serverUrl (official remote server) or command
 * (preinstalled stdio server in the tools image). The transport must match
 * the binding: streamable-http goes with a serverUrl, stdio with a command.
 *
 * Issue #284: OAuth for hosted MCP bindings is owned by the MCP SDK (the
 * runtime's OAuthClientProvider), so the binding carries no OAuth
 * endpoint — the SDK performs its own RFC 8414 discovery at connect and
 * call time. The egress proxy is transport/allowlist only.
 */
export type McpBinding =
  | { serverUrl: string; command?: never; transport: "streamable-http" }
  | { command: string; serverUrl?: never; transport: "stdio" };

/** CLI binding: the preinstalled binary, fixed args, and optional env delta. */
export interface CliBinding {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Explicit environment variable that receives the opaque per-call proxy
   * token. The real credential never enters the child environment.
   */
  credentialEnv?: string;
}

/**
 * Credential schema the vault must satisfy for this extension. `scopes` only
 * applies to oauth; an api_key schema with scopes is malformed.
 */
export interface CredentialSchema {
  type: CredentialType;
  scopes?: string[];
}

/**
 * The webhook inbound scheme (issue #57 follow-up): how a registered
 * extension's `POST /webhooks/<extension>` deliveries are authenticated.
 * `hmac-sha256` is the provider-agnostic default (raw-body HMAC, constant
 * time, hex OR base64). `github` and `linear` are PRESETS that map onto the
 * same verifier machinery with their provider conventions preserved
 * (X-Hub-Signature-256, Linear HMAC) — their schemes behave exactly as the
 * pre-manifest hand-written verifiers did.
 */
export type WebhookScheme = "hmac-sha256" | "github" | "linear";

/**
 * Manifest-declared webhook authentication (issue #57 follow-up): an
 * extension declares a `webhook` block to make its inbound deliveries
 * receivable through the generic route. The `secretRef` is the vault /
 * boot-secret identity the shared secret resolver looks up (e.g.
 * `github-webhook` for GitHub). Fail closed: an extension WITHOUT this
 * declaration refuses webhook deliveries (the route 404s).
 */
export interface WebhookDeclaration {
  /** The signature scheme; `hmac-sha256` is the provider-agnostic default. */
  scheme: WebhookScheme;
  /**
   * The request header carrying the signature. Defaults to the scheme's
   * provider convention when absent (github → `x-hub-signature-256`,
   * linear → `linear-signature`); a generic `hmac-sha256` declaration
   * defaults to {@link DEFAULT_GENERIC_WEBHOOK_HEADER} (`x-bottega-signature`).
   */
  header?: string;
  /** The vault / boot-secret identity whose value is the shared signing key. */
  secretRef: string;
}

/** The default signature header for a generic `hmac-sha256` webhook declaration. */
export const DEFAULT_GENERIC_WEBHOOK_HEADER = "x-bottega-signature";

/**
 * A reviewed destination that may receive an extension credential.
 * `domains` controls reachability; this narrower list controls authority.
 */
export interface CredentialTarget {
  /** Exact hostname or an explicitly reviewed `*.` subdomain wildcard. */
  host: string;
  /** Optional normalized absolute path prefix, matched on segment boundaries. */
  pathPrefix?: string;
}

/** One declarative tool parameter (converted to a zod schema by the bridge). */
export interface ExtensionToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  /**
   * The provider's ORIGINAL JSON Schema type when it declared a structured
   * value (issue #248). Only array/object carry jsonType: the model-facing
   * surface keeps `type: "string"` (the agent supplies a JSON literal —
   * array/object are unrepresentable in `type`), and the runtime re-parses
   * the JSON-serialized string back to a NATIVE array/object before the MCP
   * wire call. Absent → a genuinely scalar/string param, never re-parsed.
   */
  jsonType?: "array" | "object";
  description?: string;
  /** Defaults to true: a declared param is required unless marked optional. */
  required?: boolean;
  /**
   * Where an OpenAPI-generated param lands in the egress request (issue
   * #345). Present ONLY for OpenAPI extensions: path/query params map to
   * the URL, a single `body` param maps to the JSON request body. Absent
   * for MCP/CLI params (they never rebuild an HTTP request).
   */
  location?: "path" | "query" | "body";
}

/** HTTP operation template for one OpenAPI tool (issue #345). */
export interface OpenApiToolMetadata {
  /** The HTTP method verb. */
  method: "get" | "post" | "put" | "delete" | "patch" | "options" | "head" | "trace";
  /** The path template (with `{param}` placeholders), e.g. `/users/{id}`. */
  path: string;
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
  /**
   * HTTP operation template for an OpenAPI-generated tool (issue #345).
   * Present ONLY for openapi-kind extensions: the executor rebuilds the
   * egress request from method+path+param locations. Absent for MCP/CLI.
   */
  openapi?: OpenApiToolMetadata;
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
      /** Manifest-declared webhook authentication (issue #57 follow-up). */
      webhook?: WebhookDeclaration;
      /** Egress allowlist entries (iron-proxy): hostnames, optional `*.` prefix. */
      domains: string[];
      /** Reviewed credential authority, separate from the broader egress allowlist. */
      credentialTargets: CredentialTarget[];
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
      /** Manifest-declared webhook authentication (issue #57 follow-up). */
      webhook?: WebhookDeclaration;
      domains: string[];
      credentialTargets: CredentialTarget[];
    }
  | {
      id: string;
      label: string;
      vendor: string;
      kind: "openapi";
      mcp?: never;
      cli?: never;
      /** The spec URL + static auth scheme (issue #345). */
      openapi: OpenApiBinding;
      credentialSchema: CredentialSchema;
      /** The FROZEN tool surface generated from the spec at pin time. */
      tools: ExtensionTool[];
      /** Manifest-declared webhook authentication (issue #57 follow-up). */
      webhook?: WebhookDeclaration;
      /** Egress allowlist entries (iron-proxy) from the spec's HTTPS servers. */
      domains: string[];
      credentialTargets: CredentialTarget[];
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
  // Complete space-skill lifecycle; extension tools cannot shadow any
  // governance operation.
  "list_space_skills",
  "get_space_skill",
  "create_space_skill",
  "update_space_skill",
  "delete_space_skill",
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
  // Scheduler lifecycle (issues #86/#308): policy-gated custom tools.
  "create_scheduler_job",
  "list_scheduler_jobs",
  "update_scheduler_job",
  "pause_scheduler_job",
  "resume_scheduler_job",
  "run_scheduler_job_now",
  "delete_scheduler_job",
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
const ENCODED_PATH_SEPARATOR_OR_DOT_RE = /%(?:2f|5c|2e)/i;

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

/** Validates a manifest `webhook` declaration (issue #57 follow-up). Fail closed. */
function validateWebhookDeclaration(value: JsonValue): WebhookDeclaration {
  if (!isRecord(value)) {
    fail("webhook must be an object");
  }
  const scheme = value["scheme"];
  if (scheme !== "hmac-sha256" && scheme !== "github" && scheme !== "linear") {
    fail("webhook.scheme must be \"hmac-sha256\", \"github\", or \"linear\"");
  }
  const secretRef = optionalNonEmptyString(value["secretRef"]);
  if (secretRef === null) {
    fail("webhook.secretRef must be a non-empty string");
  }
  const header = optionalNonEmptyString(value["header"]);
  return header === null
    ? { scheme, secretRef }
    : { scheme, header, secretRef };
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
    return {
      serverUrl,
      transport: "streamable-http",
    };
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
  return {
    command: stdioCommand,
    transport: "stdio",
  };
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
        `cli.env key "${credentialKey}" looks like a credential — use cli.credentialEnv so only the opaque per-call proxy token enters the child`,
      );
    }
  }
  let credentialEnv: string | undefined;
  if (value["credentialEnv"] !== undefined) {
    credentialEnv = requiredString(value, "credentialEnv");
    if (!/^[A-Z_][A-Z0-9_]*$/.test(credentialEnv)) {
      fail("cli.credentialEnv must be an uppercase environment variable name");
    }
    if (!isCredentialEnvKey(credentialEnv)) {
      fail("cli.credentialEnv must name the CLI's credential variable");
    }
    if (env?.[credentialEnv] !== undefined) {
      fail(`cli.credentialEnv "${credentialEnv}" must not also appear in cli.env`);
    }
  }
  return {
    command,
    ...(args !== undefined ? { args } : undefined),
    ...(env !== undefined ? { env } : undefined),
    ...(credentialEnv !== undefined ? { credentialEnv } : undefined),
  };
}

/**
 * Validates an OpenAPI binding (issue #345): the spec URL must be HTTPS and
 * the auth scheme must be a static V1 scheme (`bearer` or `apiKeyHeader`).
 * An apiKeyHeader scheme REQUIRES a header name; bearer must not carry one
 * (it injects the standard Authorization: Bearer header).
 */
function validateOpenApiBinding(value: JsonValue): OpenApiBinding {
  if (!isRecord(value)) {
    fail("openapi binding must be an object");
  }
  const specUrl = requiredString(value, "specUrl");
  let parsed: URL;
  try {
    parsed = new URL(specUrl);
  } catch {
    fail("openapi.specUrl must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    fail("openapi.specUrl must be HTTPS (fail closed: no plaintext specs)");
  }
  const authValue = value["auth"];
  if (!isRecord(authValue)) {
    fail("openapi.auth must be an object");
  }
  const schemeRaw = z.string().safeParse(authValue["scheme"]);
  if (!schemeRaw.success || (schemeRaw.data !== "bearer" && schemeRaw.data !== "apiKeyHeader")) {
    fail('openapi.auth.scheme must be "bearer" or "apiKeyHeader"');
  }
  const scheme: OpenApiAuthScheme = schemeRaw.data;
  let headerName: string | undefined;
  if (scheme === "apiKeyHeader") {
    const header = requiredString(authValue, "headerName");
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(header)) {
      fail("openapi.auth.headerName must be a valid HTTP header name");
    }
    headerName = header;
  } else if (authValue["headerName"] !== undefined) {
    fail("openapi.auth.headerName only applies to the apiKeyHeader scheme");
  }
  const credentialLabel = optionalNonEmptyString(authValue["credentialLabel"]);
  return {
    specUrl,
    auth: {
      scheme,
      ...(headerName !== undefined ? { headerName } : undefined),
      ...(credentialLabel !== null ? { credentialLabel } : undefined),
    },
  };
}

const OPENAPI_METHODS = ["get", "post", "put", "delete", "patch", "options", "head", "trace"] as const;

function validateOpenApiToolMetadata(value: JsonValue, toolName: string): OpenApiToolMetadata {
  if (!isRecord(value)) {
    fail(`tool "${toolName}" openapi metadata must be an object`);
  }
  const method = z.enum(OPENAPI_METHODS).safeParse(value["method"]);
  if (!method.success) {
    fail(`tool "${toolName}" openapi.method must be an HTTP verb`);
  }
  const path = requiredString(value, "path");
  if (!path.startsWith("/")) {
    fail(`tool "${toolName}" openapi.path must begin with "/"`);
  }
  return { method: method.data, path };
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
    const openapi = rawEntry["openapi"] === undefined ? undefined : validateOpenApiToolMetadata(rawEntry["openapi"], name);
    tools.push({
      name,
      ...(providerName !== undefined ? { providerName } : undefined),
      tier,
      description,
      params,
      ...(openapi !== undefined ? { openapi } : undefined),
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
    let jsonType: "array" | "object" | undefined;
    if (rawEntry["jsonType"] !== undefined) {
      const parsed = z.enum(["array", "object"]).safeParse(rawEntry["jsonType"]);
      if (!parsed.success) {
        fail(`tool "${toolName}" param "${name}" jsonType must be "array" or "object"`);
      }
      // jsonType records the provider's structured type (issue #248): it
      // only applies to array/object params, which travel the model-facing
      // surface as JSON-serialized strings — a non-string pairing is
      // malformed (the runtime re-parses strings only).
      if (type.data !== "string") {
        fail(`tool "${toolName}" param "${name}" jsonType requires type "string"`);
      }
      jsonType = parsed.data;
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
    let location: "path" | "query" | "body" | undefined;
    if (rawEntry["location"] !== undefined) {
      const parsed = z.enum(["path", "query", "body"]).safeParse(rawEntry["location"]);
      if (!parsed.success) {
        fail(`tool "${toolName}" param "${name}" location must be "path", "query", or "body"`);
      }
      location = parsed.data;
    }
    params.push({
      name,
      type: type.data,
      ...(jsonType !== undefined ? { jsonType } : undefined),
      ...(description !== undefined ? { description } : undefined),
      ...(required !== undefined ? { required } : undefined),
      ...(location !== undefined ? { location } : undefined),
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

function domainCoversTarget(domain: string, host: string): boolean {
  if (domain === host) return true;
  if (!domain.startsWith("*.") || host.startsWith("*.")) return false;
  const suffix = domain.slice(1).toLowerCase();
  const normalizedHost = host.toLowerCase();
  return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
}

function validateCredentialTargets(value: JsonValue, domains: readonly string[]): CredentialTarget[] {
  if (!Array.isArray(value)) {
    fail("credentialTargets must be an array");
  }
  if (value.length === 0) {
    fail("credentialTargets must not be empty for an authenticated extension");
  }
  const targets: CredentialTarget[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) fail("each credential target must be an object");
    const host = requiredString(raw, "host").toLowerCase();
    if (host === "*" || !DOMAIN_RE.test(host)) {
      fail(`credential target host "${host}" must be an exact hostname or an explicitly reviewed "*." wildcard`);
    }
    if (host.startsWith("*.") && !domains.some((domain) => domain.toLowerCase() === host)) {
      fail(`wildcard credential target "${host}" must be covered by an identical wildcard in domains`);
    }
    if (!domains.some((domain) => domainCoversTarget(domain.toLowerCase(), host))) {
      fail(`credential target host "${host}" must be covered by domains`);
    }
    let pathPrefix: string | undefined;
    if (raw["pathPrefix"] !== undefined) {
      pathPrefix = requiredString(raw, "pathPrefix");
      if (
        !pathPrefix.startsWith("/") ||
        (pathPrefix.length > 1 && pathPrefix.endsWith("/")) ||
        pathPrefix.includes("?") ||
        pathPrefix.includes("#") ||
        pathPrefix.includes("\\") ||
        pathPrefix.includes("//") ||
        ENCODED_PATH_SEPARATOR_OR_DOT_RE.test(pathPrefix) ||
        pathPrefix.split("/").some((segment) => segment === "." || segment === "..")
      ) {
        fail(
          `credential target pathPrefix "${pathPrefix}" must be a normalized absolute path without query, fragment, trailing slash, dot segments, or encoded separators`,
        );
      }
    }
    const key = `${host}\n${pathPrefix ?? ""}`;
    if (seen.has(key)) fail(`duplicate credential target "${host}${pathPrefix ?? ""}"`);
    seen.add(key);
    targets.push({ host, ...(pathPrefix !== undefined ? { pathPrefix } : undefined) });
  }
  return targets;
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
  if (kind !== "mcp" && kind !== "cli" && kind !== "openapi") {
    fail('kind must be "mcp", "cli", or "openapi"');
  }
  const credentialSchema = validateCredentialSchema(input["credentialSchema"]);
  // Webhook inbound auth (issue #57 follow-up): an extension MAY declare a
  // webhook block; without it the generic route refuses its deliveries.
  const webhook = input["webhook"] === undefined ? undefined : validateWebhookDeclaration(input["webhook"]);
  // Tools are OPTIONAL (issue #158): absent → the runtime discovers the
  // surface from the provider's tools/list; present (including `[]` — an
  // egress-only extension) → the pinned surface wins. The typed manifest
  // keeps the distinction: `tools` is absent only when the input omitted it.
  const tools = input["tools"] === undefined ? undefined : validateTools(input["tools"]);
  const domains = validateDomains(input["domains"]);
  const credentialTargets = validateCredentialTargets(input["credentialTargets"], domains);
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
      ...(webhook !== undefined ? { webhook } : undefined),
      ...(tools !== undefined ? { tools } : undefined),
      domains,
      credentialTargets,
    };
  }
  if (kind === "openapi") {
    if (input["mcp"] !== undefined) {
      fail("an openapi extension must not declare an mcp binding");
    }
    if (input["cli"] !== undefined) {
      fail("an openapi extension must not declare a cli binding");
    }
    if (input["openapi"] === undefined) {
      fail("an openapi extension requires an openapi binding");
    }
    if (tools === undefined) {
      // The openapi surface is ALWAYS pinned at generation time (issue #345):
      // the runtime never re-fetches the spec, so the frozen tools are
      // mandatory — an openapi manifest without them is malformed.
      fail("an openapi extension requires a pinned tools surface (generated from the spec at pin)");
    }
    return {
      id,
      label,
      vendor,
      kind: "openapi",
      openapi: validateOpenApiBinding(input["openapi"]),
      credentialSchema,
      tools,
      ...(webhook !== undefined ? { webhook } : undefined),
      domains,
      credentialTargets,
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
    ...(webhook !== undefined ? { webhook } : undefined),
    ...(tools !== undefined ? { tools } : undefined),
    domains,
    credentialTargets,
  };
}
