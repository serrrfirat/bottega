/**
 * Catalog registration seam (issue #232): the deterministic route that lets
 * "connect <X>" work for ANY integrations.sh catalog extension, not just the
 * pinned ones.
 *
 * Before #232, an unregistered extension id failed the connect path with
 * "unknown extension — register it before connecting" and went to the agent
 * loop, which stalled (live evidence: "connect my notion" acked and hung).
 * This seam is the connect capability's fallback, fully deterministic — the
 * MODEL is never the driver:
 *
 *   1. LOOKUP — fetchCatalogEntry (the fetch-catalog seam, same fail-closed
 *      CatalogError); an unknown spec fails loudly with the browse path.
 *   2. DRAFT — the catalog record's scaffold + the OFFICIAL hosted MCP
 *      endpoint discovery ({@link discoverCatalogMcp}: the vendor's own
 *      `mcp.<domain>` host + RFC 8414 OAuth metadata — never a guessed
 *      endpoint or auth mode) + the auth classification (OAuth-gated →
 *      tools-less manifest, the #231 notion pattern; api_key otherwise).
 *   3. REVIEW GATE — MANDATORY for every pin, personal or org scope: the
 *      draft surfaces through the approval router as the exec-tier
 *      `register_extension` tool ("Register <X> from the catalog? (id,
 *      vendor, domains, MCP endpoint)" [Approve/Deny]). A denied gate pins
 *      nothing; a pin never happens silently.
 *   4. PIN — the reviewed draft writes config/extensions/<id>.json via the
 *      fetch-catalog pin flow (parsePinnedSnapshot-validated, fail closed),
 *      then the egress configs regenerate (byte-pinned) and the snapshot
 *      HOT-REGISTERS into the live registry (the canary's extension-pin
 *      journey mechanics, issue #197) — new sessions see the extension
 *      immediately, and the connect continues in the same turn.
 *
 * The egress regeneration fails closed for an OAuth extension without a
 * VERIFIED token endpoint (OAUTH_TOKEN_ENDPOINTS in src/egress/generate.ts
 * — never a guessed URL): the pin still lands (the approved durable
 * change) and the failure is LOUD in the result.
 */
import { mkdirSync } from "node:fs";
import type { ApprovalRouter } from "../policy/approval-router";
import type { AuditModule } from "../policy/audit";
import type { PolicyConfig } from "../policy/config";
import { evaluatePolicyGate } from "../policy/gate";
import { errorMessage } from "../tools/helpers";
import { proxyBoundaryControlFromEnv } from "./boundary";
import {
  buildSnapshotDraft,
  CatalogError,
  fetchCatalogEntry,
  pinSnapshotDraft,
  type CatalogEntry,
  type FetchCatalogOptions,
  type SnapshotDraft,
} from "./fetch-catalog";
import { validateManifest, type CredentialSchema } from "./manifest";
import type { ExtensionRegistry, PinnedSnapshot } from "./registry";
import {
  DEV_EGRESS_CONFIG_PATH,
  EGRESS_CONFIG_PATH,
  SNAPSHOTS_DIR,
  regenerateDevEgressConfig,
  regenerateEgressConfig,
} from "../egress/generate";
import { ADMIN_CATALOG_BROWSER_EVENT } from "../store/audit-events";

/** The exec-tier policy tool name for the catalog review gate (issue #232). */
export const CATALOG_REGISTER_TOOL = "register_extension";

/**
 * The gate args payload a human approves: the "Register <X> from the
 * catalog?" summary — id, vendor, kind, domains, and the discovered MCP
 * endpoint (the Slack router renders these redacted + capped).
 */
