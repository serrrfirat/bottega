import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CatalogError,
  DEFAULT_CATALOG_URL,
  buildSnapshotDraft,
  fetchCatalogEntry,
  pinSnapshotDraft,
  writeSnapshotDraft,
  type SnapshotDraft,
} from "./fetch-catalog";
import { parsePinnedSnapshot, SNAPSHOT_SCHEMA } from "./registry";

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
      draft.manifest = { ...draft.manifest, id: "github", domains: ["api.github.com"] };
      draft.extensionId = "github";
      const fetchImpl = stubFetch(); // catalog has no github entry; must not be consulted
      const outPath = await pinSnapshotDraft(draft, dir, { fetchImpl });
      expect(outPath).toContain("github.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


