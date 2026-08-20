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
import { AuthStorage, REMOTE_REFRESH_SENTINEL, type AuthCredential } from "@oh-my-pi/pi-ai";
import { createReconcileEgress, type ReconcileEgressDeps } from "./egress-reconcile";
import { type PinnedSnapshot } from "./registry";
import type { RuntimeExtensionRow } from "../store/db";
import type { McpOAuthRefreshProbe, RotatedTokenPersister, VaultOAuthCredential } from "./proxy-seed";
import { createVaultTokenStore } from "./mcp-oauth";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bottega-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** Apply env for the duration of `fn`, restoring the prior values after. */
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * A hermetic stand-in auth broker (issue #252): an in-process `Bun.serve`
 * backed by a REAL `AuthStorage` over the given sqlite `agent.db`. It
 * serves the broker snapshot surface (real refresh tokens REDACTED to
 * REMOTE_REFRESH_SENTINEL, client identity stripped — the actual broker's
 * wire behavior) and the `POST /v1/credential` connect leg (writes the
 * REAL credential into the on-disk vault).
 */
async function startFakeBroker(dbPath: string): Promise<{ url: string; token: string; stop: () => Promise<void> }> {
  const token = "bottega-test-broker-token";
  const storage = await AuthStorage.create(dbPath);
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/snapshot") {
        const credentials = storage.listStoredCredentials().map((entry) => ({
          id: entry.id,
          provider: entry.provider,
          credential: redactForBroker(entry.credential),
          identityKey: null,
          rotatesInMs: null,
        }));
        return Response.json({
          generation: 0,
          generatedAt: Date.now(),
          serverNowMs: Date.now(),
          refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
          credentials,
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/credential") {
        return (async () => {
          const body = (await req.json()) as { provider: string; credential: VaultOAuthCredential };
          storage.upsertCredential(body.provider, body.credential);
          const entries = storage.listStoredCredentials(body.provider).map((entry) => ({
            id: entry.id,
            provider: entry.provider,
            credential: redactForBroker(entry.credential),
            identityKey: null,
          }));
          return Response.json({ entries });
        })();
      }
      if (url.pathname === "/v1/healthz") return Response.json({ ok: true });
      return Response.json({ ok: false }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    stop: async () => {
      storage.close();
      server.stop();
    },
  };
}

/** Mirror the real broker: redact the refresh token + strip client identity off the wire. */
function redactForBroker(credential: AuthCredential): Record<string, unknown> {
  if (credential.type !== "oauth") return credential;
  return { type: "oauth", refresh: REMOTE_REFRESH_SENTINEL, access: credential.access, expires: credential.expires };
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
  /** Leave readVaultRows unset and exercise the production default reader (issue #252). */
  defaultReader?: boolean;
  env?: NodeJS.ProcessEnv;
  proxyControl?: { proxyControlUrl?: string; proxyControlToken?: string };
  /** Refresh-grant seam (issue #269): forwarded to the blob seed. */
  refreshOAuthToken?: McpOAuthRefreshProbe;
  /** Rotated-token vault write-back seam (issue #269): forwarded to the blob seed. */
  persistRotatedToken?: RotatedTokenPersister;
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
    readVaultRows: opts.defaultReader ? undefined : opts.readVaultRows ?? (async () => []),
    env: opts.env,
    log: () => {},
    refreshOAuthToken: opts.refreshOAuthToken,
    persistRotatedToken: opts.persistRotatedToken,
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

  test("the connect-time reconcile refreshes a renewable credential and writes the rotated token to the vault + blob (issue #269)", async () => {
    // The connect leg re-seeds the blob — the SAME refresh-on-seed the
    // boot sync runs: a renewable credential (refresh + client id +
    // secret) is refreshed app-side, and the endpoint's ROTATED token is
    // written to BOTH the vault row (the broker write seam) and the blob.
    const persisted: Array<{ provider: string; credential: VaultOAuthCredential }> = [];
    const h = makeHarness({
      committed: [["linear", linear]],
      runtimeRows: [
        { id: "notion", snapshot: JSON.stringify(notion), registered_by: "test-user", space_id: null, created_at: Date.now(), updated_at: Date.now() },
      ],
      readVaultRows: async () => [{ refresh: "rt-notion", clientId: "cli_notion", clientSecret: "cs_notion" }],
      refreshOAuthToken: async () => ({
        minted: true,
        accessToken: "acc-minted",
        refreshToken: "rt-notion-rotated",
        expiresInMs: 3_600_000,
      }),
      persistRotatedToken: async (provider, credential) => {
        persisted.push({ provider, credential });
      },
    });

    const result = await h.reconcile("notion");
    expect(result.warnings).toEqual([]);

    // The blob carries the ROTATED token — not the vault row's original.
    const blobPath = join(h.secretsDir, "notion-oauth.json");
    expect(existsSync(blobPath)).toBe(true);
    const blob = JSON.parse(readFileSync(blobPath, "utf8")) as { refresh_token?: string };
    expect(blob.refresh_token).toBe("rt-notion-rotated");
    // The broker write seam was called with the rotated token.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.provider).toBe("notion");
    expect(persisted[0]!.credential.refresh).toBe("rt-notion-rotated");
  });

  test("a regen for a DIFFERENT extension does not drop the runtime provider", async () => {
    // Reproduces the 16:29 clobber: notion registered at runtime; the
    // operator regens egress for a DIFFERENT extension ("linear").
    const h = makeHarness({
      committed: [["linear", linear]],
      runtimeRows: [
        { id: "notion", snapshot: JSON.stringify(notion), registered_by: "test-user", space_id: null, created_at: Date.now(), updated_at: Date.now() },
      ],
      readVaultRows: async () => [{ refresh: "rt-notion", clientId: "cli_notion" }],
    });

    const result = await h.reconcile("linear");
    expect(result.warnings).toEqual([]);

    // The superset union means the notion entry SURVIVES the linear regen
    // (refreshable row → not excluded from the oauth_token entries).
    for (const path of [h.egressPath, h.devEgressPath]) {
      const yaml = readFileSync(path, "utf8");
      expect(yaml).toContain("mcp.notion.com");
      expect(yaml).toContain("notion-oauth.json");
    }
  });

  test("decision B: a NON-RENEWABLE provider (no refresh row) keeps its allowlist + secrets entries but NO oauth_token entry", async () => {
    const h = makeHarness({
      committed: [["notion", notion]],
      runtimeRows: [],
      // The notion connect persisted an access-only credential (refresh ""
      // or absent — nothing refreshable anywhere).
      readVaultRows: async () => [{ refresh: "", clientId: "cli_notion" }],
    });

    const result = await h.reconcile("notion");
    expect(result.warnings).toEqual([]);

    // The blob is deleted (nothing to seed)…
    const blobPath = join(h.secretsDir, "notion-oauth.json");
    expect(existsSync(blobPath)).toBe(false);

    // …the strict allowlist still carries the provider's domain (the dev
    // config is allow-all "*" — the domain never appears there)…
    const strict = readFileSync(h.egressPath, "utf8");
    expect(strict).toContain("mcp.notion.com");
    // …but the oauth_token MINT entry is GONE from BOTH configs: with
    // require: true it would 502 every runtime call even though the SDK
    // sent a valid access token (the boundary secrets injection carries it
    // instead).
    for (const path of [h.egressPath, h.devEgressPath]) {
      expect(readFileSync(path, "utf8")).not.toContain("notion-oauth.json");
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

  test("broker-backed rows seed the blob through the DEFAULT vault reader (issue #252)", async () => {
    // A freshly connected provider's row lives in the BROKER's vault
    // (data/.omp/agent/agent.db), NOT the embedded local one — the
    // reconcile MUST read the same vault the connect leg writes.
    const brokerDir = tempDir("broker-vault");
    const dbPath = join(brokerDir, "agent.db");
    const seeded = await AuthStorage.create(dbPath);
    const seededRow = {
      type: "oauth" as const,
      refresh: "rt-notion-broker",
      access: "acc-notion",
      expires: Date.now() + 3_600_000,
      client_id: "cli_notion_broker",
      client_secret: "cs_notion_broker",
    } satisfies VaultOAuthCredential;
    seeded.upsertCredential("notion", seededRow);
    seeded.close();

    const broker = await startFakeBroker(dbPath);
    try {
      await withEnv(
        {
          OMP_AUTH_BROKER_URL: broker.url,
          OMP_AUTH_BROKER_TOKEN: broker.token,
          OMP_AUTH_BROKER_SNAPSHOT_TTL_MS: "0",
          "BOTTEGA_BROKER_AGENT_DIR": brokerDir,
        },
        async () => {
          const h = makeHarness({ committed: [["linear", linear]], defaultReader: true });
          const result = await h.reconcile("notion");
          expect(result.warnings).toEqual([]);
          const blobPath = join(h.secretsDir, "notion-oauth.json");
          // Defect: the reconcile's default reader read the EMBEDDED local
          // storage (no broker rows → blob deleted). It must read the broker vault.
          expect(existsSync(blobPath)).toBe(true);
          const blob = JSON.parse(readFileSync(blobPath, "utf8")) as {
            refresh_token?: string;
            client_id?: string;
            client_secret?: string;
          };
          expect(blob).toEqual({
            refresh_token: "rt-notion-broker",
            client_id: "cli_notion_broker",
            client_secret: "cs_notion_broker",
          });
        },
      );
    } finally {
      await broker.stop();
    }
  });

  test("round-trip: connect-through-broker save then reconcile seed from ONE vault (issue #252)", async () => {
    const brokerDir = tempDir("broker-vault");
    const broker = await startFakeBroker(join(brokerDir, "agent.db"));
    try {
      await withEnv(
        {
          OMP_AUTH_BROKER_URL: broker.url,
          OMP_AUTH_BROKER_TOKEN: broker.token,
          OMP_AUTH_BROKER_SNAPSHOT_TTL_MS: "0",
          "BOTTEGA_BROKER_AGENT_DIR": brokerDir,
        },
        async () => {
          // The REAL connect leg: save tokens through the broker, which
          // stores the REAL credential in its own agent.db.
          const connected = {
            type: "oauth" as const,
            refresh: "rt-notion-broker",
            access: "acc-notion",
            expires: Date.now() + 3_600_000,
            client_id: "cli_notion_broker",
            client_secret: "cs_notion_broker",
          } satisfies VaultOAuthCredential;
          await createVaultTokenStore().save("notion", connected);

          // Reconcile with the default (un-injected) vault reader: the SAME
          // vault the connect leg just wrote.
            const h = makeHarness({ committed: [["linear", linear]], defaultReader: true });
            const result = await h.reconcile("notion");
            expect(result.warnings).toEqual([]);
            const blobPath = join(h.secretsDir, "notion-oauth.json");
            expect(existsSync(blobPath)).toBe(true);
            const blob = JSON.parse(readFileSync(blobPath, "utf8")) as { refresh_token?: string };
            expect(blob.refresh_token).toBe("rt-notion-broker");
        },
      );
    } finally {
      await broker.stop();
    }
  });

  test("fail-closed with a broker: a never-materialized broker vault still deletes the blob (issue #252)", async () => {
    // The broker IS configured, but its vault file has never been created
    // (broker not run yet). The default reader must NOT materialize the
    // broker's db at reconcile time — it returns no rows and the seed
    // fails closed exactly like the broker-less route. No broker server
    // is started: post-fix the reader never talks to the broker.
    const brokerDir = tempDir("broker-vault-empty");
    await withEnv(
      {
        OMP_AUTH_BROKER_URL: "http://127.0.0.1:1",
        OMP_AUTH_BROKER_TOKEN: "bottega-absent-broker-token",
        OMP_AUTH_BROKER_SNAPSHOT_TTL_MS: "0",
        "BOTTEGA_BROKER_AGENT_DIR": brokerDir,
      },
      async () => {
        const h = makeHarness({ committed: [["linear", linear]], defaultReader: true });
        const blobPath = join(h.secretsDir, "notion-oauth.json");
        mkdirSync(h.secretsDir, { recursive: true });
        writeFileSync(blobPath, JSON.stringify({ refresh_token: "stale" }));
        await h.reconcile("notion");
        // The absent-vault reader returned no rows → the seed deleted the
        // stale blob (fail closed).
        expect(existsSync(blobPath)).toBe(false);
      },
    );
  });

  test("production default reads the broker vault's agent SUBDIR, not the config root (issue #252)", async () => {
    // The REAL broker vault is <config-root>/data/.omp/agent/agent.db — the
    // broker runs with PI_CONFIG_DIR=<config root> and keeps its vault in
    // the agent/ subdir, so the default agent dir is data/.omp/agent. A
    // stray data/.omp/agent.db (a stale pre-broker file) must NOT be the
    // seed source. This test exercises the PRODUCTION default resolution:
    // NO BOTTEGA_BROKER_AGENT_DIR override, cwd hoisted to a fixture laid
    // out exactly like the real shared-data mount.
    const root = tempDir("broker-vault-default");
    const agentDir = join(root, "data", ".omp", "agent");
    mkdirSync(agentDir, { recursive: true });
    // A stale PRE-broker agent.db at the config root carries only a legacy
    // api_key row. The default must NOT treat it as the OAuth vault.
    const stale = await AuthStorage.create(join(root, "data", ".omp", "agent.db"));
    stale.upsertCredential("github", { type: "api_key", key: "ghp_stale" });
    stale.close();
    const seeded = await AuthStorage.create(join(agentDir, "agent.db"));
    const defaultRow = {
      type: "oauth" as const,
      refresh: "rt-notion-default",
      access: "acc-notion",
      expires: Date.now() + 3_600_000,
      client_id: "cli_notion_default",
      client_secret: "cs_notion_default",
    } satisfies VaultOAuthCredential;
    seeded.upsertCredential("notion", defaultRow);
    seeded.close();

    const broker = await startFakeBroker(join(agentDir, "agent.db"));
    const cwd = process.cwd();
    try {
      process.chdir(root);
      await withEnv(
        {
          OMP_AUTH_BROKER_URL: broker.url,
          OMP_AUTH_BROKER_TOKEN: broker.token,
          OMP_AUTH_BROKER_SNAPSHOT_TTL_MS: "0",
        },
        async () => {
          const h = makeHarness({ committed: [["linear", linear]], defaultReader: true });
          const result = await h.reconcile("notion");
          expect(result.warnings).toEqual([]);
          const blobPath = join(h.secretsDir, "notion-oauth.json");
          expect(existsSync(blobPath)).toBe(true);
          const blob = JSON.parse(readFileSync(blobPath, "utf8")) as { refresh_token?: string };
          expect(blob.refresh_token).toBe("rt-notion-default");
        },
      );
    } finally {
      process.chdir(cwd);
      await broker.stop();
    }
  });

  test("two notion rows: the DCR grant with a per-user client id wins the seed (issue #252)", async () => {
    // The broker vault keeps EVERY grant, ascending by id. notion has an
    // older pre-#250 row (real refresh, NO client identity) inserted before
    // the live DCR grant (real refresh + per-user client_id). A plain
    // `rows.find(refresh)` wins the OLD row, finds no client id, and fails
    // closed with the NOTION_OAUTH_CLIENT_ID warning — the seed must prefer
    // the row that ALSO carries a resolvable client identity.
    const brokerDir = tempDir("broker-vault-dcr");
    const dbPath = join(brokerDir, "agent.db");
    const seeded = await AuthStorage.create(dbPath);
    seeded.upsertCredential("notion", {
      type: "oauth",
      refresh: "rt-notion-old",
      access: "acc-old",
      expires: Date.now() + 3_600_000,
    });
    const dcr = {
      type: "oauth" as const,
      refresh: "rt-notion-dcr",
      access: "acc-dcr",
      expires: Date.now() + 3_600_000,
      client_id: "cli_notion_dcr",
      client_secret: "cs_notion_dcr",
    } satisfies VaultOAuthCredential;
    seeded.upsertCredential("notion", dcr);
    seeded.close();

    const broker = await startFakeBroker(dbPath);
    try {
      await withEnv(
        {
          OMP_AUTH_BROKER_URL: broker.url,
          OMP_AUTH_BROKER_TOKEN: broker.token,
          OMP_AUTH_BROKER_SNAPSHOT_TTL_MS: "0",
          "BOTTEGA_BROKER_AGENT_DIR": brokerDir,
        },
        async () => {
          const h = makeHarness({ committed: [["linear", linear]], defaultReader: true });
          const result = await h.reconcile("notion");
          // Old failure mode: the first no-client row won the find() and the
          // seed deleted the blob with the NOTION_OAUTH_CLIENT_ID warning.
          expect(result.warnings.join(" ")).not.toContain("NOTION_OAUTH_CLIENT_ID");
          const blobPath = join(h.secretsDir, "notion-oauth.json");
          expect(existsSync(blobPath)).toBe(true);
          const blob = JSON.parse(readFileSync(blobPath, "utf8")) as {
            refresh_token?: string;
            client_id?: string;
            client_secret?: string;
          };
          // The LIVE DCR grant wins: per-user client id, not the env fallback.
          expect(blob.refresh_token).toBe("rt-notion-dcr");
          expect(blob.client_id).toBe("cli_notion_dcr");
          expect(blob.client_secret).toBe("cs_notion_dcr");
        },
      );
    } finally {
      await broker.stop();
    }
  });
});
