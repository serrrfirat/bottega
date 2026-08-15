/**
 * Bottega-hosted MCP server (issue #25): exposes the bottega capability
 * surface — memory first — to ANY ACP agent with an MCP client.
 *
 * The ACP driver attaches this server to a session via `session/new`'s
 * `mcpServers` field; the agent spawns `bun run src/mcp/server.ts` (stdio
 * transport) as a child process and sees `memory.save` / `memory.search`
 * as native tools. Because the tools execute **server-side**, the policy
 * gate and the audit trail apply at execution time no matter which agent
 * called them — the MCP surface is not a bypass of `src/policy/config.ts`
 * or `src/policy/audit.ts`.
 *
 * Transport choice: stdio. Probing real `omp acp` (issue #18's interop
 * method) showed omp's MCP client connects to `{command, args, env}`
 * entries — spawning the server, running initialize → tools/list, and
 * completing session/new (streamable-HTTP url entries work too, but stdio
 * gives each session its own process: per-session env pins the space, so
 * the space policy overlay is enforced per session with no shared state).
 *
 * Protocol surface: the official MCP TypeScript SDK runs cleanly on Bun
 * 1.3 (verified against real omp). The low-level `Server` is used rather
 * than the high-level tool registry so that gate refusals and argument
 * errors surface as JSON-RPC protocol errors: the high-level wrapper
 * converts every handler throw into an `isError` tool result, which would
 * let a denied call look like a tool that ran. Provider failures, by
 * contrast, are tool-execution failures and return `isError` content per
 * the MCP spec.
 *
 * Policy at execution (mirrors src/policy/extension.ts):
 *   - tier from TIER_BY_TOOL (memory.save=write, memory.search=read)
 *   - org config.yml floor + the session space's overlay
 *   - allow → run; deny → MCP error (no execution); ask-human → MCP error:
 *     a headless MCP context has no approval channel (ACP permission
 *     routing is issue #17's known gap), so it fails closed — the
 *     DenyRouter-equivalent. Every decision is audited as policy.decision.
 *
 * Audit: every successful save appends memory.write with the exact
 * content_hash shape the in-session tools use (sha256Hex from
 * src/tools/memory.ts) — the hash, never the content.
 *
 * Env contract (set by the ACP driver / caller):
 *   BOTTEGA_DB_PATH                SQLite file (default data/bottega.db)
 *   BOTTEGA_CONFIG_DIR             dir holding config.yml (org floor)
 *   BOTTEGA_SPACE_ID               session space (policy overlay + audit rows)
 *   BOTTEGA_MCP_DEFAULT_PRINCIPAL  default principal for user-scope saves
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { MemoryProvider, MemorySaveInput, MemorySearchQuery } from "../memory/types";
import { validateSaveInput, validateSearchQuery } from "../memory/types";
import { createSqliteMemoryProvider } from "../memory/sqlite";
import type { AuditModule } from "../policy/audit";
import { createAudit } from "../policy/audit";
import {
  applySpaceOverlay,
  decideToolCall,
  isKnownTool,
  loadOrgConfig,
  resolveTier,
  toolAction,
  type Decision,
  type PolicyConfig,
  type Tier,
} from "../policy/config";
import { createStore } from "../store/db";
import { MEMORY_WRITE_EVENT } from "../store/audit-events";
import { errorMessage } from "../tools/helpers";
import { memorySaveArgsSchema, memorySearchArgsSchema, sha256Hex } from "../tools/memory";

export interface MemoryMcpServerOptions {
  provider: MemoryProvider;
  /** Org floor + space overlay, already merged (mirrors policyFor in the extension). */
  policy: PolicyConfig;
  audit: Pick<AuditModule, "appendAudit">;
  /** Session space; recorded on audit rows. */
  spaceId?: string | null;
  /** Principal used for user-scope saves when the call omits `principal`. */
  defaultPrincipal?: string;
}

/** Cap for the args summary embedded in policy.decision rows (appendAudit redacts + caps too). */
const ARGS_SUMMARY_MAX = 1000;

function summarizeArgs(input: unknown): string {
  const text = JSON.stringify(input) ?? "";
  return text.length > ARGS_SUMMARY_MAX ? `${text.slice(0, ARGS_SUMMARY_MAX)}...[truncated]` : text;
}

/** Flattens a parse failure into a single-line message for the client. */
function zodIssues(error: { message: string; issues: Array<{ message: string }> }): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

interface GateResult {
  decision: Decision;
  reason: string;
  /** The tool's capability tier, audited alongside the decision. */
  tier: Tier;
  /** Non-null when the call must not run: the MCP error to throw. */
  error: McpError | null;
}

/**
 * The action gate (mirrors the policy extension's decide + fail-closed
 * deny). ask-human has no approval channel in the headless MCP context:
 * it fails closed (DenyRouter-equivalent) with the decision recorded in
 * the audit.
 */
function gateTool(policy: PolicyConfig, tool: string): GateResult {
  const tier = resolveTier(tool);
  if (!policy.ok) {
    const reason = `policy invalid: ${policy.errors[0] ?? "parse error"}`;
    return { decision: "deny", reason, tier, error: new McpError(ErrorCode.InvalidRequest, `policy: ${reason}`) };
  }
  const { decision, reason } = decideToolCall({
    tier,
    action: toolAction(policy, tool),
    toolKnown: isKnownTool(tool),
  });
  if (decision === "allow") return { decision, reason, tier, error: null };
  if (decision === "deny") return { decision, reason, tier, error: new McpError(ErrorCode.InvalidRequest, `policy: ${reason}`) };
  return {
    decision,
    reason,
    tier,
    error: new McpError(ErrorCode.InvalidRequest, `policy: ${reason} (headless MCP context has no approval channel — denied)`),
  };
}

