/**
 * Pluggable memory contract (memory epic, issue #19; permission-aware
 * scopes, issue #137).
 *
 * The single seam for all memory backends. Memory is never deleted —
 * providers expose save + search only.
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
 *   person:P    → scope='user', principal=P        (raw principal: existing
 *                                 `user` rows ARE person rows, so legacy
 *                                 data reads back unchanged)
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
}

export interface MemorySaveInput {
  scope: MemoryScopeKey;
  /** Non-empty. */
  content: string;
  metadata?: Record<string, string>;
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

export interface MemoryProvider {
  save(input: MemorySaveInput): Promise<MemoryEntry>;
  search(query: MemorySearchQuery): Promise<MemoryEntry[]>;
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