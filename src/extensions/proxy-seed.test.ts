/**
 * Proxy credential sync tests (issue #208 Wave 2): the boot-time path that
 * seeds iron-proxy with the LIVE provider credentials. Hermetic — injected
 * env/vault/Keychain/OAuth seams, a temp secrets dir (the #191 pattern),
 * and a loopback management stub for the reload half. No real network, no
 * real Keychain, no live proxy.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_AUTH_FILE_ENV,
  CODEX_OAUTH_CLIENT_ID,
  decodeCodexJwtExp,
  MODEL_PROXY_KEYS,
  proxyKeyFileName,
  proxyOAuthBlobFileName,
  readCodexAuthTokens,
  syncProxyCredentialsFromEnv,
  writeCodexAuthTokens,
} from "./proxy-seed";
import type { JsonValue } from "./manifest";

const NO_VAULT = (): Promise<Map<string, string>> => Promise.resolve(new Map());
const NO_KEYCHAIN = (): Promise<string | null> => Promise.resolve(null);
const NO_ROWS = (): Promise<Array<{ refresh?: string }>> => Promise.resolve([]);
const SILENT = (): void => {};

function tempSecretsDir() {
  const dir = mkdtempSync(join(tmpdir(), "bottega-proxy-seed-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A Codex CLI auth.json fixture in a temp dir (never a real home file). */
function codexAuthFile(auth: JsonValue) {
  const dir = mkdtempSync(join(tmpdir(), "bottega-codex-auth-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(auth));
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A JWT-shaped access token fixture whose payload carries the given `exp`
 * (seconds since epoch) — the seed's re-refresh trigger decodes exactly
 * this claim (issue #230). The header/signature segments are opaque.
 */
function jwtAccessToken(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `header.${payload}.signature`;
}

/** Seconds since epoch `hours` from now. */
function expInHours(hours: number): number {
  return Math.floor(Date.now() / 1_000) + hours * 60 * 60;
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
      const expected = new Map<string, string>([
        ["near", "near-env"],
        ["opencode", "opencode-env"],
        ["openai", "openai-env"],
        ["anthropic", "anthropic-env"],
      ]);
      for (const key of MODEL_PROXY_KEYS) {
        const path = join(s.dir, proxyKeyFileName(key.provider));
        expect(readFileSync(path, "utf8")).toBe(expected.get(key.provider)!);
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

  test("a broken row with an EMPTY refresh never displaces a row with a real refresh (issue #256)", async () => {
    const s = tempSecretsDir();
    try {
      // Row 4: the proven-working grant (real refresh + its DCR client).
      // Row 5: a newer connect that (pre-#256) persisted an EMPTY refresh —
      // it MUST NOT win the seed no matter how fresh its DCR client is.
      const rows = [
        { id: 4, refresh: "row-4-refresh", clientId: "client-old", expires: Date.now() + 3_600_000 },
        { id: 5, refresh: "", clientId: "broken-client", expires: Date.now() + 3_600_000 },
      ];
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) => (provider === "linear" ? rows : []),
        log: SILENT,
      });
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("linear")), "utf8"));
      expect(blob).toEqual({ refresh_token: "row-4-refresh", client_id: "client-old" });
    } finally {
      s.cleanup();
    }
  });

  test("an UNEXPIRED refresh row is seeded over an expired one, even when the expired row is older (issue #256)", async () => {
    const s = tempSecretsDir();
    try {
      // The older row's access token is already expired (its server-side
      // grant has been superseded); the newer row is fresh. The seed must
      // prefer the unexpired grant — not the oldest client-id row.
      const rows = [
        { id: 4, refresh: "stale-refresh", clientId: "client-old", expires: Date.now() - 3_600_000 },
        { id: 6, refresh: "fresh-refresh", clientId: "client-new", expires: Date.now() + 3_600_000 },
      ];
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) => (provider === "linear" ? rows : []),
        log: SILENT,
      });
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("linear")), "utf8"));
      expect(blob.refresh_token).toBe("fresh-refresh");
      expect(blob.client_id).toBe("client-new");
    } finally {
      s.cleanup();
    }
  });

  test("the NEWEST equally-viable row wins — a re-auth's fresh grant supersedes the older one it invalidated (issue #256)", async () => {
    const s = tempSecretsDir();
    try {
      // After a re-auth, BOTH rows carry a real, unexpired refresh + a DCR
      // client; the NEWER row is the registration the server still honors
      // (the older client was invalidated server-side by the re-auth), so
      // the seed must pick the newest, not the oldest.
      const rows = [
        { id: 4, refresh: "row-4-refresh", clientId: "client-invalidated", expires: Date.now() + 3_600_000 },
        { id: 6, refresh: "row-6-refresh", clientId: "client-live", expires: Date.now() + 3_600_000 },
      ];
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) => (provider === "linear" ? rows : []),
        log: SILENT,
      });
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("linear")), "utf8"));
      expect(blob).toEqual({ refresh_token: "row-6-refresh", client_id: "client-live" });
    } finally {
      s.cleanup();
    }
  });
});

