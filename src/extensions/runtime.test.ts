/**
 * Extension tool runtime (issue #53) — hermetic full path: policy gate →
 * credential ladder → boundary injection → MCP call → audit. Real SQLite
 * store + real audit module; the egress boundary and the MCP transport are
 * injected fakes so nothing leaves the process. The fixture extension
 * (fixture.weather) is the provider under test.
 *
 * Credential hygiene is asserted throughout: denied calls never resolve a
 * credential, audit payloads carry ids only (never secret values), and the
 * MCP transport receives nothing but the binding.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createAudit } from "../policy/audit";
import { DenyRouter } from "../policy/approval-router";
import { parseOrgConfigYaml, type PolicyConfig } from "../policy/config";
import { createStore, type ExtensionCredential, type Store } from "../store/db";
import {
  EXTENSION_CALL_EVENT,
  EXTENSION_CREDENTIAL_RESOLVED_EVENT,
  POLICY_DECISION_EVENT,
} from "../store/audit-events";
import { createSecretFileBoundary, extensionSecretFileName, PROXY_SECRETS_DIR, type CredentialBoundary } from "./boundary";
import { createFixtureRegistry, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL } from "./fixture";
import { validateManifest, type ExtensionManifest, type McpBinding } from "./manifest";
import { createExtensionRegistry } from "./registry";
import { createExtensionRuntime, type ExtensionRuntime, type ExtensionRuntimeDeps } from "./runtime";
import { resetToolSurfaceCache, resolveExtensionSurfaces } from "./surface";

const dir = mkdtempSync(join(tmpdir(), "bottega-runtime-"));
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Org credential row for the fixture provider, seeded through the real store. */
async function seedOrgCredential(store: Store, provider = FIXTURE_EXTENSION_ID): Promise<ExtensionCredential> {
  return store.upsertExtensionCredential({
    provider,
    identityKey: "email:org@example.com",
    owner: null,
    scope: "org",
    brokerCredentialId: 7,
  });
}

async function seedPersonalCredential(store: Store, provider: string, owner: string): Promise<ExtensionCredential> {
  return store.upsertExtensionCredential({
    provider,
    identityKey: `email:${owner.toLowerCase()}@example.com`,
    owner,
    scope: "personal",
    brokerCredentialId: 8,
  });
}

interface RuntimeHarness {
  runtime: ExtensionRuntime;
  store: Store;
  boundary: CredentialBoundary & { calls: ExtensionCredential[] };
  transports: { bindings: McpBinding[] };
  mcpTransport: (binding: McpBinding) => Transport;
}

function makeBoundary(): CredentialBoundary & { calls: ExtensionCredential[] } {
  const calls: ExtensionCredential[] = [];
  return {
    calls,
    async authorize(credential: ExtensionCredential) {
      calls.push(credential);
    },
  };
}

function makeHarness(opts: {
  policy?: PolicyConfig;
  manifests?: ExtensionManifest[];
  boundary?: CredentialBoundary;
  mcpTransport?: (binding: McpBinding) => Transport;
} = {}): RuntimeHarness {
  const registry = createFixtureRegistry();
  for (const manifest of opts.manifests ?? []) registry.register(manifest);
  const store = createStore(":memory:");
  stores.push(store);
  const boundary = (opts.boundary ?? makeBoundary()) as CredentialBoundary & { calls: ExtensionCredential[] };
  const transports = { bindings: [] as McpBinding[] };
  const mcpTransport =
    opts.mcpTransport ??
    ((binding: McpBinding) => {
      transports.bindings.push(binding);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = request.params.arguments as Record<string, unknown>;
        return { content: [{ type: "text", text: `sunny in ${String(args["city"] ?? "")}` }] };
      });
      void server.connect(serverTransport);
      return clientTransport;
    });
  const deps: ExtensionRuntimeDeps = {
    registry,
    store,
    audit: createAudit(store),
    orgPolicy: opts.policy ?? parseOrgConfigYaml("tools:\n  unknown: allow\n"),
    router: DenyRouter,
    boundary,
    mcpTransport,
  };
  return { runtime: createExtensionRuntime(deps), store, boundary, transports, mcpTransport };
}

async function callRows(store: Store, eventType: string) {
  return store.listAudit({ event_type: eventType });
}

function parse(row: { payload: string }) {
  return JSON.parse(row.payload) as Record<string, unknown>;
}

