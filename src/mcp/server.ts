/**
 * Bottega-hosted MCP server (issue #25, #61): exposes the bottega capability
 * surface — memory, the connect capability, and registered extension tools
 * — to ANY ACP agent with an MCP client.
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
 * Extension surface (issue #61): `connect_extension` and each registered
 * extension's manifest tools are advertised and executed through the #52
 * connect capability and the #53 runtime — policy gate (extension
 * allowlist + manifest tier) → credential ladder → egress boundary →
 * audit. Denied calls never resolve a credential or reach the provider;
 * their outcomes are audited and returned as tool errors (isError). Org
 * connects fail closed (DenyRouter) in this headless context; personal
 * connects are unprivileged and run for the session's principal.
 *
 * Audit: every successful save appends memory.write with the exact
 * content_hash shape the in-session tools use (sha256Hex from
 * src/tools/memory.ts) — the hash, never the content.
 *
 * Env contract (set by the ACP driver / caller):
 *   BOTTEGA_DB_PATH                SQLite file (default data/bottega.db)
 *   BOTTEGA_CONFIG_DIR             dir holding config.yml (org floor)
 *   BOTTEGA_EXTENSIONS_DIR         dir of pinned extension snapshots
 *                                  (default config/extensions — same
 *                                  registry the space server boots)
 *   BOTTEGA_SPACE_ID               session space (policy overlay + audit rows)
 *   BOTTEGA_MCP_DEFAULT_PRINCIPAL  default principal for user-scope saves,
 *                                  extension tool calls, and connects
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
  decidePolicyCall,
  loadOrgConfig,
  resolveTier,
  type Decision,
  type PolicyConfig,
  type Tier,
} from "../policy/config";
import { summarizeArgs } from "../policy/gate";
import { createStore } from "../store/db";
import { MEMORY_WRITE_EVENT, POLICY_DECISION_EVENT } from "../store/audit-events";
import { errorMessage } from "../tools/helpers";
import { memorySaveArgsSchema, memorySearchArgsSchema, sha256Hex } from "../tools/memory";
import {
  connectExtension,
  connectViaAuthBroker,
  CONNECT_EXTENSION_TOOL,
  type ConnectExtensionDeps,
} from "../extensions/connect";
import { createExtensionRegistry, type ExtensionRegistry } from "../extensions/registry";
import { createExtensionRuntime, type ExtensionRuntime } from "../extensions/runtime";
import type { ExtensionToolParam } from "../extensions/manifest";
import { DenyRouter } from "../policy/approval-router";
import { loadSpacePolicy } from "../policy/config";

export interface MemoryMcpServerOptions {
  provider: MemoryProvider;
  /** Org floor + space overlay, already merged (mirrors policyFor in the extension). */
  policy: PolicyConfig;
  audit: Pick<AuditModule, "appendAudit">;
  /** Session space; recorded on audit rows. */
  spaceId?: string | null;
  /** Principal used for user-scope saves when the call omits `principal`. */
  defaultPrincipal?: string;
  /**
   * Extension surface (issue #61): when wired, the server also advertises
   * `connect_extension` + every registered extension's manifest tools.
   * Execution is server-side through the #53 runtime (policy gate →
   * credential ladder → egress boundary → audit) and the #52 connect
   * capability — identical enforcement for every agent, no per-agent path.
   */
  extensions?: McpExtensionsOptions;
}

/**
 * The extension surface's server-side deps (issue #61). Everything
 * executes in this process, so the policy gate, the credential ladder, the
 * egress boundary, and the audit trail apply to MCP callers exactly as
 * they do to in-session OMP tool calls.
 */