/** JSON Schema advertised via tools/list (hand-written, mirrors the zod shapes). */
const saveJsonSchema = {
  type: "object",
  properties: {
    content: { type: "string" },
    scope: { type: "string", enum: ["org", "user"] },
    principal: { type: "string" },
    metadata: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["content", "scope"],
  additionalProperties: false,
} as const;

const searchJsonSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    scope: { type: "string", enum: ["org", "user"] },
    principal: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 20 },
  },
  required: ["query", "scope"],
  additionalProperties: false,
} as const;

export function createMemoryMcpServer(opts: MemoryMcpServerOptions): Server {
  const actor = "agent";

  /** Every tool call audits its policy decision, like the in-session gate. */
  const auditDecision = (
    tool: string,
    tier: string,
    decision: Decision,
    reason: string,
    args: unknown,
  ): Promise<number> =>
    opts.audit.appendAudit({
      space_id: opts.spaceId ?? null,
      actor,
      event_type: "policy.decision",
      payload: { tool, tier, decision, reason, args: summarizeArgs(args) },
    });

  /** Gate + audit first, then validate, then execute. Returns the MCP result. */
  const callSave = async (callArgs: unknown) => {
    const tool = "memory.save";
    const parsed = memorySaveArgsSchema.safeParse(callArgs);
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, `${tool}: invalid arguments: ${zodIssues(parsed.error)}`);
    }
    const args = parsed.data;
    const gate = gateTool(opts.policy, tool);
    await auditDecision(tool, gate.tier, gate.decision, gate.reason, args);
    if (gate.error) throw gate.error;

    const principal = args.principal ?? opts.defaultPrincipal;
    const input: MemorySaveInput = { scope: args.scope, content: args.content, metadata: args.metadata };
    if (principal) input.principal = principal;
    try {
      validateSaveInput(input);
    } catch (err) {
      throw new McpError(ErrorCode.InvalidParams, errorMessage(err));
    }
    try {
      const entry = await opts.provider.save(input);
      await opts.audit.appendAudit({
        space_id: opts.spaceId ?? null,
        actor: principal ?? actor,
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
      // Provider failures surface as tool errors, not protocol errors.
      return { content: [{ type: "text", text: errorMessage(err), isError: true }] };
    }
  };

  const callSearch = async (callArgs: unknown) => {
    const tool = "memory.search";
    const parsed = memorySearchArgsSchema.safeParse(callArgs);
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, `${tool}: invalid arguments: ${zodIssues(parsed.error)}`);
    }
    const args = parsed.data;
    const gate = gateTool(opts.policy, tool);
    await auditDecision(tool, gate.tier, gate.decision, gate.reason, args);
    if (gate.error) throw gate.error;

    const query: MemorySearchQuery = {
      query: args.query,
      scope: args.scope,
      principal: args.principal,
      limit: args.limit,
    };
    try {
      validateSearchQuery(query);
    } catch (err) {
      throw new McpError(ErrorCode.InvalidParams, errorMessage(err));
    }
    try {
      const entries = await opts.provider.search(query);
      return { content: [{ type: "text", text: JSON.stringify(entries) }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorMessage(err), isError: true }] };
    }
  };

  const server = new Server({ name: "bottega", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "memory.save",
        description:
          "Saves a memory entry to org-shared memory (scope: org) or a user's personal memory (scope: user; " +
          "principal required). Content is stored by the memory backend and audited by hash only. " +
          "Write-tier: subject to bottega policy — denied calls fail without executing.",
        inputSchema: saveJsonSchema,
      },
      {
        name: "memory.search",
        description:
          "Searches saved memory entries in org or user scope (principal filters user scope). Returns " +
          "matching entries with content, metadata, and creation time. Read-only.",
        inputSchema: searchJsonSchema,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "memory.save") return callSave(args);
    if (name === "memory.search") return callSearch(args);
    throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  });

  return server;
}

/** Boot the standalone server: `bun run src/mcp/server.ts` (spawned by the agent). */
if (import.meta.main) {
  const dbPath = process.env.BOTTEGA_DB_PATH ?? "data/bottega.db";
  const store = createStore(dbPath);
  const orgPolicy = loadOrgConfig(process.env.BOTTEGA_CONFIG_DIR);

  // Per-session space: apply the space's overlay so the session's policy
  // floor is enforced (mirrors policyFor in src/policy/extension.ts).
  const spaceId = process.env.BOTTEGA_SPACE_ID ?? null;
  let policy = orgPolicy;
  if (spaceId) {
    const space = await store.getSpace(spaceId);
    if (!space) {
      console.error(`[mcp] space ${spaceId} not found — failing closed`);
      process.exit(1);
    }
    policy = applySpaceOverlay(orgPolicy, space.policy_json);
  }

  const server = createMemoryMcpServer({
    provider: createSqliteMemoryProvider(store.getDb()),
    policy,
    audit: createAudit(store),
    spaceId,
    defaultPrincipal: process.env.BOTTEGA_MCP_DEFAULT_PRINCIPAL,
  });
  await server.connect(new StdioServerTransport());
}
