/**
 * Extension tool bridge (issue #50): converts registered extensions' typed
 * manifest tools into SDK tool definitions for the space agent's toolset.
 *
 * The bridge is generic by design — bottega never implements provider API
 * clients. kind "mcp" tools forward to the provider's OFFICIAL MCP server
 * (streamable-http for a serverUrl, stdio for a preinstalled command) via
 * the MCP SDK client; kind "cli" tools shell out to the preinstalled CLI in
 * the tools image, with params passed as `--name value` flags. One client
 * connection per tool call (provider issues own connection lifecycle).
 *
 * Credential boundary (issue #58): spawned CLIs never receive credentials
 * via env — the child env is the parent env minus credential-named
 * variables (plus the manifest's credential-free env delta). Auth happens
 * at the iron-proxy boundary (HTTPS_PROXY through the egress allowlist),
 * never in bottega.
 *
 * Manifest tool names are already validated against the runtime's reserved
 * names (manifest.ts), so definitions can never shadow a built-in tool.
 */
import { z, zod, type AgentToolResult, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { toolError } from "../tools/helpers";
import { CREDENTIAL_ENV_RE, type CliBinding, type ExtensionToolParam, type McpBinding } from "./manifest";
import type { ResolvedExtension } from "./registry";

export interface ExtensionToolBridgeOptions {
  /**
   * MCP transport factory (test seam): tests inject in-memory transports so
   * tool execution is exercised hermetically. Defaults to the real
   * streamable-http / stdio transports.
   */
  mcpTransport?: (binding: McpBinding) => Transport;
}

/**
 * SDK tool definitions for every tool of every registered extension.
 * Fail-closed: an extension without a binding for its kind cannot occur
 * (validateManifest rejects it), and any execution failure surfaces as a
 * tool error result, never a silent no-op.
 */
export function extensionToolDefinitions(
  extensions: ResolvedExtension[],
  opts: ExtensionToolBridgeOptions = {},
): ToolDefinition[] {
  const makeTransport = opts.mcpTransport ?? defaultMcpTransport;
  const definitions: ToolDefinition[] = [];
  for (const resolved of extensions) {
    const { manifest } = resolved;
    for (const tool of manifest.tools) {
      definitions.push({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: paramsToZodSchema(tool.params),
        approval: tool.tier,
        async execute(_toolCallId, params) {
          const args = (params ?? {}) as Record<string, unknown>;
          try {
            if (manifest.kind === "mcp") {
              return await callMcpTool(makeTransport, manifest.mcp, tool.name, args);
            }
            return await callCliTool(manifest.cli, tool.name, args);
          } catch (err) {
            return toolError(`extension tool "${tool.name}" failed: ${(err as Error).message}`);
          }
        },
      });
    }
  }
  return definitions;
}

function defaultMcpTransport(binding: McpBinding): Transport {
  if (binding.transport === "streamable-http") {
    return new StreamableHTTPClientTransport(new URL(binding.serverUrl));
  }
  return new StdioClientTransport({ command: binding.command });
}

/** Declarative manifest params -> zod object schema (required unless marked optional). */
function paramsToZodSchema(params: ExtensionToolParam[]): ReturnType<typeof z.object> {
  const shape: Record<string, zod.ZodLikeSchema<unknown>> = {};
  for (const param of params) {
    const base =
      param.type === "string" ? z.string() : param.type === "number" ? z.number() : z.boolean();
    shape[param.name] = param.required === false ? base.optional() : base;
  }
  return z.object(shape);
}

/**
 * Calls the provider's official MCP server (one client per call; the
 * provider issues own connection lifecycle). Text content blocks pass
 * through; other content types are stringified so the result always fits
 * the agent tool result shape.
 */
async function callMcpTool(
  makeTransport: (binding: McpBinding) => Transport,
  binding: McpBinding,
  toolName: string,
  params: Record<string, unknown>,
): Promise<AgentToolResult> {
  const client = new Client({ name: "bottega-extensions", version: "1.0.0" });
  try {
    await client.connect(makeTransport(binding));
    // The SDK's declared return is a union with an experimental task-based
    // branch; passing CallToolResultSchema pins the runtime shape, so the
    // cast is the documented contract (guarded below).
    const result = (await client.callTool({ name: toolName, arguments: params }, CallToolResultSchema)) as CallToolResult;
    // Task-based (experimental) results carry toolResult, not content; the
    // bridge only forwards plain call results.
    if (!("content" in result)) {
      throw new Error(`MCP server returned a task-based result for "${toolName}" (not supported)`);
    }
    return {
      content: result.content.map((block) =>
        block.type === "text"
          ? { type: "text" as const, text: block.text }
          : { type: "text" as const, text: JSON.stringify(block) },
      ),
    };
  } finally {
    await client.close();
  }
}

/**
 * Shells out to the preinstalled CLI (tools image). Fixed args from the
 * manifest come first, then the call's params as `--name value` flags
 * (`--name` alone for boolean true). Exit code 0 -> stdout as the result;
 * any other exit -> a tool error with stderr.
 *
 * Credential boundary (issue #58): the child env is the parent env minus
 * credential-named variables, plus the manifest's (validated
 * credential-free) `env` delta — CLIs never receive credentials via env.
 * Auth happens at the iron-proxy boundary: HTTPS_PROXY points at iron-proxy
 * (egress allowlist, src/egress), which injects the credential for the
 * allowlisted domain per request. Bun's `env` option REPLACES the
 * environment, so the merge must carry PATH and friends explicitly.
 */
async function callCliTool(
  binding: CliBinding,
  toolName: string,
  params: Record<string, unknown>,
): Promise<AgentToolResult> {
  const flagArgs: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === "boolean") {
      if (value) flagArgs.push(`--${name}`);
    } else {
      flagArgs.push(`--${name}`, String(value));
    }
  }
  const proc = Bun.spawnSync({
    cmd: [binding.command, ...(binding.args ?? []), ...flagArgs],
    env: { ...credentialSafeEnv(), ...binding.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    return toolError(`cli tool "${toolName}" exited ${proc.exitCode}${stderr ? `: ${stderr}` : ""}`);
  }
  return { content: [{ type: "text", text: proc.stdout.toString() }] };
}

/**
 * The parent environment minus credential-named variables
 * ({@link CREDENTIAL_ENV_RE} in manifest.ts). Credentials must never reach
 * a spawned CLI through the environment — the iron-proxy boundary is the
 * only auth path (see {@link callCliTool}).
 */
export function credentialSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !CREDENTIAL_ENV_RE.test(name)) env[name] = value;
  }
  return env;
}
