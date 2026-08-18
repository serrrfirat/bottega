/**
 * One-time upload link tests (issue #196): the mint→upload→vault flow is
 * hermetic — a real in-process Bun.serve endpoint on 127.0.0.1, a real
 * SQLite store, a recording broker (the SAME seam the connect flow uses),
 * and a recording approval router. Nothing touches the network, Slack, or
 * a transcript.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { createAudit } from "../policy/audit";
import type { ApprovalRequest, ApprovalResolution, ApprovalRouter } from "../policy/approval-router";
import { parseOrgConfigYaml, type PolicyConfig } from "../policy/config";
import { EXTENSION_CONNECTED_EVENT, SECRET_PROVISIONED_EVENT } from "../store/audit-events";
import { BOOT_SECRETS } from "../server/boot-secrets";
import { createStore, type Store } from "../store/db";
import { CONNECT_EXTENSION_TOOL, type BrokerConnectResult } from "./connect";
import { fixtureManifest } from "./fixture";
import type { ExtensionManifest } from "./manifest";
import { createExtensionRegistry, type ExtensionRegistry } from "./registry";
import {
  mintUploadLink,
  mintUploadLinkToolDefinition,
  startUploadLinkServer,
  UploadLinkStore,
  uploadLinkPublicBase,
  type UploadLinkEndpointDeps,
} from "./upload-link";

const dir = mkdtempSync(join(tmpdir(), "bottega-upload-link-"));
const stores: Store[] = [];
const callbackPort = process.env.BOTTEGA_CALLBACK_PORT;
beforeAll(() => {
  process.env.BOTTEGA_CALLBACK_PORT = "0";
});
afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
  if (callbackPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
  else process.env.BOTTEGA_CALLBACK_PORT = callbackPort;
});

function freshStore(): Store {
  const store = createStore(join(dir, `test-${stores.length}.db`));
  stores.push(store);
  return store;
}

/** OAuth-shaped manifest (the fixture is api_key; Linear/GitHub-style providers are oauth). */
function oauthManifest(): ExtensionManifest {
  const base = fixtureManifest();
  return {
    ...base,
    id: "com.example.oauth",
    label: "Example OAuth",
    credentialSchema: { type: "oauth", scopes: ["read"] },
    tools: [{ ...base.tools![0], name: "oauth.current" }],
  };
}

function registry(): ExtensionRegistry {
  const r = createExtensionRegistry();
  r.register(fixtureManifest());
  r.register(oauthManifest());
  return r;
}

class RecordingRouter implements ApprovalRouter {
  readonly requests: ApprovalRequest[] = [];
  constructor(private resolution: ApprovalResolution = { approved: true }) {}
  async request(d: ApprovalRequest): Promise<ApprovalResolution> {
    this.requests.push(d);
    return this.resolution;
  }
}

class RecordingBroker {
  readonly calls: Array<{ provider: string; credentialType: string; apiKey?: string }> = [];
  result: BrokerConnectResult;
  constructor(result: BrokerConnectResult = { identityKey: null, brokerCredentialId: 9 }) {
    this.result = result;
  }
  async connect(input: { provider: string; credentialType: string; apiKey?: string }): Promise<BrokerConnectResult> {
    this.calls.push(input);
    return this.result;
  }
}

function defaultPolicy(): PolicyConfig {
  return parseOrgConfigYaml(""); // fail-closed default: connect_extension denied
}

function allowedPolicy(): PolicyConfig {
  return parseOrgConfigYaml("tools:\n  connect_extension: allow\n");
}

interface Harness {
  deps: UploadLinkEndpointDeps;
  store: Store;
  router: RecordingRouter;
  broker: RecordingBroker;
}

function makeDeps(overrides: { policy?: PolicyConfig; router?: RecordingRouter; broker?: RecordingBroker } = {}): Harness {
  const store = freshStore();
  const router = overrides.router ?? new RecordingRouter();
  const broker = overrides.broker ?? new RecordingBroker();
  const policy = overrides.policy ?? defaultPolicy();
  return {
    deps: {
      registry: registry(),
      store,
      audit: createAudit(store),
      broker: broker.connect.bind(broker),
      gate: { loadPolicy: () => Promise.resolve(policy), router },
    },
    store,
    router,
    broker,
  };
}

