/**
 * Manifest tool generator (issue #157): discovers a provider's tool surface
 * via the MCP `tools/list` protocol call and GENERATES the manifest tools —
 * the policy surface is derived from the provider's own spec, never
 * hand-authored. Hand-authoring per-tool manifests doesn't scale as
 * providers add tools or we onboard more providers.
 *
 * The manifest is the POLICY surface (tier + param schema + description per
 * tool), so generation is deliberately CONSERVATIVE:
 *
 * - `providerName` = the provider's WIRE name (issue #148) — hosted
 *   official servers reject bottega's namespaced names, the bridge forwards
 *   the wire name on every call. The manifest `name` is namespaced
 *   (`<extensionId>.<wireName>`), matching the hand-authored convention
 *   (e.g. github.search_issues);
 * - `params` come from the server's inputSchema (JSON schema types →
 *   manifest string/number/boolean; array/object/unknown map to string, the
 *   agent JSON-serializes; `required` from the schema's required list);
 * - tier classification is a REVIEW task, not a guess-the-gate task: the
 *   server's readOnlyHint/destructiveHint win, then a name-verb heuristic
 *   (confident read verbs → read, clearly destructive verbs → exec), and
 *   EVERYTHING ELSE → write (approval). Generated drafts keep
 *   source.reviewed=false — the human confirms tiers before pin.
 *
 * Fail closed: an unreachable provider or an invalid tools/list throws (no
 * tools are ever fabricated). A tool whose wire name cannot be represented
 * in the manifest identifier charset, or that omits the MCP-required
 * inputSchema, is SKIPPED and surfaced in `skipped` — never silently
 * dropped (mirrors the catalog listing's #117 diagnostics).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "@oh-my-pi/pi-coding-agent";
import { errorMessage } from "../tools/helpers";
import { EXTENSION_ID_RE, isRecord, type ExtensionTool, type ExtensionToolParam, type ExtensionToolTier, type JsonObject, type JsonValue, type McpBinding } from "./manifest";
import { defaultMcpTransport } from "./runtime";

/**
 * The wire shape of one MCP tool as returned by tools/list (structural —
 * defensively permissive where servers misbehave; the SDK's ListToolsResult
 * validation runs on the wire before we see it).
 */
export interface ProviderTool {
  name: string;
  description?: string;
  inputSchema?: JsonValue;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** Result of a tools/list generation: representable tools plus surfaced skips. */
export interface ToolsListGeneration {
  tools: ExtensionTool[];
  /** Tools that could not be represented — surfaced, never silently dropped. */
  skipped: Array<{ tool: string; reason: string }>;
}

/** Result of a manifest refresh: kept tools plus newly discovered ones. */
export interface ToolRefresh {
  tools: ExtensionTool[];
  /** Newly discovered tools (conservative tiers) — surfaced, never silent. */
  added: ExtensionTool[];
}

/** Confidence-bounded read-only verbs (verb-first tool names). */
const READ_VERBS = {
  get: true,
  list: true,
  search: true,
  read: true,
  fetch: true,
  find: true,
  query: true,
  browse: true,
  show: true,
  retrieve: true,
  describe: true,
  view: true,
  lookup: true,
  count: true,
  status: true,
  info: true,
  ping: true,
  exists: true,
  export: true,
  download: true,
} as const satisfies Record<string, true>;

/** Clearly destructive verbs (irreversible or large blast radius → exec). */
const DESTRUCTIVE_VERBS = {
  delete: true,
  remove: true,
  drop: true,
  destroy: true,
  purge: true,
  truncate: true,
  wipe: true,
  erase: true,
  clear: true,
  revoke: true,
  terminate: true,
  kill: true,
  shutdown: true,
  suspend: true,
  cancel: true,
  reset: true,
} as const satisfies Record<string, true>;

/**
 * Conservative default tier: the server's own hints win, then a
 * confidence-bounded name-verb heuristic, and everything unknown or
 * mutating lands on `write` (approval). `exec` is reserved for clearly
 * destructive tools — an unsafe guess on the exec side is the safe
 * direction, an unsafe guess on the read side is not.
 */
export function classifyTier(
  toolName: string,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean },
): ExtensionToolTier {
  // Contradictory hints resolve to the SAFER tier: destructive wins.
  if (annotations?.destructiveHint === true) return "exec";
  if (annotations?.readOnlyHint === true) return "read";
  const firstToken = toolName.toLowerCase().split(/[._-]/)[0] ?? "";
  if (Object.hasOwn(DESTRUCTIVE_VERBS, firstToken)) return "exec";
  if (Object.hasOwn(READ_VERBS, firstToken)) return "read";
  return "write";
}

