/**
 * Issue #232/#233 acceptance (seam tier): the catalog registration seam the
 * connect path invokes for an UNREGISTERED extension — deterministic
 * lookup → draft (catalog record + official hosted MCP endpoint discovery
 * + auth classification) → REGISTER AT RUNTIME (store-backed registry +
 * egress regen merged with the runtime set + hot-register + proxy reload).
 * Red on pre-fix: the seam does not exist before #232 (the connect path
 * had no catalog fallback).
 *
 * Issue #233: the register_extension review gate is REMOVED from the seam —
 * the connect's own approval covers org scope in connect.ts; this file
 * pins the seam's own contracts: the auth classification never guesses, an
 * unknown spec fails loudly with the browse path, the lookup is READ-ONLY
 * (nothing registers, no gate), the runtime register persists the
 * snapshot to the store (machine state — no config file), the egress regen
 * MERGES the persisted runtime set, and an approved registration
 * hot-registers into the live registry. A denied/never-approved connect
 * registers nothing (the gate lives at the caller surface — space-service/
 * connect tests).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { CatalogError, DEFAULT_CATALOG_URL, type CatalogEntry } from "./fetch-catalog";
import { createExtensionRegistry, parsePinnedSnapshot, type ExtensionRegistry, type PinnedSnapshot } from "./registry";
import { type CatalogRegisterRuntimeDeps, type RuntimeRegistrySeam } from "./catalog-register";
import {
  discoverCatalogMcp,
  lookupCatalogExtension,
  registerExtensionAtRuntime,
} from "./catalog-register";

const CATALOG_URL = DEFAULT_CATALOG_URL;

const NOTION_RECORD = {
  id: "mcp/notion",
  slug: "notion",
  kind: "mcp",
  name: "Notion",
  description: "Notion's official MCP server",
  url: "https://notion.com/docs/mcp",
  domain: "notion.com",
};

const ACME_KEY_RECORD = {
  id: "mcp/acme-key",
  slug: "acme-key",
  kind: "mcp",
  name: "Acme Key",
  description: "An api_key-gated hosted MCP",
  url: "https://acme.example.com/docs/mcp",
  domain: "acme.example.com",
};

const OAUTH_ONLY_RECORD = {
  id: "mcp/oauth-only",
  slug: "oauth-only",
  kind: "mcp",
  name: "OAuth Only",
  description: "OAuth-gated with no verified token endpoint",
  url: "https://oauth-only.example.com/docs/mcp",
  domain: "oauth-only.example.com",
};

/** A catalog record with a name/alias that differs from its slug (issue #233 semantic lookup). */
const DOCS_RECORD = {
  id: "mcp/google-docs",
  slug: "google-docs",
  kind: "mcp",
  name: "Google Docs",
  aliases: ["docs", "gdocs"],
  description: "Google Docs MCP",
  url: "https://docs.google.com/mcp",
  domain: "docs.google.com",
};

function catalogDoc(records: unknown[]): string {
  return JSON.stringify({ version: 1, generatedAt: "2026-08-18T00:00:00.000Z", data: records });
}

/**
 * Routes the catalog document to the stub doc and every other URL to the
 * given behavior — hermetic, no network. Exact URL matches win, then the
 * longest prefix (so a `/mcp` route never shadows `/mcp/v1`); well-known
 * metadata paths default to `wellKnownStatus`, everything else to
 * `defaultStatus` (both 404 — fail closed).
 */
function stubFetch(
  records: unknown[],
  routes: Route[] = [],
  opts: { wellKnownStatus?: number; defaultStatus?: number } = {},
): typeof fetch {
  // SAFETY: the stub implements fetch's call contract; Bun's fetch also
  // exposes fetch.preconnect, which the catalog client never calls.
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === CATALOG_URL) return new Response(catalogDoc(records), { status: 200 });
    const exact = routes.find((r) => r.match === url);
    const route =
      exact ?? routes.filter((r) => url.startsWith(r.match)).sort((a, b) => b.match.length - a.match.length)[0];
    if (route !== undefined) {
      return new Response(route.body ?? "", { status: route.status, headers: route.headers });
    }
    if (url.includes("/.well-known/")) return new Response("", { status: opts.wellKnownStatus ?? 404 });
    return new Response("", { status: opts.defaultStatus ?? 404 });
  }) as typeof fetch;
}

/** A valid MCP initialize result body the endpoint doubles serve. */
const INITIALIZE_RESULT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "stub-mcp", version: "1.0.0" },
  },
});

