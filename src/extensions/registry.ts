/**
 * Extension registry (issue #50): register/list/resolve typed integrations.
 *
 * The registry is the heart of the extension system: a manifest (provider
 * id, credential schema, tool surface) + a pinned spec snapshot + policy.
 *
 * Catalog sourcing: registration resolves the provider's spec via the
 * integrations.sh catalog (REST https://integrations.sh/api or its MCP
 * surface) and snapshots it locally PINNED — per-org deployments never
 * depend on the catalog at runtime. Fetching is issue #54's job
 * (integrations.sh); this module defines and reads the pinned snapshot
 * format so the fetch can just write files.
 *
 * Snapshot format (one JSON file per extension, `config/extensions/<id>.json`):
 * {
 *   "schema": "bottega.extension-snapshot.v1",   // registry rejects anything else
 *   "extensionId": "com.example.provider",       // must match manifest.id
 *   "pinnedAt": "2026-08-16T00:00:00.000Z",      // catalog fetch time
 *   "source": {
 *     "catalog": "https://integrations.sh/api",  // where the spec came from
 *     "specId": "example-provider",              // catalog spec id
 *     "vendorOfficial": true,                    // vendor-official entries preferred
 *     "reviewed": false                          // community entries need explicit review
 *   },
 *   "manifest": { ... }                          // the derived ExtensionManifest
 * }
 *
 * Community snapshots (vendorOfficial: false) are rejected unless
 * `reviewed: true` — unreviewed entries fail closed and never register.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ExtensionValidationError,
  validateManifest,
  type ExtensionManifest,
} from "./manifest";

export const SNAPSHOT_SCHEMA = "bottega.extension-snapshot.v1";

export interface SnapshotSource {
  /** Catalog the spec came from, e.g. "https://integrations.sh/api". */
  catalog: string;
  /** Catalog spec id. */
  specId: string;
  /** Vendor-official entries are preferred; community entries need review. */
  vendorOfficial: boolean;
  /** Explicit human review gate for community entries. */
  reviewed: boolean;
}

/**
 * A pinned spec snapshot: the catalog record frozen at registration time.
 * Local JSON files of this shape are what the registry reads; the
 * integrations.sh fetch (issue #54) writes them.
 */
export interface PinnedSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  extensionId: string;
  pinnedAt: string;
  source: SnapshotSource;
  manifest: ExtensionManifest;
}

/** A registered extension: its manifest plus the snapshot it resolved from. */
export interface ResolvedExtension {
  manifest: ExtensionManifest;
  snapshot?: PinnedSnapshot;
}

export interface ExtensionRegistry {
  /**
   * Registers an extension. Throws {@link ExtensionRegistryError} on a
   * duplicate id or a tool name collision with an already-registered
   * extension (the session tool registry is keyed by tool name). Validation
   * failures throw {@link ExtensionValidationError} (fail closed).
   */
  register(manifest: ExtensionManifest, snapshot?: PinnedSnapshot): ResolvedExtension;
  /** All registered extensions, in registration order. */
  list(): ResolvedExtension[];
  resolve(id: string): ResolvedExtension | undefined;
  /** Tool names of every registered extension, in registration order. */
  toolNames(): string[];
  /** The extension id that owns a tool name, if any (issue #56: the gate's tool→extension seam). */
  extensionIdForTool(toolName: string): string | undefined;
  /** Egress allowlist entries contributed by extensions (deduped). */
  egressDomains(): string[];
}

export class ExtensionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionRegistryError";
  }
}

/**
 * Parses and validates one pinned snapshot document. Malformed documents
 * (wrong schema marker, manifest/id mismatch, unreviewed community entry)
 * throw — fail closed, nothing registers partially.
 */
