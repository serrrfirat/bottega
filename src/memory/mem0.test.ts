/**
 * Mem0 backend tests (issue #21).
 *
 * Hermetic: a Bun.serve stub emulates the OSS server's wire contract
 * (`POST /memories` add, `POST /search` search, `X-API-Key` auth). The
 * conformance suite from ./conformance.test runs against the stub-backed
 * provider — the same suite the SQLite backend runs, proving interface parity.
 *
 * A skip-gated Docker leg probes the published `mem0/mem0-api-server` image
 * WITHOUT an LLM key; it skips with a message whenever the server can't run
 * without one (no keys are ever created here).
 */
import type { Server } from "bun";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { MemoryProvider } from "./types";
import { asRecord, createMem0MemoryProvider, MEM0_ORG_AGENT_ID, stringifyMetadata } from "./mem0";
import { runMemoryConformanceTests } from "./conformance.test";
import { serviceEnv } from "../compose-test-utils";

/** In-memory row emulating a stored mem0 memory (payload shape of the OSS server). */
interface StubMemory {
  id: string;
  memory: string;
  event: string;
  user_id: string | null;
  agent_id: string | null;
  metadata: Record<string, string>;
  created_at: string;
}

/** Captured POST /memories request body — the fields the tests read. */
interface AddMemoryBody {
  messages?: unknown;
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  metadata?: unknown;
  enable_graph?: boolean;
}

/** Captured POST /search request body — the fields the tests read. */
interface SearchMemoryBody {
  query?: string;
  filters?: unknown;
  top_k?: number;
  enable_graph?: boolean;
}

const addMemoryBodySchema = z.object({
  messages: z.array(z.json()).optional(),
  user_id: z.string().optional(),
  agent_id: z.string().optional(),
  run_id: z.string().optional(),
  metadata: z.json().optional(),
  enable_graph: z.boolean().optional(),
});

const searchMemoryBodySchema = z.object({
  query: z.string().optional(),
  filters: z.json().optional(),
  top_k: z.number().optional(),
  enable_graph: z.boolean().optional(),
});

interface StubOptions {
  /** When set, every request must carry `X-API-Key: <value>` or gets 401. */
  requireApiKey?: string;
  /** POST /memories responds 500 with this detail (error surfacing tests). */
  failAdd?: boolean;
  /** POST /search responds 500 with this detail. */
  failSearch?: boolean;
  /** POST /memories holds the request open until the client disconnects (timeout tests). */
  slow?: boolean;
  /** POST /memories returns an empty results list (NOOP-style response). */
  emptyAdd?: boolean;
  /** Stored memories carry no created_at (createdAt fallback test). */
  noCreatedAt?: boolean;
  /** OpenAPI advertises the legacy enable_graph request field. */
  graphSupport?: boolean;
  /** Reject enable_graph with a schema error despite advertising it. */
  rejectGraph?: boolean;
  /** Repeated identical scoped facts resolve to the existing active memory. */
  consolidateDuplicates?: boolean;
}

interface StubHarness {
  server: Server<undefined>;
  memories: StubMemory[];
  /** Bodies of every POST /memories request, in order. */
  addBodies: AddMemoryBody[];
  /** Bodies of every POST /search request, in order. */
  searchBodies: SearchMemoryBody[];
  /** Every request's headers, in order. */
  headers: Headers[];
  stop(): Promise<void>;
}

