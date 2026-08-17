/**
 * MCP surface tests (issue #25): conformance of the spawned bottega MCP
 * server against a real MCP client (the official SDK), and enforcement of
 * the policy gate + audit at execution time.
 *
 * Every test spawns the real entrypoint (`src/mcp/server.ts`) as a child
 * process with a temp DB + temp config dir, and drives it with the official
 * MCP TypeScript client over the stdio transport — the same transport the
 * agent's MCP client uses when bottega attaches the server to an ACP
 * session. No ports, no global state; each test cleans up its process, DB,
 * and temp dir.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createStore, type AuditRow, type Store, type ExtensionCredential } from "../store/db";
import { sha256Hex } from "../tools/memory";
import { createSqliteMemoryProvider } from "../memory/sqlite";
import { createAudit } from "../policy/audit";
import { DenyRouter } from "../policy/approval-router";
import { parseOrgConfigYaml, type PolicyConfig } from "../policy/config";
import {
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_RESOLVED_EVENT,
  EXTENSION_CALL_EVENT,
  EXTENSION_CONNECTED_EVENT,
  EXTENSION_CREDENTIAL_RESOLVED_EVENT,
  POLICY_DECISION_EVENT,
} from "../store/audit-events";
import type { CredentialBoundary } from "../extensions/boundary";
import type { BrokerConnector } from "../extensions/connect";
import { createFixtureRegistry, fixtureManifest, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL } from "../extensions/fixture";
import { validateManifest, type ExtensionManifest, type McpBinding } from "../extensions/manifest";
import { createExtensionRegistry, type ExtensionRegistry } from "../extensions/registry";
import { createExtensionRuntime } from "../extensions/runtime";
import { resetToolSurfaceCache } from "../extensions/surface";
import { createMemoryMcpServer } from "./server";

const SERVER_ENTRY = join(import.meta.dir, "server.ts");

interface LaunchOpts {
  configYaml: string;
  /** Space overlay JSON; seeds a space row and boots the server pinned to it. */
  policyJson?: string;
  defaultPrincipal?: string;
  /** Pinned snapshots seeded into a temp extensions dir (BOTTEGA_EXTENSIONS_DIR). */
  extensions?: ExtensionManifest[];
}

interface Harness {
  client: Client;
  store: Store;
  dir: string;
  /** The seeded space id (present when policyJson was given). */
  spaceId?: string;
  cleanup: () => Promise<void>;
}