export function parsePinnedSnapshot(text: string): PinnedSnapshot {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ExtensionRegistryError("pinned snapshot is not valid JSON");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new ExtensionRegistryError("pinned snapshot must be an object");
  }
  const record = doc as Record<string, unknown>;
  if (record["schema"] !== SNAPSHOT_SCHEMA) {
    throw new ExtensionRegistryError(`pinned snapshot schema must be "${SNAPSHOT_SCHEMA}"`);
  }
  const extensionId = record["extensionId"];
  if (typeof extensionId !== "string" || extensionId.trim() === "") {
    throw new ExtensionRegistryError("pinned snapshot extensionId must be a non-empty string");
  }
  const pinnedAt = record["pinnedAt"];
  if (typeof pinnedAt !== "string" || pinnedAt.trim() === "") {
    throw new ExtensionRegistryError("pinned snapshot pinnedAt must be a non-empty string");
  }
  const source = record["source"];
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new ExtensionRegistryError("pinned snapshot source must be an object");
  }
  const sourceRecord = source as Record<string, unknown>;
  for (const field of ["catalog", "specId"]) {
    const value = sourceRecord[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new ExtensionRegistryError(`pinned snapshot source.${field} must be a non-empty string`);
    }
  }
  for (const field of ["vendorOfficial", "reviewed"]) {
    if (typeof sourceRecord[field] !== "boolean") {
      throw new ExtensionRegistryError(`pinned snapshot source.${field} must be a boolean`);
    }
  }
  if (sourceRecord["vendorOfficial"] === false && sourceRecord["reviewed"] === false) {
    throw new ExtensionRegistryError(
      `community snapshot for "${extensionId}" requires explicit review (source.reviewed: true)`,
    );
  }
  const manifest = validateManifest(record["manifest"]);
  if (manifest.id !== extensionId) {
    throw new ExtensionRegistryError(
      `pinned snapshot extensionId "${extensionId}" does not match manifest.id "${manifest.id}"`,
    );
  }
  return {
    schema: SNAPSHOT_SCHEMA,
    extensionId,
    pinnedAt,
    source: {
      catalog: sourceRecord["catalog"] as string,
      specId: sourceRecord["specId"] as string,
      vendorOfficial: sourceRecord["vendorOfficial"] as boolean,
      reviewed: sourceRecord["reviewed"] as boolean,
    },
    manifest,
  };
}

/**
 * Reads every `*.json` snapshot in `dir` (sorted by filename for
 * deterministic registration order). A missing directory yields no
 * snapshots; any malformed file fails the whole load (fail closed).
 */
export function readPinnedSnapshots(dir: string): PinnedSnapshot[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return files.map((name) => parsePinnedSnapshot(readFileSync(join(dir, name), "utf8")));
}

/**
 * Creates the registry, optionally seeding it from a pinned-snapshot
 * directory (the catalog-sourcing hook: issue #54's fetch writes snapshots
 * here; per-org deployments resolve from these files, never from the
 * catalog at runtime).
 */
export function createExtensionRegistry(snapshotsDir?: string): ExtensionRegistry {
  const entries = new Map<string, ResolvedExtension>();

  function registerOne(manifest: ExtensionManifest, snapshot?: PinnedSnapshot): ResolvedExtension {
    if (entries.has(manifest.id)) {
      throw new ExtensionRegistryError(`extension "${manifest.id}" is already registered`);
    }
    for (const existing of entries.values()) {
      for (const tool of manifest.tools ?? []) {
        if ((existing.manifest.tools ?? []).some((other) => other.name === tool.name)) {
          throw new ExtensionRegistryError(
            `tool name "${tool.name}" is already registered by extension "${existing.manifest.id}"`,
          );
        }
      }
    }
    const resolved: ResolvedExtension = { manifest, ...(snapshot !== undefined ? { snapshot } : {}) };
    entries.set(manifest.id, resolved);
    return resolved;
  }

  if (snapshotsDir !== undefined) {
    for (const snapshot of readPinnedSnapshots(snapshotsDir)) {
      registerOne(snapshot.manifest, snapshot);
    }
  }

  return {
    register: registerOne,
    list: () => [...entries.values()],
    resolve: (id: string) => entries.get(id),
    toolNames: () => {
      const names: string[] = [];
      for (const entry of entries.values()) {
        for (const tool of entry.manifest.tools ?? []) {
          if (!names.includes(tool.name)) names.push(tool.name);
        }
      }
      return names;
    },
    extensionIdForTool: (toolName: string) => {
      for (const entry of entries.values()) {
        if ((entry.manifest.tools ?? []).some((tool) => tool.name === toolName)) return entry.manifest.id;
      }
      return undefined;
    },
    egressDomains: () => {
      const domains: string[] = [];
      for (const entry of entries.values()) {
        for (const domain of entry.manifest.domains) {
          if (!domains.includes(domain)) domains.push(domain);
        }
      }
      return domains;
    },
  };
}
