import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export const DEFAULT_COMPACT_AFTER = 10;

export const MEMORY_CONSOLIDATION_PROMPT = [
  "You consolidate an agent's long-term memory pool.",
  "The input contains the active numbered facts and the facts added since the last compaction marker.",
  "Output ONLY actions, one per line, in these exact forms:",
  "UPDATE <index> <revised fact>",
  "DELETE <index>",
  "ADD <new fact>",
  "If nothing needs changing, output exactly: NONE",
  "",
  "Rules:",
  "- Prefer UPDATE over DELETE plus ADD when a fact evolved or facts should merge.",
  "- Keep each fact atomic and standalone.",
  "- DELETE stale, contradicted, duplicate, or trivially derivable facts.",
  "- Do not reword facts that are already correct.",
  "- When in doubt, leave a fact unchanged.",
].join("\n");

export type ConsolidationModelCall = (
  systemPrompt: string,
  input: string,
) => Promise<string | undefined>;

export type MemoryPool =
  | { scope: "org"; principal?: never }
  | { scope: "user"; principal: string };

export type ConsolidationAction =
  | { kind: "update"; index: number; text: string }
  | { kind: "delete"; index: number }
  | { kind: "add"; text: string };

export interface ConsolidationOptions {
  compactAfter?: number;
  now?: () => number;
}

export interface ConsolidationResult {
  pool: MemoryPool;
  newFacts: number;
  compacted: boolean;
  actionsApplied: number;
}

type PoolRow = {
  rowid: number;
  id: string;
  content: string;
  metadata_json: string;
};

type MarkerRow = { last_rowid: number };
type CountRow = { count: number; max_rowid: number | null };

const STATE_MIGRATION = `
CREATE TABLE IF NOT EXISTS memory_compaction_state (
  scope TEXT NOT NULL CHECK (scope IN ('org', 'user')),
  principal_key TEXT NOT NULL,
  last_rowid INTEGER NOT NULL DEFAULT 0,
  compacted_at INTEGER NOT NULL,
  PRIMARY KEY (scope, principal_key)
);
`;

const GENERATED_METADATA = {
  source: "consolidation",
  consolidated: "1",
} as const;

export function parseConsolidationActions(output: string): ConsolidationAction[] {
  const actions: ConsolidationAction[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || /^none$/i.test(line)) continue;

    let match = /^UPDATE\s+(\d+)\s*:?[ \t]+(.+)$/i.exec(line);
    if (match) {
      actions.push({ kind: "update", index: Number(match[1]), text: match[2]!.trim() });
      continue;
    }

    match = /^DELETE\s+(\d+)\s*$/i.exec(line);
    if (match) {
      actions.push({ kind: "delete", index: Number(match[1]) });
      continue;
    }

    match = /^ADD\s*:?[ \t]+(.+)$/i.exec(line);
    if (match) actions.push({ kind: "add", text: match[1]!.trim() });
  }
  return actions;
}

function principalKey(pool: MemoryPool): string {
  return pool.scope === "org" ? "" : pool.principal;
}

function poolPredicate(pool: MemoryPool, alias = "") {
  const column = (name: string) => `${alias}${name}`;
  if (pool.scope === "org") {
    return { sql: `${column("scope")} = 'org' AND ${column("principal")} IS NULL`, params: [] };
  }
  if (!pool.principal) throw new Error("memory consolidation: user pool requires a principal");
  return {
    sql: `${column("scope")} = 'user' AND ${column("principal")} = ?`,
    params: [pool.principal],
  };
}


function consolidationInput(rows: PoolRow[], lastRowId: number): string {
  const active = rows.map((row, index) => `${index + 1}. ${row.content}`).join("\n");
  const recent = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.rowid > lastRowId && !isGenerated(row.metadata_json))
    .map(({ row, index }) => `- ${index + 1}. ${row.content}`)
    .join("\n");
  return `Active facts:\n${active}\n\nFacts since the last compaction marker:\n${recent}`;
}

function isGenerated(metadataJson: string): boolean {
  // SAFETY: metadata_json is authored by this module as a JSON object with string values
  // (GENERATED_METADATA or the superseded-update object); the cast types only that object.
  const metadata = JSON.parse(metadataJson) as Record<string, string>;
  return metadata.source === GENERATED_METADATA.source;
}


function marker(db: Database, pool: MemoryPool): number {
  // SAFETY: the SELECT list (last_rowid) is exactly MarkerRow's shape; bun:sqlite
  // .get() returns that row object or undefined.
  const row = db
    .query(
      `SELECT last_rowid
       FROM memory_compaction_state
       WHERE scope = ? AND principal_key = ?`,
    )
    .get(pool.scope, principalKey(pool)) as MarkerRow | null;
  return row?.last_rowid ?? 0;
}

function newFactCount(
  db: Database,
  pool: MemoryPool,
  lastRowId: number,
) {
  const predicate = poolPredicate(pool);
  // SAFETY: the SELECT list (count, max_rowid) is exactly CountRow's shape; bun:sqlite
  // .get() returns that row object or undefined.
  const row = db
    .query(
      `SELECT COUNT(*) AS count, MAX(rowid) AS max_rowid
       FROM memories
       WHERE ${predicate.sql}
         AND rowid > ?
         AND json_extract(metadata_json, '$.source') IS NOT 'consolidation'`,
    )
    .get(...predicate.params, lastRowId) as CountRow;
  return { count: row.count, maxRowId: row.max_rowid ?? lastRowId };
}