function rowsFor(store: Store, provider: string) {
  return store.listExtensionCredentials(provider);
}

function postSecret(url: string, secret: string): Promise<Response> {
  const body = new FormData();
  body.append("secret", secret);
  return fetch(url, { method: "POST", body });
}

/**
 * Issue #211: the hermetic mint — no public base configured, so the mint
 * resolves loopback WITHOUT probing. The ambient .env (auto-loaded by bun)
 * carries a live tunnel URL; tests that don't exercise the liveness probe
 * must pin this resolver so the suite never touches the network.
 */
const noPublicBase = async () => ({ base: undefined, warning: undefined });

describe("one-time upload link — mint → upload → vault (issue #196)", () => {
  test("GET serves the form; POST stores the secret through the same connect path", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "fixture.weather",
        scope: "personal",
        actor: "UADA",
        label: "Fixture Weather",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const form = await fetch(url);
      expect(form.status).toBe(200);
      const html = await form.text();
      expect(html).toContain("Fixture Weather");
      expect(html).toContain('name="secret"');
      expect(form.headers.get("cache-control")).toBe("no-store");

      const secret = "attio-secret-key";
      const upload = await postSecret(url, secret);
      expect(upload.status).toBe(200);
      expect(await upload.text()).toContain("Saved to the vault");

      // The SAME broker + registry path as the connect flow: the broker saw
      // the value and the vault row landed (personal, owner = the minting
      // principal).
      expect(h.broker.calls).toEqual([
        { provider: "fixture.weather", credentialType: "api_key", apiKey: secret },
      ]);
      const rows = await rowsFor(h.store, "fixture.weather");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.owner).toBe("UADA");
      expect(rows[0]!.scope).toBe("personal");
      expect(rows[0]!.broker_credential_id).toBe(9);
      const connected = await h.store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT });
      expect(JSON.parse(connected[0]!.payload)).toEqual({
        extension: "fixture.weather",
        scope: "personal",
        owner: "UADA",
      });
    } finally {
      endpoint.stop();
    }
  });

  // Issue #222 regression: the browser upload is the sanctioned secret path
  // — a REAL-shaped credential (GitHub classic/fine-grained PATs, OpenAI
  // keys) posted through the form must store, NOT hit the chat paste-guard
  // redirect. Pre-fix, connectExtension's looksLikeObviousSecret fired on
  // the upload api_key too (the canary's fixture secret never matched the
  // patterns, so only the 400 redirected here).
  test.each([
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "github_pat_abcdefghijklmnopqrstuvwxyz1234567890",
    "sk-abcdefghijklmnopqrstuvwxyz1234567890",
  ])("a real-shaped %s pasted through the upload POST is stored, not redirected", async (secret) => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "fixture.weather",
        scope: "personal",
        actor: "UADA",
        label: "Fixture Weather",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const upload = await postSecret(url, secret);
      expect(upload.status).toBe(200);
      expect(await upload.text()).toContain("Saved to the vault");

      // The broker saw the real value and the vault row landed — the same
      // connect path as any other upload, minus the chat paste guard.
      expect(h.broker.calls).toEqual([
        { provider: "fixture.weather", credentialType: "api_key", apiKey: secret },
      ]);
      const rows = await rowsFor(h.store, "fixture.weather");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.owner).toBe("UADA");
    } finally {
      endpoint.stop();
    }
  });

  test("an org-scope upload crosses the policy gate and records the org row", async () => {
    const router = new RecordingRouter({ approved: true });
    const h = makeDeps({ policy: allowedPolicy(), router });
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "fixture.weather",
        scope: "org",
        actor: "UADA",
        spaceId: "slack:C1",
        label: "Fixture Weather",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const upload = await postSecret(url, "attio-secret-key");
      expect(upload.status).toBe(200);

      expect(h.router.requests).toHaveLength(1);
      expect(h.router.requests[0]!.tool).toBe(CONNECT_EXTENSION_TOOL);
      expect(h.router.requests[0]!.spaceId).toBe("slack:C1");
      const rows = await rowsFor(h.store, "fixture.weather");
      expect(rows[0]!.owner).toBeNull();
      expect(rows[0]!.scope).toBe("org");
    } finally {
      endpoint.stop();
    }
  });

  test("single-use: a replayed POST is refused and stores nothing twice", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "fixture.weather",
        scope: "personal",
        actor: "UADA",
        label: "Fixture Weather",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const first = await postSecret(url, "attio-secret-key");
      expect(first.status).toBe(200);

      const replay = await postSecret(url, "attio-secret-key");
      expect(replay.status).toBe(404); // fail closed: consumed tokens are gone

      expect(h.broker.calls).toHaveLength(1);
      expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(1);
    } finally {
      endpoint.stop();
    }
  });

  test("expired tokens are refused (fail closed)", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "fixture.weather",
        scope: "personal",
        actor: "UADA",
        label: "Fixture Weather",
        expiresAt: Date.now() - 1_000, // already past its TTL
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const upload = await postSecret(url, "attio-secret-key");
      expect(upload.status).toBe(404);
      expect(h.broker.calls).toHaveLength(0);
      expect(await rowsFor(h.store, "fixture.weather")).toHaveLength(0);
    } finally {
      endpoint.stop();
    }
  });

  test("an unknown token is refused on GET and POST", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const url = `${endpoint.baseUrl}/upload/not-a-real-token`;
      expect((await fetch(url)).status).toBe(404);
      expect((await postSecret(url, "attio-secret-key")).status).toBe(404);
    } finally {
      endpoint.stop();
    }
  });

  test("an empty secret is refused with 400", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      for (const empty of ["", "   "]) {
        const minted = endpoint.store.mint({
          extension: "fixture.weather",
          scope: "personal",
          actor: "UADA",
          label: "Fixture Weather",
        });
        expect(minted.ok).toBe(true);
        const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;
        expect((await postSecret(url, empty)).status).toBe(400);
      }
      expect(h.broker.calls).toHaveLength(0);
    } finally {
      endpoint.stop();
    }
  });

  test("the per-IP attempt cap fails closed with 429", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps, { maxAttemptsPerIp: 3, attemptsWindowMs: 60_000 });
    try {
      // Three attempts exhaust the window; the fourth is refused regardless
      // of the token.
      const url = `${endpoint.baseUrl}/upload/nope`;
      expect((await postSecret(url, "a")).status).toBe(404);
      expect((await postSecret(url, "b")).status).toBe(404);
      expect((await postSecret(url, "c")).status).toBe(404);
      expect((await postSecret(url, "d")).status).toBe(429);
    } finally {
      endpoint.stop();
    }
  });
});