describe("extension runtime: gate first (denied calls never resolve a credential)", () => {
  test("a policy-denied extension blocks before any credential resolution", async () => {
    const h = makeHarness({ policy: parseOrgConfigYaml("extensions:\n  deny:\n    - fixture.weather\n") });
    await seedOrgCredential(h.store);

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Lisbon" },
      caller: "UADA",
      spaceId: "slack:C1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("denied by this space's policy");
    // The deny is audited with no credential id...
    const calls = await callRows(h.store, EXTENSION_CALL_EVENT);
    expect(calls).toHaveLength(1);
    expect(parse(calls[0]!)).toMatchObject({
      extension: FIXTURE_EXTENSION_ID,
      tool: FIXTURE_EXTENSION_TOOL,
      actor: "UADA",
      credential_id: null,
      decision: "deny",
    });
    expect(calls[0]!.space_id).toBe("slack:C1");
    // ...and the ladder never ran: no resolution row, no boundary write,
    // no provider call.
    expect(await callRows(h.store, EXTENSION_CREDENTIAL_RESOLVED_EVENT)).toHaveLength(0);
    expect(h.boundary.calls).toHaveLength(0);
    expect(h.transports.bindings).toHaveLength(0);
  });

  test("an extension outside the allowlist denies before resolution", async () => {
    const h = makeHarness({
      policy: parseOrgConfigYaml(
        "tools:\n  unknown: allow\nextensions:\n  allow:\n    - github\n",
      ),
    });
    await seedOrgCredential(h.store);

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Lisbon" },
      caller: "UADA",
    });

    expect(result.ok).toBe(false);
    expect(await callRows(h.store, EXTENSION_CREDENTIAL_RESOLVED_EVENT)).toHaveLength(0);
    expect(h.boundary.calls).toHaveLength(0);
    const calls = await callRows(h.store, EXTENSION_CALL_EVENT);
    expect(parse(calls[0]!)).toMatchObject({ decision: "deny", credential_id: null });
  });

  test("an unknown extension or tool is an audited error, not a silent no-op", async () => {
    const h = makeHarness();

    const unknownExtension = await h.runtime.execute({
      extensionId: "nope.provider",
      toolName: "whatever",
      args: {},
      caller: "UADA",
    });
    expect(unknownExtension.ok).toBe(false);
    if (!unknownExtension.ok) expect(unknownExtension.error).toContain("not registered");

    const unknownTool = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: "weather.history",
      args: {},
      caller: "UADA",
    });
    expect(unknownTool.ok).toBe(false);
    if (!unknownTool.ok) expect(unknownTool.error).toContain("not declared");

    const calls = await callRows(h.store, EXTENSION_CALL_EVENT);
    expect(calls).toHaveLength(2);
    expect(parse(calls[0]!)).toMatchObject({ extension: "nope.provider", decision: "error", credential_id: null });
    expect(parse(calls[1]!)).toMatchObject({ extension: FIXTURE_EXTENSION_ID, tool: "weather.history", decision: "error" });
    expect(await callRows(h.store, EXTENSION_CREDENTIAL_RESOLVED_EVENT)).toHaveLength(0);
    expect(h.boundary.calls).toHaveLength(0);
  });
});

