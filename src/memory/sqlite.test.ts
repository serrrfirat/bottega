/**
 * SQLite memory backend tests (memory epic, issue #20).
 *
 * Runs the shared conformance suite against a fresh temp-DB provider plus
 * backend-specific behavior: LIKE escaping, metadata round-trip, ordering,
 * cross-connection sharing, and idempotent migration.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createSqliteMemoryProvider, ftsAvailable } from "./sqlite";
import { maintainMemory } from "./consolidation";
import { runMemoryConformanceTests } from "./conformance.test";
import { createStore } from "../store/db";

const dir = mkdtempSync(join(tmpdir(), "bottega-mem-sqlite-"));
const dbs: Database[] = [];
function freshDb(): Database {
  const db = new Database(join(dir, `mem-${dbs.length}.db`));
  dbs.push(db);
  return db;
}

afterAll(() => {
  for (const db of dbs) db.close();
});

runMemoryConformanceTests(async () => {
  const db = freshDb();
  return {
    provider: createSqliteMemoryProvider(db),
    runExplicitConsolidation: async (modelCall) => {
      await maintainMemory(db, modelCall, { compactAfter: 1 });
    },
  };
});

describe("sqlite memory backend specifics", () => {
  test("LIKE wildcards in the query are escaped", async () => {
    const p = createSqliteMemoryProvider(freshDb());
    await p.save({ scope: { kind: "org" }, content: "funding at 100% confirmed" });
    await p.save({ scope: { kind: "org" }, content: "funding at 100x confirmed" });
    await p.save({ scope: { kind: "org" }, content: "alpha_beta naming" });
    await p.save({ scope: { kind: "org" }, content: "alphaXbeta naming" });

    const pct = await p.search({ scope: { kind: "org" }, query: "100%" });
    expect(pct.map((e) => e.content)).toEqual(["funding at 100% confirmed"]);
    const underscore = await p.search({ scope: { kind: "org" }, query: "alpha_beta" });
    expect(underscore.map((e) => e.content)).toEqual(["alpha_beta naming"]);
  });

  test("metadata round-trips exactly and filters on multiple keys", async () => {
    const p = createSqliteMemoryProvider(freshDb());
    const saved = await p.save({
      scope: { kind: "person", principal: "alice" },
      content: "key fact",
      metadata: { source: "slack", team: "platform" },
    });
    expect(saved.metadata).toEqual({ source: "slack", team: "platform" });
    expect(saved.key).toEqual({ kind: "person", principal: "alice" });

    const plain = await p.save({ scope: { kind: "org" }, content: "no tags here" });
    expect(plain.metadata).toEqual({});

    const hits = await p.search({
      scope: { kind: "person", principal: "alice" },
      query: "key",
      metadata: { source: "slack", team: "platform" },
    });
    expect(hits.length).toBe(1);
    const miss = await p.search({
      scope: { kind: "person", principal: "alice" },
      query: "key",
      metadata: { source: "slack", team: "other" },
    });
    expect(miss.length).toBe(0);
  });

  test("results are ordered by created_at descending", async () => {
    const db = freshDb();
    createSqliteMemoryProvider(db);
    const insert = db.query(
      "INSERT INTO memories (id, scope, principal, content, metadata_json, created_at) VALUES (?, 'org', NULL, ?, '{}', ?)",
    );
    insert.run("mem_old", "first entry", 1_000);
    insert.run("mem_new", "second entry", 3_000);
    insert.run("mem_mid", "third entry", 2_000);

    const p = createSqliteMemoryProvider(db);
    const hits = await p.search({ scope: { kind: "org" }, query: "entry" });
    expect(hits.map((e) => e.id)).toEqual(["mem_new", "mem_mid", "mem_old"]);
  });

  test("memories survive reopen: second provider on the same file reruns the idempotent migration", async () => {
    const path = join(dir, "shared.db");
    const db1 = new Database(path);
    const p1 = createSqliteMemoryProvider(db1);
    await p1.save({ scope: { kind: "org" }, content: "persisted across connections" });
    db1.close();

    const db2 = new Database(path);
    dbs.push(db2);
    const p2 = createSqliteMemoryProvider(db2);
    const hits = await p2.search({ scope: { kind: "org" }, query: "persisted" });
    expect(hits.length).toBe(1);
    expect(hits[0].content).toBe("persisted across connections");
  });

  test("works with the store's database handle (getDb)", async () => {
    const store = createStore(join(dir, "store-mem.db"));
    try {
      const p = createSqliteMemoryProvider(store.getDb());
      await p.save({ scope: { kind: "org" }, content: "store-file memory" });
      const hits = await p.search({ scope: { kind: "org" }, query: "store-file" });
      expect(hits.length).toBe(1);
      expect(hits[0].content).toBe("store-file memory");
    } finally {
      store.close();
    }
  });

  test("an empty query is allowed when metadata filters are given (newest digest marker)", async () => {
    const p = createSqliteMemoryProvider(freshDb());
    await p.save({ scope: { kind: "org" }, content: "older digest", metadata: { kind: "digest", space: "slack:C1", until: "1.1" } });
    await p.save({ scope: { kind: "org" }, content: "newer digest", metadata: { kind: "digest", space: "slack:C1", until: "2.2" } });
    await p.save({ scope: { kind: "org" }, content: "other space digest", metadata: { kind: "digest", space: "slack:C2", until: "9.9" } });
    await p.save({ scope: { kind: "org" }, content: "plain memory" });

    const [newest] = await p.search({ scope: { kind: "org" }, query: "", metadata: { kind: "digest", space: "slack:C1" }, limit: 1 });
    expect(newest.content).toBe("newer digest");
    // Still rejected without metadata filters (contract unchanged).
    expect(() => p.search({ scope: { kind: "org" }, query: "" })).toThrow(/non-empty/);
  });

  test("pruneDigests keeps only the newest `keep` digests per space", async () => {
    const p = createSqliteMemoryProvider(freshDb());
    for (let i = 1; i <= 25; i++) {
      await p.save({ scope: { kind: "org" }, content: `digest ${i}`, metadata: { kind: "digest", space: "slack:C1", until: `${i}.0` } });
    }
    await p.save({ scope: { kind: "org" }, content: "other space", metadata: { kind: "digest", space: "slack:C2", until: "1.0" } });
    await p.save({ scope: { kind: "org" }, content: "plain memory" });

    const deleted = await p.pruneDigests("slack:C1", 20);
    expect(deleted).toBe(5);

    const [newest] = await p.search({ scope: { kind: "org" }, query: "", metadata: { kind: "digest", space: "slack:C1" }, limit: 1 });
    expect(newest.content).toBe("digest 25"); // newest survives
    const remaining = await p.search({ scope: { kind: "org" }, query: "", metadata: { kind: "digest", space: "slack:C1" }, limit: 20 });
    expect(remaining).toHaveLength(20);
    expect(remaining.at(-1)!.content).toBe("digest 6"); // oldest survivor

    // Other spaces and plain memories are untouched.
    const other = await p.search({ scope: { kind: "org" }, query: "", metadata: { kind: "digest", space: "slack:C2" }, limit: 1 });
    expect(other).toHaveLength(1);
    const plain = await p.search({ scope: { kind: "org" }, query: "plain" });
    expect(plain).toHaveLength(1);
  });

  test("FTS5 ranks an exact concise match above a partial document match", async () => {
    expect(ftsAvailable()).toBe(true);
    const db = freshDb();
    createSqliteMemoryProvider(db);
    const insert = db.query(
      "INSERT INTO memories (id, scope, principal, content, metadata_json, created_at) VALUES (?, 'org', NULL, ?, '{}', ?)",
    );
    insert.run("mem_partial", "The project phoenix launch plan contains several unrelated operational details", 2_000);
    insert.run("mem_exact", "project phoenix launch", 1_000);

    const hits = await createSqliteMemoryProvider(db).search({
      scope: { kind: "org" },
      query: "project phoenix launch",
    });
    expect(hits.map((entry) => entry.id)).toEqual(["mem_exact", "mem_partial"]);
  });

  test("FTS5 blends recency into otherwise equal BM25 scores", async () => {
    const now = 90 * 24 * 60 * 60 * 1_000;
    const db = freshDb();
    createSqliteMemoryProvider(db, { now: () => now });
    const insert = db.query(
      "INSERT INTO memories (id, scope, principal, content, metadata_json, created_at) VALUES (?, 'org', NULL, ?, '{}', ?)",
    );
    insert.run("mem_old", "same ranked memory", 0);
    insert.run("mem_recent", "same ranked memory", now);

    const hits = await createSqliteMemoryProvider(db, { now: () => now }).search({
      scope: { kind: "org" },
      query: "same ranked memory",
    });
    expect(hits.map((entry) => entry.id)).toEqual(["mem_recent", "mem_old"]);
  });

  test("forced FTS fallback retains literal LIKE substring behavior", async () => {
    const p = createSqliteMemoryProvider(freshDb(), { forceFtsFallback: true });
    await p.save({ scope: { kind: "org" }, content: "alphabet soup" });
    await p.save({ scope: { kind: "org" }, content: "unrelated" });

    const hits = await p.search({ scope: { kind: "org" }, query: "pha" });
    expect(hits.map((entry) => entry.content)).toEqual(["alphabet soup"]);
  });
});
