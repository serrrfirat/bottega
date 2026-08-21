/**
 * Catalog fetch helper (issue #54): turns an integrations.sh catalog entry
 * into a pinned snapshot for `config/extensions/<id>.json` (#50 format).
 *
 * The registry NEVER fetches at runtime — per-org deployments resolve the
 * pinned files only (server/index.ts seeds the registry at boot). This
 * module is the human step that PINS a new provider: fetch the catalog
 * record, print the snapshot draft (provenance + catalog-derived manifest
 * scaffold), then `--pin` the completed draft once a maintainer has filled
 * in the binding facts (mcp/cli, credentialSchema) from vendor docs and
 * marked source.reviewed / source.vendorOfficial. Manifest tools are
 * OPTIONAL (issue #158): absent → the runtime discovers the provider's
 * tools/list surface at boot with conservative tiers; present → the
 * reviewed pinned surface wins.
 *
 * The catalog record never carries an MCP/CLI binding, so the agent draft
 * flow (catalog_browser) instructs web-searching the vendor's OFFICIAL MCP
 * server and filling the scaffold from the vendor's published spec (issue
 * #146); the pin/review gate is unchanged.
 *
 * Why the draft is never written directly: the catalog record carries only
 * id/slug/name/kind/domain/url — not the MCP endpoint, auth, or tool
 * surface. A scaffold manifest without its binding/credentialSchema
 * therefore fails validateManifest (fail closed), so `--pin` refuses to
 * leave a broken file in the live snapshots dir; it validates with
 * parsePinnedSnapshot before writing.
 *
 * CLI:
 *   bun run src/extensions/fetch-catalog.ts <specId>            # print draft
 *   bun run src/extensions/fetch-catalog.ts <specId> --out DIR  # write draft to DIR
 *   bun run src/extensions/fetch-catalog.ts --generate-tools <draft.json> [--out DIR]
 *                                    # OPTIONALLY pin manifest.tools from the provider's
 *                                    # tools/list (issue #157); on a pinned manifest
 *                                    # this REFRESHES it — new tools land for review,
 *                                    # never silently. Omit tools entirely to pin a
 *                                    # tools-less manifest (runtime discovery, #158).
 *   bun run src/extensions/fetch-catalog.ts --pin <draft.json>  # validate + pin
 *
 * Env override: INTEGRATIONS_CATALOG_URL (mirrors the test seam; the
 * registry's own tests use a stub fetch).
 */
