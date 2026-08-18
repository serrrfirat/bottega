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
import { z } from "zod";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createStore, type AuditRow, type Store, type ExtensionCredential } from "../store/db";
import { sha256Hex } from "../tools/memory";
import { createSqliteMemoryProvider } from "../memory/sqlite";
import { type JsonValue } from "../memory/mem0";
import type { JsonObject } from "../extensions/manifest";
import type { MemoryProvider } from "../memory/types";
import { createAudit, type AuditModule } from "../policy/audit";
import { DenyRouter } from "../policy/approval-router";
import { parseOrgConfigYaml, type PolicyConfig } from "../policy/config";
import { buildRegistry } from "../scheduler/actions";
import { createIngestPollAction } from "../ingest/poll-action";
import { orgPulseAction } from "../scheduler/observer";
import { recurringWorkAction } from "../scheduler/recurring-work";
import { sendMessageAction } from "../scheduler/send-message";
import { reflectionAction } from "../scheduler/reflection";
import { standupDigestAction } from "../scheduler/standup";
import { schedulerToolDefinitions } from "../scheduler/scheduler-tools";
import { kbToolDefinitions } from "../tools/kb-tools";
import { modelToolsDefinitions } from "../tools/model-settings";
import { workItemToolDefinitions } from "../tools/work-items";
import {
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_RESOLVED_EVENT,
  EXTENSION_CALL_EVENT,
  EXTENSION_CONNECTED_EVENT,
  EXTENSION_CREDENTIAL_RESOLVED_EVENT,
  POLICY_DECISION_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from "../store/audit-events";
import type { CredentialBoundary } from "../extensions/boundary";
import type { BrokerConnector } from "../extensions/connect";
import { UploadLinkStore } from "../extensions/upload-link";
import { createFixtureRegistry, fixtureManifest, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL } from "../extensions/fixture";
import { validateManifest, type ExtensionManifest, type McpBinding } from "../extensions/manifest";
import { createExtensionRegistry, type ExtensionRegistry } from "../extensions/registry";
import { createExtensionRuntime } from "../extensions/runtime";
import { resetToolSurfaceCache } from "../extensions/surface";
import { createMemoryMcpServer, type McpInternalToolsOptions } from "./server";

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

  const env: Record<string, string> = {};
  env.BOTTEGA_DB_PATH = dbPath;
  env.BOTTEGA_CONFIG_DIR = configDir;
  env.BOTTEGA_SESSION_DIR = sessionsDir;
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

function payload(row: AuditRow): Record<string, JsonValue> {
  // SAFETY: audit payloads are written via JSON.stringify, so the parsed value is a JSON object.
  return JSON.parse(row.payload) as Record<string, JsonValue>;
}

/** The SDK's callTool return type is index-signature-heavy; narrow it here. */
interface ToolCallResult {
  content: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/** callTool wrapper: narrows the SDK's index-signature-heavy result to the surface these tests assert on. */
async function callTool(client: Client, name: string, args: Record<string, JsonValue>): Promise<ToolCallResult> {
  // SAFETY: a callTool result is a JSON message whose content blocks carry text/type and an optional isError flag.
  return (await client.callTool({ name, arguments: args })) as ToolCallResult;
}

/** Org floor allowing the built-in memory and transcript-search tools. */
const ALLOW_ALL = "tools:\n  memory.save: allow\n  memory.search: allow\n  session_search: allow\n";
  interface InProcessHarness {
    client: Client;
    store: Store;
    boundary: CredentialBoundary & { calls: ExtensionCredential[] };
    brokerCalls: Array<{ provider: string; credentialType: string; apiKey?: string }>;
    /** The org floor policy the server gates against (the internal surface's orgPolicy too). */
    policy: PolicyConfig;
    /** The audit module wired into the server. */
    audit: AuditModule;
    /** The memory provider wired into the server (memory + KB tools). */
    provider: MemoryProvider;
    /** The wired internal surface options (issue #206); undefined when internal is disabled. */
    internal?: McpInternalToolsOptions;
    cleanup: () => Promise<void>;
  }

  /** In-process server with injected runtime deps (real store + audit, fake boundary/broker/transport). */
  async function makeInProcessHarness(opts: {
    policy?: PolicyConfig;
    defaultPrincipal?: string;
    registry?: ExtensionRegistry;
    mcpTransport?: (binding: McpBinding) => Transport;
    /** Issue #196: wire the one-time upload-link mint (shared store + fake base URL). */
    uploadLink?: boolean;
    /** Issue #210: the wired mint's base URL (default the loopback fixture). */
    uploadLinkBaseUrl?: string;
    /**
     * Issue #206: wire the internal tool surface (work items, model
     * settings, scheduler, KB). Default true — the production surface.
     */
    internal?: boolean;
    /** Internal-surface overrides (issue #206 tests): the catalog seam / KB config. */
    internalOptions?: Partial<Pick<McpInternalToolsOptions, "agentDir" | "listModels" | "kb" | "schedulerRegistry">>;
  } = {}): Promise<InProcessHarness> {
    const dir = mkdtempSync(join(tmpdir(), "bottega-mcp-inproc-"));
    const store = createStore(join(dir, "test.db"));
    const audit = createAudit(store);
    const registry = opts.registry ?? createFixtureRegistry();
    const policy = opts.policy ?? parseOrgConfigYaml(EXT_ALLOW);
    const provider = createSqliteMemoryProvider(store.getDb());
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
          const args = z.record(z.string(), z.json()).parse(request.params.arguments ?? {});
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
    const internalOptions: McpInternalToolsOptions | undefined =
      opts.internal === false
        ? undefined
        : {
            store,
            orgPolicy: policy,
            // The same actions the server boot registers (issue
            // #86/#57/#220) — create_scheduler_job validates against them.
            schedulerRegistry: buildRegistry([
              standupDigestAction,
              reflectionAction,
              orgPulseAction,
              recurringWorkAction,
              sendMessageAction,
              createIngestPollAction(),
            ]),
            // Hermetic KB config: no sources, no egress — kb_ingest lists
            // nothing and unknown sources fail as tool outcomes.
            kb: { sources: [] },
            // Hermetic catalog seam: never touches the repo's agent dir.
            listModels: async () => [],
            ...opts.internalOptions,
          };
    const server = createMemoryMcpServer({
      provider,
      policy,
      audit,
      spaceId: "slack:C1",
      defaultPrincipal: opts.defaultPrincipal ?? "U123",
      sessionSearch: { db: store.getDb(), transcriptDir: join(dir, "sessions") },
      ...(internalOptions !== undefined ? { internal: internalOptions } : undefined),
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
        ...(opts.uploadLink
          ? {
              uploadLink: {
                store: new UploadLinkStore(store),
                baseUrl: () => opts.uploadLinkBaseUrl ?? "http://127.0.0.1:9999",
                // Issue #211: the harness mints hermetically — the public
                // base is the injected URL, never a live probe of the
                // ambient BOTTEGA_OAUTH_CALLBACK_BASE_URL.
                resolvePublicBase: async () =>
                  opts.uploadLinkBaseUrl === undefined
                    ? { base: undefined, warning: undefined }
                    : { base: opts.uploadLinkBaseUrl, warning: undefined },
              },
            }
          : undefined),
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
      policy,
      audit,
      provider,
      internal: internalOptions,
      cleanup: async () => {
        await client.close();
        await server.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
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

describe("MCP server conformance (spawned entrypoint)", () => {
  test("initialize + tools/list returns the capability tools (memory + connect + internal) with schemas", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    try {
      const { tools } = await h.client.listTools();
      // Issue #206: the internal tools ride the same surface (kb_ingest is
      // absent — the spawned harness has no config/kb.yml, so the boot
      // fails it closed).
      expect(tools.map((t) => t.name).sort()).toEqual([
        "complete_work_item",
        "connect_extension",
        "create_scheduler_job",
        "create_work_item",
        "delete_scheduler_job",
        "list_scheduler_jobs",
        "memory.save",
        "memory.search",
        "model_settings",
        "session_search",
        "work_item_cancel",
      ]);

      const connect = tools.find((t) => t.name === "connect_extension")!;
      expect((connect.description ?? "").length).toBeGreaterThan(0);
      // SAFETY: connect_extension's zod schema advertises each parameter as a JSON-schema object with optional type/enum.
      const connectProps = connect.inputSchema.properties as Record<string, { type?: string; enum?: string[] }>;
      expect(Object.keys(connectProps).sort()).toEqual(["api_key", "extension", "scope"]);
      expect(connectProps.scope?.enum).toEqual(["org", "personal"]);
      expect(connectProps.extension?.type).toBe("string");
      expect(connect.inputSchema.required).toContain("extension");
      expect(connect.inputSchema.required).toContain("scope");

      const save = tools.find((t) => t.name === "memory.save")!;
      expect((save.description ?? "").length).toBeGreaterThan(0);
      // SAFETY: memory.save's zod schema advertises each parameter as a JSON-schema object with optional type/enum.
      const saveProps = save.inputSchema.properties as Record<string, { type?: string; enum?: string[] }>;
      expect(Object.keys(saveProps).sort()).toEqual(["content", "metadata", "principal", "scope"]);
      expect(saveProps.scope?.enum).toEqual(["org", "user"]);
      expect(saveProps.content?.type).toBe("string");
      expect(save.inputSchema.required).toContain("content");
      expect(save.inputSchema.required).toContain("scope");

      const search = tools.find((t) => t.name === "memory.search")!;
      // SAFETY: memory.search's zod schema advertises each parameter as a JSON-schema object with optional type.
      const searchProps = search.inputSchema.properties as Record<string, { type?: string }>;
      expect(Object.keys(searchProps).sort()).toEqual(["limit", "principal", "query", "scope"]);
      expect(searchProps.query?.type).toBe("string");
      expect(search.inputSchema.required).toContain("query");
      expect(search.inputSchema.required).toContain("scope");

      const sessionSearch = tools.find((t) => t.name === "session_search")!;
      // SAFETY: session_search's zod schema advertises each parameter as a JSON-schema object with optional type.
      const sessionSearchProps = sessionSearch.inputSchema.properties as Record<string, { type?: string }>;
      expect(Object.keys(sessionSearchProps).sort()).toEqual(["limit", "query", "space"]);
      expect(sessionSearchProps.query?.type).toBe("string");
      expect(sessionSearch.inputSchema.required).toEqual(["query"]);

      // Issue #206: the internal tools advertise the SESSION definitions'
      // schemas (one source of truth) — create_work_item carries its full
      // parameter shape, not a stub.
      const createWorkItem = tools.find((t) => t.name === "create_work_item")!;
      expect((createWorkItem.description ?? "").length).toBeGreaterThan(0);
      // SAFETY: create_work_item's omptype zod schema emits properties as JSON-schema objects with optional type/enum.
      const createProps = createWorkItem.inputSchema.properties as Record<string, { type?: string; enum?: string[] }>;
      expect(Object.keys(createProps).sort()).toEqual(["delivery", "description", "model", "reasoning_effort", "repo", "requester"]);
      expect(createProps.description?.type).toBe("string");
      expect(createProps.delivery?.enum).toEqual(["git", "extension", "chat"]);
      expect(createWorkItem.inputSchema.required).toEqual(["description"]);
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
      const result = await callTool(h.client, "session_search", { query: "release", space: "slack:C9" });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0]!.text!)).toEqual([
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
      const res = await callTool(h.client, "memory.save", {
        scope: "org",
        content: "the vault combination is 1234",
        metadata: { topic: "vault" },
      });
      expect(res.isError).not.toBe(true);
      const text = res.content[0]!.text!;
      const { id } = JSON.parse(text);
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

      const org = await callTool(h.client, "memory.search", { scope: "org", query: "alpha" });
      // SAFETY: memory.search results are MemoryEntry-shaped; the assertion reads only the scope field.
      const orgEntries = JSON.parse(org.content[0]!.text!) as Array<{ scope: string }>;
      expect(orgEntries.map((e) => e.scope)).toEqual(["org"]);

      const mine = await callTool(h.client, "memory.search", {
        scope: "user",
        query: "alpha",
        principal: "U1",
      });
      // SAFETY: memory.search results are MemoryEntry-shaped; the assertion reads only the principal field.
      const mineEntries = JSON.parse(mine.content[0]!.text!) as Array<{ principal: string | null }>;
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
        "complete_work_item",
        "connect_extension",
        "create_scheduler_job",
        "create_work_item",
        "delete_scheduler_job",
        "list_scheduler_jobs",
        "memory.save",
        "memory.search",
        "model_settings",
        "session_search",
        FIXTURE_EXTENSION_TOOL,
        "work_item_cancel",
      ]);

      const weather = tools.find((t) => t.name === FIXTURE_EXTENSION_TOOL)!;
      expect((weather.description ?? "").length).toBeGreaterThan(0);
      // SAFETY: the fixture manifest's tool zod schema advertises each parameter as a JSON-schema object with optional type.
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
      const res = await callTool(h.client, FIXTURE_EXTENSION_TOOL, { city: "Lisbon" });
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
      const res = await callTool(h.client, FIXTURE_EXTENSION_TOOL, { city: "Lisbon" });
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


  test("a tools-less manifest is advertised + callable on the MCP surface via discovery (issue #158)", async () => {
    const DISCOVER_ID = "discover.me";
    // The discovery cache is process-global — reset so this hermetic test
    // never observes a stale surface from another file's fixture.
    resetToolSurfaceCache();
    const wireTools = [
      { name: "search_issues", description: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "delete_issue", description: "Delete", inputSchema: { type: "object", properties: {} } },
    ];
    // SAFETY: the wire-tool names recorded by the stub calls are strings.
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
      const res = await callTool(h.client, "discover.me.search_issues", { query: "repo:x" });
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

      const res = await callTool(h.client, FIXTURE_EXTENSION_TOOL, { city: "Lisbon" });
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

      const res = await callTool(h.client, FIXTURE_EXTENSION_TOOL, { city: "Lisbon" });
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
      const res = await callTool(h.client, "connect_extension", { extension: FIXTURE_EXTENSION_ID, scope: "personal" });
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
      const res = await callTool(h.client, "connect_extension", { extension: FIXTURE_EXTENSION_ID, scope: "org" });
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
      const res = await callTool(h.client, "connect_extension", { extension: "nope.xyz", scope: "personal" });
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

  test("connect_upload_link is advertised + callable when the endpoint is wired (issue #196)", async () => {
    const h = await makeInProcessHarness({ uploadLink: true });
    try {
      const { tools } = await h.client.listTools();
      expect(tools.map((t) => t.name)).toContain("connect_upload_link");

      const res = await callTool(h.client, "connect_upload_link", { extension: FIXTURE_EXTENSION_ID, scope: "personal" });
      expect(res.isError).toBeUndefined();
      // Issue #210: the result carries the URL verbatim on its own line.
      const url = (res.content[0]?.text ?? "").split("\n")[0]!;
      expect(url.startsWith("http://127.0.0.1:9999/upload/")).toBe(true);

      // The minted token is real: the SHARED store (the endpoint's) consumes it.
      const token = url.slice("http://127.0.0.1:9999/upload/".length);
      const consumed = h.store.consumeUploadToken(token);
      expect(consumed.ok).toBe(true);
      if (consumed.ok) expect(consumed.row.actor).toBe("U123");

      // Bad args are protocol errors, not silent runs.
      await expect(
        h.client.callTool({ name: "connect_upload_link", arguments: { scope: "personal" } }),
      ).rejects.toThrow(/extension/);
    } finally {
      await h.cleanup();
    }
  });

  test("connect_upload_link anchors its reply to the minted public URL (issue #210)", async () => {
    const h = await makeInProcessHarness({ uploadLink: true, uploadLinkBaseUrl: "https://upload.example.com" });
    try {
      const res = await callTool(h.client, "connect_upload_link", { extension: FIXTURE_EXTENSION_ID, scope: "personal" });
      expect(res.isError).toBeUndefined();
      const text = res.content[0]?.text ?? "";
      // The minted URL is anchored verbatim (first line) with the same
      // relay contract as the session tool…
      const url = text.split("\n")[0]!;
      expect(url.startsWith("https://upload.example.com/upload/")).toBe(true);
      expect(text).toContain("exactly as written");
      // …and no loopback base can leak into the reply.
      expect(text).not.toMatch(/127\.0\.0\.1|localhost/);

      // The minted token is real: the SHARED store consumes it.
      const token = url.slice("https://upload.example.com/upload/".length);
      const consumed = h.store.consumeUploadToken(token);
      expect(consumed.ok).toBe(true);
      if (consumed.ok) expect(consumed.row.actor).toBe("U123");
    } finally {
      await h.cleanup();
    }
  });

  test("connect_upload_link is absent when the endpoint is not wired", async () => {
    const h = await makeInProcessHarness();
    try {
      const { tools } = await h.client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("connect_upload_link");
    } finally {
      await h.cleanup();
    }
  });

  // Issue #206: the internal tools on the in-process surface — advertised
  // with the session definitions' schemas, policy-gated, audited.
  /** The SDK's advertised inputSchema shape (type: "object" + properties/required). */
  type AdvertisedInputSchema = {
    [key: string]: JsonValue | undefined;
    type: "object";
    properties?: Record<string, JsonObject>;
    required?: string[];
  };

  /** Wire JSON Schema of an SDK definition's parameters (omptype zod → JSON Schema). */
  function definitionJsonSchema(definition: ToolDefinition): AdvertisedInputSchema {
    // SAFETY: every internal tool definition is authored with the SDK's zod
    // surface (omptype); the ToolDefinition contract only promises the
    // wider TSchema, so toJsonSchema is narrowed here (same as the server).
    const parameters = definition.parameters as { toJsonSchema(): Record<string, JsonValue> };
    // SAFETY: every internal definition's parameters are a z.object, so the
    // wire document carries the SDK's advertised object shape.
    return parameters.toJsonSchema() as AdvertisedInputSchema;
  }

  test("the MCP internal tools match the session tool definitions (one source of truth)", async () => {
    const h = await makeInProcessHarness();
    try {
      const { tools } = await h.client.listTools();
      const internal = h.internal!;
      // The SAME definitions the SDK session toolset carries
      // (src/server/index.ts), built from the SAME inputs the server wired.
      const sessionDefinitions = [
        ...workItemToolDefinitions(h.store, {
          orgPolicy: internal.orgPolicy,
          agentDir: internal.agentDir,
          listModels: internal.listModels,
        }),
        ...modelToolsDefinitions(h.store, {
          audit: h.audit,
          agentDir: internal.agentDir,
          listModels: internal.listModels,
        }),
        ...schedulerToolDefinitions(h.store, h.audit, internal.schedulerRegistry!),
        ...kbToolDefinitions({ store: h.store, config: internal.kb! }),
      ].filter((definition) => definition.name !== "use_model");

      const advertisedByName: Record<string, (typeof tools)[number]> = Object.fromEntries(
        tools.map((tool) => [tool.name, tool]),
      );
      for (const definition of sessionDefinitions) {
        const advertised = advertisedByName[definition.name];
        expect(advertised, `internal tool ${definition.name} is advertised`).toBeDefined();
        expect(advertised!.description).toBe(definition.description);
        // The advertised schema IS the definition's parameters — no
        // hand-written mirror to drift.
        expect(advertised!.inputSchema).toEqual(definitionJsonSchema(definition));
      }
      // use_model stays SDK-session-only: ACP sessions cannot switch models
      // mid-session (the agent's own config governs there, issue #64).
      expect(advertisedByName["use_model"]).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });

  test("an allowed internal tool executes server-side and audits its policy decision", async () => {
    // create_work_item is exec-tier: it auto-approves ONLY when listed
    // under approvals.always_approve (issue #45) — the "list the tool
    // before it can auto-approve" rule; otherwise ask-human fails closed
    // in this headless context.
    const h = await makeInProcessHarness({
      policy: parseOrgConfigYaml(
        "approvals:\n  always_approve:\n    - create_work_item\n" + "tools:\n  unknown: allow\n",
      ),
    });
    try {
      // The call crosses the gate (auto-approved exec tier) and runs the
      // REAL definition: the item lands in the store under the pinned
      // session space (created lazily).
      const res = await callTool(h.client, "create_work_item", { description: "handle the deploy" });
      expect(res.isError).not.toBe(true);
      // SAFETY: the internal tool's result content is the SDK's JSON string
      // with the work item's id and state (asserted below).
      const { id, state } = JSON.parse(res.content[0]!.text!) as { id: string; state: string };
      expect(id).toMatch(/^wi_/);
      expect(state).toBe("open");

      const item = await h.store.getWorkItem(id);
      expect(item).not.toBeNull();
      expect(item!.space_id).toBe("slack:C1");
      expect(item!.requester).toBe("agent");

      // The call was audited like the built-in tools: the policy decision
      // (auto-approved, exec tier) + the definition's work_item.created row.
      const decisions = await auditRows(h.store, POLICY_DECISION_EVENT);
      const createDecision = decisions.find((row) => payload(row).tool === "create_work_item")!;
      expect(payload(createDecision).decision).toBe("allow");
      expect(payload(createDecision).tier).toBe("exec");
      expect(payload(createDecision).reason).toContain("always_approve");
      expect(createDecision.space_id).toBe("slack:C1");
      expect(await auditRows(h.store, WORK_ITEM_CREATED_EVENT)).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  test("model_settings, scheduler, and KB tools run through the same gate on the MCP surface", async () => {
    const h = await makeInProcessHarness();
    try {
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });

      // model_settings read (write-tier by tool name; allowed via unknown:
      // allow) returns the space settings + the hermetic catalog.
      const settings = await callTool(h.client, "model_settings", {});
      expect(settings.isError).not.toBe(true);
      expect(JSON.parse(settings.content[0]!.text!)).toMatchObject({ available_models: [] });

      // model_settings write persists + audits model.settings_changed.
      const wrote = await callTool(h.client, "model_settings", { set: { model: "deepseek-v4-flash" } });
      expect(wrote.isError).not.toBe(true);
      expect(JSON.parse(wrote.content[0]!.text!)).toMatchObject({ model: "deepseek-v4-flash" });
      expect(await auditRows(h.store, "model.settings_changed")).toHaveLength(1);

      // Scheduler list (read tier) runs the real store query.
      const jobs = await callTool(h.client, "list_scheduler_jobs", {});
      expect(jobs.isError).not.toBe(true);
      expect(JSON.parse(jobs.content[0]!.text!)).toEqual([]);

      // KB ingest with an unknown source is a TOOL OUTCOME (the call ran
      // through the gate; the definition reported the error).
      const kb = await callTool(h.client, "kb_ingest", { source: "missing" });
      expect(kb.isError).toBe(true);
      expect(kb.content[0]?.text ?? "").toContain("unknown KB source");

      // Every call audited its policy decision.
      const decisions = await auditRows(h.store, POLICY_DECISION_EVENT);
      expect(decisions.map((row) => payload(row).tool).sort()).toEqual([
        "kb_ingest",
        "list_scheduler_jobs",
        "model_settings",
        "model_settings",
      ]);
    } finally {
      await h.cleanup();
    }
  });

  test("an unlisted internal tool is denied by the policy gate with no execution (fail closed)", async () => {
    // Only memory.search is allowed; create_work_item is not listed → deny.
    const h = await makeInProcessHarness({ policy: parseOrgConfigYaml("tools:\n  memory.search: allow\n") });
    try {
      await expect(
        h.client.callTool({ name: "create_work_item", arguments: { description: "blocked" } }),
      ).rejects.toThrow(/policy/);

      // The tool never executed: no work item, no work_item.created audit.
      expect(await auditRows(h.store, WORK_ITEM_CREATED_EVENT)).toHaveLength(0);
      const decisions = await auditRows(h.store, POLICY_DECISION_EVENT);
      expect(decisions).toHaveLength(1);
      expect(payload(decisions[0]!).tool).toBe("create_work_item");
      expect(payload(decisions[0]!).decision).toBe("deny");
      expect(payload(decisions[0]!).tier).toBe("exec");
      expect(decisions[0]!.space_id).toBe("slack:C1");
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
