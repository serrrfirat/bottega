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
 * audited by the policy extension, so search appends nothing.
 */
import type { ExtensionFactory, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { MemoryProvider, MemorySaveInput, MemorySearchQuery } from "../memory/types";
import { validateSaveInput, validateSearchQuery } from "../memory/types";
import { MEMORY_WRITE_EVENT } from "../store/audit-events";
import { errorMessage, toolError } from "./helpers";
import type { AuditModule } from "../policy/audit";

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
 * shared by the in-session extension surface and the e2e harness's
 * customTools path. Restricted SDK sessions (restrictToolNames) drop
 * extension-registered tools, so surfaces that must reach the tools in
 * such sessions (the e2e harness) pass these definitions via
 * `createAgentSession`'s customTools; the extension registers the same
 * definitions for unrestricted sessions.
 */
export function memoryToolDefinitions(
  provider: MemoryProvider,
  opts: MemoryToolsExtensionOpts = {},
): Array<ToolDefinition<typeof memorySaveArgsSchema> | ToolDefinition<typeof memorySearchArgsSchema>> {
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
  const definitions = memoryToolDefinitions(provider, opts);
  return (pi) => {
    for (const definition of definitions) pi.registerTool(definition as ToolDefinition);
  };
}

/** SHA-256 hex digest: the audit stores the hash of saved content, never the content. */
export function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}
