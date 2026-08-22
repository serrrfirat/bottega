import { Database } from "bun:sqlite";
import { WORK_ITEM_CREATED_EVENT, WORK_ITEM_TRANSITION_EVENT } from "./audit-events";
import { postOutboxRow } from "./outbox";
import { runMigrations } from "./migrations";
import { randomBytes, randomUUID } from "node:crypto";
import type { WorkerJob, WorkerJobKind, WorkerJobStatus } from "../worker/envelope";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OrgSettingsParseError, parseOrgSettingsJson } from "./org-settings";
import type { OrgSettings, OrgSettingsInput } from "./org-settings";
import { KNOWN_ACTIONS } from "../scheduler/actions";
import { nextCronFire } from "../scheduler/cron";
import {
  schedulerInvocationFromRow,
  schedulerJobFromRow,
  type SchedulerInvocationRow,
  type SchedulerJobRow,
} from "../scheduler/store";
import type {
  SchedulerActionName,
  SchedulerInvocation,
  SchedulerJob,
} from "../scheduler/types";
import { z } from "zod";

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
  /** Who owns the item (issue #159): the requester at creation, the executor's identity once claimed. */
  assignee: string | null;
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
  /**
   * Explicit task-level skills (issues #234/#235, Tier 3): a JSON-array
   * TEXT of skill names ("[\"pr_review\"]") injected into the item session
   * at claim — same TEXT-JSON convention as `approvals`/`evidence`.
   */
  skills: string;
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
export type ConnectionStatus =
  | "active"
  | "replacing"
  | "replace_cleanup_pending"
  | "disconnecting_boundary"
  | "disconnecting_authority"
  | "disconnected";

/**
 * Durable extension connection (issues #51/#318). Metadata only: secret
 * payloads remain inside the credential boundary. `id` is the stable
 * operator target; revision and status provide fail-closed lifecycle CAS.
 */
export type ExtensionCredential = {
  id: string;
  provider: string;
  vault_provider: string;
  identity_key: string;
  owner: string | null;
  scope: CredentialScope;
  broker_credential_id: number;
  pending_broker_credential_id: number | null;
  pending_vault_provider: string | null;
  pending_identity_key: string | null;
  retiring_broker_credential_id: number | null;
  status: ConnectionStatus;
  revision: number;
  created_at: number;
  updated_at: number;
};

/**
 * Runtime extension registry row (issue #233): a runtime-registered
 * extension's PinnedSnapshot document (machine state — never a repo file).
 * `snapshot` is the JSON PinnedSnapshot (schema/extensionId/pinnedAt/
 * source/manifest); the registry's fail-closed parse validates it on read.
 * Field names mirror the table columns.
 */
export type RuntimeExtensionRow = {
  id: string;
  snapshot: string;
  registered_by: string;
  space_id: string | null;
  created_at: number;
  updated_at: number;
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
  connection_id: string | null;
  expected_revision: number | null;
  created_at: number;
  expires_at: number;
};

/**
 * Pending generic MCP OAuth flow row (issue #198): the connect mint writes
 * one row per authorization-code + PKCE flow. The row holds ONLY flow
 * bookkeeping — the PKCE verifier, the dynamically registered client info,
 * the cached discovery state, and the authorization URL — NEVER a token;
 * the access/refresh tokens land in the vault when the callback exchanges
 * the code. `token` is the OAuth `state` parameter: opaque, single-use,
 * short-TTL (deleted on first consume; expired/replayed are just gone —
 * fail closed).
 */
