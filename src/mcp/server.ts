/**
 * Bottega-hosted MCP server (issues #25, #61, #136): exposes the bottega
 * capability surface — memory, transcript search, the connect capability,
 * registered extension tools, and the internal tools (work items, model
 * settings, scheduler actions, KB — issue #206) — to ANY ACP agent with an
 * MCP client.
 *
 * The ACP driver attaches this server to a session via `session/new`'s
 * `mcpServers` field; the agent spawns `bun run src/mcp/server.ts` (stdio
 * transport) as a child process and sees `memory.save`, `memory.search`,
 * and `session_search` as native tools. Because tools execute server-side,
 * the policy gate and audit trail apply at execution time no matter which agent
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
 *   - tier from TIER_BY_TOOL (memory.save=write; memory.search/session_search=read)
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
 *   BOTTEGA_SESSION_DIR            transcript JSONL dir (default data/sessions)
 */
import type { Database } from "bun:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z, type ExtensionContext, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { MemoryProvider, MemorySaveInput, MemorySearchQuery } from "../memory/types";
import { validateSaveInput, validateSearchQuery } from "../memory/types";
import {
  indexSessionFiles,
  searchSessions,
  sessionSearchArgsSchema,
} from "../memory/session-search";
import type { AuditModule } from "../policy/audit";
import {
  applySpaceOverlay,
  decidePolicyCall,
  resolveTier,
  type Decision,
  type PolicyConfig,
  type Tier,
} from "../policy/config";
import { summarizeArgs } from "../policy/gate";
import { MEMORY_WRITE_EVENT, POLICY_DECISION_EVENT } from "../store/audit-events";
import { errorMessage } from "../tools/helpers";
import { memorySaveArgsSchema, memorySearchArgsSchema, sha256Hex } from "../tools/memory";
import {
  connectExtension,
  connectViaAuthBroker,
  CONNECT_EXTENSION_TOOL,
  type ConnectExtensionDeps,
} from "../extensions/connect";
import { mintUploadLink, MINT_UPLOAD_LINK_TOOL, UploadLinkStore } from "../extensions/upload-link";
import { createMcpOAuthConnector } from "../extensions/mcp-oauth";
import type { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionRuntime } from "../extensions/runtime";
import type { ExtensionTool, ExtensionToolParam, JsonObject, McpBinding } from "../extensions/manifest";
import { extensionToolSurface, toolOwnerExtensionId, type ExtensionSurfaces } from "../extensions/surface";
import { DenyRouter } from "../policy/approval-router";
import { loadSpacePolicy } from "../policy/config";
import { bootstrapRuntime, type BootstrapRuntime } from "../server/bootstrap-runtime";
import { seedBootSecretsFromVault } from "../server/boot-secrets";
import { syncProxyCredentialsFromEnv } from "../extensions/proxy-seed";
import type { SecretFileBoundaryOpts } from "../extensions/boundary";
import { buildRegistry } from "../scheduler/actions";
import { createIngestPollAction } from "../ingest/poll-action";
import { loadKbConfig, type KbConfig } from "../kb/config";
import { orgPulseAction } from "../scheduler/observer";
import { recurringWorkAction } from "../scheduler/recurring-work";
import { kbIngestAction } from "../scheduler/kb-ingest";
import { reflectionAction } from "../scheduler/reflection";
import { schedulerToolDefinitions } from "../scheduler/scheduler-tools";
import { standupDigestAction } from "../scheduler/standup";
import type { SchedulerActionRegistry } from "../scheduler/types";
import type { Store } from "../store/db";
import { kbToolDefinitions } from "../tools/kb-tools";
import { modelToolsDefinitions } from "../tools/model-settings";
import { workItemToolDefinitions } from "../tools/work-items";
import type { ModelCatalogEntry } from "../models/model-pin";

