import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AgentRegistry,
  SessionManager,
  createAgentSession,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ExtensionFactory,
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import type { MemoryProvider } from "../../memory/types";
import type { SpaceModelSettings } from "../../store/db";
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

/**
 * Model roles the `use_model` tool switches between (issue #64):
 * - `default` — the space's configured model (the `model` setting);
 * - `fast` — the `fast_model` setting (falls back to `model`) at low effort;
 * - `reasoning` — the `reasoning_model` setting (falls back to `model`) at
 *   the space's `reasoning_effort` (default high).
 */
export type ModelRole = "default" | "fast" | "reasoning";

/**
 * What a role switch actually applied (issue #64). `applied: false` means
 * nothing changed and `reason` explains why (e.g. no settings configured).
 * `model`/`thinking_level` are null when that half of the switch was a
 * no-op; `model` is a bare model id as the session lists it.
 */
export interface ModelRoleSwitchResult {
  applied: boolean;
  role: ModelRole;
  model: string | null;
  thinking_level: string | null;
  reason?: string;
}

export interface AgentSessionDriver {
  prompt(text: string, opts?: AgentTurnOptions): Promise<void>;
  abort(): Promise<void>;
  isStreaming(): boolean;
  on(event: "message" | "turn_start" | "turn_end" | "error", cb: (data: unknown) => void): () => void;
  dispose(): Promise<void>;
  /**
   * Optional per-session model-role switch (issue #64): applies the role for
   * the NEXT turn. Optional on purpose — the interface stays
   * backward-compatible, and drivers that cannot switch mid-session (ACP:
   * the agent's own config governs) simply omit it or return a
   * not-supported result. The `use_model` tool reaches this through the
   * live-session registry (SessionModelRoleRegistry).
   */
  setModelRole?(role: ModelRole): Promise<ModelRoleSwitchResult>;
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
    /**
     * Per-space model settings (issue #64): the OMP driver resolves
     * `use_model` roles against these. Absent → sessions have no settings
     * to switch to (role switches report applied: false).
     */
    getModelSettings?: (spaceId: string) => Promise<SpaceModelSettings>;
  }): Promise<AgentSessionDriver>;
}

/**
 * Live-session registry for the `use_model` tool (issue #64). The space
 * service registers each live session under its space id and removes it on
 * dispose; the tool resolves the caller's space to its live session and
 * delegates the role switch to the session's optional `setModelRole` hook.
 * A session whose driver cannot switch (or no live session at all) yields a
 * clear error instead of a silent no-op.
 */
export class SessionModelRoleRegistry {
  readonly #sessions = new Map<string, AgentSessionDriver>();

  set(spaceId: string, session: AgentSessionDriver): void {
    this.#sessions.set(spaceId, session);
  }

  delete(spaceId: string): void {
    this.#sessions.delete(spaceId);
  }

  has(spaceId: string): boolean {
    return this.#sessions.has(spaceId);
  }

  async switchRole(
    spaceId: string,
    role: ModelRole,
  ): Promise<{ ok: true; result: ModelRoleSwitchResult } | { ok: false; error: string }> {
    const session = this.#sessions.get(spaceId);
    if (!session) return { ok: false, error: `no live agent session for space ${spaceId}` };
    if (!session.setModelRole) {
      return {
        ok: false,
        error: "this agent driver does not support mid-session model switches (ACP sessions use the agent's own config)",
      };
    }
    return { ok: true, result: await session.setModelRole(role) };
  }
}

/**
 * Maps a model role to concrete per-space settings (issue #64). Each slot
 * falls back to the space `model` when its own slot is unset, so an agent
 * that only ever runs one model still gets effort switching:
 * - default → space model at the space's `reasoning_effort` (the space's
 *   default effort; unset → leave the session's model/effort untouched);
 * - fast → fast_model ?? model at fixed low effort;
 * - reasoning → reasoning_model ?? model at reasoning_effort ?? high.
 */
export function resolveRoleTarget(
  role: ModelRole,
  settings: SpaceModelSettings,
): { modelId?: string; thinkingLevel?: "off" | "low" | "medium" | "high" } {
  switch (role) {
    case "fast":
      return { modelId: settings.fast_model ?? settings.model, thinkingLevel: "low" };
    case "reasoning":
      return { modelId: settings.reasoning_model ?? settings.model, thinkingLevel: settings.reasoning_effort ?? "high" };
    case "default":
      return { modelId: settings.model, thinkingLevel: settings.reasoning_effort };
  }
}

/**
 * The SDK's thinking-level union is const-enum backed (`Effort`), which
 * loses string-literal assignability across the package boundary under
 * isolatedModules. The settings values ARE those runtime strings
 * (`Effort.Low === "low"`), so the boundary cast is value-identical.
 */
