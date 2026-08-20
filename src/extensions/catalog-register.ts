/**
 * Catalog registration seam (issue #232 + #233): the deterministic route
 * that lets "connect <X>" work for ANY integrations.sh catalog extension,
 * not just the pinned ones.
 *
 * Before #232, an unregistered extension id failed the connect path with
 * "unknown extension — register it before connecting" and went to the agent
 * loop, which stalled (live evidence: "connect my notion" acked and hung).
 * This seam is the connect capability's fallback, fully deterministic — the
 * MODEL is never the driver:
 *
 *   1. LOOKUP + DRAFT — {@link lookupCatalogExtension}: fetchCatalogEntry
 *      (the fetch-catalog seam, same fail-closed CatalogError; unknown
 *      specs fail loudly with the browse path) + the catalog record's
 *      scaffold + the OFFICIAL hosted MCP endpoint discovery
 *      ({@link discoverCatalogMcp}: the vendor's own `mcp.<domain>` host +
 *      RFC 8414 OAuth metadata — never a guessed endpoint or auth mode) +
 *      the auth classification (OAuth-gated → tools-less manifest, the
 *      #231 notion pattern; api_key otherwise). Read-only: nothing
 *      registers, no side effects, no gate.
 *   2. THE CONNECT'S OWN APPROVAL covers org scope (issue #233): the
 *      register_extension gate is REMOVED from this path. connect.ts gates
 *      an org-scope connect BEFORE the register step (the existing
 *      connect_extension exec gate — the "add a domain" egress step rides
 *      that approval, so a DENIED connect registers nothing); personal
 *      connects are direct. No registration ever happens silently: org
 *      approvals carry the draft facts (vendor, domains, MCP endpoint).
 *   3. REGISTER AT RUNTIME — {@link registerExtensionAtRuntime}: the
 *      approved/authorized draft persists to the STORE-backed runtime
 *      registry (machine state — NO config/extensions file, NO commit),
 *      the egress configs regenerate with the merged runtime set
 *      (byte-pinned for the seed fixtures; the runtime set is injected),
 *      the snapshot HOT-REGISTERS into the live registry (the canary's
 *      extension-pin journey mechanics, issue #197) — new sessions see the
 *      extension immediately — and the proxy reloads. The connect then
 *      continues in the same turn.
 *
 * The egress regeneration stays fail-closed but the OAuth extensions
 * carry no token endpoint on the record (issue #284: the MCP SDK owns
 * OAuth — RFC 8414 discovery at connect/call time; the egress proxy is
 * transport/allowlist only and never mints): a regen failure is LOUD in
 * the result, and the runtime registration still lands (the approved
 * durable change).
 */
import type { AuditModule } from "../policy/audit";
import { errorMessage } from "../tools/helpers";
import { proxyBoundaryControlFromEnv } from "./boundary";
import {
  buildSnapshotDraft,
  CatalogError,
  fetchCatalogEntry,
  type CatalogEntry,
  type FetchCatalogOptions,
  type SnapshotDraft,
} from "./fetch-catalog";
import { validateManifest, type CredentialSchema } from "./manifest";
import { probeMcpEndpoint } from "./mcp-endpoint-probe";
import type { ExtensionRegistry, PinnedSnapshot } from "./registry";
import {
  DEV_EGRESS_CONFIG_PATH,
  EGRESS_CONFIG_PATH,
  SNAPSHOTS_DIR,
  regenerateDevEgressConfig,
  regenerateEgressConfig,
} from "../egress/generate";
import { ADMIN_CATALOG_BROWSER_EVENT } from "../store/audit-events";

/** What the deterministic endpoint discovery resolved for one catalog entry. */
export interface DiscoveredCatalogMcp {
  /** The official hosted MCP server URL (the vendor's own host). */
  serverUrl: string;
  transport: "streamable-http";
  /** The MCP host (egress allowlist entry), e.g. "mcp.linear.app". */
  host: string;
  /** OAuth when the vendor publishes RFC 8414 metadata; api_key otherwise. */
  credentialSchema: CredentialSchema;
  /** True when OAuth-gated → tools-less manifest (the #231 notion pattern). */
  oauthGated: boolean;
}

