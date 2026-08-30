/**
 * Mnesis backend tests (issue #348).
 *
 * Hermetic: a scripted Bun.serve server emulates the memory-server MCP
 * Streamable HTTP wire contract the adapter targets (`POST /mcp`, JSON-RPC
 * 2.0, `memory_add_learning` / `memory_search`), with the mnesis auth model
 * (x-tenant-id + Bearer credential, permission-filtered tool surface) and the
 * exact structured fields from the live PoC schemas. The shared conformance
 * suite runs against the stub-backed provider — the same suite SQLite and
 * mem0 run, proving interface parity.
 *
 * The integration tier (real memory-server process) is separate and
 * skip-gated by BOTTEGA_RUN_INTEGRATION (see src/memory/mnesis-integration.test.ts).
 */
import type { Server } from "bun";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { MemoryProvider } from "./types";
import { createMnesisMemoryProvider, mnesisSessionId } from "./mnesis";
import { runMemoryConformanceTests } from "./conformance.test";

/** A stored mnesis learning record (wire shape of the memory_add_learning target). */
interface StubLearning {
  id: string;
  session_id: string;
  event_type: string;
  learning: string;
  context: string;
  neurons: string[];
  operation_id: string;
}

/** Captured `memory_add_learning` arguments. */
const addLearningSchema = z.object({
  session_id: z.string().optional(),
  event_type: z.string().optional(),
  learning: z.string().optional(),
  context: z.string().optional(),
  neurons: z.array(z.string()).optional(),
  operation_id: z.string().optional(),
});

/** Captured `memory_search` arguments. */
const searchSchema = z.object({
  query: z.string().optional(),
  session_id: z.string().optional(),
  limit: z.number().optional(),
  filters: z.record(z.string(), z.string()).optional(),
});

/** One JSON-RPC 2.0 request the MCP server receives. */
const jsonRpcRequestSchema = z.object({
  method: z.string(),
  id: z.unknown().optional(),
  params: z.unknown().optional(),
});

/** `tools/call` params: the tool name + its JSON arguments. */
const toolCallParamsSchema = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
});

interface StubOptions {
  /** Expected bearer token; a request without it (or a wrong tenant) → 401. */
  requireToken?: string;
  /** Expected x-tenant-id; mismatched tenant → 401 (cross-principal denial). */
  requireTenant?: string;
  /** When false, the write tool is absent from the surface (read-only principal). */
  writePermitted?: boolean;
}

interface StubHarness {
  server: Server<undefined>;
  /** Every stored learning record, in insertion order. */
  records: StubLearning[];
  /** Every `memory_add_learning` argument set, in order. */
  addBodies: z.infer<typeof addLearningSchema>[];
  /** Every `memory_search` argument set, in order. */
  searchBodies: z.infer<typeof searchSchema>[];
  stop(): Promise<void>;
}

/** Whether a record's neurons include every `key:value` filter pair. */
function recordMatchesFilters(record: StubLearning, filters: Record<string, string>): boolean {
  return Object.entries(filters).every(([key, value]) => record.neurons.includes(`${key}:${value}`));
}

