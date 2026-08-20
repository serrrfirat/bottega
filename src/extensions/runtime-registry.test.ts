/**
 * Issue #233 acceptance (registry tier): the STORE-backed runtime extension
 * registry — machine state, never a repo file. Boot merges the pinned
 * seeds + the persisted runtime set into the live registry (resolve/list
 * include both); the egress generator merges the same set. Red on
 * pre-fix: the table, the store methods, and the merge do not exist.
 *
 * The caller-surface tests (the connect registering at runtime end-to-end)
 * live in catalog-register.test.ts / connect.test.ts / space-service.test.ts;
 * this file pins the registry's own contracts against the REAL store.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../store/db";
import { createExtensionRegistry, parsePinnedSnapshot, SNAPSHOT_SCHEMA, type PinnedSnapshot } from "./registry";
import { fixtureManifest, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL } from "./fixture";
import type { McpBinding } from "./manifest";
import {
  mergeRuntimeRegistry,
  runtimeRecordFromRow,
  runtimeSnapshotsFromStore,
  storeRuntimeRegistrySeam,
  type RuntimeExtensionRecord,
} from "./runtime-registry";

const dir = mkdtempSync(join(tmpdir(), "bottega-runtime-registry-"));
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const store = createStore(join(dir, `rt-${stores.length}.db`));
  stores.push(store);
  return store;
}

function notionSnapshot(): PinnedSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    extensionId: "notion",
    pinnedAt: "2026-08-18T00:00:00.000Z",
    source: {
      catalog: "https://integrations.sh/api",
      specId: "notion",
      vendorOfficial: true,
      reviewed: true,
    },
    manifest: {
      id: "notion",
      label: "Notion",
      vendor: "Notion",
      kind: "mcp",
      mcp: { serverUrl: "https://mcp.notion.com/mcp", transport: "streamable-http" },
      credentialSchema: { type: "oauth" },
      domains: ["notion.com", "mcp.notion.com"],
    },
  };
}

describe("store-backed runtime extension registry (issue #233)", () => {
  test("upsertRuntimeExtension persists the snapshot document; list returns it in registration order", async () => {
    const store = freshStore();
    const snapshot = notionSnapshot();
    const row = await store.upsertRuntimeExtension({
      extensionId: snapshot.extensionId,
      snapshot: JSON.stringify(snapshot),
      registeredBy: "UADA",
      spaceId: "slack:C1",
    });
    expect(row.id).toBe("notion");
    expect(row.registered_by).toBe("UADA");
    expect(row.space_id).toBe("slack:C1");

    const rows = await store.listRuntimeExtensions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("notion");
    // The persisted document round-trips through the registry's fail-closed parse.
    expect(parsePinnedSnapshot(rows[0]!.snapshot).extensionId).toBe("notion");
  });

  test("re-registering the same extension id UPDATES the row, never duplicates", async () => {
    const store = freshStore();
    const first = notionSnapshot();
    await store.upsertRuntimeExtension({
      extensionId: "notion",
      snapshot: JSON.stringify(first),
      registeredBy: "UADA",
    });
    const second = notionSnapshot();
    second.pinnedAt = "2026-08-18T01:00:00.000Z";
    await store.upsertRuntimeExtension({
      extensionId: "notion",
      snapshot: JSON.stringify(second),
      registeredBy: "U1",
      spaceId: "slack:C2",
    });
    const rows = await store.listRuntimeExtensions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.registered_by).toBe("U1");
    expect(rows[0]!.space_id).toBe("slack:C2");
    expect(JSON.parse(rows[0]!.snapshot)["pinnedAt"]).toBe("2026-08-18T01:00:00.000Z");
  });

  test("runtimeRecordFromRow validates the snapshot fail-closed; malformed rows throw", async () => {
    const store = freshStore();
    await store.upsertRuntimeExtension({
      extensionId: "notion",
      snapshot: JSON.stringify(notionSnapshot()),
      registeredBy: "UADA",
    });
    const record: RuntimeExtensionRecord = runtimeRecordFromRow((await store.listRuntimeExtensions())[0]!);
    expect(record.extensionId).toBe("notion");
    expect(record.snapshot.manifest.id).toBe("notion");
    expect(record.snapshot.source.reviewed).toBe(true);
    expect(record.registeredBy).toBe("UADA");
    expect(record.spaceId).toBeNull();
    expect(record.registeredAt).toBeGreaterThan(0);

    // A corrupted snapshot document fails the parse closed (nothing partial).
    await store.upsertRuntimeExtension({ extensionId: "broken", snapshot: "{ nope", registeredBy: "UADA" });
    const broken = (await store.listRuntimeExtensions()).find((row) => row.id === "broken")!;
    expect(() => runtimeRecordFromRow(broken)).toThrow(/not valid JSON/);
  });

  test("a legacy record carrying a token endpoint survives the store round-trip endpoint-free (issue #284)", async () => {
    // Pre-#284 the runtime registration's snapshot could carry the OAuth
    // token endpoint on the mcp binding (the #275 record shape). Issue
    // #284 removes the field from the schema: the persisted row still
    // round-trips through the registry's fail-closed parse, and the
    // endpoint is dropped from the validated manifest (the SDK owns
    // OAuth — the egress regen never reads an endpoint).
    const store = freshStore();
    // A legacy notion binding with the #275 record shape: the endpoint
    // rides on the mcp binding (an unknown field the validator ignores).
    const snapshot: PinnedSnapshot = {
      schema: SNAPSHOT_SCHEMA,
      extensionId: "notion",
      pinnedAt: "2026-08-18T00:00:00.000Z",
      source: { catalog: "https://integrations.sh/api", specId: "notion", vendorOfficial: true, reviewed: true },
      manifest: {
        id: "notion",
        label: "Notion",
        vendor: "Notion",
        kind: "mcp",
        mcp: {
          serverUrl: "https://mcp.notion.com/mcp",
          transport: "streamable-http",
          tokenEndpoint: "https://mcp.notion.com/token",
        } as unknown as McpBinding,
        credentialSchema: { type: "oauth" },
        domains: ["notion.com", "mcp.notion.com"],
      },
    };
    await store.upsertRuntimeExtension({
      extensionId: snapshot.extensionId,
      snapshot: JSON.stringify(snapshot),
      registeredBy: "UADA",
    });
    const rows = await store.listRuntimeExtensions();
    expect(rows).toHaveLength(1);
    const record = runtimeRecordFromRow(rows[0]!);
    expect(record.snapshot.manifest.kind).toBe("mcp");
    if (record.snapshot.manifest.kind !== "mcp") throw new Error("expected an mcp manifest");
    expect((record.snapshot.manifest.mcp as { tokenEndpoint?: string }).tokenEndpoint).toBeUndefined();
    const set = await runtimeSnapshotsFromStore(store);
    if (set[0]!.manifest.kind !== "mcp") throw new Error("expected an mcp manifest");
    expect((set[0]!.manifest.mcp as { tokenEndpoint?: string }).tokenEndpoint).toBeUndefined();
    // The egress merge still allowlists the OAuth domains from the record.
    expect(set[0]!.manifest.domains).toContain("mcp.notion.com");
  });

  test("runtimeSnapshotsFromStore returns the validated runtime set for the egress merge", async () => {
    const store = freshStore();
    await store.upsertRuntimeExtension({
      extensionId: "notion",
      snapshot: JSON.stringify(notionSnapshot()),
      registeredBy: "UADA",
    });
    const set = await runtimeSnapshotsFromStore(store);
    expect(set.map((s) => s.extensionId)).toEqual(["notion"]);
    expect(set[0]!.manifest.domains).toEqual(["notion.com", "mcp.notion.com"]);
  });

  test("mergeRuntimeRegistry merges pins + the persisted runtime set; a pinned id wins; malformed rows are loud skips", async () => {
    const store = freshStore();
    const snapshotsDir = join(dir, "extensions");
    await store.upsertRuntimeExtension({
      extensionId: "notion",
      snapshot: JSON.stringify(notionSnapshot()),
      registeredBy: "UADA",
    });
    // A malformed runtime row must not kill the boot or its neighbors.
    await store.upsertRuntimeExtension({ extensionId: "broken", snapshot: "{ nope", registeredBy: "UADA" });
    // A runtime row for a PINNED id: the seed wins (github is pinned in the
    // committed seed — reuse the fixture id to avoid depending on them).
    await store.upsertRuntimeExtension({
      extensionId: FIXTURE_EXTENSION_ID,
      snapshot: JSON.stringify({
        ...notionSnapshot(),
        extensionId: FIXTURE_EXTENSION_ID,
        manifest: { ...fixtureManifest() },
      }),
      registeredBy: "UADA",
    });

    const registry = createExtensionRegistry(snapshotsDir); // empty seed dir
    registry.register(fixtureManifest()); // the "pinned" seed for fixture.weather

    const errorSpy = { calls: 0 };
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.calls += 1;
      origError(...args);
    };
    let merged: number;
    try {
      merged = await mergeRuntimeRegistry(store, registry);
    } finally {
      console.error = origError;
    }

    // notion merged from the runtime set; the pinned fixture.weather won
    // (its runtime row was skipped); the malformed row was a loud skip.
    expect(merged).toBe(1);
    expect(errorSpy.calls).toBeGreaterThanOrEqual(1);
    expect(registry.resolve("notion")?.manifest.id).toBe("notion");
    expect(registry.resolve("notion")?.snapshot?.source.reviewed).toBe(true);
    expect(registry.resolve("broken")).toBeUndefined();
    // The pinned seed's manifest is the one that resolved (runtime row lost).
    expect(registry.resolve(FIXTURE_EXTENSION_ID)?.manifest.tools?.[0]?.name).toBe(FIXTURE_EXTENSION_TOOL);
    // resolve/list include both seeds and runtime rows.
    expect(registry.list().map((entry) => entry.manifest.id)).toEqual([FIXTURE_EXTENSION_ID, "notion"]);
  });

  test("storeRuntimeRegistrySeam adapts the store to the catalog seam (upsert + list)", async () => {
    const store = freshStore();
    const seam = storeRuntimeRegistrySeam(store);
    const snapshot = notionSnapshot();
    await seam.upsert(snapshot, "UADA", "slack:C1");
    const set = await seam.list();
    expect(set.map((s) => s.extensionId)).toEqual(["notion"]);
    // The row persisted exactly what the registry parses.
    expect(parsePinnedSnapshot((await store.listRuntimeExtensions())[0]!.snapshot).extensionId).toBe("notion");
  });
});