/** The discovery seam; default {@link discoverCatalogMcp} (deterministic). */
export type CatalogMcpDiscoverer = (entry: CatalogEntry, opts?: FetchCatalogOptions) => Promise<DiscoveredCatalogMcp>;

/**
 * The standard RFC 8414 metadata path for an authorization-server origin.
 */
const OAUTH_AS_METADATA_PATH = "/.well-known/oauth-authorization-server";

/**
 * The finite, strictly-ordered MCP endpoint candidates for one catalog
 * entry (issue #286 §3). Trust is encoded in the order:
 *
 *   1. Trusted explicit endpoint metadata — `entry.mcpEndpoint`, honored
 *      verbatim (the catalog's machine-readable published endpoint). Wins
 *      over ALL derivation.
 *   2. Derived candidates — `https://mcp.<domain>/mcp`, then the SAME
 *      host's `/mcp/v1` (two paths, never a synthesized vendor-specific
 *      host like "gmailmcp" — such facts are exactly what a reviewed
 *      override is for). The existing `mcp.`-prefix guard stays: a domain
 *      that is already the MCP host is never double-prefixed.
 *
 * A candidate is USED only when {@link probeMcpEndpoint} accepts it;
 * otherwise the next candidate is tried. When the set is exhausted the
 * discovery fails closed with the probe evidence.
 */
function mcpCandidates(entry: CatalogEntry): string[] {
  if (entry.mcpEndpoint !== undefined && entry.mcpEndpoint.trim() !== "") {
    return [entry.mcpEndpoint.trim()];
  }
  const host = entry.domain.startsWith("mcp.") ? entry.domain : `mcp.${entry.domain}`;
  return [`https://${host}/mcp`, `https://${host}/mcp/v1`];
}

/**
 * The RFC 8414 auth-classification probe (issue #232, unchanged semantics):
 * an OAuth resource/authorization-server metadata document on the
 * validated MCP origin → OAuth-gated; clean 404s on both paths → api_key;
 * any other status fails loudly (an auth mode is never guessed).
 */
async function classifyOAuthFromMetadata(origin: string, slug: string, fetchImpl: typeof fetch): Promise<boolean> {
  const metadataPaths = [
    `${origin}/.well-known/oauth-protected-resource/mcp`,
    `${origin}${OAUTH_AS_METADATA_PATH}`,
  ];
  for (const metadataUrl of metadataPaths) {
    let res: Response;
    try {
      res = await fetchImpl(metadataUrl);
    } catch (err) {
      throw new CatalogError(
        `official MCP endpoint discovery for "${slug}" failed probing ${metadataUrl}: ${errorMessage(err)}`,
      );
    }
    if (res.status === 200) {
      // OAuth-gated: tools-less manifest, the #231 notion pattern — the
      // runtime discovers the surface from tools/list at boot, the OAuth
      // flow mints at connect (SDK-owned, issue #284).
      return true;
    }
    if (res.status !== 404) {
      throw new CatalogError(
        `official MCP endpoint discovery for "${slug}": ${metadataUrl} returned HTTP ${res.status} — ` +
          "cannot classify the auth mode (never guessed)",
      );
    }
  }
  // No OAuth metadata → the server is not OAuth-gated: the user supplies an
  // API key at connect (the #196 upload-link path). A server that omits
  // RFC 8414 metadata is never guessed as OAuth (that would mint an OAuth
  // flow against a server that does not speak it).
  return false;
}

