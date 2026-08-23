import type { AuditRow, ListAuditOpts, Store } from "../store/db";
import { z } from "@oh-my-pi/pi-coding-agent";

/** Payload cap before write (issue #7): oversized payloads are truncated, never dropped. */
export const MAX_PAYLOAD_BYTES = 4 * 1024;
export const TRUNCATION_MARKER = "\n...[truncated]";

/**
 * Best-effort redaction pass over secret-shaped values. Deterministic:
 * every match is replaced with a fixed `[REDACTED]` literal. The regex
 * shapes cover Slack/OpenAI/Anthropic/Near/GitHub/Google-OAuth token
 * families plus generic high-entropy key assignments; the guards keep the
 * false-positive rate sane (e.g. short `token=`/`key=`/`secret=` values are
 * only redacted at 32+ chars). OMP SecretObfuscator integration is deferred
 * to issue #9 (secrets obfuscation must then be enabled at boot).
 */
export function redact(text: string): string {
  let out = text;
  // Slack tokens: xoxb / xoxa / xoxp / xoxr / xoxs (anchored so the "sk-"
  // / "xox"-style shapes only redact real tokens, not words like "ask-human").
  out = out.replace(/(?<![A-Za-z0-9])xox[baprs]-[0-9a-zA-Z-]+/g, "[REDACTED]");
  // OpenAI/Anthropic-style API keys (sk-proj-... etc).
  out = out.replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9-]+/g, "sk-[REDACTED]");
  // AWS access key ids.
  out = out.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]");
  // GitHub fine-grained PATs.
  out = out.replace(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED]");
  // GitHub classic PATs, OAuth/app/server/refresh tokens (gh[pousr]_ prefixes).
  out = out.replace(/(?<![A-Za-z0-9])gh[oprsu]_[A-Za-z0-9]{15,}/g, "[REDACTED]");
  // NEAR secret keys: ed25519-encoded base58 private keys (near CLI keygen).
  out = out.replace(/(?<![A-Za-z0-9])ed25519:[A-Za-z0-9]+/g, "[REDACTED]");
  // Google OAuth access tokens (ya29.<opaque>).
  out = out.replace(/(?<![A-Za-z0-9])ya29\.[A-Za-z0-9._~+/=-]+/g, "[REDACTED]");
  // Bearer tokens (keep the "Bearer" label, mask the credential).
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}/g, "$1[REDACTED]");
  // Generic key: value pairs (JSON or text) for secret-shaped keys.
  out = out.replace(
    /("?(?:api[_-]?key|api[_-]?secret|auth[_-]?token|access[_-]?token|password|client[_-]?secret|refresh[_-]?token)"?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/g,
    "$1[REDACTED]",
  );
  // Generic HIGH-ENTROPY assignments with short key names (token= / key= /
  // secret=): only redact 32+ char values so ordinary low-entropy config
  // strings (e.g. `key=a`, `secret=short`, `token=abc`) are left alone.
  out = out.replace(
    /(?<![A-Za-z0-9])("?(?:token|secret|key)"?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{32,}/g,
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

/** JSON-serializable values accepted as audit payloads (stringified on write). */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface AuditModule {
  appendAudit(entry: {
    ts?: number;
    space_id?: string | null;
    actor: string;
    event_type: string;
    payload: JsonValue;
  }): Promise<number>;
  listAudit(opts?: ListAuditOpts): Promise<AuditRow[]>;
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
      const parsed = z.string().safeParse(entry.payload);
      const text = parsed.success ? parsed.data : JSON.stringify(entry.payload);
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