export interface MemoryMcpServerOptions {
  provider: MemoryProvider;
  /** Org floor + space overlay, already merged (mirrors policyFor in the extension). */
  policy: PolicyConfig;
  /** The audit trail (issue #7): every tool call's policy decision lands here. */
  audit: AuditModule;
  /** Shared SQLite handle + durable JSONL directory for transcript search. */
  sessionSearch: { db: Database; transcriptDir: string };
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
  /**
   * Internal tool surface (issue #206): when wired, the server also
   * advertises the internal tools (create_work_item, work_item_cancel,
   * complete_work_item, model_settings, the scheduler actions, kb_ingest) —
   * the SAME definitions the SDK sessions carry, executed server-side
   * through the same policy gate + audit. ACP sessions call them through
   * the MCP tool channel (the #154 "tool reach" gap). use_model stays
   * SDK-session-only: ACP sessions cannot switch models mid-session (the
   * agent's own config governs there, issue #64). Absent → none advertised.
   */
  internal?: McpInternalToolsOptions;
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
  registry: Pick<ExtensionRegistry, "list">;
  /** The #52 connect capability (gate included). */
  connect: ConnectExtensionDeps;
  /**
   * Pre-resolved effective tool surfaces (issue #158): extensionId →
   * pinned manifest tools or the discovered tools/list surface (see
   * resolveExtensionSurfaces). Absent → tools-less manifests discover
   * lazily through `mcpTransport` (cached, fail closed).
   */
  surfaces?: ExtensionSurfaces;
  /**
   * MCP transport seam for tools/list discovery of tools-less manifests
   * (issue #158). Defaults to the production transport
   * (src/extensions/runtime.ts); tests inject in-memory transports.
   */
  mcpTransport?: (binding: McpBinding) => Transport;
  /**
   * One-time upload link (issue #196): when wired, the server also
   * advertises `connect_upload_link` — mints a single-use, expiring URL
   * whose secret the server's browser endpoint stores DIRECTLY into the
   * vault. The store must share the `upload_tokens` table with the server
   * process's endpoint (both read the same SQLite file); the base URL
   * points at that endpoint (BOTTEGA_UPLOAD_BASE_URL, set by the ACP
   * driver). Absent → the mint tool is not advertised.
   */
  uploadLink?: { store: UploadLinkStore; baseUrl: () => string };
}

/**
 * The internal tool surface's server-side deps (issue #206). Everything is
 * the same wiring the SDK session toolset gets (src/server/index.ts): the
 * same store, the same org floor, the same scheduler registry, the same KB
 * config — so the MCP channel and the session channel run the SAME
 * definitions with the SAME policy gate and audit trail.
 */
export interface McpInternalToolsOptions {
  /** The store backing work items, model settings, and scheduler jobs. */
  store: Store;
  /** Org floor policy — the floor sessions gate against (work-item cancel authorization, issue #33). */
  orgPolicy: PolicyConfig;
  /**
   * Agent dir whose model catalog validates create_work_item model pins
   * (issue #185) and model_settings lists (issue #192). Default
   * "data/omp-agent" (the server/executor default).
   */
  agentDir?: string;
  /**
   * Model-catalog seam (issue #185/#192 tests): resolves the AVAILABLE
   * models. Defaults to the SDK registry over `agentDir`.
   */
  listModels?: (agentDir: string) => Promise<ModelCatalogEntry[]>;
  /** Scheduler action registry (create_scheduler_job validates the action name, issue #86). */
  schedulerRegistry?: SchedulerActionRegistry;
  /** KB config for kb_ingest (issue #91); absent → kb_ingest is not advertised. */
  kb?: KbConfig;
}

/**
 * Flattens a parse failure into a single-line message for the client,
 * prefixing each issue with its field path (e.g. `scope: must be ...`) so
 * protocol errors name the offending argument.
 */
function zodIssues(error: {
  message: string;
  issues: Array<{ message: string; path: PropertyKey[] }>;
}): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
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
 * One internal tool bound to this server (issue #206): the session
 * definition's name/description/schema (one source of truth) plus a `run`
 * that crosses THIS server's policy gate + audit, then executes the
 * definition against the pinned space.
 */
interface InternalToolBinding {
  name: string;
  description: string;
  /** JSON Schema advertised via tools/list — derived from the shared definition's parameters. */
  inputSchema: JsonObject;
  /** Gate → audit → validate → execute. Returns the MCP tool result. */
  run: (callArgs: CallToolRequest["params"]["arguments"]) => Promise<CallToolResult>;
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

const sessionSearchJsonSchema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    space: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 20 },
  },
  required: ["query"],
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

