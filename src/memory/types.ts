/**
 * Pluggable memory contract (memory epic, issues #19, #137, #155, and #321).
 *
 * The single seam for every backend owns validated save/search behavior,
 * exact metadata filtering, capability reporting, the one narrow
 * maintenance operation used by digest producers, and the forget-with-
 * tombstone delete path (issue #163).
 *
 * Provenance (#163) is a first-class, structured field on every saved
 * entry (see {@link MemoryProvenance}): source, spaceId, principal, and
 * the logical scope label. Producer metadata remains explicit in addition
 * to the normalized provenance shape:
 *   manual/tool save → source=tool (or caller-supplied), caller metadata
 *   auto extraction → source=auto_extract
 *   idle + standup digest → kind=digest, space, since, until
 *   reflection → kind=reflection, space, date, topic
 *   KB ingestion → kind=kb, source=<source id>, url
 *   SQLite consolidation → source=consolidation, consolidated=1
 * The weekly observer is read-only; it searches digest/reflection rows and
 * never produces memory.
 *
 * Consolidation has two equivalent lifecycle positions. SQLite reports
 * `explicit` because Bottega schedules its compactor. mem0 reports `on-save`
 * because the service consolidates each add and retains provider history.
 * Digest retention is different from correction/deletion: it may remove only
 * derived `kind=digest` rows beyond the per-space cap, whose source transcript
 * remains durable. A backend that cannot enforce that cap reports
 * `unsupported`, and `pruneDigests` rejects loudly instead of succeeding as a
 * no-op. Forget-with-tombstone (#163) is the only general delete path: a
 * forgotten entry is never recalled, never re-injected, and never silently
 * hard-deleted — the row becomes a durable tombstone.
 *
 * Logical scope model (#137): a memory belongs to one of four logical keys —
 * `org` (the company-wide floor), `person:<principal>` (one human), a
 * `channel:<spaceId>` (one Slack channel space), or a `team:<teamId>`
 * (channels sharing the same explicit `memory.team` policy value). Callers
 * never hand a provider an arbitrary composite key: `SpaceService` derives
 * the readable/writable set from the authenticated invocation context and
 * the effective space policy.
 *
 * Physical persistence stays on the existing `org|user` SQLite contract (#19)
 * — no schema migration. Logical keys map to physical rows:
 *   org         → scope='org',  principal=NULL
 *   person:P    → scope='user', principal=P
 *   channel:S   → scope='user', principal='channel:S'
 *   team:T      → scope='user', principal='team:T'
 * The `channel:`/`team:` prefixes cannot collide with Slack principals
 * (U/W-prefixed) or space ids (`slack:`), so decode is unambiguous.
 */

export type MemoryScopeKey =
  | { kind: "org" }
  | { kind: "person"; principal: string }
  | { kind: "channel"; spaceId: string }
  | { kind: "team"; teamId: string };

/** The physical scope column persisted for a logical key. */
export type MemoryPhysicalScope = "org" | "user";

/** Physical (scope, principal) row a logical key encodes to. */
export interface MemoryPhysicalRow {
  scope: MemoryPhysicalScope;
  principal: string | null;
}

/** Composite-key prefix for channel rows; see module docstring. */
export const CHANNEL_KEY_PREFIX = "channel:";
/** Composite-key prefix for team rows; see module docstring. */
export const TEAM_KEY_PREFIX = "team:";

/** Conservative stable identifier shape for `memory.team` (fail closed). */
const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** True when `teamId` is a valid, unambiguous stable team identifier. */
export function isValidTeamId(teamId: string): boolean {
  return TEAM_ID_RE.test(teamId);
}

/**
 * Encodes a logical scope key into its physical row. Person keys map to the
 * raw principal so existing `user` rows remain readable as person memory.
 */
export function encodeScopeKey(key: MemoryScopeKey): MemoryPhysicalRow {
  switch (key.kind) {
    case "org":
      return { scope: "org", principal: null };
    case "person":
      return { scope: "user", principal: key.principal };
    case "channel":
      return { scope: "user", principal: `${CHANNEL_KEY_PREFIX}${key.spaceId}` };
    case "team":
      return { scope: "user", principal: `${TEAM_KEY_PREFIX}${key.teamId}` };
  }
}

/**
 * The human-readable logical key label (`org`, `person:U1`, `channel:slack:C1`,
 * `team:eng`) — used in audit and error messages, never persisted as a raw
 * composite the caller can widen with.
 */
