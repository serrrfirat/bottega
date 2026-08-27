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
 *     the broker secret resolver, so the whole extension path failed at
 *     call time with the unwired-default error instead of the resolver's
 *     own.
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
 *   - boundary: proxy-control / secrets-dir overrides; the secret resolver
 *     is ALWAYS wired here from the deployment's configured backend
 *     (issue #190: omp-broker default, 1password-connect from the settings
 *     blob) — never a parameter a root can omit.
 *   - tool subset: each root builds its own tool definitions from the
 *     returned pieces (server session toolset, executor worker toolset,
 *     MCP advertised surface) — that assembly lives in the roots, not
 *     here.
 */
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createStore, type Store } from "../store/db";
import type { OrgSettings } from "../store/org-settings";
import { createAudit, type AuditModule } from "../policy/audit";
import type { ApprovalRouter } from "../policy/approval-router";
import { loadOrgPolicy, type PolicyConfig } from "../policy/config";
import {
  createSecretFileBoundary,
  proxyBoundaryControlFromEnv,
  secretResolverFromSettings,
  type AuthorizationContext,
  type CredentialBoundary,
  type SecretFileBoundaryOpts,
} from "../extensions/boundary";
import { createExtensionRegistry, type ExtensionRegistry } from "../extensions/registry";
import { mergeRuntimeRegistry } from "../extensions/runtime-registry";
import { createExtensionRuntime, type ExtensionRuntime } from "../extensions/runtime";
import { createOpenApiEgressSeam } from "../extensions/openapi-egress";
import { MCP_DISCOVERY_TIMEOUT_MS } from "../extensions/generate-tools";
import {
  resolveExtensionSurfaces,
  type ExtensionSurfaces,
  type SurfaceAuthorization,
} from "../extensions/surface";
import { createRuntimeMcpOAuthProvider, type McpOAuthTokenStore } from "../extensions/mcp-oauth";
import type { ExtensionManifest, McpBinding } from "../extensions/manifest";
import type { ToolStepSink } from "./services/slack-turn-presenter";
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
   * Thinking-step sink (issue #193): the extension runtime's own policy
   * gate emits a step per gated extension tool call through this. The
   * server wires it to the SpaceService's step router (late-bound — the
   * service is constructed after the shared chain); headless roots omit it
   * and no steps are emitted. Mirrors the driver gate's onToolStep.
   */
  onToolStep?: ToolStepSink;
  /**
   * Egress-boundary overrides (proxy control + secrets dir). The secret
   * resolver is ALWAYS wired by bootstrapRuntime from the deployment's
   * configured backend (issue #190) — a root can never opt out of it,
   * which is the #172 boundary parity invariant. Pass `resolver` (or the
   * legacy `resolveSecret`) here to override the configured default.
   */
  boundary?: SecretFileBoundaryOpts;
  /** Extension snapshots dir; defaults to BOTTEGA_EXTENSIONS_DIR or "config/extensions". */
  extensionsDir?: string;
  /** Org floor config dir; defaults to BOTTEGA_CONFIG_DIR or the repo root (loadOrgConfig's own default). */
  configDir?: string;
  /** DB path; defaults to "data/bottega.db". */
  dbPath?: string;
  /**
   * Sandbox-child isolation seam (issue #101): when set, the supervisor's
   * job-scoped store is injected instead of opening `dbPath` — the job
   * container never touches the shared bottega.db bytes. `dbPath` must be
   * omitted when `store` is supplied (the container opens no SQLite file).
   */
  store?: Store;
  /**
   * Injected, already-scoped org settings for the sandbox-child boot
   * (issue #101): the supervisor's parsed {@link OrgSettings} blob, so the
   * child's `loadOrgPolicy`/secret-resolver never need a synchronous store
   * read over the async RPC socket. Ignored when `store` is a real store
   * (sync reads work there).
   */
  orgSettings?: OrgSettings | null;
  /** Injected, already-scoped memory provider for the sandbox child (no
   * shared-db memory handle); mutually exclusive with opening the store. */
  memoryProvider?: ResolvedMemoryProvider;
  /**
   * Sandbox-child isolation (#101/#338): when true, the boot SKIPS
   * {@link mergeRuntimeRegistry} (a GLOBAL store write via
   * upsertRuntimeExtension). The job container's store RPC allowlist denies
   * that write, so the child boot must not attempt it — the supervisor's
   * process already holds the merged registry. Only compiled/pinned
   * extensions remain visible in the child (no runtime-registered ones).
   * Defaults false (existing roots keep merging).
   */
  skipRuntimeRegistryMerge?: boolean;
  /** MCP transport seam for tools-less manifest discovery (test seam; also threaded into the runtime). */
  mcpTransport?: (
    binding: McpBinding,
    authProvider?: OAuthClientProvider,
    authorization?: AuthorizationContext,
  ) => Transport;
  /**
   * Vault token store seam for the authenticated tools/list discovery
   * provider (issue #284 test seam, mirroring the runtime's
   * mcpOAuthTokenStore): defaults to the production vault-backed store.
   * The surface auth provider built here loads the persisted vault row's
   * tokens through this store, so a boot-time tools/list for an OAuth MCP
   * sends a real bearer. Tests inject a fake (never a real vault write).
   */
  mcpOAuthTokenStore?: McpOAuthTokenStore;
  /**
   * Issue #257 boot connectedness probe: given an extension id, is it
   * CONNECTED (a valid vault credential row exists)? Used by the surface
   * resolution to decide whether a boot-time discovery failure is the
   * LOUD fail-closed warning (connected provider that can no longer mint)
   * or the silent skip (never connected). Defaults to "≥1 credential row
   * for the provider" via the store — checked only for a provider whose
   * boot discovery just failed, so it costs nothing on the happy path.
   */
  isConnected?: (providerId: string) => boolean | Promise<boolean>;
}

