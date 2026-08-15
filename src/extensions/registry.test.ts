import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtensionRegistryError,
  SNAPSHOT_SCHEMA,
  createExtensionRegistry,
  parsePinnedSnapshot,
  readPinnedSnapshots,
  type PinnedSnapshot,
} from "./registry";
import { fixtureManifest, createFixtureRegistry, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL } from "./fixture";
import { validateManifest, type ExtensionManifest } from "./manifest";

function cliManifest(): ExtensionManifest {
  return validateManifest({
    id: "com.example.cli",
    label: "Example CLI",
    vendor: "example",
    kind: "cli",
    cli: { command: "/usr/bin/example" },
    credentialSchema: { type: "api_key" },
    tools: [{ name: "example.query", tier: "read", description: "Queries the example CLI", params: [] }],
    domains: ["api.example.com"],
  });
}

function snapshotFor(manifest = fixtureManifest(), overrides: Partial<PinnedSnapshot> = {}): PinnedSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    extensionId: manifest.id,
    pinnedAt: "2026-08-16T00:00:00.000Z",
    source: { catalog: "https://integrations.sh/api", specId: "fixture-weather", vendorOfficial: true, reviewed: false },
    manifest,
    ...overrides,
  };
}

function snapshotJson(snapshot: PinnedSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

describe("extension registry", () => {
  test("register/list/resolve round-trips in registration order", () => {
    const registry = createExtensionRegistry();
    registry.register(fixtureManifest());
    const second = cliManifest();
    registry.register(second);

    expect(registry.list().map((entry) => entry.manifest.id)).toEqual([FIXTURE_EXTENSION_ID, "com.example.cli"]);
    expect(registry.resolve(FIXTURE_EXTENSION_ID)?.manifest).toEqual(fixtureManifest());
    expect(registry.resolve("com.example.cli")?.manifest).toEqual(second);
    expect(registry.resolve("nope")).toBeUndefined();
  });

  test("duplicate extension ids fail closed", () => {
    const registry = createExtensionRegistry();
    registry.register(fixtureManifest());
    expect(() => registry.register(fixtureManifest())).toThrow(/already registered/);
  });

  test("tool name collisions across extensions fail closed", () => {
    const registry = createExtensionRegistry();
    registry.register(fixtureManifest());
    const collision = { ...cliManifest(), tools: [fixtureManifest().tools[0]] };
    expect(() => registry.register(collision)).toThrow(/already registered by extension "fixture.weather"/);
  });

  test("conformance: every registered extension resolves", () => {
    const registry = createExtensionRegistry();
    registry.register(fixtureManifest());
    registry.register(cliManifest());
    for (const entry of registry.list()) {
      expect(registry.resolve(entry.manifest.id)).toBeDefined();
      expect(registry.resolve(entry.manifest.id)?.manifest.id).toBe(entry.manifest.id);
    }
    expect(registry.list().length).toBeGreaterThan(0);
  });

  test("toolNames unions extension tools in registration order, deduped", () => {
    const registry = createExtensionRegistry();
    registry.register(fixtureManifest());
    expect(registry.toolNames()).toEqual([FIXTURE_EXTENSION_TOOL]);
    registry.register(cliManifest());
    expect(registry.toolNames()).toEqual([FIXTURE_EXTENSION_TOOL, "example.query"]);
  });

  test("egressDomains unions extension domains, deduped", () => {
    const registry = createExtensionRegistry();
    registry.register(fixtureManifest());
    registry.register({ ...cliManifest(), domains: ["api.example.com", "fixture.weather.test"] });
    expect(registry.egressDomains()).toEqual(["fixture.weather.test", "api.example.com"]);
  });

  test("a snapshot-seeded registry resolves its pinned extensions", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-snapshots-"));
    try {
      writeFileSync(join(dir, "fixture.weather.json"), snapshotJson(snapshotFor()));
      const registry = createExtensionRegistry(dir);
      expect(registry.list()).toHaveLength(1);
      const resolved = registry.resolve(FIXTURE_EXTENSION_ID);
      expect(resolved?.manifest.id).toBe(FIXTURE_EXTENSION_ID);
      expect(resolved?.snapshot?.source.catalog).toBe("https://integrations.sh/api");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing snapshot directory yields an empty registry", () => {
    const registry = createExtensionRegistry(join(tmpdir(), "does-not-exist-50"));
    expect(registry.list()).toEqual([]);
  });
});

describe("pinned snapshots", () => {
  test("parses a valid snapshot and matches manifest.id to extensionId", () => {
    const snapshot = parsePinnedSnapshot(snapshotJson(snapshotFor()));
    expect(snapshot.schema).toBe(SNAPSHOT_SCHEMA);
    expect(snapshot.extensionId).toBe(FIXTURE_EXTENSION_ID);
    expect(snapshot.manifest.id).toBe(FIXTURE_EXTENSION_ID);
  });

  test("rejects non-JSON and unknown schema markers (fail closed)", () => {
    expect(() => parsePinnedSnapshot("not json")).toThrow(/not valid JSON/);
    const doc = JSON.parse(snapshotJson(snapshotFor())) as Record<string, unknown>;
    doc["schema"] = "something-else";
    expect(() => parsePinnedSnapshot(JSON.stringify(doc))).toThrow(/schema must be/);
  });

  test("rejects an extensionId/manifest.id mismatch", () => {
    const doc = snapshotJson(snapshotFor(fixtureManifest(), { extensionId: "other.id" }));
    expect(() => parsePinnedSnapshot(doc)).toThrow(/does not match manifest.id/);
  });

  test("rejects a malformed manifest inside the snapshot", () => {
    const snapshot = snapshotFor();
    const doc = JSON.parse(snapshotJson(snapshot)) as Record<string, unknown>;
    (doc["manifest"] as Record<string, unknown>)["kind"] = "http";
    expect(() => parsePinnedSnapshot(JSON.stringify(doc))).toThrow(/extension manifest invalid/);
  });

  test("rejects unreviewed community snapshots (fail closed)", () => {
    const snapshot = snapshotFor(fixtureManifest(), {
      source: { catalog: "https://integrations.sh/api", specId: "community", vendorOfficial: false, reviewed: false },
    });
    expect(() => parsePinnedSnapshot(snapshotJson(snapshot))).toThrow(/requires explicit review/);
  });

  test("accepts a reviewed community snapshot", () => {
    const snapshot = snapshotFor(fixtureManifest(), {
      source: { catalog: "https://integrations.sh/api", specId: "community", vendorOfficial: false, reviewed: true },
    });
    expect(parsePinnedSnapshot(snapshotJson(snapshot)).source.reviewed).toBe(true);
  });

  test("readPinnedSnapshots loads all snapshot files sorted and fails on any malformed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-snapshots-"));
    try {
      writeFileSync(join(dir, "b.json"), snapshotJson(snapshotFor()));
      writeFileSync(join(dir, "a.json"), snapshotJson(snapshotFor(fixtureManifest(), { pinnedAt: "2026-01-01T00:00:00.000Z" })));
      writeFileSync(join(dir, "notes.txt"), "ignored");
      const snapshots = readPinnedSnapshots(dir);
      expect(snapshots.map((s) => s.extensionId)).toEqual([FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_ID]);
      expect(snapshots[0].pinnedAt).toBe("2026-01-01T00:00:00.000Z");

      writeFileSync(join(dir, "c.json"), "{ broken");
      expect(() => readPinnedSnapshots(dir)).toThrow(ExtensionRegistryError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("duplicate snapshot files for one id fail the seeded registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-snapshots-"));
    try {
      writeFileSync(join(dir, "a.json"), snapshotJson(snapshotFor()));
      writeFileSync(join(dir, "b.json"), snapshotJson(snapshotFor()));
      expect(() => createExtensionRegistry(dir)).toThrow(/already registered/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fixture registry resolves and carries snapshot-free provenance", () => {
    const registry = createFixtureRegistry();
    const resolved = registry.resolve(FIXTURE_EXTENSION_ID);
    expect(resolved?.manifest.id).toBe(FIXTURE_EXTENSION_ID);
    expect(resolved?.snapshot).toBeUndefined();
  });
});
