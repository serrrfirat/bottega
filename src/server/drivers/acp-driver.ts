import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { SessionManager, type TodoPhase } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import type { AuditModule } from "../../policy/audit";
import type { ApprovalRouter } from "../../policy/approval-router";
import { evaluatePolicyGate } from "../../policy/gate";
import type { PolicyConfig } from "../../policy/config";
import {
  createEmitter,
  sessionFilePath,
  SPACE_AGENT_TOOLS,
  type AgentDriver,
  type AgentSessionDriver,
  type AgentTurnOptions,
  type DriverEvent,
  type ModelRole,
  type ModelRoleSwitchResult,
} from "./agent-driver";

/**
 * ACP (Agent Client Protocol) driver — the second AgentDriver implementation.
 *
 * Spawns an ACP server (`omp acp` by default) as a child process and speaks
 * ACP v1 over the stdio transport: newline-delimited JSON-RPC 2.0 (messages
 * MUST NOT contain embedded newlines; see agentclientprotocol.com/protocol/v1
 * /transports). One child process per session: initialize -> session/new,
 * then session/prompt turns streamed as session/update notifications, with
 * session/cancel for aborts and session/close on dispose.
 *
 * Inbound `session/request_permission` requests are the ACP policy seam
 * (issue #26): with a {@link AcpPolicyContext} configured, each request is
 * evaluated against the same policy table the in-process OMP extension uses
 * (tier × org config + space overlay → allow | deny | ask-human; ask-human
 * routes through the configured ApprovalRouter) and answered with ACP's
 * permission response shape (`outcome: selected` with an allow/reject
 * option id). Every decision is audited (`policy.decision`; ask-human also
 * `approval.requested`/`approval.resolved`). Unknown tools deny — fail
 * closed. Without a policy context the driver stays transport-only and
 * answers method-not-found (nothing can run), as does every other
 * client-gated inbound method (fs/*, terminal/*, elicitation/*).
 */
export interface AcpMcpServerEntry {
  /** Advertised to the agent; becomes the MCP tool prefix (e.g. `bottega`). */
  name: string;
  /** Stdio transport: the command the agent spawns (absolute path recommended). */
  command: string;
  args?: string[];
  /** Extra env for the spawned MCP server process (BOTTEGA_DB_PATH, ...). */
  env?: Record<string, string>;
}

/**
 * Policy context for ACP sessions (issue #26): wires the driver's
 * `session/request_permission` handler to the same policy engine the
 * in-process OMP extension uses. Without it, permission requests answer
 * method-not-found (transport only — no tool can run).
 */
export interface AcpPolicyContext {
  /** Org floor; the fallback policy when no per-space resolver is given. */
  orgPolicy: PolicyConfig;
  /**
   * Resolves the effective policy for a space (org floor + the space's
   * `spaces.policy_json` overlay). Defaults to the org floor for every
   * space.
   */
  loadPolicy?: (spaceId: string | undefined) => Promise<PolicyConfig>;
  /** Audit trail; every decision writes `policy.decision` rows. */
  audit: AuditModule;
  /** ask-human routing (DenyRouter in headless contexts). */
  router: ApprovalRouter;
  /** Actor recorded on audit rows; defaults to "agent". */
  actor?: string;
  /** Ask-human timeout in ms; defaults to the policy's `approvals.timeout_minutes`. */
  timeoutMs?: number;
}

export interface AcpDriverOptions {
  /** ACP server executable. Default "omp". */
  command?: string;
  /** Arguments for the ACP server. Default ["acp"]. */
  args?: string[];
  /** Milliseconds to wait for the initialize + session/new handshake. Default 30s. */
  sessionTimeoutMs?: number;
  /**
   * MCP servers advertised in session/new's `mcpServers` field (issue #25).
   * Each entry is sent with `type: "stdio"`; the driver injects the
   * session's space id as `BOTTEGA_SPACE_ID` per session and absolutizes
   * relative `BOTTEGA_DB_PATH` / `BOTTEGA_CONFIG_DIR` values, because the
   * spawned MCP server process runs with the agent's session cwd.
   * Default: [] — omp crashes on a missing field (issue #18).
   */
  mcpServers?: AcpMcpServerEntry[];
  /**
   * Policy context for the `session/request_permission` seam (issue #26).
   * When set, inbound permission requests are evaluated against the shared
   * policy table with audit; when unset they answer method-not-found
   * (transport only — nothing can run).
   */
  policy?: AcpPolicyContext;
}