function createStub(options: StubOptions = {}): StubHarness {
  const records: StubLearning[] = [];
  const addBodies: Array<z.infer<typeof addLearningSchema>> = [];
  const searchBodies: Array<z.infer<typeof searchSchema>> = [];
  let seq = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET") {
        // SSE / session endpoint — not used by the stateless client.
        return new Response("", { status: 405 });
      }
      if (req.method !== "POST" || url.pathname !== "/mcp") {
        return Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "not found" }, id: null });
      }
      // Credential check (mnesis auth model): every request must carry both
      // the tenant header and a valid bearer token.
      const tenant = req.headers.get("x-tenant-id") ?? "";
      const auth = req.headers.get("authorization") ?? "";
      const bearer = auth.replace(/^Bearer\s+/i, "");
      if (options.requireTenant !== undefined && tenant !== options.requireTenant) {
        return Response.json({ detail: "unknown tenant" }, { status: 401 });
      }
      if (options.requireToken !== undefined && bearer !== options.requireToken) {
        return Response.json({ detail: "invalid token" }, { status: 401 });
      }

      const body = jsonRpcRequestSchema.parse(await req.json());
      const { method, id, params } = body;
      if (method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "memory-stub", version: "1.0.0" },
          },
        });
      }
      if (method === "notifications/initialized") {
        return new Response("Accepted", { status: 202 });
      }
      if (method === "tools/list") {
        const tools = options.writePermitted === false ? ["memory_search"] : ["memory_add_learning", "memory_search"];
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: { tools: tools.map((name) => ({ name })) },
        });
      }
      if (method === "tools/call") {
        const { name, arguments: args } = toolCallParamsSchema.parse(params);
        if (name === "memory_add_learning") {
          // Permission-filtered surface: a read-only principal never has the
          // write tool registered (mirrors the live probe's -32602).
          if (options.writePermitted === false) {
            return Response.json(
              { jsonrpc: "2.0", id, error: { code: -32602, message: `Tool ${name} not found` } },
              { status: 200 },
            );
          }
          const parsed = addLearningSchema.parse(args ?? {});
          addBodies.push(parsed);
          const existing = records.find(
            (r) =>
              r.session_id === parsed.session_id &&
              r.learning === parsed.learning &&
              JSON.stringify(r.neurons) === JSON.stringify(parsed.neurons ?? []),
          );
          if (existing) {
            // mnesis on-save consolidation: an identical scope+content+tags
            // write resolves to the same active record (mem0-style).
            return Response.json({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Operation: ok session=${parsed.session_id}` }] },
            });
          }
          const record: StubLearning = {
            id: `mn-${++seq}`,
            session_id: parsed.session_id ?? "",
            event_type: parsed.event_type ?? "insight",
            learning: parsed.learning ?? "",
            context: parsed.context ?? "",
            neurons: parsed.neurons ?? [],
            operation_id: parsed.operation_id ?? "",
          };
          records.push(record);
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: `Operation: ok fact=${record.id} session=${record.session_id}`,
                },
              ],
            },
          });
        }
        if (name === "memory_search") {
          const parsed = searchSchema.parse(args ?? {});
          searchBodies.push(parsed);
          const limit = parsed.limit ?? 5;
          const hits = records
            .filter((r) => parsed.session_id === undefined || r.session_id === parsed.session_id)
            .filter((r) => (parsed.filters ? recordMatchesFilters(r, parsed.filters) : true))
            .slice(0, limit);
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `## Memory Search: ${parsed.query}` }],
              structuredContent: {
                schemaVersion: 1,
                engine: "memory",
                mode: "standard",
                subQueryCount: 1,
                results: hits.map((r) => ({
                  recordId: r.id,
                  session_id: r.session_id,
                  memory: r.learning,
                  neurons: r.neurons,
                  provenance: { source: null, spaceId: null, principalId: null, memoryType: "learning" },
                  authorization: {
                    ownerScope: {
                      tenantId: options.requireTenant ?? "acme-eng",
                      principalId: "space-alpha",
                      agentId: null,
                      projectId: null,
                    },
                  },
                })),
              },
            },
          });
        }
        return Response.json({ jsonrpc: "2.0", id, result: { content: [] } });
      }
      return Response.json(
        { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } },
        { status: 200 },
      );
    },
  });

  return {
    server,
    records,
    addBodies,
    searchBodies,
    async stop() {
      await server.stop(true);
    },
  };
}

