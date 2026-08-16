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
  /** Per-space model settings JSON (issue #64): the `model_settings` tool's persistence home. */
  settings: string;
  created_at: number;
  updated_at: number;
};

/**
 * Thinking-effort values the space can pin for the reasoning role (issue
 * #64). A subset of the OMP effort scale — enough granularity for the
 * fast/reasoning split without exposing the full ladder.
 */
export type ModelThinkingLevel = "off" | "low" | "medium" | "high";

/**
 * Per-space model settings (issue #64), stored as the `spaces.settings`
 * JSON column. Model ids are bare ids as the session lists them (e.g.
 * "deepseek-v4-flash"); each slot falls back to `model` when unset at role
 * resolution (see resolveRoleTarget in agent-driver.ts).
 */
export type SpaceModelSettings = {
  /** The space's default model (the `default` role). */
  model?: string;
  /** Thinking effort for the reasoning role; also the space default effort. */
  reasoning_effort?: ModelThinkingLevel;
  /** Model for the `fast` role (falls back to `model` when unset). */
  fast_model?: string;
  /** Model for the `reasoning` role (falls back to `model` when unset). */
  reasoning_model?: string;
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

export type CredentialScope = "org" | "personal";

/**
 * Registry row for an extension credential (issue #51). Metadata only — the
 * secret payload lives in the OMP auth broker; `broker_credential_id` is the
 * broker snapshot entry id and `identity_key` the broker's identity key.
 * Field names mirror the table columns (see Space / WorkItem).
 */
export type ExtensionCredential = {
  id: string;
  provider: string;
  identity_key: string;
  owner: string | null;
  scope: CredentialScope;
  broker_credential_id: number;
  created_at: number;
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
  /** Per-space model settings (issue #64): the parsed `spaces.settings` column, {} when unset/invalid. */
  getSpaceSettings(id: string): Promise<SpaceModelSettings>;
  /** Replaces the space's model settings JSON; throws when the space does not exist. */
  updateSpaceSettings(id: string, settings: SpaceModelSettings): Promise<Space>;
  createWorkItem(input: {
    space_id: string;
    requester: string;
    description: string;
    repo?: string;
    /** Evidence entries recorded at creation (e.g. {kind: "issue_url", url}); `at` is stamped by the store. */
    evidence?: Array<{ kind: string; url: string }>;
  }): Promise<WorkItem>;
  /** Atomic open -> claimed: UPDATE ... WHERE id = (oldest open). Null when queue is empty. */
  claimNextWorkItem(): Promise<WorkItem | null>;
  /** Throws unless the row exists and is in `from`. */
  transitionWorkItem(id: string, from: WorkItemState, to: WorkItemState, opts?: TransitionOpts): Promise<WorkItem>;
  getWorkItem(id: string): Promise<WorkItem | null>;
  /** Moves items idle in `from` for longer than olderThanMs to blocked; returns count. */
  markStaleWorkItems(olderThanMs: number, from: WorkItemState): Promise<number>;
  /**
   * Registers or re-binds an extension credential (issue #51). One org row per
   * provider, one personal row per (provider, owner): re-running connect with
   * a refreshed broker credential updates identity_key + broker_credential_id.
   */
  upsertExtensionCredential(input: {
    provider: string;
    identityKey: string;
    /** Required for scope='personal'; must be null for scope='org'. */
    owner: string | null;
    scope: CredentialScope;
    brokerCredentialId: number;
  }): Promise<ExtensionCredential>;
  listExtensionCredentials(provider: string): Promise<ExtensionCredential[]>;
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

const MODEL_SETTING_KEYS = ["model", "reasoning_effort", "fast_model", "reasoning_model"] as const;
const MODEL_THINKING_LEVELS: readonly string[] = ["off", "low", "medium", "high"];

/**
 * Parses the `spaces.settings` JSON column into a SpaceModelSettings.
 * Defensive (the column is only ever written by the store, but a hand-edited
 * or older DB must not crash the reader): known keys with valid values
 * survive; anything else is dropped. Invalid JSON yields {}.
 */
export function parseSpaceSettings(text: string | null | undefined): SpaceModelSettings {
  if (!text?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: SpaceModelSettings = {};
  const record = parsed as Record<string, unknown>;
  for (const key of MODEL_SETTING_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const trimmed = value.trim();
    if (key === "reasoning_effort") {
      if (!MODEL_THINKING_LEVELS.includes(trimmed)) continue;
      out.reasoning_effort = trimmed as SpaceModelSettings["reasoning_effort"];
    } else {
      out[key] = trimmed;
    }
  }
  return out;
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
  // Idempotent migration (issue #64): databases created before the model
  // settings column existed keep their spaces table (CREATE TABLE IF NOT
  // EXISTS is a no-op), so add the column explicitly when it is missing.
  const spaceColumns = (db.query("PRAGMA table_info(spaces)").all() as { name: string }[]).map((c) => c.name);
  if (!spaceColumns.includes("settings")) {
    db.exec("ALTER TABLE spaces ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
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
      `INSERT INTO spaces (id, platform, channel_id, name, policy_json, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', '{}', ?, ?)
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

  async function getSpaceSettings(id: string): Promise<SpaceModelSettings> {
    const space = await getSpace(id);
    return space ? parseSpaceSettings(space.settings) : {};
  }

  async function updateSpaceSettings(id: string, settings: SpaceModelSettings): Promise<Space> {
    const row = db
      .query("UPDATE spaces SET settings = ?, updated_at = ? WHERE id = ? RETURNING *")
      .get(JSON.stringify(settings), Date.now(), id) as Space | null;
    if (!row) throw new Error(`space not found: ${id}`);
    return row;
  }

  async function createWorkItem(input: {
    space_id: string;
    requester: string;
    description: string;
    repo?: string;
    /** Evidence entries recorded at creation (e.g. {kind: "issue_url", url}); `at` is stamped by the store. */
    evidence?: Array<{ kind: string; url: string }>;
  }): Promise<WorkItem> {
    const id = `wi_${randomUUID()}`;
    const t = Date.now();
    db.query(
      `INSERT INTO work_items (id, space_id, requester, description, repo, state, approvals, evidence, result, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', '[]', ?, NULL, ?, ?)`,
    ).run(
      id,
      input.space_id,
      input.requester,
      input.description,
      input.repo ?? null,
      JSON.stringify((input.evidence ?? []).map((e) => ({ ...e, at: t }))),
      t,
      t,
    );
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

  async function upsertExtensionCredential(input: {
    provider: string;
    identityKey: string;
    owner: string | null;
    scope: CredentialScope;
    brokerCredentialId: number;
  }): Promise<ExtensionCredential> {
    const provider = input.provider.trim();
    const identityKey = input.identityKey.trim();
    const owner = input.owner?.trim() ?? "";
    if (!provider || !identityKey) throw new Error("extension credential needs a provider and an identity key");
    if (input.scope === "personal" && !owner) {
      throw new Error("personal extension credentials need an owner");
    }
    if (input.scope === "org" && input.owner !== null) {
      throw new Error("org extension credentials cannot have an owner");
    }
    const id = `ec_${randomUUID()}`;
    const t = Date.now();
    // Conflict targets match the partial unique indexes in schema.sql.
    const conflictTarget = input.scope === "org" ? "(provider) WHERE scope = 'org'" : "(provider, owner) WHERE scope = 'personal'";
    return db
      .query(
        `INSERT INTO extension_credentials (id, provider, identity_key, owner, scope, broker_credential_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT${conflictTarget}
         DO UPDATE SET identity_key = excluded.identity_key,
                       broker_credential_id = excluded.broker_credential_id,
                       created_at = excluded.created_at
         RETURNING *`,
      )
      .get(id, provider, identityKey, input.scope === "personal" ? owner : null, input.scope, input.brokerCredentialId, t) as ExtensionCredential;
  }

  async function listExtensionCredentials(provider: string): Promise<ExtensionCredential[]> {
    return db
      .query("SELECT * FROM extension_credentials WHERE provider = ? ORDER BY scope, created_at")
      .all(provider) as ExtensionCredential[];
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
    getSpaceSettings,
    updateSpaceSettings,
    createWorkItem,
    claimNextWorkItem,
    transitionWorkItem,
    getWorkItem,
    markStaleWorkItems,
    upsertExtensionCredential,
    listExtensionCredentials,
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
