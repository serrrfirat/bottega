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
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { errorMessage } from "../tools/helpers";
import { EXTENSION_ID_RE, isRecord, type ExtensionTool, type ExtensionToolParam, type ExtensionToolTier, type McpBinding } from "./manifest";
import { defaultMcpTransport } from "./runtime";

/**
 * The wire shape of one MCP tool as returned by tools/list (structural —
 * defensively permissive where servers misbehave; the SDK's ListToolsResult
 * validation runs on the wire before we see it).
 */
export interface ProviderTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
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
const READ_VERBS: Record<string, true> = {
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
};

/** Clearly destructive verbs (irreversible or large blast radius → exec). */
const DESTRUCTIVE_VERBS: Record<string, true> = {
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
};

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
  if (DESTRUCTIVE_VERBS[firstToken] === true) return "exec";
  if (READ_VERBS[firstToken] === true) return "read";
  return "write";
}

/**
 * JSON Schema (MCP inputSchema) → manifest params. `string`/`number`/
 * `integer`/`boolean` map directly; every other JSON schema type (array,
 * object, null, enum, unknown) maps to `string` — the agent passes the
 * JSON-serialized value, and the human reviewer can tighten the draft. A
 * param absent from the schema's `required` list is explicitly optional
 * (the manifest defaults to required).
 */
export function paramsFromInputSchema(schema: unknown): ExtensionToolParam[] {
  if (!isRecord(schema) || !isRecord(schema["properties"])) return [];
  const requiredNames = new Set(
    Array.isArray(schema["required"])
      ? (schema["required"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  const params: ExtensionToolParam[] = [];
  for (const [name, raw] of Object.entries(schema["properties"])) {
    if (!isRecord(raw)) continue;
    const jsonType = raw["type"];
    const type: ExtensionToolParam["type"] =
      jsonType === "string"
        ? "string"
        : jsonType === "number" || jsonType === "integer"
          ? "number"
          : jsonType === "boolean"
            ? "boolean"
            : "string";
    const description =
      typeof raw["description"] === "string" && raw["description"].trim() !== ""
        ? raw["description"].trim()
        : undefined;
    params.push({
      name,
      type,
      ...(description !== undefined ? { description } : {}),
      ...(requiredNames.has(name) ? {} : { required: false }),
    });
  }
  return params;
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
    const wireName = typeof wire.name === "string" ? wire.name : "";
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
      typeof wire.description === "string" && wire.description.trim() !== ""
        ? wire.description.trim()
        : `${wireName} (no description from the MCP server — confirm with the vendor docs)`;
    tools.push({
      name: `${extensionId}.${wireName}`,
      providerName: wireName,
      tier: classifyTier(wireName, wire.annotations),
      description,
      params: paramsFromInputSchema(wire.inputSchema),
    });
  }
  return { tools, skipped };
}

/** Page cap for tools/list pagination — beyond this, refuse to guess. */
const MAX_TOOLS_LIST_PAGES = 10;

/**
 * Calls the provider's MCP server through the transport seam and returns
 * every tool (following nextCursor pagination). Fail closed: an
 * unreachable provider, a malformed tools/list, or runaway pagination
 * throws a clear error — no tools are ever fabricated.
 */
export async function listProviderTools(
  binding: McpBinding,
  mcpTransport: (binding: McpBinding) => Transport = defaultMcpTransport,
): Promise<ProviderTool[]> {
  const client = new Client({ name: "bottega-extensions", version: "1.0.0" });
  try {
    await client.connect(mcpTransport(binding));
    const tools: ProviderTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOLS_LIST_PAGES; page++) {
      // The SDK validates every response against ListToolsResultSchema
      // before resolving; a malformed response throws here.
      const result = await client.listTools(cursor === undefined ? undefined : { cursor });
      tools.push(...result.tools);
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