async function launch(opts: LaunchOpts): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "bottega-mcp-"));
  const dbPath = join(dir, "test.db");
  const configDir = join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.yml"), opts.configYaml);
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir);

  // Seed the space overlay before the server boots (server reads it at boot).
  let spaceId: string | undefined;
  if (opts.policyJson) {
    const seed = createStore(dbPath);
    try {
      const space = await seed.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      spaceId = space.id;
      await seed.updatePolicy(space.id, opts.policyJson);
    } finally {
      seed.close();
    }
  }

  const env: Record<string, string> = {
    BOTTEGA_DB_PATH: dbPath,
    BOTTEGA_CONFIG_DIR: configDir,
    BOTTEGA_SESSION_DIR: sessionsDir,
  };
  if (spaceId) env.BOTTEGA_SPACE_ID = spaceId;
  if (opts.defaultPrincipal) env.BOTTEGA_MCP_DEFAULT_PRINCIPAL = opts.defaultPrincipal;
  // Pin an empty extensions dir so the spawned server never picks up the
  // repo's real snapshots via the cwd-relative default; seed it when the
  // test asks for extensions (issue #61).
  const extDir = join(dir, "extensions");
  mkdirSync(extDir, { recursive: true });
  for (const manifest of opts.extensions ?? []) {
    writeFileSync(
      join(extDir, `${manifest.id}.json`),
      JSON.stringify({
        schema: "bottega.extension-snapshot.v1",
        extensionId: manifest.id,
        pinnedAt: "2026-08-16T00:00:00.000Z",
        source: { catalog: "https://integrations.sh/api.json", specId: manifest.id, vendorOfficial: true, reviewed: true },
        manifest,
      }),
    );
  }
  env.BOTTEGA_EXTENSIONS_DIR = extDir;

  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER_ENTRY],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "bottega-mcp-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  const store = createStore(dbPath);
  return {
    client,
    store,
    dir,
    spaceId,
    cleanup: async () => {
      await client.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function auditRows(store: Store, eventType: string): Promise<AuditRow[]> {
  return store.listAudit({ event_type: eventType });
}

function payload(row: AuditRow): Record<string, unknown> {
  return JSON.parse(row.payload) as Record<string, unknown>;
}

/** The SDK's callTool return type is index-signature-heavy; narrow it here. */
interface ToolCallResult {
  content: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/** Org floor allowing the built-in memory and transcript-search tools. */
const ALLOW_ALL = "tools:\n  memory.save: allow\n  memory.search: allow\n  session_search: allow\n";

describe("MCP server conformance (spawned entrypoint)", () => {
  test("initialize + tools/list returns the capability tools (memory + connect) with schemas", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    try {
      const { tools } = await h.client.listTools();
      // connect_extension is a core capability: advertised even when no
      // extension snapshots are seeded (issue #61).
      expect(tools.map((t) => t.name).sort()).toEqual([
        "connect_extension",
        "memory.save",
        "memory.search",
        "session_search",
      ]);

      const connect = tools.find((t) => t.name === "connect_extension")!;
      expect((connect.description ?? "").length).toBeGreaterThan(0);
      const connectProps = connect.inputSchema.properties as Record<string, { type?: string; enum?: string[] }>;
      expect(Object.keys(connectProps).sort()).toEqual(["api_key", "extension", "scope"]);
      expect(connectProps.scope?.enum).toEqual(["org", "personal"]);
      expect(connectProps.extension?.type).toBe("string");
      expect(connect.inputSchema.required).toContain("extension");
      expect(connect.inputSchema.required).toContain("scope");

      const save = tools.find((t) => t.name === "memory.save")!;
      expect((save.description ?? "").length).toBeGreaterThan(0);
      const saveProps = save.inputSchema.properties as Record<string, { type?: string; enum?: string[] }>;
      expect(Object.keys(saveProps).sort()).toEqual(["content", "metadata", "principal", "scope"]);
      expect(saveProps.scope?.enum).toEqual(["org", "user"]);
      expect(saveProps.content?.type).toBe("string");
      expect(save.inputSchema.required).toContain("content");
      expect(save.inputSchema.required).toContain("scope");

      const search = tools.find((t) => t.name === "memory.search")!;
      const searchProps = search.inputSchema.properties as Record<string, { type?: string }>;
      expect(Object.keys(searchProps).sort()).toEqual(["limit", "principal", "query", "scope"]);
      expect(searchProps.query?.type).toBe("string");
      expect(search.inputSchema.required).toContain("query");
      expect(search.inputSchema.required).toContain("scope");

      const sessionSearch = tools.find((t) => t.name === "session_search")!;
      const sessionSearchProps = sessionSearch.inputSchema.properties as Record<string, { type?: string }>;
      expect(Object.keys(sessionSearchProps).sort()).toEqual(["limit", "query", "space"]);
      expect(sessionSearchProps.query?.type).toBe("string");
      expect(sessionSearch.inputSchema.required).toEqual(["query"]);
    } finally {
      await h.cleanup();
    }
  });

  test("tools/call session_search indexes and searches transcript JSONL", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    try {
      writeFileSync(
        join(h.dir, "sessions", "slack:C9.jsonl"),
        `${JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-08-17T01:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "release train is green" }] },
        })}\n`,
      );
      const result = (await h.client.callTool({
        name: "session_search",
        arguments: { query: "release", space: "slack:C9" },
      })) as ToolCallResult;
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0]!.text!) as unknown).toEqual([
        {
          space: "slack:C9",
          file: "slack:C9.jsonl",
          line: 1,
          timestamp: "2026-08-17T01:00:00.000Z",
          text: "release train is green",
        },
      ]);
    } finally {
      await h.cleanup();
    }
  });

  test("tools/call memory.save writes an audit row with content_hash, never the content", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    try {
      const res = (await h.client.callTool({
        name: "memory.save",
        arguments: { scope: "org", content: "the vault combination is 1234", metadata: { topic: "vault" } },
      })) as ToolCallResult;
      expect(res.isError).not.toBe(true);
      const text = (res.content[0] as { type: string; text: string }).text;
      const { id } = JSON.parse(text) as { id: string };
      expect(id).toMatch(/^mem_/);

      const rows = await auditRows(h.store, "memory.write");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("agent");
      expect(rows[0]!.space_id).toBeNull();
      const p = payload(rows[0]!);
      expect(p.scope).toBe("org");
      expect(p.principal).toBeNull();
      expect(p.id).toBe(id);
      expect(p.content_hash).toBe(sha256Hex("the vault combination is 1234"));
      const auditText = rows[0]!.payload;
      expect(auditText).not.toContain("vault combination");
      expect(auditText).not.toContain("1234");

      // The save was also policy-gated: a policy.decision row records it.
      const decisions = await auditRows(h.store, "policy.decision");
      expect(decisions).toHaveLength(1);
      expect(payload(decisions[0]!).decision).toBe("allow");
    } finally {
      await h.cleanup();
    }
  });

  test("user-scope save requires and audits the principal; search scopes by principal", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    try {
      const res = await h.client.callTool({
        name: "memory.save",
        arguments: { scope: "user", principal: "U123", content: "prefers dark mode" },
      });
      expect(res.isError).not.toBe(true);

      const rows = await auditRows(h.store, "memory.write");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("U123");
      expect(payload(rows[0]!).principal).toBe("U123");
      expect(payload(rows[0]!).scope).toBe("user");
    } finally {
      await h.cleanup();
    }
  });

  test("user-scope save without principal fails as an MCP error and saves nothing", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    try {
      await expect(
        h.client.callTool({ name: "memory.save", arguments: { scope: "user", content: "orphaned" } }),
      ).rejects.toThrow(/principal/);
      expect(await auditRows(h.store, "memory.write")).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test("empty content fails as an MCP error and saves nothing", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    try {
      await expect(
        h.client.callTool({ name: "memory.save", arguments: { scope: "org", content: "   " } }),
      ).rejects.toThrow(/non-empty/);
      expect(await auditRows(h.store, "memory.write")).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test("out-of-range limit fails as an MCP error", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    try {
      await expect(
        h.client.callTool({ name: "memory.search", arguments: { scope: "org", query: "x", limit: 100 } }),
      ).rejects.toThrow(/limit/);
    } finally {
      await h.cleanup();
    }
  });

  test("unknown tool fails as an MCP error", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    try {
      await expect(h.client.callTool({ name: "memory.nonexistent", arguments: {} })).rejects.toThrow();
    } finally {
      await h.cleanup();
    }
  });

  test("search scopes org vs user and filters by principal", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    try {
      await h.client.callTool({ name: "memory.save", arguments: { scope: "org", content: "alpha org fact" } });
      await h.client.callTool({ name: "memory.save", arguments: { scope: "user", principal: "U1", content: "alpha user fact" } });
      await h.client.callTool({ name: "memory.save", arguments: { scope: "user", principal: "U2", content: "alpha other user" } });

      const org = (await h.client.callTool({ name: "memory.search", arguments: { scope: "org", query: "alpha" } })) as ToolCallResult;
      const orgEntries = JSON.parse((org.content[0] as { text: string }).text) as Array<{ scope: string }>;
      expect(orgEntries.map((e) => e.scope)).toEqual(["org"]);

      const mine = (await h.client.callTool({
        name: "memory.search",
        arguments: { scope: "user", query: "alpha", principal: "U1" },
      })) as ToolCallResult;
      const mineEntries = JSON.parse((mine.content[0] as { text: string }).text) as Array<{ principal: string | null }>;
      expect(mineEntries.map((e) => e.principal)).toEqual(["U1"]);
    } finally {
      await h.cleanup();
    }
  });

  test("defaultPrincipal from env applies to user-scope saves that omit principal", async () => {
    const h = await launch({ configYaml: ALLOW_ALL, defaultPrincipal: "U9" });
    try {
      const res = await h.client.callTool({ name: "memory.save", arguments: { scope: "user", content: "likes llamas" } });
      expect(res.isError).not.toBe(true);
      const rows = await auditRows(h.store, "memory.write");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("U9");
      expect(payload(rows[0]!).principal).toBe("U9");
    } finally {
      await h.cleanup();
    }
  });
});

