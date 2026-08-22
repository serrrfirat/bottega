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
import { sha256Hex } from "./helpers";
import type { MemoryProvider, MemorySaveInput, MemoryScopeKey } from "../memory/types";
import { validateSaveInput } from "../memory/types";
import type { MemoryScopeContext } from "../memory/scope";
import { recallMemories, scopedSave } from "../memory/scope";
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
  /**
   * Authenticated invocation context (issue #137): resolved per tool call from
   * the space id (from the session file) + the turn principal + DM/channel
   * classification + effective `memory.team`. The tools derive their writable
   * (save) and readable (search) scope keys from this — a prompt/tool argument
   * can never select another user, channel, or team. Absent → org-only
   * fallback (fail closed; no person/channel scopes).
   */
  getScopeContext?: (spaceId: string) => MemoryScopeContext | Promise<MemoryScopeContext>;
  /** Audit module; every successful save appends a `memory.write` row, every successful recall a `memory.recalled` row. */
  audit?: Pick<AuditModule, "appendAudit">;
}

/** Argument shapes of the memory tools; shared with the MCP surface (src/mcp/server.ts). */
export const memorySaveArgsSchema = z.object({
  content: z.string(),
  // Issue #137: the model names the writable SCOPE KIND (org / person / channel);
  // the system derives the concrete key from the authenticated context — a
  // composite key for another user/channel/team is impossible to express.
  scope: z.enum(["org", "person", "channel"]).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export const memorySearchArgsSchema = z.object({
  query: z.string(),
  // Issue #137: an optional filter restricting recall to one derived readable
  // scope kind; omitted → all derived readable scopes (org always included).
  scope: z.enum(["org", "person", "channel", "team", "all"]).optional(),
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
/** The default writable scope kind when the save omits `scope`. */
function defaultSaveKind(ctx: MemoryScopeContext | undefined): "org" | "person" | "channel" {
  // No authenticated context → org-only (fail closed; never guess a person/channel).
  if (!ctx) return "org";
  return ctx.directMessage ? "person" : "channel";
}

interface SaveScopeResolution {
  key: MemoryScopeKey;
}

/**
 * Maps a requested save scope KIND to the concrete writable scope key derived
 * from the authenticated context. The model names only the kind; the key is
 * always derived. `org` is always writable (the existing policy/approval tier
 * gates it); `person` requires a DM with a principal; `channel` requires a
 * shared channel. Any other user/channel/team cannot be expressed.
 */
function saveScopeKey(
  kind: "org" | "person" | "channel",
  ctx: MemoryScopeContext | undefined,
): SaveScopeResolution | undefined {
  if (kind === "org") return { key: { kind: "org" } };
  if (!ctx) return undefined;
  if (kind === "person") {
    if (!ctx.directMessage || !ctx.principal) return undefined;
    return { key: { kind: "person", principal: ctx.principal } };
  }
  // channel
  if (ctx.directMessage) return undefined;
  return { key: { kind: "channel", spaceId: ctx.spaceId } };
}

/** Resolves the invocation space id from the tool's session file (`<space>.jsonl`). */
function spaceIdFromContext(ctx: { sessionManager?: { getSessionFile(): string | null | undefined } } | undefined): string | undefined {
  const file = ctx?.sessionManager?.getSessionFile();
  if (!file) return undefined;
  const name = file.split("/").pop() ?? file;
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : undefined;
}

export function memoryToolDefinitions(
  provider: MemoryProvider,
  opts: MemoryToolsExtensionOpts = {},
): ToolDefinition[] {
  const save: ToolDefinition<typeof memorySaveArgsSchema> = {
    name: "memory.save",
    label: "Save to memory",
    description:
      "Saves a memory entry to the conversation's writable scope: your own person memory (DM), the " +
      "current channel, or org-shared memory (org). The concrete person/channel key is derived from the " +
      "authenticated context — you cannot write another user's, channel's, or team's memory. Content is " +
      "stored by the memory backend and audited by hash only. Write-tier: prompts for approval in non-yolo modes.",
    parameters: memorySaveArgsSchema,
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const spaceId = spaceIdFromContext(_ctx) ?? "";
      const scopeCtx = opts.getScopeContext ? await opts.getScopeContext(spaceId) : undefined;
      // Derive the concrete writable scope key from the authenticated context.
      const writableKey = saveScopeKey(params.scope ?? defaultSaveKind(scopeCtx), scopeCtx);
      if (!writableKey) {
        return toolError(
          "memory.save: this conversation cannot write that scope (person requires a DM; channel requires a shared channel)", 
        );
      }
      let input: MemorySaveInput;
      try {
        input = scopedSave(writableKey.key, params.content, scopeCtx ?? { spaceId: "", principal: undefined, directMessage: true, teamId: undefined }, params.metadata);
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
        validateSaveInput(input);
      } catch (err) {
        return toolError(errorMessage(err));
      }
      try {
        const entry = await provider.save(input);
        await opts.audit?.appendAudit({
          actor: scopeCtx?.principal ?? "agent",
          event_type: MEMORY_WRITE_EVENT,
          payload: {
            scope: entry.key.kind,
            id: entry.id,
            content_hash: sha256Hex(entry.content),
          },
        });
        return { content: [{ type: "text", text: JSON.stringify({ id: entry.id, scope: entry.key.kind }) }] };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  const search: ToolDefinition<typeof memorySearchArgsSchema> = {
    name: "memory.search",
    label: "Search memory",
    description:
      "Searches saved memory entries across the conversation's readable scopes (org always; plus the " +
      "person in a DM, or the channel + configured team in a channel). An optional scope filter restricts " +
      "recall to one of those kinds; you cannot read another user's, channel's, or team's memory. Read-only.",
    parameters: memorySearchArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const spaceId = spaceIdFromContext(_ctx) ?? "";
      const scopeCtx = opts.getScopeContext ? await opts.getScopeContext(spaceId) : undefined;
      try {
        const entries = await recallMemories(
          provider,
          scopeCtx ?? { spaceId: "", principal: undefined, directMessage: true, teamId: undefined },
          params.query,
          { limit: params.limit, audit: opts.audit },
        );
        // Optional scope-kind filter: intersect with what the recall returned
        // (the recall already restricted to the derived readable set, so the
        // filter can only narrow, never widen).
        const filtered =
          params.scope && params.scope !== "all" ? entries.filter((e) => e.key.kind === params.scope) : entries;
        return { content: [{ type: "text", text: JSON.stringify(filtered) }] };
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