/** JSON Schema for `connect_upload_link` (mirrors the mint tool's params, issue #196). */
const mintUploadLinkJsonSchema = {
  type: "object",
  properties: {
    extension: { type: "string", description: "Extension id from the registry (e.g. the provider id)" },
    scope: {
      type: "string",
      enum: ["org", "personal"],
      description: "org = shared org account; personal = your own account",
    },
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
      ...(param.description !== undefined ? { description: param.description } : undefined),
    };
    if (param.required !== false) required.push(param.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** connect_extension args (mirrors the tool's CONNECT_PARAMS_SCHEMA + the paste-guard trim rule). */
const connectArgsSchema = z.object({
  extension: z.string().refine((value) => value.trim() !== "", { message: "extension must be a non-empty string" }),
  scope: z.enum(["org", "personal"]),
  api_key: z.string().optional(),
});

/** connect_upload_link args (mirrors the mint tool's params). */
const mintUploadLinkArgsSchema = z.object({
  extension: z.string().refine((value) => value.trim() !== "", { message: "extension must be a non-empty string" }),
  scope: z.enum(["org", "personal"]),
});

/** Validation of connect args at the MCP boundary (mirrors the tool's zod schema). */
function parseConnectArgs(
  input: CallToolRequest["params"]["arguments"],
): { ok: true; extension: string; scope: "org" | "personal"; apiKey?: string } | { ok: false; error: string } {
  const parsed = connectArgsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: zodIssues(parsed.error) };
  }
  return { ok: true, extension: parsed.data.extension, scope: parsed.data.scope, apiKey: parsed.data.api_key };
}

/** Validation of mint args at the MCP boundary (mirrors the tool's zod schema). */
function parseMintUploadLinkArgs(
  input: CallToolRequest["params"]["arguments"],
): { ok: true; extension: string; scope: "org" | "personal" } | { ok: false; error: string } {
  const parsed = mintUploadLinkArgsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: zodIssues(parsed.error) };
  }
  return { ok: true, extension: parsed.data.extension, scope: parsed.data.scope };
}

