/**
 * MCP surface tests (issue #25): conformance of the spawned bottega MCP
 * server against a real MCP client (the official SDK), and enforcement of
 * the policy gate + audit at execution time.
 *
 * Every test spawns the real entrypoint (`src/mcp/server.ts`) as a child
 * process with a temp DB + temp config dir, and drives it with the official
 * MCP TypeScript client over the stdio transport — the same transport an
 * agent's MCP client uses to reach a stdio MCP server. No ports, no global
 * state; each test cleans up its process, DB, and temp dir.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { nextCronFire } from "../scheduler/cron";
import { tickScheduler } from "../scheduler/runner";
import { kbToolDefinitions } from "../tools/kb-tools";
import { modelToolsDefinitions } from "../tools/model-settings";
import { workItemToolDefinitions } from "../tools/work-items";
import { spaceSkillToolDefinitions } from "../tools/space-skills";
import {
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_RESOLVED_EVENT,
  EXTENSION_CALL_EVENT,
  EXTENSION_CONNECTED_EVENT,
  EXTENSION_CREDENTIAL_RESOLVED_EVENT,
  POLICY_DECISION_EVENT,
  SCHEDULER_FIRE_EVENT,
  SCHEDULER_JOB_PAUSED_EVENT,
  SCHEDULER_JOB_RESUMED_EVENT,
  SCHEDULER_JOB_UPDATED_EVENT,
  SCHEDULER_RUN_REQUESTED_EVENT,
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
import { bootMemoryMcpServer, createMemoryMcpServer, type McpInternalToolsOptions } from "./server";
import { resolveWorkItemSkills } from "../server/skills";

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
  env.BOTTEGA_SKILLS_DIR = join(dir, "skills");
  env.BOTTEGA_BUILTIN_SKILLS_DIR = join(dir, "builtin-skills");
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

const auditPayloadSchema: z.ZodType<Record<string, JsonValue>> = z.record(z.string(), z.json());

const schedulerJobResultSchema = z
  .object({
    id: z.string(),
    cron: z.string(),
    nextFireAt: z.number(),
    revision: z.number(),
    enabled: z.boolean(),
  })
  .passthrough();

const revisionResultSchema = z.object({ revision: z.string() }).passthrough();
const listedSpaceSkillSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    source_tier: z.string(),
    revision: z.string(),
    companion_files: z.array(z.string()),
    shadows: z.array(z.string()),
  })
  .passthrough();
const spaceSkillResultSchema = z.object({
  skill: z
    .object({
      document: z.string(),
      revision: z.string(),
      description: z.string(),
      companion_files: z.record(
        z.string(),
        z.object({ encoding: z.string(), content: z.string() }),
      ),
    })
    .passthrough(),
  shadowed: z.array(z.object({ source_tier: z.string() }).passthrough()).optional(),
});

function payload(row: AuditRow): Record<string, JsonValue> {
  return auditPayloadSchema.parse(JSON.parse(row.payload));
}

/** The SDK's callTool return type is index-signature-heavy; parse the asserted surface here. */
const toolCallResultSchema = z
  .object({
    content: z.array(
      z
        .object({
          type: z.string().optional(),
          text: z.string().optional(),
        })
        .passthrough(),
    ),
    isError: z.boolean().optional(),
  })
  .passthrough();
type ToolCallResult = z.infer<typeof toolCallResultSchema>;

function toolText(result: ToolCallResult): string {
  const first = result.content[0];
  if (first?.type !== "text" || first.text === undefined) throw new Error("expected text tool result");
  return first.text;
}

function parsedToolText<T>(result: ToolCallResult, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(toolText(result)));
}

