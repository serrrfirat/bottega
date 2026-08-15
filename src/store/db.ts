import { Database } from "bun:sqlite";
import { WORK_ITEM_CREATED_EVENT, WORK_ITEM_TRANSITION_EVENT } from "./audit-events";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Space = {
  id: string;
  platform: "slack" | "telegram";
  channel_id: string;
  name: string | null;
  policy_json: string;
  created_at: number;
  updated_at: number;
};

export type WorkItemState = "open" | "claimed" | "working" | "review" | "done" | "blocked" | "aborted";

export type WorkItem = {
  id: string;
  space_id: string;
  requester: string;
  description: string;
  repo: string | null;
  state: WorkItemState;
  approvals: string;
  evidence: string;
  result: string | null;
  created_at: number;
  updated_at: number;
};

export type AuditRow = {
  id: number;
  ts: number;
  space_id: string | null;
  actor: string;
  event_type: string;
  payload: string;
};

export type TransitionOpts = {
  /** {approver, at} entry appended to the approvals JSON array */
  approval?: { approver: string; at?: number };
  /** note appended to the evidence JSON array as {kind: "note", url, at} */
  evidence?: string;
  /** JSON string stored verbatim in the result column */
  result?: string;
  /** Actor recorded on the work_item.transition audit row; defaults to "system". */
  by?: string;
};

export type AuditEntry = {
  ts?: number;
  space_id?: string | null;
  actor: string;
  event_type: string;
  /** JSON string, secrets redacted by the caller before writing */
  payload: string;
};

export type ListAuditOpts = {
  space?: string;
  since?: number;
  event_type?: string;
  limit?: number;
};

export interface Store {
  getOrCreateSpace(input: {
    platform: "slack" | "telegram";
    channel_id: string;
    name?: string | null;
  }): Promise<Space>;
  getSpace(id: string): Promise<Space | null>;
  updatePolicy(id: string, policyJson: string): Promise<Space>;
  createWorkItem(input: { space_id: string; requester: string; description: string; repo?: string }): Promise<WorkItem>;
  /** Atomic open -> claimed: UPDATE ... WHERE id = (oldest open). Null when queue is empty. */
  claimNextWorkItem(): Promise<WorkItem | null>;
  /** Throws unless the row exists and is in `from`. */
  transitionWorkItem(id: string, from: WorkItemState, to: WorkItemState, opts?: TransitionOpts): Promise<WorkItem>;
  getWorkItem(id: string): Promise<WorkItem | null>;
  /** Moves items idle in `from` for longer than olderThanMs to blocked; returns count. */
  markStaleWorkItems(olderThanMs: number, from: WorkItemState): Promise<number>;
  appendAudit(entry: AuditEntry): Promise<number>;
  listAudit(opts?: ListAuditOpts): Promise<AuditRow[]>;
  /** The underlying Database handle — memory providers share this file (#20). */
  getDb(): Database;
  close(): void;
}

const DEFAULT_DB_PATH = "data/bottega.db";

/** Allowed state machine moves (issue #10). The atomic claim implements open -> claimed. */
const ALLOWED_TRANSITIONS: Record<WorkItemState, readonly WorkItemState[]> = {
  open: ["claimed", "aborted"],
  claimed: ["working", "open", "aborted"],
  working: ["review", "blocked", "aborted"],
  review: ["done", "blocked", "aborted"],
  done: [],
  blocked: [],
  aborted: [],
};

/**
 * Enforces the state machine and its obligations (single choke point for all
 * transitions): done requires result.pr_url, blocked requires non-empty
 * evidence, review requires a recorded approval.
 */
function assertLegalTransition(from: WorkItemState, to: WorkItemState, opts?: TransitionOpts): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`illegal work item transition ${from} -> ${to}`);
  }
  if (to === "done" && !prUrlFromResult(opts?.result)) {
    throw new Error("work item cannot transition to done without result.pr_url");
  }
  if (to === "blocked" && !opts?.evidence?.trim()) {
    throw new Error("work item cannot transition to blocked without evidence");
  }
  if (to === "review" && !opts?.approval) {
    throw new Error("work item cannot transition to review without a recorded approval");
  }
}