export function createMemoryMcpServer(opts: MemoryMcpServerOptions): Server {
  const actor = "agent";

  /** Every tool call audits its policy decision, like the in-session gate. */
  const auditDecision = (
    tool: string,
    tier: Tier,
    decision: Decision,
    reason: string,
    args: CallToolRequest["params"]["arguments"],
  ): Promise<number> =>
    opts.audit.appendAudit({
      space_id: opts.spaceId ?? null,
      actor,
      event_type: POLICY_DECISION_EVENT,
      payload: { tool, tier, decision, reason, args: summarizeArgs(args) },
    });

  /** Gate + audit first, then validate, then execute. Returns the MCP result. */
  const callSave = async (callArgs: CallToolRequest["params"]["arguments"]) => {
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

  const callSearch = async (callArgs: CallToolRequest["params"]["arguments"]) => {
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

  const callSessionSearch = async (callArgs: CallToolRequest["params"]["arguments"]) => {
    const tool = "session_search";
    const parsed = sessionSearchArgsSchema.safeParse(callArgs);
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, `${tool}: invalid arguments: ${zodIssues(parsed.error)}`);
    }
    const args = parsed.data;
    const gate = gateTool(opts.policy, tool);
    await auditDecision(tool, gate.tier, gate.decision, gate.reason, args);
    if (gate.error) throw gate.error;

    try {
      indexSessionFiles(opts.sessionSearch.db, opts.sessionSearch.transcriptDir);
      const entries = searchSessions(opts.sessionSearch.db, args);
      return { content: [{ type: "text", text: JSON.stringify(entries) }] };
    } catch (error) {
      return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
    }
  };

  const extensions = opts.extensions;

  /**
   * The internal tool surface (issue #206): one source of truth — the SAME
   * SDK definitions the session toolset carries (src/server/index.ts),
   * bound to THIS server's gate + audit + pinned space. The session-file
   * stub maps the pinned space id back through sessionIdFromFilePath, so
   * the definitions resolve the space exactly like they do in-session.
   */
  const sessionFile = opts.spaceId ? `${opts.spaceId}.jsonl` : undefined;
  const bindInternalTool = <TDef extends ToolDefinition>(definition: TDef): InternalToolBinding => {
    const name = definition.name;
    // SAFETY: every internal definition is authored with the SDK's zod
    // surface (omptype), whose schemas carry toJsonSchema()/safeParse() —
    // the ToolDefinition contract only promises the wider TSchema, so the
    // two methods are narrowed here (the same zod surface the memory tools
    // use, e.g. memorySaveArgsSchema).
    const parameters = definition.parameters as {
      toJsonSchema(): JsonObject;
      safeParse(input: CallToolRequest["params"]["arguments"]):
        | { success: true; data: unknown }
        | { success: false; error: { message: string; issues: Array<{ message: string; path: PropertyKey[] }> } };
    };
    // SAFETY: the stub exposes only sessionManager.getSessionFile() — the
    // one ExtensionContext member the internal tools read (they derive the
    // space id from the session file, exactly like the in-session tools).
    const ctx = {
      sessionManager: { getSessionFile: () => sessionFile },
    } as ExtensionContext;
    return {
      name,
      description: definition.description,
      inputSchema: parameters.toJsonSchema(),
      async run(callArgs) {
        // Gate + audit first (fail-closed: an unlisted tool denies before
        // any validation or execution), then validate, then execute —
        // mirrors the built-in tools' call order.
        const gate = gateTool(opts.policy, name);
        await auditDecision(name, gate.tier, gate.decision, gate.reason, callArgs);
        if (gate.error) throw gate.error;
        const parsed = parameters.safeParse(callArgs);
        if (!parsed.success) {
          throw new McpError(ErrorCode.InvalidParams, `${name}: invalid arguments: ${zodIssues(parsed.error)}`);
        }
        try {
          const result = await definition.execute("0", parsed.data, undefined, undefined, ctx);
          return { content: result.content, ...(result.isError === true ? { isError: true } : undefined) };
        } catch (err) {
          // Execution failures are tool outcomes, not protocol errors.
          return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
      },
    };
  };
  const internalTools: InternalToolBinding[] | undefined = opts.internal
    ? [
        ...workItemToolDefinitions(opts.internal.store, {
          orgPolicy: opts.internal.orgPolicy,
          agentDir: opts.internal.agentDir,
          listModels: opts.internal.listModels,
        }),
        ...modelToolsDefinitions(opts.internal.store, {
          audit: opts.audit,
          agentDir: opts.internal.agentDir,
          listModels: opts.internal.listModels,
        }),
        ...(opts.internal.schedulerRegistry !== undefined
          ? schedulerToolDefinitions(opts.internal.store, opts.audit, opts.internal.schedulerRegistry)
          : []),
        ...(opts.internal.kb !== undefined
          ? kbToolDefinitions({ store: opts.internal.store, config: opts.internal.kb })
          : []),
      ]
        // ACP sessions cannot switch models mid-session (the agent's own
        // config governs there, issue #64): use_model stays session-only.
        .filter((definition) => definition.name !== "use_model")
        .map(bindInternalTool)
    : undefined;
  const internalToolsByName: Record<string, InternalToolBinding> = Object.fromEntries(
    internalTools?.map((tool) => [tool.name, tool]) ?? [],
  );

  /**
   * The #52 connect capability on the MCP surface. Personal connects are
   * unprivileged (any principal connects their own account, no gate); org
   * connects cross the capability's gate — ask-human fails closed here via
   * DenyRouter, the same "headless MCP context has no approval channel"
   * rule as {@link gateTool}. Failures are tool outcomes (isError), never
   * protocol errors: the call ran and reported its result.
   */
  const callConnect = async (callArgs: CallToolRequest["params"]["arguments"]) => {
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
    return { content: [{ type: "text", text: outcome.message }], ...(outcome.ok ? undefined : { isError: true }) };
  };

  /**
   * The #196 one-time upload-link mint on the MCP surface. The token is
   * written to the shared `upload_tokens` table; the URL points at the
   * SERVER process's browser endpoint (BOTTEGA_UPLOAD_BASE_URL), which
   * stores the pasted secret directly into the vault — never through the
   * agent or a transcript.
   */
  const callMintUploadLink = async (callArgs: CallToolRequest["params"]["arguments"]) => {
    if (!extensions?.uploadLink) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${MINT_UPLOAD_LINK_TOOL}`);
    const parsed = parseMintUploadLinkArgs(callArgs);
    if (!parsed.ok) {
      throw new McpError(ErrorCode.InvalidParams, `${MINT_UPLOAD_LINK_TOOL}: invalid arguments: ${parsed.error}`);
    }
    const outcome = mintUploadLink(
      { extension: parsed.extension, scope: parsed.scope, actor: opts.defaultPrincipal ?? "agent", spaceId: opts.spaceId ?? undefined },
      { registry: extensions.connect.registry, store: extensions.uploadLink.store, baseUrl: extensions.uploadLink.baseUrl },
    );
    if (!outcome.ok) return { content: [{ type: "text", text: outcome.message }], isError: true };
    return { content: [{ type: "text", text: outcome.url }] };
  };

  /**
   * A registered extension's manifest tool through the #53 runtime: policy
   * gate (extension allowlist + tier) → credential ladder → egress
   * boundary → audit, all server-side. The runtime audits every call
   * (policy.decision + extension.call) and never lets a denied call reach
   * a credential or the provider.
   */
  const callExtensionTool = async (extensionId: string, toolName: string, callArgs: CallToolRequest["params"]["arguments"]) => {
    // The runtime's args contract is a JSON object; decode the wire value
    // here (undefined means "no arguments" → an empty object, like the
    // in-session tools).
    const parsed = z.record(z.string(), z.unknown()).optional().safeParse(callArgs);
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, `${toolName}: arguments must be an object`);
    }
    // SAFETY: MCP tool-call arguments cross the JSON-RPC wire as a JSON object
    // (the SDK's CallToolRequest arguments contract); the record schema above
    // already rejected non-object shapes, and the runtime only forwards JSON
    // values to the provider.
    const args = (parsed.data ?? {}) as JsonObject;
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

  /**
   * The advertised surface of every registered extension (registration
   * order): pinned manifest tools, or the discovered tools/list surface for
   * tools-less manifests (issue #158 — the agent sees the provider's real
   * surface, never a stale subset). Discovery is cached; a failing
   * discovery is a clear protocol error, never a silent empty list.
   */
  const advertisedExtensionTools = async (): Promise<
    Array<{ name: string; description: string; inputSchema: unknown }>
  > => {
    if (!extensions) return [];
    const out: Array<{ name: string; description: string; inputSchema: unknown }> = [];
    for (const { manifest } of extensions.registry.list()) {
      let surface: readonly ExtensionTool[];
      try {
        surface =
          extensions.surfaces?.get(manifest.id) ??
          (await extensionToolSurface(manifest, extensions.mcpTransport));
      } catch (err) {
        throw new McpError(
          ErrorCode.InternalError,
          `extension "${manifest.id}" tool surface unavailable: ${errorMessage(err)}`,
        );
      }
      for (const tool of surface) {
        out.push({
          name: tool.name,
          description: tool.description,
          inputSchema: extensionToolJsonSchema(tool.params),
        });
      }
    }
    return out;
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
      {
        name: "session_search",
        description:
          "Searches durable session transcripts with full-text ranking and an optional exact space filter. " +
          "Returns redacted, truncated message excerpts with source file, line, and timestamp. Read-only.",
        inputSchema: sessionSearchJsonSchema,
      },
      // Issue #206: the internal tools — the SAME definitions the SDK
      // sessions carry (name, description, schema — one source of truth).
      ...(internalTools !== undefined
        ? internalTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }))
        : []),
      ...(extensions
        ? [
            {
              name: CONNECT_EXTENSION_TOOL,
              description:
                `Connects an extension account for use in this space. ` +
                `scope "org" connects the organization's shared account — privileged, requires a human approver ` +
                `(denied in headless contexts without an approval channel). ` +
                `scope "personal" connects the requesting user's own account — any user may do it. ` +
                `Extensions whose credential type is api_key require the api_key parameter. ` +
                `Never paste a live token here — use connect_upload_link instead.`,
              inputSchema: connectJsonSchema,
            },
            ...(extensions.uploadLink
              ? [
                  {
                    name: MINT_UPLOAD_LINK_TOOL,
                    description:
                      `Mints a single-use, expiring HTTPS link for an api_key-type extension. ` +
                      `The user opens the link in a browser and pastes the secret there; the server stores it ` +
                      `DIRECTLY into the vault — never through chat or a transcript.`,
                    inputSchema: mintUploadLinkJsonSchema,
                  },
                ]
              : []),
            ...(await advertisedExtensionTools()),
          ]
        : []),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "memory.save") return callSave(args);
    if (name === "memory.search") return callSearch(args);
    if (name === "session_search") return callSessionSearch(args);
    // Issue #206: internal tools run through the policy gate (fail-closed)
    // + audit like every other call; an unlisted name falls through to the
    // unknown-tool error below.
    const internalTool = internalToolsByName[name];
    if (internalTool !== undefined) return internalTool.run(args);
    if (extensions) {
      if (name === CONNECT_EXTENSION_TOOL) return callConnect(args);
      if (name === MINT_UPLOAD_LINK_TOOL) return callMintUploadLink(args);
      // Issue #158: resolve the owner across the EFFECTIVE surface (pinned
      // tools first, then discovered tools for tools-less manifests).
      const extensionId = await toolOwnerExtensionId(
        extensions.registry,
        name,
        extensions.mcpTransport,
      );
      if (extensionId !== undefined) return callExtensionTool(extensionId, name, args);
    }
    throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  });

  return server;
}

