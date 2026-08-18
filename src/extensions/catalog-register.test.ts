/**
 * Issue #232 acceptance (seam tier): the catalog registration seam the
 * connect path invokes for an UNREGISTERED extension — deterministic
 * lookup → draft (catalog record + official hosted MCP endpoint discovery
 * + auth classification) → review gate (register_extension) → pin +
 * egress regen + hot-register. Red on pre-fix: the seam does not exist
 * before #232 (the connect path had no catalog fallback).
 *
 * The gateway tests (caller surface) live in space-service.test.ts /
 * connect.test.ts — this file pins the seam's own contracts: the auth
 * classification never guesses, an unknown spec fails loudly with the
 * browse path, the review gate is MANDATORY (a denied gate pins nothing),
 * and an approved gate pins a parsePinnedSnapshot-valid snapshot, lands
 * the domains in the regenerated (byte-pinned) egress configs, and
 * hot-registers into the live registry.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogError, DEFAULT_CATALOG_URL, type CatalogEntry } from "./fetch-catalog";
import { createExtensionRegistry, parsePinnedSnapshot, type ExtensionRegistry } from "./registry";
import { DenyRouter, type ApprovalRequest, type ApprovalResolution, type ApprovalRouter } from "../policy/approval-router";
import { parseOrgConfigYaml } from "../policy/config";
import {
  CATALOG_REGISTER_TOOL,
  discoverCatalogMcp,
  registerExtensionFromCatalog,
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

function catalogDoc(records: unknown[]): string {
  return JSON.stringify({ version: 1, generatedAt: "2026-08-18T00:00:00.000Z", data: records });
}

/**
 * Routes the catalog document to the stub doc and every other URL (the
 * well-known discovery probes) to the given status — hermetic, no network.
 */
function stubFetch(records: unknown[], wellKnownStatus: number): typeof fetch {
  // SAFETY: the stub implements fetch's call contract; Bun's fetch also
  // exposes fetch.preconnect, which the catalog client never calls.
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === CATALOG_URL) return new Response(catalogDoc(records), { status: 200 });
    return new Response("", { status: wellKnownStatus });
  }) as typeof fetch;
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

class RecordingRouter implements ApprovalRouter {
  readonly requests: ApprovalRequest[] = [];
  constructor(private resolution: ApprovalResolution = { approved: true }) {}
  async request(d: ApprovalRequest): Promise<ApprovalResolution> {
    this.requests.push(d);
    return this.resolution;
  }
}

interface Harness {
  deps: Parameters<typeof registerExtensionFromCatalog>[0];
  router: RecordingRouter;
  snapshotsDir: string;
  egressPath: string;
  devEgressPath: string;
  registry: ExtensionRegistry;
  auditRows: Array<{ actor: string; event_type: string; payload: unknown }>;
  dir: string;
}