/** One URL (or prefix) → a scripted response for the endpoint doubles. */
interface Route {
  match: string;
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** Serves a valid MCP initialize result at `url` (the accepted double). */
function initializeOk(url: string): Route {
  return { match: url, status: 200, body: INITIALIZE_RESULT, headers: { "content-type": "application/json" } };
}

/** Serves HTTP 401 + a single Bearer challenge at `url` (the OAuth-gated double). */
function oauthChallengeAt(url: string): Route {
  return { match: url, status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } };
}

/** Serves a bare status at `url` (rejected-endpoint doubles). */
function statusAt(url: string, status: number): Route {
  return { match: url, status };
}

/** The derived candidate endpoints for a catalog record's domain (issue #286 §3). */
function derivedCandidates(record: unknown): string[] {
  const domain = (record as { domain: string }).domain;
  const host = domain.startsWith("mcp.") ? domain : `mcp.${domain}`;
  return [`https://${host}/mcp`, `https://${host}/mcp/v1`];
}

/** A throwing fetch: the discovery must fail loudly, never guess. */
function throwingFetch(): typeof fetch {
  // SAFETY: same contract as stubFetch; the cast goes through `unknown`
  // because the throwing arrow's return type (Promise<never>) does not
  // overlap typeof fetch structurally (no preconnect member).
  return (async (_input: string | URL | Request, _init?: RequestInit) => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
}

/**
 * In-memory runtime registry seam (issue #233): persists runtime-registered
 * snapshots exactly like the store-backed seam, with failure switches for
 * the fail-closed paths.
 */
class MemoryRuntimeRegistry implements RuntimeRegistrySeam {
  readonly rows: PinnedSnapshot[] = [];
  readonly upsertCalls: Array<{ snapshot: PinnedSnapshot; actor: string; spaceId: string | null }> = [];
  failUpsert = false;
  failList = false;
  async upsert(snapshot: PinnedSnapshot, actor: string, spaceId?: string | null): Promise<void> {
    if (this.failUpsert) throw new Error("store write failed (disk full)");
    this.upsertCalls.push({ snapshot, actor, spaceId: spaceId ?? null });
    this.rows.push(snapshot);
  }
  async list(): Promise<PinnedSnapshot[]> {
    if (this.failList) throw new Error("store read failed");
    return [...this.rows];
  }
}

interface Harness {
  deps: Omit<CatalogRegisterRuntimeDeps, "actor" | "spaceId"> & {
    snapshotsDir: string;
    egressPath: string;
    devEgressPath: string;
  };
  runtimeRegistry: MemoryRuntimeRegistry;
  egressPath: string;
  devEgressPath: string;
  registry: ExtensionRegistry;
  auditRows: Array<{ actor: string; event_type: string; payload: unknown }>;
  dir: string;
}

function makeHarness(opts: { records?: unknown[]; wellKnownStatus?: number; routes?: Route[] } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bottega-catalog-register-"));
  const snapshotsDir = join(dir, "extensions");
  const egressPath = join(dir, "egress.yml");
  const devEgressPath = join(dir, "egress.dev.yml");
  const auditRows: Array<{ actor: string; event_type: string; payload: unknown }> = [];
  const audit = {
    appendAudit: async (entry: { actor: string; event_type: string; payload: unknown }) => {
      auditRows.push(entry);
      return auditRows.length;
    },
    listAudit: async () => [],
  };
  const registry = createExtensionRegistry(snapshotsDir);
  const runtimeRegistry = new MemoryRuntimeRegistry();
  // Every record's derived candidates serve a valid initialize result by
  // default (the accepted double); explicit routes (test overrides) win.
  const records = opts.records ?? [NOTION_RECORD];
  const derivedRoutes = records.flatMap((record) => derivedCandidates(record).map((url) => initializeOk(url)));
  const routes = [...(opts.routes ?? []), ...derivedRoutes];
  const deps: Harness["deps"] = {
    registry,
    audit,
    runtimeRegistry,
    catalog: {
      fetchImpl: stubFetch(records, routes, { wellKnownStatus: opts.wellKnownStatus ?? 200 }),
    },
    snapshotsDir,
    egressPath,
    devEgressPath,
  };
  return { deps, runtimeRegistry, egressPath, devEgressPath, registry, auditRows, dir };
}

// The harness dirs are tracked after creation so cleanup is deterministic.
const tracked: Harness[] = [];
afterEach(() => {
  for (const h of tracked.splice(0)) rmSync(h.dir, { recursive: true, force: true });
});

describe("discoverCatalogMcp (issue #232 + #286) — probed official MCP endpoint + auth classification", () => {
  const entry: CatalogEntry = {
    id: "mcp/linear",
    slug: "linear",
    name: "Linear",
    kind: "mcp",
    domain: "linear.app",
    url: "https://linear.app/docs/mcp",
  };

  test("the official hosted MCP endpoint derives from the vendor domain and is PROBED before acceptance", async () => {
    // The pinned hosted providers all follow the convention (linear →
    // mcp.linear.app/mcp, attio → mcp.attio.com/mcp, notion →
    // mcp.notion.com/mcp) — the discovery derives the candidate from the
    // catalog record's OWN domain, never a community URL, and the probe
    // must see a valid initialize result before the endpoint is accepted.
    const discovered = await discoverCatalogMcp(entry, {
      fetchImpl: stubFetch([], [initializeOk("https://mcp.linear.app/mcp")], { wellKnownStatus: 404 }),
    });
    expect(discovered.serverUrl).toBe("https://mcp.linear.app/mcp");
    expect(discovered.host).toBe("mcp.linear.app");
    expect(discovered.transport).toBe("streamable-http");
    expect(discovered.credentialSchema).toEqual({ type: "api_key" });
  });

  test("an MCP OAuth resource-metadata document (RFC 8414) classifies the server OAuth-gated", async () => {
    const discovered = await discoverCatalogMcp(entry, {
      fetchImpl: stubFetch([], [initializeOk("https://mcp.linear.app/mcp")], { wellKnownStatus: 200 }),
    });
    expect(discovered.oauthGated).toBe(true);
    expect(discovered.credentialSchema).toEqual({ type: "oauth" });
  });

  test("the authorization-server metadata is the fallback OAuth signal", async () => {
    // Only the SECOND well-known path returns 200 — the discovery probes
    // both the protected-resource and the authorization-server metadata —
    // but only AFTER the endpoint's initialize probe accepted it.
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === CATALOG_URL) return new Response(catalogDoc([]), { status: 200 });
      if (url === "https://mcp.linear.app/mcp") {
        return new Response(INITIALIZE_RESULT, { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: url.includes("oauth-authorization-server") ? 200 : 404 });
    }) as typeof fetch;
    const discovered = await discoverCatalogMcp(entry, { fetchImpl });
    expect(discovered.oauthGated).toBe(true);
    expect(discovered.credentialSchema).toEqual({ type: "oauth" });
  });

  test("no OAuth metadata → api_key (the key is supplied at connect; never a guessed OAuth)", async () => {
    const discovered = await discoverCatalogMcp(entry, {
      fetchImpl: stubFetch([], [initializeOk("https://mcp.linear.app/mcp")], { wellKnownStatus: 404 }),
    });
    expect(discovered.oauthGated).toBe(false);
    expect(discovered.credentialSchema).toEqual({ type: "api_key" });
  });

  test("an unreachable endpoint probe fails loudly — the endpoint is never guessed", async () => {
    // A throwing fetch (network error) and an HTTP 503 both fail EVERY
    // candidate probe, so the discovery throws with the evidence — an
    // endpoint is never registered unproven.
    await expect(discoverCatalogMcp(entry, { fetchImpl: throwingFetch() })).rejects.toThrow(CatalogError);
    await expect(
      discoverCatalogMcp(entry, { fetchImpl: stubFetch([], [], { defaultStatus: 503 }) }),
    ).rejects.toThrow(CatalogError);
  });

  test("a domain that is already the MCP host is not double-prefixed", async () => {
    const mcpDomain: CatalogEntry = { ...entry, domain: "mcp.attio.com" };
    const discovered = await discoverCatalogMcp(mcpDomain, {
      fetchImpl: stubFetch([], [initializeOk("https://mcp.attio.com/mcp")], { wellKnownStatus: 404 }),
    });
    expect(discovered.serverUrl).toBe("https://mcp.attio.com/mcp");
  });

  test("the derived /mcp candidate failing falls through to /mcp/v1 on the SAME host (candidate order)", async () => {
    const discovered = await discoverCatalogMcp(entry, {
      fetchImpl: stubFetch(
        [],
        [statusAt("https://mcp.linear.app/mcp", 404), initializeOk("https://mcp.linear.app/mcp/v1")],
        { wellKnownStatus: 404 },
      ),
    });
    expect(discovered.serverUrl).toBe("https://mcp.linear.app/mcp/v1");
    expect(discovered.host).toBe("mcp.linear.app");
    expect(discovered.credentialSchema).toEqual({ type: "api_key" });
  });

  test("explicit mcpEndpoint metadata is honored VERBATIM and wins over derivation (priority 1)", async () => {
    // The Gmail-shaped record: the catalog publishes the vendor's official
    // /mcp/v1 endpoint. The derived mcp.gmail.googleapis.com candidate must
    // never even be probed.
    let derivedProbes = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === CATALOG_URL) return new Response(catalogDoc([]), { status: 200 });
      if (url === "https://gmailmcp.googleapis.com/mcp/v1") {
        return new Response(INITIALIZE_RESULT, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("https://mcp.gmail.googleapis.com")) {
        derivedProbes += 1;
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const explicit: CatalogEntry = {
      ...entry,
      slug: "gmail-googleapis-com",
      domain: "gmail.googleapis.com",
      mcpEndpoint: "https://gmailmcp.googleapis.com/mcp/v1",
    };
    const discovered = await discoverCatalogMcp(explicit, { fetchImpl });
    expect(discovered.serverUrl).toBe("https://gmailmcp.googleapis.com/mcp/v1");
    expect(discovered.host).toBe("gmailmcp.googleapis.com");
    expect(derivedProbes).toBe(0);
  });

  test("an HTTP 401 + Bearer challenge on the endpoint implies oauth WITHOUT the RFC 8414 metadata probe", async () => {
    let metadataProbes = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === CATALOG_URL) return new Response(catalogDoc([]), { status: 200 });
      if (url === "https://mcp.linear.app/mcp") {
        return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
      }
      if (url.includes("/.well-known/")) metadataProbes += 1;
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const discovered = await discoverCatalogMcp(entry, { fetchImpl });
    expect(discovered.serverUrl).toBe("https://mcp.linear.app/mcp");
    expect(discovered.oauthGated).toBe(true);
    expect(discovered.credentialSchema).toEqual({ type: "oauth" });
    expect(metadataProbes).toBe(0);
  });

  test("a redirect to another host is rejected — the redirect host is never allowlisted", async () => {
    let evilHits = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === CATALOG_URL) return new Response(catalogDoc([NOTION_RECORD]), { status: 200 });
      if (url === "https://mcp.notion.com/mcp") {
        return new Response("", { status: 301, headers: { location: "https://evil.example/mcp" } });
      }
      if (url.includes("evil.example")) evilHits += 1;
      return new Response("", { status: 404 });
    }) as typeof fetch;
    await expect(discoverCatalogMcp({ ...entry, slug: "notion", domain: "notion.com" }, { fetchImpl })).rejects.toThrow(
      /redirect/,
    );
    expect(evilHits).toBe(0);
  });

  test("an http:// candidate is rejected (HTTPS only) — never probed", async () => {
    let probed = false;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === CATALOG_URL) return new Response(catalogDoc([]), { status: 200 });
      probed = true;
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const httpEntry: CatalogEntry = { ...entry, mcpEndpoint: "http://mcp.linear.app/mcp" };
    await expect(discoverCatalogMcp(httpEntry, { fetchImpl })).rejects.toThrow(/must be https/);
    expect(probed).toBe(false);
  });
});

