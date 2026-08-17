import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CatalogError,
  DEFAULT_CATALOG_URL,
  buildSnapshotDraft,
  fetchCatalogEntry,
  listCatalogEntries,
  pinSnapshotDraft,
  writeSnapshotDraft,
  type SnapshotDraft,
} from "./fetch-catalog";
import { parsePinnedSnapshot, SNAPSHOT_SCHEMA } from "./registry";
import type { McpBinding } from "./manifest";

const CATALOG = {
  version: 1,
  generatedAt: "2026-08-16T00:00:00.000Z",
  data: [
    {
      id: "mcp/linear",
      slug: "linear",
      kind: "mcp",
      name: "Linear",
      description: "Manage issues, projects, and team workflows in Linear with natural language.",
      url: "https://linear.app/docs/mcp",
      domain: "linear.app",
    },
  ],
};

/** Stub catalog server: no network in tests. */
function stubFetch(catalog: unknown = CATALOG): typeof fetch {
  return (async () => new Response(JSON.stringify(catalog), { status: 200 })) as unknown as typeof fetch;
}

function completedDraft(overrides: Partial<SnapshotDraft> = {}): SnapshotDraft {
  return {
    schema: SNAPSHOT_SCHEMA,
    extensionId: "linear",
    pinnedAt: "2026-08-16T00:00:00.000Z",
    source: { catalog: DEFAULT_CATALOG_URL, specId: "linear", vendorOfficial: true, reviewed: true },
    manifest: {
      id: "linear",
      label: "Linear",
      vendor: "Linear",
      kind: "mcp",
      mcp: { serverUrl: "https://mcp.linear.app/mcp", transport: "streamable-http" },
      credentialSchema: { type: "oauth", scopes: ["read", "write"] },
      tools: [
        {
          name: "linear.search_issues",
          tier: "read",
          description: "Search Linear issues",
          params: [{ name: "query", type: "string", required: true }],
        },
      ],
      domains: ["mcp.linear.app"],
    },
    ...overrides,
  };
}