/** Org floor allowing extension calls (unknown default) + memory + connect. */
const EXT_ALLOW =
  "tools:\n  unknown: allow\n  memory.save: allow\n  memory.search: allow\n  session_search: allow\n  connect_extension: allow\n";

describe("MCP server extension surface (spawned entrypoint)", () => {
  test("advertises connect_extension and the registry's manifest tools", async () => {
    const h = await launch({ configYaml: EXT_ALLOW, extensions: [fixtureManifest()] });
    try {
      const { tools } = await h.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "connect_extension",
        "memory.save",
        "memory.search",
        "session_search",
        FIXTURE_EXTENSION_TOOL,
      ]);

      const weather = tools.find((t) => t.name === FIXTURE_EXTENSION_TOOL)!;
      expect((weather.description ?? "").length).toBeGreaterThan(0);
      const props = weather.inputSchema.properties as Record<string, { type?: string }>;
      expect(props.city?.type).toBe("string");
      expect(weather.inputSchema.required).toEqual(["city"]);
    } finally {
      await h.cleanup();
    }
  });

  test("extension tool calls run the runtime: policy allow, ladder fail-closed, audited", async () => {
    const h = await launch({ configYaml: EXT_ALLOW, extensions: [fixtureManifest()] });
    try {
      // No credential seeded: the call clears the gate, then fails closed at
      // the credential ladder — the provider (unreachable) is never touched.
      const res = (await h.client.callTool({
        name: FIXTURE_EXTENSION_TOOL,
        arguments: { city: "Lisbon" },
      })) as ToolCallResult;
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text ?? "").toContain("no fixture.weather credential is available");

      const decisions = await auditRows(h.store, POLICY_DECISION_EVENT);
      expect(payload(decisions[0]!).tool).toBe(FIXTURE_EXTENSION_TOOL);
      expect(payload(decisions[0]!).decision).toBe("allow");
      expect(payload(decisions[0]!).tier).toBe("read");
      const calls = await auditRows(h.store, EXTENSION_CALL_EVENT);
      expect(calls).toHaveLength(1);
      expect(payload(calls[0]!).decision).toBe("error");
      expect(payload(calls[0]!).credential_id).toBeNull();
      expect(await auditRows(h.store, EXTENSION_CREDENTIAL_RESOLVED_EVENT)).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test("the session space's overlay denies an extension the org floor allows", async () => {
    const h = await launch({
      configYaml: EXT_ALLOW,
      policyJson: JSON.stringify({ extensions: { deny: [FIXTURE_EXTENSION_ID] } }),
      extensions: [fixtureManifest()],
    });
    try {
      const res = (await h.client.callTool({
        name: FIXTURE_EXTENSION_TOOL,
        arguments: { city: "Lisbon" },
      })) as ToolCallResult;
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text ?? "").toContain("denied by this space's policy");

      const decisions = await auditRows(h.store, POLICY_DECISION_EVENT);
      expect(payload(decisions[0]!).decision).toBe("deny");
      expect(decisions[0]!.space_id).toBe(h.spaceId!);
      const calls = await auditRows(h.store, EXTENSION_CALL_EVENT);
      expect(calls).toHaveLength(1);
      expect(payload(calls[0]!).decision).toBe("deny");
      expect(payload(calls[0]!).credential_id).toBeNull();
      expect(await auditRows(h.store, EXTENSION_CREDENTIAL_RESOLVED_EVENT)).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });
});