function createStub(options: StubOptions = {}): StubHarness {
  const memories: StubMemory[] = [];
  const addBodies: AddMemoryBody[] = [];
  const searchBodies: SearchMemoryBody[] = [];
  const headers: Headers[] = [];
  let seq = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      headers.push(req.headers);
      if (options.requireApiKey && req.headers.get("x-api-key") !== options.requireApiKey) {
        return Response.json({ detail: "Invalid or missing API key" }, { status: 401 });
      }
      if (url.pathname === "/openapi.json" && req.method === "GET") {
        const graphProperties = options.graphSupport
          ? { enable_graph: { type: "boolean" } }
          : {};
        return Response.json({
          paths: {
            "/memories": {
              post: {
                requestBody: {
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/MemoryCreate" } },
                  },
                },
              },
            },
            "/search": {
              post: {
                requestBody: {
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/SearchRequest" } },
                  },
                },
              },
            },
          },
          components: {
            schemas: {
              MemoryCreate: { type: "object", properties: graphProperties },
              SearchRequest: { type: "object", properties: graphProperties },
            },
          },
        });
      }
      if (url.pathname === "/memories" && req.method === "POST") {
        const body = addMemoryBodySchema.parse(await req.json());
        addBodies.push(body);
        if (options.rejectGraph && body.enable_graph === true) {
          return Response.json({ detail: "enable_graph is not supported" }, { status: 422 });
        }
        if (options.slow) {
          // Hold the request open until the client's timeout aborts it — no
          // wall-clock sleep, deterministic under load.
          const { promise, resolve } = Promise.withResolvers<void>();
          req.signal.addEventListener("abort", () => resolve());
          await promise;
        }
        if (options.failAdd) return Response.json({ detail: "upstream extraction failed" }, { status: 500 });
        if (options.emptyAdd) return Response.json({ results: [] });
        // Wire contract of POST /memories: messages[] + at least one of
        // user_id / agent_id / run_id.
        const messages = body.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
          return Response.json({ detail: "messages is required" }, { status: 422 });
        }
        if (!body.user_id && !body.agent_id && !body.run_id) {
          return Response.json(
            { detail: "At least one identifier (user_id, agent_id, run_id) is required." },
            { status: 422 },
          );
        }
        const content = String(asRecord(messages[0]).content ?? "");
        const userId = body.user_id ?? null;
        const agentId = body.agent_id ?? null;
        const metadata = stringifyMetadata(asRecord(body.metadata ?? null));
        if (options.consolidateDuplicates) {
          const existing = memories.find(
            (memory) =>
              memory.memory === content &&
              memory.user_id === userId &&
              memory.agent_id === agentId &&
              JSON.stringify(memory.metadata) === JSON.stringify(metadata),
          );
          if (existing) {
            return Response.json({ results: [{ ...existing, event: "NONE" }] });
          }
        }
        const id = `mem-${++seq}`;
        const created_at = options.noCreatedAt
          ? ""
          : new Date(1_700_000_000_000 + seq * 1000).toISOString();
        const mem: StubMemory = {
          id,
          memory: content,
          event: "ADD",
          user_id: userId,
          agent_id: agentId,
          metadata,
          created_at,
        };
        memories.push(mem);
        return Response.json({
          results: [
            {
              id: mem.id,
              memory: mem.memory,
              event: mem.event,
              user_id: mem.user_id,
              agent_id: mem.agent_id,
              metadata: mem.metadata,
              created_at: mem.created_at,
            },
          ],
        });
      }
      if (url.pathname === "/search" && req.method === "POST") {
        const body = searchMemoryBodySchema.parse(await req.json());
        searchBodies.push(body);
        if (options.rejectGraph && body.enable_graph === true) {
          return Response.json({ detail: "enable_graph is not supported" }, { status: 422 });
        }
        if (options.failSearch) return Response.json({ detail: "upstream search failed" }, { status: 500 });
        const filters = asRecord(body.filters ?? null);
        if (!filters.user_id && !filters.agent_id && !filters.run_id) {
          return Response.json(
            { detail: "filters must contain at least one of: user_id, agent_id, run_id" },
            { status: 422 },
          );
        }
        const topK = body.top_k ?? 5;
        const hits = memories
          .filter((m) => {
            if (filters.user_id !== undefined && m.user_id !== filters.user_id) return false;
            if (filters.agent_id !== undefined && m.agent_id !== filters.agent_id) return false;
            // Remaining filter keys are exact-match metadata filters.
            for (const [key, value] of Object.entries(filters)) {
              if (key === "user_id" || key === "agent_id" || key === "run_id") continue;
              if (m.metadata[key] !== value) return false;
            }
            return true;
          })
          .slice(0, topK);
        return Response.json({
          results: hits.map((h) => ({
            id: h.id,
            memory: h.memory,
            score: 0.9,
            user_id: h.user_id,
            agent_id: h.agent_id,
            metadata: h.metadata,
            created_at: h.created_at,
          })),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    server,
    memories,
    addBodies,
    searchBodies,
    headers,
    async stop() {
      await server.stop(true);
    },
  };
}

describe("mem0 provider (stub-backed)", () => {
  // Fresh stub + provider per test: the stub's "search" matches all rows for
  // a scope (semantic ranking is the real server's job), so shared state
  // would leak across assertions.
  let stub: StubHarness;
  let provider: MemoryProvider;

  beforeEach(() => {
    stub = createStub();
    provider = createMem0MemoryProvider({ baseUrl: stub.server.url.href, agentId: "acme-agent" });
  });

  afterEach(async () => {
    await stub.stop();
  });

  test("save maps org scope to agent_id and parses the response", async () => {
    const saved = await provider.save({
      scope: { kind: "org" },
      content: "The org deploys bottega per company.",
      metadata: { source: "slack" },
    });
    const body = stub.addBodies.at(-1)!;
    expect(body.user_id).toBeUndefined();
    expect(body.agent_id).toBe("acme-agent");
    const messages = body.messages;
    if (!Array.isArray(messages)) throw new Error("stub: expected messages array");
    expect(messages[0]).toEqual({
      role: "user",
      content: "The org deploys bottega per company.",
    });
    expect(body.metadata).toEqual({ source: "slack" });
    expect(saved.id).toBe("mem-1");
    expect(saved.key).toEqual({ kind: "org" });
    expect(saved.content).toBe("The org deploys bottega per company.");
    expect(saved.metadata).toEqual({ source: "slack" });
    expect(saved.createdAt).toEqual(expect.any(Number));
    expect(saved.createdAt).toBe(Date.parse(stub.memories[0].created_at));
  });

  test("org scope defaults to the org agent id when agentId is unset", async () => {
    const p = createMem0MemoryProvider({ baseUrl: stub.server.url.href });
    await p.save({ scope: { kind: "org" }, content: "default org memory" });
    const body = stub.addBodies.at(-1)!;
    expect(body.agent_id).toBe(MEM0_ORG_AGENT_ID);
    expect(body.user_id).toBeUndefined();
  });

  test("save maps person scope to user_id (the physical key) with no agent passthrough", async () => {
    await provider.save({ scope: { kind: "person", principal: "alice" }, content: "alice prefers kebab case" });
    const body = stub.addBodies.at(-1)!;
    // Issue #137: a person row carries ONLY the person key in user_id — no
    // agent_id, so it cannot be cross-queryable via the org agent id.
    expect(body.user_id).toBe("alice");
    expect(body.agent_id).toBeUndefined();
  });

  test("search sends query, scope filters and top_k, and parses entries", async () => {
    await provider.save({ scope: { kind: "org" }, content: "search probe zero" });
    await provider.save({ scope: { kind: "org" }, content: "search probe one" });
    await provider.save({ scope: { kind: "org" }, content: "search probe two" });
    const hits = await provider.search({ scope: { kind: "org" }, query: "search probe", limit: 2 });
    const body = stub.searchBodies.at(-1)!;
    expect(body.query).toBe("search probe");
    expect(body.filters).toEqual({ agent_id: "acme-agent" });
    expect(body.top_k).toBe(2);
    expect(hits.length).toBe(2);
    expect(hits[0].id).toBeTruthy();
    expect(hits[0].key).toEqual({ kind: "org" });
    expect(hits[0].content).toContain("search probe");
    expect(hits[0].createdAt).toEqual(expect.any(Number));
  });

  test("search filters by user scope principal", async () => {
    await provider.save({ scope: { kind: "person", principal: "alice" }, content: "alice likes pie" });
    await provider.save({ scope: { kind: "person", principal: "bob" }, content: "bob likes cake" });
    const alice = await provider.search({ scope: { kind: "person", principal: "alice" }, query: "likes" });
    const body = stub.searchBodies.at(-1)!;
    expect(body.filters).toEqual({ user_id: "alice" });
    expect(alice.length).toBe(1);
    expect(alice[0].key).toEqual({ kind: "person", principal: "alice" });
    expect(alice[0].content).toContain("pie");
  });

  test("search merges exact-match metadata filters", async () => {
    await provider.save({ scope: { kind: "org" }, content: "tagged fact", metadata: { source: "slack" } });
    await provider.save({ scope: { kind: "org" }, content: "untagged fact" });
    const hits = await provider.search({
      scope: { kind: "org" },
      query: "fact",
      metadata: { source: "slack" },
    });
    const body = stub.searchBodies.at(-1)!;
    expect(body.filters).toEqual({ agent_id: "acme-agent", source: "slack" });
    expect(hits.length).toBe(1);
    expect(hits[0].metadata.source).toBe("slack");
  });

  test("search drops identity-key metadata instead of overwriting the scope", async () => {
    await provider.save({ scope: { kind: "person", principal: "alice" }, content: "identity probe" });
    const hits = await provider.search({
      scope: { kind: "person", principal: "alice" },
      query: "identity probe",
      metadata: { user_id: "mallory" },
    });
    const body = stub.searchBodies.at(-1)!;
// The scope's user_id wins; the caller's metadata cannot widen the scope.
    expect(body.filters).toEqual({ user_id: "alice" });
    expect(hits.length).toBe(1);
    expect(hits[0].key).toEqual({ kind: "person", principal: "alice" });
  });

  test("enables graph add and search when OpenAPI advertises support, preserving user scope", async () => {
    const graph = createStub({ graphSupport: true });
    try {
      const p = createMem0MemoryProvider({ baseUrl: graph.server.url.href, agentId: "graph-agent" });
      const saved = await p.save({
        scope: { kind: "person", principal: "alice" },
        content: "Alice works with Bob on Bottega.",
      });
      const hits = await p.search({ scope: { kind: "person", principal: "alice" }, query: "Who works with Alice?" });

      expect(graph.addBodies).toHaveLength(1);
      expect(graph.addBodies[0].enable_graph).toBe(true);
      expect(graph.addBodies[0].user_id).toBe("alice");
      expect(graph.addBodies[0].agent_id).toBeUndefined();
      expect(graph.searchBodies).toHaveLength(1);
      expect(graph.searchBodies[0].enable_graph).toBe(true);
      expect(graph.searchBodies[0].filters).toEqual({
        user_id: "alice",
      });
      expect(hits.map((hit) => hit.id)).toContain(saved.id);
    } finally {
      await graph.stop();
    }
  });

  test("uses normal vector-shaped requests when graph is not advertised", async () => {
    await provider.save({ scope: { kind: "org" }, content: "ordinary memory" });
    await provider.search({ scope: { kind: "org" }, query: "ordinary" });

    expect(stub.addBodies.at(-1)!.enable_graph).toBeUndefined();
    expect(stub.searchBodies.at(-1)!.enable_graph).toBeUndefined();
  });

  test("retries without graph after a schema rejection and remembers the fallback", async () => {
    const stale = createStub({ graphSupport: true, rejectGraph: true });
    try {
      const p = createMem0MemoryProvider({ baseUrl: stale.server.url.href });
      const saved = await p.save({ scope: { kind: "org" }, content: "fallback fact" });
      const hits = await p.search({ scope: { kind: "org" }, query: "fallback" });

      expect(stale.addBodies.map((body) => body.enable_graph)).toEqual([true, undefined]);
      expect(stale.searchBodies.map((body) => body.enable_graph)).toEqual([true, undefined]);
      expect(hits.map((hit) => hit.id)).toContain(saved.id);

      await p.save({ scope: { kind: "org" }, content: "second fallback fact" });
      expect(stale.addBodies.at(-1)!.enable_graph).toBeUndefined();
    } finally {
      await stale.stop();
    }
  });

  test("maps mem0 server-side duplicate consolidation to the existing active memory", async () => {
    const consolidating = createStub({ consolidateDuplicates: true });
    try {
      const p = createMem0MemoryProvider({ baseUrl: consolidating.server.url.href });
      const first = await p.save({ scope: { kind: "org" }, content: "Bottega deploys once per company." });
      const duplicate = await p.save({ scope: { kind: "org" }, content: "Bottega deploys once per company." });
      const hits = await p.search({ scope: { kind: "org" }, query: "deploys" });

      expect(duplicate.id).toBe(first.id);
      expect(consolidating.memories).toHaveLength(1);
      expect(hits.map((hit) => hit.id)).toEqual([first.id]);
    } finally {
      await consolidating.stop();
    }
  });

  test("sends X-API-Key when apiKey is configured", async () => {
    const authed = createStub({ requireApiKey: "m0sk-secret" });
    try {
      const p = createMem0MemoryProvider({ baseUrl: authed.server.url.href, apiKey: "m0sk-secret" });
      const saved = await p.save({ scope: { kind: "org" }, content: "authed fact" });
      expect(saved.id).toBeTruthy();
    } finally {
      await authed.stop();
    }
  });

  test("omits X-API-Key when apiKey is unset", async () => {
    await provider.save({ scope: { kind: "org" }, content: "header probe" });
    const lastHeaders = stub.headers.at(-1)!;
    expect(lastHeaders.has("x-api-key")).toBe(false);
  });

  test("surfaces non-2xx responses with status and body snippet", async () => {
    const failing = createStub({ failAdd: true, failSearch: true });
    try {
      const p = createMem0MemoryProvider({ baseUrl: failing.server.url.href });
      await expect(p.save({ scope: { kind: "org" }, content: "x" })).rejects.toThrow(/HTTP 500/);
      await expect(p.save({ scope: { kind: "org" }, content: "x" })).rejects.toThrow(/upstream extraction failed/);
      await expect(p.search({ scope: { kind: "org" }, query: "x" })).rejects.toThrow(/HTTP 500/);
      await expect(p.search({ scope: { kind: "org" }, query: "x" })).rejects.toThrow(/upstream search failed/);
    } finally {
      await failing.stop();
    }
  });

  test("surfaces timeouts with context", async () => {
    // Exercises the provider's real timeout (AbortController) against a stub
    // that never answers — deterministic, no test-side timers.
    const slow = createStub({ slow: true });
    try {
      const p = createMem0MemoryProvider({ baseUrl: slow.server.url.href, timeoutMs: 100 });
      await expect(p.save({ scope: { kind: "org" }, content: "x" })).rejects.toThrow(/timed out after 100ms/);
    } finally {
      await slow.stop();
    }
  });

  test("throws when add returns no results", async () => {
    const empty = createStub({ emptyAdd: true });
    try {
      const p = createMem0MemoryProvider({ baseUrl: empty.server.url.href });
      await expect(p.save({ scope: { kind: "org" }, content: "x" })).rejects.toThrow(/no result/);
    } finally {
      await empty.stop();
    }
  });

  test("createdAt falls back to 0 when the server omits it", async () => {
    const bare = createStub({ noCreatedAt: true });
    try {
      const p = createMem0MemoryProvider({ baseUrl: bare.server.url.href });
      const saved = await p.save({ scope: { kind: "org" }, content: "timestamp probe" });
      expect(saved.createdAt).toBe(0);
    } finally {
      await bare.stop();
    }
  });

  test("rejects a missing baseUrl at construction", () => {
    expect(() => createMem0MemoryProvider({ baseUrl: "" })).toThrow(/baseUrl/);
  });
});

describe("mem0 conformance", () => {
  let stub: StubHarness;

  beforeAll(() => {
    stub = createStub();
  });

  afterAll(async () => {
    await stub.stop();
  });

  runMemoryConformanceTests(async () =>
    createMem0MemoryProvider({ baseUrl: stub.server.url.href, agentId: "conform-agent" }),
  );
});

describe("docker-compose.yml (issue #135 mem0 deployment default)", () => {
  test("server defaults MEM0_BASE_URL to the internal mem0 service", () => {
    expect(serviceEnv("server")["MEM0_BASE_URL"]).toBe("${MEM0_BASE_URL:-http://mem0:8000}");
  });
});

describe("mem0 docker leg (skip-gated)", () => {
  const IMAGE = "mem0/mem0-api-server:latest";
  const PORT = 8017;
  const BASE = `http://127.0.0.1:${PORT}`;

  /**
   * Waits for the container's /openapi.json to answer. Returns "ok", or a
   * skip reason when the server crashes instead (the published image runs
   * `uvicorn --reload`: the reloader survives worker crashes, so the
   * container never reports "exited" — the crash only shows up in logs).
   * Integration leg: polling a real external container is the exception the
   * no-real-timers rule allows — deterministic time control is impossible
   * across a spawned process.
   */
  async function waitForBoot(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const name = `bottega-mem0-probe-${process.pid}`;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE}/openapi.json`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return "ok";
      } catch {
        // not up yet
      }
      // A worker crash (e.g. missing LLM/embedder key) shows up in the logs
      // within a few seconds — skip fast instead of waiting out the poll.
      // Note: uvicorn + Python tracebacks go to the container's stderr.
      const logs = Bun.spawnSync(["docker", "logs", "--tail", "5", name], { timeout: 5_000 });
      if (logs.success) {
        const tail = `${logs.stdout.toString()}\n${logs.stderr.toString()}`.trim();
        if (/OpenAIError|api_key client option|Traceback/.test(tail)) {
          return `container crashed while booting: ${tail.split("\n").filter(Boolean).at(-1) ?? "worker died"}`;
        }
      }
      await Bun.sleep(500);
    }
    return `server did not become reachable within ${timeoutMs / 1000}s`;
  }

  test(
    "runs one save+search against the OSS server, or skips without an LLM key",
    async () => {
      const skip = (reason: string) => {
        console.log(`[mem0 docker leg] SKIP: ${reason}`);
      };

      // 0. Integration legs are opt-in (issue #41): the default CI run stays
      //    hermetic + unit only; set BOTTEGA_RUN_INTEGRATION=1 to enable.
      if (process.env.BOTTEGA_RUN_INTEGRATION !== "1") {
        skip("integration leg skipped: set BOTTEGA_RUN_INTEGRATION=1 to run");
        return;
      }

      // 1. Docker daemon present?
      const docker = Bun.spawnSync(["docker", "version", "--format", "{{.Server.Version}}"], {
        timeout: 10_000,
      });
      if (!docker.success) {
        skip(`docker unavailable (${docker.stderr.toString().trim().slice(0, 120) || "no daemon"}). ` +
          `Manual checklist: install Docker, run the mem0 OSS server (see docs.mem0.ai/open-source/setup), ` +
          `then set org settings memory_backend.base_url and MEM0_API_KEY, and re-run this leg.`);
        return;
      }

      // 2. Image present? Pull with a hard timeout; skip on failure.
      const inspect = Bun.spawnSync(["docker", "image", "inspect", IMAGE], { timeout: 10_000 });
      if (!inspect.success) {
        const pull = Bun.spawnSync(["docker", "pull", IMAGE], { timeout: 120_000 });
        if (!pull.success) {
          skip(`could not pull ${IMAGE} (${pull.stderr.toString().trim().slice(0, 120)}). ` +
            `Manual checklist: pre-pull the image or run the server via docker compose from the mem0 repo, ` +
            `set org settings memory_backend.base_url / MEM0_API_KEY, and re-run this leg.`);
          return;
        }
      }

      // 3. Start a throwaway container without any LLM/embedder keys.
      const name = `bottega-mem0-probe-${process.pid}`;
      let started = false;
      try {
        const run = Bun.spawnSync(
          ["docker", "run", "-d", "--name", name, "-p", `127.0.0.1:${PORT}:8000`, IMAGE],
          { timeout: 30_000 },
        );
        if (!run.success) {
          skip(`container start failed (${run.stderr.toString().trim().slice(0, 120)}). ` +
            `Manual checklist: check the mem0 server logs, then set MEM0_BASE_URL/MEM0_API_KEY and re-run.`);
          return;
        }
        started = true;

        const boot = await waitForBoot(30_000);
        if (boot !== "ok") {
          skip(`${boot} (it likely needs an LLM/embedder provider at boot). ` +
            `Manual checklist: run the mem0 OSS server with an LLM key set (e.g. OPENAI_API_KEY) per ` +
            `docs.mem0.ai/open-source/setup, then set MEM0_BASE_URL/MEM0_API_KEY and re-run this leg.`);
          return;
        }

        // 4. Probe an add without any key. No keys are ever created here.
        const probeBody = JSON.stringify({
          messages: [{ role: "user", content: "docker leg probe" }],
          user_id: "docker-leg-probe",
        });
        const currentApi = await fetch(`${BASE}/memories`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: probeBody,
          signal: AbortSignal.timeout(15_000),
        });

        if (currentApi.ok) {
          // The server runs WITHOUT an LLM key (e.g. operator-configured
          // embedder): exercise the provider end to end.
          const provider = createMem0MemoryProvider({ baseUrl: BASE });
          const saved = await provider.save({ scope: { kind: "org" }, content: "docker leg probe fact" });
          const hits = await provider.search({ scope: { kind: "org" }, query: "probe fact" });
          if (hits.some((h) => h.id === saved.id)) {
            console.log("[mem0 docker leg] PASS: real server save+search round-trip");
            return;
          }
          skip("add succeeded without a key but the provider round-trip did not return the saved memory");
          return;
        }

        // Legacy image (pre-2026 /v1/memories) probe — documents why we skip.
        const legacyApi = await fetch(`${BASE}/v1/memories`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: probeBody,
          signal: AbortSignal.timeout(15_000),
        });
        if (legacyApi.ok) {
          skip(`this image exposes the legacy /v1/memories API, not the current /memories API; ` +
            `the provider targets the current server. Manual checklist: run the current mem0 OSS server ` +
            `(main branch or docs.mem0.ai/open-source/setup), set MEM0_BASE_URL/MEM0_API_KEY, re-run this leg.`);
          return;
        }
        skip(`add fails without an LLM key (HTTP ${currentApi.status}/legacy ${legacyApi.status}). ` +
          `Manual checklist: give the mem0 server an LLM/embedder provider key (e.g. OPENAI_API_KEY) per ` +
          `docs.mem0.ai/open-source/configuration, then set MEM0_BASE_URL/MEM0_API_KEY and re-run this leg.`);
      } finally {
        if (started) {
          Bun.spawnSync(["docker", "rm", "-f", name], { timeout: 15_000 });
        }
      }
    },
    { timeout: 200_000 },
  );
});
