import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AgentRegistry,
  SessionManager,
  createAgentSession,
  type AgentSession,
  type ExtensionFactory,
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import type { MemoryProvider } from "../../memory/types";
import { memoryContextExtension } from "../../tools/memory-context";
import {
  connectExtensionToolDefinition,
  connectViaAuthBroker,
  type BrokerConnector,
} from "../../extensions/connect";
import type { ExtensionRegistry } from "../../extensions/registry";
import type { AuditModule } from "../../policy/audit";
import type { ApprovalRouter } from "../../policy/approval-router";
import type { PolicyConfig } from "../../policy/config";
import type { Store } from "../../store/db";

/** Driver-level memory-context wiring (issue #42): mirrors the extension opts. */
export interface MemoryContextDriverOpts {
  provider: MemoryProvider;
  defaultPrincipal?: string;
  maxEntries?: number;
  maxBytes?: number;
  enabled?: boolean;
}

/**
 * Connect-capability wiring (issue #52): the per-session `connect_extension`
 * tool definition. Built per session so it closes over the session's
 * `getPrincipal` — the connect actor must be the requesting principal
 * (personal connects record owner = actor).
 */
export interface ConnectExtensionDriverOpts {
  registry: Pick<ExtensionRegistry, "resolve">;
  store: Pick<Store, "upsertExtensionCredential">;
  audit: AuditModule;
  loadPolicy: (spaceId: string | undefined) => Promise<PolicyConfig>;
  router: ApprovalRouter;
  /** Ask-human timeout in ms; defaults to the policy's `approvals.timeout_minutes`. */
  timeoutMs?: number;
  /** Broker seam; defaults to the production auth-broker connector. */
  broker?: BrokerConnector;
}

/**
 * Minimal agent-session abstraction. SpaceService depends only on this — the
 * concrete driver (OMP SDK today, ACP later) owns all session mechanics.
 */
export interface AgentTurnOptions {
  streamingBehavior?: "steer" | "followUp";
  /**
   * Suppress onOutput delivery for this turn (digest turns, issue #42). The
   * "message" event still fires, so callers can capture the turn's text.
   */
  silent?: boolean;
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
    /**
     * The space's current principal, re-read on every LLM call (issue #42).
     * Consumed by the OMP driver's memory-context injection; ACP sessions
     * reach memory through the MCP tools (#25) and ignore it (documented).
     */
    getPrincipal?: () => string | undefined;
    /**
     * Extra system-prompt text appended at session creation (issue #55):
     * the `request-only` directive. Evaluated per cold start, so a mode
     * change applies once the space's live session is disposed.
     */
    appendSystemPrompt?: string;
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
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : undefined;
}

/**
 * Space agent tool allowlist: conversation/read-only tools + `task` for
 * delegating to work executors. Deliberately no bash/write/edit — the space
 * agent is a participant, not an executor. The work item queue tools
 * (issue #10) are listed so the agent can create and cancel work items, and
 * the memory tools (issue #22) so it can save and search memory. The
 * connect capability (issue #52) rides the custom-tools path
 * (createOmpSdkDriver builds its definition per session) and is listed here
 * so the allowlist documents it — keep in sync with PROJECT_TOOL_NAMES.
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
  "connect_extension",
  "memory.save",
  "memory.search",
] as const;

/**
 * The session tool name list: the space-agent allowlist (or an explicit
 * allowTools override) plus extension tool names. The SDK's restricted
 * sessions only surface custom tools that are ALSO named here (see
 * allowRestrictedCustomTools in createAgentSession), so extension tools must
 * be merged into the list the driver passes.
 */
