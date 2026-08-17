/**
 * Effective tool surface resolution (issue #158): a manifest WITHOUT tools
 * is valid — the runtime resolves its tool surface from the provider's
 * tools/list at boot, so the agent sees the provider's REAL surface (e.g.
 * all 44 hosted GitHub tools), never a hand-authored subset and never a
 * stale pinned list.
 *
 * A manifest WITH tools keeps the pinned-reviewed path: the pinned surface
 * wins and no discovery happens (backward compatible). `tools: []` is a
 * deliberate pinned "no tools" surface (egress-only extension) — also no
 * discovery.
 *
 * Discovery is cached per manifest id + binding (the binding is not
 * discoverable, so it keys the cache — a re-pinned binding gets a fresh
 * surface). The #157 transport seam (listProviderTools over the injectable
 * MCP transport) and the #157 conservative tier heuristic (classifyTier /
 * toolsFromMcpList) are REUSED, never duplicated.
 *
 * Fail closed: an unreachable provider or an invalid tools/list THROWS a
 * clear error — never a silent empty toolset. Callers surface that error
 * (boot failure for the pre-resolution step, a tool error result for the
 * lazy runtime path); the agent never sees zero tools as if the provider
 * had none.
 *
 * CLI-only extensions have no tools/list protocol: absent tools on a cli
 * manifest is an egress-only extension (empty surface, like `tools: []`).
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { listProviderTools, toolsFromMcpList } from "./generate-tools";
import type { ExtensionManifest, ExtensionTool, McpBinding } from "./manifest";
import type { ExtensionRegistry } from "./registry";

/** The effective tool surface of every extension, keyed by extension id. */
export type ExtensionSurfaces = ReadonlyMap<string, readonly ExtensionTool[]>;

/** Cache key: kind + manifest id + binding identity (serverUrl or command). */
function surfaceCacheKey(manifest: ExtensionManifest): string {
  if (manifest.kind === "mcp") {
    const binding = manifest.mcp.transport === "streamable-http" ? manifest.mcp.serverUrl : manifest.mcp.command;
    return `mcp:${manifest.id}:${binding}`;
  }
  return `cli:${manifest.id}:${manifest.cli.command}`;
}

const discoveryCache = new Map<string, Promise<ExtensionTool[]>>();

/**
 * The effective tool surface of one extension: pinned manifest tools when
 * present (the reviewed path wins — no discovery), else the provider's
 * tools/list discovered with conservative tiers (cached per manifest id +
 * binding). Throws fail-closed on an unreachable provider or an invalid
 * tools/list — never a silent empty set. `mcpTransport` defaults to the
 * production transport seam (src/extensions/runtime.ts).
 */
export async function extensionToolSurface(
  manifest: ExtensionManifest,
  mcpTransport?: (binding: McpBinding) => Transport,
): Promise<ExtensionTool[]> {
  if (manifest.tools !== undefined) return manifest.tools;
  if (manifest.kind !== "mcp") return [];
  const key = surfaceCacheKey(manifest);
  const cached = discoveryCache.get(key);
  if (cached !== undefined) return cached;
  const pending = (async () => {
    const wire = await listProviderTools(manifest.mcp, mcpTransport);
    return toolsFromMcpList(wire, manifest.id).tools;
  })();
  discoveryCache.set(key, pending);
  return pending;
}

/**
 * Resolves the effective surface of every registered extension ONCE (the
 * server boot step). Pinned manifests resolve without any I/O; tools-less
 * manifests hit the provider's tools/list (in parallel, through the shared
 * cache). Fail closed: any unreachable/invalid provider throws — the boot
 * surfaces the clear error rather than silently shipping an empty toolset.
 */
export async function resolveExtensionSurfaces(
  extensions: readonly { manifest: ExtensionManifest }[],
  opts: { mcpTransport?: (binding: McpBinding) => Transport } = {},
): Promise<ExtensionSurfaces> {
  const entries = await Promise.all(
    extensions.map(async ({ manifest }) => [manifest.id, await extensionToolSurface(manifest, opts.mcpTransport)] as const),
  );
  return new Map(entries);
}

/**
 * The extension id that owns a tool name across the EFFECTIVE surface
 * (pinned tools first — the sync fast path — then discovered surfaces).
 * Used by surfaces that resolve extension tools by name (the MCP server's
 * callTool path, issue #61). Returns undefined for unknown tools.
 */
export async function toolOwnerExtensionId(
  registry: Pick<ExtensionRegistry, "list">,
  toolName: string,
  mcpTransport?: (binding: McpBinding) => Transport,
): Promise<string | undefined> {
  const pinned = registry.list().find(({ manifest }) =>
    (manifest.tools ?? []).some((tool) => tool.name === toolName),
  );
  if (pinned !== undefined) return pinned.manifest.id;
  for (const { manifest } of registry.list()) {
    if (manifest.tools !== undefined) continue;
    const surface = await extensionToolSurface(manifest, mcpTransport);
    if (surface.some((tool) => tool.name === toolName)) return manifest.id;
  }
  return undefined;
}

/**
 * Test seam: clears the discovery cache so hermetic tests never observe a
 * stale surface from an earlier fixture (the cache is keyed by manifest id
 * + binding, not by the injected transport).
 */
export function resetToolSurfaceCache(): void {
  discoveryCache.clear();
}
