import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";

/**
 * The queue row both list_work_items (work-items.ts) and list_todos
 * (list-todos.ts) render for each work item: id, description, state,
 * assignee, and created. One source of truth for the human-facing queue
 * shape so the two surfaces never drift.
 */
export interface WorkItemQueueRow {
  id: string;
  description: string;
  state: string;
  assignee: string | null;
  created: number;
}

/**
 * Maps a work item's store row (array from store.listWorkItems) to the
 * shared queue rendering. The input carries the store's `created_at`
 * column; the output exposes it as `created` on every surface.
 */
export function renderWorkItemQueue(
  item: { id: string; description: string; state: string; assignee: string | null; created_at: number },
): WorkItemQueueRow {
  return {
    id: item.id,
    description: item.description,
    state: item.state,
    assignee: item.assignee,
    created: item.created_at,
  };
}

/**
 * Error result for a tool extension (issue #33): text content flagged as an
 * error. Shared by the memory and work-item tool extensions so failure
 * results carry the same shape everywhere.
 */
export function toolError(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Message from an unknown throwable (never "undefined" for non-Error throws). */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** SHA-256 hex digest: the audit stores the hash of saved content, never the content. */
export function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

/**
 * Rejects with a timeout error after `ms`; the underlying promise keeps
 * running (it cannot be cancelled). `message` names the timed-out operation
 * so each caller keeps its own error text.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