describe("extension runtime: ladder (org / me / auto) and boundary", () => {
  test("full path: gate allow → org ladder → boundary injection → MCP call → audit", async () => {
    const h = makeHarness();
    const org = await seedOrgCredential(h.store);

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Lisbon" },
      caller: "UADA",
      spaceId: "slack:C1",
    });

    expect(result).toEqual({ ok: true, content: [{ type: "text", text: "sunny in Lisbon" }] });
    // The ladder resolved the org row...
    expect(h.boundary.calls).toEqual([org]);
    // ...the MCP call went out over the injected transport...
    expect(h.transports.bindings).toHaveLength(1);
    // ...and the trail carries policy decision, resolution, and call rows.
    const decisions = await callRows(h.store, POLICY_DECISION_EVENT);
    expect(parse(decisions.at(-1)!)).toMatchObject({ tool: FIXTURE_EXTENSION_TOOL, decision: "allow" });
    const resolved = await callRows(h.store, EXTENSION_CREDENTIAL_RESOLVED_EVENT);
    expect(parse(resolved[0]!)).toMatchObject({
      provider: FIXTURE_EXTENSION_ID,
      scope: "org",
      credential_id: org.id,
      broker_credential_id: 7,
    });
    const calls = await callRows(h.store, EXTENSION_CALL_EVENT);
    expect(parse(calls[0]!)).toMatchObject({
      extension: FIXTURE_EXTENSION_ID,
      tool: FIXTURE_EXTENSION_TOOL,
      actor: "UADA",
      credential_id: org.id,
      decision: "allow",
    });
    // Credential hygiene: no secret value anywhere on the trail (the audit
    // module redacts secret-shaped strings anyway; the payloads carry ids
    // only).
    for (const row of [...decisions, ...resolved, ...calls]) {
      expect(row.payload).not.toContain("sk-");
      expect(row.payload).not.toContain("Bearer");
    }
  });

  test("me scope resolves the caller's personal credential", async () => {
    const h = makeHarness({ policy: parseOrgConfigYaml("tools:\n  unknown: allow\n") });
    const personal = await seedPersonalCredential(h.store, FIXTURE_EXTENSION_ID, "UADA");
    // An org row exists too: me scope must not fall back to it.
    await seedOrgCredential(h.store);

    const runtime = createExtensionRuntime({
      registry: createFixtureRegistry(),
      store: h.store,
      audit: createAudit(h.store),
      orgPolicy: parseOrgConfigYaml("tools:\n  unknown: allow\n"),
      router: DenyRouter,
      boundary: h.boundary,
      mcpTransport: h.mcpTransport,
      callScope: "me",
    });

    const result = await runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Oslo" },
      caller: "UADA",
    });
    expect(result.ok).toBe(true);
    expect(h.boundary.calls).toEqual([personal]);
    const calls = await callRows(h.store, EXTENSION_CALL_EVENT);
    expect(parse(calls[0]!)).toMatchObject({ credential_id: personal.id, decision: "allow" });
  });

  test("me scope with no personal row errors without calling the provider", async () => {
    const h = makeHarness();
    await seedOrgCredential(h.store);

    const runtime = createExtensionRuntime({
      registry: createFixtureRegistry(),
      store: h.store,
      audit: createAudit(h.store),
      orgPolicy: parseOrgConfigYaml("tools:\n  unknown: allow\n"),
      router: DenyRouter,
      boundary: h.boundary,
      mcpTransport: h.mcpTransport,
      callScope: "me",
    });
    const result = await runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Oslo" },
      caller: "UADA",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("connect your fixture.weather account");
    expect(h.boundary.calls).toHaveLength(0);
    expect(h.transports.bindings).toHaveLength(0);
    expect(await callRows(h.store, EXTENSION_CREDENTIAL_RESOLVED_EVENT)).toHaveLength(0);
  });

  test("auto scope honors extensions.org_credentials deny → personal row", async () => {
    const h = makeHarness({
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\nextensions:\n  org_credentials: deny\n"),
    });
    await seedOrgCredential(h.store);
    const personal = await seedPersonalCredential(h.store, FIXTURE_EXTENSION_ID, "UADA");

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Oslo" },
      caller: "UADA",
    });
    expect(result.ok).toBe(true);
    expect(h.boundary.calls).toEqual([personal]);
  });

  test("no credential at all → ask signal blocks and audits an error", async () => {
    const h = makeHarness();
    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Oslo" },
      caller: "UADA",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no fixture.weather credential is available");
    expect(h.boundary.calls).toHaveLength(0);
    expect(h.transports.bindings).toHaveLength(0);
    const calls = await callRows(h.store, EXTENSION_CALL_EVENT);
    expect(parse(calls[0]!)).toMatchObject({ decision: "error", credential_id: null });
  });

  test("a boundary failure fails closed as a tool error (allow already audited)", async () => {
    const failingBoundary: CredentialBoundary = {
      async authorize() {
        throw new Error("proxy reload failed (500)");
      },
    };
    const h = makeHarness({ boundary: failingBoundary });
    await seedOrgCredential(h.store);

    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Oslo" },
      caller: "UADA",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("proxy reload failed");
    expect(h.transports.bindings).toHaveLength(0);
    // The allow decision is on the trail (the call was authorized and
    // attempted; the boundary failure is an execution failure).
    const calls = await callRows(h.store, EXTENSION_CALL_EVENT);
    expect(parse(calls[0]!)).toMatchObject({ decision: "allow" });
  });

  test("MCP connection failures surface as tool errors", async () => {
    const h = makeHarness({
      mcpTransport: () => {
        throw new Error("connection refused");
      },
    });
    await seedOrgCredential(h.store);
    const result = await h.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Lisbon" },
      caller: "UADA",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("connection refused");
  });

  test("extension tool args pass through to the provider verbatim", async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const harness = makeHarness({
      mcpTransport: () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const server = new Server({ name: "capture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          seen.push({ name: request.params.name, args: request.params.arguments as Record<string, unknown> });
          return { content: [{ type: "text", text: "ok" }] };
        });
        void server.connect(serverTransport);
        return clientTransport;
      },
    });
    await seedOrgCredential(harness.store);

    const result = await harness.runtime.execute({
      extensionId: FIXTURE_EXTENSION_ID,
      toolName: FIXTURE_EXTENSION_TOOL,
      args: { city: "Porto", units: "metric" },
      caller: "UADA",
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ name: FIXTURE_EXTENSION_TOOL, args: { city: "Porto", units: "metric" } }]);
  });
});

