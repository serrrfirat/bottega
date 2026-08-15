import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";

/**
 * Error result for a tool extension (issue #33): text content flagged as an
 * error. Shared by the memory and work-item tool extensions so failure
 * results carry the same shape everywhere.
 */
export function toolError(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