describe("codex static credential (issue #214 + #230)", () => {
  test("a Codex CLI auth file seeds the static openai-codex.secret AND the codex-oauth.json blob (mode 0600, access + refresh + client id)", async () => {
    const s = tempSecretsDir();
    const auth = codexAuthFile({
      tokens: { access_token: "codex-access-1", refresh_token: "codex-refresh-1", id_token: "never-read" },
    });
    try {
      const env: NodeJS.ProcessEnv = { [CODEX_AUTH_FILE_ENV]: auth.path };
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        log: SILENT,
      });
      // The egress static entry reads openai-codex.secret (issue #230): the
      // access token, mode 0600, atomic.
      const secretPath = join(s.dir, proxyKeyFileName("openai-codex"));
      expect(readFileSync(secretPath, "utf8")).toBe("codex-access-1");
      expect(statSync(secretPath).mode & 0o777).toBe(0o600);
      // The rotation-persistence blob keeps the same shape as before.
      const blobPath = join(s.dir, proxyOAuthBlobFileName("openai-codex"));
      const blob = JSON.parse(readFileSync(blobPath, "utf8"));
      expect(blob).toEqual({
        access_token: "codex-access-1",
        refresh_token: "codex-refresh-1",
        client_id: CODEX_OAUTH_CLIENT_ID,
      });
      expect(statSync(blobPath).mode & 0o777).toBe(0o600);
      // The credential never enters the app env (the path is a setting, not the secret).
      expect(env[CODEX_AUTH_FILE_ENV]).toBe(auth.path);
      expect(Object.values(env)).not.toContain("codex-access-1");
    } finally {
      auth.cleanup();
      s.cleanup();
    }
  });

  test("a missing auth file DELETES the secret + blob (fail closed — require: true 502s)", async () => {
    const s = tempSecretsDir();
    try {
      const staleBlob = join(s.dir, proxyOAuthBlobFileName("openai-codex"));
      const staleSecret = join(s.dir, proxyKeyFileName("openai-codex"));
      writeFileSync(staleBlob, "{}", { mode: 0o600 });
      writeFileSync(staleSecret, "stale", { mode: 0o600 });
      await syncProxyCredentialsFromEnv({
        env: { [CODEX_AUTH_FILE_ENV]: join(s.dir, "does-not-exist.json") },
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        log: SILENT,
      });
      expect(existsSync(staleBlob)).toBe(false);
      expect(existsSync(staleSecret)).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("an unparseable auth file or missing tokens DELETES the secret + blob (fail closed)", async () => {
    const s = tempSecretsDir();
    const blobPath = join(s.dir, proxyOAuthBlobFileName("openai-codex"));
    const secretPath = join(s.dir, proxyKeyFileName("openai-codex"));
    try {
      // Invalid JSON.
      const bad = codexAuthFile("not json at all");
      await syncProxyCredentialsFromEnv({
        env: { [CODEX_AUTH_FILE_ENV]: bad.path },
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        log: SILENT,
      });
      expect(existsSync(blobPath)).toBe(false);
      expect(existsSync(secretPath)).toBe(false);
      bad.cleanup();
      // Valid JSON, no tokens.access_token.
      const noAccess = codexAuthFile({ tokens: { refresh_token: "codex-refresh-1" } });
      writeFileSync(blobPath, "{}", { mode: 0o600 });
      writeFileSync(secretPath, "stale", { mode: 0o600 });
      await syncProxyCredentialsFromEnv({
        env: { [CODEX_AUTH_FILE_ENV]: noAccess.path },
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        log: SILENT,
      });
      expect(existsSync(blobPath)).toBe(false);
      expect(existsSync(secretPath)).toBe(false);
      noAccess.cleanup();
    } finally {
      s.cleanup();
    }
  });

  test("under the test runner, an UNSET CODEX_AUTH_PATH never reads a real home auth file (fail closed)", async () => {
    // The #191 isolation rule: with NODE_ENV=test and no explicit path, the
    // sync must NOT touch ~/.codex/auth.json on the dev machine — it treats
    // the source as absent and deletes the boundary files.
    const s = tempSecretsDir();
    try {
      const staleBlob = join(s.dir, proxyOAuthBlobFileName("openai-codex"));
      const staleSecret = join(s.dir, proxyKeyFileName("openai-codex"));
      writeFileSync(staleBlob, "{}", { mode: 0o600 });
      writeFileSync(staleSecret, "stale", { mode: 0o600 });
      const log: string[] = [];
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        log: (line) => log.push(line),
      });
      expect(existsSync(staleBlob)).toBe(false);
      expect(existsSync(staleSecret)).toBe(false);
      expect(log.join("\n")).toContain("openai-codex.secret + openai-codex-oauth.json REMOVED");
    } finally {
      s.cleanup();
    }
  });

  test("readCodexAuthTokens parses the Codex CLI shape and rejects malformed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-codex-parse-"));
    try {
      const path = join(dir, "auth.json");
      writeFileSync(path, JSON.stringify({ tokens: { access_token: "at", refresh_token: "rt" } }));
      expect(readCodexAuthTokens(path)).toEqual({ accessToken: "at", refreshToken: "rt" });
      writeFileSync(path, "not json");
      expect(readCodexAuthTokens(path)).toBeNull();
      writeFileSync(path, JSON.stringify({ tokens: { access_token: "at" } }));
      expect(readCodexAuthTokens(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Missing file → null.
    expect(readCodexAuthTokens("/nonexistent/codex-auth.json")).toBeNull();
  });

  test("decodeCodexJwtExp reads the exp claim without verifying the signature (issue #230)", () => {
    // A real JWT's payload segment carries the numeric exp (seconds).
    expect(decodeCodexJwtExp(jwtAccessToken(1_800_000_000))).toBe(1_800_000_000);
    // Non-JWT / malformed payloads / missing or non-numeric exp → null
    // (the seed treats null as "cannot verify freshness" and refreshes).
    expect(decodeCodexJwtExp("codex-access-1")).toBeNull();
    expect(decodeCodexJwtExp("a.b")).toBeNull();
    expect(decodeCodexJwtExp("a.b.c.d")).toBeNull();
    expect(decodeCodexJwtExp(`a.${Buffer.from("not json").toString("base64url")}.c`)).toBeNull();
    expect(decodeCodexJwtExp(`a.${Buffer.from('{"exp":"soon"}').toString("base64url")}.c`)).toBeNull();
  });

  test("a FRESH access token (exp > 24h away) is written statically — NO refresh round-trip (issue #230)", async () => {
    const s = tempSecretsDir();
    // exp 7 days out — far beyond the 24h re-refresh window.
    const accessToken = jwtAccessToken(expInHours(24 * 7));
    const auth = codexAuthFile({
      tokens: { access_token: accessToken, refresh_token: "codex-refresh-1" },
    });
    try {
      const env: NodeJS.ProcessEnv = { [CODEX_AUTH_FILE_ENV]: auth.path };
      let probeCalls = 0;
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        log: SILENT,
        // Must never be called: the fresh token needs no refresh.
        mintCodexRefreshToken: async () => {
          probeCalls += 1;
          throw new Error("probe must not run for a fresh access token");
        },
      });
      expect(probeCalls).toBe(0);
      const secretPath = join(s.dir, proxyKeyFileName("openai-codex"));
      expect(readFileSync(secretPath, "utf8")).toBe(accessToken);
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("openai-codex")), "utf8"));
      expect(blob.refresh_token).toBe("codex-refresh-1");
      // The CLI auth file is untouched (no refresh happened).
      expect(readFileSync(auth.path, "utf8")).toContain("codex-refresh-1");
    } finally {
      auth.cleanup();
      s.cleanup();
    }
  });

  test("an access token within 24h of expiry triggers the seed's re-refresh — the MINTED token lands in the static secret, the rotated refresh token is written back to the blob + auth file (issue #230)", async () => {
    const s = tempSecretsDir();
    // exp 1 hour out — inside the 24h re-refresh window.
    const auth = codexAuthFile({
      tokens: { access_token: jwtAccessToken(expInHours(1)), refresh_token: "codex-refresh-1" },
    });
    try {
      const env: NodeJS.ProcessEnv = { [CODEX_AUTH_FILE_ENV]: auth.path };
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        log: SILENT,
        // The endpoint minted a fresh access token AND rotated the refresh
        // token (the seed's own refresh — the proxy no longer mints).
        mintCodexRefreshToken: async () => ({
          minted: true,
          accessToken: "codex-access-minted",
          refreshToken: "codex-refresh-2-rotated",
        }),
      });
      // The static secret carries the MINTED access token.
      expect(readFileSync(join(s.dir, proxyKeyFileName("openai-codex")), "utf8")).toBe("codex-access-minted");
      // The rotation-persistence blob carries the minted access + rotated refresh token.
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("openai-codex")), "utf8"));
      expect(blob).toEqual({
        access_token: "codex-access-minted",
        refresh_token: "codex-refresh-2-rotated",
        client_id: CODEX_OAUTH_CLIENT_ID,
      });
      // Rotation write-back keeps the CLI session valid (issue #218 helper).
      const written = JSON.parse(readFileSync(auth.path, "utf8"));
      expect(written.tokens.refresh_token).toBe("codex-refresh-2-rotated");
    } finally {
      auth.cleanup();
      s.cleanup();
    }
  });
});