export interface McpExtensionsOptions {
  /** The #53 runtime every manifest tool executes through. */
  runtime: ExtensionRuntime;
  /** Registry whose manifest tools are advertised + resolved by tool name. */
  registry: Pick<ExtensionRegistry, "list" | "extensionIdForTool">;
  /** The #52 connect capability (gate included). */
  connect: ConnectExtensionDeps;
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
 * The action gate (one implementation of the shared decision table —
 * decidePolicyCall, issue #26). ask-human has no approval channel in the
 * headless MCP context: it fails closed (DenyRouter-equivalent) with the
 * decision recorded in the audit.
 */
function gateTool(policy: PolicyConfig, tool: string): GateResult {
  const tier = resolveTier(tool);
  const { decision, reason } = decidePolicyCall(policy, tool);
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

/** JSON Schema for `connect_extension` (mirrors the capability's params, issue #52). */
const connectJsonSchema = {
  type: "object",
  properties: {
    extension: { type: "string", description: "Extension id from the registry (e.g. the provider id)" },
    scope: {
      type: "string",
      enum: ["org", "personal"],
      description: "org = shared org account (privileged, needs approval); personal = your own account",
    },
    api_key: { type: "string", description: "API key for api_key-type extensions" },
  },
  required: ["extension", "scope"],
  additionalProperties: false,
} as const;

/** Manifest tool params -> the JSON Schema advertised via tools/list. */
function extensionToolJsonSchema(params: ExtensionToolParam[]) {
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];
  for (const param of params) {
    properties[param.name] = {
      type: param.type,
      ...(param.description !== undefined ? { description: param.description } : {}),
    };
    if (param.required !== false) required.push(param.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** Hand-rolled validation of connect args (mirrors the tool's zod schema). */
function parseConnectArgs(input: unknown): { ok: true; extension: string; scope: "org" | "personal"; apiKey?: string } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "arguments must be an object" };
  }
  const record = input as Record<string, unknown>;
  const extension = record["extension"];
  const scope = record["scope"];
  const apiKey = record["api_key"];
  if (typeof extension !== "string" || extension.trim() === "") {
    return { ok: false, error: "extension must be a non-empty string" };
  }
  if (scope !== "org" && scope !== "personal") {
    return { ok: false, error: 'scope must be "org" or "personal"' };
  }
  if (apiKey !== undefined && typeof apiKey !== "string") {
    return { ok: false, error: "api_key must be a string" };
  }
  return { ok: true, extension, scope, apiKey };
}

export function createMemoryMcpServer(opts: MemoryMcpServerOptions): Server {
  const actor = "agent";

  /** Every tool call audits its policy decision, like the in-session gate. */
  const auditDecision = (
    tool: string,
    tier: Tier,
    decision: Decision,
    reason: string,
    args: unknown,
  ): Promise<number> =>
    opts.audit.appendAudit({
      space_id: opts.spaceId ?? null,
      actor,
      event_type: POLICY_DECISION_EVENT,
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
      return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
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
      return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
    }
  };

  const extensions = opts.extensions;

  /**
   * The #52 connect capability on the MCP surface. Personal connects are
   * unprivileged (any principal connects their own account, no gate); org
   * connects cross the capability's gate — ask-human fails closed here via
   * DenyRouter, the same "headless MCP context has no approval channel"
   * rule as {@link gateTool}. Failures are tool outcomes (isError), never
   * protocol errors: the call ran and reported its result.
   */
  const callConnect = async (callArgs: unknown) => {
    if (!extensions) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${CONNECT_EXTENSION_TOOL}`);
    const parsed = parseConnectArgs(callArgs);
    if (!parsed.ok) {
      throw new McpError(ErrorCode.InvalidParams, `${CONNECT_EXTENSION_TOOL}: invalid arguments: ${parsed.error}`);
    }
    const actor = opts.defaultPrincipal ?? "agent";
    const outcome = await connectExtension(
      { extension: parsed.extension, scope: parsed.scope, apiKey: parsed.apiKey, actor, spaceId: opts.spaceId ?? undefined },
      extensions.connect,
    );
    return { content: [{ type: "text", text: outcome.message }], ...(outcome.ok ? {} : { isError: true }) };
  };

  /**
   * A registered extension's manifest tool through the #53 runtime: policy
   * gate (extension allowlist + tier) → credential ladder → egress
   * boundary → audit, all server-side. The runtime audits every call
   * (policy.decision + extension.call) and never lets a denied call reach
   * a credential or the provider.
   */
  const callExtensionTool = async (extensionId: string, toolName: string, callArgs: unknown) => {
    if (callArgs !== undefined && (typeof callArgs !== "object" || callArgs === null || Array.isArray(callArgs))) {
      throw new McpError(ErrorCode.InvalidParams, `${toolName}: arguments must be an object`);
    }
    const args = (callArgs ?? {}) as Record<string, unknown>;
    const result = await extensions!.runtime.execute({
      extensionId,
      toolName,
      args,
      caller: opts.defaultPrincipal ?? "agent",
      spaceId: opts.spaceId ?? undefined,
    });
    if (!result.ok) return { content: [{ type: "text", text: result.error }], isError: true };
    return { content: result.content };
  };

  /** Registry manifest tools advertised on this surface (registration order). */
  const advertisedExtensionTools = extensions
    ? extensions.registry.list().flatMap(({ manifest }) =>
        manifest.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: extensionToolJsonSchema(tool.params),
        })),
      )
    : [];

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
      ...(extensions
        ? [
            {
              name: CONNECT_EXTENSION_TOOL,
              description:
                `Connects an extension account for use in this space. ` +
                `scope "org" connects the organization's shared account — privileged, requires a human approver ` +
                `(denied in headless contexts without an approval channel). ` +
                `scope "personal" connects the requesting user's own account — any user may do it. ` +
                `Extensions whose credential type is api_key require the api_key parameter.`,
              inputSchema: connectJsonSchema,
            },
            ...advertisedExtensionTools,
          ]
        : []),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "memory.save") return callSave(args);
    if (name === "memory.search") return callSearch(args);
    if (extensions) {
      if (name === CONNECT_EXTENSION_TOOL) return callConnect(args);
      const extensionId = extensions.registry.extensionIdForTool(name);
      if (extensionId !== undefined) return callExtensionTool(extensionId, name, args);
    }
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

