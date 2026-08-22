/**
 * SQLite memory backend (memory epic, issues #20, #155, and #321).
 *
 * Default MemoryProvider for per-org self-hosted bottega. The provider
 * borrows the store's Database handle and keeps memories in the same SQLite
 * file (`data/bottega.db`), with zero external services. Save, search,
 * capability reporting, derived-digest retention, and forget-with-tombstone
 * all stay behind the MemoryProvider seam (issue #163).
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  MEMORY_LIMIT_DEFAULT,
  decodeScopeKey,
  deriveProvenance,
  encodeScopeKey,
  scopeKeyLabel,
  validateForgetInput,
  validateSaveInput,
  validateSearchQuery,
  type MemoryEntry,
  type MemoryForgetInput,
  type MemoryProvider,
  type MemorySaveInput,
  type MemoryScopeKey,
  type MemorySearchQuery,
  type MemoryTombstone,
} from "./types";

/** Idempotent base migration: same file as the store, provider-owned table. */
const BASE_MIGRATION = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('org', 'user')),
  principal TEXT,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_scope_principal ON memories (scope, principal);
`;

/**
 * Idempotent provenance columns (#163). Existing databases created before the
 * columns existed get them added; fresh creates already include them via the
 * base migration. Guarded by PRAGMA table_info so it is safe to re-run.
 */
const PROVENANCE_COLUMNS = new Set(["mem_source", "mem_space_id", "mem_principal", "mem_scope_label"]);

/** Adds any missing provenance columns (idempotent for fresh + legacy DBs). */
function migrateProvenanceColumns(db: Database): void {
  const existing = new Set(
    // SAFETY: PRAGMA table_info always returns one row per table column, and
    // every row carries a non-null `name` field, so each row matches { name: string }.
    (db.query("PRAGMA table_info(memories)").all() as { name: string }[]).map((row) => row.name),
  );
  const missing = [...PROVENANCE_COLUMNS].filter((column) => !existing.has(column));
  for (const column of missing) {
    db.exec(`ALTER TABLE memories ADD COLUMN ${column} TEXT`);
  }
}

/**
 * Tombstone table (#163). A forgotten entry's row is moved/duplicated here
 * so the memory is never recalled and never silently hard-deleted — the
 * tombstone is the durable record of the forget.
 */
const TOMBSTONE_MIGRATION = `
CREATE TABLE IF NOT EXISTS memory_tombstones (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('org', 'user')),
  principal TEXT,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  mem_source TEXT,
  mem_space_id TEXT,
  mem_principal TEXT,
  mem_scope_label TEXT,
  forgotten_at INTEGER NOT NULL
);
`;

/**
 * External-content FTS keeps one canonical copy in `memories`. The triggers
 * also cover storage-management writes made outside the provider.
 */
const FTS_MIGRATION = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content = 'memories',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

const RECENCY_WEIGHT = 0.15;
const RECENCY_DECAY_MS = 30 * 24 * 60 * 60 * 1_000;

let detectedFtsAvailability: boolean | undefined;

/** Whether this Bun SQLite build includes FTS5. The result is cached per process. */
export function ftsAvailable(): boolean {
  if (detectedFtsAvailability !== undefined) return detectedFtsAvailability;
  const probe = new Database(":memory:");
  try {
    probe.exec("CREATE VIRTUAL TABLE fts5_probe USING fts5(content, tokenize = 'unicode61')");
    detectedFtsAvailability = true;
  } catch {
    detectedFtsAvailability = false;
  } finally {
    probe.close();
  }
  return detectedFtsAvailability;
}

export interface SqliteMemoryOptions {
  /** Test/deployment escape hatch; production normally relies on feature detection. */
  forceFtsFallback?: boolean;
  /** Injectable clock for deterministic ranking tests. */
  now?: () => number;
}

type MemoryRow = {
  id: string;
  scope: string;
  principal: string | null;
  content: string;
  metadata_json: string;
  created_at: number;
  mem_source: string | null;
  mem_space_id: string | null;
  mem_principal: string | null;
  mem_scope_label: string | null;
};

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    // SAFETY: rows are written through validateSaveInput with a logical
    // scope key; decodeScopeKey is total over every persisted (scope,
    // principal) pair (legacy user rows decode to person).
    key: decodeScopeKey(row.scope as "org" | "user", row.principal),
    content: row.content,
    // SAFETY: save() writes metadata_json from the validated metadata map (string values), so parsing a stored row's JSON yields a string map.
    metadata: JSON.parse(row.metadata_json) as Record<string, string>,
    createdAt: row.created_at,
    provenance: {
      source: row.mem_source ?? "tool",
      spaceId: row.mem_space_id,
      principal: row.mem_principal,
      scopeLabel: row.mem_scope_label ?? scopeLabelFallback(
        // SAFETY: the scope column only ever stores the literal 'org' or 'user'
        // values written by save() (via encodeScopeKey) or the migration default,
        // so casting it to that union is safe.
        row.scope as "org" | "user",
        row.principal,
      ),
    },
  };
}

/** Fallback label for legacy rows persisted before provenance columns existed. */
function scopeLabelFallback(scope: "org" | "user", principal: string | null): string {
  return decodeScopeKey(scope, principal).kind === "org" ? "org" : principal ?? "person";
}

/** Escapes LIKE wildcards so user input matches literally (ESCAPE '\' in SQL). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Converts untrusted text to a literal unicode61 token conjunction. */
function toFtsQuery(value: string): string | null {
  const tokens = value.match(/[\p{L}\p{N}]+/gu);
  return tokens?.length ? tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ") : null;
}

/**
 * SQLite's narrow digest-retention operation. It removes only derived digest
 * rows beyond the newest `keep` for one space. The source transcript remains
 * durable; this is not a general memory deletion path.
 */
function pruneSqliteDigests(db: Database, spaceId: string, keep: number): number {
  const deleted = db
    .query(
      `DELETE FROM memories
       WHERE id IN (
         SELECT id FROM memories
         WHERE metadata_json LIKE '%"kind":"digest"%' ESCAPE '\\'
           AND metadata_json LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC, rowid DESC
         LIMIT -1 OFFSET ?
       )
       RETURNING id`,
    )
    .all(`%"space":"${escapeLike(spaceId)}"%`, keep);
  // Bun's run().changes includes FTS5 shadow-table work performed by the
  // delete trigger. RETURNING counts only the canonical memory rows.
  return deleted.length;
}

export function createSqliteMemoryProvider(
  db: Database,
  options: SqliteMemoryOptions = {},
): MemoryProvider {
  db.exec(BASE_MIGRATION);
  migrateProvenanceColumns(db);
  db.exec(TOMBSTONE_MIGRATION);
  const useFts = !options.forceFtsFallback && ftsAvailable();
  if (useFts) {
    db.exec(FTS_MIGRATION);
    // Backfill databases created before the FTS migration. Rebuild is
    // idempotent and also repairs an interrupted trigger write.
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
  }

  const insertStmt = db.query(
    `INSERT INTO memories (id, scope, principal, content, metadata_json, created_at,
        mem_source, mem_space_id, mem_principal, mem_scope_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = options.now ?? Date.now;

  const capabilities = {
    consolidation: "explicit",
    digestPruning: "explicit",
    forget: "explicit",
  } as const;

  // NOTE: plain functions, not async — validators must throw synchronously so
  // callers can rely on validation errors surfacing without awaiting.

  function save(input: MemorySaveInput): Promise<MemoryEntry> {
    validateSaveInput(input);
    const id = `mem_${randomUUID()}`;
    const physical = encodeScopeKey(input.scope);
    const createdAt = now();
    const provenance = deriveProvenance(input.scope, input.source, null, null);
    insertStmt.run(
      id,
      physical.scope,
      physical.principal,
      input.content,
      JSON.stringify(input.metadata ?? {}),
      createdAt,
      provenance.source,
      provenance.spaceId,
      provenance.principal,
      provenance.scopeLabel,
    );
    return Promise.resolve({
      id,
      key: input.scope,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt,
      provenance,
    });
  }

  function pruneDigests(spaceId: string, keep: number): Promise<number> {
    if (!spaceId) {
      throw new Error("memory.pruneDigests: space id must be non-empty");
    }
    if (!Number.isInteger(keep) || keep < 1) {
      throw new Error("memory.pruneDigests: keep must be a positive integer");
    }
    return Promise.resolve(pruneSqliteDigests(db, spaceId, keep));
  }

  function filterAndLimit(rows: MemoryRow[], query: MemorySearchQuery): MemoryEntry[] {
    // Metadata exact-match stays in JS. This avoids constructing JSON paths
    // from caller-controlled keys and is correct for every valid key.
    const metadata = query.metadata ?? {};
    const matched =
      Object.keys(metadata).length === 0
        ? rows
        : rows.filter((row) => {
            // SAFETY: stored rows' metadata_json is always a JSON object of string values (validated at save).
            const rowMetadata = JSON.parse(row.metadata_json) as Record<string, string>;
            return Object.entries(metadata).every(([key, value]) => rowMetadata[key] === value);
          });
    return matched.slice(0, query.limit ?? MEMORY_LIMIT_DEFAULT).map(rowToEntry);
  }

  function likeRows(query: MemorySearchQuery): MemoryRow[] {
    const physical = encodeScopeKey(query.scope);
    const clauses = ["scope = ?", "content LIKE ? ESCAPE '\\'"];
    const params: (string | number)[] = [physical.scope, `%${escapeLike(query.query)}%`];
    if (physical.scope === "user" && physical.principal !== null) {
      clauses.push("principal = ?");
      params.push(physical.principal);
    }
    // SAFETY: the SELECT column list exactly matches MemoryRow; bun:sqlite returns plain objects with those columns.
    return db
      .query(
        `SELECT id, scope, principal, content, metadata_json, created_at,
                mem_source, mem_space_id, mem_principal, mem_scope_label
         FROM memories
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...params) as MemoryRow[];
  }

  function ftsRows(query: MemorySearchQuery, match: string): MemoryRow[] {
    const physical = encodeScopeKey(query.scope);
    const clauses = ["memories_fts MATCH ?", "m.scope = ?"];
    const params: (string | number)[] = [
      RECENCY_WEIGHT,
      RECENCY_DECAY_MS,
      RECENCY_DECAY_MS,
      now(),
      match,
      physical.scope,
    ];
    if (physical.scope === "user" && physical.principal !== null) {
      clauses.push("m.principal = ?");
      params.push(physical.principal);
    }
    // SAFETY: the SELECT column list exactly matches MemoryRow; bun:sqlite returns plain objects with those columns (blended_rank is an extra column the cast ignores).
    return db
      .query(
        `SELECT m.id, m.scope, m.principal, m.content, m.metadata_json, m.created_at,
                m.mem_source, m.mem_space_id, m.mem_principal, m.mem_scope_label,
                bm25(memories_fts) *
                  (1.0 + ? * (? / (? + MAX(? - m.created_at, 0)))) AS blended_rank
         FROM memories_fts
         JOIN memories AS m ON m.rowid = memories_fts.rowid
         WHERE ${clauses.join(" AND ")}
         ORDER BY blended_rank ASC, m.created_at DESC, m.rowid DESC`,
      )
      .all(...params) as MemoryRow[];
  }

  function search(query: MemorySearchQuery): Promise<MemoryEntry[]> {
    validateSearchQuery(query);
    const match = useFts ? toFtsQuery(query.query) : null;
    // Empty/ punctuation-only metadata searches cannot form an FTS MATCH
    // expression. They retain the old literal LIKE behavior.
    const rows = match ? ftsRows(query, match) : likeRows(query);
    return Promise.resolve(filterAndLimit(rows, query));
  }

  /**
   * Forget-with-tombstone (#163): moves the row OUT of `memories` (so it is
   * never recalled or re-injected) and INTO `memory_tombstones` (a durable
   * record of the forget). Never a silent hard-delete. The entry id and its
   * physical scope must both match for the forget to succeed — a caller can
   * never forget another scope's entry by id alone.
   */
  function forget(input: MemoryForgetInput): Promise<MemoryTombstone> {
    validateForgetInput(input);
    const physical = encodeScopeKey(input.scope);
    const forgottenAt = now();
    try {
      const tombstone = db.transaction((): MemoryTombstone => {
        // Scope must match: a caller can never forget another scope's entry by
        // id alone. Org rows have principal NULL; user rows match the exact
        // physical principal composite.
        const principalClause = physical.scope === "user" ? " AND principal = ?" : " AND principal IS NULL";
        const params: (string | number)[] =
          physical.scope === "user" ? [input.id, physical.scope, physical.principal ?? ""] : [input.id, physical.scope];
        // SAFETY: the guarded SELECT lists id, scope, principal, content,
        // metadata_json, created_at, mem_source, mem_space_id, mem_principal,
        // mem_scope_label — exactly the MemoryRow fields — so each matched row
        // satisfies the row shape (columns are non-nullable in the migrations).
        const existing = db
          .query(
            `SELECT id, scope, principal, content, metadata_json, created_at,
                    mem_source, mem_space_id, mem_principal, mem_scope_label
             FROM memories
             WHERE id = ? AND scope = ?${principalClause}
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1`,
          )
          .get(...params) as MemoryRow | null;
        if (!existing) {
          throw new Error(
            `memory.forget: no entry with id '${input.id}' in scope '${scopeKeyLabel(input.scope)}'`,
          );
        }
        db.query(
          `INSERT INTO memory_tombstones (
             id, scope, principal, content, metadata_json, created_at,
             mem_source, mem_space_id, mem_principal, mem_scope_label, forgotten_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          existing.id,
          existing.scope,
          existing.principal,
          existing.content,
          existing.metadata_json,
          existing.created_at,
          existing.mem_source,
          existing.mem_space_id,
          existing.mem_principal,
          existing.mem_scope_label,
          forgottenAt,
        );
        db.query("DELETE FROM memories WHERE id = ?").run(input.id);
        return {
          id: existing.id,
          // SAFETY: scope only ever holds the literal 'org' or 'user' (written by
          // save() via encodeScopeKey or the migration default), so the cast to
          // that union is safe.
          key: decodeScopeKey(existing.scope as "org" | "user", existing.principal),
          forgottenAt,
        };
      })();
      return Promise.resolve(tombstone);
    } catch (error) {
      // A not-found or scope-mismatch surfaces as a rejected promise (not a
      // synchronous throw) so callers uniformly `await provider.forget(...)`.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function countForgotten(scope: MemoryScopeKey): Promise<number> {
    const physical = encodeScopeKey(scope);
    let sql: string;
    let params: (string | number)[];
    if (physical.scope === "org") {
      sql = "SELECT COUNT(*) AS count FROM memory_tombstones WHERE scope = 'org' AND principal IS NULL";
      params = [];
    } else {
      sql = "SELECT COUNT(*) AS count FROM memory_tombstones WHERE scope = 'user' AND principal = ?";
      params = [physical.principal ?? ""];
    }
    // SAFETY: COUNT(*) always returns exactly one row whose `count` column is a
    // non-negative integer, so the result matches { count: number } when present.
    const row = db.query(sql).get(...params) as { count: number } | null;
    return Promise.resolve(row?.count ?? 0);
  }

  function countRecallable(scope: MemoryScopeKey): Promise<number> {
    const physical = encodeScopeKey(scope);
    let sql: string;
    let params: (string | number)[];
    if (physical.scope === "org") {
      sql = "SELECT COUNT(*) AS count FROM memories WHERE scope = 'org' AND principal IS NULL";
      params = [];
    } else {
      sql = "SELECT COUNT(*) AS count FROM memories WHERE scope = 'user' AND principal = ?";
      params = [physical.principal ?? ""];
    }
    // SAFETY: COUNT(*) always returns exactly one row whose `count` column is a
    // non-negative integer, so the result matches { count: number } when present.
    const row = db.query(sql).get(...params) as { count: number } | null;
    return Promise.resolve(row?.count ?? 0);
  }

  return { capabilities, save, search, pruneDigests, forget, countForgotten, countRecallable };
}