export type OAuthFlow = {
  id: string;
  token: string;
  provider: string;
  scope: CredentialScope;
  actor: string;
  space_id: string | null;
  label: string;
  server_url: string;
  redirect_uri: string;
  flow: string;
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

/** Work-item-created audit payload (issue #10); optional fields are omitted from the JSON. */
export type CreatedWorkItemAuditPayload = {
  id: string;
  requester: string;
  /** The requester owns the item at creation (issue #159). */
  assignee: string;
  model?: string;
  reasoning_effort?: ModelThinkingLevel;
};

export type ListAuditOpts = {
  space?: string;
  since?: number;
  event_type?: string;
  limit?: number;
};

export interface AuditCursor {
  ts: number;
  id: number;
}

/** Indexed, newest-first audit query. Payload filters only inspect valid JSON rows. */
export interface AuditQueryOpts {
  space_id?: string;
  actor?: string;
  event_type?: string;
  since?: number;
  until?: number;
  tool?: string;
  extension?: string;
  cursor?: AuditCursor;
  /** Clamped to 1..100 at the store boundary. */
  limit?: number;
}

export interface AuditPage {
  rows: AuditRow[];
  nextCursor: AuditCursor | null;
}

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
  /** Every known space row, creation-ordered. Used by boot-time proactive seeders to discover opt-in destinations. */
  listSpaces(): Promise<Space[]>;
  updatePolicy(id: string, policyJson: string): Promise<Space>;
  /** Per-space model settings (issue #64): the parsed `spaces.settings` column, {} when unset/invalid. */
  getSpaceSettings(id: string): Promise<SpaceModelSettings>;
  /**
   * The space's EFFECTIVE model settings (issue #207): the per-space
   * settings with the org-wide model defaults (org_settings.models) filling
   * any unset slot — the operator's per-org choice (#185/#189/#199) is the
   * session default unless the space overrides it. Precedence: space >
   * org > agent-dir pin (the driver's last-resort fallback). A space with
   * no settings and no org row yields {}.
   */
  getEffectiveSpaceSettings(id: string): Promise<SpaceModelSettings>;
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
    /** Explicit task-level skills (issues #234/#235): skill names injected into the item session at claim. */
    skills?: string[];
  }): Promise<WorkItem>;
  /** Atomic open -> claimed for a SPECIFIC item (the worker claims by the job payload). Null when the item is not open. */
  claimWorkItemById(id: string, assignee?: string): Promise<WorkItem | null>;
  /** Throws unless the row exists and is in `from`. */
  transitionWorkItem(id: string, from: WorkItemState, to: WorkItemState, opts?: TransitionOpts): Promise<WorkItem>;
  getWorkItem(id: string): Promise<WorkItem | null>;
  /**
   * The visible queue (issue #159): work items of a space (or org-wide when
   * no space filter), newest first, optionally narrowed by state.
   */
  listWorkItems(filter?: { space_id?: string; state?: WorkItemState }): Promise<WorkItem[]>;
  /** Moves items idle in `from` for longer than olderThanMs to blocked; returns count. */
  markStaleWorkItems(olderThanMs: number, from: WorkItemState): Promise<number>;
  /**
   * Enqueues a worker job (epic #170). Idempotent by envelope id: a
   * duplicate enqueue is a no-op (git/extension work items auto-enqueue at
   * creation with the work item id as the job id).
   */
  enqueueJob(input: { id: string; kind: WorkerJobKind; payload: unknown; spaceId?: string | null }): Promise<void>;
  /**
   * Atomic claim of the oldest claimable job (epic #170): a queued job past
   * its backoff gate, or a running job whose lease expired (crash recovery).
   * The single UPDATE sets status=running, lease_until=now+leaseMs and
   * bumps attempts. Null when nothing is claimable.
   */
  claimNextJob(leaseMs: number): Promise<WorkerJob | null>;
  /** Returns the job row for observability/tests. */
  getJob(id: string): Promise<WorkerJob | null>;
  /** Requeues a running job with a backoff not-before gate; false when the job is not running. */
  requeueJob(id: string, backoffMs: number): Promise<boolean>;
  /**
   * Renews a RUNNING job's lease to `leaseUntilMs` (issue #101: the sandbox
   * supervisor keeps its child's lease alive while the job is healthy).
   * False when the job is no longer running — the lease-reclaim race, i.e.
   * another worker already swept and re-claimed it — so the renewer stops
   * believing it owns the job.
   */
  renewJobLease(id: string, leaseUntilMs: number): Promise<boolean>;
  /** Marks a running job completed (the outbox row is the completion signal); false when not running. */
  completeJob(id: string): Promise<boolean>;
  /** Marks a queued/running job failed (max attempts or the unclaimed TTL); false when already terminal. */
  failJob(id: string): Promise<boolean>;
  /**
   * Fails queued jobs never claimed within ttlMs and returns them — the
   * executor audits job.unclaimed + nudges per returned job (epic #170
   * fail-loud). A requeued job holding a backoff gate is never swept.
   */
  markUnclaimedJobs(ttlMs: number): Promise<WorkerJob[]>;
  /**
   * Durable pending-turn backstop (issue #312). Persists a queued mid-turn
   * Slack message so a restart re-enqueues accepted-but-unfinished turns.
   * Records the message ONCE: the durable identity is the inbound Slack
   * (space_id, ts), mirroring how worker_jobs claim by envelope id — a
   * duplicate enqueue of the same message is a no-op.
   */
  enqueuePendingTurn(input: {
    spaceId: string;
    ts: string;
    principal: string;
    text: string;
    rootThreadTs?: string;
  }): Promise<{ created: boolean }>;
  /**
   * Recovery claim (issue #312): atomically claims the eligible durable
   * rows for a space (each claimed exactly once) and returns them in arrival
   * order to re-enqueue after a restart. "Eligible" mirrors the worker_jobs
   * lease claim: a 'pending' row is always claimable; a 'claimed' row (a
   * prior recovery took it but the turn never settled — crash mid-drain) is
   * reclaimed only after its lease expires, so two racing recovery passes
   * cannot both deliver the same turn. Empty when nothing is eligible.
   */
  recoverPendingTurns(spaceId: string, leaseMs: number): Promise<PendingTurnClaim[]>;
  /** Marks a durable pending turn done after its drained turn settles, so a restart never re-delivers it. */
  completePendingTurn(spaceId: string, ts: string): Promise<void>;
  /** Observability/test surface: durable pending-turn rows for a space (all statuses), arrival order. */
  listPendingTurns(spaceId?: string): Promise<Array<PendingTurnRow & { status: string }>>;
  /**
   * Creates or reactivates the one connection for an org/provider or
   * personal provider/owner. Existing rows retain their stable id and
   * advance their revision.
   */
  upsertExtensionCredential(input: {
    provider: string;
    /** Credential-store namespace; defaults to provider for legacy/OAuth rows. */
    vaultProvider?: string;
    identityKey: string;
    /** Required for scope='personal'; must be null for scope='org'. */
    owner: string | null;
    scope: CredentialScope;
    brokerCredentialId: number;
  }): Promise<ExtensionCredential>;
  /** Active rows only: this is the runtime credential-resolution view. */
  listExtensionCredentials(provider: string): Promise<ExtensionCredential[]>;
  /** Deterministic operator read model, including disconnected rows. */
  listExtensionConnections(): Promise<ExtensionCredential[]>;
  getExtensionConnection(id: string): Promise<ExtensionCredential | null>;
  beginExtensionConnectionReplacement(input: {
    id: string;
    vaultProvider: string;
    expectedRevision: number;
    identityKey: string;
    brokerCredentialId: number;
  }): Promise<ExtensionCredential>;
  commitExtensionConnectionReplacement(id: string, expectedRevision: number): Promise<ExtensionCredential>;
  rollbackExtensionConnectionReplacement(id: string, expectedRevision: number): Promise<ExtensionCredential>;
  beginExtensionConnectionDisconnect(id: string, expectedRevision: number): Promise<ExtensionCredential>;
  transitionExtensionConnection(input: {
    id: string;
    from: ConnectionStatus;
    to: ConnectionStatus;
    clearRetiringAuthority?: boolean;
  }): Promise<ExtensionCredential>;
  /**
   * Runtime extension registry (issue #233): persists one runtime-registered
   * extension's PinnedSnapshot document (machine state — never a repo file).
   * Idempotent upsert by extension id: re-registering refreshes the row.
   * `snapshot` is the JSON PinnedSnapshot (schema/extensionId/pinnedAt/
   * source/manifest) the registry's fail-closed parse accepts.
   */
  upsertRuntimeExtension(input: {
    extensionId: string;
    snapshot: string;
    registeredBy: string;
    spaceId?: string | null;
  }): Promise<RuntimeExtensionRow>;
  /** Every runtime-registered extension, in registration order. */
  listRuntimeExtensions(): Promise<RuntimeExtensionRow[]>;
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
    connectionId?: string;
    expectedRevision?: number;
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
   * Mints a pending generic MCP OAuth flow (issue #198): an opaque
   * single-use row the OAuth callback consumes. The row carries the flow's
   * PKCE/client/discovery bookkeeping — never a token.
   */
  createOAuthFlow(input: {
    token: string;
    provider: string;
    scope: CredentialScope;
    actor: string;
    spaceId?: string | null;
    label: string;
    serverUrl: string;
    redirectUri: string;
    /** JSON: {codeVerifier, clientInformation, discoveryState, authorizationUrl}. */
    flow: string;
    /** Absolute ms; created_at + the caller's TTL. */
    expiresAt: number;
  }): OAuthFlow;
  /**
   * Non-consuming read of a flow row (diagnostics); null when the token is
   * unknown or already consumed.
   */
  getOAuthFlow(token: string): OAuthFlow | null;
  /**
   * Atomically consumes a flow: deletes the row and returns it on the first
   * call. Anything else — unknown, already-used, or expired — returns
   * `{ok: false}` and deletes the row if it was expired (fail closed).
   */
  consumeOAuthFlow(token: string): { ok: true; row: OAuthFlow } | { ok: false };
  /** Unexpired flows for an actor — the mint path's per-actor rate limit. */
  countActiveOAuthFlows(actor: string): number;
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
    createdAt?: number;
  }): Promise<SchedulerJob>;
  getSchedulerJob(id: string): Promise<SchedulerJob | null>;
  listSchedulerJobs(): Promise<SchedulerJob[]>;
  /** Compare-and-swap update. Omitted fields retain their current values. */
  updateSchedulerJob(input: {
    id: string;
    expectedRevision: number;
    action?: string;
    cron?: string;
    params?: Record<string, string>;
    now: number;
  }): Promise<SchedulerJob>;
  pauseSchedulerJob(id: string, expectedRevision: number): Promise<SchedulerJob>;
  resumeSchedulerJob(id: string, expectedRevision: number, now: number): Promise<SchedulerJob>;
  /** Returns false when no row existed. */
  deleteSchedulerJob(id: string): Promise<boolean>;
  updateSchedulerNextFire(id: string, nextFireAt: number): Promise<void>;
  skipSchedulerOccurrence(id: string, expectedNextFireAt: number, nextFireAt: number): Promise<boolean>;
  setSchedulerJobEnabled(id: string, enabled: boolean): Promise<void>;
  enqueueSchedulerRunNow(input: {
    jobId: string;
    expectedRevision: number;
    invocationId: string;
    requestedAt: number;
  }): Promise<{ invocation: SchedulerInvocation; created: boolean }>;
  claimScheduledSchedulerInvocation(
    jobId: string,
    expectedNextFireAt: number,
    requestedAt: number,
  ): Promise<SchedulerInvocation | null>;
  claimNextSchedulerInvocation(now: number): Promise<SchedulerInvocation | null>;
  completeSchedulerInvocation(id: string, result: "ok" | "error", completedAt: number): Promise<void>;
  listSchedulerInvocations(filter?: { jobId?: string }): Promise<SchedulerInvocation[]>;
  appendAudit(entry: AuditEntry): Promise<number>;
  listAudit(opts?: ListAuditOpts): Promise<AuditRow[]>;
  /** Indexed, cursor-backed audit search; always capped and newest-first. */
  queryAudit(opts?: AuditQueryOpts): Promise<AuditPage>;
  /** The durable ingest poll cursor for a provider (issue #101); null when never persisted. */
  getIngestWatermark(provider: string): Promise<string | null>;
  /** Persists the ingest poll boundary for a provider (issue #101). */
  setIngestWatermark(provider: string, cursor: string): Promise<void>;
  /** The underlying Database handle — memory providers share this file (#20). */
  getDb(): Database;
  close(): void;
}

const DEFAULT_DB_PATH = "data/bottega.db";

function isKnownSchedulerAction(action: string): action is SchedulerActionName {
  return KNOWN_ACTIONS.some((known) => known === action);
}

/** The state machine's legal moves per source state (issue #10). */
interface LegalTransitions {
  open: readonly WorkItemState[];
  claimed: readonly WorkItemState[];
  working: readonly WorkItemState[];
  review: readonly WorkItemState[];
  done: readonly WorkItemState[];
  blocked: readonly WorkItemState[];
  aborted: readonly WorkItemState[];
}

/** The outbox work_item notification payload (issue #159): the landing state + the queue row. */
interface WorkItemNotificationPayload {
  state: string;
  workItemId: string;
  description: string;
  /** Present only when the transition carries evidence (blocked landings). */
  evidence?: string;
}

