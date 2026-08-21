/**
 * Permission-aware memory scope resolution (issue #137).
 *
 * `SpaceService` derives the readable/writable logical scope keys from the
 * authenticated invocation context — never from prompt/tool arguments. The
 * model cannot widen access by naming another person, channel, or team.
 *
 *   DM recall     → person:<principal> + org
 *   channel recall → channel:<spaceId> + team:<teamId>? + org
 *
 * `memory.team` is the optional effective-space-policy field; a malformed
 * value fails closed (no team scope is granted). `extensions.org_credentials`
 * is unrelated and never affects memory visibility.
 *
 * Multi-scope search fans across only the derived readable keys (fixed
 * org→person/channel/team precedence for deterministic ordering), dedupes by
 * entry id, then applies ONE global limit after merging. Every successful
 * recall appends a `memory.recalled` audit row with the requester/space and
 * per-scope counts — never query or memory content.
 */
import type { AuditModule } from "../policy/audit";
import { MEMORY_RECALLED_EVENT } from "../store/audit-events";
import {
  MEMORY_LIMIT_MAX,
  type MemoryEntry,
  type MemoryProvider,
  type MemorySaveInput,
  type MemoryScopeKey,
} from "./types";

/** The authenticated invocation context a memory recall runs in. */
export interface MemoryScopeContext {
  spaceId: string;
  /** The inbound principal whose message started the turn; undefined for system turns (fail closed to agent). */
  principal: string | undefined;
  /** True when the space is a direct-message channel; false = a shared channel. */
  directMessage: boolean;
  /** The space's effective `memory.team` policy value; malformed values must resolve to undefined (fail closed). */
  teamId: string | undefined;
}

/** The readable scope keys a recall may query, in deterministic precedence order. */
export interface ReadableScopes {
  /** `org` always first (the company floor). */
  keys: MemoryScopeKey[];
}

/**
 * Derives the writable scope keys for an auto-extraction/save from the
 * invocation context. DMs write the person's key; channels write the current
 * channel key. Facts are never auto-promoted into team/org.
 */
export function deriveWritableScopes(ctx: MemoryScopeContext): MemoryScopeKey[] {
  if (ctx.directMessage) {
    // A DM writes only its authenticated person's key. A DM with no
    // principal (a turn nobody started, or a caller failed to bind one)
    // derives NO writable scope — fail closed: nothing can be written and
    // the caller must refuse rather than fall back to a channel key.
    return ctx.principal ? [{ kind: "person", principal: ctx.principal }] : [];
  }
  return [{ kind: "channel", spaceId: ctx.spaceId }];
}

/** Derives the exactly readable scope keys for a recall, fixed precedence. */
export function deriveReadableScopes(ctx: MemoryScopeContext): ReadableScopes {
  const keys: MemoryScopeKey[] = [{ kind: "org" }];
  if (ctx.directMessage) {
    if (ctx.principal) keys.push({ kind: "person", principal: ctx.principal });
    // A DM never inherits channel/team memory (a DM is its own private
    // channel; it only sees the person + org floor).
  } else {
    keys.push({ kind: "channel", spaceId: ctx.spaceId });
    if (ctx.teamId) keys.push({ kind: "team", teamId: ctx.teamId });
  }
  return { keys };
}

export interface RecallOptions {
  /** Global post-merge result limit (default 5, capped at 20). */
  limit?: number;
  /** When provided, every successful recall appends `memory.recalled` with per-scope counts (never content). */
  audit?: Pick<AuditModule, "appendAudit">;
}

export interface RecalledScope {
  /** `org`, `person:<p>`, `channel:<s>`, or `team:<t>`. */
  scope: string;
  /** The encoded composite key, exactly as persisted. */
  key: string;
  count: number;
}

function encodeAuditKey(key: MemoryScopeKey): string {
  switch (key.kind) {
    case "org":
      return "org";
    case "person":
      return key.principal;
    case "channel":
      return `channel:${key.spaceId}`;
    case "team":
      return `team:${key.teamId}`;
  }
}

/**
 * Bounded multi-scope recall: queries each derived readable key, merges in
 * deterministic order, dedupes by entry id, applies ONE global limit, and
 * appends a compact `memory.recalled` audit row (never the query, never memory
 * content). Backend failures propagate (no silent failures). Returns the
 * merged entries.
 */
export async function recallMemories(
  provider: MemoryProvider,
  ctx: MemoryScopeContext,
  query: string,
  options: RecallOptions = {},
): Promise<MemoryEntry[]> {
  // Up-front validation (fail-closed, before any scope fan-out): an empty
  // query with no metadata filters and an out-of-range limit are contextual
  // errors — a provider fake that skips validation must not silently pass.
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("memory.search: query must be non-empty");
  }
  const requestedLimit = options.limit ?? 5;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MEMORY_LIMIT_MAX) {
    throw new Error(`memory.search: limit must be 1..${MEMORY_LIMIT_MAX}`);
  }
  const { keys } = deriveReadableScopes(ctx);
  const globalLimit = requestedLimit;

  const scopedResults = await Promise.all(
    keys.map(async (scope): Promise<{ scope: MemoryScopeKey; entries: MemoryEntry[] }> => ({
      scope,
      entries: await provider.search({ query, scope, limit: globalLimit }),
    })),
  );

  // Deterministic merge: keep first-seen by entry id across the fixed
  // precedence order (org → person/channel → team), then one global limit.
  const seen = new Set<string>();
  const merged: MemoryEntry[] = [];
  for (const { entries } of scopedResults) {
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      merged.push(entry);
      if (merged.length >= globalLimit) break;
    }
    if (merged.length >= globalLimit) break;
  }

  if (options.audit) {
    const scopes = scopedResults.map(({ scope, entries }) => ({
      scope: scope.kind,
      key: encodeAuditKey(scope),
      count: entries.length,
    }));
    await options.audit.appendAudit({
      space_id: ctx.spaceId,
      actor: ctx.principal ?? "agent",
      event_type: MEMORY_RECALLED_EVENT,
      payload: { scopes },
    });
  }

  return merged;
}

/** Writable scope validation for a save request whose scope KIND a caller/tool requests. */
export function saveToWritableScope(
  key: MemoryScopeKey,
  ctx: MemoryScopeContext,
): { ok: boolean; reason?: string } {
  // Org is always writable (the existing memory.save policy/approval tier gates it).
  if (key.kind === "org" || key.kind === "team") {
    return key.kind === "org" ? { ok: true } : { ok: false, reason: `scope 'team' is not writable in this conversation` };
  }
  const writable = deriveWritableScopes(ctx);
  const matches = writable.some((candidate) => {
    if (candidate.kind === "person" && key.kind === "person") {
      return candidate.principal === key.principal;
    }
    if (candidate.kind === "channel" && key.kind === "channel") {
      return candidate.spaceId === key.spaceId;
    }
    return false;
  });
  return matches ? { ok: true } : { ok: false, reason: `scope '${key.kind}' is not writable in this conversation` };
}

/** Builds a MemorySaveInput for a writable scope; rejects (throws) a non-writable key. */
export function scopedSave(
  scope: MemoryScopeKey,
  content: string,
  ctx: MemoryScopeContext,
  metadata?: Record<string, string>,
): MemorySaveInput {
  const verdict = saveToWritableScope(scope, ctx);
  if (!verdict.ok) throw new Error(verdict.reason);
  return { scope, content, metadata };
}