/**
 * JSON Schema (MCP inputSchema) → manifest params. `string`/`number`/
 * `integer`/`boolean` map directly; `array`/`object` map to `string` while
 * PRESERVING the structured type on `jsonType` so the runtime can restore
 * the native array/object before the wire call (issue #248 — the agent
 * passes the JSON-serialized value); null/enum/unknown map to `string`.
 * A param absent from the schema's `required` list is explicitly optional
 * (the manifest defaults to required).
 */
export function paramsFromInputSchema(schema: JsonObject): ExtensionToolParam[] {
  if (!isRecord(schema["properties"])) return [];
  const requiredNames = new Set(
    Array.isArray(schema["required"])
      ? schema["required"].filter((entry): entry is string => z.string().safeParse(entry).success)
      : [],
  );
  const params: ExtensionToolParam[] = [];
  for (const [name, raw] of Object.entries(schema["properties"])) {
    if (!isRecord(raw)) continue;
    const schemaType = raw["type"];
    const type: ExtensionToolParam["type"] =
      schemaType === "string"
        ? "string"
        : schemaType === "number" || schemaType === "integer"
          ? "number"
          : schemaType === "boolean"
            ? "boolean"
            : "string";
    const jsonType: ExtensionToolParam["jsonType"] =
      schemaType === "array" ? "array" : schemaType === "object" ? "object" : undefined;
    const parsedDescription = z.string().min(1).safeParse(raw["description"]);
    const param: ExtensionToolParam = {
      name,
      type,
      ...(jsonType !== undefined ? { jsonType } : {}),
    };
    if (parsedDescription.success && parsedDescription.data.trim() !== "") {
      param.description = parsedDescription.data.trim();
    }
    if (!requiredNames.has(name)) param.required = false;
    params.push(param);
  }
  return params;
}

/**
 * Narrow an MCP inputSchema (already SDK-validated on the wire) to the
 * record contract the param generator reads. A non-record schema yields an
 * empty surface, so the tool is still surfaced with no params rather than
 * dropped.
 */
function inputSchemaSurface(inputSchema: JsonValue): JsonObject {
  return isRecord(inputSchema) ? inputSchema : {};
}

/**
 * Converts a tools/list response into manifest tools (namespaced names,
 * wire providerName, conservative tiers). Tools that cannot be represented
 * are skipped and surfaced in `skipped`.
 */
export function toolsFromMcpList(list: readonly ProviderTool[], extensionId: string): ToolsListGeneration {
  const tools: ExtensionTool[] = [];
  const skipped: ToolsListGeneration["skipped"] = [];
  for (const wire of list) {
    // wire.name is a declared string (the SDK validates it on the wire);
    // the empty-string case still routes to the "<unnamed>" skip below.
    const wireName = wire.name;
    if (wireName.trim() === "" || !EXTENSION_ID_RE.test(wireName)) {
      skipped.push({
        tool: wireName.trim() === "" ? "<unnamed>" : wireName,
        reason: `wire name "${wireName.trim() === "" ? "<unnamed>" : wireName}" is not a valid manifest identifier ` +
          "(a-z0-9, dots/underscores/dashes) — hand-author this tool if the provider needs it",
      });
      continue;
    }
    if (wire.inputSchema === undefined) {
      skipped.push({
        tool: wireName,
        reason: "no inputSchema — the MCP spec requires one; refusing to guess the params",
      });
      continue;
    }
    const description =
      wire.description !== undefined && wire.description.trim() !== ""
        ? wire.description.trim()
        : `${wireName} (no description from the MCP server — confirm with the vendor docs)`;
    // SAFETY: the SDK validates inputSchema against ListToolsResultSchema on
    // the wire; a malformed schema fails the whole list, so a present value
    // is a JSON object (absent → the generator emits no params).
    tools.push({
      name: `${extensionId}.${wireName}`,
      providerName: wireName,
      tier: classifyTier(wireName, wire.annotations),
      description,
      params: paramsFromInputSchema(inputSchemaSurface(wire.inputSchema as JsonValue)),
    });
  }
  return { tools, skipped };
}

/** Page cap for tools/list pagination — beyond this, refuse to guess. */
const MAX_TOOLS_LIST_PAGES = 10;

/**
 * Wall-clock bound on ONE discovery request (initialize or tools/list).
 * Issue #205: without a bound the SDK's default 60s request timeout lets a
 * dead stdio server hang every boot, every session cold-start, and every
 * lazy per-call resolution — turns died mid-thinking. A local stdio server
 * initializes in milliseconds; 10s is generous for a hosted endpoint.
 */
export const MCP_DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Calls the provider's MCP server through the transport seam and returns
 * every tool (following nextCursor pagination). Fail closed: an
 * unreachable provider, a malformed tools/list, or runaway pagination
 * throws a clear error — no tools are ever fabricated. Every request is
 * bounded by {@link MCP_DISCOVERY_TIMEOUT_MS} (overridable for hermetic
 * tests) so a dead server fails fast instead of hanging the caller.
 */
