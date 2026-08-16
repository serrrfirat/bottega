/** Read-only full-text search over the durable per-space session transcripts (issue #136). */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { redact } from "../policy/audit";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import { errorMessage, toolError } from "../tools/helpers";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const RESULT_TEXT_LIMIT = 500;

const META_MIGRATION = `
CREATE TABLE IF NOT EXISTS session_search_meta (
  file TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  processed_lines INTEGER NOT NULL CHECK (processed_lines >= 0)
);
`;

const FTS_MIGRATION = `
CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(
  text,
  space UNINDEXED,
  file UNINDEXED,
  line UNINDEXED,
  timestamp UNINDEXED,
  tokenize = 'unicode61'
);
`;

export interface SessionSearchQuery {
  query: string;
  space?: string;
  limit?: number;
}

export interface SessionSearchResult {
  space: string;
  file: string;
  line: number;
  timestamp: string | null;
  text: string;
}

export interface SessionIndexResult {
  files: number;
  indexedLines: number;
  indexedMessages: number;
}

type MetaRow = { file: string; file_id: string; processed_lines: number };
type SearchRow = {
  space: string;
  file: string;
  line: number;
  timestamp: string | null;
  text: string;
};

/** Raised when the linked SQLite build cannot create or query an FTS5 table. */
export class SessionSearchUnavailableError extends Error {
  constructor(cause?: unknown) {
    const detail = cause === undefined ? "" : `: ${errorMessage(cause)}`;
    super(`session_search unavailable: SQLite FTS5 support is required${detail}`);
    this.name = "SessionSearchUnavailableError";
  }
}

function ensureSchema(db: Database): void {
  db.exec(META_MIGRATION);
  try {
    db.exec(FTS_MIGRATION);
  } catch (error) {
    throw new SessionSearchUnavailableError(error);
  }
}

/** Complete JSONL records only. A crash-truncated final line is retried after it is completed. */
function completeLines(contents: string): string[] {
  if (contents.length === 0) return [];
  const lines = contents.split("\n");
  lines.pop();
  return lines;
}

function messageText(line: string): { timestamp: string | null; text: string } | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (record.type !== "message" || !record.message || typeof record.message !== "object") return null;

  const message = record.message as Record<string, unknown>;
  const content = message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          !!part &&
          typeof part === "object" &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as Record<string, unknown>).text === "string",
      )
      .map((part) => part.text)
      .join("\n");
  }
  text = text.trim();
  if (!text) return null;

  const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
  return { timestamp, text };
}

/**
 * Incrementally indexes every complete line in `<dir>/*.jsonl`.
 *
 * The metadata cursor advances for malformed and non-message lines too, because
 * it tracks physical JSONL lines. Appends therefore scan only new records.
 * Replaced/truncated files are re-indexed, and removed files lose stale hits.
 */
export function indexSessionFiles(db: Database, dir: string): SessionIndexResult {
  ensureSchema(db);

  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      names = [];
    } else {
      throw error;
    }
  }

  const currentFiles = new Set<string>();
  let indexedLines = 0;
  let indexedMessages = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    const getMeta = db.query("SELECT file, file_id, processed_lines FROM session_search_meta WHERE file = ?");
    const upsertMeta = db.query(
      `INSERT INTO session_search_meta (file, file_id, processed_lines) VALUES (?, ?, ?)
       ON CONFLICT(file) DO UPDATE SET file_id = excluded.file_id, processed_lines = excluded.processed_lines`,
    );
    const insert = db.query(
      "INSERT INTO session_search (text, space, file, line, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    const deleteFile = db.query("DELETE FROM session_search WHERE file = ?");

    for (const name of names) {
      const path = join(dir, name);
      let contents: string;
      let fileId: string;
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        fileId = `${stat.dev}:${stat.ino}`;
        contents = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }

      currentFiles.add(name);
      const lines = completeLines(contents);
      const prior = getMeta.get(name) as MetaRow | null;
      const rotated = prior !== null && (prior.file_id !== fileId || lines.length < prior.processed_lines);
      if (rotated) deleteFile.run(name);
      const start = prior === null || rotated ? 0 : prior.processed_lines;
      const space = sessionIdFromFilePath(name)!;

      for (let index = start; index < lines.length; index++) {
        const parsed = messageText(lines[index]);
        if (parsed) {
          insert.run(parsed.text, space, name, index + 1, parsed.timestamp);
          indexedMessages++;
        }
        indexedLines++;
      }
      upsertMeta.run(name, fileId, lines.length);
    }

    const known = db.query("SELECT file FROM session_search_meta").all() as Array<{ file: string }>;
    const deleteMeta = db.query("DELETE FROM session_search_meta WHERE file = ?");
    for (const { file } of known) {
      if (currentFiles.has(file)) continue;
      deleteFile.run(file);
      deleteMeta.run(file);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { files: currentFiles.size, indexedLines, indexedMessages };
}

/** Runs an FTS5 MATCH query ordered by SQLite BM25 relevance (best first). */
export function searchSessions(db: Database, input: SessionSearchQuery): SessionSearchResult[] {
  ensureSchema(db);
  const query = input.query.trim();
  if (!query) throw new Error("session_search query must be non-empty");
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`session_search limit must be an integer from 1 to ${MAX_LIMIT}`);
  }

  const where = ["session_search MATCH ?"];
  const params: Array<string | number> = [query];
  if (input.space !== undefined) {
    where.push("space = ?");
    params.push(input.space);
  }
  params.push(limit);

  let rows: SearchRow[];
  try {
    rows = db
      .query(
        `SELECT space, file, CAST(line AS INTEGER) AS line, timestamp, text
         FROM session_search
         WHERE ${where.join(" AND ")}
         ORDER BY bm25(session_search), rowid
         LIMIT ?`,
      )
      .all(...params) as SearchRow[];
  } catch (error) {
    const message = errorMessage(error);
    if (/fts5|no such (?:table|module).*session_search/i.test(message)) {
      throw new SessionSearchUnavailableError(error);
    }
    throw new Error(`session_search query failed: ${message}`);
  }

  return rows.map((row) => ({
    space: row.space,
    file: row.file,
    line: row.line,
    timestamp: row.timestamp,
    text: redact(row.text).slice(0, RESULT_TEXT_LIMIT),
  }));
}

export const sessionSearchArgsSchema = z.object({
  query: z.string().min(1),
  space: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

/** SDK tool definition; the composition root supplies the shared DB and transcript directory. */
export function sessionSearchToolDefinitions(db: Database, transcriptDir: string): ToolDefinition[] {
  const search: ToolDefinition<typeof sessionSearchArgsSchema> = {
    name: "session_search",
    label: "Search session transcripts",
    description:
      "Searches durable session transcripts with full-text ranking. Optionally filters by space. " +
      "Returns redacted, truncated message excerpts with source file, line, and timestamp. Read-only.",
    parameters: sessionSearchArgsSchema,
    approval: "read",
    async execute(_toolCallId, params) {
      try {
        indexSessionFiles(db, transcriptDir);
        const results = searchSessions(db, params);
        return { content: [{ type: "text", text: JSON.stringify(results) }] };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };
  return [search];
}