function makeHarness(opts: { router?: ApprovalRouter; records?: unknown[]; wellKnownStatus?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bottega-catalog-register-"));
  const snapshotsDir = join(dir, "extensions");
  const egressPath = join(dir, "egress.yml");
  const devEgressPath = join(dir, "egress.dev.yml");
  // The RECORDING router is always present (the gate's effective router is
  // the override when one is given — e.g. DenyRouter for the deny tests).
  const recording = new RecordingRouter();
  const router: ApprovalRouter = opts.router ?? recording;
  const auditRows: Array<{ actor: string; event_type: string; payload: unknown }> = [];
  const audit = {
    appendAudit: async (entry: { actor: string; event_type: string; payload: unknown }) => {
      auditRows.push(entry);
      return auditRows.length;
    },
    listAudit: async () => [],
  };
  const registry = createExtensionRegistry(snapshotsDir);
  const deps = {
    extensionId: "notion",
    actor: "UADA",
    spaceId: undefined as string | undefined,
    registry,
    audit,
    gate: {
      loadPolicy: () =>
        Promise.resolve(parseOrgConfigYaml("tools:\n  register_extension: allow\n")),
      router,
    },
    catalog: { fetchImpl: stubFetch(opts.records ?? [NOTION_RECORD], opts.wellKnownStatus ?? 200) },
    snapshotsDir,
    egressPath,
    devEgressPath,
  };
  return { deps, router: recording, snapshotsDir, egressPath, devEgressPath, registry, auditRows, dir };
}

// The harness dirs are tracked after creation so cleanup is deterministic.
const tracked: Harness[] = [];
afterEach(() => {
  for (const h of tracked.splice(0)) rmSync(h.dir, { recursive: true, force: true });
});

describe("discoverCatalogMcp (issue #232) — deterministic official MCP endpoint + auth classification", () => {
  const entry: CatalogEntry = {
    id: "mcp/linear",
    slug: "linear",
    name: "Linear",
    kind: "mcp",
    domain: "linear.app",
    url: "https://linear.app/docs/mcp",
  };

  test("the official hosted MCP endpoint derives from the vendor domain: https://mcp.<domain>/mcp", async () => {
    // The pinned hosted providers all follow the convention (linear →
    // mcp.linear.app/mcp, attio → mcp.attio.com/mcp, notion →
    // mcp.notion.com/mcp) — the discovery derives the candidate from the
    // catalog record's OWN domain, never a community URL.
    const discovered = await discoverCatalogMcp(entry, { fetchImpl: stubFetch([], 404) });
    expect(discovered.serverUrl).toBe("https://mcp.linear.app/mcp");
    expect(discovered.host).toBe("mcp.linear.app");
    expect(discovered.transport).toBe("streamable-http");
  });

  test("an MCP OAuth resource-metadata document (RFC 8414) classifies the server OAuth-gated", async () => {
    const discovered = await discoverCatalogMcp(entry, { fetchImpl: stubFetch([], 200) });
    expect(discovered.oauthGated).toBe(true);
    expect(discovered.credentialSchema).toEqual({ type: "oauth" });
  });

  test("the authorization-server metadata is the fallback OAuth signal", async () => {
    // Only the SECOND well-known path returns 200 — the discovery probes
    // both the protected-resource and the authorization-server metadata.
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === CATALOG_URL) return new Response(catalogDoc([]), { status: 200 });
      return new Response("", { status: url.includes("oauth-authorization-server") ? 200 : 404 });
    }) as typeof fetch;
    const discovered = await discoverCatalogMcp(entry, { fetchImpl });
    expect(discovered.oauthGated).toBe(true);
    expect(discovered.credentialSchema).toEqual({ type: "oauth" });
  });

  test("no OAuth metadata → api_key (the key is supplied at connect; never a guessed OAuth)", async () => {
    const discovered = await discoverCatalogMcp(entry, { fetchImpl: stubFetch([], 404) });
    expect(discovered.oauthGated).toBe(false);
    expect(discovered.credentialSchema).toEqual({ type: "api_key" });
  });

  test("an unreachable metadata probe fails loudly — the endpoint is never guessed", async () => {
    await expect(discoverCatalogMcp(entry, { fetchImpl: throwingFetch() })).rejects.toThrow(CatalogError);
    await expect(discoverCatalogMcp(entry, { fetchImpl: stubFetch([], 503) })).rejects.toThrow(CatalogError);
  });

  test("a domain that is already the MCP host is not double-prefixed", async () => {
    const mcpDomain: CatalogEntry = { ...entry, domain: "mcp.attio.com" };
    const discovered = await discoverCatalogMcp(mcpDomain, { fetchImpl: stubFetch([], 404) });
    expect(discovered.serverUrl).toBe("https://mcp.attio.com/mcp");
  });
});

