/**
 * Credential boundary control wiring (issue #123): the reload half of the
 * boundary engages only when BOTH the proxy control URL and its bearer
 * token are present — a token-less reload would 401 and fail every
 * extension call, so the pair gates together; unset stays write-only (the
 * hermetic fallback). Pure env mapping, tested hermetically.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerSecretResolverFromEnv, createSecretFileBoundary, extensionSecretFileName, onePasswordConnectResolver, proxyBoundaryControlFromEnv, secretResolverFromSettings, type SecretResolverRef } from "./boundary";
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

describe("createSecretFileBoundary reload half (issue #123, dev token contract)", () => {
  /** Minimal credential: authorize only reads `provider` (the secret file name). */
  const CREDENTIAL = {
    id: "1",
    provider: "github",
    identity_key: "dev",
    owner: null,
    scope: "org",
    broker_credential_id: 1,
    created_at: 0,
  } satisfies ExtensionCredential;

  test("authorize writes the secret file and reloads the management API with the dev token", async () => {
    // Stubbed management API: records the request, answers 200 like the
    // real iron-proxy does for a valid token (dev.sh exports the same token
    // to the container as IRON_MANAGEMENT_API_KEY and to the server as
    // BOTTEGA_PROXY_CONTROL_TOKEN — both come from data/proxy-mgmt-token).
    const seen: Array<{ path: string; auth: string | null }> = [];
    const mgmt = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
        return new Response("ok");
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "boundary-reload-"));
    try {
      const boundary = createSecretFileBoundary({
        secretsDir: dir,
        resolveSecret: async () => "dev-secret-value",
        proxyControlUrl: `http://127.0.0.1:${mgmt.port}`,
        proxyControlToken: "dev-mgmt-token",
      });
      await boundary.authorize(CREDENTIAL);
      expect(readFileSync(join(dir, extensionSecretFileName("github")), "utf8")).toBe("dev-secret-value");
      expect(seen).toEqual([{ path: "/v1/reload", auth: "Bearer dev-mgmt-token" }]);
    } finally {
      mgmt.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a 401 from the management API fails the extension call closed (token mismatch)", async () => {
    // The fail-closed symptom: a running container whose
    // IRON_MANAGEMENT_API_KEY differs from data/proxy-mgmt-token answers
    // the reload with 401, and the boundary must NOT silently continue
    // without injection — the extension call errors instead.
    const mgmt = Bun.serve({
      port: 0,
      fetch: async () => new Response("unauthorized", { status: 401 }),
    });
    const dir = mkdtempSync(join(tmpdir(), "boundary-reload-"));
    try {
      const boundary = createSecretFileBoundary({
        secretsDir: dir,
        resolveSecret: async () => "dev-secret-value",
        proxyControlUrl: `http://127.0.0.1:${mgmt.port}`,
        proxyControlToken: "wrong-token",
      });
      await expect(boundary.authorize(CREDENTIAL)).rejects.toThrow(/proxy reload failed \(401\)/);
    } finally {
      mgmt.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("write-only boundary (no control URL) still writes the secret file, no reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boundary-reload-"));
    try {
      const boundary = createSecretFileBoundary({ secretsDir: dir, resolveSecret: async () => "s" });
      await boundary.authorize(CREDENTIAL);
      expect(readFileSync(join(dir, extensionSecretFileName("github")), "utf8")).toBe("s");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the live default secrets dir is refused under the test runner (issue #191)", async () => {
    // The boundary's default PROXY_SECRETS_DIR is the LIVE production dir.
    // The parity suite (#172/#190) clobbered data/proxy-secrets/github.secret
    // by authorizing without an explicit temp secretsDir; the guard must
    // fail the test loudly BEFORE any file system write. The default
    // resolves to the live path from this file's cwd (the repo root).
    const before = process.env.BOTTEGA_PROXY_SECRETS_DIR;
    delete process.env.BOTTEGA_PROXY_SECRETS_DIR;
    try {
      const boundary = createSecretFileBoundary({ resolveSecret: async () => "s" });
      await expect(boundary.authorize(CREDENTIAL)).rejects.toThrow(/refusing the live default secrets dir/);
    } finally {
      if (before === undefined) delete process.env.BOTTEGA_PROXY_SECRETS_DIR;
      else process.env.BOTTEGA_PROXY_SECRETS_DIR = before;
    }
  });
});

describe("brokerSecretResolverFromEnv (issue #54 wiring, #143)", () => {
  const BROKER_CREDENTIAL = {
    id: "ec_test",
    provider: "github",
    identity_key: "api-key:dev",
    owner: "U0B9QUPCTJ5",
    scope: "personal",
    broker_credential_id: 42,
    created_at: 0,
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
      await expect(resolve(BROKER_CREDENTIAL)).rejects.toThrow(/no "github" vault row 42/);
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
      await expect(resolve(BROKER_CREDENTIAL)).rejects.toThrow(/no "github" vault row 42/);
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

  test("the resolved secret feeds the boundary end to end (secret file + reload)", async () => {
    const broker = fakeBroker([
      { id: 42, provider: "github", credential: { type: "api_key", key: "github_pat_test" }, identityKey: "api-key:dev", rotatesInMs: null },
    ]);
    const seen: Array<{ path: string; auth: string | null }> = [];
    const mgmt = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
        return new Response("ok");
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "boundary-resolver-"));
    try {
      const boundary = createSecretFileBoundary({
        secretsDir: dir,
        resolveSecret: brokerSecretResolverFromEnv({
          OMP_AUTH_BROKER_URL: broker.url,
          OMP_AUTH_BROKER_TOKEN: "broker-token",
        }),
        proxyControlUrl: `http://127.0.0.1:${mgmt.port}`,
        proxyControlToken: "dev-mgmt-token",
      });
      await boundary.authorize(BROKER_CREDENTIAL);
      expect(readFileSync(join(dir, extensionSecretFileName("github")), "utf8")).toBe("github_pat_test");
      expect(seen).toEqual([{ path: "/v1/reload", auth: "Bearer dev-mgmt-token" }]);
    } finally {
      broker.stop();
      mgmt.stop(true);
      rmSync(dir, { recursive: true, force: true });
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

  test("the Connect resolver feeds the boundary end to end (secret file + reload)", async () => {
    const connect = stubConnect(() => itemResponse([{ id: "credential", label: "credential", value: "github_pat_123" }]));
    const seen: Array<{ path: string; auth: string | null }> = [];
    const mgmt = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
        return new Response("ok");
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "boundary-connect-"));
    const credential = {
      id: "ec_connect",
      provider: "github",
      identity_key: "api-key:dev",
      owner: null,
      scope: "org",
      broker_credential_id: 1,
      created_at: 0,
    } satisfies ExtensionCredential;
    try {
      const boundary = createSecretFileBoundary({
        secretsDir: dir,
        resolver: onePasswordConnectResolver(backend(connect.url, MAPPING), { OP_CONNECT_TOKEN: "connect-token" }),
        proxyControlUrl: `http://127.0.0.1:${mgmt.port}`,
        proxyControlToken: "dev-mgmt-token",
      });
      await boundary.authorize(credential);
      expect(readFileSync(join(dir, extensionSecretFileName("github")), "utf8")).toBe("github_pat_123");
      expect(seen).toEqual([{ path: "/v1/reload", auth: "Bearer dev-mgmt-token" }]);
    } finally {
      connect.stop();
      mgmt.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
