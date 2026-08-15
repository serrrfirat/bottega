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
import { createSqliteMemoryProvider } from "./sqlite";
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

runMemoryConformanceTests(() => Promise.resolve(createSqliteMemoryProvider(freshDb())));

describe("sqlite memory backend specifics", () => {
  test("LIKE wildcards in the query are escaped", async () => {
    const p = createSqliteMemoryProvider(freshDb());
    await p.save({ scope: "org", content: "funding at 100% confirmed" });
    await p.save({ scope: "org", content: "funding at 100x confirmed" });
    await p.save({ scope: "org", content: "alpha_beta naming" });
    await p.save({ scope: "org", content: "alphaXbeta naming" });

    const pct = await p.search({ scope: "org", query: "100%" });
    expect(pct.map((e) => e.content)).toEqual(["funding at 100% confirmed"]);
    const underscore = await p.search({ scope: "org", query: "alpha_beta" });
    expect(underscore.map((e) => e.content)).toEqual(["alpha_beta naming"]);
  });

  test("metadata round-trips exactly and filters on multiple keys", async () => {
    const p = createSqliteMemoryProvider(freshDb());
    const saved = await p.save({
      scope: "user",
      principal: "alice",
      content: "key fact",
      metadata: { source: "slack", team: "platform" },
    });
    expect(saved.metadata).toEqual({ source: "slack", team: "platform" });
    expect(saved.principal).toBe("alice");

    const plain = await p.save({ scope: "org", content: "no tags here" });
    expect(plain.metadata).toEqual({});

    const hits = await p.search({
      scope: "user",
      principal: "alice",
      query: "key",
      metadata: { source: "slack", team: "platform" },
    });
    expect(hits.length).toBe(1);
    const miss = await p.search({
      scope: "user",
      principal: "alice",
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
    const hits = await p.search({ scope: "org", query: "entry" });
    expect(hits.map((e) => e.id)).toEqual(["mem_new", "mem_mid", "mem_old"]);
  });

  test("two providers on one file share the same table", async () => {
    const path = join(dir, "shared.db");
    const db1 = new Database(path);
    const p1 = createSqliteMemoryProvider(db1);
    await p1.save({ scope: "org", content: "persisted across connections" });
    db1.close();

    const db2 = new Database(path);
    dbs.push(db2);
    const p2 = createSqliteMemoryProvider(db2);
    const hits = await p2.search({ scope: "org", query: "persisted" });
    expect(hits.length).toBe(1);
    expect(hits[0].content).toBe("persisted across connections");
  });

  test("migration is idempotent across reopenings", async () => {
    const path = join(dir, "reopen.db");
    const db1 = new Database(path);
    const p1 = createSqliteMemoryProvider(db1);
    await p1.save({ scope: "org", content: "survives reopen" });
    db1.close();

    const db2 = new Database(path);
    dbs.push(db2);
    const p2 = createSqliteMemoryProvider(db2);
    const hits = await p2.search({ scope: "org", query: "survives" });
    expect(hits.length).toBe(1);
    expect(hits[0].content).toBe("survives reopen");
  });

  test("works with the store's database handle (getDb)", async () => {
    const store = createStore(join(dir, "store-mem.db"));
    try {
      const p = createSqliteMemoryProvider(store.getDb());
      await p.save({ scope: "org", content: "store-file memory" });
      const hits = await p.search({ scope: "org", query: "store-file" });
      expect(hits.length).toBe(1);
      expect(hits[0].content).toBe("store-file memory");
    } finally {
      store.close();
    }
  });
});
