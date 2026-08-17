/**
 * Shared composition-root wiring (issue #172, item 2 of the #153
 * structural-consolidation epic): ONE construction site for the runtime
 * chain every root boots — store → audit → org policy → extension registry
 * → effective tool surfaces → extension runtime (policy gate → credential
 * ladder → egress boundary → audit) → memory provider.
 *
 * The three composition roots (src/server/index.ts, src/executor.ts,
 * src/mcp/server.ts) hand-assembled this chain in parallel and silently
 * diverged twice:
 *   - the MCP root hardwired createSqliteMemoryProvider, so a mem0
 *     deployment got two disjoint memory pools depending on which surface
 *     saved a memory;
 *   - the MCP and executor roots built their extension boundary without
 *     the broker secret resolver, so the whole ACP/extension path failed
 *     at call time with the unwired-default error instead of the
 *     resolver's own.
 *
 * bootstrapRuntime is the single source: every root resolves the SAME
 * memory backend given the same settings (memory_backend.base_url set →
 * mem0 in ALL roots), every root's registry reads the same snapshots, and
 * every root's boundary carries the broker secret resolver — those are the
 * #172 parity invariants, regression-tested by
 * src/server/composition-root-parity.test.ts. What legitimately varies
 * between roots is parameterized:
 *   - router: the ask-human router for the extension runtime (Slack-backed
 *     on the server, DenyRouter in the headless executor/MCP contexts). A
 *     supplier is accepted because the server's Slack router is
 *     constructed mid-boot (the adapter precedes it) and the runtime reads
 *     the router per call.
 *   - boundary: proxy-control / secrets-dir overrides; the broker secret
 *     resolver is ALWAYS wired here, never a parameter.
 *   - tool subset: each root builds its own tool definitions from the
 *     returned pieces (server session toolset, executor worker toolset,
 *     MCP advertised surface) — that assembly lives in the roots, not
 *     here.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createStore, type Store } from "../store/db";
import { createAudit, type AuditModule } from "../policy/audit";
import type { ApprovalRouter } from "../policy/approval-router";
import { loadOrgPolicy, type PolicyConfig } from "../policy/config";
import {
  brokerSecretResolverFromEnv,
  createSecretFileBoundary,
  proxyBoundaryControlFromEnv,
  type CredentialBoundary,
  type SecretFileBoundaryOpts,
} from "../extensions/boundary";
import { createExtensionRegistry, type ExtensionRegistry } from "../extensions/registry";
import { createExtensionRuntime, type ExtensionRuntime } from "../extensions/runtime";
import { resolveExtensionSurfaces, type ExtensionSurfaces } from "../extensions/surface";
import type { McpBinding } from "../extensions/manifest";
import { resolveMemoryProvider, type ResolvedMemoryProvider } from "./memory-provider";

export interface BootstrapRuntimeDeps {
  /**
   * Ask-human router for the extension runtime's policy gate. Plain object
   * everywhere except the server, whose Slack-backed router is constructed
   * mid-boot (after the adapter, which precedes the shared chain): a
   * supplier defers the read to call time, which the runtime already does
   * (the router is consulted per ask-human request, never at construction).
   */
  router: ApprovalRouter | (() => ApprovalRouter);
  /**
   * Egress-boundary overrides (proxy control + secrets dir). The broker
   * secret resolver is ALWAYS wired by bootstrapRuntime — a root can never
   * opt out of it, which is the #172 boundary parity invariant.
   */
  boundary?: SecretFileBoundaryOpts;
  /** Extension snapshots dir; defaults to BOTTEGA_EXTENSIONS_DIR or "config/extensions". */
  extensionsDir?: string;
  /** Org floor config dir; defaults to BOTTEGA_CONFIG_DIR or the repo root (loadOrgConfig's own default). */
  configDir?: string;
  /** DB path; defaults to "data/bottega.db". */
  dbPath?: string;
  /** MCP transport seam for tools-less manifest discovery (test seam; also threaded into the runtime). */
  mcpTransport?: (binding: McpBinding) => Transport;
}

/** The shared chain every composition root boots (issue #172). */
export interface BootstrapRuntime {
  store: Store;
  audit: AuditModule;
  orgPolicy: PolicyConfig;
  registry: ExtensionRegistry;
  runtime: ExtensionRuntime;
  memoryProvider: ResolvedMemoryProvider;
  /** Effective tool surfaces resolved at boot (issue #166: failing providers are skipped, not fatal). */
  surfaces: ExtensionSurfaces;
  /** The credential boundary wired into the runtime — always carries the broker secret resolver (#172). */
  boundary: CredentialBoundary;
}

/**
 * Builds the shared composition chain. Every root calls this; the returned
 * store's database handle is the one the memory provider shares (one
 * memory pool per process, the #172 regression).
 */
export async function bootstrapRuntime(deps: BootstrapRuntimeDeps): Promise<BootstrapRuntime> {
  const store = createStore(deps.dbPath);
  const audit = createAudit(store);
  const orgPolicy = loadOrgPolicy(store, deps.configDir);
  const registry = createExtensionRegistry(
    deps.extensionsDir ?? process.env.BOTTEGA_EXTENSIONS_DIR ?? "config/extensions",
  );
  // Effective tool surfaces (issues #158/#166), resolved once: pinned
  // manifest tools, or the provider's tools/list for tools-less manifests
  // (a per-provider failure is skipped — the runtime's lazy per-call path
  // fails closed instead of the boot dying).
  const surfaces = await resolveExtensionSurfaces(
    registry.list(),
    deps.mcpTransport !== undefined ? { mcpTransport: deps.mcpTransport } : {},
  );
  // Credential boundary (issues #53/#123): the resolver is ALWAYS the
  // broker secret resolver (#54 wiring, shipped with #143) — the #172
  // parity invariant the MCP and executor roots historically violated.
  // Proxy control + secrets dir come from the environment / overrides.
  const boundary = createSecretFileBoundary({
    ...proxyBoundaryControlFromEnv(),
    resolveSecret: brokerSecretResolverFromEnv(),
    ...deps.boundary,
  });
  // The runtime's router is a per-call dependency: resolve the supplier at
  // construction when a plain object was given, otherwise forward per call
  // so the server's mid-boot router assignment is observed live.
  const resolveRouter = (): ApprovalRouter =>
    typeof deps.router === "function" ? deps.router() : deps.router;
  const runtime = createExtensionRuntime({
    registry,
    store,
    audit,
    orgPolicy,
    router: { request: (request) => resolveRouter().request(request) },
    boundary,
    surfaces,
    ...(deps.mcpTransport !== undefined ? { mcpTransport: deps.mcpTransport } : {}),
  });
  // One memory provider per process (issues #43/#67/#135): explicit
  // memory_backend.base_url settings select mem0 first, MEM0_BASE_URL is
  // the deployment fallback, unset keeps SQLite on the store database —
  // identical in every root (the MCP root's historical SQLite hardwire is
  // the #172 divergence this replaces).
  const memoryProvider = resolveMemoryProvider(store.getOrgSettings(), store.getDb());
  return { store, audit, orgPolicy, registry, runtime, memoryProvider, surfaces, boundary };
}
