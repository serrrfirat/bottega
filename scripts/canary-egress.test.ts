/**
 * Hermetic regression for issue #241: the --live-slack canary leg must ALWAYS
 * ride iron-proxy. A bare-shell launch used to send the raw
 * `bottega-proxy-placeholder` bearer straight to chatgpt.com — "Could not
 * parse your authentication token" on every model turn. These tests pin the
 * caller-surface contract of scripts/canary-egress.ts — the seam
 * scripts/canary.sh --live-slack calls (eval + exec) before spawning
 * tests/e2e/canary.ts: the egress env comes from ONE canonical definition
 * and the leg FAILS CLOSED when the tunnel is unreachable, instead of ever
 * falling back to a direct egress.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EGRESS_KEYS, NO_PROXY_LIST, PROXY_TUNNEL_URL, exportProxyEnv, proxyEnv } from "./canary-egress";

function freshCwd(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "canary-egress-"));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

type EgressSnapshot = Record<string, string | undefined>;

function snapshotEgressEnv(): EgressSnapshot {
  const snapshot: EgressSnapshot = {};
  for (const key of EGRESS_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEgressEnv(snapshot: EgressSnapshot): void {
  for (const key of EGRESS_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Runs `fn` with the ambient egress env restored afterwards (hermetic). */
function withEnv(fn: () => unknown): unknown {
  const before = snapshotEgressEnv();
  try {
    return fn();
  } finally {
    restoreEgressEnv(before);
  }
}

describe("live canary egress rides iron-proxy (issue #241)", () => {
  test("exportProxyEnv applies the canonical proxy env, derived from cwd", async () => {
    const { cwd, cleanup } = freshCwd();
    try {
      await withEnv(async () => {
        const env = await exportProxyEnv(cwd, async () => true);
        expect(env.HTTP_PROXY).toBe("http://127.0.0.1:8080");
        expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8080");
        expect(env.NO_PROXY).toBe(NO_PROXY_LIST);
        expect(env.NODE_EXTRA_CA_CERTS).toBe(join(cwd, "certs", "ca.crt"));
        expect(env.SSL_CERT_FILE).toBe(join(cwd, "certs", "ca.crt"));
        // Applied to the live process env: the spawned canary inherits them.
        for (const key of EGRESS_KEYS) expect(process.env[key]).toBe(env[key]);
      });
    } finally {
      cleanup();
    }
  });

  test("egress env is a single canonical definition (one proxy URL + one NO_PROXY)", () => {
    const { cwd, cleanup } = freshCwd();
    try {
      const env = proxyEnv(cwd);
      expect(env.HTTP_PROXY).toBe(PROXY_TUNNEL_URL);
      expect(env.HTTPS_PROXY).toBe(PROXY_TUNNEL_URL);
      expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY);
      expect(env.NO_PROXY).toBe(NO_PROXY_LIST);
      expect(env.NO_PROXY).toContain("auth-broker");
      expect(env.NO_PROXY).toContain("mem0");
    } finally {
      cleanup();
    }
  });

  test("FAILS CLOSED when the tunnel is unreachable — no partial env, no direct egress", async () => {
    const { cwd, cleanup } = freshCwd();
    try {
      const before = snapshotEgressEnv();
      await expect(exportProxyEnv(cwd, async () => false)).rejects.toThrow(/iron-proxy/i);
      // Nothing was exported: the ambient env is byte-identical.
      for (const key of EGRESS_KEYS) expect(process.env[key]).toBe(before[key]);
    } finally {
      cleanup();
    }
  });
});
