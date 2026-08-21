import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Migration = {
  readonly id: string;
  readonly up: (db: Database) => void;
};

const latestSchema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id         TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )
`;

function columnNames(db: Database, table: string): string[] {
  // SAFETY: table names are migration-owned constants, and PRAGMA table_info always exposes a name column.
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
}

function tableSql(db: Database, table: string): string {
  // SAFETY: table names are migration-owned constants, and the initial schema migration creates these tables first.
  const row = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
    sql: string;
  } | null;
  if (!row) throw new Error(`required table is missing: ${table}`);
  return row.sql;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "001_create_latest_schema",
    up(db) {
      db.exec(latestSchema);
    },
  },
  {
    id: "002_add_work_items_repo",
    up(db) {
      if (!columnNames(db, "work_items").includes("repo")) {
        db.exec("ALTER TABLE work_items ADD COLUMN repo TEXT");
      }
    },
  },
  {
    id: "003_add_work_items_delivery",
    up(db) {
      if (!columnNames(db, "work_items").includes("delivery")) {
        db.exec(
          "ALTER TABLE work_items ADD COLUMN delivery TEXT NOT NULL DEFAULT 'git' CHECK (delivery IN ('git','extension','chat'))",
        );
      }
    },
  },
  {
    id: "004_add_work_items_pr_context",
    up(db) {
      const columns = columnNames(db, "work_items");
      if (!columns.includes("pr_url")) db.exec("ALTER TABLE work_items ADD COLUMN pr_url TEXT");
      if (!columns.includes("pr_branch")) db.exec("ALTER TABLE work_items ADD COLUMN pr_branch TEXT");
      if (!columns.includes("base_branch")) db.exec("ALTER TABLE work_items ADD COLUMN base_branch TEXT");
    },
  },
  {
    id: "005_add_work_items_model_pins",
    up(db) {
      const columns = columnNames(db, "work_items");
      if (!columns.includes("model")) db.exec("ALTER TABLE work_items ADD COLUMN model TEXT");
      if (!columns.includes("reasoning_effort")) {
        db.exec(
          "ALTER TABLE work_items ADD COLUMN reasoning_effort TEXT CHECK (reasoning_effort IN ('off','low','medium','high'))",
        );
      }
    },
  },
  {
    id: "006_add_work_items_skills",
    up(db) {
      if (!columnNames(db, "work_items").includes("skills")) {
        db.exec("ALTER TABLE work_items ADD COLUMN skills TEXT NOT NULL DEFAULT '[]'");
      }
    },
  },
  {
    id: "007_add_work_items_assignee",
    up(db) {
      if (!columnNames(db, "work_items").includes("assignee")) {
        db.exec("ALTER TABLE work_items ADD COLUMN assignee TEXT");
        db.exec("UPDATE work_items SET assignee = requester WHERE assignee IS NULL");
      }
    },
  },
  {
    id: "008_expand_outbox_kinds",
    up(db) {
      if (tableSql(db, "outbox").includes("'ingest_poll'")) return;
      db.exec(`
        ALTER TABLE outbox RENAME TO outbox_old;
        CREATE TABLE outbox (
          id         TEXT PRIMARY KEY,
          kind       TEXT NOT NULL CHECK (kind IN ('git','extension','kb','scheduled','work_item','ingest_poll')),
          payload    TEXT NOT NULL,
          space      TEXT,
          status     TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','posted','failed')),
          attempts   INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          posted_at  INTEGER
        );
        INSERT INTO outbox (id, kind, payload, space, status, attempts, created_at, posted_at)
          SELECT id, kind, payload, space, status, attempts, created_at, posted_at FROM outbox_old;
        DROP TABLE outbox_old;
        CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox(status, created_at);
      `);
    },
  },
  {
    id: "009_expand_worker_job_kinds",
    up(db) {
      if (tableSql(db, "worker_jobs").includes("'ingest_poll'")) return;
      db.exec(`
        ALTER TABLE worker_jobs RENAME TO worker_jobs_old;
        CREATE TABLE worker_jobs (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL CHECK (kind IN ('git','extension','kb','scheduled','ingest_poll')),
          payload     TEXT NOT NULL,
          space_id    TEXT,
          status      TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','completed','failed')),
          attempts    INTEGER NOT NULL DEFAULT 0,
          lease_until INTEGER,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        INSERT INTO worker_jobs (id, kind, payload, space_id, status, attempts, lease_until, created_at, updated_at)
          SELECT id, kind, payload, space_id, status, attempts, lease_until, created_at, updated_at FROM worker_jobs_old;
        DROP TABLE worker_jobs_old;
        CREATE INDEX IF NOT EXISTS idx_worker_jobs_queue ON worker_jobs(status, created_at);
      `);
    },
  },
  {
    id: "010_add_spaces_settings",
    up(db) {
      if (!columnNames(db, "spaces").includes("settings")) {
        db.exec("ALTER TABLE spaces ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
      }
    },
  },
  {
    id: "011_add_scheduler_lifecycle",
    up(db) {
      if (!columnNames(db, "scheduler_jobs").includes("revision")) {
        db.exec("ALTER TABLE scheduler_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS scheduler_invocations (
          id            TEXT PRIMARY KEY,
          job_id        TEXT NOT NULL,
          action        TEXT NOT NULL,
          params        TEXT NOT NULL,
          space_id      TEXT,
          source        TEXT NOT NULL CHECK (source IN ('scheduled','manual')),
          scheduled_for INTEGER,
          requested_at  INTEGER NOT NULL,
          job_revision  INTEGER NOT NULL,
          status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','completed')),
          claimed_at    INTEGER,
          completed_at  INTEGER,
          result        TEXT CHECK (result IN ('ok','error'))
        );
        CREATE INDEX IF NOT EXISTS idx_scheduler_invocations_claim
          ON scheduler_invocations(status, requested_at, id);
        CREATE INDEX IF NOT EXISTS idx_scheduler_invocations_job
          ON scheduler_invocations(job_id, requested_at, id);
      `);
    },
  },
  {
    id: "012_add_connection_lifecycle",
    up(db) {
      const connectionColumns = columnNames(db, "extension_credentials");
      if (!connectionColumns.includes("vault_provider")) {
        db.exec("ALTER TABLE extension_credentials ADD COLUMN vault_provider TEXT NOT NULL DEFAULT ''");
        db.exec("UPDATE extension_credentials SET vault_provider = provider WHERE vault_provider = ''");
      }
      if (!connectionColumns.includes("pending_vault_provider")) {
        db.exec("ALTER TABLE extension_credentials ADD COLUMN pending_vault_provider TEXT");
      }
      if (!connectionColumns.includes("pending_broker_credential_id")) {
        db.exec("ALTER TABLE extension_credentials ADD COLUMN pending_broker_credential_id INTEGER");
      }
      if (!connectionColumns.includes("pending_identity_key")) {
        db.exec("ALTER TABLE extension_credentials ADD COLUMN pending_identity_key TEXT");
      }
      if (!connectionColumns.includes("retiring_broker_credential_id")) {
        db.exec("ALTER TABLE extension_credentials ADD COLUMN retiring_broker_credential_id INTEGER");
      }
      if (!connectionColumns.includes("status")) {
        db.exec(
          "ALTER TABLE extension_credentials ADD COLUMN status TEXT NOT NULL DEFAULT 'active' " +
            "CHECK (status IN ('active','replacing','replace_cleanup_pending','disconnecting_boundary','disconnecting_authority','disconnected'))",
        );
      }
      if (!connectionColumns.includes("revision")) {
        db.exec("ALTER TABLE extension_credentials ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
      }
      if (!connectionColumns.includes("updated_at")) {
        db.exec("ALTER TABLE extension_credentials ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
        db.exec("UPDATE extension_credentials SET updated_at = created_at WHERE updated_at = 0");
      }

      const uploadTokenColumns = columnNames(db, "upload_tokens");
      if (!uploadTokenColumns.includes("connection_id")) {
        db.exec("ALTER TABLE upload_tokens ADD COLUMN connection_id TEXT");
      }
      if (!uploadTokenColumns.includes("expected_revision")) {
        db.exec("ALTER TABLE upload_tokens ADD COLUMN expected_revision INTEGER");
      }
    },
  },
];

function assertValidRegistry(migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  let previous = "";
  for (const migration of migrations) {
    if (!/^\d{3}_[a-z0-9_]+$/.test(migration.id)) throw new Error(`invalid migration ID: ${migration.id}`);
    if (seen.has(migration.id)) throw new Error(`duplicate migration ID: ${migration.id}`);
    if (migration.id <= previous) throw new Error(`out-of-order migration ID: ${migration.id}`);
    seen.add(migration.id);
    previous = migration.id;
  }
}

function appliedMigrationIds(db: Database): string[] {
  // SAFETY: the runner owns the ledger schema and reads its TEXT primary key only.
  return (db.query("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>).map(({ id }) => id);
}

function assertConsistentLedger(appliedIds: readonly string[], migrations: readonly Migration[]): void {
  const knownIds = new Set(migrations.map(({ id }) => id));
  for (const [index, id] of appliedIds.entries()) {
    if (!knownIds.has(id)) throw new Error(`unknown migration ID: ${id}`);
    if (migrations[index]?.id !== id) throw new Error(`inconsistent migration ID: ${id}`);
  }
}

export function runMigrations(db: Database, migrations: readonly Migration[] = MIGRATIONS): void {
  assertValidRegistry(migrations);
  db.exec(LEDGER_SQL);

  const appliedIds = appliedMigrationIds(db);
  assertConsistentLedger(appliedIds, migrations);

  for (const [index, migration] of migrations.entries()) {
    if (index < appliedIds.length) continue;
    const apply = db.transaction(() => {
      // Re-read after BEGIN IMMEDIATE so two booting processes cannot apply
      // the same pending migration from stale pre-transaction ledger reads.
      const currentIds = appliedMigrationIds(db);
      assertConsistentLedger(currentIds, migrations);
      if (currentIds.length > index) return;
      if (currentIds.length < index) {
        throw new Error(`inconsistent migration ID: ${migration.id}`);
      }
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, Date.now());
    });
    try {
      apply.immediate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`migration ${migration.id} failed: ${message}`, { cause: error });
    }
  }
}