/**
 * Deterministic official MCP endpoint discovery (issue #232 + #286): every
 * candidate endpoint is PROBED with a raw JSON-RPC `initialize` before it
 * can register — a synthesized or hand-typed URL is never persisted
 * unproven (the broken Gmail pin bound /mcp while the official endpoint is
 * /mcp/v1). Candidates come from the finite ordered set in
 * {@link mcpCandidates}; the first accepted verdict wins:
 *
 *   - `mcp` verdict → the endpoint speaks MCP; the auth mode comes from
 *     the vendor's published RFC 8414 metadata on the VALIDATED origin
 *     (the same discovery the SDK's `auth()` runs): a metadata document →
 *     OAuth-gated; none → api_key. Issue #284: no token endpoint is
 *     carried on the record — the SDK performs its own RFC 8414 discovery
 *     at connect/call time and the egress proxy never mints.
 *   - `oauth_challenge` verdict → the endpoint exists and is OAuth-gated
 *     (a standards-compliant Bearer challenge); the metadata probe is
 *     unnecessary.
 *
 * The allowlist host is the VALIDATED URL's host — never a redirect
 * target, never a well-known metadata origin. Fail closed: an endpoint
 * that fails every candidate probe (or a metadata probe that is neither
 * 200 nor 404) is a loud {@link CatalogError} carrying the probe evidence
 * and the reviewed-override instruction — an endpoint or auth mode is
 * never guessed.
 */
export async function discoverCatalogMcp(entry: CatalogEntry, opts: FetchCatalogOptions = {}): Promise<DiscoveredCatalogMcp> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs;
  const failures: Array<{ url: string; evidence: string }> = [];
  for (const serverUrl of mcpCandidates(entry)) {
    const verdict = await probeMcpEndpoint(serverUrl, {
      fetchImpl,
      ...(timeoutMs !== undefined ? { timeoutMs } : undefined),
    });
    if (!verdict.ok) {
      failures.push({ url: serverUrl, evidence: verdict.evidence });
      continue;
    }
    const host = new URL(serverUrl).host;
    if (verdict.kind === "oauth_challenge") {
      return {
        serverUrl,
        host,
        transport: "streamable-http",
        credentialSchema: { type: "oauth" },
        oauthGated: true,
      };
    }
    const oauthGated = await classifyOAuthFromMetadata(`https://${host}`, entry.slug, fetchImpl);
    return {
      serverUrl,
      host,
      transport: "streamable-http",
      credentialSchema: oauthGated ? { type: "oauth" } : { type: "api_key" },
      oauthGated,
    };
  }
  throw new CatalogError(
    `official MCP endpoint discovery for "${entry.slug}" failed: ` +
      failures.map((f) => `candidate ${f.url} failed the MCP validation probe (${f.evidence})`).join("; ") +
      " and no other candidate accepted — nothing was registered. The vendor's hosted MCP endpoint could not be " +
      "validated. If you have a reviewed official endpoint, register it via catalog_browser action=pin " +
      `spec=${entry.slug} binding={serverUrl: "<reviewed https url>", transport: "streamable-http"} ` +
      "credential_schema={...} confirm=true — the pin path probes the endpoint the same way. Browse the " +
      "integrations.sh catalog with catalog_browser to find the right id.",
  );
}

/** The connect capability's optional catalog wiring (issue #232). */
export interface CatalogRegisterDeps {
  /** Catalog fetch seams; defaults: live integrations.sh + global fetch. */
  catalog?: FetchCatalogOptions;
  /** Official MCP endpoint + auth-mode discovery; default {@link discoverCatalogMcp}. */
  discoverMcp?: CatalogMcpDiscoverer;
  /** Where the PINNED seed snapshots live (the egress regen's seed source); default SNAPSHOTS_DIR. */
  snapshotsDir?: string;
  /** Strict egress output; default EGRESS_CONFIG_PATH ("config/egress.yml"). */
  egressPath?: string;
  /** Dev egress output; default DEV_EGRESS_CONFIG_PATH. */
  devEgressPath?: string;
  /**
   * The store-backed runtime registry seam (issue #233): persists the
   * runtime-registered manifest (machine state — never a repo file) and
   * feeds the egress regen the full persisted set. Absent (headless
   * contexts, hermetic tests) → the registration is ephemeral: the egress
   * regen still runs with the new snapshot and the live registry still
   * hot-registers, but nothing persists across a restart.
   */
  runtimeRegistry?: RuntimeRegistrySeam;
}

