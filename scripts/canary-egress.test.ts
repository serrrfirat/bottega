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

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), "canary-egress-"));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

/** The five proxy env vars the egress needs + the canonical certs-dir override (issue #301). */
const AMBIENT_KEYS = [...EGRESS_KEYS, "BOTTEGA_DEV_CERTS_DIR"] as const;

interface EgressSnapshot {
  HTTP_PROXY: string | undefined;
  HTTPS_PROXY: string | undefined;
  NO_PROXY: string | undefined;
  NODE_EXTRA_CA_CERTS: string | undefined;
  SSL_CERT_FILE: string | undefined;
  BOTTEGA_DEV_CERTS_DIR: string | undefined;
}

function snapshotEgressEnv(): EgressSnapshot {
  return {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    BOTTEGA_DEV_CERTS_DIR: process.env.BOTTEGA_DEV_CERTS_DIR,
  };
}


function restoreEgressEnv(snapshot: EgressSnapshot): void {
  for (const key of AMBIENT_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Runs `fn` with the ambient egress + canonical-certs env cleared (hermetic). */
function withEnv<T>(fn: () => T): T {
  const before = snapshotEgressEnv();
  for (const key of AMBIENT_KEYS) delete process.env[key];
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

  test("honors the CANONICAL certs dir (BOTTEGA_DEV_CERTS_DIR, issue #301) for the CA path", () => {
    // scripts/dev.sh exports BOTTEGA_DEV_CERTS_DIR=shared_certs_dir before
    // evaling canary-egress, so a dev server booted from ANY worktree trusts
    // the SAME CA the SHARED proxy terminates with — never a worktree-local
    // certs/ca.crt the shared proxy is not terminating with.
    const { cwd, cleanup } = freshCwd();
    try {
      const before = process.env.BOTTEGA_DEV_CERTS_DIR;
      process.env.BOTTEGA_DEV_CERTS_DIR = "/canonical/dev/certs";
      try {
        const env = proxyEnv(cwd);
        expect(env.NODE_EXTRA_CA_CERTS).toBe("/canonical/dev/certs/ca.crt");
        expect(env.SSL_CERT_FILE).toBe("/canonical/dev/certs/ca.crt");
        // …and NOT the worktree-local certs the cwd would otherwise imply.
        expect(env.NODE_EXTRA_CA_CERTS).not.toContain(join(cwd, "certs"));
      } finally {
        if (before === undefined) delete process.env.BOTTEGA_DEV_CERTS_DIR;
        else process.env.BOTTEGA_DEV_CERTS_DIR = before;
      }
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
