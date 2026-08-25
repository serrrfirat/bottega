import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./db";
import { MIGRATIONS, runMigrations, type Migration } from "./migrations";

const dirs: string[] = [];
const EXPECTED_MIGRATION_IDS: string[] = [
  "001_create_latest_schema",
  "002_add_work_items_repo",
  "003_add_work_items_delivery",
  "004_add_work_items_pr_context",
  "005_add_work_items_model_pins",
  "006_add_work_items_skills",
  "007_add_work_items_assignee",
  "008_expand_outbox_kinds",
  "009_expand_worker_job_kinds",
  "010_add_spaces_settings",
  "011_add_scheduler_lifecycle",
  "012_add_connection_lifecycle",
  "013_add_audit_search_indexes",
  "014_add_durable_pending_turns",
  "015_add_reactive_core_tables",
  "016_add_work_item_forks",
] as const;

function tempDb(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bottega-migrations-"));
  dirs.push(dir);
  return join(dir, name);
}

function ledgerIds(db: Database): string[] {
  // SAFETY: this fixed SELECT returns rows with exactly one text id column.
  return (db.query("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>).map(
    ({ id }) => id,
  );
}

/** One table's structural snapshot as read from sqlite_master + PRAGMA metadata. */
interface TableSchemaSnapshot {
  columns: Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
  foreignKeys: unknown[];
  indexes: Array<{ name: string; unique: number; partial: number; columns: string[] }>;
}

function schemaSnapshot(db: Database): Record<string, TableSchemaSnapshot> {
  const tables = (
  // SAFETY: this fixed sqlite_master query returns rows with exactly one text name column.
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);

  return Object.fromEntries(
    tables.map((table) => {
  // SAFETY: PRAGMA table_info returns one row per declared column with exactly these metadata columns.
      const columns = (
        db.query(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>
      )
        .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const foreignKeys = db.query(`PRAGMA foreign_key_list(${JSON.stringify(table)})`).all();
  // SAFETY: PRAGMA index_list/index_info return fixed metadata column sets;
  // only name/unique/partial and the per-index name column are read.
      const indexes = (
        db.query(`PRAGMA index_list(${JSON.stringify(table)})`).all() as Array<{ name: string; unique: number; partial: number }>
      )
        .filter(({ name }) => !name.startsWith("sqlite_autoindex_"))
        .map(({ name, unique, partial }) => ({
          name,
          unique,
          partial,
          columns: (db.query(`PRAGMA index_info(${JSON.stringify(name)})`).all() as Array<{ name: string }>).map(
            (column) => column.name,
          ),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return [table, { columns, foreignKeys, indexes }];
    }),
  );
}

function createPreLedgerLegacyDatabase(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      name TEXT,
      policy_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id),
      requester TEXT NOT NULL,
      description TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','claimed','working','review','done','blocked','aborted')),
      approvals TEXT NOT NULL DEFAULT '[]',
      evidence TEXT NOT NULL DEFAULT '[]',
      result TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('git','extension','kb','scheduled')),
      payload TEXT NOT NULL,
      space TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      posted_at INTEGER
    );
    CREATE TABLE worker_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('git','extension','kb','scheduled')),
      payload TEXT NOT NULL,
      space_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO spaces VALUES ('slack:legacy', 'slack', 'legacy', 'Legacy', '{"tools":{}}', 1, 2);
    INSERT INTO work_items VALUES ('wi_legacy', 'slack:legacy', 'U1', 'keep me', 'open', '[]', '[]', NULL, 3, 4);
    INSERT INTO outbox VALUES ('out_legacy', 'git', '{"ok":true}', 'slack:legacy', 'pending', 1, 5, NULL);
    INSERT INTO worker_jobs VALUES ('job_legacy', 'git', '{"task":true}', 'slack:legacy', 'queued', 2, NULL, 6, 7);
  `);
  db.close();
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ordered SQLite migrations", () => {
  test("fresh creation applies the complete ordered history", () => {
    const store = createStore(tempDb("fresh.db"));
    expect(ledgerIds(store.getDb())).toEqual(EXPECTED_MIGRATION_IDS);
    store.close();
  });

  test("a pre-ledger database preserves data, converges on the fresh schema, and reopens without rerunning", async () => {
    const legacyPath = tempDb("legacy.db");
    const freshPath = tempDb("canonical.db");
    createPreLedgerLegacyDatabase(legacyPath);

    const upgraded = createStore(legacyPath);
    // SAFETY: the migration runner owns this ledger schema and the query selects its three typed columns.
    const firstLedger = upgraded
      .getDb()
      .query("SELECT rowid, id, applied_at FROM schema_migrations ORDER BY rowid")
      .all() as Array<{ rowid: number; id: string; applied_at: number }>;
    expect(firstLedger.map(({ id }) => id)).toEqual(EXPECTED_MIGRATION_IDS);
    expect(await upgraded.getWorkItem("wi_legacy")).toMatchObject({ requester: "U1", assignee: "U1", delivery: "git" });
    expect(upgraded.getDb().query("SELECT * FROM outbox WHERE id = 'out_legacy'").get()).toMatchObject({ attempts: 1 });
    expect(upgraded.getDb().query("SELECT * FROM worker_jobs WHERE id = 'job_legacy'").get()).toMatchObject({ attempts: 2 });

    const fresh = createStore(freshPath);
    expect(schemaSnapshot(upgraded.getDb())).toEqual(schemaSnapshot(fresh.getDb()));
    fresh.close();
    upgraded.close();

    const reopened = createStore(legacyPath);
    expect(
      reopened.getDb().query("SELECT rowid, id, applied_at FROM schema_migrations ORDER BY rowid").all(),
    ).toEqual(firstLedger);
    expect(await reopened.getWorkItem("wi_legacy")).toMatchObject({ requester: "U1", assignee: "U1" });
    reopened.close();
  });

  test("an existing migration ledger receives the audit search indexes", () => {
    const path = tempDb("pre-audit-indexes.db");
    const store = createStore(path);
    const db = store.getDb();
    db.exec(`
      DROP INDEX idx_audit_event_ts;
      DROP INDEX idx_audit_space_ts;
      DROP INDEX idx_audit_actor_ts;
      -- Roll the ledger back to a genuine PRE-013 state: drop 013 AND any
      -- later migrations (014, 015, 016) so the remaining ledger [001..012]
      -- can re-apply 013..016 with no index gap (issue #312 extends the
      -- history past 013; #356 past 014; #358 past that).
      DELETE FROM schema_migrations WHERE id IN ('013_add_audit_search_indexes', '014_add_durable_pending_turns', '015_add_reactive_core_tables', '016_add_work_item_forks');
    `);
    store.close();

    const upgraded = createStore(path);
    // SAFETY: this fixed sqlite_master query returns rows with exactly one text name column.
    const indexes = upgraded
      .getDb()
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_audit_%_ts' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(indexes.map(({ name }) => name)).toEqual([
      "idx_audit_actor_ts",
      "idx_audit_event_ts",
      "idx_audit_space_ts",
    ]);
    // 013 (and the later migrations) were re-applied to a ledger that ended
    // at 012; the backfill runs through the current tail (#358's fork columns).
    expect(ledgerIds(upgraded.getDb())).toContain("013_add_audit_search_indexes");
    expect(ledgerIds(upgraded.getDb()).at(-1)).toBe("016_add_work_item_forks");
    upgraded.close();
  });

  test("an existing ledger receives the durable pending_turns table (issue #312)", async () => {
    const path = tempDb("pre-pending-turns.db");
    const store = createStore(path);
    const db = store.getDb();
    db.exec(`
      DROP TABLE pending_turns;
      DELETE FROM schema_migrations WHERE id IN ('014_add_durable_pending_turns', '015_add_reactive_core_tables', '016_add_work_item_forks');
    `);
    store.close();

    const upgraded = createStore(path);
    // SAFETY: this fixed sqlite_master query returns rows with exactly one type/name column.
    const tableNames = upgraded
      .getDb()
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_turns'")
      .all() as Array<{ name: string }>;
    expect(tableNames.map(({ name }) => name)).toEqual(["pending_turns"]);
    // SAFETY: PRAGMA table_info returns one row per declared column with exactly these metadata columns.
    const columns = (
      upgraded.getDb().query("PRAGMA table_info(pending_turns)").all() as Array<{ name: string }>
    ).map(({ name }) => name);
    // The durable identity + lifecycle columns all land: id, space_id, ts,
    // principal, text, root_thread_ts, the three statuses' columns.
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "space_id",
        "ts",
        "principal",
        "text",
        "root_thread_ts",
        "status",
        "claimed_at",
        "lease_until",
        "completed_at",
      ]),
    );
    // SAFETY: this fixed sqlite_master query returns rows with exactly one name column.
    const indexNames = upgraded
      .getDb()
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_pending_turns_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    // The UNIQUE(space_id, ts) identity index (issue #312 dedupe) and the
    // recover index both land when 014 re-runs on an older ledger.
    expect(indexNames.map(({ name }) => name)).toEqual([
      "idx_pending_turns_identity",
      "idx_pending_turns_recover",
    ]);
    // The durable rows are usable end-to-end on the backfilled ledger.
    await upgraded.enqueuePendingTurn({ spaceId: "slack:C1", ts: "1.1", principal: "U1", text: "backfilled" });
    expect(await upgraded.listPendingTurns("slack:C1")).toHaveLength(1);
    expect(ledgerIds(upgraded.getDb()).at(-1)).toBe("016_add_work_item_forks");
    upgraded.close();
  });

  test("a failed migration rolls back its schema, data, and version row, then retries safely", () => {
    const path = tempDb("rollback.db");
    const db = new Database(path);
    const failing: readonly Migration[] = [
      {
        id: "001_create_probe",
        up(database) {
          database.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
        },
      },
      {
        id: "002_injected_failure",
        up(database) {
          database.exec("ALTER TABLE probe ADD COLUMN transient TEXT");
          database.exec("INSERT INTO probe (id, value, transient) VALUES (1, 'partial', 'partial')");
          throw new Error("injected failure");
        },
      },
    ];

    expect(() => runMigrations(db, failing)).toThrow("migration 002_injected_failure failed: injected failure");
    expect(ledgerIds(db)).toEqual(["001_create_probe"]);
    // SAFETY: PRAGMA table_info(probe) returns one row per surviving column; only name is read.
    expect((db.query("PRAGMA table_info(probe)").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual([
      "id",
      "value",
    ]);
    expect(db.query("SELECT COUNT(*) AS count FROM probe").get()).toEqual({ count: 0 });

    const fixed: readonly Migration[] = [
      failing[0]!,
      {
        id: "002_injected_failure",
        up(database) {
          database.exec("ALTER TABLE probe ADD COLUMN recovered TEXT");
          database.exec("INSERT INTO probe (id, value, recovered) VALUES (1, 'complete', 'safe')");
        },
      },
    ];
    runMigrations(db, fixed);
    expect(ledgerIds(db)).toEqual(["001_create_probe", "002_injected_failure"]);
    expect(db.query("SELECT id, value, recovered FROM probe").get()).toEqual({ id: 1, value: "complete", recovered: "safe" });
    db.close();
  });

  test("unknown and inconsistent ledger entries fail closed with the offending migration ID", () => {
    const unknownPath = tempDb("unknown.db");
    const unknownStore = createStore(unknownPath);
    unknownStore.close();
    const unknownDb = new Database(unknownPath);
    unknownDb.query("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run("999_future", Date.now());
    unknownDb.close();
    expect(() => createStore(unknownPath)).toThrow("unknown migration ID: 999_future");

    const inconsistentPath = tempDb("inconsistent.db");
    const inconsistentStore = createStore(inconsistentPath);
    inconsistentStore.close();
    const inconsistentDb = new Database(inconsistentPath);
    const missingId = MIGRATIONS[1]!.id;
    const offendingId = MIGRATIONS[2]!.id;
    inconsistentDb.query("DELETE FROM schema_migrations WHERE id = ?").run(missingId);
    inconsistentDb.close();
    expect(() => createStore(inconsistentPath)).toThrow(`inconsistent migration ID: ${offendingId}`);
  });
});
