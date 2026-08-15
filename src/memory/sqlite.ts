/**
 * SQLite memory backend (memory epic, issue #20).
 *
 * Default MemoryProvider for per-org self-hosted bottega: the provider
 * borrows the store's Database handle and keeps memories in the same
 * SQLite file (`data/bottega.db`), zero external services. Memory is never
 * deleted — save + search only (issue #19 invariant).
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

/** Idempotent migration: same file as the store, provider-owned table. */
const MIGRATION = `
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

/**
 * Digest cap (issue #42): deletes digest memories for `spaceId` beyond the
 * newest `keep`, so digests cannot pile up (the space transcript retains the
 * full history, so pruning loses nothing). Returns the number of deleted
 * rows. This is deliberately not part of the MemoryProvider contract —
 * memory is never deleted through the provider (issue #19); the cap is a
 * bottega-owned storage-management rule on the shared SQLite file.
 */
export function pruneDigestMemories(db: Database, spaceId: string, keep: number): number {
  const result = db
    .query(
      `DELETE FROM memories
       WHERE id IN (
         SELECT id FROM memories
         WHERE metadata_json LIKE '%"kind":"digest"%' ESCAPE '\\'
           AND metadata_json LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC, rowid DESC
         LIMIT -1 OFFSET ?
       )`,
    )
    .run(`%"space":"${escapeLike(spaceId)}"%`, keep);
  return result.changes;
}

export function createSqliteMemoryProvider(db: Database): MemoryProvider {
  db.exec(MIGRATION);

  const insertStmt = db.query(
    `INSERT INTO memories (id, scope, principal, content, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  // NOTE: plain functions, not async — validators must throw synchronously so
  // callers can rely on validation errors surfacing without awaiting.

  function save(input: MemorySaveInput): Promise<MemoryEntry> {
    validateSaveInput(input);
    const id = `mem_${randomUUID()}`;
    const principal = input.scope === "user" ? input.principal! : null;
    const createdAt = Date.now();
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

  function search(query: MemorySearchQuery): Promise<MemoryEntry[]> {
    validateSearchQuery(query);
    const clauses = ["scope = ?", "content LIKE ? ESCAPE '\\'"];
    const params: (string | number)[] = [query.scope, `%${escapeLike(query.query)}%`];
    // Principal filters only user scope; org memory is shared across principals.
    if (query.scope === "user" && query.principal !== undefined) {
      clauses.push("principal = ?");
      params.push(query.principal);
    }
    const rows = db
      .query(
        `SELECT id, scope, principal, content, metadata_json, created_at
         FROM memories
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...params) as MemoryRow[];

    // Metadata exact-match in JS: memory tables are small, and this stays
    // correct for every key (json_extract path syntax is not worth the edges).
    const metadata = query.metadata ?? {};
    const matched =
      Object.keys(metadata).length === 0
        ? rows
        : rows.filter((row) =>
            Object.entries(metadata).every(
              ([key, value]) => (JSON.parse(row.metadata_json) as Record<string, string>)[key] === value,
            ),
          );
    return Promise.resolve(matched.slice(0, query.limit ?? MEMORY_LIMIT_DEFAULT).map(rowToEntry));
  }

  return { save, search };
}