/** The store-backed runtime registry persistence seam (issue #233). */
export interface RuntimeRegistrySeam {
  /** Persists one runtime-registered extension's snapshot (idempotent upsert by extension id). */
  upsert(snapshot: PinnedSnapshot, actor: string, spaceId?: string | null): Promise<void>;
  /** The full persisted runtime set (the egress regen's merge input), in registration order. */
  list(): Promise<PinnedSnapshot[]>;
}

/** Everything the seam needs at call time (assembled by the connect path). */
export interface CatalogRegisterRuntimeDeps extends CatalogRegisterDeps {
  /** The LIVE registry — hot-register target AND the resolve-after-register proof. */
  registry: Pick<ExtensionRegistry, "resolve" | "register">;
  /** The audit module (the registration audits its own durable trail). */
  audit: AuditModule;
  /** The connect principal who registered it. */
  actor: string;
  /** The space the connect ran in (audit + the registry row's provenance). */
  spaceId?: string;
}

/** The lookup+draft step's facts (read-only; the org approval renders these). */
export interface CatalogDraftFacts {
  extensionId: string;
  /** The catalog entry's display name (e.g. "Notion"). */
  label: string;
  /** Catalog kind ("mcp" — the deterministic route registers hosted MCP only). */
  kind: string;
  /** The egress allowlist domains the registration would add. */
  domains: string[];
  /** The discovered official hosted MCP endpoint. */
  mcpEndpoint: string;
  credentialSchema: CredentialSchema;
  oauthGated: boolean;
}

export type CatalogLookupResult =
  | { ok: true; facts: CatalogDraftFacts; snapshot: PinnedSnapshot }
  | { ok: false; message: string };

/**
 * The deterministic lookup + draft (issue #232 mechanics, issue #233
 * shape): catalog lookup → draft (official hosted MCP endpoint discovery +
 * auth classification) → validation. READ-ONLY: nothing registers, no
 * gate, no side effects — the connect path uses the facts to render the
 * org approval (the connect's own approval covers the registration) and
 * passes the snapshot to {@link registerExtensionAtRuntime}. Every failure
 * is loud; an unknown spec carries the browse path.
 */