function readPool(db: Database, pool: MemoryPool): PoolRow[] {
  const predicate = poolPredicate(pool);
  // SAFETY: the SELECT list (rowid, id, content, metadata_json) is exactly PoolRow's
  // shape; bun:sqlite .all() returns one such row object per memory row.
  return db
    .query(
      `SELECT rowid, id, content, metadata_json
       FROM memories
       WHERE ${predicate.sql}
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(...predicate.params) as PoolRow[];
}


function applyActions(
  db: Database,
  pool: MemoryPool,
  rows: PoolRow[],
  actions: ConsolidationAction[],
  markerRowId: number,
  at: number,
): number {
  const updates = new Map<number, string>();
  const deletes = new Set<number>();
  const adds: string[] = [];
  for (const action of actions) {
    if (action.kind === "update") updates.set(action.index, action.text);
    else if (action.kind === "delete") deletes.add(action.index);
    else adds.push(action.text);
  }

  return db.transaction(() => {
    let applied = 0;
    const predicate = poolPredicate(pool);
    const mutation = { sql: `id = ? AND ${predicate.sql}`, params: predicate.params };

    for (const index of deletes) {
      const row = rows[index - 1];
      if (!row) continue;
      const deleted = db
        .query(`DELETE FROM memories WHERE ${mutation.sql} RETURNING id`)
        .get(row.id, ...mutation.params);
      if (deleted) applied++;
    }

    for (const [index, content] of updates) {
      if (deletes.has(index)) continue;
      const row = rows[index - 1];
      if (!row) continue;
      // SAFETY: metadata_json is authored by this module as a JSON object with string
      // values (GENERATED_METADATA or a prior superseded-update object); the cast types
      // only that object so superseded can be attached.
      const metadata = JSON.parse(row.metadata_json) as Record<string, string>;
      metadata.superseded = row.content;
      const updated = db
        .query(
          `UPDATE memories
           SET content = ?, metadata_json = ?
           WHERE ${mutation.sql}
           RETURNING id`,
        )
        .get(content, JSON.stringify(metadata), row.id, ...mutation.params);
      if (updated) applied++;
    }

    for (const content of adds) {
      db.query(
        `INSERT INTO memories (id, scope, principal, content, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        `mem_${randomUUID()}`,
        pool.scope,
        pool.scope === "user" ? pool.principal : null,
        content,
        JSON.stringify(GENERATED_METADATA),
        at,
      );
      applied++;
    }

    db.query(
      `INSERT INTO memory_compaction_state
         (scope, principal_key, last_rowid, compacted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, principal_key) DO UPDATE SET
         last_rowid = excluded.last_rowid,
         compacted_at = excluded.compacted_at`,
    ).run(pool.scope, principalKey(pool), markerRowId, at);

    return applied;
  })();
}

export async function consolidatePool(
  db: Database,
  pool: MemoryPool,
  modelCall: ConsolidationModelCall,
  options: ConsolidationOptions = {},
): Promise<ConsolidationResult> {
  db.exec(STATE_MIGRATION);
  const compactAfter = options.compactAfter ?? DEFAULT_COMPACT_AFTER;
  const resultPool: MemoryPool =
    pool.scope === "org"
      ? { scope: "org" }
      : { scope: "user", principal: pool.principal };
  if (compactAfter <= 0) {
    return { pool: resultPool, newFacts: 0, compacted: false, actionsApplied: 0 };
  }

  const lastRowId = marker(db, pool);
  const pending = newFactCount(db, pool, lastRowId);
  if (pending.count < compactAfter) {
    return { pool: resultPool, newFacts: pending.count, compacted: false, actionsApplied: 0 };
  }

  const rows = readPool(db, pool);
  const output = await modelCall(
    MEMORY_CONSOLIDATION_PROMPT,
    consolidationInput(rows, lastRowId),
  );
  const actions = parseConsolidationActions(output ?? "");
  const actionsApplied = applyActions(
    db,
    pool,
    rows,
    actions,
    pending.maxRowId,
    (options.now ?? Date.now)(),
  );
  return { pool: resultPool, newFacts: pending.count, compacted: true, actionsApplied };
}

export async function maintainMemory(
  db: Database,
  modelCall: ConsolidationModelCall,
  options: ConsolidationOptions = {},
): Promise<ConsolidationResult[]> {
  db.exec(STATE_MIGRATION);
  // SAFETY: SELECT DISTINCT scope, principal returns one row per memory pool with
  // exactly those columns; bun:sqlite .all() returns them as row objects.
  const pools = db
    .query(
      `SELECT DISTINCT scope, principal
       FROM memories
       WHERE scope = 'org' OR (scope = 'user' AND principal IS NOT NULL)
       ORDER BY scope ASC, principal ASC`,
    )
    .all() as { scope: "org" | "user"; principal: string | null }[];

  const results: ConsolidationResult[] = [];
  for (const row of pools) {
    const pool: MemoryPool =
      row.scope === "org"
        ? { scope: "org" }
        : { scope: "user", principal: row.principal! };
    const result = await consolidatePool(db, pool, modelCall, options);
    if (result.compacted) results.push(result);
  }
  return results;
}