/** The shared chain every composition root boots (issue #172). */
export interface BootstrapRuntime {
  store: Store;
  audit: AuditModule;
  /** Authorization wrapper shared by boot discovery and session refresh. */
  surfaceAuthorization: SurfaceAuthorization;
  orgPolicy: PolicyConfig;
  registry: ExtensionRegistry;
  runtime: ExtensionRuntime;
  memoryProvider: ResolvedMemoryProvider;
  /** Effective tool surfaces resolved at boot (issue #166: failing providers are skipped, not fatal). */
  surfaces: ExtensionSurfaces;
  /** The credential boundary wired into the runtime — always carries the configured secret resolver (#172/#190). */
  boundary: CredentialBoundary;
  /** Auth provider used for authenticated tools/list discovery of hosted OAuth MCPs. */
  surfaceAuthProvider: (manifest: ExtensionManifest) => Promise<OAuthClientProvider | undefined>;
}

/**
 * Builds the shared composition chain. Every root calls this; the returned
 * store's database handle is the one the memory provider shares (one
 * memory pool per process, the #172 regression).
 */
export async function bootstrapRuntime(deps: BootstrapRuntimeDeps): Promise<BootstrapRuntime> {
  const store = deps.store ?? createStore(deps.dbPath);
  const audit = createAudit(store);
  const orgPolicy = loadOrgPolicy(store, deps.configDir, deps.orgSettings);
  const registry = createExtensionRegistry(
    deps.extensionsDir ?? process.env.BOTTEGA_EXTENSIONS_DIR ?? "config/extensions",
  );
  // Issue #233: the runtime extension registry is STORE state — boot merges
  // the pinned seeds + the persisted runtime-registered set into the LIVE
  // registry, so resolve/list surfaces include both. A pinned id wins; a
  // malformed runtime row is a loud skip, never a boot failure (the #205
  // posture). The sandbox child SKIPS this merge: it is a global store write
  // the job container's RPC allowlist must deny (its supervisor process
  // already holds the merged registry), and only the child's isolate sees it.
  if (deps.skipRuntimeRegistryMerge !== true) {
    await mergeRuntimeRegistry(store, registry);
  }
  const surfaceAuthProvider = async (manifest: ExtensionManifest): Promise<OAuthClientProvider | undefined> => {
    if (manifest.kind !== "mcp" || manifest.credentialSchema.type !== "oauth") return undefined;
    const credential = (await store.listExtensionCredentials(manifest.id)).at(-1);
    if (credential === undefined) return undefined;
    return createRuntimeMcpOAuthProvider({ credential, tokenStore: deps.mcpOAuthTokenStore });
  };
  // Credential boundary (issues #53/#123/#190): the resolver is the
  // deployment's configured secrets backend (issue #190) — omp-broker by
  // default (the #54/#143 behavior, byte-identical), 1password-connect
  // when the settings blob's secrets_backend says so. A root can still
  // override via deps.boundary (resolver or resolveSecret); the #172
  // boundary parity invariant is that the DEFAULT carries a real resolver,
  // never the unwired error. Proxy control + secrets dir come from the
  // environment / overrides.
  const boundaryOpts: SecretFileBoundaryOpts = {
    ...proxyBoundaryControlFromEnv(),
    ...deps.boundary,
  };
  if (boundaryOpts.resolver === undefined && boundaryOpts.resolveSecret === undefined) {
    boundaryOpts.resolver = secretResolverFromSettings(deps.orgSettings ?? store.getOrgSettings());
  }
  const boundary = createSecretFileBoundary(boundaryOpts);
  // API-key MCP discovery runs through the same call-scoped boundary as
  // execution. OAuth remains owned by the MCP SDK's auth provider above.
  const surfaceAuthorization: SurfaceAuthorization = async (manifest, invoke) => {
    if (manifest.kind !== "mcp" || manifest.credentialSchema.type !== "api_key") return invoke();
    const credential = (await store.listExtensionCredentials(manifest.id)).at(-1);
    if (credential === undefined) return invoke();
    return boundary.runWithAuthorization(
      {
        credential,
        targets: manifest.credentialTargets,
        callId: `surface:${manifest.id}:tools-list`,
        timeoutMs: MCP_DISCOVERY_TIMEOUT_MS,
      },
      invoke,
    );
  };
  // Effective tool surfaces (issues #158/#166), resolved once: pinned
  // manifest tools, or the provider's tools/list for tools-less manifests
  // (a per-provider failure is skipped — the runtime's lazy per-call path
  // fails closed instead of the boot dying).
  const surfaceOptions: NonNullable<Parameters<typeof resolveExtensionSurfaces>[1]> = {
    authProvider: surfaceAuthProvider,
    authorize: surfaceAuthorization,
    // Issue #257: a boot discovery failure on a provider that HAS a
    // credential row is a loud fail-closed warning, never the silent skip.
    isConnected:
      deps.isConnected ??
      (async (providerId: string) => (await store.listExtensionCredentials(providerId)).length > 0),
  };
  if (deps.mcpTransport !== undefined) surfaceOptions.mcpTransport = deps.mcpTransport;
  const surfaces = await resolveExtensionSurfaces(registry.list(), surfaceOptions);
  // The runtime's router is a per-call dependency: resolve the supplier at
  // construction when a plain object was given, otherwise forward per call
  // so the server's mid-boot router assignment is observed live.
  const resolveRouter = (): ApprovalRouter =>
    "request" in deps.router ? deps.router : deps.router();
  const runtime = createExtensionRuntime({
    registry,
    store,
    audit,
    orgPolicy,
    router: { request: (request) => resolveRouter().request(request) },
    boundary,
    surfaces,
    // OpenAPI egress (issue #345): the REAL static-inject seam, resolving
    // the openapi extension for a host and failing closed until its static
    // credential is provisioned (the compose/proxy env injects the key at
    // egress — the seam never touches the secret).
    openapiEgress: createOpenApiEgressSeam({ registry }),
    ...(deps.mcpTransport !== undefined ? { mcpTransport: deps.mcpTransport } : undefined),
    ...(deps.onToolStep !== undefined ? { onToolStep: deps.onToolStep } : undefined),
  });
  // One memory provider per process (issues #43/#67/#135): explicit
  // memory_backend.base_url settings select mem0 first, MEM0_BASE_URL is
  // the deployment fallback, unset keeps SQLite on the store database —
  // identical in every root (the MCP root's historical SQLite hardwire is
  // the #172 divergence this replaces).
  const memoryProvider =
    deps.memoryProvider ??
    (deps.store !== undefined
      ? (() => {
          throw new Error(
            "bootstrapRuntime: a sandbox child injecting a scoped store must also inject its scoped memoryProvider (no shared-db memory handle)",
          );
        })()
      : resolveMemoryProvider(store.getOrgSettings(), store.getDb()));
  return { store, audit, orgPolicy, registry, runtime, memoryProvider, surfaces, boundary, surfaceAuthProvider, surfaceAuthorization };
}
