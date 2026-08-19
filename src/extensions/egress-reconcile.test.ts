/**
 * Issue #250 acceptance (seam tier): a successful OAuth connect reconciles
 * the egress proxy plane. RED on current main — pre-fix, the proxy OAuth
 * blob was boot-only (defect A) and egress regeneration passed NO runtime
 * set (defect B — a later regen for an unrelated extension dropped a
 * runtime-registered provider like notion from the running proxy config).
 *
 * Pins, RED→GREEN:
 *   - after a runtime connect of an OAuth provider (a fake registry row +
 *     per-user vault client creds), the proxy OAuth blob exists and the
 *     regenerated egress + dev-egress carry the provider's domain +
 *     oauth_token entry, WITHOUT a boot;
 *   - a subsequent regen for a DIFFERENT extension does NOT drop the
 *     runtime-registered provider (the superset union survives);
 *   - fail-closed: a refresh row with no resolvable client id yields a
 *     LOUD receivable warning naming NOTION_OAUTH_CLIENT_ID and never a
 *     half-wired blob.
 *
 * Hermetic (tier-2): REAL temp dirs + a real registry + a fake store /
 * vault-row seam + a fake proxy control — no network, no boot.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReconcileEgress, type ReconcileEgressDeps } from "./egress-reconcile";
import { type PinnedSnapshot } from "./registry";
import type { RuntimeExtensionRow } from "../store/db";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bottega-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** A committed-pin-style snapshot document (same shape as config/extensions/linear.json). */
function pinSnapshot(id: string, label: string, domain: string): PinnedSnapshot {
  return {
    schema: "bottega.extension-snapshot.v1",
    extensionId: id,
    pinnedAt: "2026-08-18T00:00:00.000Z",
    source: {
      catalog: "https://integrations.sh/api.json",
      specId: id,
      vendorOfficial: true,
      reviewed: true,
    },
    manifest: {
      id,
      label,
      vendor: label,
      kind: "mcp",
      mcp: { serverUrl: `https://${domain}/mcp`, transport: "streamable-http" },
      credentialSchema: { type: "oauth", scopes: ["read", "write"] },
      domains: [domain],
    },
  };
}

/** One held temp harness: committed pins + runtime rows + reconcile callable. */
interface Harness {
  reconcile: (provider: string) => Promise<{ warnings: string[] }>;
  secretsDir: string;
  egressPath: string;
  devEgressPath: string;
}

function makeHarness(opts: {
  committed?: Array<[string, PinnedSnapshot]>;
  runtimeRows?: RuntimeExtensionRow[];
  readVaultRows?: (provider: string) => Promise<Array<{ refresh?: string; clientId?: string; clientSecret?: string }>>;
  env?: NodeJS.ProcessEnv;
  proxyControl?: { proxyControlUrl?: string; proxyControlToken?: string };
}): Harness {
  const root = tempDir("egress-reconcile");
  const snapshotsDir = join(root, "extensions");
  const secretsDir = join(root, "secrets");
  const egressPath = join(root, "egress.yml");
  const devEgressPath = join(root, "egress.dev.yml");
  mkdirSync(snapshotsDir, { recursive: true });
  for (const [file, pin] of opts.committed ?? []) {
    writeFileSync(join(snapshotsDir, `${file}.json`), JSON.stringify(pin, null, 2));
  }
  const store = {
    listRuntimeExtensions: async () => opts.runtimeRows ?? [],
  };
  const deps: ReconcileEgressDeps = {
    store,
    snapshotsDir,
    secretsDir,
    egressPath,
    devEgressPath,
    proxyControl: opts.proxyControl,
    readVaultRows: opts.readVaultRows ?? (async () => []),
    env: opts.env,
    log: () => {},
  };
  return { reconcile: createReconcileEgress(deps), secretsDir, egressPath, devEgressPath };
}

const notion = pinSnapshot("notion", "Notion", "mcp.notion.com");
const linear = pinSnapshot("linear", "Linear", "mcp.linear.app");

describe("connect-time egress reconcile (#250)", () => {
  test("a runtime OAuth connect yields the blob + superset egress without a boot", async () => {
    const h = makeHarness({
      committed: [["linear", linear]],
      runtimeRows: [
        { id: "notion", snapshot: JSON.stringify(notion), registered_by: "test-user", space_id: null, created_at: Date.now(), updated_at: Date.now() },
      ],
      readVaultRows: async () => [
        { refresh: "rt-notion", clientId: "cli_notion", clientSecret: "cs_notion" },
      ],
    });

    const result = await h.reconcile("notion");
    expect(result.warnings).toEqual([]);

    // Defect A: no boot — the provider's proxy OAuth blob is seeded now.
    const blobPath = join(h.secretsDir, "notion-oauth.json");
    expect(existsSync(blobPath)).toBe(true);
    const blob = JSON.parse(readFileSync(blobPath, "utf8")) as {
      refresh_token?: string;
      client_id?: string;
      client_secret?: string;
    };
    expect(blob.refresh_token).toBe("rt-notion");
    expect(blob.client_id).toBe("cli_notion");
    expect(blob.client_secret).toBe("cs_notion");

    // Both egress configs carry the runtime-registered provider.
    for (const path of [h.egressPath, h.devEgressPath]) {
      const yaml = readFileSync(path, "utf8");
      expect(yaml).toContain("mcp.notion.com");
      expect(yaml).toContain("notion-oauth.json");
    }
  });

  test("a regen for a DIFFERENT extension does not drop the runtime provider", async () => {
    // Reproduces the 16:29 clobber: notion registered at runtime; the
    // operator regens egress for a DIFFERENT extension ("linear").
    const h = makeHarness({
      committed: [["linear", linear]],
      runtimeRows: [
        { id: "notion", snapshot: JSON.stringify(notion), registered_by: "test-user", space_id: null, created_at: Date.now(), updated_at: Date.now() },
      ],
      readVaultRows: async () => [],
    });

    const result = await h.reconcile("linear");
    expect(result.warnings).toEqual([]);

    // The superset union means the notion entry SURVIVES the linear regen.
    for (const path of [h.egressPath, h.devEgressPath]) {
      const yaml = readFileSync(path, "utf8");
      expect(yaml).toContain("mcp.notion.com");
      expect(yaml).toContain("notion-oauth.json");
    }
  });

  test("fail-closed: refresh without a client id names NOTION_OAUTH_CLIENT_ID, never a half-wired blob", async () => {
    const h = makeHarness({
      committed: [["linear", linear]],
      runtimeRows: [],
      // A freshened env + a per-user row carrying a refresh but NO client
      // identity: the blob cannot mint — fail closed, loud + receivable.
      env: {},
      readVaultRows: async () => [{ refresh: "rt-notion" }],
    });

    const result = await h.reconcile("notion");
    // Reconcile NEVER throws: the connect stays successful, the gap is a
    // receivable warning naming the env var the operator must satisfy.
    expect(result.warnings.join(" ")).toContain("NOTION_OAUTH_CLIENT_ID");
    expect(result.warnings.join(" ")).toContain("notion-oauth.json");
    expect(existsSync(join(h.secretsDir, "notion-oauth.json"))).toBe(false);
  });
});
