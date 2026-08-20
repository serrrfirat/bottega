/**
 * Proxy credential sync tests (issue #208 Wave 2): the boot-time path that
 * seeds iron-proxy with the LIVE provider credentials. Hermetic — injected
 * env/vault/Keychain/OAuth seams, a temp secrets dir (the #191 pattern),
 * and a loopback management stub for the reload half. No real network, no
 * real Keychain, no live proxy.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROXY_SEED_LOCK_STALE_MS,
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
import type {
  McpOAuthRefreshInput,
  McpOAuthRefreshOutcome,
  McpOAuthRefreshProbe,
  VaultOAuthCredential,
} from "./proxy-seed";

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
        TAVILY_API_KEY: "tavily-env",
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
        ["tavily", "tavily-env"],
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
      // Issue #268: the blob ALWAYS carries client_secret — "" when no
      // secret exists (the transform reads json_key "client_secret"
      // unconditionally; a MISSING key 502s the mint, an empty value
      // resolves cleanly and the oauth2 client omits it from the POST).
      expect(blob).toEqual({ refresh_token: "linear-refresh-1", client_id: "linear-client", client_secret: "" });
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
        verified_from: "linear-refresh-1",
      });
    } finally {
      s.cleanup();
    }
  });

  test("the blob ALWAYS carries client_secret — \"\" without one, the per-user vault secret when the row has one (issue #268)", async () => {
    // The oauth_token transform reads json_key "client_secret"
    // unconditionally for every provider. iron-proxy's json_key extraction
    // FAILS a mint when the key is missing from the blob (502 — fail
    // closed), so a secret-less public client must still get the key with
    // an empty value; the oauth2 client then omits the empty secret from
    // the token POST (public PKCE clients keep working). A per-user vault
    // client secret (issue #250) lands in the blob.
    const s = tempSecretsDir();
    try {
      const env = { LINEAR_OAUTH_CLIENT_ID: "linear-client" };
      // No secret anywhere → the key is present, empty.
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) => (provider === "linear" ? [{ refresh: "linear-refresh-1" }] : []),
        log: SILENT,
      });
      expect(JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("linear")), "utf8"))).toEqual({
        refresh_token: "linear-refresh-1",
        client_id: "linear-client",
        client_secret: "",
      });
      // The per-user vault row's client secret (issue #250) wins. The
      // boot env-strip consumed LINEAR_OAUTH_CLIENT_ID on the first call
      // (issue #208), so a FRESH env object is required here.
      await syncProxyCredentialsFromEnv({
        env: { LINEAR_OAUTH_CLIENT_ID: "linear-client" },
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) =>
          provider === "linear" ? [{ refresh: "linear-refresh-1", clientSecret: "row-secret" }] : [],
        log: SILENT,
      });
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("linear")), "utf8"));
      expect(blob).toEqual({
        refresh_token: "linear-refresh-1",
        client_id: "linear-client",
        client_secret: "row-secret",
        verified_from: "linear-refresh-1",
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
      expect(blob).toEqual({ refresh_token: "row-4-refresh", client_id: "client-old", client_secret: "" });
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
      expect(blob).toEqual({ refresh_token: "row-6-refresh", client_id: "client-live", client_secret: "" });
    } finally {
      s.cleanup();
    }
  });
});

describe("MCP OAuth rotation persistence (issue #269)", () => {
  test("a renewable credential (refresh + client id + secret) is refreshed at seed — the rotated token lands in the blob AND the vault", async () => {
    // iron-proxy's oauth_token transform rotates the refresh token in
    // memory on every mint and never persists it; the blob file source
    // (24h ttl) re-reads a token the proxy already consumed. The seed must
    // refresh the renewable grant APP-SIDE and write the endpoint's
    // ROTATED token back to BOTH the vault row (the broker write seam) and
    // the blob — never the vault row's consumed token verbatim.
    const s = tempSecretsDir();
    try {
      const env = {};
      const probes: McpOAuthRefreshInput[] = [];
      const persisted: Array<{ provider: string; credential: VaultOAuthCredential }> = [];
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) =>
          provider === "notion"
            ? [
                {
                  id: 9,
                  refresh: "notion-refresh-1",
                  clientId: "cli_notion",
                  clientSecret: "cs_notion",
                  expires: Date.now() + 3_600_000,
                },
              ]
            : [],
        log: SILENT,
        // The fake rotating token endpoint: mints a fresh access token and
        // rotates the refresh token on every exchange (Notion's behavior).
        refreshOAuthToken: async (input) => {
          probes.push(input);
          return { minted: true, accessToken: "acc-minted", refreshToken: "notion-refresh-2-rotated", expiresInMs: 3_600_000 };
        },
        persistRotatedToken: async (provider, credential) => {
          persisted.push({ provider, credential });
        },
      });
      // The refresh seam was called with the credential's client identity +
      // the provider's VERIFIED token endpoint (the egress map).
      expect(probes).toEqual([
        {
          refreshToken: "notion-refresh-1",
          clientId: "cli_notion",
          clientSecret: "cs_notion",
          tokenEndpoint: "https://mcp.notion.com/token",
          authMethod: undefined,
          // The default probe time bound is threaded into the probe input so
          // the production fetch aborts a hanging endpoint (issue #283 High).
          timeoutMs: 15000,
        },
      ]);
      // The ROTATED token was written back to the vault row (the broker
      // update seam) — the pre-fix code never touches the vault.
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.provider).toBe("notion");
      expect(persisted[0]!.credential.refresh).toBe("notion-refresh-2-rotated");
      // The blob carries the ROTATED token — NOT the row's original.
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("notion")), "utf8"));
      expect(blob).toEqual({
        refresh_token: "notion-refresh-2-rotated",
        client_id: "cli_notion",
        client_secret: "cs_notion",
        verified_from: "notion-refresh-1",
      });
    } finally {
      s.cleanup();
    }
  });

  test("a REJECTED refresh (invalid_grant) is never seeded renewable — the blob is deleted fail-closed", async () => {
    // A consumed/revoked refresh token fails the grant with a 4xx. The
    // credential must NOT be written as renewable: the blob is removed
    // (the proxy's require:true 502s) and the rejection is receivable —
    // never a stale blob carrying a dead token.
    const s = tempSecretsDir();
    try {
      const stale = join(s.dir, proxyOAuthBlobFileName("notion"));
      writeFileSync(stale, "{}", { mode: 0o600 });
      const log: string[] = [];
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) =>
          provider === "notion"
            ? [{ id: 9, refresh: "notion-refresh-1", clientId: "cli_notion", clientSecret: "cs_notion" }]
            : [],
        log: (line) => log.push(line),
        refreshOAuthToken: async () => ({ minted: false, status: 400, refreshToken: "notion-refresh-1" }),
        persistRotatedToken: async () => {
          throw new Error("a rejected grant must never be persisted");
        },
      });
      expect(existsSync(stale)).toBe(false);
      expect(log.join("\n")).toContain("REJECTED (HTTP 400)");
    } finally {
      s.cleanup();
    }
  });

  test("a non-renewable credential (no client secret) is unchanged — no refresh call, blob written as today", async () => {
    // Public clients (no secret) cannot be refreshed app-side: the seed
    // writes the blob exactly as before — no refresh round-trip, no vault
    // write, the empty client_secret key intact.
    const s = tempSecretsDir();
    try {
      const env = {};
      let probeCalls = 0;
      await syncProxyCredentialsFromEnv({
        env,
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) =>
          provider === "linear" ? [{ id: 9, refresh: "linear-refresh-1", clientId: "linear-client" }] : [],
        log: SILENT,
        refreshOAuthToken: async () => {
          probeCalls += 1;
          throw new Error("the refresh seam must not run for a non-renewable credential");
        },
      });
      expect(probeCalls).toBe(0);
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("linear")), "utf8"));
      expect(blob).toEqual({ refresh_token: "linear-refresh-1", client_id: "linear-client", client_secret: "" });
    } finally {
      s.cleanup();
    }
  });

  test("two independent boot syncs (separate processes) share the durable blob — the 2nd re-verifies the live rotated token B (never the consumed A), so the blob survives (issue #283)", async () => {
    // Production boots twice in the same window as SEPARATE processes: the
    // server root calls `syncProxyCredentialsFromEnv` (src/server/index.ts)
    // and a per-session MCP/executor child calls it again (src/mcp/server.ts
    // / src/executor.ts — #172 parity). A rotating single-use grant is
    // CONSUMED by the FIRST sync's probe POST (A → B); the second process
    // re-reads the SAME pre-rotation A from a stale broker snapshot and,
    // pre-fix, re-probs A → HTTP 400 → DELETES the working blob. The seed
    // must be idempotent ACROSS processes: the proxy OAuth blob (the shared
    // boundary both processes write atomically) records `verified_from`, so
    // the second process, seeing vault A already verified, probes the blob's
    // LIVE rotated token B instead of the consumed A — B is re-verified (not
    // blindly trusted); A is NEVER probed twice. The two syncs below share
    // ONLY `secretsDir` — no JS state — exactly like two independent
    // processes.
    const s = tempSecretsDir();
    try {
      // The remote token endpoint: A is accepted ONCE (single-use, rotated
      // to B); a second use of A is REJECTED. B stays valid.
      const consumed = new Set<string>();
      const accepts = new Set(["notion-refresh-1", "notion-refresh-2-rotated"]);
      const probed: string[] = [];
      const endpoint: McpOAuthRefreshProbe = async (input) => {
        probed.push(input.refreshToken);
        if (!accepts.has(input.refreshToken) || consumed.has(input.refreshToken)) {
          return { minted: false, status: 400, refreshToken: input.refreshToken };
        }
        consumed.add(input.refreshToken);
        if (input.refreshToken === "notion-refresh-1") {
          return { minted: true, accessToken: "acc-1", refreshToken: "notion-refresh-2-rotated", expiresInMs: 3_600_000 };
        }
        return { minted: true, accessToken: "acc-2", refreshToken: "notion-refresh-2-rotated", expiresInMs: 3_600_000 };
      };
      // The stale-snapshot read: EVERY process observes the PRE-rotation row
      // (the broker credential update is not re-visible to the OAuth-row
      // read in the #283 window).
      const readOAuthRows = async (provider: string) =>
        provider === "notion"
          ? [
              {
                id: 9,
                refresh: "notion-refresh-1",
                clientId: "cli_notion",
                clientSecret: "cs_notion",
                expires: Date.now() + 3_600_000,
              },
            ]
          : [];
      // Each "process" builds its OWN seed call + probe counter; they share
      // nothing but the secrets dir (the durable boundary) and the remote
      // endpoint state.
      const seedAsProcess = (probeCalls: { n: number }) =>
        syncProxyCredentialsFromEnv({
          env: {},
          secretsDir: s.dir,
          fetchVault: NO_VAULT,
          readKeychain: NO_KEYCHAIN,
          readOAuthRows,
          log: SILENT,
          refreshOAuthToken: async (input) => {
            probeCalls.n += 1;
            return endpoint(input);
          },
          persistRotatedToken: async () => {},
        });
      // Process 1 (server root): consumes A, rotates to B, seeds the blob
      // with the durable `verified_from: notion-refresh-1` marker.
      const p1 = { n: 0 };
      await seedAsProcess(p1);
      expect(p1.n).toBe(1);
      expect(existsSync(join(s.dir, proxyOAuthBlobFileName("notion")))).toBe(true);
      // Process 2 (session child root) re-reads the STALE A. It must probe
      // the blob's LIVE rotated token B (to confirm B is not revoked), never
      // the consumed A. A is probed EXACTLY once across both processes.
      const p2 = { n: 0 };
      await seedAsProcess(p2);
      expect(p2.n).toBe(1); // the 2nd process re-verifies B (not A, not zero)
      expect(probed.filter((t) => t === "notion-refresh-1")).toHaveLength(1); // A never probed twice
      expect(probed).toContain("notion-refresh-2-rotated"); // the 2nd probes B
      const blobPath = join(s.dir, proxyOAuthBlobFileName("notion"));
      expect(existsSync(blobPath)).toBe(true); // RED: 2nd sync deletes it
      const blob = JSON.parse(readFileSync(blobPath, "utf8")) as { refresh_token: string; verified_from?: string };
      expect(blob.refresh_token).toBe("notion-refresh-2-rotated"); // carries the live rotated token
      expect(blob.verified_from).toBe("notion-refresh-1"); // the durable marker
    } finally {
      s.cleanup();
    }
  });

  test("two CONCURRENT syncs (separate processes, racing) — the cross-process lock serializes them: A is probed once, the 2nd re-verifies B, the blob survives (issue #283)", async () => {
    // Two OS processes boot in the SAME window and race the shared blob.
    // Without a cross-process lock the read-check-write marker is racy: both
    // read no/incomplete marker, both probe A, the loser's HTTP 400 DELETES
    // the winner's blob (single-use A consumed by the first POST). The
    // critical section (read marker → choose token → probe → write/delete)
    // MUST be serialized by a file lock shared across processes. After the
    // fix: seeder 1 probes A → B; seeder 2 (locked after) sees vault A
    // verified and probes B; A is probed exactly once and the blob survives.
    const s = tempSecretsDir();
    try {
      const consumed = new Set<string>();
      const accepts = new Set(["notion-refresh-1", "notion-refresh-2-rotated"]);
      const probed: string[] = [];
      const endpoint: McpOAuthRefreshProbe = async (input) => {
        probed.push(input.refreshToken);
        // Simulate a real single-use grant: a NOT-yet-consumed A succeeds
        // (rotates to B); any second use of the same token 400s.
        if (!accepts.has(input.refreshToken) || consumed.has(input.refreshToken)) {
          return { minted: false, status: 400, refreshToken: input.refreshToken };
        }
        consumed.add(input.refreshToken);
        return { minted: true, accessToken: "acc", refreshToken: "notion-refresh-2-rotated", expiresInMs: 3_600_000 };
      };
      const readOAuthRows = async (provider: string) =>
        provider === "notion"
          ? [{ id: 9, refresh: "notion-refresh-1", clientId: "cli_notion", clientSecret: "cs_notion" }]
          : [];
      const seed = () =>
        syncProxyCredentialsFromEnv({
          env: {},
          secretsDir: s.dir,
          fetchVault: NO_VAULT,
          readKeychain: NO_KEYCHAIN,
          readOAuthRows,
          log: SILENT,
          refreshOAuthToken: endpoint,
          persistRotatedToken: async () => {},
        });
      // Launch both "processes" truly concurrently — neither awaits the other
      // before entering the critical section.
      await Promise.all([seed(), seed()]);
      // The single-use A must never be consumed twice.
      expect(probed.filter((t) => t === "notion-refresh-1")).toHaveLength(1);
      expect(probed).toContain("notion-refresh-2-rotated");
      const blobPath = join(s.dir, proxyOAuthBlobFileName("notion"));
      expect(existsSync(blobPath)).toBe(true); // RED (no lock): loser deletes the winner's blob
      const blob = JSON.parse(readFileSync(blobPath, "utf8")) as { refresh_token: string; verified_from?: string };
      expect(blob.refresh_token).toBe("notion-refresh-2-rotated");
      expect(blob.verified_from).toBe("notion-refresh-1");
    } finally {
      s.cleanup();
    }
  });

  test("a revoked rotated token B behind a stale verified marker is detected — the blob is deleted fail-closed loudly, never masked (issue #283)", async () => {
    // The durable `verified_from` marker must not blindly trust the blob's
    // live token: if the vault write-back of the rotated B failed (issue
    // #269) and B was subsequently revoked, reusing B unverified would seed a
    // dead grant. Under the lock, when vault A == verified_from, the seed
    // re-PROBES the blob's B; a REJECTED B (HTTP 400) deletes the blob
    // fail-closed with a receivable warning naming the reconnect path.
    const s = tempSecretsDir();
    try {
      // Seed a blob with a stale marker A→B, where the vault still holds A.
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) =>
          provider === "notion"
            ? [{ id: 9, refresh: "notion-refresh-1", clientId: "cli_notion", clientSecret: "cs_notion" }]
            : [],
        log: SILENT,
        refreshOAuthToken: async () => ({
          minted: true,
          accessToken: "acc-b",
          refreshToken: "notion-refresh-2-rotated",
          expiresInMs: 3_600_000,
        }),
        persistRotatedToken: async () => {},
      });
      expect(existsSync(join(s.dir, proxyOAuthBlobFileName("notion")))).toBe(true);
      // Vault STILL reads the stale A (write-back of B never landed). The
      // endpoint now REJECTS B (revoked). A must NOT be probed (consumed and
      // single-use) — only B.
      const probed: string[] = [];
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) =>
          provider === "notion"
            ? [{ id: 9, refresh: "notion-refresh-1", clientId: "cli_notion", clientSecret: "cs_notion" }]
            : [],
        log: SILENT,
        refreshOAuthToken: async (input) => {
          probed.push(input.refreshToken);
          return { minted: false, status: 400, refreshToken: input.refreshToken };
        },
        persistRotatedToken: async () => {},
      });
      // B was probed (not A, not skipped) and rejected → fail closed: the
      // blob is deleted (never a blob that mints nothing).
      expect(probed).toEqual(["notion-refresh-2-rotated"]);
      expect(existsSync(join(s.dir, proxyOAuthBlobFileName("notion")))).toBe(false); // deleted fail-closed
    } finally {
      s.cleanup();
    }
  });

  test("a stale `verified_from` blob does NOT mask a reconnect to a genuinely NEW token C — C is probed fresh (issue #283)", async () => {
    // The durable marker only skips re-probing the EXACT token already
    // verified. A reconnect writes a NEW token C into the vault (≠ the
    // blob's `verified_from` A), and the seed must probe C normally — never
    // silently reuse the old A-derived blob as if C were verified.
    const s = tempSecretsDir();
    try {
      // Seed a blob from a prior boot that verified A → B.
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) =>
          provider === "notion"
            ? [{ id: 9, refresh: "notion-refresh-1", clientId: "cli_notion", clientSecret: "cs_notion" }]
            : [],
        log: SILENT,
        refreshOAuthToken: async () => ({
          minted: true,
          accessToken: "acc-b",
          refreshToken: "notion-refresh-2-rotated",
          expiresInMs: 3_600_000,
        }),
        persistRotatedToken: async () => {},
      });
      expect(existsSync(join(s.dir, proxyOAuthBlobFileName("notion")))).toBe(true);
      // Reconnect: the vault row now holds a genuinely NEW grant C (a fresh
      // authorization, not the rotated B). The seed must PROBE C, not skip.
      const reads: string[] = [];
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) => {
          if (provider !== "notion") return [];
          reads.push("notion");
          return [{ id: 12, refresh: "notion-refresh-C-new", clientId: "cli_notion", clientSecret: "cs_notion" }];
        },
        log: SILENT,
        refreshOAuthToken: async (input) => {
          expect(input.refreshToken).toBe("notion-refresh-C-new");
          return { minted: true, accessToken: "acc-c", refreshToken: "notion-refresh-C-rotated", expiresInMs: 3_600_000 };
        },
        persistRotatedToken: async () => {},
      });
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("notion")), "utf8")) as {
        refresh_token: string;
        verified_from?: string;
      };
      // The new grant C was probed and its rotation persisted — the old
      // A-derived blob was replaced, never masked.
      expect(blob.refresh_token).toBe("notion-refresh-C-rotated");
      expect(blob.verified_from).toBe("notion-refresh-C-new");
    } finally {
      s.cleanup();
    }
  });

  test("an initially-invalid refresh token is never masked by a verified marker — each sync still fails closed (issue #283)", async () => {
    // The durable `verified_from` marker is ONLY written by a SUCCESSFUL
    // probe. An initial invalid_grant (A REJECTED, HTTP 400) writes NO blob,
    // so every subsequent sync re-probes A, gets 400, and deletes (never a
    // working/stale blob). Two independent syncs both fail closed.
    const s = tempSecretsDir();
    try {
      const stale = join(s.dir, proxyOAuthBlobFileName("notion"));
      writeFileSync(stale, "{}", { mode: 0o600 });
      const sync = () =>
        syncProxyCredentialsFromEnv({
          env: {},
          secretsDir: s.dir,
          fetchVault: NO_VAULT,
          readKeychain: NO_KEYCHAIN,
          readOAuthRows: async (provider) =>
            provider === "notion"
              ? [{ id: 9, refresh: "notion-refresh-1", clientId: "cli_notion", clientSecret: "cs_notion" }]
              : [],
          log: SILENT,
          refreshOAuthToken: async () => ({ minted: false, status: 400, refreshToken: "notion-refresh-1" }),
          persistRotatedToken: async () => {
            throw new Error("a rejected grant must never be persisted");
          },
        });
      await sync();
      expect(existsSync(stale)).toBe(false); // 1st sync deletes fail-closed
      await sync();
      expect(existsSync(stale)).toBe(false); // 2nd sync also fails closed (no false marker)
    } finally {
      s.cleanup();
    }
  });

  test("a probe that times out (hanging endpoint) is TRANSIENT: the lock is released and the blob is kept unverified, never deleted (issue #283 High)", async () => {
    // A hanging token endpoint must not wedge the cross-process lock holder
    // forever (a waiter would age-steal the lock and re-probe the same
    // single-use token, consuming it twice). The probe is bounded below the
    // stale ceiling; on timeout the seed treats it EXACTLY like a transport
    // error — keep the blob unverified (never a rejection/delete), and the
    // lock is released (this holder's finally runs) so a successor can take
    // it. This is a fresh seed (no prior blob) so the existing token is
    // written unverified.
    const s = tempSecretsDir();
    try {
      let probeStarted = false;
      // The endpoint NEVER answers.
      const hung = new Promise<never>(() => {});
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) =>
          provider === "notion"
            ? [{ id: 9, refresh: "notion-refresh-1", clientId: "cli_notion", clientSecret: "cs_notion" }]
            : [],
        log: SILENT,
        refreshOAuthToken: async () => {
          probeStarted = true;
          return hung;
        },
        persistRotatedToken: async () => {},
        // Tiny bound, far below the 60s stale ceiling, so nothing waits 15s.
        probeTimeoutMs: 20,
      });
      expect(probeStarted).toBe(true); // the probe really hung, then timed out
      const blobPath = join(s.dir, proxyOAuthBlobFileName("notion"));
      expect(existsSync(blobPath)).toBe(true); // KEPT, not deleted
      const blob = JSON.parse(readFileSync(blobPath, "utf8")) as { refresh_token?: string; verified_from?: string };
      expect(blob.refresh_token).toBe("notion-refresh-1"); // unverified write of the existing token
      expect(blob.verified_from).toBeUndefined(); // NOT marked verified (it timed out)
      // The lock was released by this holder's finally (a successor can take it).
      expect(existsSync(join(s.dir, proxyOAuthBlobFileName("notion") + ".lock"))).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("a probe rejection after its timeout is observed: the blob stays unverified and no unhandled rejection escapes (issue #283)", async () => {
    const s = tempSecretsDir();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    const late = Promise.withResolvers<void>();
    process.on("unhandledRejection", onUnhandled);
    try {
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) =>
          provider === "notion"
            ? [{ id: 9, refresh: "notion-refresh-1", clientId: "cli_notion", clientSecret: "cs_notion" }]
            : [],
        log: SILENT,
        refreshOAuthToken: async () => {
          const probe = Promise.withResolvers<McpOAuthRefreshOutcome>();
          // Real timer required: this contract is specifically that a platform
          // promise rejects after the production timeout has already won.
          setTimeout(() => {
            probe.reject(new Error("late token endpoint failure"));
            late.resolve();
          }, 30);
          return await probe.promise;
        },
        persistRotatedToken: async () => {},
        probeTimeoutMs: 5,
      });
      await late.promise;
      expect(unhandled).toEqual([]);
      const blob = JSON.parse(
        readFileSync(join(s.dir, proxyOAuthBlobFileName("notion")), "utf8"),
      ) as { refresh_token: string; client_id: string; client_secret: string; verified_from?: string };
      expect(blob).toEqual({ refresh_token: "notion-refresh-1", client_id: "cli_notion", client_secret: "cs_notion" });
    } finally {
      process.off("unhandledRejection", onUnhandled);
      s.cleanup();
    }
  });

  test("a dead holder's STALE lock is recovered: a seeder steals it, runs its critical section, and leaves no lock behind (proper-lockfile stale behavior) (issue #283 High)", async () => {
    // Correct cross-process lock ownership relies on the library's stale
    // mechanism, not our own nonce bookkeeping (AGENTS.md off-the-shelf
    // rule): a previous process that acquired the lock and died WITHOUT
    // releasing leaves its lock dir (<blob>.lock) behind. A fresh seeder
    // must STEAL that stale lock (aged past the stale threshold),
    // run its critical section exactly once, and release — leaving no
    // lock behind and never double-probing the single-use A.
    const s = tempSecretsDir();
    try {
      const blobPath = join(s.dir, proxyOAuthBlobFileName("notion"));
      const lockPath = blobPath + ".lock";
      // Simulate the dead holder's unreleased lock dir, aged past stale.
      mkdirSync(s.dir, { recursive: true });
      mkdirSync(lockPath);
      const stale = new Date(Date.now() - PROXY_SEED_LOCK_STALE_MS - 5_000);
      utimesSync(lockPath, stale, stale);
      // A fresh seeder proceeds: steals the stale lock, probes A once, seeds
      // the blob, and releases.
      let aProbes = 0;
      await syncProxyCredentialsFromEnv({
        env: {},
        secretsDir: s.dir,
        fetchVault: NO_VAULT,
        readKeychain: NO_KEYCHAIN,
        readOAuthRows: async (provider) =>
          provider === "notion"
            ? [{ id: 9, refresh: "notion-refresh-1", clientId: "cli_notion", clientSecret: "cs_notion" }]
            : [],
        log: SILENT,
        refreshOAuthToken: async (input) => {
          aProbes += 1;
          expect(input.refreshToken).toBe("notion-refresh-1");
          return { minted: true, accessToken: "acc", refreshToken: "notion-refresh-2-rotated", expiresInMs: 3_600_000 };
        },
        persistRotatedToken: async () => {},
      });
      // The stale lock was stolen, used, and released — none left behind.
      expect(existsSync(lockPath)).toBe(false);
      // The critical section ran exactly once and the blob was seeded.
      expect(aProbes).toBe(1);
      const blob = JSON.parse(readFileSync(blobPath, "utf8")) as { refresh_token: string; verified_from?: string };
      expect(blob.refresh_token).toBe("notion-refresh-2-rotated");
      expect(blob.verified_from).toBe("notion-refresh-1");
    } finally {
      s.cleanup();
    }
  });

  test("concurrent critical sections never overlap — the cross-process lock serializes them even when the probe is slow-but-respecting (issue #283 High)", async () => {
    // Two concurrent seeds, each probe-taking just under the timeout bound,
    // MUST NOT run their critical sections simultaneously: only one may probe
    // at a time (two simultaneous probes of a single-use rotating token =
    // double-consume). The lock serializes them even when both are slow.
    const s = tempSecretsDir();
    try {
      let active = 0;
      let maxActive = 0;
      const once = new Set<string>();
      await Promise.all([
        syncProxyCredentialsFromEnv({
          env: {},
          secretsDir: s.dir,
          fetchVault: NO_VAULT,
          readKeychain: NO_KEYCHAIN,
          readOAuthRows: async () => [
            { id: 9, refresh: "notion-refresh-1", clientId: "cli_notion", clientSecret: "cs_notion" },
          ],
          log: SILENT,
          // Slow-but-respecting: takes 5ms, tracks overlap.
          refreshOAuthToken: async (input) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            once.add(input.refreshToken);
            await new Promise((r) => setTimeout(r, 5));
            active -= 1;
            return { minted: true, refreshToken: "notion-refresh-2-rotated", accessToken: "acc", expiresInMs: 3_600_000 };
          },
          persistRotatedToken: async () => {},
          probeTimeoutMs: 1_000, // never trips; each probe finishes in 5ms
        }),
        syncProxyCredentialsFromEnv({
          env: {},
          secretsDir: s.dir,
          fetchVault: NO_VAULT,
          readKeychain: NO_KEYCHAIN,
          readOAuthRows: async () => [
            { id: 9, refresh: "notion-refresh-1", clientId: "cli_notion", clientSecret: "cs_notion" },
          ],
          log: SILENT,
          refreshOAuthToken: async (input) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            once.add(input.refreshToken);
            await new Promise((r) => setTimeout(r, 5));
            active -= 1;
            return { minted: true, refreshToken: "notion-refresh-2-rotated", accessToken: "acc", expiresInMs: 3_600_000 };
          },
          persistRotatedToken: async () => {},
          probeTimeoutMs: 1_000,
        }),
      ]);
      // The critical sections (probes) were strictly serialized: never two at
      // once. And the single-use A was probed exactly once (serialized too).
      expect(maxActive).toBe(1);
      expect(once).toEqual(new Set(["notion-refresh-1", "notion-refresh-2-rotated"]));
      const blob = JSON.parse(readFileSync(join(s.dir, proxyOAuthBlobFileName("notion")), "utf8")) as {
        refresh_token: string;
        verified_from?: string;
      };
      expect(blob.refresh_token).toBe("notion-refresh-2-rotated");
      expect(blob.verified_from).toBe("notion-refresh-1");
    } finally {
      s.cleanup();
    }
  });

  test("a hung vault write-back times out and releases the lock so a concurrent boot preserves the rotated grant (issue #283)", async () => {
    const s = tempSecretsDir();
    try {
      const logs: string[] = [];
      let aProbes = 0;
      let bProbes = 0;
      const endpoint = async (input: McpOAuthRefreshInput): Promise<McpOAuthRefreshOutcome> => {
        if (input.refreshToken === "notion-refresh-1") {
          aProbes += 1;
          return {
            minted: true,
            accessToken: "access-a",
            refreshToken: "notion-refresh-2-rotated",
            expiresInMs: 3_600_000,
          };
        }
        expect(input.refreshToken).toBe("notion-refresh-2-rotated");
        bProbes += 1;
        return {
          minted: true,
          accessToken: "access-b",
          refreshToken: "notion-refresh-2-rotated",
          expiresInMs: 3_600_000,
        };
      };
      const seed = () =>
        syncProxyCredentialsFromEnv({
          env: {},
          secretsDir: s.dir,
          fetchVault: NO_VAULT,
          readKeychain: NO_KEYCHAIN,
          readOAuthRows: async (provider) =>
            provider === "notion"
              ? [{ id: 9, refresh: "notion-refresh-1", clientId: "cli_notion", clientSecret: "cs_notion" }]
              : [],
          log: (line) => logs.push(line),
          refreshOAuthToken: endpoint,
          persistRotatedToken: async () => await Promise.withResolvers<never>().promise,
          probeTimeoutMs: 1_000,
          persistTimeoutMs: 20,
        });

      await Promise.all([seed(), seed()]);

      expect(aProbes).toBe(1);
      expect(bProbes).toBe(1);
      expect(logs.some((line) => line.includes("timed out after 20ms"))).toBe(true);
      const blobPath = join(s.dir, proxyOAuthBlobFileName("notion"));
      const blob = JSON.parse(readFileSync(blobPath, "utf8")) as { refresh_token: string; verified_from?: string };
      expect(blob.refresh_token).toBe("notion-refresh-2-rotated");
      expect(blob.verified_from).toBe("notion-refresh-1");
      expect(existsSync(blobPath + ".lock")).toBe(false);
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
