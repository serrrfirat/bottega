/**
 * Memory tools (issue #22): the agent's explicit memory surface.
 *
 * memory.save is write-tier: it mutates durable state, so it prompts in
 * non-yolo approval modes (the policy gate, issue #6, resolves it via
 * TIER_BY_TOOL → write). memory.search is read-tier: it only queries, so
 * it runs under the read gate.
 *
 * Every successful save appends a `memory.write` audit row carrying
 * {scope, principal, id, content_hash} — a SHA-256 of the content, never
 * the content itself: memory is user data, and the hash keeps the audit
 * trail verifiable without leaking it. Policy decisions are already
 * audited by the policy gate, so search appends nothing.
 *
 * Issue #121: memory.save REFUSES obvious credential-shaped content (PATs,
 * Slack/OpenAI/AWS keys — see {@link looksLikeObviousSecret}) with a clear
 * error, writing nothing and auditing nothing. Memory is durable and
 * never deleted, so a pasted token would be a permanent leak; credentials
 * belong in the auth-broker vault (`connect <extension> as me|org`) or the
 * executor's 0600 PAT file, never in memory or chat.
 */
import type { ExtensionFactory, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { MemoryProvider, MemorySaveInput, MemorySearchQuery } from "../memory/types";
import { validateSaveInput, validateSearchQuery } from "../memory/types";
import { MEMORY_WRITE_EVENT } from "../store/audit-events";
import { errorMessage, toolError } from "./helpers";
import type { AuditModule } from "../policy/audit";

/**
 * Obvious credential shapes rejected by memory.save (issue #121): the token
 * families a user might paste into chat after an agent asked for one.
 * Word-bounded so prose mentioning a prefix is not refused. The list is
 * deliberately narrow and fail-closed: a false positive refuses one save
 * (the user rephrases), a false negative leaks a live credential into
 * durable memory that is never deleted.
 */
const OBVIOUS_SECRET_PATTERNS: readonly RegExp[] = [
  // GitHub fine-grained PATs (github_pat_<22>_<59>) and classic PATs.
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  // GitHub classic PATs / OAuth / user-to-server / server-to-server tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  // Slack bot/app/user tokens (xoxb- / xoxa- / xoxp- / xoxr- / xoxs-).
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  // OpenAI-style API keys.
  /\bsk-[A-Za-z0-9]{20,}\b/,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/,
  // NEAR-style API keys (the repo's secret templates use the same shape).
  /\bnear-[A-Za-z0-9]{20,}\b/,
];

/** True when content looks like an obvious credential; memory.save refuses these. */
export function looksLikeObviousSecret(content: string): boolean {
  return OBVIOUS_SECRET_PATTERNS.some((pattern) => pattern.test(content));
}

export interface MemoryToolsExtensionOpts {
  /** Principal used for user-scope saves when the call omits `principal`. */
  defaultPrincipal?: string;
  /** Audit module; every successful save appends a `memory.write` row. */
  audit?: Pick<AuditModule, "appendAudit">;
}

/** Argument shapes of the memory tools; shared with the MCP surface (src/mcp/server.ts). */
export const memorySaveArgsSchema = z.object({
  content: z.string(),
  scope: z.enum(["org", "user"]),
  principal: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export const memorySearchArgsSchema = z.object({
  query: z.string(),
  scope: z.enum(["org", "user"]),
  principal: z.string().optional(),
  limit: z.number().int().optional(),
});

/**
 * The memory tools as SDK {@link ToolDefinition}s (issue #66): one source
 * shared by the in-session extension surface and the customTools path.
 * Restricted SDK sessions (restrictToolNames) drop extension-registered
 * tools entirely, so surfaces that must reach the tools in such sessions
 * (the OMP driver's gatedTools, issue #69) pass these definitions; the
 * extension registers the same definitions for unrestricted sessions.
 */
export function memoryToolDefinitions(
  provider: MemoryProvider,
  opts: MemoryToolsExtensionOpts = {},
): ToolDefinition[] {
  const save: ToolDefinition<typeof memorySaveArgsSchema> = {
    name: "memory.save",
    label: "Save to memory",
    description:
      "Saves a memory entry to org-shared memory (scope: org) or a user's personal memory (scope: user; " +
      "principal required, or resolved from the session default). Content is stored by the memory " +
      "backend and audited by hash only. Write-tier: prompts for approval in non-yolo modes.",
    parameters: memorySaveArgsSchema,
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const principal = params.principal ?? opts.defaultPrincipal;
      const input: MemorySaveInput = { scope: params.scope, content: params.content, metadata: params.metadata };
      if (principal) input.principal = principal;
      try {
        validateSaveInput(input);
      } catch (err) {
        return toolError(errorMessage(err));
      }
      // Fail closed (issue #121): a credential-shaped save is refused with
      // a clear error BEFORE anything is written or audited — memory is
      // durable and never deleted, so a pasted token would be a permanent
      // leak. Credentials belong in the vault (connect_extension) or the
      // executor PAT file, not in memory.
      if (looksLikeObviousSecret(input.content)) {
        return toolError(
          "memory.save refuses credential-shaped content — secrets don't belong in memory (memory and transcripts are durable and never deleted). " +
            "Connect credentials instead (`connect <extension> as me|org`), or install the executor PAT file (mode 0600) — never paste tokens into chat.",
        );
      }
      try {
        const entry = await provider.save(input);
        await opts.audit?.appendAudit({
          actor: principal ?? "agent",
          event_type: MEMORY_WRITE_EVENT,
          payload: {
            scope: entry.scope,
            principal: entry.principal,
            id: entry.id,
            content_hash: sha256Hex(entry.content),
          },
        });
        return { content: [{ type: "text", text: JSON.stringify({ id: entry.id }) }] };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  const search: ToolDefinition<typeof memorySearchArgsSchema> = {
    name: "memory.search",
    label: "Search memory",
    description:
      "Searches saved memory entries in org or user scope (principal filters user scope). Returns " +
      "matching entries with content, metadata, and creation time. Read-only.",
    parameters: memorySearchArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const query: MemorySearchQuery = {
        query: params.query,
        scope: params.scope,
        principal: params.principal,
        limit: params.limit,
      };
      try {
        validateSearchQuery(query);
      } catch (err) {
        return toolError(errorMessage(err));
      }
      try {
        const entries = await provider.search(query);
        return { content: [{ type: "text", text: JSON.stringify(entries) }] };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  return [save, search];
}

export function memoryToolsExtension(provider: MemoryProvider, opts: MemoryToolsExtensionOpts = {}): ExtensionFactory {
  return (pi) => {
    for (const definition of memoryToolDefinitions(provider, opts)) pi.registerTool(definition);
  };
}

/** SHA-256 hex digest: the audit stores the hash of saved content, never the content. */
export function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}