/** callTool wrapper: narrows the SDK's index-signature-heavy result to the surface these tests assert on. */
async function callTool(client: Client, name: string, args: Record<string, JsonValue>): Promise<ToolCallResult> {
  return toolCallResultSchema.parse(await client.callTool({ name, arguments: args }));
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
    internalOptions?: Partial<
      Pick<
        McpInternalToolsOptions,
        "agentDir" | "listModels" | "kb" | "schedulerRegistry" | "schedulerNow" | "skillsRoot" | "builtinSkillsDir"
      >
    >;
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
      async runWithAuthorization(request, invoke) {
        calls.push(request.credential);
        return invoke({
          callId: request.callId,
          placeholder: "test-placeholder",
          signal: new AbortController().signal,
        });
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
        "create_space_skill",
        "create_work_item",
        "delete_scheduler_job",
        "delete_space_skill",
        "disconnect_connection",
        "get_space_skill",
        "inspect_connection",
        "list_connections",
        "list_scheduler_jobs",
        "list_space_skills",
        "list_work_items",
        "memory.save",
        "memory.search",
        "model_settings",
        "pause_scheduler_job",
        "replace_connection",
        "resume_scheduler_job",
        "run_scheduler_job_now",
        "session_search",
        "update_scheduler_job",
        "update_space_skill",
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
      const replace = tools.find((t) => t.name === "replace_connection")!;
      expect(Object.keys(replace.inputSchema.properties ?? {}).sort()).toEqual(["connection_id", "expected_revision"]);
      expect(replace.inputSchema.required).toEqual(["connection_id", "expected_revision"]);
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
      // skills (issues #234/#235): the explicit task-level skill pins.
      expect(Object.keys(createProps).sort()).toEqual(["delivery", "description", "model", "reasoning_effort", "repo", "requester", "skills"]);
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

  test("channel-scope save writes to the current channel key; person scope in a channel fails closed", async () => {
    const h = await launch({ configYaml: ALLOW_ALL, policyJson: "{\"response_mode\":\"always\"}" });
    try {
      // The MCP server runs pinned to slack:C1 (a shared channel). A channel
      // save derives the channel:<spaceId> key.
      const ch = await h.client.callTool({
        name: "memory.save",
        arguments: { scope: "channel", content: "our channel deploys on Tuesdays" },
      });
      expect(ch.isError).not.toBe(true);

      const rows = await auditRows(h.store, "memory.write");
      expect(rows).toHaveLength(1);
      expect(payload(rows[0]!).scope).toBe("channel");

      // A person-scope save in a shared channel is NOT writable — fail closed
      // (issue #137: a channel cannot derive person). It saves nothing.
      await expect(
        h.client.callTool({
          name: "memory.save",
          arguments: { scope: "person", content: "someone's private fact" },
        }),
      ).rejects.toThrow(/not writable/);
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

  test("search scopes org + channel; a channel never retrieves a person's fact", async () => {
    const h = await launch({ configYaml: ALLOW_ALL, policyJson: "{\"response_mode\":\"always\"}" });
    try {
      await h.client.callTool({ name: "memory.save", arguments: { scope: "org", content: "alpha org fact" } });
      await h.client.callTool({ name: "memory.save", arguments: { scope: "channel", content: "alpha channel fact" } });
      // Seed a person fact directly (the MCP channel cannot derive a person key).
      h.store
        .getDb()
        .query(
          "INSERT INTO memories (id, scope, principal, content, metadata_json, created_at) VALUES ('p1', 'user', 'U1', 'alpha person fact', '{}', ?)",
        )
        .run(Date.now());

      const all = await callTool(h.client, "memory.search", { scope: "all", query: "alpha" });
      // SAFETY: memory.search results are MemoryEntry-shaped; read the logical key kind.
      const entries = JSON.parse(all.content[0]!.text!) as Array<{ key: { kind: string } }>;
      const kinds = entries.map((e) => e.key.kind).sort();
      // The channel recall derives channel + org — never the person's key.
      expect(kinds).toEqual(["channel", "org"]);
      expect(entries.some((e) => JSON.stringify(e).includes("person fact"))).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  test("defaultPrincipal is the recall actor (org save in a channel session)", async () => {
    const h = await launch({ configYaml: ALLOW_ALL, defaultPrincipal: "U9" });
    try {
      const res = await h.client.callTool({ name: "memory.save", arguments: { scope: "org", content: "likes llamas" } });
      expect(res.isError).not.toBe(true);
      const rows = await auditRows(h.store, "memory.write");
      expect(rows).toHaveLength(1);
      // The MCP session's principal (defaultPrincipal) is the actor.
      expect(rows[0]!.actor).toBe("U9");
      expect(payload(rows[0]!).scope).toBe("org");
    } finally {
      await h.cleanup();
    }
  });
});


describe("MCP scheduler lifecycle caller surface (issues #308, #322)", () => {
  test("drives update, pause, resume, and run-now through the durable runner with fake time", async () => {
    let now = Date.UTC(2026, 7, 21, 12, 34);
    const calls: Array<Record<string, string>> = [];
    const schedulerRegistry = buildRegistry([
      {
        name: "send_message",
        run: async (params) => {
          calls.push(params);
        },
      },
    ]);
    const policy = parseOrgConfigYaml(
      "tools:\n" +
        "  unknown: allow\n" +
        "approvals:\n" +
        "  always_approve:\n" +
        "    - update_scheduler_job\n" +
        "    - pause_scheduler_job\n" +
        "    - resume_scheduler_job\n" +
        "    - run_scheduler_job_now\n",
    );
    const h = await makeInProcessHarness({
      policy,
      internalOptions: { schedulerRegistry, schedulerNow: () => now },
    });
    try {
      const names = (await h.client.listTools()).tools.map(({ name }) => name);
      expect(names).toContain("update_scheduler_job");
      expect(names).toContain("pause_scheduler_job");
      expect(names).toContain("resume_scheduler_job");
      expect(names).toContain("run_scheduler_job_now");

      const created = await h.store.createSchedulerJob({
        action: "send_message",
        cron: "0 * * * *",
        params: { text: "before" },
        spaceId: "slack:C1",
        createdBy: "U1",
      });
      const updatedResult = await callTool(h.client, "update_scheduler_job", {
        id: created.id,
        expected_revision: created.revision,
        cron: "*/15 * * * *",
        params: { text: "after" },
      });
      expect(updatedResult.isError).not.toBe(true);
      const updated = parsedToolText(updatedResult, schedulerJobResultSchema);
      expect(updated.nextFireAt).toBe(nextCronFire(updated.cron, now));

      const stale = await callTool(h.client, "update_scheduler_job", {
        id: created.id,
        expected_revision: created.revision,
        params: { text: "lost" },
      });
      expect(stale.isError).toBe(true);
      expect((await h.store.getSchedulerJob(created.id))?.params).toEqual({ text: "after" });

      const pausedResult = await callTool(h.client, "pause_scheduler_job", {
        id: created.id,
        expected_revision: updated.revision,
      });
      const paused = parsedToolText(pausedResult, schedulerJobResultSchema);
      expect(paused.enabled).toBe(false);

      now += 37 * 60_000;
      const resumedResult = await callTool(h.client, "resume_scheduler_job", {
        id: created.id,
        expected_revision: paused.revision,
      });
      const resumed = parsedToolText(resumedResult, schedulerJobResultSchema);
      expect(resumed.nextFireAt).toBe(nextCronFire(resumed.cron, now));
      const recurringNext = resumed.nextFireAt;

      await expect(
        callTool(h.client, "run_scheduler_job_now", {
          id: created.id,
          expected_revision: resumed.revision,
          invocation_id: "   ",
        }),
      ).rejects.toThrow(/invocation_id/);

      const runArgs = {
        id: created.id,
        expected_revision: resumed.revision,
        invocation_id: "  mcp-manual-1  ",
      };
      await Promise.all([
        callTool(h.client, "run_scheduler_job_now", runArgs),
        callTool(h.client, "run_scheduler_job_now", runArgs),
      ]);
      expect((await h.store.listSchedulerInvocations({ jobId: created.id })).map(({ id }) => id)).toEqual([
        "mcp-manual-1",
      ]);
      await tickScheduler({
        store: h.store,
        audit: h.audit,
        registry: schedulerRegistry,
        memoryProvider: h.provider,
        postMessage: async () => undefined,
        loadPolicy: async () => policy,
        log: () => {},
        now: () => now,
      });
      expect(calls).toEqual([{ text: "after", space: "slack:C1" }]);
      expect((await h.store.getSchedulerJob(created.id))?.nextFireAt).toBe(recurringNext);
      expect(await h.audit.listAudit({ event_type: SCHEDULER_JOB_UPDATED_EVENT })).toHaveLength(1);
      expect(await h.audit.listAudit({ event_type: SCHEDULER_JOB_PAUSED_EVENT })).toHaveLength(1);
      expect(await h.audit.listAudit({ event_type: SCHEDULER_JOB_RESUMED_EVENT })).toHaveLength(1);
      expect(await h.audit.listAudit({ event_type: SCHEDULER_RUN_REQUESTED_EVENT })).toHaveLength(1);
      expect(await h.audit.listAudit({ event_type: SCHEDULER_FIRE_EVENT })).toHaveLength(1);
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
        "create_space_skill",
        "create_work_item",
        "delete_scheduler_job",
        "delete_space_skill",
        "disconnect_connection",
        "get_space_skill",
        "inspect_connection",
        "list_connections",
        "list_scheduler_jobs",
        "list_space_skills",
        "list_work_items",
        "memory.save",
        "memory.search",
        "model_settings",
        "pause_scheduler_job",
        "replace_connection",
        "resume_scheduler_job",
        "run_scheduler_job_now",
        "session_search",
        "update_scheduler_job",
        "update_space_skill",
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
        credentialTargets: [{ host: "discover.me.test", pathPrefix: "/mcp" }],
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

      // The MCP client sees the FULL discovered surface (namespaced names),
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
      const res = await callTool(h.client, "connect_extension", {
        extension: FIXTURE_EXTENSION_ID,
        scope: "personal",
        api_key: "attio-secret-key",
      });
      expect(res.isError).not.toBe(true);
      expect(res.content[0]?.text ?? "").toBe("Fixture Weather connected as @U123");

      expect(h.brokerCalls).toEqual([
        expect.objectContaining({ provider: FIXTURE_EXTENSION_ID, credentialType: "api_key", apiKey: "attio-secret-key" }),
      ]);
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

  test("connect_extension without an api_key for an api_key extension points at connect_upload_link (issue #247)", async () => {
    const h = await makeInProcessHarness();
    try {
      // The chat/MCP surface never carries the key (the paste guard refuses
      // pasted keys), so the no-key connect must surface the upload-link
      // pointer, never the broker's bare "needs its API key" throw.
      const res = await callTool(h.client, "connect_extension", {
        extension: FIXTURE_EXTENSION_ID,
        scope: "personal",
      });
      expect(res.isError).toBe(true);
      const text = res.content[0]?.text ?? "";
      expect(text).toContain("connect_upload_link");
      expect(text).not.toContain("needs its API key");

      // Nothing reached the broker and no credential row was written.
      expect(h.brokerCalls).toHaveLength(0);
      expect(await h.store.listExtensionCredentials(FIXTURE_EXTENSION_ID)).toHaveLength(0);
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
        ...spaceSkillToolDefinitions(h.store, {
          audit: h.audit,
          skillsRoot: internal.skillsRoot,
          builtinSkillsDir: internal.builtinSkillsDir,
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
      // use_model stays SDK-session-only: MCP sessions cannot switch models
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

  test("space-skill lifecycle is complete through the real MCP registry and refreshes only cold sessions", async () => {
    const fsRoot = mkdtempSync(join(tmpdir(), "bottega-mcp-skills-"));
    const skillsRoot = join(fsRoot, "space");
    const builtinSkillsDir = join(fsRoot, "builtin");
    mkdirSync(join(builtinSkillsDir, "review_loop"), { recursive: true });
    writeFileSync(
      join(builtinSkillsDir, "review_loop", "SKILL.md"),
      "---\nname: review_loop\ndescription: Built-in review procedure.\n---\nUse the built-in checklist.\n",
    );
    const h = await makeInProcessHarness({
      policy: parseOrgConfigYaml(
        "tools:\n  unknown: allow\napprovals:\n  always_approve:\n" +
          "    - create_space_skill\n    - update_space_skill\n    - delete_space_skill\n",
      ),
      internalOptions: { skillsRoot, builtinSkillsDir },
    });
    try {
      const created = await callTool(h.client, "create_space_skill", {
        name: "review_loop",
        document:
          "---\nname: review_loop\ndescription: Space review v1.\n---\nTOP SECRET procedure version one.\n",
        companion_files: { "scripts/run.sh": { encoding: "text", content: "echo private-v1" } },
      });
      expect(created.isError).not.toBe(true);
      const createdBody = parsedToolText(created, revisionResultSchema);
      expect(createdBody.revision).toMatch(/^[a-f0-9]{64}$/);

      const listed = await callTool(h.client, "list_space_skills", {});
      expect(parsedToolText(listed, z.array(listedSpaceSkillSchema))).toEqual([
        expect.objectContaining({
          name: "review_loop",
          description: "Space review v1.",
          source_tier: "space",
          revision: createdBody.revision,
          companion_files: ["scripts/run.sh"],
          shadows: ["builtin"],
        }),
      ]);

      const got = await callTool(h.client, "get_space_skill", { name: "review_loop" });
      const gotBody = parsedToolText(got, spaceSkillResultSchema);
      expect(gotBody.skill.document).toContain("Space review v1.");
      expect(gotBody.skill.companion_files["scripts/run.sh"]).toEqual({ encoding: "text", content: "echo private-v1" });
      expect(gotBody.shadowed).toEqual([expect.objectContaining({ source_tier: "builtin" })]);

      const activeSessionSnapshot = await resolveWorkItemSkills("slack:C1", ["review_loop"], {
        root: skillsRoot,
        builtinDir: builtinSkillsDir,
      });
      expect(activeSessionSnapshot[0]?.description).toBe("Space review v1.");

      const updated = await callTool(h.client, "update_space_skill", {
        name: "review_loop",
        expected_revision: createdBody.revision,
        document:
          "---\nname: review_loop\ndescription: Space review v2.\n---\nTOP SECRET procedure version two.\n",
        companion_files: { "scripts/run.sh": { encoding: "text", content: "echo private-v2" } },
      });
      expect(updated.isError).not.toBe(true);
      const updatedBody = parsedToolText(updated, revisionResultSchema);
      expect(updatedBody.revision).not.toBe(createdBody.revision);

      const stale = await callTool(h.client, "update_space_skill", {
        name: "review_loop",
        expected_revision: createdBody.revision,
        document: "---\nname: review_loop\ndescription: stale overwrite\n---\nwrong\n",
        companion_files: {},
      });
      expect(stale.isError).toBe(true);
      const afterStale = await callTool(h.client, "get_space_skill", { name: "review_loop" });
      expect(parsedToolText(afterStale, spaceSkillResultSchema)).toMatchObject({
        skill: { revision: updatedBody.revision, description: "Space review v2." },
      });

      // Existing sessions retain their immutable snapshot; the next cold
      // resolution sees the successful cache-busting update.
      expect(activeSessionSnapshot[0]?.description).toBe("Space review v1.");
      expect(
        (await resolveWorkItemSkills("slack:C1", ["review_loop"], {
          root: skillsRoot,
          builtinDir: builtinSkillsDir,
        }))[0]?.description,
      ).toBe("Space review v2.");

      const deleted = await callTool(h.client, "delete_space_skill", {
        name: "review_loop",
        expected_revision: updatedBody.revision,
      });
      expect(deleted.isError).not.toBe(true);
      const revealed = await callTool(h.client, "get_space_skill", { name: "review_loop" });
      expect(JSON.parse(revealed.content[0]!.text!)).toMatchObject({
        skill: { source_tier: "builtin", description: "Built-in review procedure." },
        shadowed: [],
      });
      expect(
        (await resolveWorkItemSkills("slack:C1", ["review_loop"], {
          root: skillsRoot,
          builtinDir: builtinSkillsDir,
        }))[0]?.source,
      ).toBe("builtin");

      const auditText = (await h.store.listAudit()).map((row) => row.payload).join("\n");
      expect(auditText).not.toContain("TOP SECRET");
      expect(auditText).not.toContain("private-v1");
      expect(auditText).not.toContain("private-v2");
      expect(auditText).toContain("sha256");
    } finally {
      await h.cleanup();
      rmSync(fsRoot, { recursive: true, force: true });
    }
  });

  test("space-skill mutation authorization denies before filesystem execution", async () => {
    const fsRoot = mkdtempSync(join(tmpdir(), "bottega-mcp-skills-deny-"));
    const skillsRoot = join(fsRoot, "space");
    const h = await makeInProcessHarness({
      policy: parseOrgConfigYaml("tools:\n  list_space_skills: allow\n"),
      internalOptions: { skillsRoot, builtinSkillsDir: join(fsRoot, "builtin") },
    });
    try {
      await expect(
        h.client.callTool({
          name: "create_space_skill",
          arguments: {
            name: "blocked",
            document: "---\nname: blocked\ndescription: Blocked.\n---\nMust not land.\n",
          },
        }),
      ).rejects.toThrow(/policy/);
      expect(existsSync(skillsRoot)).toBe(false);
      const decisions = await auditRows(h.store, POLICY_DECISION_EVENT);
      expect(decisions).toHaveLength(1);
      expect(payload(decisions[0]!)).toMatchObject({ tool: "create_space_skill", decision: "deny", tier: "exec" });
    } finally {
      await h.cleanup();
      rmSync(fsRoot, { recursive: true, force: true });
    }
  });

  test("MCP skill schemas reject traversal and caps while the storage boundary rejects symlink roots", async () => {
    const fsRoot = mkdtempSync(join(tmpdir(), "bottega-mcp-skills-boundary-"));
    const outside = join(fsRoot, "outside");
    mkdirSync(outside);
    const skillsRoot = join(fsRoot, "linked-space");
    symlinkSync(outside, skillsRoot, "dir");
    const h = await makeInProcessHarness({
      policy: parseOrgConfigYaml(
        "tools:\n  unknown: allow\napprovals:\n  always_approve:\n    - create_space_skill\n",
      ),
      internalOptions: { skillsRoot, builtinSkillsDir: join(fsRoot, "builtin") },
    });
    try {
      await expect(
        h.client.callTool({
          name: "create_space_skill",
          arguments: {
            name: "bad",
            document: "---\nname: bad\ndescription: Bad.\n---\nNo.\n",
            companion_files: { "../outside": { encoding: "text", content: "escape" } },
          },
        }),
      ).rejects.toThrow(/invalid arguments/);
      await expect(
        h.client.callTool({
          name: "create_space_skill",
          arguments: {
            name: "bad",
            document: "x".repeat(64 * 1024 + 1),
            companion_files: {},
          },
        }),
      ).rejects.toThrow(/invalid arguments/);

      const symlinked = await callTool(h.client, "create_space_skill", {
        name: "safe",
        document: "---\nname: safe\ndescription: Safe.\n---\nNo crossing.\n",
        companion_files: {},
      });
      expect(symlinked.isError).toBe(true);
      expect(symlinked.content[0]?.text ?? "").toContain("symlink");
      expect(existsSync(join(outside, "slack:C1"))).toBe(false);
    } finally {
      await h.cleanup();
      rmSync(fsRoot, { recursive: true, force: true });
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

describe("bootMemoryMcpServer fail-closed (issue #172)", () => {
  test("an unknown pinned space refuses to boot — never an un-pinned session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-mcp-boot-"));
    const savedCwd = process.cwd();
    const saved = {
      configDir: process.env.BOTTEGA_CONFIG_DIR,
      dbPath: process.env.BOTTEGA_DB_PATH,
      spaceId: process.env.BOTTEGA_SPACE_ID,
    };
    try {
      process.chdir(dir);
      // Deployment config the boot reads: a KB config + an empty extensions
      // dir (no snapshots — the space guard throws before any extension is
      // used). The cwd default "data/proxy-secrets" resolves under THIS temp
      // dir, never the live repo's.
      mkdirSync(join(dir, "config", "extensions"), { recursive: true });
      writeFileSync(join(dir, "config", "kb.yml"), "sources:\n");
      delete process.env.BOTTEGA_CONFIG_DIR;
      delete process.env.BOTTEGA_DB_PATH;
      delete process.env.BOTTEGA_SPACE_ID;
      const dbPath = join(dir, "data", "bottega.db");
      await expect(
        bootMemoryMcpServer({
          dbPath,
          configDir: join(dir, "config"),
          extensionsDir: join(dir, "config", "extensions"),
          sessionDir: join(dir, "sessions"),
          spaceId: "slack:DOES-NOT-EXIST",
        }),
      ).rejects.toThrow(/space slack:DOES-NOT-EXIST not found/);
    } finally {
      process.chdir(savedCwd);
      const restore = (value: string | undefined, envName: string) => {
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      };
      restore(saved.configDir, "BOTTEGA_CONFIG_DIR");
      restore(saved.dbPath, "BOTTEGA_DB_PATH");
      restore(saved.spaceId, "BOTTEGA_SPACE_ID");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
