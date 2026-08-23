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
import { generateOpenApiTools, type OpenApiOperation, type OpenApiToolGeneration } from "./openapi-tools";
import {
  parsePinnedSnapshot,
  SNAPSHOT_SCHEMA,
  type PinnedSnapshot,
  type SnapshotSource,
} from "./registry";
import { errorMessage } from "../tools/helpers";
import {
  ExtensionValidationError,
  isRecord,
  validateManifest,
  type CliBinding,
  type CredentialSchema,
  type CredentialTarget,
  type ExtensionKind,
  type ExtensionTool,
  type JsonObject,
  type JsonValue,
  type McpBinding,
  type OpenApiBinding,
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
  /**
   * OpenAPI catalog metadata (issue #345): the spec URL + static auth scheme
   * for an API-first vendor entry (kind "openapi"). Optional `operations`
   * curation (default = all non-deprecated ops, capped); absent on mcp/cli
   * entries.
   */
  openapi?: {
    url: string;
    /** Optional explicit operation-id curation; default = all non-deprecated. */
    operations?: string[];
    auth: {
      scheme: "bearer" | "apiKeyHeader";
      headerName?: string;
      credentialLabel?: string;
    };
  };
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
    /**
     * OpenAPI binding for an openapi-kind entry (issue #345). Unlike MCP/CLI
     * bindings the human never fills this from vendor docs: the spec URL +
     * static auth scheme come from the catalog's `openapi` block, carried
     * verbatim into the draft so an openapi draft does not collapse to another
     * kind and stays self-contained (the frozen tool surface is generated at
     * pin time from the spec).
     */
    openapi?: OpenApiBinding;
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

/** Parses an entry's optional OpenAPI block (issue #345). Fail closed on malformed fields. */
function parseOptionalOpenApiBlock(
  record: JsonObject,
  specId: string,
): CatalogEntry["openapi"] {
  const value = record["openapi"];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new CatalogError(`entry "${specId}" has a non-object "openapi" block`);
  }
  const url = optionalString(value["url"]);
  if (url === null || url.trim() === "") {
    throw new CatalogError(`entry "${specId}" openapi block is missing a non-empty "url"`);
  }
  const authValue = value["auth"];
  if (!isRecord(authValue)) {
    throw new CatalogError(`entry "${specId}" openapi block is missing an "auth" object`);
  }
  const schemeRaw = optionalString(authValue["scheme"]);
  if (schemeRaw !== "bearer" && schemeRaw !== "apiKeyHeader") {
    throw new CatalogError(`entry "${specId}" openapi auth.scheme must be "bearer" or "apiKeyHeader"`);
  }
  let headerName: string | undefined;
  if (schemeRaw === "apiKeyHeader") {
    const header = optionalString(authValue["headerName"]);
    if (header === null || header.trim() === "") {
      throw new CatalogError(`entry "${specId}" openapi apiKeyHeader scheme requires "headerName"`);
    }
    headerName = header.trim();
  }
  const credentialLabel = optionalString(authValue["credentialLabel"]);
  let operations: string[] | undefined;
  if (value["operations"] !== undefined) {
    if (!Array.isArray(value["operations"])) {
      throw new CatalogError(`entry "${specId}" openapi.operations must be an array of operation ids`);
    }
    const parsed = value["operations"]
      .map((entry) => optionalString(entry)?.trim())
      .filter((entry): entry is string => entry !== undefined && entry !== "");
    operations = parsed;
  }
  return {
    url: url.trim(),
    ...(operations !== undefined && operations.length > 0 ? { operations } : undefined),
    auth: {
      scheme: schemeRaw,
      ...(headerName !== undefined ? { headerName } : undefined),
      ...(credentialLabel !== null && credentialLabel.trim() !== "" ? { credentialLabel } : undefined),
    },
  };
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
  const openapi = parseOptionalOpenApiBlock(record, specId);
  return {
    id,
    slug,
    name,
    kind,
    domain,
    ...(url !== null && url.trim() !== "" ? { url } : undefined),
    ...(description !== null ? { description } : undefined),
    ...(mcpEndpoint !== null && mcpEndpoint.trim() !== "" ? { mcpEndpoint } : undefined),
    ...(openapi !== undefined ? { openapi } : undefined),
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
  const kind: ExtensionKind = entry.kind === "mcp" ? "mcp" : entry.kind === "cli" ? "cli" : entry.kind === "openapi" ? "openapi" : "mcp";
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
      // An openapi entry's binding is self-contained: the catalog's `openapi`
      // block carries the spec URL + static auth scheme, so the draft for an
      // openapi kind does not collapse to another kind and is pin-ready once
      // the spec surface is generated (issue #345).
      ...(kind === "openapi" && entry.openapi !== undefined
        ? {
            openapi: {
              specUrl: entry.openapi.url,
              auth: {
                scheme: entry.openapi.auth.scheme,
                ...(entry.openapi.auth.headerName !== undefined
                  ? { headerName: entry.openapi.auth.headerName }
                  : undefined),
                ...(entry.openapi.auth.credentialLabel !== undefined
                  ? { credentialLabel: entry.openapi.auth.credentialLabel }
                  : undefined),
              },
            },
          }
        : undefined),
    },
  };
}

