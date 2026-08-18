/**
 * Proxy credential sync tests (issue #208 Wave 2): the boot-time path that
 * seeds iron-proxy with the LIVE provider credentials. Hermetic — injected
 * env/vault/Keychain/OAuth seams, a temp secrets dir (the #191 pattern),
 * and a loopback management stub for the reload half. No real network, no
 * real Keychain, no live proxy.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_PROXY_KEYS,
  proxyKeyFileName,
  proxyOAuthBlobFileName,
  syncProxyCredentialsFromEnv,
} from "./proxy-seed";

const NO_VAULT = (): Promise<Map<string, string>> => Promise.resolve(new Map());
const NO_KEYCHAIN = (): Promise<string | null> => Promise.resolve(null);
const NO_ROWS = (): Promise<Array<{ refresh?: string }>> => Promise.resolve([]);
const SILENT = (): void => {};

function tempSecretsDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "bottega-proxy-seed-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("model gateway keys (issue #208)", () => {
  test("env keys seed the proxy secret files (mode 0600) for every gateway", async () => {
    const s = tempSecretsDir();
    try {
      const env: NodeJS.ProcessEnv = {
        NEAR_API_KEY: "near-env",
        OPENCODE_API_KEY: "opencode-env",
        OPENAI_API_KEY: "openai-env",
        ANTHROPIC_API_KEY: "anthropic-env",
      };
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        log: SILENT,
      });
      const expected: Record<string, string> = {
        near: "near-env",
        opencode: "opencode-env",
        openai: "openai-env",
        anthropic: "anthropic-env",
      };
      for (const key of MODEL_PROXY_KEYS) {
        const path = join(s.dir, proxyKeyFileName(key.provider));
        expect(readFileSync(path, "utf8")).toBe(expected[key.provider]);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(env[key.envName]).toBeUndefined();
      }
    } finally {
      s.cleanup();
    }
  });

  test("vault beats env; Keychain is the last leg (the #201 precedence)", async () => {
    const s = tempSecretsDir();
    try {
      const env = { NEAR_API_KEY: "near-env" };
      const vault = new Map([["near", "near-vault"]]);
      const keychain = new Map([["bottega-opencode", "opencode-kc"]]);
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: () => Promise.resolve(vault),
        readKeychain: async (service) => keychain.get(service) ?? null,
        readOAuthRows: NO_ROWS,
        log: SILENT,
      });
      expect(readFileSync(join(s.dir, "near.secret"), "utf8")).toBe("near-vault");
      expect(readFileSync(join(s.dir, "opencode.secret"), "utf8")).toBe("opencode-kc");
    } finally {
      s.cleanup();
    }
  });

  test("a key missing everywhere DELETES the file (fail closed — the config's require:true 502s)", async () => {
    const s = tempSecretsDir();
    try {
      // A stale file from a previous boot must not survive a keyless boot.
      const stale = join(s.dir, "near.secret");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(stale, "stale-key", { mode: 0o600 });
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        log: SILENT,
      });
      expect(existsSync(stale)).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("the sync is a no-op for the live default secrets dir under test (issue #191 pattern)", async () => {
    // NODE_ENV is "test" under bun test — the sync must not touch the
    // repo's live default dir: it skips (the boots in smoke/agent-dir
    // tests run in the repo cwd and verify wiring, not seeding).
    const log: string[] = [];
    await syncProxyCredentialsFromEnv({
      env: { NEAR_API_KEY: "near-env" },
      fetchVault: NO_VAULT,
      readKeychain: NO_KEYCHAIN,
      readOAuthRows: NO_ROWS,
      log: (line) => log.push(line),
    });
    expect(log.join("\n")).toContain("proxy credential sync skipped");
  });
});

describe("OAuth blobs (issue #208)", () => {
  test("a vault oauth row + client id env seed the provider's json blob", async () => {
    const s = tempSecretsDir();
    try {
      const env = { LINEAR_OAUTH_CLIENT_ID: "linear-client" };
      const rows = [{ refresh: "linear-refresh-1" }];
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) => (provider === "linear" ? rows : []),
        log: SILENT,
      });
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("linear")), "utf8"));
      expect(blob).toEqual({ refresh_token: "linear-refresh-1", client_id: "linear-client" });
      // attio has no vault row in this test → its blob is deleted (fail closed).
      expect(existsSync(join(s.dir, proxyOAuthBlobFileName("attio")))).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("a configured client secret joins the blob", async () => {
    const s = tempSecretsDir();
    try {
      const env = {
        LINEAR_OAUTH_CLIENT_ID: "linear-client",
        LINEAR_OAUTH_CLIENT_SECRET: "linear-secret",
      };
      const rows = [{ refresh: "linear-refresh-1" }];
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) => (provider === "linear" ? rows : []),
        log: SILENT,
      });
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("linear")), "utf8"));
      expect(blob).toEqual({
        refresh_token: "linear-refresh-1",
        client_id: "linear-client",
        client_secret: "linear-secret",
      });
    } finally {
      s.cleanup();
    }
  });

  test("no oauth row, a sentinel refresh, or a missing client id DELETES the blob (fail closed)", async () => {
    const s = tempSecretsDir();
    try {
      const { writeFileSync } = await import("node:fs");
      const stale = join(s.dir, proxyOAuthBlobFileName("linear"));
      writeFileSync(stale, "{}", { mode: 0o600 });
      await syncProxyCredentialsFromEnv({
        env: { LINEAR_OAUTH_CLIENT_ID: "linear-client" },
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS, // no row at all
        log: SILENT,
      });
      expect(existsSync(stale)).toBe(false);

      // Sentinel refresh (a remote broker row) → deleted.
      writeFileSync(stale, "{}", { mode: 0o600 });
      await syncProxyCredentialsFromEnv({
        env: { LINEAR_OAUTH_CLIENT_ID: "linear-client" },
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) => (provider === "linear" ? [{ refresh: "__remote__" }] : []),
        log: SILENT,
      });
      expect(existsSync(stale)).toBe(false);

      // Row present but client id env unset → deleted (the refresh grant
      // cannot mint without a client id).
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) => (provider === "linear" ? [{ refresh: "linear-refresh-1" }] : []),
        log: SILENT,
      });
      expect(existsSync(stale)).toBe(false);
    } finally {
      s.cleanup();
    }
  });
});

describe("proxy reload half (issue #123/#197 seam)", () => {
  test("a configured control pair reloads the proxy once after the writes", async () => {
    const s = tempSecretsDir();
    const reloads: string[] = [];
    const mgmt = Bun.serve({
      port: 0,
      fetch: async (req) => {
        reloads.push(req.headers.get("authorization") ?? "");
        return new Response("ok", { status: 200 });
      },
    });
    try {
      await syncProxyCredentialsFromEnv({
        env: { NEAR_API_KEY: "near-env" },
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        proxyControl: { proxyControlUrl: `http://127.0.0.1:${mgmt.port}`, proxyControlToken: "mgmt-token" },
        log: SILENT,
      });
      expect(reloads).toEqual(["Bearer mgmt-token"]);
    } finally {
      mgmt.stop(true);
      s.cleanup();
    }
  });

  test("a failed reload throws (a boot that cannot push its credentials must fail)", async () => {
    const s = tempSecretsDir();
    const mgmt = Bun.serve({ port: 0, fetch: () => new Response("denied", { status: 401 }) });
    try {
      await expect(
        syncProxyCredentialsFromEnv({
          env: { NEAR_API_KEY: "near-env" },
          secretsDir: s.dir,
          fetchVault: NO_VAULT,
          readKeychain: NO_KEYCHAIN,
          readOAuthRows: NO_ROWS,
          proxyControl: { proxyControlUrl: `http://127.0.0.1:${mgmt.port}`, proxyControlToken: "wrong" },
          log: SILENT,
        }),
      ).rejects.toThrow(/proxy credential sync reload failed \(401\)/);
    } finally {
      mgmt.stop(true);
      s.cleanup();
    }
  });

  test("no control pair → write-only (no reload attempted)", async () => {
    const s = tempSecretsDir();
    const mgmt = Bun.serve({ port: 0, fetch: () => new Response("should never be hit") });
    try {
      await syncProxyCredentialsFromEnv({
        env: { NEAR_API_KEY: "near-env" },
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        proxyControl: {},
        log: SILENT,
      });
      expect(existsSync(join(s.dir, "near.secret"))).toBe(true);
    } finally {
      mgmt.stop(true);
      s.cleanup();
    }
  });
});
