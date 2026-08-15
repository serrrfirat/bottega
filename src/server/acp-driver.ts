import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AgentDriver, AgentSessionDriver, AgentTurnOptions } from "./agent-driver";

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
 * Permission requests and other client-gated inbound methods (fs/*,
 * terminal/*, elicitation/*) are answered with JSON-RPC method-not-found —
 * transport only; policy routing is issue #6.
 */
export interface AcpDriverOptions {
  /** ACP server executable. Default "omp". */
  command?: string;
  /** Arguments for the ACP server. Default ["acp"]. */
  args?: string[];
  /** Milliseconds to wait for the initialize + session/new handshake. Default 30s. */
  sessionTimeoutMs?: number;
}

export function createAcpDriver(opts: AcpDriverOptions = {}): AgentDriver {
  const command = opts.command ?? "omp";
  const args = opts.args ?? ["acp"];
  const sessionTimeoutMs = opts.sessionTimeoutMs ?? 30_000;
  return {
    async createSession({ spaceId, transcriptDir, onOutput }) {
      mkdirSync(transcriptDir, { recursive: true });
      const session = new AcpSessionDriver({ spaceId, command, args, sessionTimeoutMs, onOutput });
      await session.start();
      return session;
    },
  };
}

const PROTOCOL_VERSION = 1;
const METHOD_NOT_FOUND = -32601;
const DISPOSE_CLOSE_TIMEOUT_MS = 2_000;

type DriverEvent = "message" | "turn_start" | "turn_end" | "error";

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
  readonly #listeners = new Map<DriverEvent, Set<(data: unknown) => void>>();

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
  }) {
    this.#spaceId = deps.spaceId;
    this.#command = deps.command;
    this.#args = deps.args;
    this.#sessionTimeoutMs = deps.sessionTimeoutMs;
    this.#onOutput = deps.onOutput;
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
      const created = await this.#request("session/new", { cwd: process.cwd() });
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
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(cb);
    return () => set.delete(cb);
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
    this.#emit("turn_start", { spaceId: this.#spaceId });
    return this.#request("session/prompt", {
      sessionId: this.#sessionId,
      prompt: [{ type: "text", text }],
    })
      .then(() => undefined)
      .finally(() => {
        this.#streaming = false;
        this.#flushBufferedMessage();
        this.#emit("turn_end", { spaceId: this.#spaceId });
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
    this.#emit("error", { spaceId: this.#spaceId, message: err.message });
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
    // Transport only: v1 answers method-not-found until policy routing (#6) wires these.
    console.error(`[acp-driver] unsupported method from agent (${this.#spaceId}): ${msg.method}`);
    this.#write({ jsonrpc: "2.0", id: msg.id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${msg.method}` } });
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
    this.#emit("message", { spaceId: this.#spaceId, text: trimmed });
  }

  #emit(event: DriverEvent, data: unknown): void {
    for (const cb of this.#listeners.get(event) ?? []) cb(data);
  }
}
