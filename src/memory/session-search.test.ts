import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePolicyCall, parseOrgConfigYaml } from "../policy/config";
import { sessionFilePath } from "../server/drivers/agent-driver";
import {
  indexSessionFiles,
  messageLineSchema,
  searchSessions,
  sessionSearchArgsSchema,
  sessionSearchToolDefinitions,
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

// #171 writer → reader round-trip pin: a transcript line written with the
// driver's OWN serialization (the agent-driver `sessionFilePath` naming + the
// canonical messageLineSchema) must be found by the session-search reader with
// its content and space id intact.
describe("transcript writer -> reader round-trip (#171)", () => {
  test("a driver-serialized message is indexed and searched with content + space intact", () => {
    const { db, dir } = fixture();
    const space = "slack:C1";
    const timestamp = "2026-08-17T01:00:00.000Z";
    // Source the wire line from the seam's exported schema (not a hand-rolled
    // literal): the SDK driver persists this exact shape per message.
    const line = messageLineSchema.parse({
      type: "message",
      id: timestamp,
      parentId: null,
      timestamp,
      message: { role: "user", content: [{ type: "text", text: "alpha release plan post-schema" }] },
    });
    // Path + filename come from the driver's exported writer helper.
    const file = sessionFilePath(dir, space);
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "title", v: 1, title: "", updatedAt: timestamp, pad: "" }),
        JSON.stringify({ type: "session", version: 3, id: space, timestamp, cwd: "/tmp" }),
        JSON.stringify(line),
        "",
      ].join("\n"),
    );

    indexSessionFiles(db, dir);
    const hits = searchSessions(db, { query: "alpha", space });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.space).toBe(space);
    expect(hits[0]!.file).toBe(`${space}.jsonl`);
    expect(hits[0]!.timestamp).toBe(timestamp);
    expect(hits[0]!.text).toBe("alpha release plan post-schema");
  });
});

/** The context surface the tool bridge reads from an ExtensionContext. */
interface ToolRunContext {
  sessionManager: { getSessionFile(): string | undefined };
}

/** Builds an ExtensionContext whose session file names the space id (issue #66 convention). */
function ctxForSessionFile(file: string | undefined): ExtensionContext {
  const ctx: ToolRunContext = { sessionManager: { getSessionFile: () => file } };
  // SAFETY: session_search resolves the space id only via sessionManager.getSessionFile()
  // (the tool bridge); ToolRunContext is exactly that surface, so the stub is sound.
  return ctx as ExtensionContext;
}

describe("session_search tool execution scoping (issue #171-security)", () => {
  test("the wire schema has NO caller-supplied space argument", () => {
    expect(sessionSearchArgsSchema.safeParse({ query: "alpha" }).success).toBe(true);
    expect(sessionSearchArgsSchema.safeParse({ query: "alpha", limit: 5 }).success).toBe(true);
    // A caller must not be able to pick another space — a space arg is rejected.
    expect(sessionSearchArgsSchema.safeParse({ query: "alpha", space: "slack:C2" }).success).toBe(false);
  });

  test("execute searches ONLY the session's own space, never another space's transcripts", async () => {
    const { db, dir } = fixture();
    writeSession(dir, "slack:C1", [entry("release train is green", "2026-08-17T01:00:00.000Z")]);
    writeSession(dir, "slack:C2", [entry("release plans are confidential", "2026-08-17T02:00:00.000Z")]);
    const [tool] = sessionSearchToolDefinitions(db, dir);

    const result = await tool.execute("tc1", { query: "release" }, undefined, undefined, ctxForSessionFile(join(dir, "slack:C1.jsonl")));
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    // SAFETY: the tool serializes SessionSearchResult rows (which include space);
    // the test asserts on the space and text fields only.
    const hits = JSON.parse(text) as Array<{ space: string; text: string }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.space).toBe("slack:C1");
    expect(hits.some((hit) => hit.text.includes("confidential"))).toBe(false);
  });

  test("execute fails closed (no all-space search) when session context is missing", async () => {
    const { db, dir } = fixture();
    writeSession(dir, "slack:C1", [entry("release train is green", "2026-08-17T01:00:00.000Z")]);
    const [tool] = sessionSearchToolDefinitions(db, dir);

    // No session file -> no resolvable space -> the tool must error, not
    // search every space's transcripts (issue #171-security).
    const result = await tool.execute("tc1", { query: "release" }, undefined, undefined, ctxForSessionFile(undefined));
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    expect(text).toContain("could not resolve this conversation's space");
  });
});