describe("boot-secret provisioning via the upload link (issue #201)", () => {
  test("boot secrets mint by their vault provider id without a registry entry", async () => {
    const store = new UploadLinkStore(freshStore(), { maxOutstandingPerActor: BOOT_SECRETS.length });
    for (const id of ["slack-app", "slack-bot", "opencode", "near", "openai", "anthropic", "github-webhook"]) {
      const outcome = await mintUploadLink(
        { extension: id, scope: "org", actor: "UADA" },
        { registry: registry(), store, baseUrl: () => "http://127.0.0.1:9", resolvePublicBase: noPublicBase },
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.url).toContain(`http://127.0.0.1:9/upload/`);
    }
  });

  test("a boot-secret upload stores the api_key row in the vault — no registry row", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "near",
        scope: "personal",
        actor: "UADA",
        label: "NEAR AI Cloud key",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const secret = "near-vault-key";
      const upload = await postSecret(url, secret);
      expect(upload.status).toBe(200);
      expect(await upload.text()).toContain("Saved to the vault");

      // The broker saw the value under the boot secret's provider identity…
      expect(h.broker.calls).toEqual([{ provider: "near", credentialType: "api_key", apiKey: secret }]);
      // …and NO extension registry row exists (boot secrets have no manifest).
      expect(await rowsFor(h.store, "near")).toHaveLength(0);
      const audit = await h.store.listAudit({ event_type: SECRET_PROVISIONED_EVENT });
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0]!.payload)).toEqual({ secret: "near", scope: "personal", owner: "UADA" });
    } finally {
      endpoint.stop();
    }
  });

  test("an org-scope boot-secret upload crosses the policy gate", async () => {
    const router = new RecordingRouter({ approved: true });
    const h = makeDeps({ policy: allowedPolicy(), router });
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "openai",
        scope: "org",
        actor: "UADA",
        spaceId: "slack:C1",
        label: "OpenAI key",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const upload = await postSecret(url, "sk-openai-vault");
      expect(upload.status).toBe(200);

      expect(h.router.requests).toHaveLength(1);
      expect(h.router.requests[0]!.tool).toBe(CONNECT_EXTENSION_TOOL);
      expect(h.router.requests[0]!.spaceId).toBe("slack:C1");
      expect(h.broker.calls).toEqual([{ provider: "openai", credentialType: "api_key", apiKey: "sk-openai-vault" }]);
      const audit = await h.store.listAudit({ event_type: SECRET_PROVISIONED_EVENT });
      expect(JSON.parse(audit[0]!.payload)).toEqual({ secret: "openai", scope: "org", owner: null });
    } finally {
      endpoint.stop();
    }
  });

  test("a denied org gate stores nothing (fail closed)", async () => {
    const router = new RecordingRouter({ approved: false });
    const h = makeDeps({ policy: allowedPolicy(), router });
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const minted = endpoint.store.mint({
        extension: "slack-app",
        scope: "org",
        actor: "UADA",
        label: "Slack app-level token",
      });
      expect(minted.ok).toBe(true);
      const url = `${endpoint.baseUrl}/upload/${minted.ok ? minted.token : ""}`;

      const upload = await postSecret(url, "xapp-denied");
      expect(upload.status).toBe(400);
      expect(h.broker.calls).toHaveLength(0);
      expect(await h.store.listAudit({ event_type: SECRET_PROVISIONED_EVENT })).toHaveLength(0);
    } finally {
      endpoint.stop();
    }
  });
});

