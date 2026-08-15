/**
 * Pluggable memory contract (memory epic, issue #19).
 *
 * The single seam for all memory backends. Org memory is shared across
 * spaces; user memory is scoped to a principal. Memory is never deleted —
 * providers expose save + search only.
 */

export type MemoryScope = "org" | "user";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  /** Non-null when scope = "user". */
  principal: string | null;
  content: string;
  metadata: Record<string, string>;
  createdAt: number;
}

export interface MemorySaveInput {
  scope: MemoryScope;
  /** Required when scope = "user". */
  principal?: string;
  /** Non-empty. */
  content: string;
  metadata?: Record<string, string>;
}

export interface MemorySearchQuery {
  /** Non-empty. */
  query: string;
  scope: MemoryScope;
  /** Filters when provided; ignored for org scope. */
  principal?: string;
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
  if (input.scope !== "org" && input.scope !== "user") {
    throw new Error(`memory.save: invalid scope ${String(input.scope)}`);
  }
  if (input.scope === "user" && !input.principal) {
    throw new Error("memory.save: principal is required for user scope");
  }
  if (!input.content || !input.content.trim()) {
    throw new Error("memory.save: content must be non-empty");
  }
}

export function validateSearchQuery(query: MemorySearchQuery): void {
  if (query.scope !== "org" && query.scope !== "user") {
    throw new Error(`memory.search: invalid scope ${String(query.scope)}`);
  }
  if (!query.query || !query.query.trim()) {
    throw new Error("memory.search: query must be non-empty");
  }
  if (query.limit !== undefined && (query.limit < 1 || query.limit > MEMORY_LIMIT_MAX)) {
    throw new Error(`memory.search: limit must be 1..${MEMORY_LIMIT_MAX}`);
  }
}