/** The pr_url from a result JSON string, or null when absent/invalid. */
function prUrlFromResult(result: string | undefined): string | null {
  if (!result) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    const url = (parsed as { pr_url?: unknown } | null)?.pr_url;
    return typeof url === "string" && url.trim().length > 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * Opens (creating if needed) the SQLite store at `dbPath` and runs the
 * idempotent schema migration (src/store/schema.sql). WAL mode + busy_timeout
 * so the server and the executor can share the file.
 */
export function createStore(dbPath: string = DEFAULT_DB_PATH): Store {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
  // Idempotent migration (issue #47): databases created before the repo
  // column existed keep their work_items table (CREATE TABLE IF NOT EXISTS
  // is a no-op), so add the column explicitly when it is missing.
  const workItemColumns = (db.query("PRAGMA table_info(work_items)").all() as { name: string }[]).map((c) => c.name);
  if (!workItemColumns.includes("repo")) {
    db.exec("ALTER TABLE work_items ADD COLUMN repo TEXT");
  }

  const getSpaceStmt = db.query("SELECT * FROM spaces WHERE id = ?");
  const getWorkItemStmt = db.query("SELECT * FROM work_items WHERE id = ?");

  async function getOrCreateSpace(input: {
    platform: "slack" | "telegram";
    channel_id: string;
    name?: string | null;
  }): Promise<Space> {
    const id = `${input.platform}:${input.channel_id}`;
    const t = Date.now();
    db.query(
      `INSERT INTO spaces (id, platform, channel_id, name, policy_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(id, input.platform, input.channel_id, input.name ?? null, t, t);
    return getSpaceStmt.get(id) as Space;
  }

  async function getSpace(id: string): Promise<Space | null> {
    return (getSpaceStmt.get(id) as Space | null) ?? null;
  }

  async function updatePolicy(id: string, policyJson: string): Promise<Space> {
    const row = db
      .query("UPDATE spaces SET policy_json = ?, updated_at = ? WHERE id = ? RETURNING *")
      .get(policyJson, Date.now(), id) as Space | null;
    if (!row) throw new Error(`space not found: ${id}`);
    return row;
  }

  async function createWorkItem(input: {
    space_id: string;
    requester: string;
    description: string;
    repo?: string;
  }): Promise<WorkItem> {
    const id = `wi_${randomUUID()}`;
    const t = Date.now();
    db.query(
      `INSERT INTO work_items (id, space_id, requester, description, repo, state, approvals, evidence, result, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', '[]', '[]', NULL, ?, ?)`,
    ).run(id, input.space_id, input.requester, input.description, input.repo ?? null, t, t);
    const item = getWorkItemStmt.get(id) as WorkItem;
    appendAudit({
      space_id: input.space_id,
      actor: input.requester,
      event_type: WORK_ITEM_CREATED_EVENT,
      payload: JSON.stringify({ id, requester: input.requester }),
    });
    return item;
  }

  async function claimNextWorkItem(): Promise<WorkItem | null> {
    const row = db
      .query(
        `UPDATE work_items
         SET state = 'claimed', updated_at = ?
         WHERE id = (SELECT id FROM work_items WHERE state = 'open' ORDER BY created_at LIMIT 1)
         RETURNING *`,
      )
      .get(Date.now()) as WorkItem | null;
    return row ?? null;
  }

  async function transitionWorkItem(
    id: string,
    from: WorkItemState,
    to: WorkItemState,
    opts?: TransitionOpts,
  ): Promise<WorkItem> {
    assertLegalTransition(from, to, opts);
    const t = Date.now();
    const appendJson = (column: string): string => `json_set(${column}, '$[#]', json(?))`;
    const sets: string[] = ["state = ?", "updated_at = ?"];
    const params: (string | number | null)[] = [to, t];
    if (opts?.approval) {
      sets.push(`approvals = ${appendJson("approvals")}`);
      params.push(JSON.stringify({ approver: opts.approval.approver, at: opts.approval.at ?? t }));
    }
    if (opts?.evidence !== undefined) {
      sets.push(`evidence = ${appendJson("evidence")}`);
      params.push(JSON.stringify({ kind: "note", url: opts.evidence, at: t }));
    }
    if (opts?.result !== undefined) {
      sets.push("result = ?");
      params.push(opts.result);
    }
    params.push(id, from);
    const row = db
      .query(`UPDATE work_items SET ${sets.join(", ")} WHERE id = ? AND state = ? RETURNING *`)
      .get(...params) as WorkItem | null;
    if (!row) throw new Error(`work item not found or not in state ${from}: ${id}`);
    const by = opts?.by ?? "system";
    appendAudit({
      space_id: row.space_id,
      actor: by,
      event_type: WORK_ITEM_TRANSITION_EVENT,
      payload: JSON.stringify({ from, to, by }),
    });
    return row;
  }

  async function getWorkItem(id: string): Promise<WorkItem | null> {
    return (getWorkItemStmt.get(id) as WorkItem | null) ?? null;
  }

  async function markStaleWorkItems(olderThanMs: number, from: WorkItemState): Promise<number> {
    const t = Date.now();
    const cutoff = t - olderThanMs;
    const stale = db
      .query("SELECT id, space_id FROM work_items WHERE state = ? AND updated_at < ?")
      .all(from, cutoff) as { id: string; space_id: string }[];
    if (stale.length === 0) return 0;
    db.query(
      `UPDATE work_items
       SET state = 'blocked', updated_at = ?,
           evidence = json_set(evidence, '$[#]', json(?))
       WHERE state = ? AND updated_at < ?`,
    ).run(t, JSON.stringify({ kind: "note", text: "interrupted by restart", at: t }), from, cutoff);
    for (const row of stale) {
      appendAudit({
        space_id: row.space_id,
        actor: "system",
        event_type: WORK_ITEM_TRANSITION_EVENT,
        payload: JSON.stringify({ from, to: "blocked", by: "system" }),
      });
    }
    return stale.length;
  }

  async function appendAudit(entry: AuditEntry): Promise<number> {
    const res = db
      .query("INSERT INTO audit (ts, space_id, actor, event_type, payload) VALUES (?, ?, ?, ?, ?)")
      .run(entry.ts ?? Date.now(), entry.space_id ?? null, entry.actor, entry.event_type, entry.payload);
    return Number(res.lastInsertRowid);
  }

  async function listAudit(opts: ListAuditOpts = {}): Promise<AuditRow[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.space !== undefined) {
      clauses.push("space_id = ?");
      params.push(opts.space);
    }
    if (opts.since !== undefined) {
      clauses.push("ts >= ?");
      params.push(opts.since);
    }
    if (opts.event_type !== undefined) {
      clauses.push("event_type = ?");
      params.push(opts.event_type);
    }
    let sql = "SELECT * FROM audit";
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY ts, id";
    if (opts.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    return db.query(sql).all(...params) as AuditRow[];
  }

  return {
    getOrCreateSpace,
    getSpace,
    updatePolicy,
    createWorkItem,
    claimNextWorkItem,
    transitionWorkItem,
    getWorkItem,
    markStaleWorkItems,
    appendAudit,
    listAudit,
    getDb: () => db,
    close: () => db.close(),
  };
}

/**
 * Stale-run recovery (issue #10): marks `claimed` and `working` items idle
 * for longer than `olderThanMs` as blocked with an interrupted-by-restart
 * evidence note. The executor runs this once at boot.
 */
export async function recoverStaleWorkItems(store: Store, olderThanMs: number): Promise<number> {
  const claimed = await store.markStaleWorkItems(olderThanMs, "claimed");
  const working = await store.markStaleWorkItems(olderThanMs, "working");
  return claimed + working;
}