  const audit = createAudit(store);
  // Extension surface (issue #61): the same registry the space server
  // boots (config/extensions; env-overridable for tests and per-org
  // deployments). Runtime + connect run server-side, so the gate, ladder,
  // boundary, and audit apply identically to every MCP caller.
  const extensionRegistry = createExtensionRegistry(process.env.BOTTEGA_EXTENSIONS_DIR ?? "config/extensions");
  const extensionRuntime = createExtensionRuntime({
    registry: extensionRegistry,
    store,
    audit,
    // Org floor only — the runtime applies the session space's overlay per
    // call via loadSpacePolicy (BOTTEGA_SPACE_ID pins the session space).
    orgPolicy,
    // Headless MCP context: ask-human has no approval channel, so it fails
    // closed (DenyRouter) — the same rule as the memory gate above.
    router: DenyRouter,
    timeoutMs: orgPolicy.timeoutMinutes * 60_000,
  });
  const server = createMemoryMcpServer({
    provider: createSqliteMemoryProvider(store.getDb()),
    policy,
    audit,
    spaceId,
    defaultPrincipal: process.env.BOTTEGA_MCP_DEFAULT_PRINCIPAL,
    extensions: {
      runtime: extensionRuntime,
      registry: extensionRegistry,
      connect: {
        registry: extensionRegistry,
        store,
        audit,
        broker: connectViaAuthBroker,
        gate: {
          loadPolicy: (sid) => loadSpacePolicy(orgPolicy, store, sid),
          router: DenyRouter,
          timeoutMs: orgPolicy.timeoutMinutes * 60_000,
        },
      },
    },
  });
  await server.connect(new StdioServerTransport());
}