describe("extension runtime: secret-file boundary (issue #53 injection wiring)", () => {
  test("writes the resolved secret to the extension's file with mode 0600 and reloads the proxy", async () => {
    const secretsDir = join(dir, "boundary-secrets");
    const reloads: Array<{ url: string; auth: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        reloads.push({
          url: req.url,
          auth: req.headers.get("authorization"),
        });
        return new Response("ok");
      },
    });
    try {
      const boundary = createSecretFileBoundary({
        resolveSecret: async () => "sk-real-secret-123",
        secretsDir,
        proxyControlUrl: `http://127.0.0.1:${server.port}`,
        proxyControlToken: "mgmt-token",
      });
      const store = createStore(":memory:");
      stores.push(store);
      const credential = await seedOrgCredential(store);
      await boundary.authorize(credential);

      const filePath = join(secretsDir, extensionSecretFileName(FIXTURE_EXTENSION_ID));
      expect(readFileSync(filePath, "utf8")).toBe("sk-real-secret-123");
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      // The reload hit the management API with the bearer token.
      expect(reloads).toEqual([
        { url: `http://127.0.0.1:${server.port}/v1/reload`, auth: "Bearer mgmt-token" },
      ]);
    } finally {
      server.stop();
    }
  });

  test("no broker resolver → fails closed with a clear error, nothing written", async () => {
    const secretsDir = join(dir, "boundary-empty");
    const boundary = createSecretFileBoundary({ secretsDir });
    const store = createStore(":memory:");
    stores.push(store);
    const credential = await seedOrgCredential(store);
    await expect(boundary.authorize(credential)).rejects.toThrow(/issue #54/);
    expect(() => statSync(join(secretsDir, extensionSecretFileName(FIXTURE_EXTENSION_ID)))).toThrow();
  });

  test("a failed proxy reload fails the authorization closed", async () => {
    const boundary = createSecretFileBoundary({
      resolveSecret: async () => "sk-secret",
      secretsDir: join(dir, "boundary-reload-fail"),
      proxyControlUrl: "http://127.0.0.1:9",
    });
    const store = createStore(":memory:");
    stores.push(store);
    const credential = await seedOrgCredential(store);
    await expect(boundary.authorize(credential)).rejects.toThrow(/proxy reload failed/);
  });

  test("the proxy-side file path matches the generated egress config", () => {
    // The runtime writes PROXY_SECRETS_DIR/...; the generated config reads
    // /data/proxy-secrets/... (same volume). Both use the same filename.
    expect(PROXY_SECRETS_DIR.endsWith("proxy-secrets")).toBe(true);
  });
});

