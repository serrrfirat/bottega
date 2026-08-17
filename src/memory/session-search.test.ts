import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePolicyCall, parseOrgConfigYaml } from "../policy/config";
import {
  indexSessionFiles,
  searchSessions,
  SessionSearchUnavailableError,
} from "./session-search";

const root = mkdtempSync(join(tmpdir(), "bottega-session-search-"));
const dbs: Database[] = [];
let fixtureNumber = 0;

afterAll(() => {
  for (const db of dbs) db.close();
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const id = fixtureNumber++;
  const dir = join(root, `sessions-${id}`);
  mkdirSync(dir);
  const db = new Database(join(root, `search-${id}.db`));
  dbs.push(db);
  return { db, dir };
}

function entry(text: string, timestamp: string, role: "user" | "assistant" = "user"): string {
  return JSON.stringify({
    type: "message",
    id: timestamp,
    parentId: null,
    timestamp,
    message: { role, content: [{ type: "text", text }] },
  });
}

function writeSession(dir: string, space: string, entries: string[]): string {
  const file = join(dir, `${space}.jsonl`);
  const header = [
    JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-08-17T00:00:00.000Z", pad: "" }),
    JSON.stringify({ type: "session", version: 3, id: space, timestamp: "2026-08-17T00:00:00.000Z", cwd: "/tmp" }),
  ];
  writeFileSync(file, `${[...header, ...entries].join("\n")}\n`);
  return file;
}

describe("session transcript FTS index", () => {
  test("indexes only appended JSONL lines on repeated scans", () => {
    const { db, dir } = fixture();
    const file = writeSession(dir, "slack:C1", [
      entry("alpha release plan", "2026-08-17T01:00:00.000Z"),
      entry("unrelated note", "2026-08-17T02:00:00.000Z", "assistant"),
    ]);

    expect(indexSessionFiles(db, dir)).toEqual({ files: 1, indexedLines: 4, indexedMessages: 2 });
    expect(indexSessionFiles(db, dir)).toEqual({ files: 1, indexedLines: 0, indexedMessages: 0 });

    appendFileSync(file, `${entry("alpha follow-up", "2026-08-17T03:00:00.000Z")}\n`);
    expect(indexSessionFiles(db, dir)).toEqual({ files: 1, indexedLines: 1, indexedMessages: 1 });
    expect(searchSessions(db, { query: "alpha" }).map((hit) => hit.line).sort()).toEqual([3, 5]);

    // SAFETY: the SELECT lists the processed_lines INTEGER column of the meta row
    // for this file, inserted by indexSessionFiles; bun:sqlite surfaces it as a number.
    const meta = db.query("SELECT processed_lines FROM session_search_meta WHERE file = ?").get("slack:C1.jsonl") as {
      processed_lines: number;
    };
    expect(meta.processed_lines).toBe(5);
  });

  test("orders by BM25 relevance and filters by exact space", () => {
    const { db, dir } = fixture();
    writeSession(dir, "slack:C1", [
      entry("launch launch launch checklist", "2026-08-17T01:00:00.000Z"),
      entry("launch is mentioned once in a considerably longer background sentence", "2026-08-17T02:00:00.000Z"),
    ]);
    writeSession(dir, "slack:C2", [
      entry("launch notes from the other space", "2026-08-17T03:00:00.000Z"),
    ]);
    indexSessionFiles(db, dir);

    const all = searchSessions(db, { query: "launch" });
    expect(all[0].text).toBe("launch launch launch checklist");
    expect(all.map((hit) => hit.space).sort()).toEqual(["slack:C1", "slack:C1", "slack:C2"]);

    const filtered = searchSessions(db, { query: "launch", space: "slack:C2" });
    expect(filtered).toEqual([
      {
        space: "slack:C2",
        file: "slack:C2.jsonl",
        line: 3,
        timestamp: "2026-08-17T03:00:00.000Z",
        text: "launch notes from the other space",
      },
    ]);
  });

  test("redacts secrets before returning a bounded excerpt", () => {
    const { db, dir } = fixture();
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    writeSession(dir, "slack:C1", [
      entry(`deploy token ${secret} ${"x".repeat(700)}`, "2026-08-17T01:00:00.000Z"),
    ]);
    indexSessionFiles(db, dir);

    const [hit] = searchSessions(db, { query: "deploy" });
    expect(hit.text).toContain("sk-[REDACTED]");
    expect(hit.text).not.toContain(secret);
    expect(hit.text.length).toBe(500);
  });

  test("re-indexes rotated files and removes missing-file hits", () => {
    const { db, dir } = fixture();
    const file = writeSession(dir, "slack:C1", [
      entry("obsolete rotation marker", "2026-08-17T01:00:00.000Z"),
      entry("second obsolete marker", "2026-08-17T02:00:00.000Z"),
    ]);
    indexSessionFiles(db, dir);

    writeFileSync(file, `${entry("replacement marker", "2026-08-17T03:00:00.000Z")}\n`);
    expect(indexSessionFiles(db, dir)).toEqual({ files: 1, indexedLines: 1, indexedMessages: 1 });
    expect(searchSessions(db, { query: "obsolete" })).toEqual([]);
    expect(searchSessions(db, { query: "replacement" })).toHaveLength(1);

    rmSync(file);
    expect(() => indexSessionFiles(db, dir)).not.toThrow();
    expect(searchSessions(db, { query: "replacement" })).toEqual([]);
  });

  test("fails closed with a clear error when SQLite lacks FTS5", () => {
    // SAFETY: searchSessions probes FTS5 availability through exec() and must see
    // it throw; the rest of Database is never touched on that path, so the partial
    // fake is safe to treat as a Database (never is the single-hop escape).
    const unavailableDb = {
      exec(sql: string) {
        if (sql.includes("VIRTUAL TABLE")) throw new Error("no such module: fts5");
      },
    } as never;

    expect(() => searchSessions(unavailableDb, { query: "anything" })).toThrow(SessionSearchUnavailableError);
    expect(() => searchSessions(unavailableDb, { query: "anything" })).toThrow(/FTS5 support is required/);
  });
});

describe("session_search policy", () => {
  test("the read-tier tool resolves to allow when the deployment policy allows it", () => {
    const policy = parseOrgConfigYaml("tools:\n  session_search: allow\n");
    expect(decidePolicyCall(policy, "session_search")).toEqual({
      decision: "allow",
      reason: "allowed by policy",
      autoApproved: false,
    });
  });
});
