/**
 * SQLite memory backend (memory epic, issue #20).
 *
 * Default MemoryProvider for per-org self-hosted bottega: the provider
 * borrows the store's Database handle and keeps memories in the same
 * SQLite file (`data/bottega.db`), zero external services. The provider
 * exposes only save + search; storage maintenance is kept outside its contract.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  MEMORY_LIMIT_DEFAULT,
  validateSaveInput,
  validateSearchQuery,
  type MemoryEntry,
  type MemoryProvider,
  type MemorySaveInput,
  type MemorySearchQuery,
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
};

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    scope: row.scope as MemoryEntry["scope"],
    principal: row.principal,
    content: row.content,
    metadata: JSON.parse(row.metadata_json) as Record<string, string>,
    createdAt: row.created_at,
  };
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
 * Digest cap (issue #42): deletes digest memories for `spaceId` beyond the
 * newest `keep`, so digests cannot pile up (the space transcript retains the
 * full history, so pruning loses nothing). Returns the number of deleted
 * rows. This is deliberately not part of the MemoryProvider contract —
 * memory is never deleted through the provider (issue #19); the cap is a
 * bottega-owned storage-management rule on the shared SQLite file.
 */
export function pruneDigestMemories(db: Database, spaceId: string, keep: number): number {
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
  const useFts = !options.forceFtsFallback && ftsAvailable();
  if (useFts) {
    db.exec(FTS_MIGRATION);
    // Backfill databases created before the FTS migration. Rebuild is
    // idempotent and also repairs an interrupted trigger write.
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
  }

  const insertStmt = db.query(
    `INSERT INTO memories (id, scope, principal, content, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = options.now ?? Date.now;

  // NOTE: plain functions, not async — validators must throw synchronously so
  // callers can rely on validation errors surfacing without awaiting.

  function save(input: MemorySaveInput): Promise<MemoryEntry> {
    validateSaveInput(input);
    const id = `mem_${randomUUID()}`;
    const principal = input.scope === "user" ? input.principal! : null;
    const createdAt = now();
    insertStmt.run(
      id,
      input.scope,
      principal,
      input.content,
      JSON.stringify(input.metadata ?? {}),
      createdAt,
    );
    return Promise.resolve({
      id,
      scope: input.scope,
      principal,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt,
    });
  }

  function filterAndLimit(rows: MemoryRow[], query: MemorySearchQuery): MemoryEntry[] {
    // Metadata exact-match stays in JS. This avoids constructing JSON paths
    // from caller-controlled keys and is correct for every valid key.
    const metadata = query.metadata ?? {};
    const matched =
      Object.keys(metadata).length === 0
        ? rows
        : rows.filter((row) => {
            const rowMetadata = JSON.parse(row.metadata_json) as Record<string, string>;
            return Object.entries(metadata).every(([key, value]) => rowMetadata[key] === value);
          });
    return matched.slice(0, query.limit ?? MEMORY_LIMIT_DEFAULT).map(rowToEntry);
  }

  function likeRows(query: MemorySearchQuery): MemoryRow[] {
    const clauses = ["scope = ?", "content LIKE ? ESCAPE '\\'"];
    const params: (string | number)[] = [query.scope, `%${escapeLike(query.query)}%`];
    if (query.scope === "user" && query.principal !== undefined) {
      clauses.push("principal = ?");
      params.push(query.principal);
    }
    return db
      .query(
        `SELECT id, scope, principal, content, metadata_json, created_at
         FROM memories
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...params) as MemoryRow[];
  }

  function ftsRows(query: MemorySearchQuery, match: string): MemoryRow[] {
    const clauses = ["memories_fts MATCH ?", "m.scope = ?"];
    const params: (string | number)[] = [
      RECENCY_WEIGHT,
      RECENCY_DECAY_MS,
      RECENCY_DECAY_MS,
      now(),
      match,
      query.scope,
    ];
    if (query.scope === "user" && query.principal !== undefined) {
      clauses.push("m.principal = ?");
      params.push(query.principal);
    }
    return db
      .query(
        `SELECT m.id, m.scope, m.principal, m.content, m.metadata_json, m.created_at,
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

  return { save, search };
}