/** The MCP composition root's boot result (issue #172). */
export interface McpBoot {
  /** The shared composition chain — the same pieces every root boots. */
  runtime: BootstrapRuntime;
  /** Org floor + space overlay, already merged (mirrors policyFor in the extension). */
  policy: PolicyConfig;
  /** The booted MCP server (stdio transport connected by the caller). */
  server: Server;
}

/**
 * The MCP composition root (issue #172, #153 item 2): the boot-time
 * process-scoped resources — the shared runtime chain (bootstrapRuntime:
 * store → audit → org policy → extension registry → effective surfaces →
 * extension runtime → memory provider, identical to the server and
 * executor roots), the session space's policy overlay, and the
 * memory/extension MCP server. The memory provider and the extension
 * boundary come from the shared chain — the historical MCP divergences
 * (hardwired SQLite provider, boundary without the broker secret resolver)
 * are the #172 regressions this replaces.
 *
 * Env contract (set by the ACP driver / caller): BOTTEGA_DB_PATH,
 * BOTTEGA_CONFIG_DIR, BOTTEGA_EXTENSIONS_DIR, BOTTEGA_SPACE_ID,
 * BOTTEGA_MCP_DEFAULT_PRINCIPAL, BOTTEGA_SESSION_DIR — see the file header.
 */
