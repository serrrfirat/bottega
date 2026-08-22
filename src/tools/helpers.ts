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