export function scopeKeyLabel(key: MemoryScopeKey): string {
  switch (key.kind) {
    case "org":
      return "org";
    case "person":
      return `person:${key.principal}`;
    case "channel":
      return `channel:${key.spaceId}`;
    case "team":
      return `team:${key.teamId}`;
  }
}

/**
 * Decodes a physical row back into its logical key. A non-`:`-prefixed
 * principal (any legacy or person-written row) maps to `person:<principal>`;
 * `channel:`/`team:`-prefixed principals map to their own kind. The decode
 * is total: every persisted row is a valid logical key by construction.
 */
export function decodeScopeKey(scope: MemoryPhysicalScope, principal: string | null): MemoryScopeKey {
  if (scope === "org") return { kind: "org" };
  const value = principal ?? "";
  if (value.startsWith(CHANNEL_KEY_PREFIX)) {
    return { kind: "channel", spaceId: value.slice(CHANNEL_KEY_PREFIX.length) };
  }
  if (value.startsWith(TEAM_KEY_PREFIX)) {
    return { kind: "team", teamId: value.slice(TEAM_KEY_PREFIX.length) };
  }
  return { kind: "person", principal: value };
}

export interface MemoryEntry {
  id: string;
  /** The logical scope key the entry belongs to (decoded from the physical row). */
  key: MemoryScopeKey;
  content: string;
  metadata: Record<string, string>;
  createdAt: number;
  /** Structured provenance (#163): where and by whom the entry was produced. */
  provenance: MemoryProvenance;
}

/**
 * Structured provenance carried on every saved entry (#163). It is derived
 * from the invocation scope at save time and persisted (SQLite) or mapped
 * from the backend's own identity fields (mem0). A backend without
 * first-class provenance still fills default values (source `tool`,
 * spaceId/principal null for org rows).
 */
export interface MemoryProvenance {
  /**
   * Producer label: `tool`, `auto_extract`, `digest`, `reflection`, `kb`,
   * `consolidation`, or a caller-supplied value. The distinction between
   * human/manual and generated memory.
   */
  source: string;
  /** The space the entry was produced from (null for org/system turns). */
  spaceId: string | null;
  /** The principal that produced the entry (null for system/org turns). */
  principal: string | null;
  /** Human-readable logical scope label (`org`, `person:U1`, `channel:slack:C1`). */
  scopeLabel: string;
}

export interface MemorySaveInput {
  scope: MemoryScopeKey;
  /** Non-empty. */
  content: string;
  metadata?: Record<string, string>;
  /**
   * Optional provenance source label. Absent → `tool`. spaceId/principal are
   * not part of the save input (they are derived from the authenticated
   * context), except where a caller knows them and passes them via
   * `source`. See {@link MemoryProvenance}.
   */
  source?: string;
}

export interface MemoryForgetInput {
  /** The logical scope key the entry belongs to (must match the entry's row). */
  scope: MemoryScopeKey;
  /** The entry id to forget. */
  id: string;
}

/** The durable record left behind when an entry is forgotten (#163). */
export interface MemoryTombstone {
  /** The forgotten entry's id. */
  id: string;
  /** The logical scope key the forgotten entry belonged to. */
  key: MemoryScopeKey;
  /** When the forget happened (ms epoch). */
  forgottenAt: number;
}

export interface MemorySearchQuery {
  /** Non-empty unless `metadata` filters are given (metadata-only listing). */
  query: string;
  /** Exactly one derived logical scope key — callers never widen it. */
  scope: MemoryScopeKey;
  /** Default 5, capped at 20. */
  limit?: number;
  /** Exact-match filters; all must match. */
  metadata?: Record<string, string>;
}

export interface MemoryProviderCapabilities {
  /**
   * `explicit`: Bottega must run its scheduled compactor.
   * `on-save`: the backend consolidates as part of save; no scheduled pass.
   * `unsupported`: a caller requiring consolidation must reject.
   */
  readonly consolidation: "explicit" | "on-save" | "unsupported";
  /**
   * `explicit`: pruneDigests enforces the per-space cap.
   * `unsupported`: pruneDigests must reject without deleting content.
   */
  readonly digestPruning: "explicit" | "unsupported";
  /**
   * `explicit`: forget() leaves a durable tombstone and the entry is never
   * recalled. `unsupported`: forget() rejects loudly; the backend has no
   * delete path and must never silently hard-delete.
   */
  readonly forget: "explicit" | "unsupported";
}