describe("fetch-catalog helper (issue #54)", () => {
  test("fetchCatalogEntry resolves an entry by bare slug and by full id", async () => {
    const fetchImpl = stubFetch();
    const bySlug = await fetchCatalogEntry("linear", { fetchImpl });
    expect(bySlug.id).toBe("mcp/linear");
    expect(bySlug.slug).toBe("linear");
    expect(bySlug.name).toBe("Linear");
    expect(bySlug.kind).toBe("mcp");
    expect(bySlug.domain).toBe("linear.app");
    expect(bySlug.url).toBe("https://linear.app/docs/mcp");
    const byId = await fetchCatalogEntry("mcp/linear", { fetchImpl });
    expect(byId.slug).toBe("linear");
  });

  test("fetchCatalogEntry fails closed on unknown specs and broken catalogs", async () => {
    await expect(fetchCatalogEntry("not-a-provider", { fetchImpl: stubFetch() })).rejects.toThrow(
      CatalogError,
    );
    await expect(
      fetchCatalogEntry("linear", { fetchImpl: (async () => new Response("nope", { status: 200 })) as unknown as typeof fetch }),
    ).rejects.toThrow(/not valid JSON/);
    await expect(
      fetchCatalogEntry("linear", { fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 503/);
  });

  test("buildSnapshotDraft freezes provenance and the catalog-derived scaffold", () => {
    const entry = {
      id: "mcp/linear",
      slug: "linear",
      kind: "mcp",
      name: "Linear",
      domain: "linear.app",
      url: "https://linear.app/docs/mcp",
    };
    const draft = buildSnapshotDraft(entry, "2026-08-16T00:00:00.000Z");
    expect(draft.schema).toBe(SNAPSHOT_SCHEMA);
    expect(draft.extensionId).toBe("linear");
    expect(draft.source).toEqual({
      catalog: DEFAULT_CATALOG_URL,
      specId: "linear",
      vendorOfficial: false,
      reviewed: false,
    });
    expect(draft.manifest).toEqual({
      id: "linear",
      label: "Linear",
      vendor: "Linear",
      kind: "mcp",
      domains: ["linear.app"],
    });
  });

  test("writeSnapshotDraft pins a completed draft into the snapshots dir, parseable by the registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-pin-"));
    try {
      const outPath = writeSnapshotDraft(completedDraft(), dir);
      const parsed = parsePinnedSnapshot(readFileSync(outPath, "utf8"));
      expect(parsed.extensionId).toBe("linear");
      expect(parsed.source.specId).toBe("linear");
      expect(parsed.manifest.tools[0].name).toBe("linear.search_issues");
      // A registry seeded from the pinned dir resolves the provider.
      expect(parsePinnedSnapshot(readFileSync(outPath, "utf8"))).toEqual(parsed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeSnapshotDraft refuses an incomplete scaffold draft and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-pin-"));
    try {
      const draft = completedDraft();
      // Drop the completed fields back to the raw scaffold.
      draft.manifest = { id: "linear", label: "Linear", vendor: "Linear", kind: "mcp", domains: ["linear.app"] };
      expect(() => writeSnapshotDraft(draft, dir)).toThrow(/incomplete/);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeSnapshotDraft enforces the review gate for community entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-pin-"));
    try {
      const draft = completedDraft({
        source: { catalog: DEFAULT_CATALOG_URL, specId: "linear", vendorOfficial: false, reviewed: false },
      });
      expect(() => writeSnapshotDraft(draft, dir)).toThrow(/requires explicit review/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pinSnapshotDraft re-checks the catalog for integrations.sh-sourced drafts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-pin-"));
    try {
      const fetchImpl = stubFetch();
      const outPath = await pinSnapshotDraft(completedDraft(), dir, { fetchImpl });
      expect(readFileSync(outPath, "utf8")).toContain('"extensionId": "linear"');

      const unknown = completedDraft({
        source: { catalog: DEFAULT_CATALOG_URL, specId: "ghost", vendorOfficial: true, reviewed: true },
      });
      await expect(pinSnapshotDraft(unknown, dir, { fetchImpl })).rejects.toThrow(/not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pinSnapshotDraft skips the catalog check for non-integrations.sh sources", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-pin-"));
    try {
      const draft = completedDraft({
        source: {
          catalog: "https://github.com/github/github-mcp-server",
          specId: "github-mcp-server",
          vendorOfficial: true,
          reviewed: true,
        },
      });
      draft.manifest = { ...draft.manifest, id: "github", domains: ["api.githubcopilot.com"] };
      draft.extensionId = "github";
      const fetchImpl = stubFetch(); // catalog has no github entry; must not be consulted
      const outPath = await pinSnapshotDraft(draft, dir, { fetchImpl });
      expect(outPath).toContain("github.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pinSnapshotDraft generates tools from tools/list when the draft has an mcp binding but no tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-pin-"));
    try {
      const draft = completedDraft({
        manifest: {
          id: "linear",
          label: "Linear",
          vendor: "Linear",
          kind: "mcp",
          mcp: { serverUrl: "https://mcp.linear.app/mcp", transport: "streamable-http" },
          credentialSchema: { type: "oauth", scopes: ["read", "write"] },
          domains: ["mcp.linear.app"],
          // no tools — the generator must populate them (issue #157)
        },
      });
      const mcpTransport = fakeToolsServer([
        { name: "search_issues", description: "Search Linear issues", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
        { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: {} } },
        { name: "delete_issue", description: "Delete an issue", inputSchema: { type: "object", properties: {} } },
      ]);
      const outPath = await pinSnapshotDraft(draft, dir, { fetchImpl: stubFetch(), mcpTransport });
      const parsed = parsePinnedSnapshot(readFileSync(outPath, "utf8"));
      expect(parsed.manifest.tools.map((tool) => tool.name)).toEqual([
        "linear.search_issues",
        "linear.create_issue",
        "linear.delete_issue",
      ]);
      expect(parsed.manifest.tools.map((tool) => tool.providerName)).toEqual([
        "search_issues",
        "create_issue",
        "delete_issue",
      ]);
      // Conservative tiers: read heuristic → read; mutating → write; destructive → exec.
      expect(parsed.manifest.tools.map((tool) => tool.tier)).toEqual(["read", "write", "exec"]);
      expect(parsed.manifest.tools[0]!.params).toEqual([{ name: "query", type: "string" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the review gate holds: a generated community draft refuses to pin until reviewed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-pin-"));
    try {
      const draft = completedDraft({
        source: { catalog: DEFAULT_CATALOG_URL, specId: "linear", vendorOfficial: false, reviewed: false },
        manifest: {
          id: "linear",
          label: "Linear",
          vendor: "Linear",
          kind: "mcp",
          mcp: { serverUrl: "https://mcp.linear.app/mcp", transport: "streamable-http" },
          credentialSchema: { type: "api_key" },
          domains: ["mcp.linear.app"],
        },
      });
      const mcpTransport = fakeToolsServer([
        { name: "get_issue", description: "Get an issue", inputSchema: { type: "object", properties: {} } },
      ]);
      // Generation succeeds, but the pin still refuses: unreviewed community
      // drafts never register — the generated tiers need the human review.
      await expect(
        pinSnapshotDraft(draft, dir, { fetchImpl: stubFetch(), mcpTransport }),
      ).rejects.toThrow(/requires explicit review/);
      expect(readdirSync(dir)).toEqual([]);

      draft.source = { ...draft.source, reviewed: true };
      const outPath = await pinSnapshotDraft(draft, dir, { fetchImpl: stubFetch(), mcpTransport });
      const parsed = parsePinnedSnapshot(readFileSync(outPath, "utf8"));
      expect(parsed.source.reviewed).toBe(true);
      expect(parsed.manifest.tools.map((tool) => tool.name)).toEqual(["linear.get_issue"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pinSnapshotDraft fails closed when tools/list is unreachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-pin-"));
    try {
      const draft = completedDraft({
        manifest: {
          id: "linear",
          label: "Linear",
          vendor: "Linear",
          kind: "mcp",
          mcp: { serverUrl: "https://mcp.linear.app/mcp", transport: "streamable-http" },
          credentialSchema: { type: "api_key" },
          domains: ["mcp.linear.app"],
        },
      });
      await expect(
        pinSnapshotDraft(draft, dir, {
          fetchImpl: stubFetch(),
          mcpTransport: () => {
            throw new Error("connection refused");
          },
        }),
      ).rejects.toThrow(/tools\/list failed/);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A fake MCP server whose tools/list returns the given wire tools. */
function fakeToolsServer(tools: unknown[]): (binding: McpBinding) => Transport {
  return () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "fake-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    void server.connect(serverTransport);
    return clientTransport;
  };
}

/**
 * Catalog doc: a valid linear entry (with url), a url-less entry (LISTABLE —
 * the live integrations.sh failure mode, issue #118), and one truly
 * unlistable record (missing a renderable field) that must be skipped.
 */
function catalogWithBadEntry(): { version: number; generatedAt: string; data: unknown[] } {
  return {
    version: 1,
    generatedAt: "2026-08-16T00:00:00.000Z",
    data: [
      {
        id: "mcp/linear",
        slug: "linear",
        name: "Linear",
        kind: "mcp",
        domain: "linear.app",
        url: "https://linear.app/docs/mcp",
      },
      {
        id: "mcp/b12",
        slug: "b12-website-generator",
        name: "B12 Website Generator",
        kind: "mcp",
        domain: "b12.io",
        // no url — listable (issue #118); the strict draft/pin paths still reject it
      },
      {
        id: "mcp/broken",
        slug: "broken-entry",
        kind: "mcp",
        domain: "broken.io",
        // no name — truly unlistable (missing a renderable field)
      },
    ],
  };
}

describe("listCatalogEntries resilience (issue #117, #118)", () => {
  test("a url-less record lists fine; only truly unlistable records are skipped", async () => {
    const result = await listCatalogEntries(undefined, { fetchImpl: stubFetch(catalogWithBadEntry()) });
    expect(result.entries.map((e) => e.slug)).toEqual(["linear", "b12-website-generator"]);
    // url is omitted for the url-less entry, never fabricated.
    expect(result.entries[1].url).toBeUndefined();
    expect(result.skipped).toEqual([
      {
        specId: "broken-entry",
        reason: 'catalog fetch failed: entry "broken-entry" is missing a non-empty "name"',
      },
    ]);
  });

  test("a catalog where most entries lack url lists them all with url omitted", async () => {
    const data = Array.from({ length: 5 }, (_, i) => ({
      id: `mcp/spec${i}`,
      slug: `spec${i}`,
      name: `Spec ${i}`,
      kind: "mcp",
      domain: `spec${i}.example.com`,
      ...(i === 0 ? { url: `https://spec${i}.example.com/docs` } : {}), // only spec0 has url
    }));
    const result = await listCatalogEntries(undefined, {
      fetchImpl: stubFetch({ version: 1, generatedAt: "2026-08-16T00:00:00.000Z", data }),
    });
    expect(result.entries).toHaveLength(5);
    expect(result.skipped).toEqual([]);
    expect(result.entries[0].url).toBe("https://spec0.example.com/docs");
    expect(result.entries[1].url).toBeUndefined();
  });

  test("the query filters valid entries only; skipped records stay surfaced", async () => {
    const result = await listCatalogEntries("linear", { fetchImpl: stubFetch(catalogWithBadEntry()) });
    expect(result.entries.map((e) => e.slug)).toEqual(["linear"]);
    expect(result.skipped).toHaveLength(1);
    // A query matching only the unlistable record still surfaces it as skipped, not as an entry.
    const none = await listCatalogEntries("broken-entry", { fetchImpl: stubFetch(catalogWithBadEntry()) });
    expect(none.entries).toEqual([]);
    expect(none.skipped).toHaveLength(1);
  });

  test("a malformed catalog document still fails closed", async () => {
    await expect(listCatalogEntries(undefined, { fetchImpl: stubFetch({ version: 1 }) })).rejects.toThrow(/no data array/);
    await expect(
      listCatalogEntries(undefined, {
        fetchImpl: (async () => new Response("<html>not json</html>", { status: 200 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  test("direct single-entry fetch of a malformed spec still fails closed", async () => {
    await expect(fetchCatalogEntry("b12-website-generator", { fetchImpl: stubFetch(catalogWithBadEntry()) })).rejects.toThrow(
      /missing a non-empty "url"/,
    );
  });
});