export async function lookupCatalogExtension(
  extensionId: string,
  deps: CatalogRegisterDeps,
): Promise<CatalogLookupResult> {
  const catalogOpts = deps.catalog ?? {};
  const discoverMcp = deps.discoverMcp ?? discoverCatalogMcp;

  // 1. LOOKUP — the catalog is the only source of truth; an unknown spec
  // (or an unreachable catalog) fails loudly with the browse path.
  let entry: CatalogEntry;
  try {
    entry = await fetchCatalogEntry(extensionId, catalogOpts);
  } catch (err) {
    return {
      ok: false,
      message:
        `unknown extension "${extensionId}" — no extension or catalog entry for it ` +
        `(${errorMessage(err)}). Browse the integrations.sh catalog with catalog_browser ` +
        `(or "bun run src/extensions/fetch-catalog.ts") to find the right id, then "connect <id>" again.`,
    };
  }
  // The deterministic route registers HOSTED MCP extensions only: the
  // discovery resolves an official hosted MCP endpoint, which a cli/openapi
  // entry does not have. Non-MCP entries keep the human's catalog_browser
  // draft/pin flow (the agent web-searches the vendor's binding).
  if (entry.kind !== "mcp") {
    return {
      ok: false,
      message:
        `catalog entry "${extensionId}" is kind "${entry.kind}" — the deterministic catalog connect ` +
        "registers hosted MCP extensions only. Use catalog_browser (action=draft/pin) to register a " +
        "non-MCP extension with the vendor binding facts.",
    };
  }

  // 2. DRAFT — the catalog scaffold + the discovered official endpoint +
  // the auth classification. Fail closed BEFORE anything registers: a
  // manifest that cannot register must never reach the human's approval.
  let discovered: DiscoveredCatalogMcp;
  try {
    discovered = await discoverMcp(entry, catalogOpts);
  } catch (err) {
    // Issue #286: the discovery failure carries the probe evidence and the
    // reviewed-override instruction (§8) — nothing was registered.
    return {
      ok: false,
      message: `cannot register "${extensionId}" from the catalog: ${errorMessage(err)}`,
    };
  }
  const scaffold = buildSnapshotDraft(entry);
  const manifest = {
    ...scaffold.manifest,
    mcp: {
      serverUrl: discovered.serverUrl,
      transport: discovered.transport,
    },
    credentialSchema: discovered.credentialSchema,
    // Egress allowlist: the vendor host + the official MCP host (notion →
    // ["notion.com", "mcp.notion.com"]).
    domains: [...new Set<string>([...scaffold.manifest.domains, discovered.host])],
  };
  const completed: SnapshotDraft = { ...scaffold, manifest };
  let manifestValidated: ReturnType<typeof validateManifest>;
  try {
    manifestValidated = validateManifest(JSON.parse(JSON.stringify(manifest)));
  } catch (err) {
    return { ok: false, message: `cannot register "${extensionId}" from the catalog: ${errorMessage(err)}` };
  }

  // The approval IS the review (issue #233): the connect's own approval
  // (org scope) or the direct personal connect authorizes the runtime
  // registration — the snapshot records reviewed: true and the endpoint
  // came from the vendor's own host (vendorOfficial: true).
  const reviewed: SnapshotDraft = {
    ...completed,
    source: { ...completed.source, reviewed: true, vendorOfficial: true },
  };
  const snapshot: PinnedSnapshot = {
    schema: reviewed.schema,
    extensionId: reviewed.extensionId,
    pinnedAt: reviewed.pinnedAt,
    source: reviewed.source,
    manifest: manifestValidated,
  };
  return {
    ok: true,
    facts: {
      extensionId,
      label: entry.name,
      kind: entry.kind,
      domains: manifest.domains,
      mcpEndpoint: discovered.serverUrl,
      credentialSchema: discovered.credentialSchema,
      oauthGated: discovered.oauthGated,
    },
    snapshot,
  };
}

export type RegisterFromCatalogResult =
  | {
      ok: true;
      message: string;
      extensionId: string;
      label: string;
      liveRegistry: "registered" | "failed" | "absent";
      oauthGated: boolean;
      credentialType: "oauth" | "api_key";
      /** Loud warnings (store failure, egress regen failure, live-registry failure, proxy reload failure). */
      warnings: string[];
    }
  | { ok: false; message: string };

/**
 * The runtime register step (issue #233): the approved/authorized draft
 * from {@link lookupCatalogExtension} persists to the STORE-backed runtime
 * registry (machine state — NO config/extensions file, NO commit), the
 * egress configs regenerate with the merged runtime set (byte-pinned for
 * the seed fixtures; the runtime set is injected), the snapshot
 * HOT-REGISTERS into the live registry, and the proxy reloads. Every
 * failure is loud; a store-write failure fails the registration closed
 * (nothing durable, no egress, no hot-register).
 */