describe("extension runtime: tools-less manifests discover their surface (issue #158)", () => {
  const DISCOVER_ID = "discover.me";
  const WIRE_TOOLS = [
    { name: "search_issues", description: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "create_issue", description: "Create", inputSchema: { type: "object", properties: {} } },
    { name: "delete_issue", description: "Delete", inputSchema: { type: "object", properties: {} } },
  ];

  beforeEach(() => {
    // The discovery cache is per-process (keyed by manifest id + binding,
    // not by transport) — hermetic tests must not observe a stale surface
    // from an earlier fixture.
    resetToolSurfaceCache();
  });

  function toolsLessManifest(): ExtensionManifest {
    return validateManifest({
      id: DISCOVER_ID,
      label: "Discover Me",
      vendor: "example",
      kind: "mcp",
      mcp: { serverUrl: "http://127.0.0.1:9/mcp", transport: "streamable-http" },
      credentialSchema: { type: "api_key" },
      domains: ["discover.me.test"],
    });
  }

  /** Transport serving BOTH tools/list (discovery) and tools/call (execution). */
  function discoverableTransport(calls: { list: number; tool: string[] }) {
    return (): Transport => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "discover-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        calls.list += 1;
        return { tools: WIRE_TOOLS };
      });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls.tool.push(request.params.name);
        return { content: [{ type: "text", text: `ok ${request.params.name}` }] };
      });
      void server.connect(serverTransport);
      return clientTransport;
    };
  }

  test("full path: lazy discovery → gate with the DISCOVERED tier → ladder → boundary → provider call by wire name", async () => {
    const calls = { list: 0, tool: [] as string[] };
    const h = makeHarness({
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\n"),
      manifests: [toolsLessManifest()],
      mcpTransport: discoverableTransport(calls),
    });
    const org = await seedOrgCredential(h.store, DISCOVER_ID);

    // The bridge forwards the provider's WIRE name (providerName) — the
    // runtime resolves it against the discovered surface.
    const result = await h.runtime.execute({
      extensionId: DISCOVER_ID,
      toolName: "search_issues",
      args: { query: "repo:x" },
      caller: "UADA",
      spaceId: "slack:C1",
    });

    expect(result).toEqual({ ok: true, content: [{ type: "text", text: "ok search_issues" }] });
    // Discovery happened exactly once (cached per manifest id + binding)…
    expect(calls.list).toBe(1);
    // …the provider call used the wire name…
    expect(calls.tool).toEqual(["search_issues"]);
    // …the boundary received the resolved credential…
    expect(h.boundary.calls).toEqual([org]);
    // …and the policy decision audited the DISCOVERED tier (read), not the
    // static unknown-tool table (exec).
    const decisions = await callRows(h.store, POLICY_DECISION_EVENT);
    expect(parse(decisions.at(-1)!)).toMatchObject({
      tool: "discover.me.search_issues",
      tier: "read",
      decision: "allow",
    });
    const callsAudit = await callRows(h.store, EXTENSION_CALL_EVENT);
    expect(parse(callsAudit[0]!)).toMatchObject({
      extension: DISCOVER_ID,
      tool: "discover.me.search_issues",
      credential_id: org.id,
      decision: "allow",
    });
  });

  test("an extension denied per-space blocks EVERY discovered tool before any credential work", async () => {
    const calls = { list: 0, tool: [] as string[] };
    const h = makeHarness({
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\n"),
      manifests: [toolsLessManifest()],
      mcpTransport: discoverableTransport(calls),
    });
    await seedOrgCredential(h.store, DISCOVER_ID);
    // Per-space overlay: deny the whole extension in this space only.
    const space = await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    await h.store.updatePolicy(space.id, JSON.stringify({ extensions: { deny: [DISCOVER_ID] } }));

    const result = await h.runtime.execute({
      extensionId: DISCOVER_ID,
      toolName: "search_issues",
      args: {},
      caller: "UADA",
      spaceId: space.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("denied by this space's policy");
    // Denied BEFORE the ladder: no credential resolution, no boundary
    // write, no provider call — but discovery still resolved the surface
    // (the gate needed the discovered tier to make the deny decision).
    expect(await callRows(h.store, EXTENSION_CREDENTIAL_RESOLVED_EVENT)).toHaveLength(0);
    expect(h.boundary.calls).toHaveLength(0);
    expect(calls.tool).toEqual([]);
    const callsAudit = await callRows(h.store, EXTENSION_CALL_EVENT);
    expect(parse(callsAudit[0]!)).toMatchObject({ decision: "deny", credential_id: null });
  });

  test("a per-space tool deny gates ONE discovered tool; sibling discovered tools still run", async () => {
    const calls = { list: 0, tool: [] as string[] };
    const h = makeHarness({
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\n"),
      manifests: [toolsLessManifest()],
      mcpTransport: discoverableTransport(calls),
    });
    await seedOrgCredential(h.store, DISCOVER_ID);
    const space = await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    // Deny the destructive discovered tool by its namespaced manifest name.
    await h.store.updatePolicy(space.id, JSON.stringify({ tools: { "discover.me.delete_issue": "deny" } }));

    const denied = await h.runtime.execute({
      extensionId: DISCOVER_ID,
      toolName: "delete_issue",
      args: {},
      caller: "UADA",
      spaceId: space.id,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain("policy denies");
    expect(calls.tool).toEqual([]);

    // The non-denied discovered tool still executes (same extension, same
    // space): per-tool granularity on the discovered surface.
    const allowed = await h.runtime.execute({
      extensionId: DISCOVER_ID,
      toolName: "search_issues",
      args: { query: "repo:x" },
      caller: "UADA",
      spaceId: space.id,
    });
    expect(allowed.ok).toBe(true);
    expect(calls.tool).toEqual(["search_issues"]);
  });

  test("a pinned-tools manifest wins: the transport only ever sees the CALL, never tools/list", async () => {
    const calls = { list: 0, tool: [] as string[] };
    const pinned = validateManifest({
      id: "pinned.provider",
      label: "Pinned",
      vendor: "example",
      kind: "mcp",
      mcp: { serverUrl: "http://127.0.0.1:9/mcp", transport: "streamable-http" },
      credentialSchema: { type: "api_key" },
      tools: [{ name: "pinned.provider.get", tier: "read", description: "Pinned surface", params: [] }],
      domains: ["pinned.test"],
    });
    const h = makeHarness({
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\n"),
      manifests: [pinned],
      mcpTransport: discoverableTransport(calls),
    });
    await seedOrgCredential(h.store, "pinned.provider");

    const result = await h.runtime.execute({
      extensionId: "pinned.provider",
      toolName: "pinned.provider.get",
      args: {},
      caller: "UADA",
    });
    expect(result.ok).toBe(true);
    // No tools/list ever — the pinned surface is the whole surface.
    expect(calls.list).toBe(0);
    expect(calls.tool).toEqual(["pinned.provider.get"]);
  });

  test("an unreachable provider fails closed: a clear error result, never a silent empty toolset", async () => {
    const h = makeHarness({
      policy: parseOrgConfigYaml("tools:\n  unknown: allow\n"),
      manifests: [toolsLessManifest()],
      mcpTransport: () => {
        throw new Error("connection refused");
      },
    });
    await seedOrgCredential(h.store, DISCOVER_ID);

    const result = await h.runtime.execute({
      extensionId: DISCOVER_ID,
      toolName: "search_issues",
      args: {},
      caller: "UADA",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("tool surface unavailable");
      expect(result.error).toContain("tools/list failed");
    }
    // The failure is audited as an error and nothing downstream ran.
    const callsAudit = await callRows(h.store, EXTENSION_CALL_EVENT);
    expect(parse(callsAudit[0]!)).toMatchObject({ decision: "error", credential_id: null });
    expect(await callRows(h.store, EXTENSION_CREDENTIAL_RESOLVED_EVENT)).toHaveLength(0);
    expect(h.boundary.calls).toHaveLength(0);
  });

  test("boot-resolved surfaces: the runtime consumes the pre-resolved map without re-discovering", async () => {
    const calls = { list: 0, tool: [] as string[] };
    const registry = createExtensionRegistryFor([toolsLessManifest()]);
    const surfaces = await resolveExtensionSurfaces(registry.list(), { mcpTransport: discoverableTransport(calls) });
    // Boot resolution discovered once…
    expect(calls.list).toBe(1);
    const store = createStore(":memory:");
    stores.push(store);
    await seedOrgCredential(store, DISCOVER_ID);
    const runtime = createExtensionRuntime({
      registry,
      store,
      audit: createAudit(store),
      orgPolicy: parseOrgConfigYaml("tools:\n  unknown: allow\n"),
      router: DenyRouter,
      boundary: hBoundary(),
      mcpTransport: discoverableTransport(calls),
      surfaces,
    });
    const result = await runtime.execute({
      extensionId: DISCOVER_ID,
      toolName: "search_issues",
      args: { query: "repo:x" },
      caller: "UADA",
    });
    expect(result.ok).toBe(true);
    // The execute path read the pre-resolved surface: no second tools/list.
    expect(calls.list).toBe(1);
    expect(calls.tool).toEqual(["search_issues"]);
  });
});

/** A recording boundary for ad-hoc runtime constructions. */
function hBoundary(): CredentialBoundary {
  return {
    async authorize() {},
  };
}

/** A registry with exactly the given manifests. */
function createExtensionRegistryFor(manifests: ExtensionManifest[]) {
  const registry = createExtensionRegistry();
  for (const manifest of manifests) registry.register(manifest);
  return registry;
}