import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateManifestTools, refreshManifestTools } from "./generate-tools";
import {
  parsePinnedSnapshot,
  SNAPSHOT_SCHEMA,
  type PinnedSnapshot,
  type SnapshotSource,
} from "./registry";
import { errorMessage } from "../tools/helpers";
import {
  ExtensionValidationError,
  validateManifest,
  type CliBinding,
  type CredentialSchema,
  type CredentialTarget,
  type ExtensionKind,
  type ExtensionTool,
  type JsonObject,
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
   * Vendor documentation URL. OPTIONAL everywhere: the live integrations.sh
   * catalog omits it for most entries (issue #118, #270), and no downstream
   * consumer (draft, pin, listing) requires it — it round-trips when present.
   */
  url?: string;
  description?: string;
  /**
   * Trusted explicit hosted MCP endpoint metadata (issue #286): when a
   * catalog record publishes the vendor's machine-readable MCP endpoint,
   * the deterministic connect honors it VERBATIM over any derivation. The
   * live integrations.sh catalog carries none today (the field is inert),
   * but it is load-bearing for forward compatibility: a catalog-published
   * endpoint is always probed before it registers, exactly like a derived
   * one.
   */
  mcpEndpoint?: string;
}

export interface FetchCatalogOptions {
  catalogUrl?: string;
  /** Test seam: default is global fetch. */
  fetchImpl?: typeof fetch;
  /** The MCP endpoint probe's wall-clock bound (issue #286); default MCP_DISCOVERY_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * A snapshot DRAFT: full provenance pinned now, plus the manifest scaffold
 * the catalog record supports. Binding/credentialSchema are filled in by a
 * maintainer from vendor docs before `pinSnapshotDraft` accepts it; tools
 * are OPTIONAL (issue #158) — absent → runtime discovery from the
 * provider's tools/list.
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
    credentialTargets?: CredentialTarget[];
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
async function fetchCatalogDoc(opts: FetchCatalogOptions): Promise<JsonObject[]> {
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
    throw new CatalogError(`GET ${catalogUrl} failed: ${errorMessage(err)}`);
  }
  let doc: { data?: unknown };
  try {
    // JSON.parse returns `any`; the only shape trusted here is a document
    // carrying an optional `data` field — checked below, fail closed.
    doc = JSON.parse(body);
  } catch {
    throw new CatalogError(`catalog at ${catalogUrl} is not valid JSON`);
  }
  if (!Array.isArray(doc.data)) {
    throw new CatalogError(`catalog at ${catalogUrl} has no data array`);
  }
  // SAFETY: Array.isArray(doc.data) passed above, and the document came from
  // JSON.parse — every element is a JSON object.
  return doc.data as JsonObject[];
}

/** The record field's string value, or null when it isn't one. */
function optionalString(value: JsonObject[string]): string | null {
  const parsed = z.string().safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Non-empty string field, failing closed with the catalog's canonical error. */
function requireString(record: JsonObject, field: string, specId: string): string {
  const value = optionalString(record[field]);
  if (value === null || value.trim() === "") {
    throw new CatalogError(`entry "${specId}" is missing a non-empty "${field}"`);
  }
  return value;
}

/**
 * LENIENT record validation for LISTING and the single-entry lookup (issues
 * #118, #270): a record is valid with id/slug/name/kind/domain — `url` is
 * NOT required (the live catalog omits it for most entries) and is included
 * only when present, never fabricated. Truly invalid records (missing a
 * renderable field) throw {@link CatalogError}.
 */
function parseListableRecord(record: JsonObject): CatalogEntry {
  const specId = optionalString(record["slug"]) ?? String(record["id"] ?? "?");
  const id = requireString(record, "id", specId);
  const slug = requireString(record, "slug", specId);
  const name = requireString(record, "name", specId);
  const kind = requireString(record, "kind", specId);
  const domain = requireString(record, "domain", specId);
  const url = optionalString(record["url"]);
  const description = optionalString(record["description"]);
  const mcpEndpoint = optionalString(record["mcpEndpoint"]);
  return {
    id,
    slug,
    name,
    kind,
    domain,
    ...(url !== null && url.trim() !== "" ? { url } : undefined),
    ...(description !== null ? { description } : undefined),
    ...(mcpEndpoint !== null && mcpEndpoint.trim() !== "" ? { mcpEndpoint } : undefined),
  };
}

/**
 * Semantic record matching (issue #233): a connect's extension token
 * resolves by exact slug/id OR by name/alias — "connect my docs" →
 * extension token "docs" → the catalog entry named "Docs" (or carrying a
 * "docs" alias) — case-insensitive, never a substring guess (substring
 * matching would make ambiguous connects resolve arbitrarily). Aliases are
 * an optional per-record array (some catalog entries publish them).
 */
function recordMatchesSpec(record: JsonObject, specId: string): boolean {
  const needle = specId.toLowerCase();
  if (optionalString(record["slug"])?.toLowerCase() === needle) return true;
  if (optionalString(record["id"])?.toLowerCase() === needle) return true;
  if (optionalString(record["name"])?.toLowerCase() === needle) return true;
  const aliases = record["aliases"];
  if (Array.isArray(aliases)) {
    for (const alias of aliases) {
      if (optionalString(alias)?.toLowerCase() === needle) return true;
    }
  }
  return false;
}

export async function fetchCatalogEntry(
  specId: string,
  opts: FetchCatalogOptions = {},
): Promise<CatalogEntry> {
  const catalogUrl = opts.catalogUrl ?? process.env.INTEGRATIONS_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  const entry = (await fetchCatalogDoc(opts)).find((record) => recordMatchesSpec(record, specId));
  if (entry === undefined) {
    throw new CatalogError(`spec "${specId}" not found in ${catalogUrl}`);
  }
  return parseListableRecord(entry);
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
        const specId = optionalString(record["slug"]) ?? String(record["id"] ?? "?");
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
  // Binding, credential schema, and credential authority are reviewed facts.
  const needsBinding =
    draft.manifest.kind === "mcp" ? draft.manifest.mcp === undefined : draft.manifest.cli === undefined;
  if (
    needsBinding ||
    draft.manifest.credentialSchema === undefined ||
    draft.manifest.credentialTargets === undefined
  ) {
    throw new ExtensionValidationError(
      `draft for "${draft.extensionId}" is incomplete: add the ${draft.manifest.kind} binding, ` +
        "credentialSchema, and explicit credentialTargets from the vendor docs before pinning; " +
        "reachable domains do not grant credential authority",
    );
  }
  return validateManifest(JSON.parse(JSON.stringify(draft.manifest)));
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
 * Pins a completed draft into the snapshots dir. Re-fetches the catalog to
 * confirm the spec still exists when the draft's source.catalog is the
 * integrations.sh catalog (provenance check); drafts sourced elsewhere
 * (e.g. the github-mcp-server vendor repo) skip the check — their catalog
 * is the human's responsibility. Returns the written path.
 *
 * Issue #158: manifest tools are OPTIONAL — a draft without tools pins
 * tools-less as-is (the runtime discovers the surface from the provider's
 * tools/list at boot with conservative tiers). The `--generate-tools` CLI
 * remains the explicit path for a PINNED, reviewed surface (issue #157).
 * The review gate is unchanged: unreviewed community drafts refuse to pin.
 */
export async function pinSnapshotDraft(
  draft: SnapshotDraft,
  outDir: string,
  opts: FetchCatalogOptions = {},
): Promise<string> {
  if (draft.source.catalog === DEFAULT_CATALOG_URL) {
    await fetchCatalogEntry(draft.source.specId, opts);
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
    // SAFETY: --pin reads a draft written by the draft/pin flow or hand-edited
    // to that shape; malformed drafts fail closed inside pinSnapshotDraft.
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
    // SAFETY: --generate-tools reads a draft written by the draft/pin flow
    // (SnapshotDraft shape); the binding/kind fields are checked below.
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