describe("lookupCatalogExtension (issue #232/#233) — lookup → draft, READ-ONLY", () => {
  function harness(opts: Parameters<typeof makeHarness>[0] = {}): Harness {
    const h = makeHarness(opts);
    tracked.push(h);
    return h;
  }

  test("an unknown spec fails loudly with the catalog browse path and registers NOTHING", async () => {
    const h = harness({ records: [] });
    const result = await lookupCatalogExtension("nope.xyz", h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('unknown extension "nope.xyz"');
      expect(result.message).toContain("no extension or catalog entry");
      expect(result.message).toContain("catalog_browser");
    }
    // The lookup failed BEFORE any gate/register: nothing written, nothing
    // hot-registered, no egress output, no store row.
    expect(h.runtimeRegistry.rows).toHaveLength(0);
    expect(h.registry.resolve("nope.xyz")).toBeUndefined();
    expect(existsSync(h.egressPath)).toBe(false);
    expect(h.auditRows).toHaveLength(0);
  });

  test("semantic lookup resolves by NAME and ALIASES, not just exact ids (issue #233)", async () => {
    // "connect my docs" → the intent token is "docs" → the catalog entry
    // named "Google Docs" (or carrying the "docs" alias) must resolve.
    const h = harness({ records: [DOCS_RECORD], wellKnownStatus: 404 });
    const byAlias = await lookupCatalogExtension("docs", h.deps);
    expect(byAlias.ok).toBe(true);
    if (byAlias.ok) {
      expect(byAlias.facts.label).toBe("Google Docs");
      expect(byAlias.snapshot.extensionId).toBe("google-docs");
    }
    const byName = await lookupCatalogExtension("Google Docs", h.deps);
    expect(byName.ok).toBe(true);
    if (byName.ok) expect(byName.snapshot.extensionId).toBe("google-docs");
    // An exact id match is case-insensitive.
    const byId = await lookupCatalogExtension("MCP/Google-Docs", h.deps);
    expect(byId.ok).toBe(true);
    if (byId.ok) expect(byId.snapshot.extensionId).toBe("google-docs");
    // Never a substring guess: "google-doc" (a prefix of the id) resolves
    // nothing — ambiguous partial tokens fail loudly.
    const bySubstring = await lookupCatalogExtension("google-doc", h.deps);
    expect(bySubstring.ok).toBe(false);
  });

  test("the draft facts carry the discovered endpoint, domains, and auth classification", async () => {
    const h = harness();
    const result = await lookupCatalogExtension("notion", h.deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts).toEqual({
      extensionId: "notion",
      label: "Notion",
      kind: "mcp",
      domains: ["notion.com", "mcp.notion.com"],
      mcpEndpoint: "https://mcp.notion.com/mcp",
      credentialSchema: { type: "oauth" },
      oauthGated: true,
    });
    // The draft snapshot is registry-valid and reviewed (the connect's own
    // approval IS the review — the #231 notion shape: OAuth + tools-less).
    expect(result.snapshot.extensionId).toBe("notion");
    expect(result.snapshot.source.reviewed).toBe(true);
    expect(result.snapshot.source.vendorOfficial).toBe(true);
    expect(result.snapshot.source.catalog).toBe(CATALOG_URL);
    expect(result.snapshot.manifest.mcp).toEqual({ serverUrl: "https://mcp.notion.com/mcp", transport: "streamable-http" });
    expect(result.snapshot.manifest.credentialSchema).toEqual({ type: "oauth" });
    // Tools-less (issue #158): the surface is discovered at runtime from
    // the provider's tools/list with conservative tiers.
    expect(result.snapshot.manifest.tools).toBeUndefined();
    expect(result.snapshot.manifest.domains).toEqual(["notion.com", "mcp.notion.com"]);
  });

  test("the lookup is READ-ONLY — no store row, no egress, no hot-register, no audit", async () => {
    const h = harness();
    const result = await lookupCatalogExtension("notion", h.deps);
    expect(result.ok).toBe(true);
    expect(h.runtimeRegistry.rows).toHaveLength(0);
    expect(existsSync(h.egressPath)).toBe(false);
    expect(h.registry.resolve("notion")).toBeUndefined();
    expect(h.auditRows).toHaveLength(0);
  });

  test("a non-mcp catalog entry is refused deterministically (hosted MCP only)", async () => {
    const cliRecord = {
      id: "cli/acme-cli",
      slug: "acme-cli",
      kind: "cli",
      name: "Acme CLI",
      url: "https://acme.example.com/docs/cli",
      domain: "acme.example.com",
    };
    const h = harness({ records: [cliRecord], wellKnownStatus: 404 });
    const result = await lookupCatalogExtension("acme-cli", h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("kind \"cli\"");
      expect(result.message).toContain("catalog_browser");
    }
    expect(h.runtimeRegistry.rows).toHaveLength(0);
  });

  test("every candidate failing the probe fails the lookup closed with the reviewed-override instruction — nothing registers (issue #286)", async () => {
    const h = harness({
      routes: [statusAt("https://mcp.notion.com/mcp", 404), statusAt("https://mcp.notion.com/mcp/v1", 404)],
    });
    const result = await lookupCatalogExtension("notion", h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // §8: the failure carries the probe evidence and the reviewed
      // override path — the exact wording the agent needs to recover.
      expect(result.message).toContain("validation probe");
      expect(result.message).toContain("HTTP 404");
      expect(result.message).toContain("no other candidate accepted");
      expect(result.message).toContain("reviewed official endpoint");
      expect(result.message).toContain("catalog_browser action=pin");
    }
    // Fail closed: no store row, no egress output, no hot-register, no audit.
    expect(h.runtimeRegistry.rows).toHaveLength(0);
    expect(existsSync(h.egressPath)).toBe(false);
    expect(h.registry.resolve("notion")).toBeUndefined();
    expect(h.auditRows).toHaveLength(0);
  });

  test("an oauth_challenge on the endpoint drafts an OAuth-gated tools-less manifest WITHOUT the metadata probe (issue #286)", async () => {
    const h = harness({
      routes: [oauthChallengeAt("https://mcp.notion.com/mcp")],
      wellKnownStatus: 404,
    });
    const result = await lookupCatalogExtension("notion", h.deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.mcpEndpoint).toBe("https://mcp.notion.com/mcp");
    expect(result.facts.oauthGated).toBe(true);
    expect(result.facts.credentialSchema).toEqual({ type: "oauth" });
    expect(result.facts.domains).toEqual(["notion.com", "mcp.notion.com"]);
    expect(result.snapshot.manifest.credentialSchema).toEqual({ type: "oauth" });
    expect(result.snapshot.manifest.tools).toBeUndefined();
  });

  test("an explicit mcpEndpoint candidate that passes drafts exactly that URL and allowlists its host (issue #286)", async () => {
    const gmailRecord = {
      id: "mcp/gmail-googleapis-com",
      slug: "gmail-googleapis-com",
      kind: "mcp",
      name: "Gmail",
      domain: "gmail.googleapis.com",
      mcpEndpoint: "https://gmailmcp.googleapis.com/mcp/v1",
    };
    const h = harness({
      records: [gmailRecord],
      routes: [initializeOk("https://gmailmcp.googleapis.com/mcp/v1")],
      wellKnownStatus: 404,
    });
    const result = await lookupCatalogExtension("gmail-googleapis-com", h.deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.manifest.mcp).toEqual({
      serverUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      transport: "streamable-http",
    });
    // The allowlist host is the VALIDATED endpoint's host — never a
    // synthesized mcp.gmail.googleapis.com.
    expect(result.snapshot.manifest.domains).toEqual(["gmail.googleapis.com", "gmailmcp.googleapis.com"]);
  });
});

