import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
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
    credentialTargets: [{ host: "api.example.com" }],
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
    const collision = { ...cliManifest(), tools: [fixtureManifest().tools![0]] };
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

  test("extensionIdForTool maps a tool name to its owning extension (issue #56)", () => {
    const registry = createExtensionRegistry();
    registry.register(fixtureManifest());
    registry.register(cliManifest());
    expect(registry.extensionIdForTool(FIXTURE_EXTENSION_TOOL)).toBe(FIXTURE_EXTENSION_ID);
    expect(registry.extensionIdForTool("example.query")).toBe("com.example.cli");
    expect(registry.extensionIdForTool("bash")).toBeUndefined();
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

  test("the committed seed resolves the pinned providers (github/linear/attio/notion) — notion re-pinned (issue #361)", () => {
    // Issue #233 removed the notion pin in favor of runtime connects — but
    // the connect flow's MCP validation probe runs BEFORE registration, and
    // on a strict deployment the probe 403s at the egress gate until the
    // domain is allowlisted. Runtime-only connects were unreachable there
    // (#361), so the reviewed seed pin is back; the runtime connect still
    // owns the credential.
    const registry = createExtensionRegistry(resolve(import.meta.dir, "../../config/extensions"));
    const notion = registry.resolve("notion");
    expect(notion).toBeDefined();
    expect(notion!.manifest.credentialSchema.type).toBe("oauth");
    expect(notion!.snapshot?.source.reviewed).toBe(true);
    const linear = registry.resolve("linear");
    expect(linear).toBeDefined();
    expect(linear!.manifest.kind).toBe("mcp");
    expect(linear!.manifest.mcp).toEqual({
      serverUrl: "https://mcp.linear.app/mcp",
      transport: "streamable-http",
    });
    expect(linear!.manifest.credentialSchema.type).toBe("oauth");
    expect(linear!.snapshot?.source.vendorOfficial).toBe(true);
  });

  test("every committed pinned snapshot registers (issue #231 + #286)", () => {
    // A dropped or malformed snapshot must not silently shrink the seeded
    // registry: the boot resolves the whole committed set, and the
    // connect/extension tools key off registry.resolve. The set is the
    // #233 seed (attio/github/linear) plus the reviewed Gmail override
    // (issue #286 §7).
    const registry = createExtensionRegistry(resolve(import.meta.dir, "../../config/extensions"));
    const ids = registry.list().map((entry) => entry.manifest.id);
    // Filename sort order: "github" < "gmail-googleapis-com" (i < m) < notion.
    expect(ids).toEqual(["attio", "github", "gmail-googleapis-com", "linear", "notion"]);
    for (const id of ids) {
      expect(registry.resolve(id)).toBeDefined();
    }
    // The Gmail override carries the reviewed official /mcp/v1 binding.
    const gmail = registry.resolve("gmail-googleapis-com");
    expect(gmail?.manifest.mcp).toEqual({
      serverUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      transport: "streamable-http",
    });
    expect(gmail?.manifest.credentialSchema).toEqual({
      type: "oauth",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    expect(gmail?.snapshot?.source.reviewed).toBe(true);
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
    // SAFETY: snapshotFor() serializes a PinnedSnapshot whose JSON carries the `schema` key; the test then corrupts it.
    const doc = JSON.parse(snapshotJson(snapshotFor())) as { schema: string };
    doc["schema"] = "something-else";
    expect(() => parsePinnedSnapshot(JSON.stringify(doc))).toThrow(/schema must be/);
  });

  test("rejects an extensionId/manifest.id mismatch", () => {
    const doc = snapshotJson(snapshotFor(fixtureManifest(), { extensionId: "other.id" }));
    expect(() => parsePinnedSnapshot(doc)).toThrow(/does not match manifest.id/);
  });

  test("rejects a malformed manifest inside the snapshot", () => {
    const snapshot = snapshotFor();
    // SAFETY: the fixture snapshot's JSON always carries `manifest.kind` (validateManifest requires it); the test then corrupts it.
    const doc = JSON.parse(snapshotJson(snapshot)) as { manifest: { kind: string } };
    doc.manifest.kind = "http";
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

  test("readPinnedSnapshots loads all snapshot files sorted and skips malformed files (issue #205)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-snapshots-"));
    try {
      writeFileSync(join(dir, "b.json"), snapshotJson(snapshotFor()));
      writeFileSync(join(dir, "a.json"), snapshotJson(snapshotFor(fixtureManifest(), { pinnedAt: "2026-01-01T00:00:00.000Z" })));
      writeFileSync(join(dir, "notes.txt"), "ignored");
      const snapshots = readPinnedSnapshots(dir);
      expect(snapshots.map((s) => s.extensionId)).toEqual([FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_ID]);
      expect(snapshots[0].pinnedAt).toBe("2026-01-01T00:00:00.000Z");

      // Issue #205: a malformed snapshot (e.g. a parked draft whose stdio
      // command is now rejected) is a loud per-file SKIP — the boot and the
      // extensions around it must survive; only the bad file registers
      // nothing. A broken JSON document and a validation-rejected manifest
      // (bare "npx" stdio command) both skip; the valid file still loads.
      const errorSpy = { calls: 0 };
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        errorSpy.calls += 1;
        origError(...args);
      };
      try {
        writeFileSync(join(dir, "c.json"), "{ broken");
        writeFileSync(
          join(dir, "d.json"),
          JSON.stringify({
            ...JSON.parse(snapshotJson(snapshotFor())),
            manifest: { ...fixtureManifest(), mcp: { command: "npx", transport: "stdio" } },
          }),
        );
        const loaded = readPinnedSnapshots(dir);
        expect(loaded.map((s) => s.extensionId)).toEqual([FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_ID]);
        expect(errorSpy.calls).toBeGreaterThanOrEqual(2);
      } finally {
        console.error = origError;
      }
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
