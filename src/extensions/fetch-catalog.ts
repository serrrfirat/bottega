/**
 * Catalog fetch helper (issue #54): turns an integrations.sh catalog entry
 * into a pinned snapshot for `config/extensions/<id>.json` (#50 format).
 *
 * The registry NEVER fetches at runtime — per-org deployments resolve the
 * pinned files only (server/index.ts seeds the registry at boot). This
 * module is the human step that PINS a new provider: fetch the catalog
 * record, print the snapshot draft (provenance + catalog-derived manifest
 * scaffold), then `--pin` the completed draft once a maintainer has filled
 * in the binding facts (mcp/cli, credentialSchema, tools) from vendor docs
 * and marked source.reviewed / source.vendorOfficial.
 *
 * The catalog record never carries an MCP/CLI binding, so the agent draft
 * flow (catalog_browser) instructs web-searching the vendor's OFFICIAL MCP
 * server and filling the scaffold from the vendor's published spec (issue
 * #146); the pin/review gate is unchanged.
 *
 * Why the draft is never written directly: the catalog record carries only
 * id/slug/name/kind/domain/url — not the MCP endpoint, auth, or tool
 * surface. A scaffold manifest therefore fails validateManifest (fail
 * closed), so `--pin` refuses to leave a broken file in the live snapshots
 * dir; it validates with parsePinnedSnapshot before writing.
 *
 * CLI:
 *   bun run src/extensions/fetch-catalog.ts <specId>            # print draft
 *   bun run src/extensions/fetch-catalog.ts <specId> --out DIR  # write draft to DIR
 *   bun run src/extensions/fetch-catalog.ts --generate-tools <draft.json> [--out DIR]
 *                                    # populate manifest.tools from the provider's
 *                                    # tools/list (issue #157); on a pinned manifest
 *                                    # this REFRESHES it — new tools land for review,
 *                                    # never silently
 *   bun run src/extensions/fetch-catalog.ts --pin <draft.json>  # validate + pin
 *
 * Env override: INTEGRATIONS_CATALOG_URL (mirrors the test seam; the
 * registry's own tests use a stub fetch).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { generateManifestTools, refreshManifestTools } from "./generate-tools";
import {
  parsePinnedSnapshot,
  SNAPSHOT_SCHEMA,
  type PinnedSnapshot,
  type SnapshotSource,
} from "./registry";
import {
  ExtensionValidationError,
  validateManifest,
  type CliBinding,
  type CredentialSchema,
  type ExtensionKind,
  type ExtensionTool,
  type McpBinding,
} from "./manifest";

/** The integrations.sh catalog (REST; a JSON document at /api.json). */
export const DEFAULT_CATALOG_URL = "https://integrations.sh/api.json";

export class CatalogError extends Error {
  constructor(message: string) {
    super(`catalog fetch failed: ${message}`);
    this.name = "CatalogError";
  }
}

/** One integrations.sh catalog record (subset of the full entry). */
export interface CatalogEntry {
  /** Catalog id, e.g. "mcp/linear". */
  id: string;
  /** Short id, e.g. "linear". */
  slug: string;
  name: string;
  /** Catalog kind: "mcp" | "cli" | "openapi" | "graphql" | "discovered". */
  kind: string;
  /** Provider hostname the entry points at, e.g. "linear.app". */
  domain: string;
  /**
   * Vendor documentation URL. OPTIONAL for listing — the live integrations.sh
   * catalog omits it for most entries (issue #118). Required by the strict
   * draft/pin paths (`fetchCatalogEntry`, `pinSnapshotDraft`).
   */
  url?: string;
  description?: string;
}