export function spaceAgentToolNames(extensionToolNames: readonly string[], allowTools?: readonly string[]): string[] {
  const names = allowTools ? [...allowTools] : [...SPACE_AGENT_TOOLS];
  for (const name of extensionToolNames) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Driver backed by the OMP SDK (`createAgentSession`). Sessions are
 * file-backed (SessionManager under `transcriptDir`, one JSONL per space —
 * the durable space timeline), tool-restricted to the allowlist above, and
 * registered in a private AgentRegistry (SDK requirement for concurrent
 * top-level sessions). `extensions` is OMP-typed by design: the AgentDriver
 * abstraction stays engine-free, and OMP-specific options live on this
 * factory (policy + audit extensions plug in here, issues #6/#7).
 *
 * `memoryContext` (issue #42) wraps every session with the memory-context
 * injection extension, built per session so it closes over the session's
 * `getPrincipal` — the smallest analogue of the MCP server's per-session
 * BOTTEGA_SPACE_ID pattern (the ACP driver documents this path instead).
 *
 * `customTools` (issue #50) carries the extension registry's tool
 * definitions; restricted sessions skip extension factories entirely, so
 * registry tools ride the SDK's custom-tools path instead.
 */
export function createOmpSdkDriver(
  opts: {
    agentDir?: string;
    extensions?: ExtensionFactory[];
    customTools?: ToolDefinition[];
    memoryContext?: MemoryContextDriverOpts;
    /** Connect capability (issue #52); omitted → the connect tool is absent (e.g. executor sessions). */
    connectExtension?: ConnectExtensionDriverOpts;
  } = {},
): AgentDriver {
  const customTools = opts.customTools ?? [];
  return {
    async createSession({ spaceId, transcriptDir, onOutput, cwd, allowTools, getPrincipal, appendSystemPrompt }) {
      mkdirSync(transcriptDir, { recursive: true });
      const sessionCwd = cwd ?? process.cwd();
      const sessionManager = SessionManager.create(sessionCwd, transcriptDir);
      // Missing/empty files start fresh; existing files resume the space's
      // transcript (server restarts keep history intact).
      await sessionManager.setSessionFile(sessionFilePath(transcriptDir, spaceId));
      const extensions = [...(opts.extensions ?? [])];
      if (opts.memoryContext) {
        extensions.push(
          memoryContextExtension(opts.memoryContext.provider, {
            defaultPrincipal: opts.memoryContext.defaultPrincipal,
            maxEntries: opts.memoryContext.maxEntries,
            maxBytes: opts.memoryContext.maxBytes,
            enabled: opts.memoryContext.enabled,
            getPrincipal,
          }),
        );
      }
      // The connect tool (issue #52) rides the custom-tools path — restricted
      // sessions skip extension factories — and is built per session so the
      // actor is the session's principal (personal connects record the owner).
      const sessionCustomTools = opts.connectExtension
        ? [
            ...customTools,
            connectExtensionToolDefinition({
              registry: opts.connectExtension.registry,
              store: opts.connectExtension.store,
              audit: opts.connectExtension.audit,
              broker: opts.connectExtension.broker ?? connectViaAuthBroker,
              gate: {
                loadPolicy: opts.connectExtension.loadPolicy,
                router: opts.connectExtension.router,
                timeoutMs: opts.connectExtension.timeoutMs,
              },
              getPrincipal,
              spaceIdFromFile: sessionIdFromFilePath,
            }),
          ]
        : customTools;
      const { session } = await createAgentSession({
        cwd: sessionCwd,
        agentDir: opts.agentDir,
        sessionManager,
        agentRegistry: new AgentRegistry(),
        restrictToolNames: true,
        toolNames: spaceAgentToolNames(sessionCustomTools.map((tool) => tool.name), allowTools),
        // Extension seam: policy + audit extensions plug in here (#6/#7).
        extensions,
        // request-only directive (issue #55), appended to the rendered prompt.
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        // Registry + connect tools (issues #50/#52) must surface in
        // restricted sessions; discovered extensions, MCP, and ambient
        // custom tools stay disabled.
        customTools: sessionCustomTools,
        allowRestrictedCustomTools: true,
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
  /** When a prompt runs with silent: true, output is captured but not delivered. */
  #silentTurn = false;

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
    this.#silentTurn = opts?.silent ?? false;
    try {
      if (this.#session.isStreaming) {
        if (opts?.streamingBehavior === "followUp") {
          await this.#session.followUp(text);
        } else {
          await this.#session.steer(text);
        }
      } else {
        await this.#session.prompt(text);
      }
    } finally {
      this.#silentTurn = false;
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
    // Silent turns (digest, #42) skip the output callback but still emit, so
    // the caller can capture the text without posting it to the space.
    if (!this.#silentTurn) this.#onOutput(this.#spaceId, text);
    this.#emitter.emit("message", { spaceId: this.#spaceId, text });
  }
}
