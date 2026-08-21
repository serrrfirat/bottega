/**
 * Credential boundary control wiring (issue #123): the reload half of the
 * boundary engages only when BOTH the proxy control URL and its bearer
 * token are present — a token-less reload would 401 and fail every
 * extension call, so the pair gates together; unset stays write-only (the
 * hermetic fallback). Pure env mapping, tested hermetically.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brokerSecretResolverFromEnv,
  createSecretFileBoundary,
  onePasswordConnectResolver,
  proxyBoundaryControlFromEnv,
  renderScopedAuthorizationEntries,
  SCOPED_AUTHORIZATIONS_BEGIN,
  SCOPED_AUTHORIZATIONS_END,
  secretResolverFromSettings,
  type AuthorizationContext,
  type SecretResolverRef,
} from "./boundary";
import type { ExtensionCredential } from "../store/db";
import type { OrgSecretsBackendSettings, OrgSettings } from "../store/org-settings";

describe("proxyBoundaryControlFromEnv (issue #123)", () => {
  test("both vars set -> the boundary reloads the proxy", () => {
    expect(
      proxyBoundaryControlFromEnv({
        BOTTEGA_PROXY_CONTROL_URL: "http://127.0.0.1:9092",
        BOTTEGA_PROXY_CONTROL_TOKEN: "mgmt-token",
      }),
    ).toEqual({ proxyControlUrl: "http://127.0.0.1:9092", proxyControlToken: "mgmt-token" });
  });

  test("neither var set -> write-only boundary (no reload)", () => {
    expect(proxyBoundaryControlFromEnv({})).toEqual({});
  });

  test("URL without a token -> write-only (a token-less reload would 401)", () => {
    expect(proxyBoundaryControlFromEnv({ BOTTEGA_PROXY_CONTROL_URL: "http://127.0.0.1:9092" })).toEqual({});
  });

  test("token without a URL -> write-only", () => {
    expect(proxyBoundaryControlFromEnv({ BOTTEGA_PROXY_CONTROL_TOKEN: "mgmt-token" })).toEqual({});
  });

  test("empty-string values are treated as unset", () => {
    expect(
      proxyBoundaryControlFromEnv({ BOTTEGA_PROXY_CONTROL_URL: "", BOTTEGA_PROXY_CONTROL_TOKEN: "" }),
    ).toEqual({});
  });

  test("defaults to process.env when no env is passed", () => {
    const beforeUrl = process.env.BOTTEGA_PROXY_CONTROL_URL;
    const beforeToken = process.env.BOTTEGA_PROXY_CONTROL_TOKEN;
    try {
      delete process.env.BOTTEGA_PROXY_CONTROL_URL;
      delete process.env.BOTTEGA_PROXY_CONTROL_TOKEN;
      expect(proxyBoundaryControlFromEnv()).toEqual({});
      process.env.BOTTEGA_PROXY_CONTROL_URL = "http://127.0.0.1:9092";
      process.env.BOTTEGA_PROXY_CONTROL_TOKEN = "t";
      expect(proxyBoundaryControlFromEnv()).toEqual({
        proxyControlUrl: "http://127.0.0.1:9092",
        proxyControlToken: "t",
      });
    } finally {
      if (beforeUrl === undefined) delete process.env.BOTTEGA_PROXY_CONTROL_URL;
      else process.env.BOTTEGA_PROXY_CONTROL_URL = beforeUrl;
      if (beforeToken === undefined) delete process.env.BOTTEGA_PROXY_CONTROL_TOKEN;
      else process.env.BOTTEGA_PROXY_CONTROL_TOKEN = beforeToken;
    }
  });
});

describe("request-scoped credential boundary (issues #317 and #307)", () => {
  const ALICE = {
    id: "alice",
    provider: "github",
    vault_provider: "github",
    identity_key: "alice",
    owner: "alice",
    scope: "personal",
    broker_credential_id: 1,
    pending_vault_provider: null,
    pending_broker_credential_id: null,
    pending_identity_key: null,
    retiring_broker_credential_id: null,
    status: "active",
    revision: 1,
    created_at: 0,
    updated_at: 0,
  } satisfies ExtensionCredential;
  const BOB = {
    ...ALICE,
    id: "bob",
    identity_key: "bob",
    owner: "bob",
    broker_credential_id: 2,
  } satisfies ExtensionCredential;
  const TARGETS = [{ host: "api.example.com", pathPrefix: "/mcp" }] as const;

  function proxyConfig(): string {
    return `transforms:
  - name: secrets
    config:
      secrets:
${SCOPED_AUTHORIZATIONS_BEGIN}
${SCOPED_AUTHORIZATIONS_END}
`;
  }

  test("two overlapping principals keep distinct authority and revoke in completion order", async () => {
    const root = mkdtempSync(join(tmpdir(), "scoped-boundary-"));
    const configPath = join(root, "egress.yml");
    writeFileSync(configPath, proxyConfig());
    const reloads: string[] = [];
    const management = Bun.serve({
      port: 0,
      fetch: () => {
        reloads.push(readFileSync(configPath, "utf8"));
        return new Response("ok");
      },
    });
    const boundary = createSecretFileBoundary({
      secretsDir: join(root, "secrets"),
      proxyConfigPath: configPath,
      proxyControlUrl: `http://127.0.0.1:${management.port}`,
      proxyControlToken: "management-token",
      resolveSecret: async (credential) => `secret-${credential.owner}`,
    });
    const aliceGate = Promise.withResolvers<void>();
    const bobGate = Promise.withResolvers<void>();
    const aliceReady = Promise.withResolvers<void>();
    const bobReady = Promise.withResolvers<void>();
    let aliceContext!: AuthorizationContext;
    let bobContext!: AuthorizationContext;
    try {
      const alice = boundary.runWithAuthorization(
        { credential: ALICE, targets: TARGETS, callId: "call-alice" },
        async (context) => {
          aliceContext = context;
          aliceReady.resolve();
          await aliceGate.promise;
          return "alice";
        },
      );
      const bob = boundary.runWithAuthorization(
        { credential: BOB, targets: TARGETS, callId: "call-bob" },
        async (context) => {
          bobContext = context;
          bobReady.resolve();
          await bobGate.promise;
          return "bob";
        },
      );
      await Promise.all([aliceReady.promise, bobReady.promise]);
      const active = readFileSync(configPath, "utf8");
      expect(active).toContain(aliceContext.placeholder);
      expect(active).toContain(bobContext.placeholder);
      expect(aliceContext.placeholder).not.toBe(bobContext.placeholder);
      const files = readdirSync(join(root, "secrets", "scoped")).sort();
      expect(files).toHaveLength(2);
      expect(
        files.map((file) => readFileSync(join(root, "secrets", "scoped", file), "utf8")).sort(),
      ).toEqual(["secret-alice", "secret-bob"]);
      for (const file of files) {
        expect(statSync(join(root, "secrets", "scoped", file)).mode & 0o777).toBe(0o600);
      }

      bobGate.resolve();
      await expect(bob).resolves.toBe("bob");
      expect(readFileSync(configPath, "utf8")).not.toContain(bobContext.placeholder);
      expect(readFileSync(configPath, "utf8")).toContain(aliceContext.placeholder);

      aliceGate.resolve();
      await expect(alice).resolves.toBe("alice");
      const revoked = readFileSync(configPath, "utf8");
      expect(revoked).not.toContain(aliceContext.placeholder);
      expect(revoked).not.toContain(bobContext.placeholder);
      expect(readdirSync(join(root, "secrets", "scoped"))).toEqual([]);
      expect(reloads.length).toBeGreaterThanOrEqual(5);
    } finally {
      bobGate.resolve();
      aliceGate.resolve();
      management.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exception, timeout, and caller abort revoke before returning", async () => {
    const root = mkdtempSync(join(tmpdir(), "scoped-boundary-revoke-"));
    const configPath = join(root, "egress.yml");
    writeFileSync(configPath, proxyConfig());
    const management = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    let expire!: () => void;
    const boundary = createSecretFileBoundary({
      secretsDir: join(root, "secrets"),
      proxyConfigPath: configPath,
      proxyControlUrl: `http://127.0.0.1:${management.port}`,
      proxyControlToken: "management-token",
      resolveSecret: async () => "secret",
      scheduleExpiry: (callback) => {
        expire = callback;
        return () => {};
      },
    });
    try {
      await expect(
        boundary.runWithAuthorization(
          { credential: ALICE, targets: TARGETS, callId: "exception" },
          async () => {
            throw new Error("provider failed");
          },
        ),
      ).rejects.toThrow("provider failed");
      expect(readdirSync(join(root, "secrets", "scoped"))).toEqual([]);

      const timeoutReady = Promise.withResolvers<void>();
      const timeoutPending = Promise.withResolvers<never>();
      const timedOut = boundary.runWithAuthorization(
        { credential: ALICE, targets: TARGETS, callId: "timeout", timeoutMs: 5 },
        async () => {
          timeoutReady.resolve();
          return timeoutPending.promise;
        },
      );
      await timeoutReady.promise;
      expire();
      await expect(timedOut).rejects.toThrow(/expired/);
      expect(readdirSync(join(root, "secrets", "scoped"))).toEqual([]);

      const controller = new AbortController();
      const abortReady = Promise.withResolvers<void>();
      const abortPending = Promise.withResolvers<never>();
      const aborted = boundary.runWithAuthorization(
        { credential: ALICE, targets: TARGETS, callId: "abort", signal: controller.signal },
        async () => {
          abortReady.resolve();
          return abortPending.promise;
        },
      );
      await abortReady.promise;
      controller.abort(new Error("caller cancelled"));
      await expect(aborted).rejects.toThrow("caller cancelled");
      expect(readdirSync(join(root, "secrets", "scoped"))).toEqual([]);
    } finally {
      management.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reload failure and process restart leave every old context denied", async () => {
    const root = mkdtempSync(join(tmpdir(), "scoped-boundary-reload-"));
    const configPath = join(root, "egress.yml");
    writeFileSync(configPath, proxyConfig());
    const failing = Bun.serve({ port: 0, fetch: () => new Response("bad", { status: 500 }) });
    const denied = createSecretFileBoundary({
      secretsDir: join(root, "secrets"),
      proxyConfigPath: configPath,
      proxyControlUrl: `http://127.0.0.1:${failing.port}`,
      proxyControlToken: "management-token",
      resolveSecret: async () => "secret",
    });
    try {
      await expect(
        denied.runWithAuthorization(
          { credential: ALICE, targets: TARGETS, callId: "reload" },
          async () => "unreachable",
        ),
      ).rejects.toThrow(/proxy reload failed \(500\)/);
      expect(readFileSync(configPath, "utf8")).not.toContain("bottega-call-");
      expect(readdirSync(join(root, "secrets", "scoped"))).toEqual([]);
    } finally {
      failing.stop(true);
    }

    writeFileSync(
      configPath,
      proxyConfig().replace(
        SCOPED_AUTHORIZATIONS_END,
        `        - stale-call-entry\n${SCOPED_AUTHORIZATIONS_END}`,
      ),
    );
    mkdirSync(join(root, "secrets", "scoped"), { recursive: true });
    writeFileSync(join(root, "secrets", "scoped", "stale.secret"), "old-secret");
    const management = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const restarted = createSecretFileBoundary({
      secretsDir: join(root, "secrets"),
      proxyConfigPath: configPath,
      proxyControlUrl: `http://127.0.0.1:${management.port}`,
      proxyControlToken: "management-token",
      resolveSecret: async () => "new-secret",
    });
    try {
      await restarted.runWithAuthorization(
        { credential: ALICE, targets: TARGETS, callId: "after-restart" },
        async () => "ok",
      );
      expect(readFileSync(configPath, "utf8")).not.toContain("stale-call-entry");
      expect(readdirSync(join(root, "secrets", "scoped"))).toEqual([]);
    } finally {
      management.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rendered targets use segment-boundary paths and never scan query/path/body for secrets", () => {
    const rendered = renderScopedAuthorizationEntries([
      {
        fileId: "call",
        placeholder: "opaque",
        targets: [
          { host: "api.example.com", pathPrefix: "/mcp" },
          { host: "*.reviewed.example.com" },
        ],
      },
    ]);
    expect(rendered).toContain('host: "api.example.com"');
    expect(rendered).toContain('paths: ["/mcp", "/mcp/*"]');
    expect(rendered).not.toContain("/mcp-evil");
    expect(rendered).toContain('host: "*.reviewed.example.com"');
    expect(rendered).toContain("match_query: false");
    expect(rendered).toContain("match_path: false");
    expect(rendered).toContain("match_body: false");
  });
});

describe("brokerSecretResolverFromEnv (issue #54 wiring, #143)", () => {
  const BROKER_CREDENTIAL = {
    id: "ec_test",
    provider: "github",
    vault_provider: "github",
    identity_key: "api-key:dev",
    owner: "U0B9QUPCTJ5",
    scope: "personal",
    broker_credential_id: 42,
    pending_vault_provider: null,
    pending_broker_credential_id: null,
    pending_identity_key: null,
    retiring_broker_credential_id: null,
    status: "active",
    revision: 1,
    created_at: 0,
    updated_at: 0,
  } satisfies ExtensionCredential;

  /** A schema-valid broker snapshot (GET /v1/snapshot, wire schemas are strict). */
  function snapshotResponse(entries: unknown[]): string {
    return JSON.stringify({
      generation: 1,
      generatedAt: Date.now(),
      serverNowMs: Date.now(),
      refresher: { enabled: false, intervalMs: 60000, skewMs: 0, nextSweepInMs: 0 },
      credentials: entries,
    });
  }

  /** Fake broker: records the bearer it saw and serves the given snapshot. */
  function fakeBroker(entries: unknown[]) {
    const seenAuth: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname !== "/v1/snapshot") return new Response("not found", { status: 404 });
        seenAuth.push(req.headers.get("authorization") ?? "");
        return new Response(snapshotResponse(entries), { headers: { "content-type": "application/json" } });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, seenAuth, stop: () => server.stop(true) };
  }

  test("missing OMP_AUTH_BROKER_URL fails closed (the boundary never runs unauthenticated)", async () => {
    // Lazy fail-closed: the resolver is wired at boot (server boots without
    // broker env), the FIRST RESOLUTION throws with the exact missing var.
    const resolve = brokerSecretResolverFromEnv({ OMP_AUTH_BROKER_TOKEN: "bt" });
    await expect(resolve(BROKER_CREDENTIAL)).rejects.toThrow(/OMP_AUTH_BROKER_URL/);
  });

  test("missing OMP_AUTH_BROKER_TOKEN fails closed", async () => {
    const resolve = brokerSecretResolverFromEnv({ OMP_AUTH_BROKER_URL: "http://127.0.0.1:8765" });
    await expect(resolve(BROKER_CREDENTIAL)).rejects.toThrow(/OMP_AUTH_BROKER_TOKEN/);
  });

  test("empty-string values are treated as unset (fail closed)", async () => {
    const resolve = brokerSecretResolverFromEnv({ OMP_AUTH_BROKER_URL: "", OMP_AUTH_BROKER_TOKEN: "" });
    await expect(resolve(BROKER_CREDENTIAL)).rejects.toThrow(/OMP_AUTH_BROKER_URL/);
  });

  test("wiring the resolver does not throw without broker env (the server boots fail-closed)", () => {
    // Regression (issue #143): the boundary is constructed at server boot;
    // the missing-env failure must surface on the first extension call, not
    // at wiring time.
    expect(() => brokerSecretResolverFromEnv({})).not.toThrow();
    expect(() => brokerSecretResolverFromEnv()).not.toThrow();
  });

  test("resolves an api_key vault row by broker_credential_id (the GitHub PAT path)", async () => {
    const broker = fakeBroker([
      { id: 7, provider: "linear", credential: { type: "api_key", key: "lin-secret" }, identityKey: null, rotatesInMs: null },
      { id: 42, provider: "github", credential: { type: "api_key", key: "github_pat_test" }, identityKey: "api-key:dev", rotatesInMs: null },
    ]);
    try {
      const resolve = brokerSecretResolverFromEnv({
        OMP_AUTH_BROKER_URL: broker.url,
        OMP_AUTH_BROKER_TOKEN: "broker-token",
      });
      expect(await resolve(BROKER_CREDENTIAL)).toBe("github_pat_test");
      expect(broker.seenAuth).toEqual(["Bearer broker-token"]);
    } finally {
      broker.stop();
    }
  });

  test("resolves an oauth vault row to its access token (the bearer the proxy injects)", async () => {
    const broker = fakeBroker([
      { id: 42, provider: "github", credential: { type: "oauth", refresh: "__remote__", access: "oauth-access-token", expires: 9999999999 }, identityKey: "email:dev@example.com", rotatesInMs: null },
    ]);
    try {
      const resolve = brokerSecretResolverFromEnv({
        OMP_AUTH_BROKER_URL: broker.url,
        OMP_AUTH_BROKER_TOKEN: "broker-token",
      });
      expect(await resolve(BROKER_CREDENTIAL)).toBe("oauth-access-token");
    } finally {
      broker.stop();
    }
  });

  test("a missing vault row fails closed (re-connect hint, never a bare call)", async () => {
    const broker = fakeBroker([
      { id: 1, provider: "github", credential: { type: "api_key", key: "other" }, identityKey: null, rotatesInMs: null },
    ]);
    try {
      const resolve = brokerSecretResolverFromEnv({
        OMP_AUTH_BROKER_URL: broker.url,
        OMP_AUTH_BROKER_TOKEN: "broker-token",
      });
      await expect(resolve(BROKER_CREDENTIAL)).rejects.toThrow(/no vault row 42 for connection provider "github"/);
    } finally {
      broker.stop();
    }
  });

  test("a provider mismatch on the same id fails closed", async () => {
    const broker = fakeBroker([
      { id: 42, provider: "linear", credential: { type: "api_key", key: "lin" }, identityKey: null, rotatesInMs: null },
    ]);
    try {
      const resolve = brokerSecretResolverFromEnv({
        OMP_AUTH_BROKER_URL: broker.url,
        OMP_AUTH_BROKER_TOKEN: "broker-token",
      });
      await expect(resolve(BROKER_CREDENTIAL)).rejects.toThrow(/no vault row 42 for connection provider "github"/);
    } finally {
      broker.stop();
    }
  });

  test("a broker 401 (bad token) fails the extension call closed", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => new Response("unauthorized", { status: 401 }),
    });
    try {
      const resolve = brokerSecretResolverFromEnv({
        OMP_AUTH_BROKER_URL: `http://127.0.0.1:${server.port}`,
        OMP_AUTH_BROKER_TOKEN: "wrong-token",
      });
      await expect(resolve(BROKER_CREDENTIAL)).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  });

});