export interface FetchCatalogOptions {
  catalogUrl?: string;
  /** Test seam: default is global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * A snapshot DRAFT: full provenance pinned now, plus the manifest scaffold
 * the catalog record supports. Binding/credentialSchema/tools are filled in
 * by a maintainer from vendor docs before `pinSnapshotDraft` accepts it.
 */
export interface SnapshotDraft {
  schema: typeof SNAPSHOT_SCHEMA;
  extensionId: string;
  pinnedAt: string;
  source: SnapshotSource;
  manifest: {
    id: string;
    label: string;
    vendor: string;
    kind: ExtensionKind;
    domains: string[];
    mcp?: McpBinding;
    cli?: CliBinding;
    credentialSchema?: CredentialSchema;
    tools?: ExtensionTool[];
  };
}

/**
 * Fetches the catalog and returns the entry whose slug or id matches
 * `specId` (id may be "mcp/linear" or the bare slug "linear"). Throws
 * {@link CatalogError} when the catalog is unreachable or the spec is not
 * in it — pinning must never guess.
 */
/**
 * Fetches and validates the catalog document (shared by the single-entry
 * lookup and the browser's list). Throws {@link CatalogError} on any
 * unreachable/malformed catalog — never guesses.
 */
async function fetchCatalogDoc(opts: FetchCatalogOptions): Promise<Record<string, unknown>[]> {
  const catalogUrl = opts.catalogUrl ?? process.env.INTEGRATIONS_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let body: string;
  try {
    const response = await fetchImpl(catalogUrl);
    if (!response.ok) {
      throw new CatalogError(`GET ${catalogUrl} -> HTTP ${response.status}`);
    }
    body = await response.text();
  } catch (err) {
    if (err instanceof CatalogError) throw err;
    throw new CatalogError(`GET ${catalogUrl} failed: ${(err as Error).message}`);
  }
  let doc: { data?: unknown };
  try {
    doc = JSON.parse(body) as { data?: unknown };
  } catch {
    throw new CatalogError(`catalog at ${catalogUrl} is not valid JSON`);
  }
  if (!Array.isArray(doc.data)) {
    throw new CatalogError(`catalog at ${catalogUrl} has no data array`);
  }
  return doc.data as Record<string, unknown>[];
}

/**
 * STRICT record validation for the draft/pin paths: requires every field
 * including `url` — an explicitly requested or pinned entry must have
 * complete provenance. Throws {@link CatalogError} on malformed records.
 */
function parseCatalogRecord(record: Record<string, unknown>): CatalogEntry {
  const specId = typeof record["slug"] === "string" ? record["slug"] : String(record["id"] ?? "?");
  for (const field of ["id", "slug", "name", "kind", "domain", "url"] as const) {
    if (typeof record[field] !== "string" || record[field].trim() === "") {
      throw new CatalogError(`entry "${specId}" is missing a non-empty "${field}"`);
    }
  }
  return {
    id: record["id"] as string,
    slug: record["slug"] as string,
    name: record["name"] as string,
    kind: record["kind"] as string,
    domain: record["domain"] as string,
    url: record["url"] as string,
    ...(typeof record["description"] === "string" ? { description: record["description"] } : {}),
  };
}

/**
 * LENIENT record validation for LISTING (issue #118): a record is listable
 * with id/slug/name/kind/domain — `url` is NOT required (the live catalog
 * omits it for most entries) and is included only when present, never
 * fabricated. Truly unlistable records (missing a renderable field) throw
 * {@link CatalogError}.
 */
function parseListableRecord(record: Record<string, unknown>): CatalogEntry {
  const specId = typeof record["slug"] === "string" ? record["slug"] : String(record["id"] ?? "?");
  for (const field of ["id", "slug", "name", "kind", "domain"] as const) {
    if (typeof record[field] !== "string" || record[field].trim() === "") {
      throw new CatalogError(`entry "${specId}" is missing a non-empty "${field}"`);
    }
  }
  return {
    id: record["id"] as string,
    slug: record["slug"] as string,
    name: record["name"] as string,
    kind: record["kind"] as string,
    domain: record["domain"] as string,
    ...(typeof record["url"] === "string" && record["url"].trim() !== ""
      ? { url: record["url"] as string }
      : {}),
    ...(typeof record["description"] === "string" ? { description: record["description"] } : {}),
  };
}

export async function fetchCatalogEntry(
  specId: string,
  opts: FetchCatalogOptions = {},
): Promise<CatalogEntry> {
  const catalogUrl = opts.catalogUrl ?? process.env.INTEGRATIONS_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  const entry = (await fetchCatalogDoc(opts)).find(
    (record) => record["slug"] === specId || record["id"] === specId,
  );
  if (entry === undefined) {
    throw new CatalogError(`spec "${specId}" not found in ${catalogUrl}`);
  }
  return parseCatalogRecord(entry);
}

/** Result of a catalog listing: valid entries plus surfaced malformed-record diagnostics. */
export interface CatalogListResult {
  entries: CatalogEntry[];
  /** Malformed records skipped from `entries` — surfaced, never silently dropped (issue #117). */
  skipped: Array<{ specId: string; reason: string }>;
}

/**
 * Lists the whole catalog, optionally filtered by `query` (case-insensitive
 * substring match against name, slug, id, kind, and domain). Throws
 * {@link CatalogError} when the catalog DOCUMENT is unreachable or malformed
 * (never guesses). Records are validated LENIENTLY for listing: id/slug/name/
 * kind/domain suffice, `url` is optional (issue #118). Truly unlistable
 * records are SKIPPED and surfaced in `skipped` — one bad vendor entry must
 * not take down the whole list (issue #117); a record-level problem is never
 * a silent drop.
 */
export async function listCatalogEntries(
  query?: string,
  opts: FetchCatalogOptions = {},
): Promise<CatalogListResult> {
  const records = await fetchCatalogDoc(opts);
  const entries: CatalogEntry[] = [];
  const skipped: CatalogListResult["skipped"] = [];
  for (const record of records) {
    try {
      entries.push(parseListableRecord(record));
    } catch (err) {
      if (err instanceof CatalogError) {
        const specId = typeof record["slug"] === "string" ? record["slug"] : String(record["id"] ?? "?");
        skipped.push({ specId, reason: err.message });
        continue;
      }
      throw err;
    }
  }
  const needle = query?.trim().toLowerCase();
  if (needle) {
    return {
      entries: entries.filter((entry) =>
        [entry.name, entry.slug, entry.id, entry.kind, entry.domain].some((field) =>
          field.toLowerCase().includes(needle),
        ),
      ),
      skipped,
    };
  }
  return { entries, skipped };
}

/**
 * Builds the snapshot draft from a catalog entry: pinnedAt = now,
 * source = the catalog provenance (unverified until a maintainer reviews),
 * manifest scaffold = the catalog-derived fields only. The scaffold is NOT
 * registry-valid (no binding yet) by design.
 */
export function buildSnapshotDraft(entry: CatalogEntry, pinnedAt: string = new Date().toISOString()): SnapshotDraft {
  const kind: ExtensionKind = entry.kind === "mcp" ? "mcp" : entry.kind === "cli" ? "cli" : "mcp";
  return {
    schema: SNAPSHOT_SCHEMA,
    extensionId: entry.slug,
    pinnedAt,
    source: {
      catalog: DEFAULT_CATALOG_URL,
      specId: entry.slug,
      vendorOfficial: false,
      reviewed: false,
    },
    manifest: {
      id: entry.slug,
      label: entry.name,
      vendor: entry.name,
      kind,
      domains: [entry.domain],
    },
  };
}

function completeManifest(draft: SnapshotDraft): PinnedSnapshot["manifest"] {
  if (
    draft.manifest.mcp === undefined &&
    draft.manifest.cli === undefined &&
    draft.manifest.credentialSchema === undefined &&
    draft.manifest.tools === undefined
  ) {
    throw new ExtensionValidationError(
      `draft for "${draft.extensionId}" is incomplete: add the binding and credentialSchema ` +
        "from the vendor docs (see the catalog entry url) before pinning; manifest tools are " +
        "generated from the provider's tools/list (fetch-catalog --generate-tools, issue #157)",
    );
  }
  return validateManifest(draft.manifest);
}

/**
 * Writes a COMPLETED draft to `outDir/<extensionId>.json` as a pinned
 * snapshot. Fails closed: the draft is validated with parsePinnedSnapshot
 * (schema marker, id match, manifest, review gate) and nothing is written
 * when it is malformed — a broken file would fail the registry load.
 * Returns the written path.
 */
export function writeSnapshotDraft(draft: SnapshotDraft, outDir: string): string {
  const manifest = completeManifest(draft);
  const snapshot: PinnedSnapshot = {
    schema: SNAPSHOT_SCHEMA,
    extensionId: draft.extensionId,
    pinnedAt: draft.pinnedAt,
    source: draft.source,
    manifest,
  };
  // Throws on any malformed field; also enforces the review gate.
  parsePinnedSnapshot(JSON.stringify(snapshot, null, 2));
  const outPath = resolve(outDir, `${draft.extensionId}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n");
  return outPath;
}

/**
 * Options for the pin path: the catalog fetch seams plus the MCP transport
 * seam the manifest tool generator uses for tools/list discovery (issue
 * #157). Tests inject in-memory transports; production uses the real
 * streamable-http / stdio transports.
 */
export interface PinDraftOptions extends FetchCatalogOptions {
  mcpTransport?: (binding: McpBinding) => Transport;
}

/**
 * Pins a completed draft into the snapshots dir. Re-fetches the catalog to
 * confirm the spec still exists when the draft's source.catalog is the
 * integrations.sh catalog (provenance check); drafts sourced elsewhere
 * (e.g. the github-mcp-server vendor repo) skip the check — their catalog
 * is the human's responsibility. Returns the written path.
 *
 * Issue #157: a draft WITH an mcp binding but no tools gets its manifest
 * tools generated from the provider's tools/list before the pin — the
 * manifest is never pinned half-populated. Fail closed: an unreachable
 * provider or an invalid tools/list aborts the pin. The review gate is
 * unchanged: the generated draft still carries source.reviewed=false and
 * community drafts refuse to pin until a human reviews (and confirms the
 * conservative tiers).
 */
export async function pinSnapshotDraft(
  draft: SnapshotDraft,
  outDir: string,
  opts: PinDraftOptions = {},
): Promise<string> {
  if (draft.source.catalog === DEFAULT_CATALOG_URL) {
    await fetchCatalogEntry(draft.source.specId, opts);
  }
  if (
    draft.manifest.kind === "mcp" &&
    draft.manifest.mcp !== undefined &&
    (draft.manifest.tools === undefined || draft.manifest.tools.length === 0)
  ) {
    const generation = await generateManifestTools({
      binding: draft.manifest.mcp,
      extensionId: draft.extensionId,
      mcpTransport: opts.mcpTransport,
    });
    draft = { ...draft, manifest: { ...draft.manifest, tools: generation.tools } };
  }
  return writeSnapshotDraft(draft, outDir);
}

if (import.meta.main) {
  const [first, second, third, fourth] = process.argv.slice(2);
  if (first === "--pin") {
    if (!second) {
      console.error("usage: bun run src/extensions/fetch-catalog.ts --pin <draft.json>");
      process.exit(1);
    }
    const draft = JSON.parse(readFileSync(resolve(second), "utf8")) as SnapshotDraft;
    pinSnapshotDraft(draft, "config/extensions")
      .then((path) => console.log(`pinned ${path}`))
      .catch((err: Error) => {
        console.error(err.message);
        process.exit(1);
      });
  } else if (first === "--generate-tools") {
    if (!second) {
      console.error("usage: bun run src/extensions/fetch-catalog.ts --generate-tools <draft.json> [--out DIR]");
      process.exit(1);
    }
    const filePath = resolve(second);
    const doc = JSON.parse(readFileSync(filePath, "utf8")) as SnapshotDraft;
    if (doc.manifest.kind !== "mcp" || doc.manifest.mcp === undefined) {
      console.error(
        `cannot generate tools from "${second}": it has no mcp binding — tools/list discovery requires a ` +
          "streamable-http or stdio binding (fill the binding first)",
      );
      process.exit(1);
    }
    generateManifestTools({ binding: doc.manifest.mcp, extensionId: doc.extensionId })
      .then((generation) => {
        const existing = doc.manifest.tools ?? [];
        const refreshed =
          existing.length === 0
            ? { tools: generation.tools, added: generation.tools }
            : refreshManifestTools(existing, generation.tools);
        // Newly generated (or refreshed) tools are NEVER reviewed: the
        // human confirms the conservative tiers before pinning.
        const updated: SnapshotDraft = {
          ...doc,
          source: { ...doc.source, reviewed: false },
          manifest: { ...doc.manifest, tools: refreshed.tools },
        };
        const isDraft = filePath.endsWith(".draft.json");
        const outDir =
          third === "--out"
            ? resolve(fourth ?? ".")
            : isDraft
              ? dirname(filePath)
              : resolve("config/extensions", "drafts");
        mkdirSync(outDir, { recursive: true });
        const outPath = resolve(outDir, `${doc.extensionId}.draft.json`);
        writeFileSync(outPath, JSON.stringify(updated, null, 2) + "\n");
        console.log(
          `tools/list: ${generation.tools.length} tools, ${generation.skipped.length} skipped`,
        );
        for (const entry of generation.skipped) {
          console.log(`  skipped: ${entry.tool} — ${entry.reason}`);
        }
        if (existing.length > 0) {
          if (refreshed.added.length === 0) {
            console.log("  refresh: no new tools — tool surface unchanged");
          } else {
            for (const tool of refreshed.added) {
              console.log(`  added: ${tool.name} (tier ${tool.tier})`);
            }
          }
        } else {
          for (const tool of refreshed.added) {
            console.log(`  generated: ${tool.name} (tier ${tool.tier})`);
          }
        }
        console.log(
          `written to ${outPath} (source.reviewed: false — review the tiers, then pin via --pin)`,
        );
      })
      .catch((err: Error) => {
        console.error(err.message);
        process.exit(1);
      });
  } else {
    if (!first) {
      console.error("usage: bun run src/extensions/fetch-catalog.ts <specId> [--out DIR]");
      process.exit(1);
    }
    fetchCatalogEntry(first)
      .then((entry) => {
        const draft = buildSnapshotDraft(entry);
        if (second === "--out") {
          const dir = third ?? "config/extensions";
          // Write the draft for editing — NOT into the live snapshots dir,
          // which the registry loads fail-closed at boot.
          writeFileSync(resolve(dir, `${draft.extensionId}.draft.json`), JSON.stringify(draft, null, 2) + "\n");
          console.log(`draft written to ${resolve(dir, `${draft.extensionId}.draft.json`)}`);
        }
        console.log(JSON.stringify(draft, null, 2));
      })
      .catch((err: Error) => {
        console.error(err.message);
        process.exit(1);
      });
  }
}