/**
 * Builds the pinned manifest for an openapi-kind catalog entry (issue
 * #345): generates the frozen tool surface from the already-fetched spec
 * (honoring the entry's optional `operations` curation), derives the egress
 * domain allowlist from the spec's HTTPS servers, and pairs them with the
 * static bearer/apiKeyHeader auth. Fail closed on every cap: a non-openapi
 * entry, a missing openapi block, an unknown auth scheme, a non-HTTPS spec
 * URL, a generation cap/collision, or a curated id matching no operation —
 * nothing partial ever pins.
 */
export function buildOpenApiPinnedManifest(
  entry: CatalogEntry,
  spec: JsonObject,
): PinnedSnapshot["manifest"] {
  return openApiGenerationFor(entry, spec).manifest;
}

/**
 * The review-ready outcome of pinning an openapi-kind catalog entry (issue
 * #345): the FROZEN manifest plus the operations+tiers rendering the review
 * step surfaces (the connect approval, the catalog_browser pin gate). One
 * source shared by {@link buildOpenApiPinnedManifest} and every review
 * surface, so the human sees exactly the operations that pin froze.
 */
export interface OpenApiPinReview {
  manifest: PinnedSnapshot["manifest"];
  /** The generated operations + tiers (the review rendering). */
  operations: OpenApiOperation[];
  /** Validated HTTPS-only origin hosts (the egress allowlist). */
  hosts: string[];
  /** The generator's raw output (tools + hosts + operations). */
  generation: OpenApiToolGeneration;
}

/**
 * Validates an openapi-kind catalog entry and generates its frozen tool
 * surface + operations for review (issue #345). Fail closed on every cap: a
 * non-openapi entry, a missing openapi block, an unknown auth scheme, a
 * non-HTTPS spec URL, a generation cap/collision, or a curated id matching
 * no operation — nothing partial ever pins.
 */
export function openApiGenerationFor(
  entry: CatalogEntry,
  spec: JsonObject,
): OpenApiPinReview {
  if (entry.kind !== "openapi") {
    throw new CatalogError(`entry "${entry.slug}" must be kind "openapi" to pin a spec surface`);
  }
  const openApi = entry.openapi;
  if (openApi === undefined) {
    throw new CatalogError(`entry "${entry.slug}" (kind openapi) is missing the "openapi" block`);
  }
  if (openApi.auth.scheme !== "bearer" && openApi.auth.scheme !== "apiKeyHeader") {
    throw new CatalogError(
      `entry "${entry.slug}" openapi auth.scheme "${openApi.auth.scheme}" is unsupported in V1 (bearer/apiKeyHeader only)`,
    );
  }
  let generation;
  try {
    generation = generateOpenApiTools(spec, entry.slug);
  } catch (err) {
    if (err instanceof Error) {
      throw new CatalogError(
        `cannot pin openapi surface for "${entry.slug}": ${err.message}`,
      );
    }
    throw err;
  }
  const curated = openApi.operations;
  let tools = generation.tools;
  if (curated !== undefined && curated.length > 0) {
    const allowed = new Set(curated);
    const kept = generation.operations.filter((op) => allowed.has(op.operationId));
    for (const id of curated) {
      if (!generation.operations.some((op) => op.operationId === id)) {
        throw new CatalogError(
          `entry "${entry.slug}" curates operation "${id}" but the spec declares no such operation — refuse to pin`,
        );
      }
    }
    tools = kept.map((op) => tools.find((tool) => tool.name === op.name)!);
  }
  const host = generation.hosts[0];
  const credentialSchema = { type: "api_key" as const };
  const headerName = openApi.auth.scheme === "apiKeyHeader" ? openApi.auth.headerName : undefined;
  const manifestInput = {
    id: entry.slug,
    label: entry.name,
    vendor: entry.name,
    kind: "openapi",
    openapi: {
      specUrl: openApi.url,
      auth: {
        scheme: openApi.auth.scheme,
        ...(headerName !== undefined ? { headerName } : undefined),
        ...(openApi.auth.credentialLabel !== undefined
          ? { credentialLabel: openApi.auth.credentialLabel }
          : undefined),
      },
    },
    credentialSchema,
    tools,
    domains: generation.hosts,
    credentialTargets: host !== undefined ? [{ host }] : [],
  };
  // SAFETY: JSON round-tripping a manifest-shaped object yields a JSON
  // document (JsonValue); validateManifest re-validates it and also
  // guarantees deterministic byte-for-byte snapshot bytes (the pin's
  // reviewed surface).
  const manifest = validateManifest(JSON.parse(JSON.stringify(manifestInput)) as JsonValue);
  return { manifest, operations: generation.operations, hosts: generation.hosts, generation };
}

function completeManifest(draft: SnapshotDraft): PinnedSnapshot["manifest"] {
  // Binding, credential schema, and credential authority are reviewed facts.
  // An openapi binding is the `openapi` block (spec URL + static auth scheme),
  // carried verbatim from the catalog — it never needs a human to fill it
  // (issue #345).
  const needsBinding =
    draft.manifest.kind === "mcp"
      ? draft.manifest.mcp === undefined
      : draft.manifest.kind === "cli"
        ? draft.manifest.cli === undefined
        : draft.manifest.openapi === undefined;
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