export function createAcpDriver(opts: AcpDriverOptions = {}): AgentDriver {
  const command = opts.command ?? "omp";
  const args = opts.args ?? ["acp"];
  const sessionTimeoutMs = opts.sessionTimeoutMs ?? 30_000;
  return {
    async createSession(options) {
      const { spaceId, transcriptDir, onOutput, cwd, allowTools, appendSystemPrompt, getPrincipal, getModelSettings } = options;
      // Honored-or-throws (issue #173): ACP v1 has no tool-restriction
      // field — the agent's own config governs its surface — so an
      // allowTools request that NARROWS the space-agent allowlist cannot be
      // honored and is loudly rejected instead of silently handing out the
      // full toolset (the #154 fail-open: allowTools: [] meant "zero tools"
      // but ran everything). The SpaceService default (the full space-agent
      // allowlist, possibly persona-widened) requests no narrowing and
      // passes through.
      if (allowTools !== undefined && SPACE_AGENT_TOOLS.some((tool) => !allowTools.includes(tool))) {
        throw new Error(
          `acp driver: unsupported option 'allowTools' — ACP v1 cannot restrict the agent's tool surface below ` +
            `the space-agent allowlist (requested [${allowTools.join(", ")}]); remove the restriction or use the OMP SDK driver`,
        );
      }
      // Per-space model settings (issue #64) are meaningless here: ACP
      // sessions cannot switch models mid-session (setModelRole reports
      // not-supported). Reject loudly rather than drop the option.
      if (getModelSettings !== undefined) {
        throw new Error(
          "acp driver: unsupported option 'getModelSettings' — ACP sessions cannot switch models mid-session " +
            "(the agent's own config governs there); remove the option or use the OMP SDK driver",
        );
      }
      // Transcript parity (issue #173): materialize the durable space
      // timeline at the same session-file path the OMP driver uses, so the
      // transcript contract is driver-independent.
      const sessionCwd = cwd ?? process.cwd();
      mkdirSync(transcriptDir, { recursive: true });
      const sessionManager = SessionManager.create(sessionCwd, transcriptDir);
      await sessionManager.setSessionFile(sessionFilePath(transcriptDir, spaceId));
      const session = new AcpSessionDriver({
        spaceId,
        command,
        args,
        sessionTimeoutMs,
        onOutput,
        mcpServers: opts.mcpServers,
        policy: opts.policy,
        cwd: sessionCwd,
        // The request-only directive (issue #55): ACP v1 has no
        // system-prompt transport field, so the directive rides the first
        // prompt's text — the only channel that reaches the agent's
        // context (honored-or-throws, #173).
        appendSystemPrompt,
        // The space's current principal (issue #42): ACP reaches memory
        // through the MCP tools, so the option feeds the permission-gate
        // actor instead of memory injection — consumed, never silently
        // dropped (#173).
        getPrincipal,
      });
      await session.start();
      return session;
    },
  };
}

const PROTOCOL_VERSION = 1;
const METHOD_NOT_FOUND = -32601;
const DISPOSE_CLOSE_TIMEOUT_MS = 2_000;

/**
 * ACP's stdio MCP server shape takes env as name/value pairs, and the
 * spawned MCP server process runs with the *agent session's* cwd — not
 * bottega's. Path env vars the MCP server consumes are therefore
 * absolutized here so a relative BOTTEGA_DB_PATH cannot silently resolve
 * against the wrong directory.
 */
