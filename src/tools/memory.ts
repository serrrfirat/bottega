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
import type { AgentToolResult, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { MemoryProvider, MemorySaveInput, MemorySearchQuery } from "../memory/types";
import { validateSaveInput, validateSearchQuery } from "../memory/types";
import type { AuditModule } from "../policy/audit";

export interface MemoryToolsExtensionOpts {
  /** Principal used for user-scope saves when the call omits `principal`. */
  defaultPrincipal?: string;
  /** Audit module; every successful save appends a `memory.write` row. */
  audit?: Pick<AuditModule, "appendAudit">;
}

export function memoryToolsExtension(provider: MemoryProvider, opts: MemoryToolsExtensionOpts = {}): ExtensionFactory {
  const saveSchema = z.object({
    content: z.string(),
    scope: z.enum(["org", "user"]),
    principal: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  });
  const searchSchema = z.object({
    query: z.string(),
    scope: z.enum(["org", "user"]),
    principal: z.string().optional(),
    limit: z.number().int().optional(),
  });
  return (pi) => {
    pi.registerTool({
      name: "memory.save",
      label: "Save to memory",
      description:
        "Saves a memory entry to org-shared memory (scope: org) or a user's personal memory (scope: user; " +
        "principal required, or resolved from the session default). Content is stored by the memory " +
        "backend and audited by hash only. Write-tier: prompts for approval in non-yolo modes.",
      parameters: saveSchema,
      approval: "write",
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const principal = params.principal ?? opts.defaultPrincipal;
        const input: MemorySaveInput = { scope: params.scope, content: params.content, metadata: params.metadata };
        if (principal) input.principal = principal;
        try {
          validateSaveInput(input);
        } catch (err) {
          return toolError((err as Error).message);
        }
        try {
          const entry = await provider.save(input);
          await opts.audit?.appendAudit({
            actor: principal ?? "agent",
            event_type: "memory.write",
            payload: {
              scope: entry.scope,
              principal: entry.principal,
              id: entry.id,
              content_hash: sha256Hex(entry.content),
            },
          });
          return { content: [{ type: "text", text: JSON.stringify({ id: entry.id }) }] };
        } catch (err) {
          return toolError((err as Error).message);
        }
      },
    });

    pi.registerTool({
      name: "memory.search",
      label: "Search memory",
      description:
        "Searches saved memory entries in org or user scope (principal filters user scope). Returns " +
        "matching entries with content, metadata, and creation time. Read-only.",
      parameters: searchSchema,
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
          return toolError((err as Error).message);
        }
        try {
          const entries = await provider.search(query);
          return { content: [{ type: "text", text: JSON.stringify(entries) }] };
        } catch (err) {
          return toolError((err as Error).message);
        }
      },
    });
  };
}

/** SHA-256 hex digest: the audit stores the hash of saved content, never the content. */
function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

function toolError(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
