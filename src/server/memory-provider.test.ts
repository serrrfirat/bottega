/**
 * Memory provider selection tests (issues #43, #67).
 *
 * resolveMemoryProvider reads ONLY the passed settings object (plus the env
 * record for the optional API key): memory_backend.base_url set → mem0
 * backend (base URL + optional API key reach the client), unset → SQLite
 * fallback sharing the given store database. The mem0 branch is proven
 * against a Bun.serve stub (the same wire contract the client's own tests
 * use), so "right args" means an actual HTTP round-trip with the
 * configured key.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Server } from "bun";
import { resolveMemoryProvider } from "./memory-provider";
const dir = mkdtempSync(join(tmpdir(), "bottega-mem-provider-"));
const dbs: Database[] = [];
function freshDb(): Database {
  const db = new Database(join(dir, `mem-${dbs.length}.db`));
  dbs.push(db);
  return db;
}

afterAll(() => {
  for (const db of dbs) db.close();
});

/** Minimal mem0 OSS wire stub: records requests, answers /memories + /search. */
function createStub() {
  const requests: { path: string; apiKey: string | null; body: Record<string, unknown> }[] = [];
  let seq = 0;
  const server: Server<undefined> = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const apiKey = req.headers.get("x-api-key");
      if (url.pathname === "/memories" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        requests.push({ path: url.pathname, apiKey, body });
        const id = `mem-${++seq}`;
        return Response.json({
          results: [
            {
              id,
              memory: String((body.messages as { content: string }[])[0].content),
              event: "ADD",
              user_id: body.user_id ?? null,
              agent_id: body.agent_id ?? null,
              metadata: body.metadata ?? {},
              created_at: new Date(1_700_000_000_000).toISOString(),
            },
          ],
        });
      }
      if (url.pathname === "/search" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        requests.push({ path: url.pathname, apiKey, body });
        return Response.json({ results: [] });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    },
  });
  return { server, requests, async stop() { await server.stop(true); } };
}

describe("resolveMemoryProvider (issue #43)", () => {
  test("memory_backend.base_url set → mem0 provider with the configured URL and API key", async () => {
    const stub = createStub();
    try {
      const provider = resolveMemoryProvider(
        { memoryBackend: { baseUrl: stub.server.url.href } },
        freshDb(),
        { MEM0_API_KEY: "m0sk-test" },
      );
      const saved = await provider.save({ scope: "org", content: "selection test fact" });
      expect(saved.content).toBe("selection test fact");
      // Wire contract: org scope maps to a fixed agent_id, key travels as
      // X-API-Key, and the request hit the configured base URL.
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].path).toBe("/memories");
      expect(stub.requests[0].apiKey).toBe("m0sk-test");
      expect(stub.requests[0].body.agent_id).toBe("bottega");

      await provider.search({ scope: "org", query: "selection test" });
      expect(stub.requests[1].path).toBe("/search");
      expect(stub.requests[1].apiKey).toBe("m0sk-test");
    } finally {
      await stub.stop();
    }
  });

  test("memory_backend.base_url unset → SQLite provider sharing the store database", async () => {
    const db = freshDb();
    const provider = resolveMemoryProvider(null, db);
    const saved = await provider.save({ scope: "org", content: "sqlite fallback fact" });
    expect(saved.id).toBeTruthy();
    const hits = await provider.search({ scope: "org", query: "sqlite fallback" });
    expect(hits.map((e) => e.content)).toEqual(["sqlite fallback fact"]);
    // Same database handle: a second provider sees the same rows.
    const again = resolveMemoryProvider({}, db);
    const more = await again.search({ scope: "org", query: "sqlite fallback" });
    expect(more.map((e) => e.content)).toEqual(["sqlite fallback fact"]);
  });
});
