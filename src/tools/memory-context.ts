/**
 * Memory-context injection (issue #42, supersedes #23).
 *
 * Layer 2 of the context strategy: instead of replaying raw transcripts,
 * the space agent gets ONE compact system message of relevant memory at the
 * start of each turn. The seam is the OMP SDK `context` event (a
 * message-chain filter): it fires before every LLM call with a deep copy of
 * the messages about to be sent, and a handler may return a replacement
 * list. Injection is therefore LLM-visible only — the session transcript is
 * never touched.
 *
 * Mechanics per provider request:
 * 1. Skip when injection is disabled, already injected this turn (the
 *    injected message is not persisted, so the conversation-content check
 *    alone cannot catch re-injection within a turn — a per-turn flag reset
 *    on `agent_start` covers it), or the conversation already contains a
 *    memory-injection message (the issue's no-re-injection rule).
 * 2. Take the latest user message text as the search query.
 * 3. Search org scope, plus user scope for the space's last known principal
 *    (threaded per session via the driver's `getPrincipal` seam — the
 *    smallest analogue of the MCP server's BOTTEGA_SPACE_ID pattern, which
 *    lives at session creation on the driver side).
 * 4. Prepend ONE compact developer message ("Relevant memory:\n- ...")
 *    budget-capped by entries (maxEntries, default 5) and bytes (maxBytes,
 *    default 4096). Entries are deduped by content; org and user hits share
 *    the budget.
 *
 * ACP path: documented only — ACP agents reach memory through the MCP tools
 * (issue #25); the ACP driver cannot hook their context.
 */
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { MEMORY_LIMIT_MAX, type MemoryEntry, type MemoryProvider } from "../memory/types";

/** Fixed label of the injected message; also the "already injected" marker. */
export const MEMORY_INJECTION_PREFIX = "Relevant memory:";

export interface MemoryContextExtensionOpts {
  /** User-scope fallback when the session exposes no live principal. */
  defaultPrincipal?: string;
  /** Max memory entries per injection. Default 5. */
  maxEntries?: number;
  /** Max bytes of the injected message body (prefix included). Default 4096. */
  maxBytes?: number;
  /** Master switch (policy config `memory.injection.enabled`). Default true. */
  enabled?: boolean;
  /** Per-session principal getter (driver opts seam, issue #42). */
  getPrincipal?: () => string | undefined;
}

export function memoryContextExtension(
  provider: MemoryProvider,
  opts: MemoryContextExtensionOpts = {},
): ExtensionFactory {
  const maxEntries = opts.maxEntries ?? 5;
  const maxBytes = opts.maxBytes ?? 4096;
  const enabled = opts.enabled ?? true;
  return (pi) => {
    // The injected message exists only in the LLM-visible copy, so a
    // "already injected" scan of the conversation cannot see it on the next
    // provider request of the same turn. The per-turn flag is the real
    // guard; the content check below is the issue's belt-and-suspenders rule.
    let injectedThisTurn = false;
    pi.on("agent_start", () => {
      injectedThisTurn = false;
    });
    pi.on("context", async (event) => {
      if (!enabled || injectedThisTurn) return;
      if (event.messages.some(isInjectionMessage)) return;
      const query = latestUserText(event.messages);
      if (!query) return;
      const principal = opts.getPrincipal?.() ?? opts.defaultPrincipal;
      // Search itself caps at MEMORY_LIMIT_MAX; honor a larger maxEntries for
      // the combined budget, but never ask the provider for more than it allows.
      const limit = Math.min(maxEntries, MEMORY_LIMIT_MAX);
      const [orgHits, userHits] = await Promise.all([
        provider.search({ query, scope: "org", limit }),
        principal
          ? provider.search({ query, scope: "user", principal, limit })
          : Promise.resolve<MemoryEntry[]>([]),
      ]);
      const body = renderInjection([...orgHits, ...userHits], maxEntries, maxBytes);
      if (!body) return;
      injectedThisTurn = true;
      return {
        messages: [{ role: "developer", content: body, timestamp: Date.now() }, ...event.messages],
      };
    });
  };
}

/** True when a message is one of our injected memory blocks (by fixed prefix). */
function isInjectionMessage(message: { role: string; content?: unknown }): boolean {
  return typeof message.content === "string" && message.content.startsWith(MEMORY_INJECTION_PREFIX);
}

/** The latest user message's text (steering/synthetic included — latest wins). */
function latestUserText(messages: Array<{ role: string; content?: unknown }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user" || typeof message.content !== "string") continue;
    const text = message.content.trim();
    if (text) return text;
  }
  return null;
}

/**
 * Renders the injected body: `- <content>` bullets, deduped by content,
 * entry-capped then byte-capped (the "Relevant memory:" prefix counts
 * against the byte budget). A single oversized entry is truncated to fit
 * rather than dropped, so one huge memory can never starve injection.
 * Empty result when nothing fits.
 */
export function renderInjection(entries: MemoryEntry[], maxEntries: number, maxBytes: number): string {
  const prefix = `${MEMORY_INJECTION_PREFIX}\n`;
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  let remaining = maxBytes - prefixBytes;
  if (remaining <= 0) return "";

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of entries) {
    if (lines.length >= maxEntries) break;
    const text = entry.content.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    let line = `- ${text}`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > remaining) {
      if (remaining <= 0) break;
      line = truncateUtf8(line, remaining);
      lines.push(line);
      break;
    }
    lines.push(line);
    remaining -= lineBytes;
  }
  return lines.length ? prefix + lines.join("\n") : "";
}

/** Cuts `text` down to at most `maxBytes` UTF-8 bytes (code-point safe). */
function truncateUtf8(text: string, maxBytes: number): string {
  let cut = text;
  while (Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(0, -1);
  return cut;
}