export async function bootMemoryMcpServer(opts: {
  dbPath?: string;
  configDir?: string;
  extensionsDir?: string;
  spaceId?: string | null;
  defaultPrincipal?: string;
  sessionDir?: string;
  mcpTransport?: (binding: McpBinding) => Transport;
  /**
   * Egress-boundary override (issue #191): proxy-control / secrets-dir
   * overrides threaded into the shared chain's credential boundary (see
   * {@link BootstrapRuntimeDeps.boundary}). The composition-root parity
   * test pins an absolute temp secrets dir so its authorize() probes never
   * touch the live data/proxy-secrets. Unset → the deployment defaults.
   */
  boundary?: SecretFileBoundaryOpts;
} = {}): Promise<McpBoot> {
  // Issue #201: same boot-secret seed as the server/executor roots (#172
  // parity) — this MCP child's sessions resolve models from the same env
  // names, so the provider keys must be seeded before any SDK use. Issue
  // #208: then push the provider credentials into the proxy (the app
  // process never holds them — the proxy injects at egress).
  await seedBootSecretsFromVault();
  await syncProxyCredentialsFromEnv();
  const runtime = await bootstrapRuntime({
    router: DenyRouter,
    // Env contract (see the file header): the ACP driver / tests pin the
    // DB, config, and extensions dirs; unset falls back to the defaults.
    dbPath: opts.dbPath ?? process.env.BOTTEGA_DB_PATH,
    ...(opts.configDir !== undefined ? { configDir: opts.configDir } : undefined),
    ...(opts.extensionsDir !== undefined ? { extensionsDir: opts.extensionsDir } : undefined),
    ...(opts.mcpTransport !== undefined ? { mcpTransport: opts.mcpTransport } : undefined),
    ...(opts.boundary !== undefined ? { boundary: opts.boundary } : undefined),
  });
  const { store, audit, orgPolicy } = runtime;
  // Per-session space: apply the space's overlay so the session's policy
  // floor is enforced (mirrors policyFor in src/policy/extension.ts).
  const spaceId = opts.spaceId ?? process.env.BOTTEGA_SPACE_ID ?? null;
  let policy = orgPolicy;
  if (spaceId) {
    const space = await store.getSpace(spaceId);
    if (!space) {
      throw new Error(`[mcp] space ${spaceId} not found — failing closed`);
    }
    policy = applySpaceOverlay(orgPolicy, space.policy_json);
  }
  // Issue #196: when the server process exposed its upload endpoint URL
  // (BOTTEGA_UPLOAD_BASE_URL — the ACP driver sets it), this child mints
  // links into the SHARED upload_tokens table, consumable by that endpoint.
  const uploadBaseUrl = process.env.BOTTEGA_UPLOAD_BASE_URL;
  const uploadLink =
    uploadBaseUrl && uploadBaseUrl.length > 0
      ? { store: new UploadLinkStore(store), baseUrl: () => uploadBaseUrl }
      : undefined;
  // Issue #198: same posture for hosted OAuth MCPs — the connect tool here
  // mints flows into the SHARED oauth_flows table with the callback pointed
  // at the SERVER process's OAuth callback endpoint (BOTTEGA_OAUTH_CALLBACK_BASE_URL,
  // set by the ACP driver like BOTTEGA_UPLOAD_BASE_URL).
  const oauthBaseUrl = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
  const mcpOAuth =
    oauthBaseUrl && oauthBaseUrl.length > 0
      ? createMcpOAuthConnector({ registry: runtime.registry, store, audit, callbackBaseUrl: () => oauthBaseUrl })
      : undefined;
  // Issue #206: the internal tools ride the MCP surface too — the same
  // scheduler registry the server boot builds (action-name validation for
  // create_scheduler_job) and the same KB config. A deployment without a
  // readable config/kb.yml simply lacks kb_ingest (fail closed, like the
  // un-wired upload-link mint).
  let kb: KbConfig | undefined;
  try {
    kb = loadKbConfig();
  } catch {
    // No KB config → the ingest tool is not advertised.
  }
  const server = createMemoryMcpServer({
    // The SAME memory backend the server and executor roots resolve
    // (issue #172): memory_backend.base_url set → mem0, else SQLite on the
    // store database — never a hardwired provider.
    provider: runtime.memoryProvider,
    policy,
    audit,
    spaceId,
    defaultPrincipal: opts.defaultPrincipal ?? process.env.BOTTEGA_MCP_DEFAULT_PRINCIPAL,
    sessionSearch: {
      db: store.getDb(),
      transcriptDir: opts.sessionDir ?? process.env.BOTTEGA_SESSION_DIR ?? "data/sessions",
    },
    internal: {
      store,
      orgPolicy,
      // The same five actions the server root registers (issue #86/#57) —
      // create_scheduler_job validates against this registry only; the
      // server process's runner executes the jobs.
      schedulerRegistry: buildRegistry([
        standupDigestAction,
        reflectionAction,
        orgPulseAction,
        recurringWorkAction,
        createIngestPollAction(),
        ...(kb !== undefined ? [kbIngestAction(kb)] : []),
      ]),
      ...(kb !== undefined ? { kb } : undefined),
    },
    extensions: {
      runtime: runtime.runtime,
      registry: runtime.registry,
      connect: {
        registry: runtime.registry,
        store,
        audit,
        broker: connectViaAuthBroker,
        ...(mcpOAuth !== undefined ? { mcpOAuth } : undefined),
        gate: {
          loadPolicy: (sid) => loadSpacePolicy(orgPolicy, store, sid),
          router: DenyRouter,
          timeoutMs: orgPolicy.timeoutMinutes * 60_000,
        },
      },
      ...(uploadLink !== undefined ? { uploadLink } : undefined),
    },
  });
  return { runtime, policy, server };
}

/** Boot the standalone server: `bun run src/mcp/server.ts` (spawned by the agent). */
if (import.meta.main) {
  try {
    const { server } = await bootMemoryMcpServer();
    await server.connect(new StdioServerTransport());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
