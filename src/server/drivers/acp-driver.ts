import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { AuditModule } from "../../policy/audit";
import type { ApprovalRouter } from "../../policy/approval-router";
import { evaluatePolicyGate } from "../../policy/gate";
import type { PolicyConfig } from "../../policy/config";
import { createEmitter, type AgentDriver, type AgentSessionDriver, type AgentTurnOptions, type DriverEvent } from "./agent-driver";

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
    async createSession({ spaceId, transcriptDir, onOutput }) {
      // appendSystemPrompt (issue #55) has no ACP v1 transport field yet —
      // the OMP driver is the shipped engine and carries the directive.
      mkdirSync(transcriptDir, { recursive: true });
      const session = new AcpSessionDriver({ spaceId, command, args, sessionTimeoutMs, onOutput, mcpServers: opts.mcpServers, policy: opts.policy });
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

/** The ACP v1 toolCall carried by session/request_permission (issue #26). */
interface AcpToolCall {
  kind?: unknown;
  rawInput?: unknown;
}

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
  const rawInput = toolCall?.rawInput;
  const path = typeof rawInput === "object" && rawInput !== null ? (rawInput as Record<string, unknown>).path : undefined;
  if (typeof path === "string" && path.startsWith("xd://mcp__")) {
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
function acpToolCallArgs(toolCall: AcpToolCall | null | undefined): unknown {
  const rawInput = toolCall?.rawInput;
  if (typeof rawInput === "object" && rawInput !== null) {
    const content = (rawInput as Record<string, unknown>).content;
    if (typeof content === "string") {
      try {
        return JSON.parse(content);
      } catch {
        // Not JSON; fall through to the raw shape.
      }
    }
  }
  return rawInput;
}

/**
 * The optionId to answer with: prefer the agent-offered allow_once /
 * reject_once, else the first allow-kind/reject-kind option, else the
 * literal id (a conforming client should pick an offered option; the
 * fallback keeps the response valid for peers that send none).
 */
function pickPermissionOptionId(options: unknown, allow: boolean): string {
  const wanted = allow ? "allow_once" : "reject_once";
  const kindPrefix = allow ? "allow" : "reject";
  if (Array.isArray(options)) {
    for (const option of options) {
      const id = (option as { optionId?: unknown } | null)?.optionId;
      if (id === wanted) return String(id);
    }
    for (const option of options) {
      const id = (option as { optionId?: unknown } | null)?.optionId;
      if (typeof id === "string" && id.startsWith(kindPrefix)) return id;
    }
  }
  return wanted;
}
interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

class AcpSessionDriver implements AgentSessionDriver {
  readonly #spaceId: string;
  readonly #command: string;
  readonly #args: string[];
  readonly #sessionTimeoutMs: number;
  readonly #onOutput: (spaceId: string, text: string) => void;
  readonly #emitter = createEmitter<DriverEvent>();
  /** Policy context for session/request_permission; null = transport-only. */
  readonly #policy: AcpPolicyContext | null;
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
  /** Messages prompted while a turn was in flight; sent when the turn completes. */
  #queuedPrompts: string[] = [];
  /** Accumulated agent text per messageId (chunks sharing a messageId join up). */
  #buffers = new Map<string, string>();
  #currentMessageId: string | null = null;

  constructor(deps: {
    spaceId: string;
    command: string;
    args: string[];
    sessionTimeoutMs: number;
    onOutput: (spaceId: string, text: string) => void;
    mcpServers?: AcpMcpServerEntry[];
    policy?: AcpPolicyContext;
  }) {
    this.#spaceId = deps.spaceId;
    this.#command = deps.command;
    this.#args = deps.args;
    this.#sessionTimeoutMs = deps.sessionTimeoutMs;
    this.#onOutput = deps.onOutput;
    this.#policy = deps.policy ?? null;
    // The MCP server process is spawned by the agent with the session cwd,
    // so the space id is injected per session and path env vars are
    // absolutized here (see toEnvPairs).
    this.#mcpServers = (deps.mcpServers ?? []).map((s) => {
      const env = toEnvPairs({ ...s.env, BOTTEGA_SPACE_ID: deps.spaceId });
      const entry: { name: string; type: "stdio"; command: string; args?: string[]; env: typeof env } = {
        name: s.name,
        type: "stdio",
        command: s.command,
        env,
      };
      if (s.args) entry.args = s.args;
      return entry;
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
      const init = (await this.#request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "bottega", version: "0.1.0" },
      })) as { protocolVersion?: unknown } | null;
      if (init?.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`unsupported ACP protocol version: ${String(init?.protocolVersion)}`);
      }
      // ACP v1 session/new takes { cwd, mcpServers } — a list of MCP servers
      // for the agent to connect. omp's handler iterates mcpServers
      // unconditionally: when the field is absent it crashes with
      // -32603 "undefined is not an object (evaluating 'n.length')" and may
      // never respond, so always send an explicit empty list (issue #17/#18).
      const created = await this.#request("session/new", { cwd: process.cwd(), mcpServers: this.#mcpServers });
      const sessionId = (created as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("ACP agent returned no sessionId from session/new");
      }
      this.#sessionId = sessionId;
    } catch (err) {
      this.#killChild();
      throw err;
    }
  }

  async prompt(text: string, _opts?: AgentTurnOptions): Promise<void> {
    if (this.#dead || this.#disposed) {
      throw new Error("acp agent process is not running");
    }
    if (this.#streaming) {
      // ACP v1 has no steer primitive; any streamingBehavior (steer/followUp)
      // queues the message and sends it once the in-flight turn completes.
      this.#queuedPrompts.push(text);
      return;
    }
    await this.#sendPrompt(text);
    while (this.#queuedPrompts.length > 0) {
      await this.#sendPrompt(this.#queuedPrompts.shift()!);
    }
  }

  async abort(): Promise<void> {
    if (this.#dead || this.#disposed || !this.#streaming) return;
    this.#write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.#sessionId } });
  }

  isStreaming(): boolean {
    return this.#streaming && !this.#dead && !this.#disposed;
  }

  on(event: DriverEvent, cb: (data: unknown) => void): () => void {
    return this.#emitter.on(event, cb);
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

  #sendPrompt(text: string): Promise<void> {
    this.#streaming = true;
    this.#emitter.emit("turn_start", { spaceId: this.#spaceId });
    return this.#request("session/prompt", {
      sessionId: this.#sessionId,
      prompt: [{ type: "text", text }],
    })
      .then(() => undefined)
      .finally(() => {
        this.#streaming = false;
        this.#flushBufferedMessage();
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

  #request(method: string, params: unknown, timeoutMs = this.#sessionTimeoutMs): Promise<unknown> {
    if (this.#dead || this.#disposed || !this.#child) {
      return Promise.reject(new Error("acp agent process is not running"));
    }
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
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

  #write(msg: unknown): void {
    if (!this.#child || this.#dead) return;
    this.#child.stdin?.write(JSON.stringify(msg) + "\n");
  }

  #onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`[acp-driver] ignoring non-JSON agent output: ${line}`);
      return;
    }
    const obj = msg as { id?: unknown; method?: unknown; result?: unknown; error?: unknown; params?: unknown };
    if (typeof obj.method === "string" && obj.id !== undefined) {
      this.#onInboundRequest(obj as { id: unknown; method: string; params?: unknown });
    } else if (typeof obj.method === "string") {
      this.#onInboundNotification(obj as { method: string; params?: unknown });
    } else if (obj.id !== undefined) {
      this.#onResponse(obj as { id: unknown; result?: unknown; error?: { message?: unknown } });
    } else {
      console.error(`[acp-driver] ignoring malformed agent message: ${line}`);
    }
  }

  /** Requests the agent sends to us (permission, fs, terminal, elicitation, ...). */
  #onInboundRequest(msg: { id: unknown; method: string; params?: unknown }): void {
    if (msg.method === "session/request_permission" && this.#policy) {
      // Fire and forget: the resolution writes the JSON-RPC response.
      void this.#resolvePermissionRequest(msg.id, msg.params).catch((err) => {
        // Fail closed: an internal gate error denies the call.
        console.error(`[acp-driver] permission gate error (${this.#spaceId}), denying:`, err);
        this.#answerPermission(msg.id, false, msg.params);
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
  async #resolvePermissionRequest(id: unknown, params: unknown): Promise<void> {
    const policy = this.#policy!;
    const toolCall = (params as { toolCall?: unknown } | null)?.toolCall as AcpToolCall | null | undefined;
    const tool = toolNameFromAcpToolCall(toolCall);
    const outcome = await evaluatePolicyGate(
      {
        loadPolicy: policy.loadPolicy ?? (async () => policy.orgPolicy),
        audit: policy.audit,
        router: policy.router,
        timeoutMs: policy.timeoutMs,
      },
      {
        tool: tool ?? String((toolCall as { kind?: unknown } | null)?.kind ?? "unknown"),
        args: acpToolCallArgs(toolCall),
        spaceId: this.#spaceId,
        actor: policy.actor ?? "agent",
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
  #answerPermission(id: unknown, allow: boolean, params: unknown): void {
    const optionId = pickPermissionOptionId((params as { options?: unknown } | null)?.options, allow);
    this.#write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId } } });
  }

  #onInboundNotification(msg: { method: string; params?: unknown }): void {
    if (msg.method === "session/update") {
      this.#onUpdate(msg.params);
      return;
    }
    console.error(`[acp-driver] ignoring unknown notification from agent (${this.#spaceId}): ${msg.method}`);
  }

  #onResponse(msg: { id: unknown; result?: unknown; error?: { message?: unknown } }): void {
    const pending = this.#pending.get(msg.id as number);
    if (!pending) {
      console.error(`[acp-driver] unexpected response for id ${String(msg.id)}`);
      return;
    }
    this.#pending.delete(msg.id as number);
    if (msg.error !== undefined) {
      pending.reject(new Error(`ACP ${pending.method} failed: ${String((msg.error as { message?: unknown })?.message ?? msg.error)}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  // --- session/update -------------------------------------------------------

  #onUpdate(params: unknown): void {
    const update = (params as { update?: { sessionUpdate?: unknown } } | null)?.update;
    if (!update || typeof update !== "object") return;
    const u = update as { sessionUpdate?: unknown; messageId?: unknown; content?: { type?: unknown; text?: unknown } };
    if (u.sessionUpdate !== "agent_message_chunk") return; // plan/tool_call/usage_update/... tolerated
    const content = u.content;
    if (content?.type !== "text" || typeof content.text !== "string") return;
    const messageId = typeof u.messageId === "string" ? u.messageId : "";
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
    this.#onOutput(this.#spaceId, trimmed);
    this.#emitter.emit("message", { spaceId: this.#spaceId, text: trimmed });
  }
}