/** Allowed state machine moves (issue #10). The atomic claim implements open -> claimed. */
const ALLOWED_TRANSITIONS: LegalTransitions = {
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
  // Extension pickup (#128) and an in-channel chat answer (#202) authorize
  // direct completion. Git retains the working -> review -> done path because
  // its PR deliverable still needs human review.
  const isDirectNonGitCompletion =
    (delivery === "extension" || delivery === "chat") && from === "working" && to === "done";
  if (!ALLOWED_TRANSITIONS[from].includes(to) && !isDirectNonGitCompletion) {
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

/**
 * Result JSON accepted for a done transition (issue #128). Optional string
 * fields; a non-object payload fails the whole parse and the checks below
 * fail closed. Extra keys are ignored.
 */
const DONE_RESULT_SCHEMA = z.object({
  pr_url: z.string().optional(),
  url: z.string().optional(),
  summary: z.string().optional(),
});

/** Fails closed unless result JSON satisfies the selected delivery contract (issue #128). */
function assertDoneResult(delivery: WorkItemDelivery, result: string | undefined): void {
  let record: z.infer<typeof DONE_RESULT_SCHEMA> = {};
  try {
    record = DONE_RESULT_SCHEMA.parse(result ? JSON.parse(result) : null);
  } catch {
    // Malformed JSON or a non-object payload: record stays empty and the
    // required-field checks below fail closed.
  }
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

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

const MODEL_SETTING_KEYS = ["model", "reasoning_effort", "fast_model", "reasoning_model"] as const;
const MODEL_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
const MODEL_THINKING_LEVEL_SCHEMA = z.enum(MODEL_THINKING_LEVELS);

/**
 * Lenient per-key contract for the `spaces.settings` JSON column: a known
 * key holding a non-string value is replaced with "" (dropped by the trim
 * check below) rather than failing the whole read, so one malformed key
 * never discards the other settings.
 */
const SPACE_SETTINGS_SCHEMA = z.object({
  model: z.string().catch("").optional(),
  reasoning_effort: z.string().catch("").optional(),
  fast_model: z.string().catch("").optional(),
  reasoning_model: z.string().catch("").optional(),
});

/**
 * Parses the `spaces.settings` JSON column into a SpaceModelSettings.
 * Defensive (the column is only ever written by the store, but a hand-edited
 * or older DB must not crash the reader): known keys with valid values
 * survive; anything else is dropped. Invalid JSON yields {}.
 */
export function parseSpaceSettings(text: string | null | undefined): SpaceModelSettings {
  if (!text?.trim()) return {};
  let record: z.infer<typeof SPACE_SETTINGS_SCHEMA>;
  try {
    record = SPACE_SETTINGS_SCHEMA.parse(JSON.parse(text));
  } catch {
    return {};
  }
  const out: SpaceModelSettings = {};
  for (const key of MODEL_SETTING_KEYS) {
    const value = record[key];
    if (!value?.trim()) continue;
    const trimmed = value.trim();
    if (key === "reasoning_effort") {
      const level = MODEL_THINKING_LEVEL_SCHEMA.safeParse(trimmed);
      if (!level.success) continue;
      out.reasoning_effort = level.data;
    } else {
      out[key] = trimmed;
    }
  }
  return out;
}

/** Raw `worker_jobs` row shape (epic #170). */
type WorkerJobRow = {
  id: string;
  kind: WorkerJobKind;
  payload: string;
  space_id: string | null;
  status: string;
  attempts: number;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
};

/** Parses a worker_jobs row into the typed envelope (payload JSON decoded). */
function parseWorkerJob(row: WorkerJobRow): WorkerJob {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    spaceId: row.space_id ?? undefined,
    attempts: row.attempts,
    leaseUntil: row.lease_until,
    // SAFETY: the status column is written only by the store's own lifecycle
    // transitions (queued/running/completed/failed), so the TEXT value is
    // always one of the declared WorkerJobStatus values.
    status: row.status as WorkerJobStatus,
  };
}

/**
 * Durable pending-turn lifecycle (issue #312): the durable payload of a
 * queued (accepted) Slack turn — space, sender, text, and conversation root
 * for thread replies — that survives a restart as a crash-safe backstop
 * while the accepted message also lives in Slack history. The claimed
 * payload's shape, used by SpaceService when it re-enqueues a recovered
 * turn, matches the in-memory PendingTurn.
 */
export type PendingTurnClaim = {
  spaceId: string;
  ts: string;
  principal: string;
  text: string;
  rootThreadTs?: string;
};

/** The durable pending-turn row's full shape (issue #312). */
export type PendingTurnRow = {
  id: number;
  space_id: string;
  ts: string;
  principal: string;
  text: string;
  root_thread_ts: string | null;
  status: "pending" | "claimed" | "done";
  created_at: number;
  claimed_at: number | null;
  lease_until: number | null;
  completed_at: number | null;
};

/** Parses a durable pending-turn row into the claimed payload. */
function pendingTurnFromRow(row: PendingTurnRow): PendingTurnClaim {
  return {
    spaceId: row.space_id,
    ts: row.ts,
    principal: row.principal,
    text: row.text,
    rootThreadTs: row.root_thread_ts ?? undefined,
  };
}

/**
 * Opens (creating if needed) the SQLite store at `dbPath` and applies every
 * pending ordered migration before exposing the database.
 */
export function createStore(dbPath: string = DEFAULT_DB_PATH): Store {
  const objectsDir = join(dirname(dbPath), "objects");
  mkdirSync(objectsDir, { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA foreign_keys = ON;");
    runMigrations(db);
  } catch (error) {
    db.close();
    throw error;
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
    // SAFETY: the upsert above guarantees a row with this id exists; SELECT returns its full shape.
    return getSpaceStmt.get(id) as Space;
  }

  async function getSpace(id: string): Promise<Space | null> {
    // SAFETY: get() yields undefined when no row matches; undefined maps to null below.
    return (getSpaceStmt.get(id) as Space | null) ?? null;
  }

  async function listSpaces(): Promise<Space[]> {
    // SAFETY: SELECT * returns one row per space, each with Space's column shape.
    return db.query("SELECT * FROM spaces ORDER BY created_at, id").all() as Space[];
  }

  async function updatePolicy(id: string, policyJson: string): Promise<Space> {
    // SAFETY: UPDATE ... RETURNING * returns the updated row only when the id exists; a missing id throws below.
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

  async function getEffectiveSpaceSettings(id: string): Promise<SpaceModelSettings> {
    const space = await getSpaceSettings(id);
    const orgModels = getOrgSettings()?.models;
    if (!orgModels) return space;
    const effective: SpaceModelSettings = { ...space };
    // The org-wide defaults fill only the slots the space left unset; a
    // space that sets ANY knob keeps its own value for that knob.
    if (effective.model === undefined && orgModels.default !== undefined) effective.model = orgModels.default;
    if (effective.fast_model === undefined && orgModels.fast !== undefined) effective.fast_model = orgModels.fast;
    if (effective.reasoning_model === undefined && orgModels.reasoning !== undefined) {
      effective.reasoning_model = orgModels.reasoning;
    }
    if (effective.reasoning_effort === undefined && orgModels.effort !== undefined) {
      // Defensive narrowing: the org blob validates effort as a string, but
      // only the enum levels are meaningful for role resolution.
      const level = MODEL_THINKING_LEVEL_SCHEMA.safeParse(orgModels.effort);
      if (level.success) effective.reasoning_effort = level.data;
    }
    return effective;
  }

  async function updateSpaceSettings(id: string, settings: SpaceModelSettings): Promise<Space> {
    // SAFETY: UPDATE ... RETURNING * returns the updated row only when the id exists; a missing id throws below.
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
    // SAFETY: the INSERT above guarantees a row with this id exists; SELECT returns its full shape.
    return getObjectStmt.get(id) as SpaceObject;
  }

  async function listObjects(space_id: string): Promise<SpaceObject[]> {
    // SAFETY: SELECT * returns one row per objects match, each with SpaceObject's column shape.
    return db
      .query("SELECT * FROM objects WHERE space_id = ? ORDER BY created_at DESC")
      .all(space_id) as SpaceObject[];
  }

  async function getObject(id: string): Promise<SpaceObject | null> {
    // SAFETY: get() yields undefined when no row matches; undefined maps to null below.
    return (getObjectStmt.get(id) as SpaceObject | null) ?? null;
  }

  async function readObjectBytes(id: string): Promise<Uint8Array | null> {
    const object = await getObject(id);
    if (!object) return null;
    try {
      return readFileSync(join(objectsDir, object.sha256));
    } catch (err) {
      // SAFETY: readFileSync throws Error instances; Node fs errors carry a `code` property.
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
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
    /** Explicit task-level skills (issues #234/#235): skill names injected into the item session at claim. */
    skills?: string[];
  }): Promise<WorkItem> {
    const id = `wi_${randomUUID()}`;
    const t = Date.now();
    const delivery = input.delivery ?? "git";
    // Ownership (issue #159): the requester owns the item at creation; the
    // executor's claim reassigns it later.
    db.query(
      `INSERT INTO work_items (id, space_id, requester, assignee, description, repo, delivery, model, reasoning_effort, pr_url, pr_branch, base_branch, state, approvals, evidence, skills, result, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', '[]', ?, ?, NULL, ?, ?)`,
    ).run(
      id,
      input.space_id,
      input.requester,
      input.requester,
      input.description,
      input.repo ?? null,
      delivery,
      input.model ?? null,
      input.reasoning_effort ?? null,
      input.pr_url ?? null,
      input.pr_branch ?? null,
      input.base_branch ?? null,
      JSON.stringify((input.evidence ?? []).map((e) => ({ ...e, at: t }))),
      JSON.stringify(input.skills ?? []),
      t,
      t,
    );
    // SAFETY: the INSERT above guarantees a row with this id exists; SELECT returns its full shape.
    const item = getWorkItemStmt.get(id) as WorkItem;
    const createdPayload: CreatedWorkItemAuditPayload = { id, requester: input.requester, assignee: input.requester };
    if (input.model !== undefined) createdPayload.model = input.model;
    if (input.reasoning_effort !== undefined) createdPayload.reasoning_effort = input.reasoning_effort;
    appendAudit({
      space_id: input.space_id,
      actor: input.requester,
      event_type: WORK_ITEM_CREATED_EVENT,
      payload: JSON.stringify(createdPayload),
    });
    // Epic #170: git/extension work items enqueue a worker job with the SAME
    // id — one id across enqueue → claim → run → outbox → post. Chat items
    // have no worker (the space agent handles them in-session) and never
    // enqueue.
    if (delivery === "git" || delivery === "extension") {
      enqueueJob({ id, kind: delivery, payload: { workItemId: id }, spaceId: input.space_id });
    }
    return item;
  }

  /**
   * Atomic open -> claimed for a SPECIFIC item (the worker claims by the job
   * payload). Null when the item is not open. The claim stamps the
   * assignee (issue #159): ownership passes to the claiming worker, whose
   * identity is "executor" everywhere on the audit trail.
   */
  async function claimWorkItemById(id: string, assignee = "executor"): Promise<WorkItem | null> {
    // SAFETY: UPDATE ... RETURNING * returns the claimed row, or undefined when the item is not open.
    const row = db
      .query(
        `UPDATE work_items SET state = 'claimed', assignee = ?, updated_at = ? WHERE id = ? AND state = 'open' RETURNING *`,
      )
      .get(assignee, Date.now(), id) as WorkItem | null;
    return row ?? null;
  }

  async function enqueueJob(input: { id: string; kind: WorkerJobKind; payload: unknown; spaceId?: string | null }): Promise<void> {
    const t = Date.now();
    // ON CONFLICT DO NOTHING keeps enqueue idempotent by envelope id: a
    // duplicate dispatch of the same job is a no-op, never a second row.
    db.query(
      `INSERT INTO worker_jobs (id, kind, payload, space_id, status, attempts, lease_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 0, NULL, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      input.id,
      input.kind,
      input.payload === undefined ? "null" : JSON.stringify(input.payload),
      input.spaceId ?? null,
      t,
      t,
    );
  }

  async function claimNextJob(leaseMs: number): Promise<WorkerJob | null> {
    const now = Date.now();
    // The single atomic claim UPDATE (epic #170): a queued job past its
    // backoff gate, or a running job whose lease expired (crash recovery),
    // oldest first. SAFETY: UPDATE ... RETURNING * returns the claimed row,
    // or undefined when nothing is claimable.
    const row = db
      .query(
        `UPDATE worker_jobs
         SET status = 'running', lease_until = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = (
           SELECT id FROM worker_jobs
           WHERE (status = 'queued' AND (lease_until IS NULL OR lease_until <= ?))
              OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ?)
           ORDER BY created_at ASC
           LIMIT 1
         )
         RETURNING *`,
      )
      .get(now + leaseMs, now, now, now) as WorkerJobRow | null;
    return row ? parseWorkerJob(row) : null;
  }

  async function getJob(id: string): Promise<WorkerJob | null> {
    // SAFETY: get() yields undefined when no row matches; undefined maps to null below.
    const row = db.query("SELECT * FROM worker_jobs WHERE id = ?").get(id) as WorkerJobRow | null;
    return row ? parseWorkerJob(row) : null;
  }

  async function requeueJob(id: string, backoffMs: number): Promise<boolean> {
    const now = Date.now();
    // lease_until becomes the backoff not-before gate while queued.
    // SAFETY: run() reports changed rows; 1 only when the job was running.
    const res = db
      .query(
        `UPDATE worker_jobs SET status = 'queued', lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(now + backoffMs, now, id);
    return Number(res.changes) === 1;
  }

  async function renewJobLease(id: string, leaseUntilMs: number): Promise<boolean> {
    // SAFETY: run() reports changed rows; 1 only while the job is still
    // running (a swept/re-claimed job returns 0 → the renewer stops
    // believing it owns the job).
    const res = db
      .query(
        `UPDATE worker_jobs SET lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(leaseUntilMs, Date.now(), id);
    return Number(res.changes) === 1;
  }

  async function completeJob(id: string): Promise<boolean> {
    // SAFETY: run() reports changed rows; 1 only when the job was running
    // (a lease-reclaimed job cannot be completed twice).
    const res = db
      .query(
        `UPDATE worker_jobs SET status = 'completed', lease_until = NULL, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(Date.now(), id);
    return Number(res.changes) === 1;
  }

  async function failJob(id: string): Promise<boolean> {
    // SAFETY: run() reports changed rows; 1 only when the job was queued or
    // running (terminal jobs stay terminal).
    const res = db
      .query(
        `UPDATE worker_jobs SET status = 'failed', lease_until = NULL, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(Date.now(), id);
    return Number(res.changes) === 1;
  }

  async function markUnclaimedJobs(ttlMs: number): Promise<WorkerJob[]> {
    const now = Date.now();
    const cutoff = now - ttlMs;
    // A requeued job holding a backoff gate (lease_until in the future) is
    // waiting on a live worker, not orphaned — never swept. SAFETY: UPDATE
    // ... RETURNING * returns exactly the rows transitioned to failed.
    const rows = db
      .query(
        `UPDATE worker_jobs SET status = 'failed', lease_until = NULL, updated_at = ?
         WHERE id IN (
           SELECT id FROM worker_jobs
           WHERE status = 'queued' AND updated_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
         )
         RETURNING *`,
      )
      .all(now, cutoff, now) as WorkerJobRow[];
    return rows.map(parseWorkerJob);
  }

  async function enqueuePendingTurn(input: {
    spaceId: string;
    ts: string;
    principal: string;
    text: string;
    rootThreadTs?: string;
  }): Promise<{ created: boolean }> {
    if (!input.spaceId || !input.ts || !input.principal) {
      throw new Error("pending turn requires spaceId, ts, and principal");
    }
    const t = Date.now();
    // INSERT OR IGNORE keyed on the unique (space_id, ts) identity: the same
    // inbound Slack message is recorded once, so a re-delivered accepted
    // turn can never be persisted twice (issue #312 dedupe).
    const res = db
      .query(
        `INSERT OR IGNORE INTO pending_turns (space_id, ts, principal, text, root_thread_ts, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(input.spaceId, input.ts, input.principal, input.text, input.rootThreadTs ?? null, t);
    return { created: Number(res.changes) === 1 };
  }

  async function recoverPendingTurns(spaceId: string, leaseMs: number): Promise<PendingTurnClaim[]> {
    const now = Date.now();
    // One atomic transaction claims ALL eligible rows for the space exactly
    // once (issue #312): 'pending' rows always, plus 'claimed' rows whose
    // lease expired (a prior recovery took them but their turn never
    // settled — crash mid-drain). The per-row status re-check under the
    // immediate transaction makes two racing recovery passes deliver each
    // row to only ONE claimant — the loser sees the winner's freshly leased
    // 'claimed' rows and skips them.
    const recover = db.transaction(() => {
      // SAFETY: SELECT id mirrors pending_turns, which always exposes the id column.
      const ids = (
        db
          .query(
            `SELECT id FROM pending_turns
             WHERE space_id = ? AND status != 'done'
               AND (status = 'pending' OR (status = 'claimed' AND lease_until IS NOT NULL AND lease_until < ?))
             ORDER BY id ASC`,
          )
          .all(spaceId, now) as Array<{ id: number }>
      ).map((row) => row.id);
      const claims: PendingTurnClaim[] = [];
      for (const id of ids) {
        // SAFETY: UPDATE ... RETURNING * mirrors pending_turns; a row already
        // transitioned to 'done' (or claimed under a fresh lease) by a racing
        // recovery yields no row and is skipped.
        const row = db
          .query(
            `UPDATE pending_turns
             SET status = 'claimed', claimed_at = ?, lease_until = ?
             WHERE id = ? AND status != 'done'
               AND (status = 'pending' OR (status = 'claimed' AND lease_until IS NOT NULL AND lease_until < ?))
             RETURNING *`,
          )
          .get(now, now + leaseMs, id, now) as PendingTurnRow | null;
        if (row) claims.push(pendingTurnFromRow(row));
      }
      return claims;
    });
    return recover.immediate();
  }

  async function completePendingTurn(spaceId: string, ts: string): Promise<void> {
    const now = Date.now();
    // Marks the durable pending turn done after its drained turn settles.
    // Idempotent: run for the exact (space_id, ts); a row already done is a
    // no-op (never re-delivered), not an error.
    db.query(
      `UPDATE pending_turns
       SET status = 'done', completed_at = ?
       WHERE space_id = ? AND ts = ? AND status IN ('pending', 'claimed')`,
    ).run(now, spaceId, ts);
  }

  async function listPendingTurns(spaceId?: string): Promise<Array<PendingTurnRow & { status: string }>> {
    // SAFETY: both SELECT * branches mirror pending_turns and only add an
    // optional space filter; the no-row case is empty.
    const rows =
      spaceId === undefined
        ? (db.query("SELECT * FROM pending_turns ORDER BY id ASC").all() as Array<PendingTurnRow & { status: string }>)
        : (db
            .query("SELECT * FROM pending_turns WHERE space_id = ? ORDER BY id ASC")
            .all(spaceId) as Array<PendingTurnRow & { status: string }>);
    return rows;
  }

  async function transitionWorkItem(
    id: string,
    from: WorkItemState,
    to: WorkItemState,
    opts?: TransitionOpts,
  ): Promise<WorkItem> {
    // SAFETY: get() yields undefined when the id is absent; the not-found branch throws before any use.
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
    // SAFETY: UPDATE ... WHERE id AND state RETURNING * returns the transitioned row, or undefined when the guard fails.
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
    // Blocked/review landings are human-visible queue events (issue #159):
    // the executor's transition sites funnel here, so this single write
    // posts the one-line notification through the outbox — the same
    // worker→server channel the delivery results ride. The row id is
    // item+state so a repeated transition to the same state can never
    // double-post (INSERT OR IGNORE dedupes).
    if (to === "blocked" || to === "review") {
      const notification: WorkItemNotificationPayload = {
        state: to,
        workItemId: row.id,
        description: row.description,
      };
      if (opts?.evidence !== undefined) notification.evidence = opts.evidence;
      postOutboxRow(store, {
        id: `${row.id}:${to}`,
        kind: "work_item",
        payload: notification,
        space: row.space_id,
      });
    }
    return row;
  }

  async function getWorkItem(id: string): Promise<WorkItem | null> {
    // SAFETY: get() yields undefined when no row matches; undefined maps to null below.
    return (getWorkItemStmt.get(id) as WorkItem | null) ?? null;
  }

  async function upsertExtensionCredential(input: {
    provider: string;
    vaultProvider?: string;
    identityKey: string;
    owner: string | null;
    scope: CredentialScope;
    brokerCredentialId: number;
  }): Promise<ExtensionCredential> {
    const provider = input.provider.trim();
    const vaultProvider = input.vaultProvider?.trim() || provider;
    const identityKey = input.identityKey.trim();
    const owner = input.owner?.trim() ?? "";
    if (!provider || !vaultProvider || !identityKey) {
      throw new Error("extension credential needs a provider, vault provider, and identity key");
    }
    if (input.scope === "personal" && !owner) {
      throw new Error("personal extension credentials need an owner");
    }
    if (input.scope === "org" && input.owner !== null) {
      throw new Error("org extension credentials cannot have an owner");
    }
    const id = `ec_${randomUUID()}`;
    const now = Date.now();
    const conflictTarget = input.scope === "org" ? "(provider) WHERE scope = 'org'" : "(provider, owner) WHERE scope = 'personal'";
    // SAFETY: INSERT ... ON CONFLICT ... RETURNING returns exactly one typed metadata row.
    return db
      .query(
        `INSERT INTO extension_credentials
           (id, provider, vault_provider, identity_key, owner, scope, broker_credential_id,
            pending_vault_provider, pending_broker_credential_id, pending_identity_key,
            retiring_broker_credential_id, status, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'active', 1, ?, ?)
         ON CONFLICT${conflictTarget}
         DO UPDATE SET vault_provider = excluded.vault_provider,
                       identity_key = excluded.identity_key,
                       broker_credential_id = excluded.broker_credential_id,
                       pending_vault_provider = NULL,
                       pending_broker_credential_id = NULL,
                       pending_identity_key = NULL,
                       retiring_broker_credential_id = NULL,
                       status = 'active',
                       revision = extension_credentials.revision + 1,
                       updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(
        id,
        provider,
        vaultProvider,
        identityKey,
        input.scope === "personal" ? owner : null,
        input.scope,
        input.brokerCredentialId,
        now,
        now,
      ) as ExtensionCredential;
  }

  async function listExtensionCredentials(provider: string): Promise<ExtensionCredential[]> {
    // The runtime view excludes every non-active lifecycle state.
    // SAFETY: SELECT * returns ExtensionCredential's column shape.
    return db
      .query(
        "SELECT * FROM extension_credentials WHERE provider = ? AND status = 'active' " +
          "ORDER BY scope, COALESCE(owner, ''), created_at, id",
      )
      .all(provider) as ExtensionCredential[];
  }

  async function listExtensionConnections(): Promise<ExtensionCredential[]> {
    // SAFETY: SELECT * returns ExtensionCredential's column shape.
    return db
      .query("SELECT * FROM extension_credentials ORDER BY provider, scope, COALESCE(owner, ''), created_at, id")
      .all() as ExtensionCredential[];
  }

  async function getExtensionConnection(id: string): Promise<ExtensionCredential | null> {
    // SAFETY: get() returns one ExtensionCredential-shaped row or null.
    return (db.query("SELECT * FROM extension_credentials WHERE id = ?").get(id) as ExtensionCredential | null) ?? null;
  }

  function connectionMutationResult(
    row: ExtensionCredential | null,
    id: string,
    expectedRevision?: number,
  ): ExtensionCredential {
    if (row) return row;
    // SAFETY: SELECT * mirrors the extension_credentials table and therefore
    // returns an ExtensionCredential row when the id exists; absence is checked below.
    const current = db.query("SELECT * FROM extension_credentials WHERE id = ?").get(id) as ExtensionCredential | null;
    if (!current) throw new Error(`connection "${id}" not found`);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new Error(`stale revision for connection "${id}": expected ${expectedRevision}, current ${current.revision}`);
    }
    throw new Error(`connection "${id}" cannot transition from status ${current.status}`);
  }

  async function beginExtensionConnectionReplacement(input: {
    id: string;
    vaultProvider: string;
    expectedRevision: number;
    identityKey: string;
    brokerCredentialId: number;
  }): Promise<ExtensionCredential> {
    const vaultProvider = input.vaultProvider.trim();
    const identityKey = input.identityKey.trim();
    if (!vaultProvider || !identityKey) {
      throw new Error("replacement connection needs a vault provider and identity key");
    }
    // SAFETY: UPDATE ... RETURNING * yields the full ExtensionCredential row
    // when the revision and active-state predicates match, otherwise no row.
    const row = db
      .query(
        `UPDATE extension_credentials
         SET status = 'replacing',
             pending_vault_provider = ?,
             pending_broker_credential_id = ?,
             pending_identity_key = ?,
             updated_at = ?
         WHERE id = ? AND revision = ? AND status = 'active'
         RETURNING *`,
      )
      .get(vaultProvider, input.brokerCredentialId, identityKey, Date.now(), input.id, input.expectedRevision) as ExtensionCredential | null;
    return connectionMutationResult(row, input.id, input.expectedRevision);
  }

  async function commitExtensionConnectionReplacement(id: string, expectedRevision: number): Promise<ExtensionCredential> {
    // SAFETY: UPDATE ... RETURNING * yields the full ExtensionCredential row
    // when the replacement is complete and the lifecycle predicates match, otherwise no row.
    const row = db
      .query(
        `UPDATE extension_credentials
         SET vault_provider = pending_vault_provider,
             identity_key = pending_identity_key,
             retiring_broker_credential_id = broker_credential_id,
             broker_credential_id = pending_broker_credential_id,
             pending_vault_provider = NULL,
             pending_broker_credential_id = NULL,
             pending_identity_key = NULL,
             status = 'replace_cleanup_pending',
             revision = revision + 1,
             updated_at = ?
         WHERE id = ? AND revision = ? AND status = 'replacing'
           AND pending_vault_provider IS NOT NULL
           AND pending_broker_credential_id IS NOT NULL
           AND pending_identity_key IS NOT NULL
         RETURNING *`,
      )
      .get(Date.now(), id, expectedRevision) as ExtensionCredential | null;
    return connectionMutationResult(row, id, expectedRevision);
  }

  async function rollbackExtensionConnectionReplacement(id: string, expectedRevision: number): Promise<ExtensionCredential> {
    // SAFETY: UPDATE ... RETURNING * yields the full ExtensionCredential row
    // when the revision and replacing-state predicates match, otherwise no row.
    const row = db
      .query(
        `UPDATE extension_credentials
         SET status = 'active',
             pending_vault_provider = NULL,
             pending_broker_credential_id = NULL,
             pending_identity_key = NULL,
             updated_at = ?
         WHERE id = ? AND revision = ? AND status = 'replacing'
         RETURNING *`,
      )
      .get(Date.now(), id, expectedRevision) as ExtensionCredential | null;
    return connectionMutationResult(row, id, expectedRevision);
  }

  async function beginExtensionConnectionDisconnect(id: string, expectedRevision: number): Promise<ExtensionCredential> {
    // SAFETY: UPDATE ... RETURNING * yields the full ExtensionCredential row
    // when the revision and active-state predicates match, otherwise no row.
    const row = db
      .query(
        `UPDATE extension_credentials
         SET status = 'disconnecting_boundary', revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND status = 'active'
         RETURNING *`,
      )
      .get(Date.now(), id, expectedRevision) as ExtensionCredential | null;
    return connectionMutationResult(row, id, expectedRevision);
  }

  async function transitionExtensionConnection(input: {
    id: string;
    from: ConnectionStatus;
    to: ConnectionStatus;
    clearRetiringAuthority?: boolean;
  }): Promise<ExtensionCredential> {
    const retirementUpdate = input.clearRetiringAuthority ? ", retiring_broker_credential_id = NULL" : "";
    // SAFETY: UPDATE ... RETURNING * yields the full ExtensionCredential row
    // when the requested source status matches, otherwise no row.
    const row = db
      .query(
        `UPDATE extension_credentials SET status = ?, updated_at = ?${retirementUpdate} ` +
          "WHERE id = ? AND status = ? RETURNING *",
      )
      .get(input.to, Date.now(), input.id, input.from) as ExtensionCredential | null;
    return connectionMutationResult(row, input.id);
  }

  async function upsertRuntimeExtension(input: {
    extensionId: string;
    snapshot: string;
    registeredBy: string;
    spaceId?: string | null;
  }): Promise<RuntimeExtensionRow> {
    const extensionId = input.extensionId.trim();
    const registeredBy = input.registeredBy.trim();
    if (!extensionId || !registeredBy) {
      throw new Error("runtime extension registration needs an extension id and a registering actor");
    }
    if (!input.snapshot.trim()) throw new Error("runtime extension registration needs a snapshot document");
    const t = Date.now();
    // Idempotent upsert by extension id: a re-register (the same catalog
    // connect running again after a restart) refreshes the row, never
    // duplicates it.
    // SAFETY: INSERT ... RETURNING * always yields the inserted or updated
    // extension_registry row, whose columns exactly match RuntimeExtensionRow.
    return db
      .query(
        `INSERT INTO extension_registry (id, snapshot, registered_by, space_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot,
                                       registered_by = excluded.registered_by,
                                       space_id = excluded.space_id,
                                       updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(extensionId, input.snapshot, registeredBy, input.spaceId ?? null, t, t) as RuntimeExtensionRow;
  }

  async function listRuntimeExtensions(): Promise<RuntimeExtensionRow[]> {
    // SAFETY: SELECT * returns one row per extension_registry match, each with RuntimeExtensionRow's column shape.
    return db.query("SELECT * FROM extension_registry ORDER BY created_at").all() as RuntimeExtensionRow[];
  }

  function createUploadToken(input: {
    extension: string;
    scope: CredentialScope;
    actor: string;
    spaceId?: string | null;
    label: string;
    connectionId?: string;
    expectedRevision?: number;
    expiresAt: number;
  }): UploadToken {
    const extension = input.extension.trim();
    const label = input.label.trim();
    if (!extension || !label) throw new Error("upload token needs an extension and a label");
    if (input.scope !== "org" && input.scope !== "personal") throw new Error("upload token scope must be org or personal");
    if (!Number.isSafeInteger(input.expiresAt)) throw new Error("upload token expiresAt must be a safe integer");
    const hasConnection = input.connectionId !== undefined;
    if (hasConnection !== (input.expectedRevision !== undefined)) {
      throw new Error("replacement upload token needs both connectionId and expectedRevision");
    }
    if (input.expectedRevision !== undefined && !Number.isSafeInteger(input.expectedRevision)) {
      throw new Error("replacement upload token expectedRevision must be a safe integer");
    }
    // Sweep expired rows lazily so the table stays bounded by live links.
    db.query("DELETE FROM upload_tokens WHERE expires_at <= ?").run(Date.now());
    const token = randomBytes(18).toString("base64url"); // 144 bits, unguessable
    // SAFETY: INSERT ... RETURNING * always returns the freshly inserted upload token row.
    return db
      .query(
        `INSERT INTO upload_tokens
           (id, token, extension, scope, actor, space_id, label, connection_id, expected_revision, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.connectionId ?? null,
        input.expectedRevision ?? null,
        Date.now(),
        input.expiresAt,
      ) as UploadToken;
  }

  function getUploadToken(token: string): UploadToken | null {
    // SAFETY: get() yields undefined when no row matches; undefined maps to null below.
    return (db.query("SELECT * FROM upload_tokens WHERE token = ?").get(token) as UploadToken | null) ?? null;
  }

  function consumeUploadToken(token: string): { ok: true; row: UploadToken } | { ok: false } {
    const now = Date.now();
    // Atomic single-use: only the first caller gets the row back; everyone
    // else (replay) sees nothing.
    // SAFETY: DELETE ... RETURNING * returns the consumed row, or undefined when the token is absent or expired.
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
    // SAFETY: COUNT(*) AS n always returns exactly one row with a numeric n.
    const row = db
      .query("SELECT COUNT(*) AS n FROM upload_tokens WHERE actor = ? AND expires_at > ?")
      .get(actor, Date.now()) as { n: number };
    return row.n;
  }

  function createOAuthFlow(input: {
    token: string;
    provider: string;
    scope: CredentialScope;
    actor: string;
    spaceId?: string | null;
    label: string;
    serverUrl: string;
    redirectUri: string;
    flow: string;
    expiresAt: number;
  }): OAuthFlow {
    const provider = input.provider.trim();
    const label = input.label.trim();
    if (!provider || !label) throw new Error("oauth flow needs a provider and a label");
    if (input.scope !== "org" && input.scope !== "personal") throw new Error("oauth flow scope must be org or personal");
    if (!Number.isSafeInteger(input.expiresAt)) throw new Error("oauth flow expiresAt must be a safe integer");
    if (!input.token || !input.serverUrl || !input.redirectUri || !input.flow) {
      throw new Error("oauth flow needs token, serverUrl, redirectUri, and the flow JSON");
    }
    // Sweep expired rows lazily so the table stays bounded by live flows.
    db.query("DELETE FROM oauth_flows WHERE expires_at <= ?").run(Date.now());
    // SAFETY: INSERT ... RETURNING * always returns the freshly inserted oauth flow row.
    return db
      .query(
        `INSERT INTO oauth_flows (id, token, provider, scope, actor, space_id, label, server_url, redirect_uri, flow, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        `of_${randomUUID()}`,
        input.token,
        provider,
        input.scope,
        input.actor,
        input.spaceId ?? null,
        label,
        input.serverUrl,
        input.redirectUri,
        input.flow,
        Date.now(),
        input.expiresAt,
      ) as OAuthFlow;
  }

  function getOAuthFlow(token: string): OAuthFlow | null {
    // SAFETY: get() yields undefined when no row matches; undefined maps to null below.
    return (db.query("SELECT * FROM oauth_flows WHERE token = ?").get(token) as OAuthFlow | null) ?? null;
  }

  function consumeOAuthFlow(token: string): { ok: true; row: OAuthFlow } | { ok: false } {
    const now = Date.now();
    // Atomic single-use: only the first caller gets the row back; everyone
    // else (replay) sees nothing.
    // SAFETY: DELETE ... RETURNING * returns the consumed row, or undefined when the token is absent or expired.
    const row = db
      .query(
        `DELETE FROM oauth_flows WHERE id = (SELECT id FROM oauth_flows WHERE token = ?1 AND expires_at > ?2) RETURNING *`,
      )
      .get(token, now) as OAuthFlow | null;
    if (row) return { ok: true, row };
    // Fail closed: an expired row must not linger for a future replay.
    db.query("DELETE FROM oauth_flows WHERE token = ?").run(token);
    return { ok: false };
  }

  function countActiveOAuthFlows(actor: string): number {
    // SAFETY: COUNT(*) AS n always returns exactly one row with a numeric n.
    const row = db
      .query("SELECT COUNT(*) AS n FROM oauth_flows WHERE actor = ? AND expires_at > ?")
      .get(actor, Date.now()) as { n: number };
    return row.n;
  }

  async function createSchedulerJob(input: {
    action: string;
    cron: string;
    params?: Record<string, string>;
    spaceId?: string | null;
    createdBy: string;
    createdAt?: number;
  }): Promise<SchedulerJob> {
    if (!isKnownSchedulerAction(input.action)) {
      throw new Error(`unknown scheduler action: ${input.action}`);
    }
    const params = input.params ?? {};
    const id = `sj_${randomUUID()}`;
    const createdAt = input.createdAt ?? Date.now();
    if (!Number.isSafeInteger(createdAt)) throw new Error("scheduler creation time must be a safe integer");
    const nextFireAt = nextCronFire(input.cron, createdAt);
    // SAFETY: INSERT ... RETURNING * always returns the freshly inserted scheduler_jobs row.
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
    // SAFETY: get() yields undefined when no row matches; the caller maps undefined to null.
    const row = getSchedulerJobStmt.get(id) as SchedulerJobRow | null;
    return row ? schedulerJobFromRow(row) : null;
  }

  async function listSchedulerJobs(): Promise<SchedulerJob[]> {
    // SAFETY: SELECT * returns one row per scheduler_jobs match, each with SchedulerJobRow's column shape.
    const rows = db
      .query("SELECT * FROM scheduler_jobs ORDER BY created_at, id")
      .all() as SchedulerJobRow[];
    return rows.map(schedulerJobFromRow);
  }
  async function updateSchedulerJob(input: {
    id: string;
    expectedRevision: number;
    action?: string;
    cron?: string;
    params?: Record<string, string>;
    now: number;
  }): Promise<SchedulerJob> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("scheduler expected revision must be a positive safe integer");
    }
    if (!Number.isSafeInteger(input.now)) throw new Error("scheduler update time must be a safe integer");
    const current = await getSchedulerJob(input.id);
    if (!current) throw new Error(`scheduler job not found: ${input.id}`);
    if (current.revision !== input.expectedRevision) {
      throw new Error(
        `stale revision for scheduler job ${input.id}: expected ${input.expectedRevision}, current ${current.revision}`,
      );
    }
    const action = input.action ?? current.action;
    if (!isKnownSchedulerAction(action)) throw new Error(`unknown scheduler action: ${action}`);
    const cron = input.cron ?? current.cron;
    const nextFireAt = input.cron === undefined ? current.nextFireAt : nextCronFire(cron, input.now);
    const params = input.params ?? current.params;
    // The revision predicate is the write authority. Another connection that
    // wins after the read makes this UPDATE return no row, never a lost write.
    // SAFETY: UPDATE ... RETURNING * yields the full SchedulerJobRow when the
    // id and revision predicates match, otherwise no row.
    const row = db
      .query(
        `UPDATE scheduler_jobs
         SET action = ?, cron = ?, params = ?, next_fire_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ?
         RETURNING *`,
      )
      .get(action, cron, JSON.stringify(params), nextFireAt, input.id, input.expectedRevision) as
      | SchedulerJobRow
      | null;
    if (!row) {
      const latest = await getSchedulerJob(input.id);
      if (!latest) throw new Error(`scheduler job not found: ${input.id}`);
      throw new Error(
        `stale revision for scheduler job ${input.id}: expected ${input.expectedRevision}, current ${latest.revision}`,
      );
    }
    return schedulerJobFromRow(row);
  }

  async function pauseSchedulerJob(id: string, expectedRevision: number): Promise<SchedulerJob> {
    // SAFETY: UPDATE ... RETURNING * yields the full SchedulerJobRow when the
    // id, revision, and enabled-state predicates match, otherwise no row.
    const row = db
      .query(
        `UPDATE scheduler_jobs
         SET enabled = 0, revision = revision + 1
         WHERE id = ? AND revision = ? AND enabled = 1
         RETURNING *`,
      )
      .get(id, expectedRevision) as SchedulerJobRow | null;
    if (row) return schedulerJobFromRow(row);
    const current = await getSchedulerJob(id);
    if (!current) throw new Error(`scheduler job not found: ${id}`);
    if (current.revision !== expectedRevision) {
      throw new Error(`stale revision for scheduler job ${id}: expected ${expectedRevision}, current ${current.revision}`);
    }
    throw new Error(`scheduler job is already paused: ${id}`);
  }

  async function resumeSchedulerJob(id: string, expectedRevision: number, now: number): Promise<SchedulerJob> {
    if (!Number.isSafeInteger(now)) throw new Error("scheduler resume time must be a safe integer");
    const current = await getSchedulerJob(id);
    if (!current) throw new Error(`scheduler job not found: ${id}`);
    if (current.revision !== expectedRevision) {
      throw new Error(`stale revision for scheduler job ${id}: expected ${expectedRevision}, current ${current.revision}`);
    }
    if (current.enabled) throw new Error(`scheduler job is already enabled: ${id}`);
    const nextFireAt = nextCronFire(current.cron, now);
    // SAFETY: UPDATE ... RETURNING * yields the full SchedulerJobRow when the
    // id, revision, and disabled-state predicates match, otherwise no row.
    const row = db
      .query(
        `UPDATE scheduler_jobs
         SET enabled = 1, next_fire_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND enabled = 0
         RETURNING *`,
      )
      .get(nextFireAt, id, expectedRevision) as SchedulerJobRow | null;
    if (!row) {
      const latest = await getSchedulerJob(id);
      if (!latest) throw new Error(`scheduler job not found: ${id}`);
      throw new Error(`stale revision for scheduler job ${id}: expected ${expectedRevision}, current ${latest.revision}`);
    }
    return schedulerJobFromRow(row);
  }

  async function deleteSchedulerJob(id: string): Promise<boolean> {
    return db.query("DELETE FROM scheduler_jobs WHERE id = ?").run(id).changes > 0;
  }

  async function updateSchedulerNextFire(id: string, nextFireAt: number): Promise<void> {
    if (!Number.isSafeInteger(nextFireAt)) throw new Error("scheduler nextFireAt must be a safe integer");
    const result = db.query("UPDATE scheduler_jobs SET next_fire_at = ? WHERE id = ?").run(nextFireAt, id);
    if (result.changes === 0) throw new Error(`scheduler job not found: ${id}`);
  }

  async function skipSchedulerOccurrence(
    id: string,
    expectedNextFireAt: number,
    nextFireAt: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(expectedNextFireAt) || !Number.isSafeInteger(nextFireAt)) {
      throw new Error("scheduler occurrence times must be safe integers");
    }
    return (
      db
        .query(
          "UPDATE scheduler_jobs SET next_fire_at = ? WHERE id = ? AND enabled = 1 AND next_fire_at = ?",
        )
        .run(nextFireAt, id, expectedNextFireAt).changes === 1
    );
  }

  async function setSchedulerJobEnabled(id: string, enabled: boolean): Promise<void> {
    const result = db
      .query("UPDATE scheduler_jobs SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    if (result.changes === 0) throw new Error(`scheduler job not found: ${id}`);
  }
  async function enqueueSchedulerRunNow(input: {
    jobId: string;
    expectedRevision: number;
    invocationId: string;
    requestedAt: number;
  }): Promise<{ invocation: SchedulerInvocation; created: boolean }> {
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(input.invocationId)) {
      throw new Error("scheduler invocation id must be 1-200 safe identity characters");
    }
    if (!Number.isSafeInteger(input.requestedAt)) throw new Error("scheduler request time must be a safe integer");
    const enqueue = db.transaction(() => {
      // SAFETY: SELECT * mirrors scheduler_invocations, so a matching id yields
      // a SchedulerInvocationRow; the no-row case is handled immediately.
      const existing = db
        .query("SELECT * FROM scheduler_invocations WHERE id = ?")
        .get(input.invocationId) as SchedulerInvocationRow | null;
      if (existing) {
        if (existing.job_id !== input.jobId || existing.source !== "manual") {
          throw new Error(`scheduler invocation identity is already in use: ${input.invocationId}`);
        }
        return { invocation: schedulerInvocationFromRow(existing), created: false };
      }
      // SAFETY: the prepared SELECT * statement mirrors scheduler_jobs, so a
      // matching id yields a SchedulerJobRow; the no-row case is checked below.
      const jobRow = getSchedulerJobStmt.get(input.jobId) as SchedulerJobRow | null;
      if (!jobRow) throw new Error(`scheduler job not found: ${input.jobId}`);
      if (jobRow.revision !== input.expectedRevision) {
        throw new Error(
          `stale revision for scheduler job ${input.jobId}: expected ${input.expectedRevision}, current ${jobRow.revision}`,
        );
      }
      // SAFETY: INSERT ... RETURNING * always yields the newly inserted
      // scheduler_invocations row, whose columns match SchedulerInvocationRow.
      const row = db
        .query(
          `INSERT INTO scheduler_invocations
           (id, job_id, action, params, space_id, source, scheduled_for, requested_at, job_revision)
           VALUES (?, ?, ?, ?, ?, 'manual', NULL, ?, ?)
           RETURNING *`,
        )
        .get(
          input.invocationId,
          jobRow.id,
          jobRow.action,
          jobRow.params,
          jobRow.space_id,
          input.requestedAt,
          jobRow.revision,
        ) as SchedulerInvocationRow;
      return { invocation: schedulerInvocationFromRow(row), created: true };
    });
    return enqueue.immediate();
  }

  async function claimScheduledSchedulerInvocation(
    jobId: string,
    expectedNextFireAt: number,
    requestedAt: number,
  ): Promise<SchedulerInvocation | null> {
    if (!Number.isSafeInteger(expectedNextFireAt) || !Number.isSafeInteger(requestedAt)) {
      throw new Error("scheduler occurrence times must be safe integers");
    }
    const enqueue = db.transaction(() => {
      // SAFETY: SELECT * mirrors scheduler_jobs, so matching identity, enabled,
      // and next-fire predicates yield a SchedulerJobRow; no match returns no row.
      const jobRow = db
        .query("SELECT * FROM scheduler_jobs WHERE id = ? AND enabled = 1 AND next_fire_at = ?")
        .get(jobId, expectedNextFireAt) as SchedulerJobRow | null;
      if (!jobRow) return null;
      const invocationId = `scheduled:${jobId}:${expectedNextFireAt}`;
      const inserted = db
        .query(
          `INSERT OR IGNORE INTO scheduler_invocations
           (id, job_id, action, params, space_id, source, scheduled_for, requested_at, job_revision)
           VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
        )
        .run(
          invocationId,
          jobRow.id,
          jobRow.action,
          jobRow.params,
          jobRow.space_id,
          expectedNextFireAt,
          requestedAt,
          jobRow.revision,
        );
      if (inserted.changes === 0) return null;
      const nextFireAt = nextCronFire(jobRow.cron, requestedAt);
      const advanced = db
        .query(
          "UPDATE scheduler_jobs SET next_fire_at = ? WHERE id = ? AND enabled = 1 AND next_fire_at = ?",
        )
        .run(nextFireAt, jobId, expectedNextFireAt);
      if (advanced.changes !== 1) throw new Error(`scheduler occurrence claim lost for job ${jobId}`);
      // SAFETY: this SELECT * reads the scheduler_invocations row just inserted
      // in the same immediate transaction; the defensive no-row case throws below.
      const row = db.query("SELECT * FROM scheduler_invocations WHERE id = ?").get(invocationId) as
        | SchedulerInvocationRow
        | null;
      if (!row) throw new Error(`scheduler invocation disappeared after enqueue: ${invocationId}`);
      return schedulerInvocationFromRow(row);
    });
    return enqueue.immediate();
  }

  async function claimNextSchedulerInvocation(now: number): Promise<SchedulerInvocation | null> {
    if (!Number.isSafeInteger(now)) throw new Error("scheduler claim time must be a safe integer");
    // SAFETY: UPDATE ... RETURNING * yields a full SchedulerInvocationRow when
    // a pending invocation is claimed, otherwise no row.
    const row = db
      .query(
        `UPDATE scheduler_invocations
         SET status = 'running', claimed_at = ?
         WHERE id = (
           SELECT id FROM scheduler_invocations
           WHERE status = 'pending'
           ORDER BY requested_at, id
           LIMIT 1
         )
         RETURNING *`,
      )
      .get(now) as SchedulerInvocationRow | null;
    return row ? schedulerInvocationFromRow(row) : null;
  }

  async function completeSchedulerInvocation(
    id: string,
    result: "ok" | "error",
    completedAt: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(completedAt)) throw new Error("scheduler completion time must be a safe integer");
    const complete = db.transaction(() => {
      // SAFETY: UPDATE ... RETURNING * yields a full SchedulerInvocationRow
      // when the id is running, otherwise no row.
      const row = db
        .query(
          `UPDATE scheduler_invocations
           SET status = 'completed', completed_at = ?, result = ?
           WHERE id = ? AND status = 'running'
           RETURNING *`,
        )
        .get(completedAt, result, id) as SchedulerInvocationRow | null;
      if (!row) throw new Error(`scheduler invocation not found or not running: ${id}`);
      // A deletion can race an already claimed execution. History remains
      // complete even when the recurring parent no longer exists.
      db.query(
        "UPDATE scheduler_jobs SET last_fired_at = ?, last_result = ? WHERE id = ?",
      ).run(completedAt, result, row.job_id);
    });
    complete.immediate();
  }

  async function listSchedulerInvocations(
    filter: { jobId?: string } = {},
  ): Promise<SchedulerInvocation[]> {
    // SAFETY: both SELECT * branches mirror scheduler_invocations and therefore
    // return SchedulerInvocationRow arrays, with the optional branch only adding a job filter.
    const rows =
      filter.jobId === undefined
        ? (db
            .query("SELECT * FROM scheduler_invocations ORDER BY requested_at, id")
            .all() as SchedulerInvocationRow[])
        : (db
            .query("SELECT * FROM scheduler_invocations WHERE job_id = ? ORDER BY requested_at, id")
            .all(filter.jobId) as SchedulerInvocationRow[]);
    return rows.map(schedulerInvocationFromRow);
  }

  async function markStaleWorkItems(olderThanMs: number, from: WorkItemState): Promise<number> {
    const t = Date.now();
    const cutoff = t - olderThanMs;
    // SAFETY: SELECT id, space_id, description returns rows with exactly those columns.
    const stale = db
      .query("SELECT id, space_id, description FROM work_items WHERE state = ? AND updated_at < ?")
      .all(from, cutoff) as { id: string; space_id: string; description: string }[];
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
      // Stale recovery is a blocked landing too (issue #159): the boot-time
      // sweep posts the same one-line notification as any other blocked
      // transition, so a restarted item is never silently stuck.
      postOutboxRow(store, {
        id: `${row.id}:blocked`,
        kind: "work_item",
        payload: { state: "blocked", workItemId: row.id, description: row.description, evidence: "interrupted by restart" },
        space: row.space_id,
      });
    }
    return stale.length;
  }

  function getOrgSettings(): OrgSettings | null {
    // SAFETY: get() yields undefined when absent (handled below) or the single org_settings row, whose settings column is a string.
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

  async function getIngestWatermark(provider: string): Promise<string | null> {
    // SAFETY: get() yields undefined when no row matches; undefined maps to null below.
    const row = db.query("SELECT cursor FROM ingest_watermark WHERE provider = ?").get(provider) as
      | { cursor: string }
      | null
      | undefined;
    return row ? row.cursor : null;
  }

  async function setIngestWatermark(provider: string, cursor: string): Promise<void> {
    db.query(
      `INSERT INTO ingest_watermark (provider, cursor, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).run(provider, cursor, Date.now());
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
    // SAFETY: SELECT * returns one row per audit match, each with AuditRow's column shape.
    return db.query(sql).all(...params) as AuditRow[];
  }

  async function queryAudit(opts: AuditQueryOpts = {}): Promise<AuditPage> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.event_type !== undefined) {
      clauses.push("event_type = ?");
      params.push(opts.event_type);
    }
    if (opts.space_id !== undefined) {
      clauses.push("space_id = ?");
      params.push(opts.space_id);
    }
    if (opts.actor !== undefined) {
      clauses.push("actor = ?");
      params.push(opts.actor);
    }
    if (opts.since !== undefined) {
      clauses.push("ts >= ?");
      params.push(opts.since);
    }
    if (opts.until !== undefined) {
      clauses.push("ts <= ?");
      params.push(opts.until);
    }
    if (opts.tool !== undefined) {
      clauses.push("json_valid(payload) AND json_extract(payload, '$.tool') = ?");
      params.push(opts.tool);
    }
    if (opts.extension !== undefined) {
      clauses.push(
        "json_valid(payload) AND COALESCE(json_extract(payload, '$.extension'), json_extract(payload, '$.provider')) = ?",
      );
      params.push(opts.extension);
    }
    if (opts.cursor !== undefined) {
      if (
        !Number.isSafeInteger(opts.cursor.ts) ||
        !Number.isSafeInteger(opts.cursor.id) ||
        opts.cursor.ts < 0 ||
        opts.cursor.id < 1
      ) {
        throw new Error("invalid audit cursor");
      }
      clauses.push("(ts < ? OR (ts = ? AND id < ?))");
      params.push(opts.cursor.ts, opts.cursor.ts, opts.cursor.id);
    }
    const requestedLimit = opts.limit ?? 50;
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.trunc(requestedLimit))) : 50;
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const sql =
      "SELECT id, ts, space_id, actor, event_type, payload FROM audit" +
      where +
      " ORDER BY ts DESC, id DESC LIMIT ?";
    params.push(limit + 1);
    // SAFETY: the SELECT projects exactly AuditRow's six columns.
    const matches = db.query(sql).all(...params) as AuditRow[];
    const hasMore = matches.length > limit;
    const rows = hasMore ? matches.slice(0, limit) : matches;
    const last = rows.at(-1);
    return {
      rows,
      nextCursor: hasMore && last !== undefined ? { ts: last.ts, id: last.id } : null,
    };
  }

  /**
   * The visible queue (issue #159): work items of a space (or every space
   * when no space filter), newest first, optionally narrowed by state.
   */
  async function listWorkItems(filter: { space_id?: string; state?: WorkItemState } = {}): Promise<WorkItem[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.space_id !== undefined) {
      clauses.push("space_id = ?");
      params.push(filter.space_id);
    }
    if (filter.state !== undefined) {
      clauses.push("state = ?");
      params.push(filter.state);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    // SAFETY: SELECT * returns one row per work_items match, each with WorkItem's column shape.
    return db.query(`SELECT * FROM work_items ${where} ORDER BY created_at DESC`).all(...params) as WorkItem[];
  }

  const store: Store = {
    getOrCreateSpace,
    getSpace,
    listSpaces,
    updatePolicy,
    getSpaceSettings,
    getEffectiveSpaceSettings,
    updateSpaceSettings,
    createObject,
    listObjects,
    getObject,
    readObjectBytes,
    createWorkItem,
    claimWorkItemById,
    transitionWorkItem,
    getWorkItem,
    listWorkItems,
    markStaleWorkItems,
    enqueueJob,
    claimNextJob,
    getJob,
    requeueJob,
    renewJobLease,
    completeJob,
    failJob,
    markUnclaimedJobs,
    enqueuePendingTurn,
    recoverPendingTurns,
    completePendingTurn,
    listPendingTurns,
    upsertExtensionCredential,
    listExtensionCredentials,
    listExtensionConnections,
    getExtensionConnection,
    beginExtensionConnectionReplacement,
    commitExtensionConnectionReplacement,
    rollbackExtensionConnectionReplacement,
    beginExtensionConnectionDisconnect,
    transitionExtensionConnection,
    upsertRuntimeExtension,
    listRuntimeExtensions,
    createUploadToken,
    getUploadToken,
    consumeUploadToken,
    countActiveUploadTokens,
    createOAuthFlow,
    getOAuthFlow,
    consumeOAuthFlow,
    countActiveOAuthFlows,
    getOrgSettings,
    setOrgSettings,
    createSchedulerJob,
    getSchedulerJob,
    listSchedulerJobs,
    updateSchedulerJob,
    pauseSchedulerJob,
    resumeSchedulerJob,
    deleteSchedulerJob,
    skipSchedulerOccurrence,
    updateSchedulerNextFire,
    setSchedulerJobEnabled,
    enqueueSchedulerRunNow,
    claimScheduledSchedulerInvocation,
    claimNextSchedulerInvocation,
    completeSchedulerInvocation,
    listSchedulerInvocations,
    queryAudit,
    appendAudit,
    listAudit,
    getIngestWatermark,
    setIngestWatermark,
    getDb: () => db,
    close: () => db.close(),
  };
  return store;
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
