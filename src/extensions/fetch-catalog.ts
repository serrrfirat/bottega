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
 * Why the draft is never written directly: the catalog record carries only
 * id/slug/name/kind/domain/url — not the MCP endpoint, auth, or tool
 * surface. A scaffold manifest therefore fails validateManifest (fail
 * closed), so `--pin` refuses to leave a broken file in the live snapshots
 * dir; it validates with parsePinnedSnapshot before writing.
 *
 * CLI:
 *   bun run src/extensions/fetch-catalog.ts <specId>            # print draft
 *   bun run src/extensions/fetch-catalog.ts <specId> --out DIR  # write draft to DIR
 *   bun run src/extensions/fetch-catalog.ts --pin <draft.json>  # validate + pin
 *
 * Env override: INTEGRATIONS_CATALOG_URL (mirrors the test seam; the
 * registry's own tests use a stub fetch).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePinnedSnapshot, SNAPSHOT_SCHEMA, type PinnedSnapshot } from "./registry";
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
  /** Vendor documentation URL for the integration. */
  url: string;
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
  source: { catalog: string; specId: string; vendorOfficial: boolean; reviewed: boolean };
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
export async function fetchCatalogEntry(
  specId: string,
  opts: FetchCatalogOptions = {},
): Promise<CatalogEntry> {
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
  const entry = (doc.data as Record<string, unknown>[]).find(
    (record) => record["slug"] === specId || record["id"] === specId,
  );
  if (entry === undefined) {
    throw new CatalogError(`spec "${specId}" not found in ${catalogUrl}`);
  }
  for (const field of ["id", "slug", "name", "kind", "domain", "url"] as const) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      throw new CatalogError(`entry "${specId}" is missing a non-empty "${field}"`);
    }
  }
  return {
    id: entry["id"] as string,
    slug: entry["slug"] as string,
    name: entry["name"] as string,
    kind: entry["kind"] as string,
    domain: entry["domain"] as string,
    url: entry["url"] as string,
    ...(typeof entry["description"] === "string" ? { description: entry["description"] } : {}),
  };
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
      `draft for "${draft.extensionId}" is incomplete: add the binding, credentialSchema, and tools ` +
        "from the vendor docs (see the catalog entry url) before pinning",
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
 * Pins a completed draft into the snapshots dir. Re-fetches the catalog to
 * confirm the spec still exists when the draft's source.catalog is the
 * integrations.sh catalog (provenance check); drafts sourced elsewhere
 * (e.g. the github-mcp-server vendor repo) skip the check — their catalog
 * is the human's responsibility. Returns the written path.
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
  const [first, second, third] = process.argv.slice(2);
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