describe("registerExtensionFromCatalog (issue #232) — lookup → draft → gate → pin → egress → hot-register", () => {
  function harness(opts: Parameters<typeof makeHarness>[0] = {}): Harness {
    const h = makeHarness(opts);
    tracked.push(h);
    return h;
  }

  test("an unknown spec fails loudly with the catalog browse path and pins nothing", async () => {
    const h = harness({ records: [] });
    const result = await registerExtensionFromCatalog({ ...h.deps, extensionId: "nope.xyz" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('unknown extension "nope.xyz"');
      expect(result.message).toContain("no extension or catalog entry");
      expect(result.message).toContain("catalog_browser");
    }
    // The lookup failed BEFORE the review gate: no approval was requested
    // and nothing was written.
    expect(h.router.requests).toHaveLength(0);
    expect(existsSync(join(h.snapshotsDir, "nope.xyz.json"))).toBe(false);
    expect(h.registry.resolve("nope.xyz")).toBeUndefined();
  });

  test("the review gate is MANDATORY — a denied gate pins nothing", async () => {
    const h = harness({ router: DenyRouter });
    const result = await registerExtensionFromCatalog(h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("policy: approval denied");
    expect(existsSync(join(h.snapshotsDir, "notion.json"))).toBe(false);
    expect(h.registry.resolve("notion")).toBeUndefined();
  });

  test("the gate request surfaces the draft: id, vendor, kind, domains, MCP endpoint", async () => {
    const h = harness();
    await registerExtensionFromCatalog(h.deps);
    expect(h.router.requests).toHaveLength(1);
    const request = h.router.requests[0]!;
    expect(request.tool).toBe(CATALOG_REGISTER_TOOL);
    expect(request.spaceId).toBe("");
    expect(request.args).toEqual({
      action: "register_from_catalog",
      extension: "notion",
      vendor: "Notion",
      kind: "mcp",
      domains: ["notion.com", "mcp.notion.com"],
      mcpEndpoint: "https://mcp.notion.com/mcp",
      credentialSchema: { type: "oauth" },
    });
  });

  test("approve pins a parsePinnedSnapshot-valid snapshot, regenerates egress, and hot-registers", async () => {
    const h = harness();
    const result = await registerExtensionFromCatalog(h.deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.extensionId).toBe("notion");
      expect(result.liveRegistry).toBe("registered");
      expect(result.oauthGated).toBe(true);
      expect(result.credentialType).toBe("oauth");
      expect(result.message).toContain('Pinned "Notion" from the catalog');
      expect(result.pinnedPath).toBe(join(h.snapshotsDir, "notion.json"));
    }

    // The pinned snapshot is registry-valid and reviewed (the human
    // approval IS the review — the #231 notion shape: OAuth + tools-less).
    const snapshot = parsePinnedSnapshot(readFileSync(join(h.snapshotsDir, "notion.json"), "utf8"));
    expect(snapshot.extensionId).toBe("notion");
    expect(snapshot.source.reviewed).toBe(true);
    expect(snapshot.source.vendorOfficial).toBe(true);
    expect(snapshot.source.catalog).toBe(CATALOG_URL);
    expect(snapshot.source.specId).toBe("notion");
    expect(snapshot.manifest.kind).toBe("mcp");
    expect(snapshot.manifest.mcp).toEqual({ serverUrl: "https://mcp.notion.com/mcp", transport: "streamable-http" });
    expect(snapshot.manifest.credentialSchema).toEqual({ type: "oauth" });
    // Tools-less (issue #158): the surface is discovered at runtime from
    // the provider's tools/list with conservative tiers.
    expect(snapshot.manifest.tools).toBeUndefined();
    expect(snapshot.manifest.domains).toEqual(["notion.com", "mcp.notion.com"]);

    // Egress regenerated (byte-pinned): the vendor host AND the MCP host
    // are allowlisted.
    const egress = readFileSync(h.egressPath, "utf8");
    expect(egress).toContain('"mcp.notion.com"');
    expect(egress).toContain('"notion.com"');
    expect(existsSync(h.devEgressPath)).toBe(true);
    expect(readFileSync(h.devEgressPath, "utf8")).toContain("mcp.notion.com");

    // Hot-registered: the LIVE registry resolves the extension immediately.
    expect(h.registry.resolve("notion")?.manifest.id).toBe("notion");
  });

  test("an api_key-gated extension pins api_key (the #196 upload path supplies the key)", async () => {
    const h = harness({ records: [ACME_KEY_RECORD], wellKnownStatus: 404 });
    const result = await registerExtensionFromCatalog({ ...h.deps, extensionId: "acme-key" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.oauthGated).toBe(false);
      expect(result.credentialType).toBe("api_key");
    }
    const snapshot = parsePinnedSnapshot(readFileSync(join(h.snapshotsDir, "acme-key.json"), "utf8"));
    expect(snapshot.manifest.credentialSchema).toEqual({ type: "api_key" });
    expect(snapshot.manifest.domains).toEqual(["acme.example.com", "mcp.acme.example.com"]);
    expect(readFileSync(h.egressPath, "utf8")).toContain('"mcp.acme.example.com"');
    expect(h.registry.resolve("acme-key")).toBeDefined();
  });

  test("an OAuth extension without a verified token endpoint pins but surfaces the egress failure loudly", async () => {
    // OAUTH_TOKEN_ENDPOINTS (src/egress/generate.ts) has no "oauth-only"
    // entry → regeneration fails closed (never a guessed token endpoint).
    // The pin still lands (the approved durable change), and the failure is
    // LOUD in the result — never silent drift.
    const h = harness({ records: [OAUTH_ONLY_RECORD], wellKnownStatus: 200 });
    const result = await registerExtensionFromCatalog({ ...h.deps, extensionId: "oauth-only" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes("EGRESS REGEN FAILED"))).toBe(true);
      expect(result.liveRegistry).toBe("registered");
    }
    expect(existsSync(join(h.snapshotsDir, "oauth-only.json"))).toBe(true);
    expect(h.registry.resolve("oauth-only")).toBeDefined();
  });

  test("a denied gate records the ask-human trail and never touches egress", async () => {
    const h = harness({ router: DenyRouter });
    await registerExtensionFromCatalog(h.deps);
    const decision = h.auditRows.find((row) => row.event_type === "policy.decision");
    expect(decision?.payload).toMatchObject({ tool: CATALOG_REGISTER_TOOL, decision: "ask-human" });
    expect(h.auditRows.some((row) => row.event_type === "approval.requested")).toBe(true);
    const resolved = h.auditRows.find((row) => row.event_type === "approval.resolved");
    expect(resolved?.payload).toMatchObject({ approved: false });
    expect(existsSync(h.egressPath)).toBe(false);
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
    const result = await registerExtensionFromCatalog({ ...h.deps, extensionId: "acme-cli" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("kind \"cli\"");
      expect(result.message).toContain("catalog_browser");
    }
    expect(h.router.requests).toHaveLength(0);
    expect(existsSync(join(h.snapshotsDir, "acme-cli.json"))).toBe(false);
  });

  test("the pin audit row records the egress configs and the live-registry outcome", async () => {
    const h = harness();
    const result = await registerExtensionFromCatalog(h.deps);
    expect(result.ok).toBe(true);
    const pinRow = h.auditRows.find((row) => row.event_type === "admin.catalog_browser");
    expect(pinRow?.payload).toMatchObject({
      action: "pin",
      spec: "notion",
      via: "connect",
      egress_config: h.egressPath,
      live_registry: "registered",
    });
  });
});