function toEnvPairs(env: Record<string, string>): Array<{ name: string; value: string }> {
  const absolutize: Record<string, string> = {};
  for (const key of ["BOTTEGA_DB_PATH", "BOTTEGA_CONFIG_DIR", "BOTTEGA_EXTENSIONS_DIR"]) {
    const value = env[key];
    if (value && !isAbsolute(value)) absolutize[key] = resolve(process.cwd(), value);
  }
  return Object.entries({ ...env, ...absolutize }).map(([name, value]) => ({ name, value }));
}

/** JSON values: the domain type of everything that crosses the JSON-RPC wire. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Recursive JSON-value schema (validates wire payloads at the JSON-RPC boundary). */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** A JSON-RPC 2.0 request/notification/response id (the driver sends numeric ids). */
type JsonRpcId = number | string | null;

/**
 * The ACP v1 toolCall carried by session/request_permission (issue #26),
 * decoded at the JSON-RPC boundary. `rawInput` keeps the shape the ACP
 * client sends: the xdev path for MCP calls plus the JSON-text `content`.
 */
const acpToolCallSchema = z.object({
  kind: z.string().optional(),
  rawInput: z
    .object({
      path: z.string().optional(),
      content: z.string().optional(),
    })
    .passthrough()
    .optional(),
});
type AcpToolCall = z.infer<typeof acpToolCallSchema>;

/** A permission-response option the agent offered (unknown extra fields kept). */
const permissionOptionSchema = z.object({ optionId: z.string().optional() }).passthrough();
type AcpPermissionOption = z.infer<typeof permissionOptionSchema>;

/** The session/request_permission params: the toolCall being gated + offered options. */
const permissionRequestSchema = z.object({
  toolCall: acpToolCallSchema.optional(),
  options: z.array(permissionOptionSchema).optional(),
});
type PermissionRequestParams = z.infer<typeof permissionRequestSchema>;

/** JSON-RPC 2.0 envelope decoded at the stdio boundary (loose: unknown extra fields ignored). */
const jsonRpcMessageSchema = z.object({
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  method: z.string().optional(),
  result: jsonValueSchema.optional(),
  error: z.object({ message: z.string().optional() }).optional(),
  params: jsonValueSchema.optional(),
});
type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>;

/** initialize result: the agent's supported protocol version (extra fields ignored). */
const initializeResultSchema = z.object({ protocolVersion: z.number().optional() }).passthrough();

/** session/new result: the session id the agent allocated (extra fields ignored). */
const sessionNewResultSchema = z.object({ sessionId: z.string().optional() }).passthrough();

/** session/update params (agent_message_chunk notifications), decoded at the boundary. */
const sessionUpdateSchema = z.object({
  update: z.object({
    sessionUpdate: z.string(),
    messageId: z.string().optional(),
    content: z.object({ type: z.string(), text: z.string() }).optional(),
  }),
});
type SessionUpdateParams = z.infer<typeof sessionUpdateSchema>;

/**
 * Maps an ACP toolCall to the policy table's tool names. MCP tools surface
 * as xdev paths (`xd://mcp__<server>_<tool>` with dots underscore-encoded,
 * e.g. `xd://mcp__bottega_memory_save` → `memory.save`); built-in calls
 * carry only a ToolKind (read/search/fetch/edit/execute/...), so each kind
 * maps to the bottega tool that best matches its capability tier — a
 * documented approximation of the OMP path's exact tool names, because ACP
 * gives allow/deny only (issue #26). Unmappable kinds return null and the
 * caller's raw kind name reaches the table, which denies it (fail closed).
 */
function toolNameFromAcpToolCall(toolCall: AcpToolCall | null | undefined): string | null {
  const path = toolCall?.rawInput?.path;
  if (path !== undefined && path.startsWith("xd://mcp__")) {
    const rest = path.slice("xd://mcp__".length);
    const sep = rest.indexOf("_");
    return sep > 0 ? rest.slice(sep + 1).replaceAll("_", ".") : null;
  }
  switch (toolCall?.kind) {
    case "read":
      return "read";
    case "search":
      return "grep"; // read-tier search representative (grep/glob/ast_grep)
    case "fetch":
      return "web_search";
    case "edit":
    case "delete":
    case "move": // write-tier file mutations share the edit policy name
      return "edit";
    case "execute":
      return "bash";
    default:
      return null; // think/other/unknown → deny
  }
}

