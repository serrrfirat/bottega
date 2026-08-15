import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AgentRegistry,
  SessionManager,
  createAgentSession,
  type AgentSession,
  type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";

/**
 * Minimal agent-session abstraction. SpaceService depends only on this — the
 * concrete driver (OMP SDK today, ACP later) owns all session mechanics.
 */
export interface AgentTurnOptions {
  streamingBehavior?: "steer" | "followUp";
}

export interface AgentSessionDriver {
  prompt(text: string, opts?: AgentTurnOptions): Promise<void>;
  abort(): Promise<void>;
  isStreaming(): boolean;
  on(event: "message" | "turn_start" | "turn_end" | "error", cb: (data: unknown) => void): () => void;
  dispose(): Promise<void>;
}

export interface AgentDriver {
  createSession(opts: {
    spaceId: string;
    transcriptDir: string;
    onOutput: (spaceId: string, text: string) => void;
    /** Working directory for the session (e.g. a work-item workspace). Defaults to process.cwd(). */
    cwd?: string;
    /** Tool allowlist override; defaults to the space-agent allowlist. */
    allowTools?: readonly string[];
  }): Promise<AgentSessionDriver>;
}

/** Events the session drivers emit; both drivers share this vocabulary. */
export type DriverEvent = "message" | "turn_start" | "turn_end" | "error";

/**
 * The listener plumbing behind {@link AgentSessionDriver.on} (issue #33).
 * The OMP and ACP drivers share identical event semantics, so the emitter
 * lives here once: typed by event name, idempotent `on` (a listener
 * registers once), and unsubscribe-by-closure.
 */
export function createEmitter<Event extends string>() {
  const listeners = new Map<Event, Set<(data: unknown) => void>>();
  return {
    on(event: Event, cb: (data: unknown) => void): () => void {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    },
    emit(event: Event, data: unknown): void {
      for (const cb of listeners.get(event) ?? []) cb(data);
    },
  };
}

/** Transcript file for a space: `<transcriptDir>/<space-id>.jsonl` (`:` is legal in POSIX filenames). */
export function sessionFilePath(transcriptDir: string, spaceId: string): string {
  return join(transcriptDir, `${spaceId}.jsonl`);
}

/**
 * Inverse of {@link sessionFilePath}: the space id from a session file
 * path (the driver contract: `<transcriptDir>/<space-id>.jsonl`). Null or
 * non-`.jsonl` files yield undefined. This is the canonical derivation —
 * policy and tool extensions import it instead of re-deriving it.
 */
export function sessionIdFromFilePath(file: string | null | undefined): string | undefined {
  if (!file) return undefined;
  const base = basename(file);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

/**
 * Space agent tool allowlist: conversation/read-only tools + `task` for
 * delegating to work executors. Deliberately no bash/write/edit — the space
 * agent is a participant, not an executor. The work item queue tools
 * (issue #10) are listed so the agent can create and cancel work items, and
 * the memory tools (issue #22) so it can save and search memory.
 */
export const SPACE_AGENT_TOOLS = [
  "read",
  "glob",
  "grep",
  "ast_grep",
  "web_search",
  "inspect_image",
  "lsp",
  "task",
  "create_work_item",
  "work_item_cancel",
  "memory.save",
  "memory.search",
] as const;

/**
 * Driver backed by the OMP SDK (`createAgentSession`). Sessions are
 * file-backed (SessionManager under `transcriptDir`, one JSONL per space —
 * the durable space timeline), tool-restricted to the allowlist above, and
 * registered in a private AgentRegistry (SDK requirement for concurrent
 * top-level sessions). `extensions` is OMP-typed by design: the AgentDriver
 * abstraction stays engine-free, and OMP-specific options live on this
 * factory (policy + audit extensions plug in here, issues #6/#7).
 */
export function createOmpSdkDriver(opts: { agentDir?: string; extensions?: ExtensionFactory[] } = {}): AgentDriver {
  return {
    async createSession({ spaceId, transcriptDir, onOutput, cwd, allowTools }) {
      mkdirSync(transcriptDir, { recursive: true });
      const sessionCwd = cwd ?? process.cwd();
      const sessionManager = SessionManager.create(sessionCwd, transcriptDir);
      // Missing/empty files start fresh; existing files resume the space's
      // transcript (server restarts keep history intact).
      await sessionManager.setSessionFile(sessionFilePath(transcriptDir, spaceId));
      const { session } = await createAgentSession({
        cwd: sessionCwd,
        agentDir: opts.agentDir,
        sessionManager,
        agentRegistry: new AgentRegistry(),
        restrictToolNames: true,
        toolNames: allowTools ? [...allowTools] : [...SPACE_AGENT_TOOLS],
        // Extension seam: policy + audit extensions plug in here (#6/#7).
        extensions: opts.extensions ?? [],
      });
      return new OmpSessionDriver({ spaceId, session, onOutput });
    },
  };
}

class OmpSessionDriver implements AgentSessionDriver {
  readonly #spaceId: string;
  readonly #session: AgentSession;
  readonly #onOutput: (spaceId: string, text: string) => void;
  readonly #emitter = createEmitter<DriverEvent>();
  #textByIndex = new Map<number, string>();
  #unsubscribe: () => void;

  constructor(deps: {
    spaceId: string;
    session: AgentSession;
    onOutput: (spaceId: string, text: string) => void;
  }) {
    this.#spaceId = deps.spaceId;
    this.#session = deps.session;
    this.#onOutput = deps.onOutput;
    this.#unsubscribe = deps.session.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const { assistantMessageEvent: ae } = event;
          if (ae.type === "text_delta") {
            this.#textByIndex.set(ae.contentIndex, (this.#textByIndex.get(ae.contentIndex) ?? "") + ae.delta);
          } else if (ae.type === "text_end") {
            this.#textByIndex.set(ae.contentIndex, ae.content);
          }
          break;
        }
        case "message_end": {
          const text = [...this.#textByIndex.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, part]) => part)
            .join("\n")
            .trim();
          this.#textByIndex.clear();
          if (text) this.#deliver(text);
          break;
        }
        case "turn_start":
          this.#emitter.emit("turn_start", { spaceId: deps.spaceId });
          break;
        case "turn_end":
          this.#emitter.emit("turn_end", { spaceId: deps.spaceId });
          break;
        case "notice":
          if (event.level === "error") this.#emitter.emit("error", { spaceId: deps.spaceId, message: event.message });
          break;
        default:
          break;
      }
    });
  }

  /** Steers into the running turn, queues a follow-up, or starts a fresh turn. */
  async prompt(text: string, opts?: AgentTurnOptions): Promise<void> {
    if (this.#session.isStreaming) {
      if (opts?.streamingBehavior === "followUp") {
        await this.#session.followUp(text);
      } else {
        await this.#session.steer(text);
      }
    } else {
      await this.#session.prompt(text);
    }
  }

  async abort(): Promise<void> {
    await this.#session.abort();
  }

  isStreaming(): boolean {
    return this.#session.isStreaming;
  }

  on(event: DriverEvent, cb: (data: unknown) => void): () => void {
    return this.#emitter.on(event, cb);
  }

  async dispose(): Promise<void> {
    this.#unsubscribe();
    this.#session.beginDispose();
    await this.#session.dispose();
  }

  #deliver(text: string): void {
    // onOutput and the "message" event are the same signal: consume one channel.
    this.#onOutput(this.#spaceId, text);
    this.#emitter.emit("message", { spaceId: this.#spaceId, text });
  }
}