describe("mnesis provider (stub-backed, issue #348)", () => {
  let stub: StubHarness;
  let provider: MemoryProvider;

  beforeEach(() => {
    stub = createStub({ requireTenant: "acme-eng", requireToken: "mnesis-token", writePermitted: true });
    provider = createMnesisMemoryProvider({
      baseUrl: `${stub.server.url.origin}/mcp`,
      tenantId: "acme-eng",
      principalId: "space-alpha",
      token: "mnesis-token",
    });
  });

  afterEach(async () => {
    await stub.stop();
  });

  test("save maps content/scope/kind/metadata onto memory_add_learning structured fields", async () => {
    await provider.save({
      scope: { kind: "org" },
      content: "the org ships bottega per company",
      metadata: { kind: "decision", category: "architecture", epic: "348" },
    });
    expect(stub.addBodies).toHaveLength(1);
    const body = stub.addBodies[0]!;
    // First-class field mapping (GO condition 1 — no <meta>JSON</meta> hack):
    expect(body.session_id).toBe("bottega:org");
    expect(body.event_type).toBe("decision"); // metadata.kind → event_type
    expect(body.learning).toBe("the org ships bottega per company");
    expect(body.neurons).toEqual(
      expect.arrayContaining(["kind:decision", "category:architecture", "epic:348"]),
    );
    expect(body.operation_id).toBeTruthy();
  });

  test("session id encodes the logical scope (org/person/channel/team)", () => {
    expect(mnesisSessionId({ kind: "org" })).toBe("bottega:org");
    expect(mnesisSessionId({ kind: "person", principal: "U1" })).toBe("bottega:person:U1");
    expect(mnesisSessionId({ kind: "channel", spaceId: "C1" })).toBe("bottega:channel:C1");
    expect(mnesisSessionId({ kind: "team", teamId: "eng" })).toBe("bottega:team:eng");
  });

  test("rejects a missing base URL at construction", () => {
    expect(() => createMnesisMemoryProvider({ baseUrl: "", tenantId: "t", principalId: "p", token: "x" })).toThrow(/baseUrl/);
  });

  test("rejects a missing tenant or token at construction", () => {
    expect(() =>
      createMnesisMemoryProvider({ baseUrl: "http://x/mcp", tenantId: "", principalId: "p", token: "x" }),
    ).toThrow(/tenantId/);
    expect(() =>
      createMnesisMemoryProvider({ baseUrl: "http://x/mcp", tenantId: "t", principalId: "p", token: "" }),
    ).toThrow(/token/);
  });

  test("forget is unsupported and rejects loudly (no delete tool — issue #348 verdict)", async () => {
    expect(provider.capabilities.forget).toBe("unsupported");
    const saved = await provider.save({ scope: { kind: "org" }, content: "forget me" });
    await expect(provider.forget({ scope: { kind: "org" }, id: saved.id })).rejects.toThrow(/does not support forget/);
  });

  test("digest pruning is unsupported (rejects loudly, never a silent no-op)", async () => {
    expect(provider.capabilities.digestPruning).toBe("unsupported");
    await expect(provider.pruneDigests("slack:C1", 2)).rejects.toThrow(/does not support required digest pruning/);
  });

  test("consolidation is on-save", () => {
    expect(provider.capabilities.consolidation).toBe("on-save");
  });

  test("wrong-tenant probe fails loudly (401 on a tenant outside the credential allowlist)", async () => {
    const other = createMnesisMemoryProvider({
      baseUrl: `${stub.server.url.origin}/mcp`,
      tenantId: "acme-design", // NOT the stub's tenant
      principalId: "space-beta",
      token: "mnesis-token",
    });
    await expect(other.save({ scope: { kind: "org" }, content: "cross-tenant probe" })).rejects.toThrow(/401|rejected the credential/i);
  });
});

describe("mnesis permission-filtered surface (issue #348)", () => {
  test("a read-only principal cannot write (tool absent from its surface)", async () => {
    const stub = createStub({
      requireTenant: "acme-eng",
      requireToken: "readonly-token",
      writePermitted: false,
    });
    const p = createMnesisMemoryProvider({
      baseUrl: `${stub.server.url.origin}/mcp`,
      tenantId: "acme-eng",
      principalId: "readonly-probe",
      token: "readonly-token",
    });
    try {
      await expect(p.save({ scope: { kind: "org" }, content: "should fail" })).rejects.toThrow(/not available|does not admit|-32602/i);
      // Read is still permitted.
      const hits = await p.search({ scope: { kind: "org" }, query: "anything" });
      expect(hits).toEqual([]);
    } finally {
      await stub.stop();
    }
  });
});

describe("mnesis conformance", () => {
  let stub: StubHarness;
  beforeAll(() => {
    stub = createStub({ requireTenant: "acme-eng", requireToken: "conform-token", writePermitted: true });
  });
  afterAll(async () => {
    await stub.stop();
  });

  runMemoryConformanceTests(async () => {
    const provider = createMnesisMemoryProvider({
      baseUrl: `${stub.server.url.origin}/mcp`,
      tenantId: "acme-eng",
      principalId: "conform-agent",
      token: "conform-token",
    });
    return { provider };
  });
});