export interface CatalogRegisterGateArgs {
  action: "register_from_catalog";
  extension: string;
  vendor: string;
  kind: string;
  domains: string[];
  mcpEndpoint: string;
  credentialSchema: CredentialSchema;
}

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
 * Deterministic official MCP endpoint discovery (issue #232): the official
 * HOSTED server follows the vendor-domain convention every pinned hosted
 * provider uses (linear → mcp.linear.app/mcp, attio → mcp.attio.com/mcp,
 * notion → mcp.notion.com/mcp) — derived from the catalog record's OWN
 * domain, never a community URL. The auth mode comes from the vendor's
 * published RFC 8414 metadata (the same discovery the SDK's `auth()` runs):
 * an OAuth resource/authorization-server metadata document → OAuth-gated;
 * none → api_key. An unreachable/5xx probe fails loudly — an endpoint or
 * auth mode is never guessed.
 */
export async function discoverCatalogMcp(entry: CatalogEntry, opts: FetchCatalogOptions = {}): Promise<DiscoveredCatalogMcp> {
  const host = entry.domain.startsWith("mcp.") ? entry.domain : `mcp.${entry.domain}`;
  const serverUrl = `https://${host}/mcp`;
  const origin = `https://${host}`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  // RFC 8414 discovery paths: the MCP OAuth resource metadata (the MCP auth
  // spec's canonical signal) and the authorization-server metadata (the
  // fallback some vendors serve instead — e.g. linear/attio per
  // src/egress/generate.ts).
  const metadataPaths = [
    `${origin}/.well-known/oauth-protected-resource/mcp`,
    `${origin}/.well-known/oauth-authorization-server`,
  ];
  for (const metadataUrl of metadataPaths) {
    let res: Response;
    try {
      res = await fetchImpl(metadataUrl);
    } catch (err) {
      throw new CatalogError(
        `official MCP endpoint discovery for "${entry.slug}" failed probing ${metadataUrl}: ${errorMessage(err)}`,
      );
    }
    if (res.status === 200) {
      // OAuth-gated: tools-less manifest, the #231 notion pattern — the
      // runtime discovers the surface from tools/list at boot, the OAuth
      // flow mints at connect.
      return { serverUrl, host, transport: "streamable-http", credentialSchema: { type: "oauth" }, oauthGated: true };
    }
    if (res.status !== 404) {
      throw new CatalogError(
        `official MCP endpoint discovery for "${entry.slug}": ${metadataUrl} returned HTTP ${res.status} — ` +
          "cannot classify the auth mode (never guessed)",
      );
    }
  }
  // No OAuth metadata → the server is not OAuth-gated: the user supplies an
  // API key at connect (the #196 upload-link path). A server that omits
  // RFC 8414 metadata is never guessed as OAuth (that would mint an OAuth
  // flow against a server that does not speak it).
  return { serverUrl, host, transport: "streamable-http", credentialSchema: { type: "api_key" }, oauthGated: false };
}

/** The connect capability's optional catalog wiring (issue #232). */
export interface CatalogRegisterDeps {
  /** Catalog fetch seams; defaults: live integrations.sh + global fetch. */
  catalog?: FetchCatalogOptions;
  /** Official MCP endpoint + auth-mode discovery; default {@link discoverCatalogMcp}. */
  discoverMcp?: CatalogMcpDiscoverer;
  /** Where the pin lands; default SNAPSHOTS_DIR ("config/extensions"). */
  snapshotsDir?: string;
  /** Strict egress output; default EGRESS_CONFIG_PATH ("config/egress.yml"). */
  egressPath?: string;
  /** Dev egress output; default DEV_EGRESS_CONFIG_PATH. */
  devEgressPath?: string;
}

/** The policy-gate pieces the review gate needs (the connect gate's shape). */
export interface CatalogRegisterGate {
  loadPolicy: (spaceId: string | undefined) => Promise<PolicyConfig>;
  router: ApprovalRouter;
  /** Ask-human timeout in ms; defaults to the policy's `approvals.timeout_minutes`. */
  timeoutMs?: number;
  /** Executor-session scope (issue #11); see decidePolicyCall. */
  preApproved?: boolean;
}

/** Everything the seam needs at call time (assembled by the connect path). */
export interface CatalogRegisterRuntimeDeps extends CatalogRegisterDeps {
  extensionId: string;
  actor: string;
  spaceId?: string;
  /** The LIVE registry — hot-register target AND the resolve-after-pin proof. */
  registry: Pick<ExtensionRegistry, "resolve" | "register">;
  /** The policy gate's audit module (the gate audits its own trail). */
  audit: AuditModule;
  gate: CatalogRegisterGate;
}

export type RegisterFromCatalogResult =
  | {
      ok: true;
      message: string;
      extensionId: string;
      label: string;
      pinnedPath: string;
      liveRegistry: "registered" | "failed" | "absent";
      oauthGated: boolean;
      credentialType: "oauth" | "api_key";
      /** Loud warnings (egress regen failure, live-registry failure). */
      warnings: string[];
    }
  | { ok: false; message: string };

/**
 * The deterministic catalog flow (issue #232): lookup → draft → review gate
 * → pin + egress regen + hot-register. Every failure is loud; nothing pins
 * without the gate's approval. Returns the outcome the connect path posts
 * in-channel; on success the caller re-resolves the extension and continues
 * the connect in the same turn.
 */
export async function registerExtensionFromCatalog(
  deps: CatalogRegisterRuntimeDeps,
): Promise<RegisterFromCatalogResult> {
  const catalogOpts = deps.catalog ?? {};
  const discoverMcp = deps.discoverMcp ?? discoverCatalogMcp;
  const snapshotsDir = deps.snapshotsDir ?? SNAPSHOTS_DIR;
  const egressPath = deps.egressPath ?? EGRESS_CONFIG_PATH;
  const devEgressPath = deps.devEgressPath ?? DEV_EGRESS_CONFIG_PATH;

  // 1. LOOKUP — the catalog is the only source of truth; an unknown spec
  // (or an unreachable catalog) fails loudly with the browse path.
  let entry: CatalogEntry;
  try {
    entry = await fetchCatalogEntry(deps.extensionId, catalogOpts);
  } catch (err) {
    return {
      ok: false,
      message:
        `unknown extension "${deps.extensionId}" — no extension or catalog entry for it ` +
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
        `catalog entry "${deps.extensionId}" is kind "${entry.kind}" — the deterministic catalog connect ` +
        "registers hosted MCP extensions only. Use catalog_browser (action=draft/pin) to register a " +
        "non-MCP extension with the vendor binding facts.",
    };
  }

  // 2. DRAFT — the catalog scaffold + the discovered official endpoint +
  // the auth classification. Fail closed BEFORE the gate: a manifest that
  // cannot pin must never reach the human's confirmation.
  let discovered: DiscoveredCatalogMcp;
  try {
    discovered = await discoverMcp(entry, catalogOpts);
  } catch (err) {
    return {
      ok: false,
      message:
        `cannot register "${deps.extensionId}" from the catalog: ${errorMessage(err)} — nothing was pinned. ` +
        "Fix the discovery failure (the vendor's hosted MCP endpoint or OAuth metadata) and retry.",
    };
  }
  const scaffold = buildSnapshotDraft(entry);
  const manifest = {
    ...scaffold.manifest,
    mcp: { serverUrl: discovered.serverUrl, transport: discovered.transport },
    credentialSchema: discovered.credentialSchema,
    // Egress allowlist: the vendor host + the official MCP host (notion →
    // ["notion.com", "mcp.notion.com"]).
    domains: [...new Set<string>([...scaffold.manifest.domains, discovered.host])],
  };
  const completed: SnapshotDraft = { ...scaffold, manifest };
  try {
    validateManifest(JSON.parse(JSON.stringify(manifest)));
  } catch (err) {
    return { ok: false, message: `cannot register "${deps.extensionId}" from the catalog: ${errorMessage(err)}` };
  }

  // 3. THE REVIEW GATE — MANDATORY, personal or org scope: a pin is a
  // repo-level change with egress implications, so it rides the approval
  // router as an exec-tier tool call. Denied → nothing pins.
  const gateArgs: CatalogRegisterGateArgs = {
    action: "register_from_catalog",
    extension: deps.extensionId,
    vendor: entry.name,
    kind: entry.kind,
    domains: manifest.domains,
    mcpEndpoint: discovered.serverUrl,
    credentialSchema: discovered.credentialSchema,
  };
  const gateOutcome = await evaluatePolicyGate(
    {
      loadPolicy: deps.gate.loadPolicy,
      audit: deps.audit,
      router: deps.gate.router,
      timeoutMs: deps.gate.timeoutMs,
      preApproved: deps.gate.preApproved,
    },
    { tool: CATALOG_REGISTER_TOOL, args: gateArgs, spaceId: deps.spaceId, actor: deps.actor },
  );
  if (!gateOutcome.allowed) return { ok: false, message: gateOutcome.blockReason };

  // 4. PIN — the human approval IS the review (the canary's pin journey
  // shape): the snapshot records reviewed: true and the endpoint came from
  // the vendor's own host (vendorOfficial: true).
  const reviewed: SnapshotDraft = {
    ...completed,
    source: { ...completed.source, reviewed: true, vendorOfficial: true },
  };
  let pinnedPath: string;
  try {
    mkdirSync(snapshotsDir, { recursive: true });
    pinnedPath = await pinSnapshotDraft(reviewed, snapshotsDir, catalogOpts);
  } catch (err) {
    return {
      ok: false,
      message: `pinning "${deps.extensionId}" from the catalog failed: ${errorMessage(err)} — nothing was pinned`,
    };
  }

  // 5. EGRESS REGEN (byte-pinned) + HOT-REGISTER (issue #197) + proxy
  // reload — the canary's extension-pin journey mechanics. Failures are
  // LOUD in the result; the approved snapshot stays on disk.
  const warnings: string[] = [];
  try {
    regenerateEgressConfig(snapshotsDir, egressPath);
    regenerateDevEgressConfig(snapshotsDir, devEgressPath);
  } catch (err) {
    warnings.push(
      `EGRESS REGEN FAILED — "${deps.extensionId}" is pinned but ${egressPath} was NOT regenerated: ` +
        `${errorMessage(err)}. Fix the cause (e.g. a verified OAuth token endpoint in OAUTH_TOKEN_ENDPOINTS, ` +
        `src/egress/generate.ts) and run "bun run src/egress/generate.ts" — until then the new domains are NOT allowlisted.`,
    );
  }
  let liveRegistry: "registered" | "failed" | "absent" = "absent";
  if (deps.registry.resolve(deps.extensionId) !== undefined) {
    liveRegistry = "registered";
  } else {
    try {
      const manifestValidated = validateManifest(JSON.parse(JSON.stringify(reviewed.manifest)));
      const snapshot: PinnedSnapshot = {
        schema: reviewed.schema,
        extensionId: reviewed.extensionId,
        pinnedAt: reviewed.pinnedAt,
        source: reviewed.source,
        manifest: manifestValidated,
      };
      deps.registry.register(manifestValidated, snapshot);
      liveRegistry = "registered";
    } catch (err) {
      liveRegistry = "failed";
      warnings.push(
        `LIVE REGISTRY REGISTRATION FAILED — "${deps.extensionId}" is pinned but this server's runtime won't ` +
          `see it until a restart: ${errorMessage(err)}`,
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
      action: "pin",
      via: "connect",
      spec: deps.extensionId,
      written_to: pinnedPath,
      egress_config: egressPath,
      hosted_variant: true,
      vendor_official: true,
      live_registry: liveRegistry,
    },
  });

  const message =
    `Pinned "${entry.name}" from the catalog (${pinnedPath}) — egress regenerated (${egressPath}, ` +
    `${devEgressPath}), live in the running server.`;
  return {
    ok: true,
    message: warnings.length > 0 ? `${message} WARNING: ${warnings.join(" ")}` : message,
    extensionId: deps.extensionId,
    label: entry.name,
    pinnedPath,
    liveRegistry,
    oauthGated: discovered.oauthGated,
    credentialType: discovered.credentialSchema.type,
    warnings,
  };
}