export interface MemoryProvider {
  readonly capabilities: MemoryProviderCapabilities;
  save(input: MemorySaveInput): Promise<MemoryEntry>;
  search(query: MemorySearchQuery): Promise<MemoryEntry[]>;
  /**
   * Enforces derived-digest retention for one space. Unsupported providers
   * reject loudly; returning zero is reserved for a supported no-deletion pass.
   */
  pruneDigests(spaceId: string, keep: number): Promise<number>;
  /**
   * Forget-with-tombstone (#163): removes the entry from recall and leaves a
   * durable tombstone so it is never re-injected or silently hard-deleted.
   * Unsupported providers reject loudly. Returns the tombstone that was left.
   */
  forget(input: MemoryForgetInput): Promise<MemoryTombstone>;
  /**
   * Counts the durable tombstones left in one logical scope (issue #163).
   * Optional: a backend without tombstones (mem0) is undefined; callers
   * (the weekly memory review) treat an absent method as "forgotten count
   * unavailable" and degrade to zero/unknown rather than fail.
   */
  countForgotten?(scope: MemoryScopeKey): Promise<number>;
  /**
   * Counts ALL recallable (non-tombstoned) entries in one logical scope
   * (issue #163). Optional: backends without a cheap count (mem0) leave it
   * undefined; the weekly memory review treats an absent method as "count
   * via search" and falls back to a bounded recall for the estimate.
   */
  countRecallable?(scope: MemoryScopeKey): Promise<number>;
}

/** Fails before a digest producer starts when the configured backend cannot enforce its cap. */
export function requireDigestPruning(provider: MemoryProvider): void {
  if (provider.capabilities.digestPruning !== "explicit") {
    throw new Error(
      "configured memory provider does not support required digest pruning; " +
        "digest production cannot enforce the per-space retention cap",
    );
  }
}

export const MEMORY_LIMIT_DEFAULT = 5;
export const MEMORY_LIMIT_MAX = 20;

export function validateSaveInput(input: MemorySaveInput): void {
  if (!input.content || !input.content.trim()) {
    throw new Error("memory.save: content must be non-empty");
  }
  if (input.scope.kind === "person" && !input.scope.principal) {
    throw new Error("memory.save: person scope requires a principal");
  }
  if (input.scope.kind === "team" && !isValidTeamId(input.scope.teamId)) {
    throw new Error(`memory.save: invalid team id '${input.scope.teamId}'`);
  }
  if (input.scope.kind === "channel" && !input.scope.spaceId) {
    throw new Error("memory.save: channel scope requires a space id");
  }
}

export function validateSearchQuery(query: MemorySearchQuery): void {
  // An empty query is a metadata-only listing (e.g. the newest digest for a
  // space, issue #42); without metadata filters it is a plain validation miss.
  const hasMetadataFilters = query.metadata !== undefined && Object.keys(query.metadata).length > 0;
  if ((!query.query || !query.query.trim()) && !hasMetadataFilters) {
    throw new Error("memory.search: query must be non-empty (or provide metadata filters)");
  }
  if (query.limit !== undefined && (query.limit < 1 || query.limit > MEMORY_LIMIT_MAX)) {
    throw new Error(`memory.search: limit must be 1..${MEMORY_LIMIT_MAX}`);
  }
  if (query.scope.kind === "team" && !isValidTeamId(query.scope.teamId)) {
    throw new Error(`memory.search: invalid team id '${query.scope.teamId}'`);
  }
}

export function validateForgetInput(input: MemoryForgetInput): void {
  if (!input.id || !input.id.trim()) {
    throw new Error("memory.forget: id must be non-empty");
  }
  if (input.scope.kind === "team" && !isValidTeamId(input.scope.teamId)) {
    throw new Error(`memory.forget: invalid team id '${input.scope.teamId}'`);
  }
}

/**
 * Derives the provenance of a saved entry (#163). The source label comes
 * from the save input (default `tool`); the scope label is always derived
 * from the logical key; spaceId/principal are supplied by the caller's
 * authenticated context when known (null for org/system turns).
 */
export function deriveProvenance(
  scope: MemoryScopeKey,
  source: string | undefined,
  spaceId: string | null,
  principal: string | null,
): MemoryProvenance {
  return {
    source: (source ?? "tool").trim() || "tool",
    spaceId,
    principal,
    scopeLabel: scopeKeyLabel(scope),
  };
}