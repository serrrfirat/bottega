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
 * surface). FAILED discoveries are never cached (issue #167): a rejection
 * evicts itself so a transient failure cannot poison later boots, sessions,
 * or the runtime's lazy path. The #157 transport seam (listProviderTools
 * over the injectable MCP transport) and the #157 conservative tier
 * heuristic (classifyTier / toolsFromMcpList) are REUSED, never duplicated.
 *
 * Fail closed: an unreachable provider or an invalid tools/list THROWS a
 * clear error — never a silent empty toolset. Per-call resolution (the
 * runtime's lazy path, issue #166) surfaces that error to the caller; the
 * BOOT step (resolveExtensionSurfaces) instead SKIPS the failing provider
 * — logged with evidence — and defers it to that per-call path, so the
 * boot never dies because one provider is unreachable or auth-gated.
 *
 * CLI-only extensions have no tools/list protocol: absent tools on a cli
 * manifest is an egress-only extension (empty surface, like `tools: []`).
 */
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { errorMessage } from "../tools/helpers";
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
  if (manifest.kind === "openapi") {
    // OpenAPI tools are always pinned (never discovered), so the cache key
    // is the binding identity: the frozen surface keys by spec URL.
    return `openapi:${manifest.id}:${manifest.openapi.specUrl}`;
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
  mcpTransport?: (binding: McpBinding, authProvider?: OAuthClientProvider) => Transport,
  authProvider?: OAuthClientProvider,
): Promise<ExtensionTool[]> {
  if (manifest.tools !== undefined) return manifest.tools;
  if (manifest.kind !== "mcp") return [];
  const key = surfaceCacheKey(manifest);
  const cached = discoveryCache.get(key);
  if (cached !== undefined) return cached;
  const pending = (async () => {
    const wire = await listProviderTools(manifest.mcp, mcpTransport, { authProvider });
    return toolsFromMcpList(wire, manifest.id).tools;
  })();
  discoveryCache.set(key, pending);
  // Issue #167: never cache a FAILED discovery. A rejected promise evicts
  // itself so a transient failure (proxy/credential timing at boot, a
  // provider down for minutes) never poisons the process-global cache for
  // later boots, sessions, or the runtime's lazy per-call path — the next
  // resolution re-discovers instead of replaying the stale rejection.
  // (Successful surfaces stay cached: one tools/list per key, ever.)
  void pending.catch(() => {
    if (discoveryCache.get(key) === pending) discoveryCache.delete(key);
  });
  return pending;
}

/**
 * Resolves the effective surface of every registered extension ONCE (the
 * server boot step). Pinned manifests resolve without any I/O; tools-less
 * manifests hit the provider's tools/list (in parallel, through the shared
 * cache). Issue #166: a per-provider discovery failure (an unreachable or
 * auth-gated provider) SKIPS that provider at boot — logged with evidence
 * (provider + error) — and defers it to the runtime's lazy per-call path,
 * which fails closed ("tool surface unavailable"). The returned map holds
 * only the surfaces that resolved; providers that resolve keep resolving
 * eagerly (github stays). This function never rejects.
 */
export async function resolveExtensionSurfaces(
  extensions: readonly { manifest: ExtensionManifest }[],
  opts: {
    mcpTransport?: (binding: McpBinding, authProvider?: OAuthClientProvider) => Transport;
    authProvider?: (manifest: ExtensionManifest) => Promise<OAuthClientProvider | undefined>;
    /**
     * Issue #257 connectedness probe: given an extension id, is it
     * CONNECTED (a valid vault credential row exists)? Checked ONLY for a
     * provider whose boot discovery just failed. `true` → the boot emits
     * the LOUD fail-closed warning (a provider the user connected whose
     * tools/list now cannot mint is an incident-in-waiting — every later
     * call fails closed invisibly); `false`/absent → a provider that was
     * never connected keeps the silent skip. Defaults to false (no probe),
     * which is exactly the pre-#257 boot behavior; the composition root
     * (bootstrap-runtime) wires the real store-backed probe.
     */
    isConnected?: (providerId: string) => boolean | Promise<boolean>;
  } = {},
): Promise<ExtensionSurfaces> {
  const entries = await Promise.all(
    extensions.map(async ({ manifest }) => {
      try {
        const authProvider = await opts.authProvider?.(manifest);
        return [manifest.id, await extensionToolSurface(manifest, opts.mcpTransport, authProvider)] as const;
      } catch (err) {
        // Issue #166: a tools-less manifest whose provider is unreachable /
        // auth-gated must never fail the boot. Skip it (the map carries
        // only RESOLVED surfaces) and let the runtime's lazy per-call path
        // fail closed if a call is attempted while the provider is down.
        //
        // Issue #257: distinguish the SILENT skip (never connected — no
        // credential row, e.g. linear/attio) from the LOUD failed-closed
        // warning (CONNECTED — the user authorized it, but tools/list can
        // no longer mint). The connected case must never look "fine" at
        // boot: name the provider + the recovery action.
        let connected = false;
        if (opts.isConnected !== undefined) {
          try {
            connected = (await opts.isConnected(manifest.id)) === true;
          } catch {
            connected = false; // the probe itself failed — degrade to the silent path
          }
        }
        if (connected) {
          console.error(
            `[surface] boot: CONNECTED provider "${manifest.id}" is unreachable or auth-gated — ` +
              `tools/list failed (${errorMessage(err)}); it has a saved credential but can no longer mint. ` +
              `Re-run "connect ${manifest.id}" (or revoke/refresh its credential) — ` +
              `every call to it stays fail-closed until then.`,
          );
        } else {
          console.error(
            `[surface] boot: skipping "${manifest.id}" — tools/list failed (${errorMessage(err)}); ` +
              "the runtime resolves it lazily per call and fails closed if the provider is still unreachable",
          );
        }
        return null;
      }
    }),
  );
  const map = new Map<string, readonly ExtensionTool[]>();
  for (const entry of entries) {
    if (entry !== null) map.set(entry[0], entry[1]);
  }
  return map;
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
  mcpTransport?: (binding: McpBinding, authProvider?: OAuthClientProvider) => Transport,
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
 * Refreshes the surfaces of extensions MISSING from a current map (issue
 * #167): the session toolset resolves lazily so a provider whose discovery
 * failed at boot (issue #166 — skipped, not fatal) is re-attempted when a
 * session is created, and the moment it resolves the FULL surface lands —
 * never a partial stale subset. Resolved extensions pass through untouched
 * (their cached surfaces are authoritative); only absent tools-less mcp
 * manifests are re-resolved, and failures are never cached, so the next
 * refresh re-attempts. Returns a NEW merged map (the input is unchanged).
 */
export async function refreshMissingExtensionSurfaces(
  extensions: readonly { manifest: ExtensionManifest }[],
  current: ExtensionSurfaces,
  opts: {
    mcpTransport?: (binding: McpBinding, authProvider?: OAuthClientProvider) => Transport;
    authProvider?: (manifest: ExtensionManifest) => Promise<OAuthClientProvider | undefined>;
  } = {},
): Promise<ExtensionSurfaces> {
  const missing = extensions.filter(
    ({ manifest }) => !current.has(manifest.id) && manifest.tools === undefined && manifest.kind === "mcp",
  );
  if (missing.length === 0) return current;
  const refreshed = await resolveExtensionSurfaces(missing, opts);
  if (refreshed.size === 0) return current;
  const merged = new Map(current);
  for (const [id, surface] of refreshed) merged.set(id, surface);
  return merged;
}

/**
 * Test seam: clears the discovery cache so hermetic tests never observe a
 * stale surface from an earlier fixture (the cache is keyed by manifest id
 * + binding, not by the injected transport).
 */
export function resetToolSurfaceCache(): void {
  discoveryCache.clear();
}