describe("MCP server extension surface (in-process deps)", () => {
  /** Fake egress boundary: records the credential, never touches the proxy. */
  function makeBoundary(): CredentialBoundary & { calls: ExtensionCredential[] } {
    const calls: ExtensionCredential[] = [];
    return {
      calls,
      async authorize(credential: ExtensionCredential) {
        calls.push(credential);
      },
    };
  }

  interface InProcessHarness {
    client: Client;
    store: Store;
    boundary: CredentialBoundary & { calls: ExtensionCredential[] };
    brokerCalls: Array<{ provider: string; credentialType: string; apiKey?: string }>;
    cleanup: () => Promise<void>;
  }

  /** In-process server with injected runtime deps (real store + audit, fake boundary/broker/transport). */
  async function makeInProcessHarness(opts: {
    policy?: PolicyConfig;
    defaultPrincipal?: string;
    registry?: ExtensionRegistry;
    mcpTransport?: (binding: McpBinding) => Transport;
  } = {}): Promise<InProcessHarness> {
    const dir = mkdtempSync(join(tmpdir(), "bottega-mcp-inproc-"));
    const store = createStore(join(dir, "test.db"));
    const audit = createAudit(store);
    const registry = opts.registry ?? createFixtureRegistry();
    const policy = opts.policy ?? parseOrgConfigYaml(EXT_ALLOW);
    const boundary = makeBoundary();
    const brokerCalls: Array<{ provider: string; credentialType: string; apiKey?: string }> = [];
    const broker: BrokerConnector = async (input) => {
      brokerCalls.push(input);
      return { identityKey: null, brokerCredentialId: 42 };
    };
    const mcpTransport =
      opts.mcpTransport ??
      ((_binding: McpBinding): Transport => {
        // Stub provider MCP server: returns the city echoed back (hermetic —
        // the fixture's serverUrl is intentionally unreachable).
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const stub = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
        stub.setRequestHandler(CallToolRequestSchema, async (request) => {
          const args = request.params.arguments as Record<string, unknown>;
          return { content: [{ type: "text", text: `sunny in ${String(args["city"] ?? "")}` }] };
        });
        void stub.connect(serverTransport);
        return clientTransport;
      });
    const runtime = createExtensionRuntime({
      registry,
      store,
      audit,
      orgPolicy: policy,
      router: DenyRouter,
      boundary,
      mcpTransport,
    });
    const server = createMemoryMcpServer({
      provider: createSqliteMemoryProvider(store.getDb()),
      policy,
      audit,
      spaceId: "slack:C1",
      defaultPrincipal: opts.defaultPrincipal ?? "U123",
      sessionSearch: { db: store.getDb(), transcriptDir: join(dir, "sessions") },
      extensions: {
        runtime,
        registry,
        mcpTransport,
        connect: {
          registry,
          store,
          audit,
          broker,
          gate: { loadPolicy: () => Promise.resolve(policy), router: DenyRouter, timeoutMs: 1_000 },
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport);
    const client = new Client({ name: "bottega-mcp-inproc-test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(clientTransport);
    return {
      client,
      store,
      boundary,
      brokerCalls,
      cleanup: async () => {
        await client.close();
        await server.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  test("a tools-less manifest is advertised + callable on the MCP surface via discovery (issue #158)", async () => {
    const DISCOVER_ID = "discover.me";
    // The discovery cache is process-global — reset so this hermetic test
    // never observes a stale surface from another file's fixture.
    resetToolSurfaceCache();
    const wireTools = [
      { name: "search_issues", description: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "delete_issue", description: "Delete", inputSchema: { type: "object", properties: {} } },
    ];
    const seen = { list: 0, tool: [] as string[] };
    const registry = createExtensionRegistry();
    registry.register(
      validateManifest({
        id: DISCOVER_ID,
        label: "Discover Me",
        vendor: "example",
        kind: "mcp",
        mcp: { serverUrl: "http://127.0.0.1:9/mcp", transport: "streamable-http" },
        credentialSchema: { type: "api_key" },
        domains: ["discover.me.test"],
      }),
    );
    const h = await makeInProcessHarness({
      registry,
      mcpTransport: () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const stub = new Server({ name: "discover-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
        stub.setRequestHandler(ListToolsRequestSchema, async () => {
          seen.list += 1;
          return { tools: wireTools };
        });
        stub.setRequestHandler(CallToolRequestSchema, async (request) => {
          seen.tool.push(request.params.name);
          return { content: [{ type: "text", text: `ok ${request.params.name}` }] };
        });
        void stub.connect(serverTransport);
        return clientTransport;
      },
    });
    try {
      await h.store.upsertExtensionCredential({
        provider: DISCOVER_ID,
        identityKey: "email:org@example.com",
        owner: null,
        scope: "org",
        brokerCredentialId: 7,
      });

      // The ACP agent sees the FULL discovered surface (namespaced names),
      // never an empty toolset.
      const listed = await h.client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("discover.me.search_issues");
      expect(names).toContain("discover.me.delete_issue");

      // A call by the namespaced name resolves the owner across the
      // discovered surface and executes through the runtime with the WIRE
      // name (providerName).
      const res = (await h.client.callTool({
        name: "discover.me.search_issues",
        arguments: { query: "repo:x" },
      })) as ToolCallResult;
      expect(res.isError).not.toBe(true);
      expect(res.content[0]?.text ?? "").toBe("ok search_issues");
      expect(seen.tool).toEqual(["search_issues"]);
      expect(h.boundary.calls).toHaveLength(1);
      expect(h.boundary.calls[0]!.provider).toBe(DISCOVER_ID);
    } finally {
      await h.cleanup();
    }
  });

  test("calls a fixture extension tool through the runtime: gate → ladder → boundary → audit", async () => {
    const h = await makeInProcessHarness();
    try {
      await h.store.upsertExtensionCredential({
        provider: FIXTURE_EXTENSION_ID,
        identityKey: "email:org@example.com",
        owner: null,
        scope: "org",
        brokerCredentialId: 7,
      });

      const res = (await h.client.callTool({
        name: FIXTURE_EXTENSION_TOOL,
        arguments: { city: "Lisbon" },
      })) as ToolCallResult;
      expect(res.isError).not.toBe(true);
      expect(res.content[0]?.text ?? "").toBe("sunny in Lisbon");

      // Egress boundary received the resolved org credential (metadata only).
      expect(h.boundary.calls).toHaveLength(1);
      expect(h.boundary.calls[0]!.scope).toBe("org");
      expect(h.boundary.calls[0]!.identity_key).toBe("email:org@example.com");

      // Audit trail: policy decision (manifest tier) + ladder resolution + call.
      const decisions = await auditRows(h.store, POLICY_DECISION_EVENT);
      expect(payload(decisions[0]!).tool).toBe(FIXTURE_EXTENSION_TOOL);
      expect(payload(decisions[0]!).decision).toBe("allow");
      expect(payload(decisions[0]!).tier).toBe("read");
      const resolutions = await auditRows(h.store, EXTENSION_CREDENTIAL_RESOLVED_EVENT);
      expect(resolutions).toHaveLength(1);
      const calls = await auditRows(h.store, EXTENSION_CALL_EVENT);
      expect(calls).toHaveLength(1);
      expect(payload(calls[0]!).decision).toBe("allow");
      expect(payload(calls[0]!).credential_id).toBe(h.boundary.calls[0]!.id);
      expect(payload(calls[0]!).actor).toBe("U123");
    } finally {
      await h.cleanup();
    }
  });

  test("a policy-denied extension tool fails closed before the ladder", async () => {
    const h = await makeInProcessHarness({
      policy: parseOrgConfigYaml(
        "extensions:\n  deny:\n    - fixture.weather\n" + "tools:\n  unknown: allow\n  connect_extension: allow\n",
      ),
    });
    try {
      await h.store.upsertExtensionCredential({
        provider: FIXTURE_EXTENSION_ID,
        identityKey: "email:org@example.com",
        owner: null,
        scope: "org",
        brokerCredentialId: 7,
      });

      const res = (await h.client.callTool({
        name: FIXTURE_EXTENSION_TOOL,
        arguments: { city: "Lisbon" },
      })) as ToolCallResult;
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text ?? "").toContain("denied by this space's policy");

      expect(h.boundary.calls).toHaveLength(0);
      const decisions = await auditRows(h.store, POLICY_DECISION_EVENT);
      expect(payload(decisions[0]!).decision).toBe("deny");
      const calls = await auditRows(h.store, EXTENSION_CALL_EVENT);
      expect(calls).toHaveLength(1);
      expect(payload(calls[0]!).decision).toBe("deny");
      expect(payload(calls[0]!).credential_id).toBeNull();
      expect(await auditRows(h.store, EXTENSION_CREDENTIAL_RESOLVED_EVENT)).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test("connect_extension personal connects for the session principal and audits", async () => {
    const h = await makeInProcessHarness();
    try {
      const res = (await h.client.callTool({
        name: "connect_extension",
        arguments: { extension: FIXTURE_EXTENSION_ID, scope: "personal" },
      })) as ToolCallResult;
      expect(res.isError).not.toBe(true);
      expect(res.content[0]?.text ?? "").toBe("Fixture Weather connected as @U123");

      expect(h.brokerCalls).toEqual([{ provider: FIXTURE_EXTENSION_ID, credentialType: "api_key" }]);
      const rows = await h.store.listExtensionCredentials(FIXTURE_EXTENSION_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.scope).toBe("personal");
      expect(rows[0]!.owner).toBe("U123");

      const connected = await auditRows(h.store, EXTENSION_CONNECTED_EVENT);
      expect(connected).toHaveLength(1);
      expect(connected[0]!.space_id).toBe("slack:C1");
      expect(payload(connected[0]!)).toMatchObject({
        extension: FIXTURE_EXTENSION_ID,
        scope: "personal",
        owner: "U123",
      });
      // Personal connects are unprivileged: no policy decision row.
      expect(await auditRows(h.store, POLICY_DECISION_EVENT)).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test("connect_extension org fails closed without an approval channel", async () => {
    const h = await makeInProcessHarness();
    try {
      const res = (await h.client.callTool({
        name: "connect_extension",
        arguments: { extension: FIXTURE_EXTENSION_ID, scope: "org" },
      })) as ToolCallResult;
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text ?? "").toContain("policy: approval denied");

      // The broker is never reached and no credential row is written.
      expect(h.brokerCalls).toHaveLength(0);
      expect(await h.store.listExtensionCredentials(FIXTURE_EXTENSION_ID)).toHaveLength(0);

      const decisions = await auditRows(h.store, POLICY_DECISION_EVENT);
      expect(payload(decisions[0]!).tool).toBe("connect_extension");
      expect(payload(decisions[0]!).decision).toBe("ask-human");
      expect(payload(decisions[0]!).tier).toBe("exec");
      expect(await auditRows(h.store, APPROVAL_REQUESTED_EVENT)).toHaveLength(1);
      const resolved = await auditRows(h.store, APPROVAL_RESOLVED_EVENT);
      expect(resolved).toHaveLength(1);
      expect(payload(resolved[0]!).approved).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  test("connect_extension with an unknown extension is a tool error", async () => {
    const h = await makeInProcessHarness();
    try {
      const res = (await h.client.callTool({
        name: "connect_extension",
        arguments: { extension: "nope.xyz", scope: "personal" },
      })) as ToolCallResult;
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text ?? "").toContain("unknown extension");
      expect(h.brokerCalls).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test("invalid connect_extension arguments are protocol errors", async () => {
    const h = await makeInProcessHarness();
    try {
      await expect(
        h.client.callTool({ name: "connect_extension", arguments: { extension: FIXTURE_EXTENSION_ID } }),
      ).rejects.toThrow(/scope/);
      await expect(
        h.client.callTool({ name: "connect_extension", arguments: { scope: "personal" } }),
      ).rejects.toThrow(/extension/);
      await expect(
        h.client.callTool({ name: "connect_extension", arguments: { extension: 7, scope: "personal" } }),
      ).rejects.toThrow(/extension/);
    } finally {
      await h.cleanup();
    }
  });

});

describe("MCP server policy + audit enforcement", () => {
  test("policy-denied call fails as an MCP error with no execution", async () => {
    const h = await launch({ configYaml: "tools:\n  memory.save: deny\n  memory.search: allow\n" });
    try {
      await expect(
        h.client.callTool({ name: "memory.save", arguments: { scope: "org", content: "blocked" } }),
      ).rejects.toThrow(/policy/);
      expect(await auditRows(h.store, "memory.write")).toHaveLength(0);
      // The denial itself is audited as a policy decision.
      const decisions = await auditRows(h.store, "policy.decision");
      expect(decisions).toHaveLength(1);
      expect(payload(decisions[0]!).decision).toBe("deny");
      expect(payload(decisions[0]!).tool).toBe("memory.save");
    } finally {
      await h.cleanup();
    }
  });

  test("ask-human policy fails closed in the headless MCP context", async () => {
    const h = await launch({ configYaml: "tools:\n  memory.save: prompt\n  memory.search: allow\n" });
    try {
      await expect(
        h.client.callTool({ name: "memory.save", arguments: { scope: "org", content: "needs approval" } }),
      ).rejects.toThrow(/policy/);
      expect(await auditRows(h.store, "memory.write")).toHaveLength(0);
      const decisions = await auditRows(h.store, "policy.decision");
      expect(payload(decisions[0]!).decision).toBe("ask-human");
    } finally {
      await h.cleanup();
    }
  });

  test("space overlay tightens the org floor for the session's space", async () => {
    // Org floor allows; the space overlay denies — the server must apply the
    // overlay because BOTTEGA_SPACE_ID pins the session to that space.
    const h = await launch({
      configYaml: ALLOW_ALL,
      policyJson: JSON.stringify({ tools: { "memory.save": "deny" } }),
    });
    try {
      await expect(
        h.client.callTool({ name: "memory.save", arguments: { scope: "org", content: "tightened" } }),
      ).rejects.toThrow(/policy/);
      expect(await auditRows(h.store, "memory.write")).toHaveLength(0);
      // Audit rows for the session's space carry the space id.
      const decisions = await auditRows(h.store, "policy.decision");
      expect(decisions[0]!.space_id).toBe(h.spaceId!);
      expect(payload(decisions[0]!).decision).toBe("deny");

      // search stays allowed by both org and overlay.
      const res = await h.client.callTool({ name: "memory.search", arguments: { scope: "org", query: "nothing" } });
      expect(res.isError).not.toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});
