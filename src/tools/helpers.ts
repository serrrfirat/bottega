import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";

/**
 * Error result for a tool extension (issue #33): text content flagged as an
 * error. Shared by the memory and work-item tool extensions so failure
 * results carry the same shape everywhere.
 */
export function toolError(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Message from an unknown throwable (never "undefined" for non-Error throws). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
