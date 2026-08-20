/**
 * Runtime extension registry (issue #233): the STORE-backed registry for
 * runtime-registered extension manifests — the durable record the catalog
 * connect path writes (machine state, NEVER a repo file; no
 * config/extensions file, no commit).
 *
 * Boot merges the pinned seeds (config/extensions snapshots) + the
 * persisted runtime set into the LIVE registry, so resolve/list surfaces
 * include both. The egress generator merges the same runtime set (the
 * allowlist domains; issue #284 — OAuth extensions get no transform
 * entry, the SDK owns OAuth) into both emitted configs — see
 * src/egress/generate.ts.
 *
 * The snapshot column holds the full PinnedSnapshot document; every read
 * re-validates through parsePinnedSnapshot (fail closed — a malformed row
 * registers nothing, loudly, never partially).
 */
import type { RuntimeExtensionRow, Store } from "../store/db";
import type { RuntimeRegistrySeam } from "./catalog-register";
import { parsePinnedSnapshot, type ExtensionRegistry, type PinnedSnapshot } from "./registry";
import { errorMessage } from "../tools/helpers";

/** One persisted runtime registration, parsed and validated. */
export interface RuntimeExtensionRecord {
  extensionId: string;
  snapshot: PinnedSnapshot;
  registeredBy: string;
  spaceId: string | null;
  registeredAt: number;
}

/** Parses one store row into a validated record. Throws (fail closed) on a
 * malformed snapshot document — the caller decides loud-skip vs loud-fail. */
export function runtimeRecordFromRow(row: RuntimeExtensionRow): RuntimeExtensionRecord {
  const snapshot = parsePinnedSnapshot(row.snapshot);
  return {
    extensionId: row.id,
    snapshot,
    registeredBy: row.registered_by,
    spaceId: row.space_id,
    registeredAt: row.created_at,
  };
}

/**
 * The persisted runtime set as registry-valid snapshots (the egress
 * generator's merge input), in registration order. A malformed row THROWS
 * (fail closed — the egress regen must never silently drop a registered
 * extension's allowlist entry).
 */
export async function runtimeSnapshotsFromStore(store: Pick<Store, "listRuntimeExtensions">): Promise<PinnedSnapshot[]> {
  const rows = await store.listRuntimeExtensions();
  return rows.map((row) => runtimeRecordFromRow(row).snapshot);
}

/**
 * Boot merge (issue #233): registers every persisted runtime row into the
 * live registry AFTER the pinned seeds. A pinned id wins (a seed shadows a
 * stale runtime row — e.g. a previously-runtime-registered id that later
 * became a pin). A malformed runtime row is a LOUD skip, never a boot
 * failure (the #205 posture: one bad row must not kill the extensions
 * around it). Returns how many runtime rows merged.
 */
export async function mergeRuntimeRegistry(
  store: Pick<Store, "listRuntimeExtensions">,
  registry: ExtensionRegistry,
): Promise<number> {
  const rows = await store.listRuntimeExtensions();
  let merged = 0;
  for (const row of rows) {
    if (registry.resolve(row.id) !== undefined) continue; // pinned seed wins
    try {
      const record = runtimeRecordFromRow(row);
      registry.register(record.snapshot.manifest, record.snapshot);
      merged += 1;
    } catch (err) {
      console.error(
        `[extensions] skipping malformed runtime registration "${row.id}": ` +
          `${errorMessage(err)} — the extension is not registered until a connect re-registers it`,
      );
    }
  }
  return merged;
}

/**
 * The production wiring helper (issue #233): adapts the store's runtime
 * registry table to the catalog seam's {@link RuntimeRegistrySeam} — the
 * upsert persists the snapshot document (the row IS the durable evidence),
 * and list() re-validates every row through the registry's fail-closed
 * parse (a malformed row throws — the egress regen must never silently
 * drop a registered extension's allowlist entry).
 */
export function storeRuntimeRegistrySeam(
  store: Pick<Store, "upsertRuntimeExtension" | "listRuntimeExtensions">,
): RuntimeRegistrySeam {
  return {
    async upsert(snapshot, actor, spaceId) {
      await store.upsertRuntimeExtension({
        extensionId: snapshot.extensionId,
        snapshot: JSON.stringify(snapshot),
        registeredBy: actor,
        spaceId,
      });
    },
    list: () => runtimeSnapshotsFromStore(store),
  };
}