type SdkThinkingLevel = NonNullable<Parameters<AgentSession["setModel"]>[2]>["thinkingLevel"];

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
 * (issue #22) so it can save and search memory. The connect capability
 * (issue #52) rides the custom-tools path
 * (createOmpSdkDriver builds its definition per session) and is listed here
 * so the allowlist documents it — keep in sync with PROJECT_TOOL_NAMES.
 * The model tools (issue #64) are listed so the agent can read/change
 * per-space model settings and switch its own next-turn model role.
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
  "model_settings",
  "use_model",
  // Settings tool (issue #67): get/set the durable org/space settings.
  "settings",
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
 * Session thinking level (issue #68). Mirrors the SDK's `ThinkingLevel`
 * values (`@oh-my-pi/pi-agent-core`) — the SDK root does not re-export the
 * type, so the driver re-declares it. "low" is a valid effort for
 * openai-completions models (pi-catalog `Effort.Low`); "off" disables
 * reasoning entirely (the documented fallback if empty responses persist).
 * "inherit" is deliberately absent: in a server context there is no
 * higher-level selector to defer to.
 */
export type DriverThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
    /** Per-space model settings (issue #64); see createSession's getModelSettings. */
    getModelSettings?: (spaceId: string) => Promise<SpaceModelSettings>;
    /**
     * Session thinking level (issue #68). Default "low": the space agent is
     * a chat participant, and with no level set the SDK's default reasoning
     * budget applied — deepseek-v4-flash consumed the whole token budget on
     * reasoning and returned empty responses (`content: ''` +
     * `finish_reason: length`, #60). "low" keeps the budget for answers;
     * "off" is the fallback if empties persist. Per-space configurability
     * lands with #64 (model settings); this sets the safe default.
     */
    thinkingLevel?: DriverThinkingLevel;
    /**
     * Session-factory seam (issue #68 tests): defaults to the SDK's
     * `createAgentSession`. Injected by hermetic tests to assert the exact
     * options the driver builds without touching the SDK.
     */
    createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
  } = {},
): AgentDriver {
  const customTools = opts.customTools ?? [];
  const createSession = opts.createSession ?? createAgentSession;
  const thinkingLevel: DriverThinkingLevel = opts.thinkingLevel ?? "low";
  return {
    async createSession({ spaceId, transcriptDir, onOutput, cwd, allowTools, getPrincipal, appendSystemPrompt, getModelSettings }) {
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
      const { session } = await createSession({
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
        // Issue #68: keep the token budget for answers, not reasoning (see
        // the thinkingLevel option on createOmpSdkDriver). The cast bridges
        // the SDK's const-enum typing: Effort members type nominally in
        // declaration files, but the runtime values are the same strings
        // DriverThinkingLevel mirrors.
        thinkingLevel: thinkingLevel as CreateAgentSessionOptions["thinkingLevel"],
        // Registry + connect tools (issues #50/#52) must surface in
        // restricted sessions; discovered extensions, MCP, and ambient
        // custom tools stay disabled.
        customTools: sessionCustomTools,
        allowRestrictedCustomTools: true,
      });
      return new OmpSessionDriver({
        spaceId,
        session,
        onOutput,
        getModelSettings: opts.getModelSettings ?? getModelSettings ?? (async () => ({})),
      });
    },
  };
}

/**
 * The OMP driver's session implementation. Exported so driver-level tests
 * can pin setModelRole against a stubbed SDK session (the factory path
 * exercises it with a real SDK session elsewhere).
 */
export class OmpSessionDriver implements AgentSessionDriver {
  readonly #spaceId: string;
  readonly #session: AgentSession;
  readonly #onOutput: (spaceId: string, text: string) => void;
  readonly #getModelSettings: (spaceId: string) => Promise<SpaceModelSettings>;
  readonly #emitter = createEmitter<DriverEvent>();
  #textByIndex = new Map<number, string>();
  #unsubscribe: () => void;
  /** When a prompt runs with silent: true, output is captured but not delivered. */
  #silentTurn = false;

  constructor(deps: {
    spaceId: string;
    session: AgentSession;
    onOutput: (spaceId: string, text: string) => void;
    /** Per-space model settings (issue #64); default: no settings (role switches report applied: false). */
    getModelSettings?: (spaceId: string) => Promise<SpaceModelSettings>;
  }) {
    this.#spaceId = deps.spaceId;
    this.#session = deps.session;
    this.#onOutput = deps.onOutput;
    this.#getModelSettings = deps.getModelSettings ?? (async () => ({}));
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

  /**
   * Applies a model role for the NEXT turn (issue #64): resolves the role
   * against the space's model settings, finds the model in the session's
   * available set, and switches via the SDK's per-session model hooks
   * (AgentSession.setModel with an explicit thinking level, non-persisting —
   * per-space persistence lives in `spaces.settings`, not the agent dir).
   * A role whose slots are all unset reports applied: false without
   * touching the session.
   */
  async setModelRole(role: ModelRole): Promise<ModelRoleSwitchResult> {
    const settings = await this.#getModelSettings(this.#spaceId);
    const target = resolveRoleTarget(role, settings);
    if (!target.modelId && !target.thinkingLevel) {
      return {
        applied: false,
        role,
        model: null,
        thinking_level: null,
        reason: "no model settings configured for this space",
      };
    }
    const thinkingLevel = target.thinkingLevel as SdkThinkingLevel | undefined;
    if (target.modelId) {
      const model = this.#findModel(target.modelId);
      if (!model) {
        throw new Error(`model '${target.modelId}' is not available to this session`);
      }
      await this.#session.setModel(model, undefined, {
        thinkingLevel,
        // Session-only: never write the OMP agent's settings file — the
        // space's `settings` column is the persistence home (#64).
        persist: false,
      });
    } else if (thinkingLevel !== undefined) {
      this.#session.setThinkingLevel(thinkingLevel);
    }
    return {
      applied: true,
      role,
      model: target.modelId ?? null,
      thinking_level: target.thinkingLevel ?? null,
    };
  }

  /** The session's available model matching a bare id (or "provider/id"). */
  #findModel(modelId: string): ReturnType<AgentSession["getAvailableModels"]>[number] | undefined {
    return this.#session
      .getAvailableModels()
      .find((m) => m.id === modelId || `${m.provider}/${m.id}` === modelId);
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
