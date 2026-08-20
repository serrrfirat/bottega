/**
 * Issue #250 acceptance (seam tier): a successful OAuth connect reconciles
 * the egress proxy plane — the egress/dev-egress configs regenerate from
 * the SUPERSET (committed repo pins ∪ runtime-registered rows) so a regen
 * for ANY one extension never drops another provider's allowlist, and the
 * running proxy reloads via the control boundary.
 *
 * Issue #284: the reconcile touches NO OAuth credentials — no vault OAuth
 * rows, no `<provider>-oauth.json` blob seeding/probing, no refresh-grant
 * POST. The MCP SDK owns OAuth for hosted MCP calls and tools/list; the
 * proxy is transport/allowlist only, so allowlist regen + reload is the
 * ENTIRE reconcile. The tests below prove exactly that: OAuth extension
 * domains allowlist, and zero credential side effects exist.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReconcileEgress, type ReconcileEgress, type ReconcileEgressDeps } from "./egress-reconcile";
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
  reconcile: ReconcileEgress;
  secretsDir: string;
  egressPath: string;
  devEgressPath: string;
}

function makeHarness(opts: {
  committed?: Array<[string, PinnedSnapshot]>;
  runtimeRows?: RuntimeExtensionRow[];
  proxyControl?: { proxyControlUrl?: string; proxyControlToken?: string };
  log?: (line: string) => void;
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
    egressPath,
    devEgressPath,
    proxyControl: opts.proxyControl,
    log: opts.log ?? (() => {}),
  };
  return { reconcile: createReconcileEgress(deps), secretsDir, egressPath, devEgressPath };
}

const notion = pinSnapshot("notion", "Notion", "mcp.notion.com");
const linear = pinSnapshot("linear", "Linear", "mcp.linear.app");

describe("connect-time egress reconcile (#250, #284)", () => {
  test("a runtime OAuth connect regenerates the superset egress WITHOUT a boot — domains allowlisted, ZERO credential side effects", async () => {
    const h = makeHarness({
      committed: [["linear", linear]],
      runtimeRows: [
        { id: "notion", snapshot: JSON.stringify(notion), registered_by: "test-user", space_id: null, created_at: Date.now(), updated_at: Date.now() },
      ],
    });

    const result = await h.reconcile("notion");
    expect(result.warnings).toEqual([]);

    // Issue #284: NO provider OAuth blob is seeded/probed/written — the
    // proxy plane is transport/allowlist only. The reconcile never even
    // reads a vault credential (there is no vault seam anymore).
    expect(existsSync(join(h.secretsDir, "notion-oauth.json"))).toBe(false);
    expect(existsSync(join(h.secretsDir, "linear-oauth.json"))).toBe(false);

    // Both egress configs carry NO oauth_token transform / blob / token
    // endpoint anywhere; the STRICT config's allowlist carries the
    // runtime-registered provider's domains (the dev config is allow-all
    // "*" — domains never appear there by design).
    for (const path of [h.egressPath, h.devEgressPath]) {
      const yaml = readFileSync(path, "utf8");
      expect(yaml).not.toContain("- name: oauth_token");
      expect(yaml).not.toContain("notion-oauth.json");
      expect(yaml).not.toContain("token_endpoint:");
      expect(yaml).not.toContain("grant: refresh_token");
    }
    const strict = readFileSync(h.egressPath, "utf8");
    expect(strict).toContain("mcp.notion.com");
    expect(strict).toContain("mcp.linear.app");
    const dev = readFileSync(h.devEgressPath, "utf8");
    expect(dev).toContain('- "*"');
  });

  test("the pre-authorization preflight is the same call — allowlist regen only, never a credential probe/seed (issue #284)", async () => {
    const h = makeHarness({
      committed: [["notion", notion]],
      runtimeRows: [],
    });

    // No options exist anymore: the preflight cannot ask to exclude a mint
    // entry or skip a seed — there is no mint entry and no seed. The call
    // is exactly the post-connect call.
    const result = await h.reconcile("notion");

    expect(result.warnings).toEqual([]);
    expect(readFileSync(h.egressPath, "utf8")).toContain("mcp.notion.com");
    // No credential side effects on the preflight either.
    expect(existsSync(join(h.secretsDir, "notion-oauth.json"))).toBe(false);
  });

  test("a regen for a DIFFERENT extension does not drop the runtime provider", async () => {
    // Reproduces the 16:29 clobber: notion registered at runtime; the
    // operator regens egress for a DIFFERENT extension ("linear").
    const h = makeHarness({
      committed: [["linear", linear]],
      runtimeRows: [
        { id: "notion", snapshot: JSON.stringify(notion), registered_by: "test-user", space_id: null, created_at: Date.now(), updated_at: Date.now() },
      ],
    });

    const result = await h.reconcile("linear");
    expect(result.warnings).toEqual([]);

    // The superset union means the notion domain SURVIVES the linear regen
    // in the STRICT config; the dev config is allow-all and carries no
    // extension domains or credential artifacts.
    const strict = readFileSync(h.egressPath, "utf8");
    expect(strict).toContain("mcp.notion.com");
    expect(strict).toContain("mcp.linear.app");
    for (const path of [h.egressPath, h.devEgressPath]) {
      const yaml = readFileSync(path, "utf8");
      expect(yaml).not.toContain("notion-oauth.json");
      expect(yaml).not.toContain("- name: oauth_token");
    }
  });

  test("a configured control pair reloads the proxy after the regen", async () => {
    const reloads: string[] = [];
    const mgmt = Bun.serve({
      port: 0,
      fetch: async (req) => {
        reloads.push(req.headers.get("authorization") ?? "");
        return new Response("ok", { status: 200 });
      },
    });
    const h = makeHarness({
      committed: [["notion", notion]],
      proxyControl: { proxyControlUrl: `http://127.0.0.1:${mgmt.port}`, proxyControlToken: "mgmt-token" },
    });
    try {
      const result = await h.reconcile("notion");
      expect(result.warnings).toEqual([]);
      expect(reloads).toEqual(["Bearer mgmt-token"]);
    } finally {
      mgmt.stop(true);
    }
  });

  test("no control pair → write-only (no reload attempted, no warning)", async () => {
    const h = makeHarness({ committed: [["notion", notion]] });
    const result = await h.reconcile("notion");
    expect(result.warnings).toEqual([]);
    expect(readFileSync(h.egressPath, "utf8")).toContain("mcp.notion.com");
  });

  test("a malformed runtime row is a loud warning — regen proceeds on the committed set (issue #205 posture)", async () => {
    const h = makeHarness({
      committed: [["notion", notion]],
      runtimeRows: [{ id: "broken", snapshot: "not-json", registered_by: "x", space_id: null, created_at: Date.now(), updated_at: Date.now() }],
    });
    const result = await h.reconcile("notion");
    expect(result.warnings.join(" ")).toContain("runtime registry read failed");
    // The committed provider's domain still regenerates.
    expect(readFileSync(h.egressPath, "utf8")).toContain("mcp.notion.com");
  });

  test("a failed proxy reload is receivable, never fatal", async () => {
    const mgmt = Bun.serve({ port: 0, fetch: () => new Response("denied", { status: 401 }) });
    const h = makeHarness({
      committed: [["notion", notion]],
      proxyControl: { proxyControlUrl: `http://127.0.0.1:${mgmt.port}`, proxyControlToken: "wrong" },
    });
    try {
      const result = await h.reconcile("notion");
      expect(result.warnings.join(" ")).toContain("proxy reload failed (401)");
      // The egress regen still landed.
      expect(readFileSync(h.egressPath, "utf8")).toContain("mcp.notion.com");
    } finally {
      mgmt.stop(true);
    }
  });
});