export async function registerExtensionAtRuntime(
  snapshot: PinnedSnapshot,
  label: string,
  deps: CatalogRegisterRuntimeDeps,
): Promise<RegisterFromCatalogResult> {
  const snapshotsDir = deps.snapshotsDir ?? SNAPSHOTS_DIR;
  const egressPath = deps.egressPath ?? EGRESS_CONFIG_PATH;
  const devEgressPath = deps.devEgressPath ?? DEV_EGRESS_CONFIG_PATH;

  // 3. REGISTER AT RUNTIME — the durable store write comes FIRST: a failed
  // persistence fails the registration closed (the egress regen reads the
  // store; a non-persisted registration would be dropped by the next
  // regen). Without a runtimeRegistry seam (headless contexts, hermetic
  // tests) the registration is ephemeral: egress + hot-register still run
  // with just this snapshot.
  if (deps.runtimeRegistry !== undefined) {
    try {
      await deps.runtimeRegistry.upsert(snapshot, deps.actor, deps.spaceId ?? null);
    } catch (err) {
      return {
        ok: false,
        message:
          `runtime registration of "${snapshot.extensionId}" FAILED — nothing was registered: ` +
          `${errorMessage(err)}. The store write is the durable evidence of a runtime registration; ` +
          "retry the connect.",
      };
    }
  }

  // 4. EGRESS REGEN (merged runtime set) + HOT-REGISTER (issue #197) +
  // proxy reload — the canary's extension-pin journey mechanics. Failures
  // are LOUD in the result; the approved registration stays persisted.
  const warnings: string[] = [];
  let runtimeSet: PinnedSnapshot[] = [snapshot];
  if (deps.runtimeRegistry !== undefined) {
    try {
      runtimeSet = await deps.runtimeRegistry.list();
    } catch (err) {
      warnings.push(
        `RUNTIME REGISTRY READ FAILED — regenerating egress with only the new registration: ` +
          `${errorMessage(err)}. Fix the store read and re-run "bun run src/egress/generate.ts".`,
      );
    }
  }
  try {
    regenerateEgressConfig(snapshotsDir, egressPath, runtimeSet);
    regenerateDevEgressConfig(snapshotsDir, devEgressPath, runtimeSet);
  } catch (err) {
    warnings.push(
      `EGRESS REGEN FAILED — "${snapshot.extensionId}" is registered at runtime but ${egressPath} was NOT ` +
        `regenerated: ${errorMessage(err)}. Fix the cause and run "bun run src/egress/generate.ts" — until ` +
        `then the new domains are NOT allowlisted.`,
    );
  }
  let liveRegistry: "registered" | "failed" | "absent" = "absent";
  if (deps.registry.resolve(snapshot.extensionId) !== undefined) {
    liveRegistry = "registered";
  } else {
    try {
      deps.registry.register(snapshot.manifest, snapshot);
      liveRegistry = "registered";
    } catch (err) {
      liveRegistry = "failed";
      warnings.push(
        `LIVE REGISTRY REGISTRATION FAILED — "${snapshot.extensionId}" is registered in the store but this ` +
          `server's runtime won't see it until a restart: ${errorMessage(err)}`,
      );
    }
  }
  // The proxy reload (issue #123): the egress regen changed the allowlist —
  // trigger the boundary's reload so the new domains apply immediately.
  // Unset control (unconfigured deployments, hermetic tests) → write-only,
  // exactly like the boundary.
  const control = proxyBoundaryControlFromEnv();
  if (control.proxyControlUrl !== undefined) {
    try {
      const res = await fetch(`${control.proxyControlUrl}/v1/reload`, {
        method: "POST",
        headers:
          control.proxyControlToken !== undefined
            ? { Authorization: `Bearer ${control.proxyControlToken}` }
            : undefined,
      });
      if (!res.ok) throw new Error(`proxy reload failed (${res.status})`);
    } catch (err) {
      warnings.push(
        `PROXY RELOAD FAILED — the egress config regenerated but the dev proxy is still serving the OLD ` +
          `allowlist until a reload/restart: ${errorMessage(err)}`,
      );
    }
  }

  await deps.audit.appendAudit({
    space_id: deps.spaceId ?? null,
    actor: deps.actor,
    event_type: ADMIN_CATALOG_BROWSER_EVENT,
    payload: {
      action: "register",
      via: "connect",
      spec: snapshot.extensionId,
      runtime_registry: deps.runtimeRegistry !== undefined ? "store" : "ephemeral",
      egress_config: egressPath,
      hosted_variant: true,
      vendor_official: true,
      live_registry: liveRegistry,
    },
  });

  const message =
    `Registered "${label}" from the catalog at runtime — egress regenerated (${egressPath}, ` +
    `${devEgressPath}), live in the running server.`;
  return {
    ok: true,
    message: warnings.length > 0 ? `${message} WARNING: ${warnings.join(" ")}` : message,
    extensionId: snapshot.extensionId,
    label,
    liveRegistry,
    oauthGated: snapshot.manifest.credentialSchema.type === "oauth",
    credentialType: snapshot.manifest.credentialSchema.type,
    warnings,
  };
}