/** Args for the audit row: the rawInput, or the parsed MCP `content` JSON. */
function acpToolCallArgs(toolCall: AcpToolCall | null | undefined): JsonValue | undefined {
  const content = toolCall?.rawInput?.content;
  if (content !== undefined) {
    try {
      return JSON.parse(content);
    } catch {
      // Not JSON; fall through to the raw shape.
    }
  }
  return toolCall?.rawInput === undefined ? undefined : JSON.parse(JSON.stringify(toolCall.rawInput));
}

/**
 * The optionId to answer with: prefer the agent-offered allow_once /
 * reject_once, else the first allow-kind/reject-kind option, else the
 * literal id (a conforming client should pick an offered option; the
 * fallback keeps the response valid for peers that send none).
 */
function pickPermissionOptionId(options: AcpPermissionOption[] | undefined, allow: boolean): string {
  const wanted = allow ? "allow_once" : "reject_once";
  const kindPrefix = allow ? "allow" : "reject";
  if (options !== undefined) {
    for (const option of options) {
      if (option.optionId === wanted) return option.optionId;
    }
    for (const option of options) {
      if (option.optionId !== undefined && option.optionId.startsWith(kindPrefix)) return option.optionId;
    }
  }
  return wanted;
}
interface PendingRequest {
  method: string;
  resolve: (result: JsonValue | undefined) => void;
  reject: (err: Error) => void;
}

/** Event payloads this driver emits: message text, turn bounds, and errors. */
type AcpDriverEventData =
  | { spaceId: string; text: string }
  | { spaceId: string }
  | { spaceId: string; message: string };