describe("secretResolverFromSettings (issue #190 backend selection)", () => {
  /** A schema-valid empty settings blob (getOrgSettings with no row). */
  const EMPTY_SETTINGS: OrgSettings = { ok: true, errors: [], warnings: [] };

  const REF = {
    provider: "github",
    identityKey: "api-key:dev",
    scope: "personal",
    owner: "U0B9QUPCTJ5",
    brokerCredentialId: 42,
  } satisfies SecretResolverRef;

  function snapshotResponse(entries: unknown[]): string {
    return JSON.stringify({
      generation: 1,
      generatedAt: Date.now(),
      serverNowMs: Date.now(),
      refresher: { enabled: false, intervalMs: 60000, skewMs: 0, nextSweepInMs: 0 },
      credentials: entries,
    });
  }

  function fakeBroker(entries: unknown[]) {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname !== "/v1/snapshot") return new Response("not found", { status: 404 });
        return new Response(snapshotResponse(entries), { headers: { "content-type": "application/json" } });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  test("no secrets_backend in the settings -> the omp-broker resolver (the byte-identical default)", async () => {
    const broker = fakeBroker([
      { id: 42, provider: "github", credential: { type: "api_key", key: "github_pat_test" }, identityKey: "api-key:dev", rotatesInMs: null },
    ]);
    try {
      const resolver = secretResolverFromSettings(EMPTY_SETTINGS, {
        OMP_AUTH_BROKER_URL: broker.url,
        OMP_AUTH_BROKER_TOKEN: "broker-token",
      });
      await expect(resolver.resolve(REF)).resolves.toEqual({ type: "api_key", secret: "github_pat_test" });
    } finally {
      broker.stop();
    }
  });

  test("an explicit omp-broker backend resolves from the broker vault", async () => {
    const broker = fakeBroker([
      { id: 42, provider: "github", credential: { type: "oauth", refresh: "__remote__", access: "oauth-access-token", expires: 9999999999 }, identityKey: "api-key:dev", rotatesInMs: null },
    ]);
    try {
      const resolver = secretResolverFromSettings(
        { ...EMPTY_SETTINGS, secretsBackend: { type: "omp-broker" } },
        { OMP_AUTH_BROKER_URL: broker.url, OMP_AUTH_BROKER_TOKEN: "broker-token" },
      );
      await expect(resolver.resolve(REF)).resolves.toEqual({ type: "oauth", secret: "oauth-access-token" });
    } finally {
      broker.stop();
    }
  });

  test("an unknown backend type fails closed at selection (never falls back silently)", () => {
    expect(() =>
      // SAFETY: deliberately invalid secretsBackend type to exercise the
      // unknown-backend fail-closed branch; the never assertion bypasses the
      // settings union's literal constraint for this negative test.
      secretResolverFromSettings({ ...EMPTY_SETTINGS, secretsBackend: { type: "infisical" as never } }),
    ).toThrow(/unknown secrets_backend type "infisical"/);
  });

  test("the omp-broker resolver fails closed without a broker credential id", async () => {
    const resolver = secretResolverFromSettings(EMPTY_SETTINGS, {
      OMP_AUTH_BROKER_URL: "http://127.0.0.1:8765",
      OMP_AUTH_BROKER_TOKEN: "bt",
    });
    await expect(
      resolver.resolve({ provider: "github", identityKey: "api-key:dev", scope: "org", owner: null }),
    ).rejects.toThrow(/broker credential id/);
  });
});

