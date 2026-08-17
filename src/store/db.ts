import { Database } from "bun:sqlite";
import { WORK_ITEM_CREATED_EVENT, WORK_ITEM_TRANSITION_EVENT } from "./audit-events";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OrgSettingsParseError, parseOrgSettingsJson } from "./org-settings";
import type { OrgSettings, OrgSettingsInput } from "./org-settings";
import { KNOWN_ACTIONS } from "../scheduler/actions";
import { nextCronFire } from "../scheduler/cron";
import { schedulerJobFromRow, type SchedulerJobRow } from "../scheduler/store";
import type { SchedulerActionName, SchedulerJob } from "../scheduler/types";

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

export type SpaceObject = {
  id: string;
  space_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  uploaded_by: string;
  created_at: number;
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
export type WorkItemDelivery = "git" | "extension" | "chat";

export type WorkItem = {
  id: string;
  space_id: string;
  requester: string;
  description: string;
  repo: string | null;
  /** Existing-PR conflict-resolution shape (issue #186): non-null on a git item switches the executor to rebase/resolve/push. */
  pr_url: string | null;
  /** Head branch of the PR to rebase (issue #186). */
  pr_branch: string | null;
  /** Branch the PR branch is rebased onto; the executor defaults to "main". */
  base_branch: string | null;
  delivery: WorkItemDelivery;
  /** Per-task model pin (issue #185): a role ref ("fast"/"reasoning") or a resolved available model id. */
  model: string | null;
  /** Per-task thinking-effort pin (issue #185); null = no pin (space/default effort applies). */
  reasoning_effort: ModelThinkingLevel | null;
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

/**
 * One-time upload link row (issue #196): a single-use, short-TTL token the
 * browser upload endpoint consumes to store an api_key secret DIRECTLY into
 * the vault — the row is deleted on first consume, so an expired or replayed
 * token is just gone (fail closed). Field names mirror the table columns.
 */
export type UploadToken = {
  id: string;
  token: string;
  extension: string;
  scope: CredentialScope;
  actor: string;
  space_id: string | null;
  label: string;
  created_at: number;
  expires_at: number;
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
  /**
   * Idempotent upsert on first contact (issue #188): creates the row with
   * policy_json/settings '{}' and NEVER overwrites an existing space's
   * settings, policy, or name — re-contacts only bump updated_at.
   */
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
  createObject(input: {
    space_id: string;
    name: string;
    mime: string;
    size: number;
    sha256: string;
    uploaded_by: string;
    bytes: Uint8Array;
  }): Promise<SpaceObject>;
  listObjects(space_id: string): Promise<SpaceObject[]>;
  getObject(id: string): Promise<SpaceObject | null>;
  readObjectBytes(id: string): Promise<Uint8Array | null>;
  createWorkItem(input: {
    space_id: string;
    requester: string;
    description: string;
    repo?: string;
    delivery?: WorkItemDelivery;
    /** Per-task model pin (issue #185): a role ref ("fast"/"reasoning") or a resolved available model id. */
    model?: string;
    /** Per-task thinking-effort pin (issue #185). */
    reasoning_effort?: ModelThinkingLevel;
    /** PR context for the conflict-resolution job shape (issue #186): pr_url set → rebase/resolve/push instead of open-PR. */
    pr_url?: string;
    pr_branch?: string;
    base_branch?: string;
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
  /**
   * Mints a one-time upload token (issue #196): an opaque single-use row the
   * browser upload endpoint consumes. The token is the only credential the
   * link carries — the secret itself goes straight to the vault on upload.
   */
  createUploadToken(input: {
    extension: string;
    scope: CredentialScope;
    actor: string;
    spaceId?: string | null;
    label: string;
    /** Absolute ms; created_at + the caller's TTL. */
    expiresAt: number;
  }): UploadToken;
  /**
   * Non-consuming read of a token row (the upload form renders the label);
   * null when the token is unknown or already consumed.
   */
  getUploadToken(token: string): UploadToken | null;
  /**
   * Atomically consumes a token: deletes the row and returns it on the first
   * call. Anything else — unknown, already-used, or expired — returns
   * `{ok: false}` and deletes the row if it was expired (fail closed).
   */
  consumeUploadToken(token: string): { ok: true; row: UploadToken } | { ok: false };
  /** Unexpired tokens for an actor — the mint path's per-actor rate limit. */
  countActiveUploadTokens(actor: string): number;
  /**
   * Org settings singleton (issue #67): the validated settings blob, or
   * null when no row exists. Sync (bun:sqlite is synchronous, like getDb).
   * Throws OrgSettingsParseError on a malformed blob — fail closed, never
   * a silently-defaulted settings object.
   */
  getOrgSettings(): OrgSettings | null;
  /**
   * Validates and upserts the org settings blob (id=1). Throws
   * OrgSettingsParseError when the input is malformed and writes nothing.
   */
  setOrgSettings(settings: OrgSettingsInput): OrgSettings;
  /** Durable UTC cron jobs and their last/next fire state (issue #86). */
  createSchedulerJob(input: {
    action: string;
    cron: string;
    params?: Record<string, string>;
    spaceId?: string | null;
    createdBy: string;
  }): Promise<SchedulerJob>;
  getSchedulerJob(id: string): Promise<SchedulerJob | null>;
  listSchedulerJobs(): Promise<SchedulerJob[]>;
  /** Returns false when no row existed. */
  deleteSchedulerJob(id: string): Promise<boolean>;
  updateSchedulerNextFire(id: string, nextFireAt: number): Promise<void>;
  /** Records a result and advances from `at` to the next cron occurrence. */
  markSchedulerFired(id: string, result: "ok" | "error", at: number): Promise<void>;
  setSchedulerJobEnabled(id: string, enabled: boolean): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<number>;
  listAudit(opts?: ListAuditOpts): Promise<AuditRow[]>;
  /** The underlying Database handle — memory providers share this file (#20). */
  getDb(): Database;
  close(): void;
}

const DEFAULT_DB_PATH = "data/bottega.db";

function isKnownSchedulerAction(action: string): action is SchedulerActionName {
  return KNOWN_ACTIONS.some((known) => known === action);
}

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
 * transitions): done requires a delivery-specific result, blocked requires
 * non-empty evidence, and review requires a recorded approval.
 */
function assertLegalTransition(
  from: WorkItemState,
  to: WorkItemState,
  delivery: WorkItemDelivery,
  opts?: TransitionOpts,
): void {
  // Extension pickup authorizes headless completion (#128); git retains the
  // working -> review -> done delivery-approval path. Chat has no worker yet.
  const isDirectExtensionCompletion = delivery === "extension" && from === "working" && to === "done";
  if (!ALLOWED_TRANSITIONS[from].includes(to) && !isDirectExtensionCompletion) {
    throw new Error(`illegal work item transition ${from} -> ${to}`);
  }
  if (to === "done") assertDoneResult(delivery, opts?.result);
  if (to === "blocked" && !opts?.evidence?.trim()) {
    throw new Error("work item cannot transition to blocked without evidence");
  }
  if (to === "review" && !opts?.approval) {
    throw new Error("work item cannot transition to review without a recorded approval");
  }
}

/** Fails closed unless result JSON satisfies the selected delivery contract (issue #128). */
function assertDoneResult(delivery: WorkItemDelivery, result: string | undefined): void {
  let parsed: unknown;
  try {
    parsed = result ? JSON.parse(result) : null;
  } catch {
    parsed = null;
  }
  const record =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  if (delivery === "git" && !isNonEmptyString(record.pr_url)) {
    throw new Error("git work item cannot transition to done without result.pr_url");
  }
  if (delivery === "extension" && !isNonEmptyString(record.url)) {
    throw new Error("extension work item cannot transition to done without result.url");
  }
  if (!isNonEmptyString(record.summary)) {
    throw new Error("work item cannot transition to done without result.summary");
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
  const objectsDir = join(dirname(dbPath), "objects");
  mkdirSync(objectsDir, { recursive: true });
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
  // Idempotent migration (issue #128): CREATE TABLE IF NOT EXISTS cannot add
  // delivery to existing work_items tables. PRAGMA guards SQLite's otherwise
  // non-idempotent ALTER TABLE; the default backfills every existing row.
  if (!workItemColumns.includes("delivery")) {
    db.exec(
      "ALTER TABLE work_items ADD COLUMN delivery TEXT NOT NULL DEFAULT 'git' CHECK (delivery IN ('git','extension','chat'))",
    );
  }
  // Idempotent migration (issue #186): the resolve-conflicts job shape's
  // PR-context columns (pr_url set on a git item = rebase/resolve/push an
  // existing PR instead of opening one). Nullable; existing rows are
  // untouched (implement-and-open-PR remains the default).
  if (!workItemColumns.includes("pr_url")) {
    db.exec("ALTER TABLE work_items ADD COLUMN pr_url TEXT");
  }
  if (!workItemColumns.includes("pr_branch")) {
    db.exec("ALTER TABLE work_items ADD COLUMN pr_branch TEXT");
  }
  if (!workItemColumns.includes("base_branch")) {
    db.exec("ALTER TABLE work_items ADD COLUMN base_branch TEXT");
  }
  // Idempotent migration (issue #185): per-task model pin columns. Fresh
  // databases get them from schema.sql; existing work_items tables need the
  // explicit ALTER (CREATE TABLE IF NOT EXISTS is a no-op for them).
  const pinColumns = (db.query("PRAGMA table_info(work_items)").all() as { name: string }[]).map((c) => c.name);
  if (!pinColumns.includes("model")) {
    db.exec("ALTER TABLE work_items ADD COLUMN model TEXT");
  }
  if (!pinColumns.includes("reasoning_effort")) {
    db.exec(
      "ALTER TABLE work_items ADD COLUMN reasoning_effort TEXT CHECK (reasoning_effort IN ('off','low','medium','high'))",
    );
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
  const getSchedulerJobStmt = db.query("SELECT * FROM scheduler_jobs WHERE id = ?");
  const getObjectStmt = db.query("SELECT * FROM objects WHERE id = ?");

  /**
   * Idempotent upsert (issue #188): creates the row on first contact with
   * policy_json/settings '{}' and never overwrites an existing space's
   * settings, policy, or name — re-contacts only bump updated_at.
   */
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
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
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

  async function createObject(input: {
    space_id: string;
    name: string;
    mime: string;
    size: number;
    sha256: string;
    uploaded_by: string;
    bytes: Uint8Array;
  }): Promise<SpaceObject> {
    const id = `obj_${randomUUID()}`;
    const created_at = Date.now();
    const blobPath = join(objectsDir, input.sha256);
    if (!existsSync(blobPath)) writeFileSync(blobPath, input.bytes);
    db.query(
      `INSERT INTO objects (id, space_id, name, mime, size, sha256, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.space_id, input.name, input.mime, input.size, input.sha256, input.uploaded_by, created_at);
    return getObjectStmt.get(id) as SpaceObject;
  }

  async function listObjects(space_id: string): Promise<SpaceObject[]> {
    return db
      .query("SELECT * FROM objects WHERE space_id = ? ORDER BY created_at DESC")
      .all(space_id) as SpaceObject[];
  }

  async function getObject(id: string): Promise<SpaceObject | null> {
    return (getObjectStmt.get(id) as SpaceObject | null) ?? null;
  }

  async function readObjectBytes(id: string): Promise<Uint8Array | null> {
    const object = await getObject(id);
    if (!object) return null;
    try {
      return readFileSync(join(objectsDir, object.sha256));
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return null;
      throw err;
    }
  }

  async function createWorkItem(input: {
    space_id: string;
    requester: string;
    description: string;
    repo?: string;
    delivery?: WorkItemDelivery;
    /** Per-task model pin (issue #185): a role ref ("fast"/"reasoning") or a resolved available model id. */
    model?: string;
    /** Per-task thinking-effort pin (issue #185). */
    reasoning_effort?: ModelThinkingLevel;
    pr_url?: string;
    pr_branch?: string;
    base_branch?: string;
    /** Evidence entries recorded at creation (e.g. {kind: "issue_url", url}); `at` is stamped by the store. */
    evidence?: Array<{ kind: string; url: string }>;
  }): Promise<WorkItem> {
    const id = `wi_${randomUUID()}`;
    const t = Date.now();
    db.query(
      `INSERT INTO work_items (id, space_id, requester, description, repo, delivery, model, reasoning_effort, pr_url, pr_branch, base_branch, state, approvals, evidence, result, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', '[]', ?, NULL, ?, ?)`,
    ).run(
      id,
      input.space_id,
      input.requester,
      input.description,
      input.repo ?? null,
      input.delivery ?? "git",
      input.model ?? null,
      input.reasoning_effort ?? null,
      input.pr_url ?? null,
      input.pr_branch ?? null,
      input.base_branch ?? null,
      JSON.stringify((input.evidence ?? []).map((e) => ({ ...e, at: t }))),
      t,
      t,
    );
    const item = getWorkItemStmt.get(id) as WorkItem;
    appendAudit({
      space_id: input.space_id,
      actor: input.requester,
      event_type: WORK_ITEM_CREATED_EVENT,
      payload: JSON.stringify({
        id,
        requester: input.requester,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.reasoning_effort !== undefined ? { reasoning_effort: input.reasoning_effort } : {}),
      }),
    });
    return item;
  }

  async function claimNextWorkItem(): Promise<WorkItem | null> {
    // Chat has no worker yet (#128): defer it behind executable deliveries so
    // returning a chat item to open cannot starve git or extension work.
    const row = db
      .query(
        `UPDATE work_items
         SET state = 'claimed', updated_at = ?
         WHERE id = (
           SELECT id FROM work_items
           WHERE state = 'open'
           ORDER BY (delivery = 'chat') ASC, created_at ASC
           LIMIT 1
         )
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
    const current = getWorkItemStmt.get(id) as WorkItem | null;
    if (!current) throw new Error(`work item not found: ${id}`);
    assertLegalTransition(from, to, current.delivery, opts);
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

  function createUploadToken(input: {
    extension: string;
    scope: CredentialScope;
    actor: string;
    spaceId?: string | null;
    label: string;
    expiresAt: number;
  }): UploadToken {
    const extension = input.extension.trim();
    const label = input.label.trim();
    if (!extension || !label) throw new Error("upload token needs an extension and a label");
    if (input.scope !== "org" && input.scope !== "personal") throw new Error("upload token scope must be org or personal");
    if (!Number.isSafeInteger(input.expiresAt)) throw new Error("upload token expiresAt must be a safe integer");
    // Sweep expired rows lazily so the table stays bounded by live links.
    db.query("DELETE FROM upload_tokens WHERE expires_at <= ?").run(Date.now());
    const token = randomBytes(18).toString("base64url"); // 144 bits, unguessable
    return db
      .query(
        `INSERT INTO upload_tokens (id, token, extension, scope, actor, space_id, label, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        `ut_${randomUUID()}`,
        token,
        extension,
        input.scope,
        input.actor,
        input.spaceId ?? null,
        label,
        Date.now(),
        input.expiresAt,
      ) as UploadToken;
  }

  function getUploadToken(token: string): UploadToken | null {
    return (db.query("SELECT * FROM upload_tokens WHERE token = ?").get(token) as UploadToken | null) ?? null;
  }

  function consumeUploadToken(token: string): { ok: true; row: UploadToken } | { ok: false } {
    const now = Date.now();
    // Atomic single-use: only the first caller gets the row back; everyone
    // else (replay) sees nothing.
    const row = db
      .query(
        `DELETE FROM upload_tokens WHERE id = (SELECT id FROM upload_tokens WHERE token = ?1 AND expires_at > ?2) RETURNING *`,
      )
      .get(token, now) as UploadToken | null;
    if (row) return { ok: true, row };
    // Fail closed: an expired row must not linger for a future replay.
    db.query("DELETE FROM upload_tokens WHERE token = ?").run(token);
    return { ok: false };
  }

  function countActiveUploadTokens(actor: string): number {
    const row = db
      .query("SELECT COUNT(*) AS n FROM upload_tokens WHERE actor = ? AND expires_at > ?")
      .get(actor, Date.now()) as { n: number };
    return row.n;
  }

  async function createSchedulerJob(input: {
    action: string;
    cron: string;
    params?: Record<string, string>;
    spaceId?: string | null;
    createdBy: string;
  }): Promise<SchedulerJob> {
    if (!isKnownSchedulerAction(input.action)) {
      throw new Error(`unknown scheduler action: ${input.action}`);
    }
    const params = input.params ?? {};
    if (Object.values(params).some((value) => typeof value !== "string")) {
      throw new Error("scheduler job params must contain only string values");
    }
    const id = `sj_${randomUUID()}`;
    const createdAt = Date.now();
    const nextFireAt = nextCronFire(input.cron, createdAt);
    const row = db
      .query(
        `INSERT INTO scheduler_jobs
         (id, action, cron, params, space_id, created_by, created_at, next_fire_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        id,
        input.action,
        input.cron,
        JSON.stringify(params),
        input.spaceId ?? null,
        input.createdBy,
        createdAt,
        nextFireAt,
      ) as SchedulerJobRow;
    return schedulerJobFromRow(row);
  }

  async function getSchedulerJob(id: string): Promise<SchedulerJob | null> {
    const row = getSchedulerJobStmt.get(id) as SchedulerJobRow | null;
    return row ? schedulerJobFromRow(row) : null;
  }

  async function listSchedulerJobs(): Promise<SchedulerJob[]> {
    const rows = db
      .query("SELECT * FROM scheduler_jobs ORDER BY created_at, id")
      .all() as SchedulerJobRow[];
    return rows.map(schedulerJobFromRow);
  }

  async function deleteSchedulerJob(id: string): Promise<boolean> {
    return db.query("DELETE FROM scheduler_jobs WHERE id = ?").run(id).changes > 0;
  }

  async function updateSchedulerNextFire(id: string, nextFireAt: number): Promise<void> {
    if (!Number.isSafeInteger(nextFireAt)) throw new Error("scheduler nextFireAt must be a safe integer");
    const result = db.query("UPDATE scheduler_jobs SET next_fire_at = ? WHERE id = ?").run(nextFireAt, id);
    if (result.changes === 0) throw new Error(`scheduler job not found: ${id}`);
  }

  async function markSchedulerFired(id: string, result: "ok" | "error", at: number): Promise<void> {
    if (!Number.isSafeInteger(at)) throw new Error("scheduler fire time must be a safe integer");
    const row = getSchedulerJobStmt.get(id) as SchedulerJobRow | null;
    if (!row) throw new Error(`scheduler job not found: ${id}`);
    const nextFireAt = nextCronFire(row.cron, at);
    db.query(
      `UPDATE scheduler_jobs
       SET last_fired_at = ?, last_result = ?, next_fire_at = ?
       WHERE id = ?`,
    ).run(at, result, nextFireAt, id);
  }

  async function setSchedulerJobEnabled(id: string, enabled: boolean): Promise<void> {
    const result = db
      .query("UPDATE scheduler_jobs SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    if (result.changes === 0) throw new Error(`scheduler job not found: ${id}`);
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

  function getOrgSettings(): OrgSettings | null {
    const row = db.query("SELECT settings FROM org_settings WHERE id = 1").get() as
      | { settings: string }
      | null;
    if (!row) return null;
    const parsed = parseOrgSettingsJson(row.settings);
    if (!parsed.ok) throw new OrgSettingsParseError(parsed.errors);
    return parsed;
  }

  function setOrgSettings(settings: OrgSettingsInput): OrgSettings {
    const parsed = parseOrgSettingsJson(JSON.stringify(settings));
    if (!parsed.ok) throw new OrgSettingsParseError(parsed.errors);
    db.query(
      `INSERT INTO org_settings (id, settings, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(settings), Date.now());
    return parsed;
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
    createObject,
    listObjects,
    getObject,
    readObjectBytes,
    createWorkItem,
    claimNextWorkItem,
    transitionWorkItem,
    getWorkItem,
    markStaleWorkItems,
    upsertExtensionCredential,
    listExtensionCredentials,
    createUploadToken,
    getUploadToken,
    consumeUploadToken,
    countActiveUploadTokens,
    getOrgSettings,
    setOrgSettings,
    createSchedulerJob,
    getSchedulerJob,
    listSchedulerJobs,
    deleteSchedulerJob,
    updateSchedulerNextFire,
    markSchedulerFired,
    setSchedulerJobEnabled,
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