class AcpSessionDriver implements AgentSessionDriver {
  readonly #spaceId: string;
  readonly #command: string;
  readonly #args: string[];
  readonly #sessionTimeoutMs: number;
  readonly #onOutput: (spaceId: string, text: string) => void;
  readonly #emitter = createEmitter<DriverEvent>();
  /** Policy context for session/request_permission; null = transport-only. */
  readonly #policy: AcpPolicyContext | null;
  /** Session working directory sent in session/new (issue #173: honored, never dropped). */
  readonly #cwd: string;
  /**
   * The request-only directive (issue #55): prepended to the FIRST prompt's
   * text — ACP v1 has no system-prompt transport field (honored-or-throws,
   * #173). Absent → prompts pass through unchanged.
   */
  readonly #appendSystemPrompt: string | undefined;
  /**
   * The space's current principal (issue #42): consumed as the
   * permission-gate actor fallback — ACP reaches memory through the MCP
   * tools, so the option feeds policy context instead (honored-or-throws,
   * #173).
   */
  readonly #getPrincipal: (() => string | undefined) | undefined;
  /** ACP-shaped mcpServers entries (session/new payload), space id injected. */
  readonly #mcpServers: Array<{
    name: string;
    type: "stdio";
    command: string;
    args?: string[];
    env: Array<{ name: string; value: string }>;
  }>;

  #child: ChildProcess | null = null;
  #sessionId: string | null = null;
  #nextId = 0;
  #pending = new Map<number, PendingRequest>();
  #streaming = false;
  #dead = false;
  #disposed = false;
  /** The first prompt has not been sent yet (appendSystemPrompt rides it). */
  #firstPrompt = true;
  /** When a turn runs with silent: true, output is captured but not delivered. */
  #silentTurn = false;
  /** Messages prompted while a turn was in flight; sent when the turn completes. */
  #queuedPrompts: Array<{ text: string; principal?: string; silent?: boolean }> = [];
  /**
   * The principal of the CURRENT turn (issue #152): bound when a turn's
   * prompt is sent, cleared when the turn completes. ACP serializes turns
   * (messages during a turn queue), so each prompt is its own turn and
   * binds its own inbound principal.
   */
  #turnPrincipal: string | undefined;
  /** Accumulated agent text per messageId (chunks sharing a messageId join up). */
  #buffers = new Map<string, string>();
  #currentMessageId: string | null = null;
  /** The current turn already delivered a visible message (issue #226). */
  #turnDelivered = false;
  /** An error event already surfaced this turn (issue #226: the retry note must not overwrite it). */
  #turnErrored = false;

  constructor(deps: {
    spaceId: string;
    command: string;
    args: string[];
    sessionTimeoutMs: number;
    onOutput: (spaceId: string, text: string) => void;
    mcpServers?: AcpMcpServerEntry[];
    policy?: AcpPolicyContext;
    cwd?: string;
    appendSystemPrompt?: string;
    getPrincipal?: () => string | undefined;
  }) {
    this.#spaceId = deps.spaceId;
    this.#command = deps.command;
    this.#args = deps.args;
    this.#sessionTimeoutMs = deps.sessionTimeoutMs;
    this.#onOutput = deps.onOutput;
    this.#policy = deps.policy ?? null;
    this.#cwd = deps.cwd ?? process.cwd();
    this.#appendSystemPrompt = deps.appendSystemPrompt;
    this.#getPrincipal = deps.getPrincipal;
    // The MCP server process is spawned by the agent with the session cwd,
    // so the space id is injected per session and path env vars are
    // absolutized here (see toEnvPairs).
    this.#mcpServers = (deps.mcpServers ?? []).map((s) => {
      const env = toEnvPairs({ ...s.env, BOTTEGA_SPACE_ID: deps.spaceId });
      return {
        name: s.name,
        type: "stdio" as const,
        command: s.command,
        env,
        ...(s.args !== undefined ? { args: s.args } : undefined),
      };
    });
  }

  /** Spawn the agent child and complete the initialize + session/new handshake. */
  async start(): Promise<void> {
    const child = spawn(this.#command, this.#args, { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    child.on("error", (err) => this.#onChildError(err));
    child.on("exit", (code, signal) => this.#onChildExit(code, signal));
    child.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[acp-driver] agent stderr (${this.#spaceId}): ${chunk.toString().trimEnd()}`);
    });
    const rl = createInterface({ input: child.stdout ?? undefined });
    rl.on("line", (line) => this.#onLine(line));
    rl.on("error", () => {}); // stdout stream closed on child exit; handled by #onChildExit

    try {
      const init = initializeResultSchema.safeParse(
        await this.#request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "bottega", version: "0.1.0" },
        }),
      ).data;
      if (init?.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`unsupported ACP protocol version: ${String(init?.protocolVersion)}`);
      }
      // ACP v1 session/new takes { cwd, mcpServers } — a list of MCP servers
      // for the agent to connect. omp's handler iterates mcpServers
      // unconditionally: when the field is absent it crashes with
      // -32603 "undefined is not an object (evaluating 'n.length')" and may
      // never respond, so always send an explicit empty list (issue #17/#18).
      // The caller's cwd is honored (issue #173): previously the driver
      // hardcoded process.cwd() and silently dropped the option.
      const created = await this.#request("session/new", { cwd: this.#cwd, mcpServers: this.#mcpServers });
      const sessionId = sessionNewResultSchema.safeParse(created).data?.sessionId;
      if (sessionId === undefined || sessionId === "") {
        throw new Error("ACP agent returned no sessionId from session/new");
      }
      this.#sessionId = sessionId;
    } catch (err) {
      this.#killChild();
      throw err;
    }
  }

  async prompt(text: string, opts?: AgentTurnOptions): Promise<void> {
    if (this.#dead || this.#disposed) {
      throw new Error("acp agent process is not running");
    }
    if (this.#streaming) {
      // ACP v1 has no steer primitive; any streamingBehavior (steer/followUp)
      // queues the message and sends it once the in-flight turn completes.
      // Each queued message becomes its OWN turn, so its principal (and
      // silent flag) queue alongside it (issues #152/#173).
      this.#queuedPrompts.push({ text, principal: opts?.principal, silent: opts?.silent });
      return;
    }
    await this.#sendPrompt(text, opts?.principal, opts?.silent);
    while (this.#queuedPrompts.length > 0) {
      const next = this.#queuedPrompts.shift()!;
      await this.#sendPrompt(next.text, next.principal, next.silent);
    }
  }

  /** The principal of the current turn (issue #152); undefined between turns. */
  getTurnPrincipal(): string | undefined {
    return this.#turnPrincipal;
  }

  /**
   * The session's live todo plan (issue #228): ACP v1 has no todo
   * transport, so the plan is always empty — no active plan is normal,
   * never an error (the interface contract).
   */
  getTodoPhases(): TodoPhase[] {
    return [];
  }

  async abort(): Promise<void> {
    if (this.#dead || this.#disposed || !this.#streaming) return;
    this.#write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.#sessionId } });
  }

  isStreaming(): boolean {
    return this.#streaming && !this.#dead && !this.#disposed;
  }

  on(event: DriverEvent, cb: (data: AcpDriverEventData) => void): () => void {
    return this.#emitter.on(event, cb);
  }

  /**
   * Documented not-supported (issue #64): ACP v1 has no per-session model
   * switch message, and the spawned agent's own config governs its model.
   * Returns a clear result so the `use_model` tool can surface it instead of
   * pretending the switch happened.
   */
  async setModelRole(role: ModelRole): Promise<ModelRoleSwitchResult> {
    return {
      applied: false,
      role,
      model: null,
      thinking_level: null,
      reason: "ACP sessions cannot switch models mid-session: the agent's own config governs there",
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    // Politely close the ACP session; the kill below is authoritative either way.
    if (this.#child && !this.#dead && this.#sessionId) {
      try {
        await this.#request("session/close", { sessionId: this.#sessionId }, DISPOSE_CLOSE_TIMEOUT_MS);
      } catch {
        // Agent may refuse or already be gone — termination still proceeds.
      }
    }
    this.#disposed = true;
    this.#failPending(new Error("acp session disposed"));
    this.#killChild();
  }

  #sendPrompt(text: string, principal?: string, silent?: boolean): Promise<void> {
    this.#streaming = true;
    // Each ACP prompt is its own turn: bind the inbound principal with it
    // and drop the binding when the turn completes (issue #152).
    this.#turnPrincipal = principal;
    this.#silentTurn = silent ?? false;
    this.#turnDelivered = false;
    this.#turnErrored = false;
    this.#emitter.emit("turn_start", { spaceId: this.#spaceId });
    // appendSystemPrompt (issue #55/#173): ACP v1 has no system-prompt
    // transport field, so the directive rides the FIRST prompt's text —
    // the only channel that reaches the agent's context. Later prompts of
    // the session pass through unchanged (cold-start semantics, like OMP).
    const promptText = this.#firstPrompt && this.#appendSystemPrompt ? `${this.#appendSystemPrompt}\n\n${text}` : text;
    this.#firstPrompt = false;
    return this.#request("session/prompt", {
      sessionId: this.#sessionId,
      prompt: [{ type: "text", text: promptText }],
    })
      .then(() => undefined)
      .finally(() => {
        this.#streaming = false;
        this.#turnPrincipal = undefined;
        // Deliver the buffered message BEFORE clearing the silent flag so a
        // silent turn never reaches the space surface (issue #173).
        this.#flushBufferedMessage();
        if (!this.#turnDelivered && !this.#turnErrored) {
          // Issue #226: an empty completion must never be a silent no-reply —
          // the presenter surfaces the visible retry note for this event.
          // Skipped when an error event already surfaced the turn (e.g. the
          // child died): the retry note must not overwrite the error text.
          this.#emitter.emit("message", { spaceId: this.#spaceId, text: "" });
        }
        this.#silentTurn = false;
        this.#emitter.emit("turn_end", { spaceId: this.#spaceId });
      });
  }

  // --- child lifecycle ------------------------------------------------------

  #onChildError(err: Error): void {
    this.#failChild(new Error(`acp agent process failed to start: ${err.message}`));
  }

  #onChildExit(code: number | null, signal: string | null): void {
    if (this.#disposed) return;
    const detail = signal ? `signal=${signal}` : `code=${code}`;
    this.#failChild(new Error(`acp agent process exited (${detail})`));
  }

  /** Mark the child dead, surface an error event, and settle every in-flight request. */
  #failChild(err: Error): void {
    this.#dead = true;
    // The error event IS the visible surface for this turn; the empty
    // completion must not overwrite it with the generic retry note (#226).
    this.#turnErrored = true;
    this.#emitter.emit("error", { spaceId: this.#spaceId, message: err.message });
    this.#failPending(err);
  }

  #failPending(err: Error): void {
    for (const pending of this.#pending.values()) pending.reject(err);
    this.#pending.clear();
  }

  #killChild(): void {
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    try {
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      // Escalate if the agent does not die promptly.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 500).unref?.();
    } catch {
      // Already gone.
    }
  }

  // --- JSON-RPC -------------------------------------------------------------

  #request(method: string, params: JsonValue, timeoutMs = this.#sessionTimeoutMs): Promise<JsonValue | undefined> {
    if (this.#dead || this.#disposed || !this.#child) {
      return Promise.reject(new Error("acp agent process is not running"));
    }
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<JsonValue | undefined>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`ACP request timed out: ${method}`));
    }, timeoutMs);
    timer.unref?.();
    this.#pending.set(id, {
      method,
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    this.#write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  #write(msg: JsonValue): void {
    if (!this.#child || this.#dead) return;
    this.#child.stdin?.write(JSON.stringify(msg) + "\n");
  }

  #onLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = jsonRpcMessageSchema.parse(JSON.parse(line));
    } catch {
      console.error(`[acp-driver] ignoring non-JSON agent output: ${line}`);
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      this.#onInboundRequest({ id: msg.id, method: msg.method, params: msg.params });
    } else if (msg.method !== undefined) {
      this.#onInboundNotification({ method: msg.method, params: msg.params });
    } else if (msg.id !== undefined) {
      this.#onResponse({ id: msg.id, result: msg.result, error: msg.error });
    } else {
      console.error(`[acp-driver] ignoring malformed agent message: ${line}`);
    }
  }

  /** Requests the agent sends to us (permission, fs, terminal, elicitation, ...). */
  #onInboundRequest(msg: { id: JsonRpcId; method: string; params?: JsonValue }): void {
    if (msg.method === "session/request_permission" && this.#policy) {
      const parsed = permissionRequestSchema.safeParse(msg.params);
      const params = parsed.success ? parsed.data : undefined;
      // Fire and forget: the resolution writes the JSON-RPC response.
      void this.#resolvePermissionRequest(msg.id, params).catch((err) => {
        // Fail closed: an internal gate error denies the call.
        console.error(`[acp-driver] permission gate error (${this.#spaceId}), denying:`, err);
        this.#answerPermission(msg.id, false, params);
      });
      return;
    }
    // Transport only (no policy context for permission requests): v1 answers
    // method-not-found until policy routing (#6) wires these — nothing can run.
    console.error(`[acp-driver] unsupported method from agent (${this.#spaceId}): ${msg.method}`);
    this.#write({ jsonrpc: "2.0", id: msg.id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${msg.method}` } });
  }

  // --- session/request_permission (issue #26) ------------------------------

  /** Evaluate one permission request against the shared policy gate and answer. */
  async #resolvePermissionRequest(id: JsonRpcId, params: PermissionRequestParams | undefined): Promise<void> {
    const policy = this.#policy!;
    const toolCall = params?.toolCall ?? null;
    const tool = toolNameFromAcpToolCall(toolCall);
    const outcome = await evaluatePolicyGate(
      {
        loadPolicy: policy.loadPolicy ?? (async () => policy.orgPolicy),
        audit: policy.audit,
        router: policy.router,
        timeoutMs: policy.timeoutMs,
      },
      {
        tool: tool ?? String(params?.toolCall?.kind ?? "unknown"),
        args: acpToolCallArgs(toolCall),
        spaceId: this.#spaceId,
        // The per-turn principal (#152) wins; the createSession getPrincipal
        // option (#42) is the space-level fallback — consumed, never
        // silently dropped (#173). policy.actor stays the final override.
        actor: this.#turnPrincipal ?? this.#getPrincipal?.() ?? policy.actor ?? "agent",
      },
    );
    this.#answerPermission(id, outcome.allowed, params);
  }

  /**
   * ACP's permission response: `outcome: { outcome: "selected", optionId }`
   * (agentclientprotocol.com/protocol/v1 tool-calls, "Requesting Permission").
   * The optionId is one the agent offered (allow_once/reject_once preferred,
   * else the first allow-kind/reject-kind option), falling back to the
   * literal ids so a peer that omits options still gets a valid response.
   */
  #answerPermission(id: JsonRpcId, allow: boolean, params: PermissionRequestParams | undefined): void {
    const optionId = pickPermissionOptionId(params?.options, allow);
    this.#write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId } } });
  }

  #onInboundNotification(msg: { method: string; params?: JsonValue }): void {
    if (msg.method === "session/update") {
      const parsed = sessionUpdateSchema.safeParse(msg.params);
      this.#onUpdate(parsed.success ? parsed.data : undefined);
      return;
    }
    console.error(`[acp-driver] ignoring unknown notification from agent (${this.#spaceId}): ${msg.method}`);
  }

  #onResponse(msg: { id: JsonRpcId; result?: JsonValue; error?: { message?: string } }): void {
    // SAFETY: the driver sends only numeric request ids, so a response id is always one of ours.
    const id = msg.id as number;
    const pending = this.#pending.get(id);
    if (!pending) {
      console.error(`[acp-driver] unexpected response for id ${String(msg.id)}`);
      return;
    }
    this.#pending.delete(id);
    if (msg.error !== undefined) {
      pending.reject(new Error(`ACP ${pending.method} failed: ${msg.error.message ?? String(msg.error)}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  // --- session/update -------------------------------------------------------

  #onUpdate(params: SessionUpdateParams | undefined): void {
    const u = params?.update;
    if (u === undefined || u.sessionUpdate !== "agent_message_chunk") return; // plan/tool_call/usage_update/... tolerated
    const content = u.content;
    if (content === undefined || content.type !== "text") return;
    const messageId = u.messageId ?? "";
    // A changed messageId starts a new message: deliver the previous one.
    if (this.#currentMessageId !== null && messageId !== this.#currentMessageId) {
      this.#flushMessage(this.#currentMessageId);
    }
    this.#currentMessageId = messageId;
    this.#buffers.set(messageId, (this.#buffers.get(messageId) ?? "") + content.text);
  }

  /** Deliver the accumulated text of one agent message (onOutput + "message" event). */
  #flushMessage(messageId: string): void {
    const text = this.#buffers.get(messageId);
    this.#buffers.delete(messageId);
    if (text) this.#deliver(text);
  }

  /** Deliver whatever is still buffered when a turn ends (incl. cancelled/crashed turns). */
  #flushBufferedMessage(): void {
    if (this.#currentMessageId !== null) {
      this.#flushMessage(this.#currentMessageId);
      this.#currentMessageId = null;
    }
  }

  #deliver(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // A real message means the turn produced output: the empty-completion
    // fallback at turn end must not fire (issue #226).
    this.#turnDelivered = true;
    // Silent turns (digest, #42) skip the output callback but still emit,
    // so the caller can capture the text without posting it to the space
    // (issue #173: honored, matching the OMP driver).
    if (!this.#silentTurn) this.#onOutput(this.#spaceId, trimmed);
    this.#emitter.emit("message", { spaceId: this.#spaceId, text: trimmed });
  }
}
