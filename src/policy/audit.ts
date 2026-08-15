import type { AuditRow, Store } from "../store/db";

/** Payload cap before write (issue #7): oversized payloads are truncated, never dropped. */
export const MAX_PAYLOAD_BYTES = 4 * 1024;
export const TRUNCATION_MARKER = "\n...[truncated]";

/**
 * Best-effort redaction pass over secret-shaped values. Deterministic:
 * every match is replaced with a fixed `[REDACTED]` literal. v1 uses regex
 * shapes for common tokens; OMP SecretObfuscator integration is deferred
 * to issue #9 (secrets obfuscation must then be enabled at boot).
 */
export function redact(text: string): string {
  let out = text;
  // Slack tokens: xoxb / xoxa / xoxp / xoxr / xoxs.
  out = out.replace(/xox[baprs]-[0-9a-zA-Z-]+/g, "[REDACTED]");
  // OpenAI/Anthropic-style API keys (sk-... and sk-ant-...).
  out = out.replace(/sk-[A-Za-z0-9-]+/g, "sk-[REDACTED]");
  // AWS access key ids.
  out = out.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]");
  // GitHub fine-grained PATs.
  out = out.replace(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED]");
  // Bearer tokens (keep the "Bearer" label, mask the credential).
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}/g, "$1[REDACTED]");
  // Generic key: value pairs (JSON or text) for secret-shaped keys.
  out = out.replace(
    /("?(?:api[_-]?key|api[_-]?secret|auth[_-]?token|access[_-]?token|password)"?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/g,
    "$1[REDACTED]",
  );
  return out;
}

/** Cuts `text` to the payload cap, appending the truncation marker. */
function enforcePayloadCap(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_PAYLOAD_BYTES) return text;
  const budget = MAX_PAYLOAD_BYTES - Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  let cut = text;
  while (Buffer.byteLength(cut, "utf8") > budget) {
    cut = cut.slice(0, -1);
  }
  return cut + TRUNCATION_MARKER;
}

export interface AuditModule {
  appendAudit(entry: {
    ts?: number;
    space_id?: string | null;
    actor: string;
    event_type: string;
    payload: Record<string, unknown> | string;
  }): Promise<number>;
  listAudit(opts: { space?: string; since?: number; event_type?: string; limit?: number }): Promise<AuditRow[]>;
}

/**
 * Policy-side audit wrapper (issue #7). Owns redaction + the payload cap;
 * the store owns immutability (appendAudit is the only write path, plus
 * UPDATE/DELETE triggers in schema.sql). The policy extension (#6) wires
 * this with a live store.
 */
export function createAudit(store: Store): AuditModule {
  return {
    async appendAudit(entry) {
      const text = typeof entry.payload === "string" ? entry.payload : JSON.stringify(entry.payload);
      return store.appendAudit({
        ts: entry.ts,
        space_id: entry.space_id,
        actor: entry.actor,
        event_type: entry.event_type,
        payload: enforcePayloadCap(redact(text)),
      });
    },
    listAudit: (opts) => store.listAudit(opts),
  };
}