describe("codex mint probe + rotation write-back (issue #218)", () => {
  const OK_PROBE = (refreshToken: string) => async () => ({ minted: true, refreshToken });

  test("a dead refresh token (mint probe 401) makes the seed THROW with the remedy and never writes the secret or blob", async () => {
    const s = tempSecretsDir();
    const auth = codexAuthFile({
      tokens: { access_token: "codex-access-1", refresh_token: "codex-refresh-1" },
    });
    try {
      // Stale boundary files from a previous boot must not survive a dead token.
      const blobPath = join(s.dir, proxyOAuthBlobFileName("openai-codex"));
      const secretPath = join(s.dir, proxyKeyFileName("openai-codex"));
      writeFileSync(blobPath, "{}", { mode: 0o600 });
      writeFileSync(secretPath, "stale", { mode: 0o600 });
      const env: NodeJS.ProcessEnv = { [CODEX_AUTH_FILE_ENV]: auth.path };
      await expect(
        syncProxyCredentialsFromEnv({
          env,
          secretsDir: s.dir,
          fetchVault: NO_VAULT,
          readKeychain: NO_KEYCHAIN,
          readOAuthRows: NO_ROWS,
          log: SILENT,
          mintCodexRefreshToken: async () => ({ minted: false, status: 401, refreshToken: "codex-refresh-1" }),
        }),
      ).rejects.toThrow(/codex login/); // the boot error names the remedy
      await expect(
        syncProxyCredentialsFromEnv({
          env,
          secretsDir: s.dir,
          fetchVault: NO_VAULT,
          readKeychain: NO_KEYCHAIN,
          readOAuthRows: NO_ROWS,
          log: SILENT,
          mintCodexRefreshToken: async () => ({ minted: false, status: 401, refreshToken: "codex-refresh-1" }),
        }),
      ).rejects.toThrow(/restart the server/);
      expect(existsSync(blobPath)).toBe(false); // never a silent write of a dead token
      expect(existsSync(secretPath)).toBe(false);
    } finally {
      auth.cleanup();
      s.cleanup();
    }
  });

  test("a verified refresh token (mint probe 200) writes the static secret + blob with the file tokens", async () => {
    const s = tempSecretsDir();
    const auth = codexAuthFile({
      tokens: { access_token: "codex-access-1", refresh_token: "codex-refresh-1" },
    });
    try {
      const env: NodeJS.ProcessEnv = { [CODEX_AUTH_FILE_ENV]: auth.path };
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        log: SILENT,
        mintCodexRefreshToken: OK_PROBE("codex-refresh-1"),
      });
      // The static secret carries the (unrotated) access token — the probe
      // returned no minted access token, so the file's token is kept.
      expect(readFileSync(join(s.dir, proxyKeyFileName("openai-codex")), "utf8")).toBe("codex-access-1");
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("openai-codex")), "utf8"));
      expect(blob).toEqual({
        access_token: "codex-access-1",
        refresh_token: "codex-refresh-1",
        client_id: CODEX_OAUTH_CLIENT_ID,
      });
    } finally {
      auth.cleanup();
      s.cleanup();
    }
  });

  test("the endpoint's rotated refresh token is written back to the blob AND the auth file (fields + mode preserved)", async () => {
    const s = tempSecretsDir();
    const auth = codexAuthFile({
      tokens: { access_token: "codex-access-1", refresh_token: "codex-refresh-1", id_token: "keep-me" },
    });
    try {
      const env: NodeJS.ProcessEnv = { [CODEX_AUTH_FILE_ENV]: auth.path };
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        log: SILENT,
        // The token endpoint rotated the refresh token on the probe mint.
        mintCodexRefreshToken: OK_PROBE("codex-refresh-2-rotated"),
      });
      // The static secret keeps the file's access token (no minted token
      // in this probe stub); the blob + auth file carry the rotated one.
      expect(readFileSync(join(s.dir, proxyKeyFileName("openai-codex")), "utf8")).toBe("codex-access-1");
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("openai-codex")), "utf8"));
      expect(blob.refresh_token).toBe("codex-refresh-2-rotated");
      // The CLI auth file was patched in place: rotated token, everything
      // else preserved (issue #214: only tokens.* ever enter the app).
      const written = JSON.parse(readFileSync(auth.path, "utf8"));
      expect(written.tokens.refresh_token).toBe("codex-refresh-2-rotated");
      expect(written.tokens.access_token).toBe("codex-access-1");
      expect(written.tokens.id_token).toBe("keep-me");
      expect(statSync(auth.path).mode & 0o777).toBe(0o644); // mode preserved (fixture 0644)
    } finally {
      auth.cleanup();
      s.cleanup();
    }
  });

  test("an unverifiable probe (endpoint unreachable) warns and still writes the secret + blob (transient ≠ dead)", async () => {
    const s = tempSecretsDir();
    const auth = codexAuthFile({
      tokens: { access_token: "codex-access-1", refresh_token: "codex-refresh-1" },
    });
    try {
      const log: string[] = [];
      const env: NodeJS.ProcessEnv = { [CODEX_AUTH_FILE_ENV]: auth.path };
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: NO_ROWS,
        log: (line) => log.push(line),
        mintCodexRefreshToken: async () => ({ minted: false, refreshToken: "codex-refresh-1" }),
      });
      expect(existsSync(join(s.dir, proxyKeyFileName("openai-codex")))).toBe(true);
      expect(existsSync(join(s.dir, proxyOAuthBlobFileName("openai-codex")))).toBe(true);
      expect(log.join("\n")).toContain("could not be verified");
      expect(readFileSync(auth.path, "utf8")).toContain("codex-refresh-1"); // auth file untouched
    } finally {
      auth.cleanup();
      s.cleanup();
    }
  });

  test("writeCodexAuthTokens preserves unknown top-level fields and skips unchanged tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-codex-writeback-"));
    try {
      const path = join(dir, "auth.json");
      writeFileSync(path, JSON.stringify({ oauth_account: "acct", tokens: { access_token: "at", refresh_token: "rt" } }), { mode: 0o644 });
      writeCodexAuthTokens(path, "rt"); // unchanged → no rewrite
      expect(JSON.parse(readFileSync(path, "utf8")).tokens.refresh_token).toBe("rt");
      writeCodexAuthTokens(path, "rt-rotated");
      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written.tokens.refresh_token).toBe("rt-rotated");
      expect(written.tokens.access_token).toBe("at");
      expect(written.oauth_account).toBe("acct");
      expect(statSync(path).mode & 0o777).toBe(0o644);
      // A missing file is a no-op (the blob still carries the rotated token).
      writeCodexAuthTokens(join(dir, "missing.json"), "rt-rotated");
      expect(existsSync(join(dir, "missing.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