describe("upload link minting (issue #196)", () => {
  test("mint is rate-limited per actor (outstanding cap)", () => {
    const store = new UploadLinkStore(freshStore(), { maxOutstandingPerActor: 2 });
    const first = store.mint({ extension: "fixture.weather", scope: "personal", actor: "UADA", label: "Fixture Weather" });
    const second = store.mint({ extension: "fixture.weather", scope: "personal", actor: "UADA", label: "Fixture Weather" });
    const third = store.mint({ extension: "fixture.weather", scope: "personal", actor: "UADA", label: "Fixture Weather" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toContain("too many outstanding");
  });

  test("oauth extensions cannot mint — they have no secret to upload", async () => {
    const store = new UploadLinkStore(freshStore());
    const outcome = await mintUploadLink(
      { extension: "com.example.oauth", scope: "personal", actor: "UADA" },
      { registry: registry(), store, baseUrl: () => "http://127.0.0.1:9", resolvePublicBase: noPublicBase },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("OAuth");
  });

  test("unknown extensions cannot mint", async () => {
    const store = new UploadLinkStore(freshStore());
    const outcome = await mintUploadLink(
      { extension: "com.nope", scope: "personal", actor: "UADA" },
      { registry: registry(), store, baseUrl: () => "http://127.0.0.1:9", resolvePublicBase: noPublicBase },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("unknown extension");
  });

  test("mintUploadLinkToolDefinition returns the single-use URL for the session principal", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      const tool = mintUploadLinkToolDefinition({
        registry: h.deps.registry,
        store: endpoint.store,
        baseUrl: () => endpoint.baseUrl,
        resolvePublicBase: noPublicBase,
        getPrincipal: () => "UADA",
        spaceIdFromFile: (file) => (file === "slack:C1.jsonl" ? "slack:C1" : undefined),
      });

      const result = await tool.execute(
        "t1",
        { extension: "fixture.weather", scope: "personal" },
        undefined,
        undefined,
        // SAFETY: the upload-link tool never reads the execute context; a minimal sessionManager fake satisfies the arity.
        { sessionManager: { getSessionFile: () => "slack:C1.jsonl" } } as never,
      );
      expect(result.isError).toBeUndefined();
      // SAFETY: the tool replies with a single text content block carrying the upload URL.
      const text = (result.content[0] as { text: string }).text;
      // Issue #210: the result carries the URL verbatim on its own line.
      const url = text.split("\n")[0]!;
      expect(url.startsWith(`${endpoint.baseUrl}/upload/`)).toBe(true);

      // The minted token is real: the endpoint's store consumes it.
      const token = url.slice(endpoint.baseUrl.length + "/upload/".length);
      const consumed = endpoint.store.consume(token);
      expect(consumed.ok).toBe(true);
      if (consumed.ok) {
        expect(consumed.row.actor).toBe("UADA");
        expect(consumed.row.space_id).toBe("slack:C1");
      }
    } finally {
      endpoint.stop();
    }
  });

  test("the mint tool anchors its reply to the minted public URL — never a loopback (issue #210)", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    // Issue #211: the "tunnel" is a live Bun.serve stub (404 on unknown
    // paths, exactly like the real inbound surface) — the tool's DEFAULT
    // resolver health-checks the configured base and must mint with it.
    const tunnel = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not found", { status: 404 }) });
    try {
      // The post-fix wiring expression server/index.ts uses: baseUrl is
      // the loopback FALLBACK only; the mint resolves the PUBLIC base
      // itself (health-checked, issue #211). A configured public base is
      // the bug's trigger: the agent re-emitted the token with a loopback
      // base pattern-copied from older context, rendering a dead link.
      const baseUrl = () => endpoint.baseUrl;
      const saved = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = `http://127.0.0.1:${tunnel.port}`;
      try {
        const tool = mintUploadLinkToolDefinition({
          registry: h.deps.registry,
          store: endpoint.store,
          baseUrl,
          getPrincipal: () => "UADA",
        });
        const result = await tool.execute(
          "t1",
          { extension: "fixture.weather", scope: "personal" },
          undefined,
          undefined,
          // SAFETY: the upload-link tool never reads the execute context; a minimal sessionManager fake satisfies the arity.
          { sessionManager: { getSessionFile: () => null } } as never,
        );
        expect(result.isError).toBeUndefined();
        const text = (result.content[0] as { text: string }).text;
        // The minted URL is anchored verbatim (first line)…
        const url = text.split("\n")[0]!;
        expect(url.startsWith(`http://127.0.0.1:${tunnel.port}/upload/`)).toBe(true);
        // …with an explicit relay contract the agent must follow…
        expect(text).toContain("exactly as written");
        // …a LIVE public base mints without a staleness warning…
        expect(text).not.toMatch(/WARNING|unreachable|stale/i);
        // …and no loopback base can leak into the reply.
        expect(text).not.toMatch(new RegExp(`127\\.0\\.0\\.1:${endpoint.baseUrl.split(":").pop()}`));

        // The token is real: the SHARED endpoint store consumes it.
        const token = url.slice(`http://127.0.0.1:${tunnel.port}/upload/`.length);
        const consumed = endpoint.store.consume(token);
        expect(consumed.ok).toBe(true);
        if (consumed.ok) expect(consumed.row.actor).toBe("UADA");
      } finally {
        if (saved === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
        else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = saved;
      }
    } finally {
      tunnel.stop();
      endpoint.stop();
    }
  });
});

describe("upload link public base + stable port (issue #196)", () => {
  test("uploadLinkPublicBase reads the #198 public-base env (absent/empty → undefined)", () => {
    const saved = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
    try {
      delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      expect(uploadLinkPublicBase()).toBeUndefined();
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "";
      expect(uploadLinkPublicBase()).toBeUndefined();
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "https://upload.example.com";
      expect(uploadLinkPublicBase()).toBe("https://upload.example.com");
    } finally {
      if (saved === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = saved;
    }
  });

  test("the mint returns the public base URL when configured and reachable, else the loopback fallback", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    // Issue #211: the "tunnel" is a live Bun.serve stub (404 on unknown
    // paths, exactly like the real inbound surface). The mint's DEFAULT
    // resolver probes the configured base — the post-fix server/index.ts
    // wiring: baseUrl is the loopback fallback only.
    const tunnel = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not found", { status: 404 }) });
    try {
      const baseUrl = () => endpoint.baseUrl;
      const saved = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      try {
        delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
        const local = await mintUploadLink(
          { extension: "fixture.weather", scope: "personal", actor: "UADA" },
          { registry: registry(), store: endpoint.store, baseUrl },
        );
        expect(local.ok).toBe(true);
        if (local.ok) {
          expect(local.url.startsWith(`${endpoint.baseUrl}/upload/`)).toBe(true);
          expect(local.warning).toBeUndefined(); // absent env is the normal local-dev posture
        }

        process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = `http://127.0.0.1:${tunnel.port}`;
        const remote = await mintUploadLink(
          { extension: "fixture.weather", scope: "personal", actor: "UADA" },
          { registry: registry(), store: endpoint.store, baseUrl },
        );
        expect(remote.ok).toBe(true);
        if (remote.ok) {
          expect(remote.url.startsWith(`http://127.0.0.1:${tunnel.port}/upload/`)).toBe(true);
          expect(remote.warning).toBeUndefined(); // the live probe passed
          // The public prefix changes only the browser-facing base: the
          // token is the same single-use token the loopback endpoint burns.
          const token = remote.url.slice(`http://127.0.0.1:${tunnel.port}/upload/`.length);
          expect(endpoint.store.consume(token).ok).toBe(true);
        }
      } finally {
        if (saved === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
        else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = saved;
      }
    } finally {
      tunnel.stop();
      endpoint.stop();
    }
  });

  test("BOTTEGA_CALLBACK_PORT pins the listener; absent → ephemeral", () => {
    const saved = process.env.BOTTEGA_CALLBACK_PORT;
    const h = makeDeps();
    try {
      process.env.BOTTEGA_CALLBACK_PORT = "18765";
      const pinned = startUploadLinkServer(h.deps);
      try {
        expect(pinned.baseUrl).toBe("http://127.0.0.1:18765");
      } finally {
        pinned.stop();
      }
      delete process.env.BOTTEGA_CALLBACK_PORT;
      const ephemeral = startUploadLinkServer(h.deps);
      try {
        expect(ephemeral.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
        expect(ephemeral.baseUrl).not.toBe("http://127.0.0.1:18765");
      } finally {
        ephemeral.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
      else process.env.BOTTEGA_CALLBACK_PORT = saved;
    }
  });

  test("an invalid BOTTEGA_CALLBACK_PORT fails closed at bind time", () => {
    const saved = process.env.BOTTEGA_CALLBACK_PORT;
    const h = makeDeps();
    try {
      process.env.BOTTEGA_CALLBACK_PORT = "not-a-port";
      expect(() => startUploadLinkServer(h.deps)).toThrow(/BOTTEGA_CALLBACK_PORT/);
    } finally {
      if (saved === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
      else process.env.BOTTEGA_CALLBACK_PORT = saved;
    }
  });

  test("the endpoint binds loopback only — never a non-loopback interface", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    try {
      expect(endpoint.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
      // Probe the first non-loopback IPv4 address, when one exists: the
      // form must refuse there while the loopback URL serves — the tunnel /
      // proxy terminates at the host and forwards; the listener itself
      // never exposes the form to the network.
      const lan = Object.values(networkInterfaces())
        .flat()
        .find((iface) => iface !== undefined && !iface.internal && iface.family === "IPv4");
      if (lan !== undefined) {
        const port = endpoint.baseUrl.slice("http://127.0.0.1:".length);
        const probe = `http://${lan.address}:${port}/upload/nope`;
        await expect(fetch(probe, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
        expect((await fetch(`${endpoint.baseUrl}/upload/nope`)).status).toBe(404);
      }
    } finally {
      endpoint.stop();
    }
  });
});

describe("upload link public base liveness (issue #211)", () => {
  /** The mint reply's URL line: the warning block precedes the relay text. */
  function urlLine(text: string): string {
    return text.split("\n").find((line) => line.startsWith("http://"))!;
  }

  test("a dead configured public URL (5xx from the ingress) → the mint falls back to loopback WITH a loud warning", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    // The tunnel is GONE but the hostname still resolves: Cloudflare's edge
    // answers 502/530 for the dead quick tunnel — the observed canary
    // failure mode (run msyi15gi-iwa). The app's own surface never 5xxs an
    // unknown path, so a 5xx means the ingress cannot reach the listener.
    const deadTunnel = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("Bad Gateway", { status: 502 }),
    });
    try {
      const saved = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = `http://127.0.0.1:${deadTunnel.port}`;
      try {
        const tool = mintUploadLinkToolDefinition({
          registry: h.deps.registry,
          store: endpoint.store,
          baseUrl: () => endpoint.baseUrl, // the post-fix wiring: loopback fallback only
          getPrincipal: () => "UADA",
        });
        const result = await tool.execute(
          "t1",
          { extension: "fixture.weather", scope: "personal" },
          undefined,
          undefined,
          // SAFETY: the upload-link tool never reads the execute context; a minimal sessionManager fake satisfies the arity.
          { sessionManager: { getSessionFile: () => null } } as never,
        );
        expect(result.isError).toBeUndefined();
        const text = (result.content[0] as { text: string }).text;
        // The warning is LOUD and actionable: it names the env var, says
        // the tunnel URL is stale, and flags the link as loopback-only.
        expect(text).toContain("WARNING");
        expect(text).toContain("BOTTEGA_OAUTH_CALLBACK_BASE_URL");
        expect(text).toContain("stale");
        expect(text).toContain("LOOPBACK-only");
        // The minted link is the loopback fallback — never the dead URL…
        const url = urlLine(text);
        expect(url.startsWith(`${endpoint.baseUrl}/upload/`)).toBe(true);
        // …and the relay contract still anchors the reply to that URL.
        expect(text).toContain("exactly as written");
        const token = url.slice(endpoint.baseUrl.length + "/upload/".length);
        expect(endpoint.store.consume(token).ok).toBe(true);
      } finally {
        if (saved === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
        else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = saved;
      }
    } finally {
      deadTunnel.stop();
      endpoint.stop();
    }
  });

  test("a dead configured public URL (connection refused) → the mint falls back to loopback WITH a loud warning", async () => {
    const h = makeDeps();
    const endpoint = startUploadLinkServer(h.deps);
    // The tunnel process is DOWN: nothing listens on the host — the probe's
    // connection is refused (the DNS-failure leg of the liveness check;
    // hermetically equivalent and local).
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const deadPort = dead.port;
    dead.stop();
    try {
      const saved = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = `http://127.0.0.1:${deadPort}`;
      try {
        const outcome = await mintUploadLink(
          { extension: "fixture.weather", scope: "personal", actor: "UADA" },
          { registry: registry(), store: endpoint.store, baseUrl: () => endpoint.baseUrl },
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.url.startsWith(`${endpoint.baseUrl}/upload/`)).toBe(true);
          expect(outcome.warning).toBeDefined();
          expect(outcome.warning).toContain("WARNING");
          expect(outcome.warning).toContain("stale");
        }
      } finally {
        if (saved === undefined) delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
        else process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = saved;
      }
    } finally {
      endpoint.stop();
    }
  });
});