export async function listProviderTools(
  binding: McpBinding,
  mcpTransport: (binding: McpBinding) => Transport = defaultMcpTransport,
  opts: { timeoutMs?: number } = {},
): Promise<ProviderTool[]> {
  const timeoutMs = opts.timeoutMs ?? MCP_DISCOVERY_TIMEOUT_MS;
  const client = new Client({ name: "bottega-extensions", version: "1.0.0" });
  try {
    const transport = mcpTransport(binding);
    // Contain a misbehaving stdio server's stderr (issue #205): the boot log
    // must never carry a child's exec noise, and an unbounded pipe would
    // stall the child on backpressure. Drain up to a bounded prefix for
    // diagnostics, then detach.
    drainBoundedStderr(transport);
    await client.connect(transport, { timeout: timeoutMs });
    const tools: ProviderTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOLS_LIST_PAGES; page++) {
      // The SDK validates every response against ListToolsResultSchema
      // before resolving; a malformed response throws here.
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: timeoutMs });
      tools.push(
        ...result.tools.map((tool) => ({
          ...tool,
          // The SDK validated the response against ListToolsResultSchema
          // (JSON by the MCP wire contract); the round-trip yields the
          // JSON domain ProviderTool.inputSchema declares.
          inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)),
        })),
      );
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    if (cursor !== undefined) {
      throw new Error(`tools/list paginated past ${MAX_TOOLS_LIST_PAGES} pages — refusing to guess the rest`);
    }
    return tools;
  } catch (err) {
    const target = binding.transport === "streamable-http" ? binding.serverUrl : binding.command;
    throw new Error(`tools/list failed for ${target}: ${errorMessage(err)}`);
  } finally {
    await client.close();
  }
}

/** How much of a stdio server's stderr to surface as diagnostics. */
const STDIO_STDERR_DIAGNOSTIC_BYTES = 2048;

/**
 * Reads (and bounds) a stdio transport's stderr so a misbehaving child's
 * noise never floods the server log and backpressure never deadlocks the
 * child. The first {@link STDIO_STDERR_DIAGNOSTIC_BYTES} are surfaced as a
 * single bounded diagnostic line; the rest is dropped. Non-stdio transports
 * expose no stderr stream and are untouched.
 */
function drainBoundedStderr(transport: Transport): void {
  if (!(transport instanceof StdioClientTransport)) return;
  const stderr = transport.stderr;
  if (stderr === null) return;
  void (async () => {
    let bytes = 0;
    let prefix = "";
    try {
      // SAFETY: StdioClientTransport.stderr is a Node Readable when stderr
      // is "pipe" (the SDK's ctor builds a PassThrough) — Readable is async
      // iterable at runtime even though its declared `Stream` type does not
      // carry the Symbol.asyncIterator typing.
      for await (const chunk of stderr as NodeJS.ReadableStream) {
        // Stream chunks are string or Buffer; both decode to text via toString.
        const text = chunk.toString();
        if (bytes < STDIO_STDERR_DIAGNOSTIC_BYTES) {
          prefix += text;
          bytes += text.length;
          if (bytes >= STDIO_STDERR_DIAGNOSTIC_BYTES) break;
        }
      }
    } catch {
      // The stream closed or errored with the child; nothing to log.
    }
    const trimmed = prefix.trim();
    if (trimmed.length > 0) {
      console.error(`[extensions] stdio server stderr (bounded): ${trimmed.slice(0, STDIO_STDERR_DIAGNOSTIC_BYTES)}`);
    }
  })();
}

/**
 * Discovers and generates the manifest tools for a provider binding.
 * {@link ToolsListGeneration.skipped} surfaces unrepresentable tools; the
 * generated `tools` carry conservative tiers and are NOT reviewed (the
 * caller keeps source.reviewed=false until the human confirms tiers).
 */
export async function generateManifestTools(input: {
  binding: McpBinding;
  extensionId: string;
  mcpTransport?: (binding: McpBinding) => Transport;
}): Promise<ToolsListGeneration> {
  const wireTools = await listProviderTools(input.binding, input.mcpTransport);
  return toolsFromMcpList(wireTools, input.extensionId);
}

/**
 * Re-discovery merge (issue #157): refresh a pinned manifest against a
 * freshly generated surface. Existing tools keep their REVIEWED tiers
 * (never silently reclassified); NEW tools are added with their
 * conservative tiers and returned in `added` so the caller can surface them
 * — new tools always land for review, never silently.
 */
export function refreshManifestTools(
  existing: readonly ExtensionTool[],
  generated: readonly ExtensionTool[],
): ToolRefresh {
  const byName = new Map(existing.map((tool) => [tool.name, tool]));
  const added: ExtensionTool[] = [];
  for (const tool of generated) {
    if (!byName.has(tool.name)) {
      byName.set(tool.name, tool);
      added.push(tool);
    }
  }
  return { tools: [...byName.values()], added };
}