describe("onePasswordConnectResolver (issue #190)", () => {
  /** Stub Connect server: serves the given item fields for any vault/item. */
  function stubConnect(
    response: (path: string) => Response,
  ) {
    const seen: Array<{ path: string; auth: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, auth: req.headers.get("authorization") });
        return response(url.pathname);
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
  }

  function itemResponse(fields: Array<{ id?: string; label?: string; value?: string }>): Response {
    return new Response(JSON.stringify({ id: "item-1", title: "t", category: "LOGIN", fields }), {
      headers: { "content-type": "application/json" },
    });
  }

  function backend(url: string, mapping: OrgSecretsBackendSettings["mapping"]): OrgSecretsBackendSettings {
    return { type: "1password-connect", connectUrl: url, mapping };
  }

  const MAPPING: NonNullable<OrgSecretsBackendSettings["mapping"]> = {
    "github:api-key:dev": { vault: "vault-1", item: "item-1", field: "credential" },
  };

  const REF = { provider: "github", identityKey: "api-key:dev", scope: "org", owner: null } satisfies SecretResolverRef;

  test("resolves a mapped api_key from the Connect item (field id), bearer token sent", async () => {
    const connect = stubConnect(() => itemResponse([{ id: "credential", label: "credential", value: "github_pat_123" }]));
    try {
      const resolver = onePasswordConnectResolver(backend(connect.url, MAPPING), { OP_CONNECT_TOKEN: "connect-token" });
      await expect(resolver.resolve(REF)).resolves.toEqual({ type: "api_key", secret: "github_pat_123" });
      expect(connect.seen).toEqual([
        { path: "/v1/vaults/vault-1/items/item-1", auth: "Bearer connect-token" },
      ]);
    } finally {
      connect.stop();
    }
  });

  test("matches a field by label when the configured id differs", async () => {
    const connect = stubConnect(() => itemResponse([{ id: "abc123", label: "credential", value: "pat-by-label" }]));
    try {
      const resolver = onePasswordConnectResolver(backend(connect.url, MAPPING), { OP_CONNECT_TOKEN: "connect-token" });
      await expect(resolver.resolve(REF)).resolves.toEqual({ type: "api_key", secret: "pat-by-label" });
    } finally {
      connect.stop();
    }
  });

  test("returns the mapping-declared credential type (oauth static)", async () => {
    const connect = stubConnect(() => itemResponse([{ id: "credential", label: "credential", value: "static-oauth" }]));
    try {
      const resolver = onePasswordConnectResolver(
        backend(connect.url, { ...MAPPING, "github:api-key:dev": { vault: "vault-1", item: "item-1", field: "credential", type: "oauth" } }),
        { OP_CONNECT_TOKEN: "connect-token" },
      );
      await expect(resolver.resolve(REF)).resolves.toEqual({ type: "oauth", secret: "static-oauth" });
    } finally {
      connect.stop();
    }
  });

  test("an unmapped provider:identityKey fails closed with the missing key", async () => {
    const connect = stubConnect(() => itemResponse([]));
    try {
      const resolver = onePasswordConnectResolver(backend(connect.url, MAPPING), { OP_CONNECT_TOKEN: "connect-token" });
      await expect(
        resolver.resolve({ ...REF, identityKey: "api-key:other" }),
      ).rejects.toThrow(/no 1Password mapping for "github:api-key:other"/);
      expect(connect.seen).toEqual([]); // never a fetch without a mapping
    } finally {
      connect.stop();
    }
  });

  test("a missing OP_CONNECT_TOKEN fails closed lazily (the resolver is wired at boot)", async () => {
    const connect = stubConnect(() => itemResponse([{ id: "credential", value: "x" }]));
    try {
      const resolver = onePasswordConnectResolver(backend(connect.url, MAPPING), {});
      await expect(resolver.resolve(REF)).rejects.toThrow(/OP_CONNECT_TOKEN/);
      expect(connect.seen).toEqual([]); // no fetch without the token
    } finally {
      connect.stop();
    }
  });

  test("a missing connect_url fails closed (config validation, defense in depth)", async () => {
    const resolver = onePasswordConnectResolver({ type: "1password-connect", mapping: MAPPING }, { OP_CONNECT_TOKEN: "t" });
    await expect(resolver.resolve(REF)).rejects.toThrow(/secrets_backend.connect_url/);
  });

  test("a 401 from the Connect server fails the extension call closed", async () => {
    const connect = stubConnect(() => new Response("unauthorized", { status: 401 }));
    try {
      const resolver = onePasswordConnectResolver(backend(connect.url, MAPPING), { OP_CONNECT_TOKEN: "wrong-token" });
      await expect(resolver.resolve(REF)).rejects.toThrow(/item fetch failed \(401\)/);
    } finally {
      connect.stop();
    }
  });

  test("a missing item (404) fails the extension call closed", async () => {
    const connect = stubConnect(() => new Response("not found", { status: 404 }));
    try {
      const resolver = onePasswordConnectResolver(backend(connect.url, MAPPING), { OP_CONNECT_TOKEN: "connect-token" });
      await expect(resolver.resolve(REF)).rejects.toThrow(/item fetch failed \(404\)/);
    } finally {
      connect.stop();
    }
  });

  test("a missing field fails closed", async () => {
    const connect = stubConnect(() => itemResponse([{ id: "other", label: "other", value: "x" }]));
    try {
      const resolver = onePasswordConnectResolver(backend(connect.url, MAPPING), { OP_CONNECT_TOKEN: "connect-token" });
      await expect(resolver.resolve(REF)).rejects.toThrow(/has no field "credential"/);
    } finally {
      connect.stop();
    }
  });

  test("a field without a value fails closed (never an empty credential)", async () => {
    const connect = stubConnect(() => itemResponse([{ id: "credential", label: "credential" }]));
    try {
      const resolver = onePasswordConnectResolver(backend(connect.url, MAPPING), { OP_CONNECT_TOKEN: "connect-token" });
      await expect(resolver.resolve(REF)).rejects.toThrow(/has no value/);
    } finally {
      connect.stop();
    }
  });

  test("a malformed Connect item fails closed", async () => {
    const connect = stubConnect(() => new Response("not-json", { status: 200 }));
    try {
      const resolver = onePasswordConnectResolver(backend(connect.url, MAPPING), { OP_CONNECT_TOKEN: "connect-token" });
      await expect(resolver.resolve(REF)).rejects.toThrow(/malformed item/);
    } finally {
      connect.stop();
    }
  });


});
