import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteMemoryProvider } from "../memory/sqlite";
import { createAudit } from "../policy/audit";
import { MEMORY_WRITE_EVENT } from "../store/audit-events";
import { createStore, type Store } from "../store/db";
import { sha256Hex } from "../tools/memory";
import { chunkText, ingestAll, ingestSource } from "./ingest";
import type { KbSource } from "./config";

const tempDir = mkdtempSync(join(tmpdir(), "bottega-kb-ingest-"));
const stores: Store[] = [];
const changingRequests = new Map<string, number>();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/handbook") {
      return new Response(
        "<html><body><h1>Company Handbook</h1><p>Remote work is supported.</p><h2>Expenses</h2><p>Receipts are required.</p></body></html>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (url.pathname === "/changing") {
      const key = url.searchParams.get("key") ?? "default";
      const requestNumber = (changingRequests.get(key) ?? 0) + 1;
      changingRequests.set(key, requestNumber);
      const content = requestNumber === 1 ? "Old handbook version" : "New handbook version";
      return new Response(`<h1>Handbook</h1><p>${content}</p>`, {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.pathname === "/too-large") {
      return new Response("x".repeat(128), { headers: { "content-type": "text/plain" } });
    }
    return new Response("not found", { status: 404 });
  },
});

function freshStore(): Store {
  const store = createStore(join(tempDir, `store-${stores.length}.db`));
  stores.push(store);
  return store;
}

function source(path: string, id = "handbook"): KbSource {
  return { id, url: new URL(path, server.url).toString(), type: "html" };
}

/** MEMORY_WRITE_EVENT payload (audit-events.ts): {scope, principal, id, content_hash}. */
interface MemoryWritePayload {
  scope: string;
  principal: string | null;
  id: string;
  content_hash: string;
}

afterAll(() => {
  server.stop(true);
  for (const store of stores) store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("chunkText", () => {
  test("splits at headings and paragraphs while carrying heading context", () => {
    const chunks = chunkText("# Handbook\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Expenses\n\nKeep receipts.", 42);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 42)).toBe(true);
    expect(chunks.filter((chunk) => chunk.includes("First") || chunk.includes("Second")).every((chunk) => chunk.startsWith("# Handbook"))).toBe(true);
    expect(chunks.find((chunk) => chunk.includes("Keep receipts."))?.startsWith("## Expenses")).toBe(true);
  });

  test("hard-splits an oversized block without exceeding the size cap", () => {
    const chunks = chunkText(`# Limits\n\n${"abcdefghij".repeat(30)}`, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("# Limits"))).toBe(true);
    expect(chunks.map((chunk) => chunk.replace(/^# Limits\n\n/, "")).join("")).toBe("abcdefghij".repeat(30));
  });

  test("returns no chunks for blank input", () => {
    expect(chunkText(" \n\n ")).toEqual([]);
  });
});

describe("KB ingestion", () => {
  test("fetches HTML, saves org memories with source metadata, and audits every save", async () => {
    const store = freshStore();
    const memory = createSqliteMemoryProvider(store.getDb());
    const audit = createAudit(store);
    const kbSource: KbSource = {
      id: "handbook",
      url: "https://docs.example.com/handbook",
      type: "html",
    };

    const result = await ingestSource(memory, audit, kbSource, { baseUrl: server.url.origin });

    expect(result.url).toBe(kbSource.url);
    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(result.saved).toBe(result.chunks);
    const memories = await memory.search({
      query: "",
      scope: "org",
      metadata: { kind: "kb", source: "handbook" },
      limit: 20,
    });
    expect(memories).toHaveLength(result.saved);
    expect(memories.every((entry) => entry.principal === null)).toBe(true);
    expect(memories.every((entry) => entry.metadata.kind === "kb")).toBe(true);
    expect(memories.every((entry) => entry.metadata.source === "handbook")).toBe(true);
    expect(memories.every((entry) => entry.metadata.url === kbSource.url)).toBe(true);
    expect(memories.some((entry) => entry.content.includes("Company Handbook"))).toBe(true);
    expect(memories.some((entry) => entry.content.includes("Receipts are required."))).toBe(true);

    const rows = await store.listAudit({ event_type: MEMORY_WRITE_EVENT, limit: 20 });
    expect(rows).toHaveLength(result.saved);
    for (const row of rows) {
      expect(row.actor).toBe("kb_ingest");
      // SAFETY: ingestSource writes MEMORY_WRITE_EVENT rows with exactly this
      // payload shape (audit-events.ts); the schema is pinned by this test.
      const payload = JSON.parse(row.payload) as MemoryWritePayload;
      expect(payload.scope).toBe("org");
      expect(payload.principal).toBeNull();
      const entry = memories.find((memoryEntry) => memoryEntry.id === payload.id);
      expect(entry).toBeDefined();
      expect(payload.content_hash).toBe(sha256Hex(entry!.content));
    }
  });

  test("re-ingestion appends entries and SQLite returns the newest version first", async () => {
    const store = freshStore();
    const memory = createSqliteMemoryProvider(store.getDb());
    const audit = createAudit(store);
    const kbSource = source(`/changing?key=${crypto.randomUUID()}`);

    await ingestSource(memory, audit, kbSource);
    await ingestSource(memory, audit, kbSource);

    const memories = await memory.search({
      query: "",
      scope: "org",
      metadata: { kind: "kb", source: "handbook" },
      limit: 20,
    });
    expect(memories).toHaveLength(2);
    expect(memories[0]!.content).toContain("New handbook version");
    expect(memories[1]!.content).toContain("Old handbook version");
  });

  test("ingestAll processes each configured source", async () => {
    const store = freshStore();
    const memory = createSqliteMemoryProvider(store.getDb());
    const audit = createAudit(store);
    const result = await ingestAll(memory, audit, {
      sources: [source("/handbook", "one"), source("/handbook", "two")],
    });
    expect(result).toHaveLength(2);
    expect(result.map((entry) => entry.url)).toEqual([
      source("/handbook", "one").url,
      source("/handbook", "two").url,
    ]);
  });

  test("fails with source context on HTTP and response-size errors", async () => {
    const store = freshStore();
    const memory = createSqliteMemoryProvider(store.getDb());
    const audit = createAudit(store);
    expect(ingestSource(memory, audit, source("/missing"))).rejects.toThrow("handbook");
    expect(ingestSource(memory, audit, source("/too-large"), { maxBytes: 64 })).rejects.toThrow("size cap");
  });
});
