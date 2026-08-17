import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consolidatePool,
  maintainMemory,
  MEMORY_CONSOLIDATION_PROMPT,
  parseConsolidationActions,
} from "./consolidation";
import { createSqliteMemoryProvider } from "./sqlite";

const dir = mkdtempSync(join(tmpdir(), "bottega-mem-consolidation-"));
const dbs: Database[] = [];

function freshDb(): Database {
  const db = new Database(join(dir, `consolidation-${dbs.length}.db`));
  dbs.push(db);
  createSqliteMemoryProvider(db);
  return db;
}

function memoryRows(db: Database): Array<{
  scope: string;
  principal: string | null;
  content: string;
  metadata_json: string;
}> {
  // SAFETY: the query selects exactly these four columns, so every row carries them.
  return db
    .query(
      `SELECT scope, principal, content, metadata_json
       FROM memories
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all() as Array<{
    scope: string;
    principal: string | null;
    content: string;
    metadata_json: string;
  }>;
}

afterAll(() => {
  for (const db of dbs) db.close();
});

describe("SQLite memory consolidation", () => {
  test("parses only explicit deterministic UPDATE, DELETE, and ADD actions", () => {
    expect(
      parseConsolidationActions(
        "UPDATE 1 revised fact\nDELETE 2\nADD new fact\nUPDATE x nope\nfree-form prose\nNONE",
      ),
    ).toEqual([
      { kind: "update", index: 1, text: "revised fact" },
      { kind: "delete", index: 2 },
      { kind: "add", text: "new fact" },
    ]);
  });

  test("applies UPDATE, DELETE, and ADD and advances the pool marker", async () => {
    const db = freshDb();
    const insert = db.query(
      "INSERT INTO memories (id, scope, principal, content, metadata_json, created_at) VALUES (?, 'org', NULL, ?, ?, ?)",
    );
    insert.run("mem_1", "The team deploys on Tuesdays", JSON.stringify({ source: "slack" }), 1);
    insert.run("mem_2", "Duplicate deployment note", "{}", 2);
    insert.run("mem_3", "The support rotation starts Monday", "{}", 3);

    let calls = 0;
    const result = await consolidatePool(
      db,
      { scope: "org" },
      async (systemPrompt, input) => {
        calls++;
        expect(systemPrompt).toBe(MEMORY_CONSOLIDATION_PROMPT);
        expect(systemPrompt).toContain("UPDATE <index> <revised fact>");
        expect(input).toContain("1. The team deploys on Tuesdays");
        expect(input).toContain("Facts since the last compaction marker:");
        return "UPDATE 1 The team deploys on Wednesdays\nDELETE 2\nADD Release notes are posted after deployment";
      },
      { compactAfter: 3, now: () => 10_000 },
    );

    expect(calls).toBe(1);
    expect(result).toEqual({
      pool: { scope: "org" },
      newFacts: 3,
      compacted: true,
      actionsApplied: 3,
    });

    const rows = memoryRows(db);
    expect(rows.map((row) => row.content)).toEqual([
      "The team deploys on Wednesdays",
      "The support rotation starts Monday",
      "Release notes are posted after deployment",
    ]);
    expect(JSON.parse(rows[0]!.metadata_json)).toEqual({
      source: "slack",
      superseded: "The team deploys on Tuesdays",
    });
    expect(JSON.parse(rows[2]!.metadata_json)).toEqual({
      source: "consolidation",
      consolidated: "1",
    });

    // SAFETY: consolidatePool writes this marker row before returning, and the query selects exactly these two columns.
    const marker = db
      .query(
        "SELECT last_rowid, compacted_at FROM memory_compaction_state WHERE scope = 'org' AND principal_key = ''",
      )
      .get() as { last_rowid: number; compacted_at: number };
    expect(marker).toEqual({ last_rowid: 3, compacted_at: 10_000 });

    const second = await consolidatePool(
      db,
      { scope: "org" },
      async () => {
        calls++;
        return "DELETE 1";
      },
      { compactAfter: 1 },
    );
    expect(second).toEqual({
      pool: { scope: "org" },
      newFacts: 0,
      compacted: false,
      actionsApplied: 0,
    });
    expect(calls).toBe(1);
  });

  test("maintainMemory compacts each eligible org or principal pool in isolation", async () => {
    const db = freshDb();
    const insert = db.query(
      "INSERT INTO memories (id, scope, principal, content, metadata_json, created_at) VALUES (?, ?, ?, ?, '{}', ?)",
    );
    insert.run("org_1", "org", null, "org first", 1);
    insert.run("org_2", "org", null, "org second", 2);
    insert.run("alice_1", "user", "alice", "alice first", 3);
    insert.run("alice_2", "user", "alice", "alice second", 4);
    insert.run("bob_1", "user", "bob", "bob only", 5);

    const inputs: string[] = [];
    const results = await maintainMemory(
      db,
      async (_systemPrompt, input) => {
        inputs.push(input);
        return "NONE";
      },
      { compactAfter: 2, now: () => 20_000 },
    );

    expect(results.map((result) => result.pool)).toEqual([
      { scope: "org" },
      { scope: "user", principal: "alice" },
    ]);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain("org first");
    expect(inputs[0]).not.toContain("alice first");
    expect(inputs[1]).toContain("alice first");
    expect(inputs[1]).not.toContain("org first");
    expect(inputs.join("\n")).not.toContain("bob only");

    const markers = db
      .query(
        `SELECT scope, principal_key
         FROM memory_compaction_state
         ORDER BY scope ASC, principal_key ASC`,
      )
      .all();
    expect(markers).toEqual([
      { scope: "org", principal_key: "" },
      { scope: "user", principal_key: "alice" },
    ]);
  });
});