describe("registerExtensionAtRuntime (issue #233) — store write → egress regen (merged runtime set) → hot-register → reload", () => {
  async function lookup(h: Harness, extensionId = "notion") {
    const result = await lookupCatalogExtension(extensionId, h.deps);
    if (!result.ok) throw new Error(result.message);
    return result;
  }

  test("the approved registration persists to the runtime registry, merges egress, and hot-registers", async () => {
    const h = makeHarness();
    tracked.push(h);
    const draft = await lookup(h);
    const result = await registerExtensionAtRuntime(draft.snapshot, draft.facts.label, {
      ...h.deps,
      actor: "UADA",
      spaceId: "slack:C1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.extensionId).toBe("notion");
      expect(result.liveRegistry).toBe("registered");
      expect(result.oauthGated).toBe(true);
      expect(result.credentialType).toBe("oauth");
      expect(result.message).toContain('Registered "Notion" from the catalog at runtime');
      expect(result.message).not.toContain("config/extensions"); // no pin file, no commit
      expect(result.warnings).toEqual([]);
    }

    // The STORE holds the durable snapshot (machine state — the egress
    // regen merges it; NO config/extensions file was written).
    expect(h.runtimeRegistry.rows).toHaveLength(1);
    const persisted = parsePinnedSnapshot(JSON.stringify(h.runtimeRegistry.rows[0]));
    expect(persisted.extensionId).toBe("notion");
    expect(persisted.source.reviewed).toBe(true);
    expect(persisted.source.vendorOfficial).toBe(true);
    expect(existsSync(join(h.deps.snapshotsDir, "notion.json"))).toBe(false);

    // Egress regenerated (byte-pinned) with the runtime set merged: the
    // vendor host AND the MCP host are allowlisted, and — issue #284 — NO
    // oauth_token entry/blob is emitted (the SDK owns the OAuth).
    const egress = readFileSync(h.egressPath, "utf8");
    expect(egress).toContain('"mcp.notion.com"');
    expect(egress).toContain('"notion.com"');
    expect(egress).not.toContain("notion-oauth.json");
    expect(egress).not.toContain("- name: oauth_token");
    expect(existsSync(h.devEgressPath)).toBe(true);
    expect(readFileSync(h.devEgressPath, "utf8")).toContain("- name: allowlist");

    // Hot-registered: the LIVE registry resolves the extension immediately.
    expect(h.registry.resolve("notion")?.manifest.id).toBe("notion");
  });

  test("the egress regen merges the FULL persisted runtime set — earlier registrations survive (issue #233)", async () => {
    const h = makeHarness({ records: [NOTION_RECORD, ACME_KEY_RECORD], wellKnownStatus: 404 });
    tracked.push(h);
    const notion = await lookup(h, "notion");
    await registerExtensionAtRuntime(notion.snapshot, notion.facts.label, { ...h.deps, actor: "UADA" });
    const acme = await lookup(h, "acme-key");
    const second = await registerExtensionAtRuntime(acme.snapshot, acme.facts.label, { ...h.deps, actor: "UADA" });

    expect(second.ok).toBe(true);
    // The SECOND regen still contains the FIRST registration's domains —
    // the runtime set is the whole persisted set, never just the new row.
    const egress = readFileSync(h.egressPath, "utf8");
    expect(egress).toContain('"mcp.notion.com"');
    expect(egress).toContain('"mcp.acme.example.com"');
    expect(readFileSync(h.devEgressPath, "utf8")).toContain("mcp.acme.example.com");
  });

  test("a failed store write fails the registration closed — nothing registers", async () => {
    const h = makeHarness();
    tracked.push(h);
    h.runtimeRegistry.failUpsert = true;
    const draft = await lookup(h);
    const result = await registerExtensionAtRuntime(draft.snapshot, draft.facts.label, { ...h.deps, actor: "UADA" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("FAILED — nothing was registered");
      expect(result.message).toContain("store write failed");
    }
    // Fail closed: no egress output, no hot-register, no audit row.
    expect(existsSync(h.egressPath)).toBe(false);
    expect(h.registry.resolve("notion")).toBeUndefined();
    expect(h.auditRows).toHaveLength(0);
  });

  test("without a runtime registry seam the registration is ephemeral but still regenerates egress + hot-registers", async () => {
    const h = makeHarness();
    tracked.push(h);
    const draft = await lookup(h);
    const result = await registerExtensionAtRuntime(draft.snapshot, draft.facts.label, {
      catalog: h.deps.catalog,
      snapshotsDir: h.deps.snapshotsDir,
      egressPath: h.deps.egressPath,
      devEgressPath: h.deps.devEgressPath,
      registry: h.deps.registry,
      audit: h.deps.audit,
      actor: "UADA",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message).toContain('Registered "Notion" from the catalog at runtime');
    // The egress regen still ran with the new snapshot (the #232
    // ephemeral mechanics); the live registry still hot-registers.
    expect(readFileSync(h.egressPath, "utf8")).toContain('"mcp.notion.com"');
    expect(h.registry.resolve("notion")).toBeDefined();
  });

  test("an api_key-gated extension registers api_key (the #196 upload path supplies the key)", async () => {
    const h = makeHarness({ records: [ACME_KEY_RECORD], wellKnownStatus: 404 });
    tracked.push(h);
    const draft = await lookup(h, "acme-key");
    const result = await registerExtensionAtRuntime(draft.snapshot, draft.facts.label, { ...h.deps, actor: "UADA" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.oauthGated).toBe(false);
      expect(result.credentialType).toBe("api_key");
    }
    expect(h.runtimeRegistry.rows).toHaveLength(1);
    expect(readFileSync(h.egressPath, "utf8")).toContain('"mcp.acme.example.com"');
    expect(h.registry.resolve("acme-key")).toBeDefined();
  });

  test("an OAuth-gated extension registers and the egress regen SUCCEEDS — domains allowlisted, no oauth_token transform (issue #284)", async () => {
    // Pre-#284 an OAuth extension without a verified token endpoint failed
    // the egress regen loudly. Issue #284: the record carries no token
    // endpoint at all (the SDK owns OAuth via its own RFC 8414 discovery),
    // so the regen always succeeds for an OAuth extension — its domains
    // allowlist and NO transform entry is emitted. The runtime
    // registration lands (the approved durable change) with no warning.
    const h = makeHarness({ records: [OAUTH_ONLY_RECORD], wellKnownStatus: 200 });
    tracked.push(h);
    const draft = await lookup(h, "oauth-only");
    const result = await registerExtensionAtRuntime(draft.snapshot, draft.facts.label, { ...h.deps, actor: "UADA" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes("EGRESS REGEN FAILED"))).toBe(false);
      expect(result.liveRegistry).toBe("registered");
    }
    // The registration is persisted and live.
    expect(h.runtimeRegistry.rows).toHaveLength(1);
    expect(h.registry.resolve("oauth-only")).toBeDefined();
    // The egress allowlist carries the OAuth domain with no mint machinery.
    const egress = readFileSync(h.egressPath, "utf8");
    expect(egress).toContain("mcp.oauth-only.example.com");
    expect(egress).not.toContain("- name: oauth_token");
    expect(egress).not.toContain("oauth-only-oauth.json");
    expect(egress).not.toContain("token_endpoint:");
  });

  test("the registration audit row records the runtime store + egress + live-registry outcome", async () => {
    const h = makeHarness();
    tracked.push(h);
    const draft = await lookup(h);
    await registerExtensionAtRuntime(draft.snapshot, draft.facts.label, { ...h.deps, actor: "UADA", spaceId: "slack:C1" });
    const row = h.auditRows.find((r) => r.event_type === "admin.catalog_browser");
    expect(row?.payload).toMatchObject({
      action: "register",
      spec: "notion",
      via: "connect",
      runtime_registry: "store",
      egress_config: h.egressPath,
      live_registry: "registered",
    });
    expect(row?.actor).toBe("UADA");
  });
});

describe("OAuth discovery carries no token endpoint on the record (issue #284 — the SDK owns OAuth)", () => {
  /** An RFC 8414 authorization-server metadata document (the vendor's own). */
  const AS_METADATA = JSON.stringify({
    issuer: "https://mcp.notion.com",
    authorization_endpoint: "https://mcp.notion.com/authorize",
    token_endpoint: "https://mcp.notion.com/token",
    registration_endpoint: "https://mcp.notion.com/register",
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
  });

  const NOTION_ENTRY: CatalogEntry = {
    id: "mcp/notion",
    slug: "notion",
    name: "Notion",
    kind: "mcp",
    domain: "notion.com",
    url: "https://notion.com/docs/mcp",
  };

  test("an RFC 8414 metadata 200 classifies OAuth-gated WITHOUT extracting a token endpoint (never carried on the record)", async () => {
    // Pre-#284 the discovery extracted the vendor's token_endpoint for the
    // egress mint. Issue #284: the proxy never mints, so the record is
    // endpoint-free — the SDK re-discovers RFC 8414 metadata itself at
    // connect/call time. The 200 on the metadata path is the classification
    // signal only (the endpoint's initialize probe must still pass first).
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === CATALOG_URL) return new Response(catalogDoc([]), { status: 200 });
      if (url === "https://mcp.notion.com/mcp") {
        return new Response(INITIALIZE_RESULT, { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(AS_METADATA, { status: 200 });
    }) as typeof fetch;
    const discovered = await discoverCatalogMcp(NOTION_ENTRY, { fetchImpl });
    expect(discovered.oauthGated).toBe(true);
    expect((discovered as { tokenEndpoint?: string }).tokenEndpoint).toBeUndefined();
  });

  test("the protected-resource metadata 200 classifies OAuth-gated with no follow-hop (issue #284)", async () => {
    // The old discovery followed `authorization_servers` to the AS metadata
    // to extract the token endpoint. Issue #284: any 200 on the well-known
    // paths is the OAuth signal; there is no endpoint extraction hop.
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === CATALOG_URL) return new Response(catalogDoc([]), { status: 200 });
      if (url === "https://mcp.linear.app/mcp") {
        return new Response(INITIALIZE_RESULT, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ resource: "https://mcp.linear.app/mcp", authorization_servers: ["https://mcp.linear.app"] }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const entry: CatalogEntry = { ...NOTION_ENTRY, slug: "linear", domain: "linear.app" };
    const discovered = await discoverCatalogMcp(entry, { fetchImpl });
    expect(discovered.oauthGated).toBe(true);
    expect((discovered as { tokenEndpoint?: string }).tokenEndpoint).toBeUndefined();
  });

  test("lookupCatalogExtension registers an endpoint-free OAuth snapshot (the record carries no token endpoint)", async () => {
    const h = makeHarness({ records: [NOTION_RECORD], wellKnownStatus: 200 });
    tracked.push(h);
    const result = await lookupCatalogExtension("notion", h.deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.manifest.mcp).toEqual({
      serverUrl: "https://mcp.notion.com/mcp",
      transport: "streamable-http",
    });
    expect(result.facts.oauthGated).toBe(true);
    expect((result.facts as { tokenEndpoint?: string }).tokenEndpoint).toBeUndefined();
  });

  test("registerExtensionAtRuntime for an OAuth catalog entry regenerates egress WITHOUT any warning — allowlist only (issue #284)", async () => {
    const h = makeHarness({ records: [NOTION_RECORD], wellKnownStatus: 200 });
    tracked.push(h);
    const lookupResult = await lookupCatalogExtension("notion", h.deps);
    if (!lookupResult.ok) throw new Error(lookupResult.message);
    const draft = lookupResult;
    const result = await registerExtensionAtRuntime(draft.snapshot, draft.facts.label, { ...h.deps, actor: "UADA" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes("EGRESS REGEN FAILED"))).toBe(false);
    }
    const egress = readFileSync(h.egressPath, "utf8");
    expect(egress).toContain("mcp.notion.com");
    expect(egress).not.toContain('token_endpoint: "https://mcp.notion.com/token"');
    expect(egress).not.toContain("notion-oauth.json");
    expect(egress).not.toContain("- name: oauth_token");
    // The persisted store row is endpoint-free too (the durable record).
    const persisted = parsePinnedSnapshot(JSON.stringify(h.runtimeRegistry.rows[0]!));
    expect(persisted.manifest.kind).toBe("mcp");
    if (persisted.manifest.kind !== "mcp") throw new Error("expected an mcp manifest");
    expect((persisted.manifest.mcp as { tokenEndpoint?: string }).tokenEndpoint).toBeUndefined();
  });
});
