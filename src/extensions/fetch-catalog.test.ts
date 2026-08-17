import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createExtensionRegistry, parsePinnedSnapshot, SNAPSHOT_SCHEMA } from "./registry";

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

/** Catalog document the stub serves — malformed docs exercise the fail-closed paths. */
interface StubCatalogDoc {
  version: number;
  generatedAt?: string;
  data?: unknown[];
}

/** Stub catalog server: no network in tests. */
function stubFetch(catalog: StubCatalogDoc = CATALOG): typeof fetch {
  // SAFETY: the stub implements fetch's call contract (input, init?) => Promise<Response>;
  // Bun's fetch also exposes fetch.preconnect, which the catalog client never calls.
  return (async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(catalog), { status: 200 })) as typeof fetch;
}

/** Raw-response fetch stub: serves exactly the given body/status (malformed-catalog cases). */
function stubResponse(body: string, status: number): typeof fetch {
  // SAFETY: the stub implements fetch's call contract (input, init?) => Promise<Response>;
  // Bun's fetch also exposes fetch.preconnect, which the catalog client never calls.
  return (async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(body, { status })) as typeof fetch;
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
      fetchCatalogEntry("linear", { fetchImpl: stubResponse("nope", 200) }),
    ).rejects.toThrow(/not valid JSON/);
    await expect(
      fetchCatalogEntry("linear", { fetchImpl: stubResponse("", 503) }),
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
      expect(parsed.manifest.tools![0].name).toBe("linear.search_issues");
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

  test("a tools-less mcp draft pins tools-less (no generation) — runtime discovery is the default (issue #158)", async () => {
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
          // no tools — the pin must NOT fabricate a surface; the runtime
          // discovers it from the provider's tools/list (issue #158)
        },
      });
      // A tools-less manifest pins tools-less: the pin path is pure
      // configuration (there is no transport seam on it at all), and the
      // runtime discovers the surface from the provider's tools/list.
      const outPath = await pinSnapshotDraft(draft, dir, { fetchImpl: stubFetch() });
      const parsed = parsePinnedSnapshot(readFileSync(outPath, "utf8"));
      expect(parsed.manifest.tools).toBeUndefined();
      expect(parsed.manifest.mcp).toEqual({ serverUrl: "https://mcp.linear.app/mcp", transport: "streamable-http" });
      // A registry seeded from the pinned dir resolves the tools-less
      // manifest — the surface resolves at runtime, not at pin time.
      const registry = createExtensionRegistry(dir);
      expect(registry.resolve("linear")?.manifest.tools).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the review gate holds on tools-less community drafts: unreviewed refuses to pin (issue #158)", async () => {
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
      // The pin still refuses: unreviewed community drafts never register —
      // the discovered conservative tiers need the human review.
      await expect(pinSnapshotDraft(draft, dir, { fetchImpl: stubFetch() })).rejects.toThrow(
        /requires explicit review/,
      );
      expect(readdirSync(dir)).toEqual([]);

      draft.source = { ...draft.source, reviewed: true };
      const outPath = await pinSnapshotDraft(draft, dir, { fetchImpl: stubFetch() });
      const parsed = parsePinnedSnapshot(readFileSync(outPath, "utf8"));
      expect(parsed.source.reviewed).toBe(true);
      expect(parsed.manifest.tools).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Catalog doc: a valid linear entry (with url), a url-less entry (LISTABLE —
 * the live integrations.sh failure mode, issue #118), and one truly
 * unlistable record (missing a renderable field) that must be skipped.
 */
function catalogWithBadEntry() {
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
      ...(i === 0 ? { url: `https://spec${i}.example.com/docs` } : undefined), // only spec0 has url
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
        fetchImpl: stubResponse("<html>not json</html>", 200),
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  test("direct single-entry fetch of a malformed spec still fails closed", async () => {
    await expect(fetchCatalogEntry("b12-website-generator", { fetchImpl: stubFetch(catalogWithBadEntry()) })).rejects.toThrow(
      /missing a non-empty "url"/,
    );
  });
});


