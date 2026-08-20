import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AgentRegistry,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
  z,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ExtensionFactory,
  type Skill,
  type TodoPhase,
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { parseYamlSubset, type YamlNode } from "../../yaml-subset";
import {
  DEFAULT_MODEL_CATALOG_DIR,
  listAvailableModels,
  resolveModelPin,
  type ModelCatalogEntry,
} from "../../models/model-pin";
import type { MemoryProvider } from "../../memory/types";
import { MEMORY_LIMIT_MAX } from "../../memory/types";
import type { SpaceModelSettings } from "../../store/db";
import { renderInjection } from "../../tools/memory-context";
import {
  connectExtensionToolDefinition,
  connectViaAuthBroker,
  type BrokerConnector,
} from "../../extensions/connect";
import type { McpOAuthConnector } from "../../extensions/mcp-oauth";
import type { CatalogRegisterDeps } from "../../extensions/catalog-register";
import { mintUploadLinkToolDefinition, type UploadLinkStore } from "../../extensions/upload-link";
import type { ExtensionRegistry } from "../../extensions/registry";
import type { AuditModule } from "../../policy/audit";
import { redact } from "../../policy/audit";
import type { ApprovalRouter } from "../../policy/approval-router";
import type { PolicyConfig } from "../../policy/config";
import { loadSpacePolicy, resolveTier } from "../../policy/config";
import { evaluatePolicyGate, summarizeArgs, type PolicyGateOutcome } from "../../policy/gate";
import type { PolicyExtensionDeps } from "../../policy/extension";
import type { Store } from "../../store/db";
import { humanizeToolName } from "../adapters/approval-router";
import { emitToolStep, nextToolStepId, toolStepTitle, parseSearchResultRows } from "../services/slack-turn-presenter";

/**
 * Driver-level memory-context wiring (issue #42): org memories flagged
 * `metadata: { inject: "1" }` are injected into the model's context at
 * session cold start via the `appendSystemPrompt` seam. Restricted SDK
 * sessions cannot hook the extension `context` event, so the driver renders
 * the injection itself (same renderer as the extension).
 */
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
  registry: Pick<ExtensionRegistry, "resolve" | "register">;
  // `listRuntimeExtensions` (issue #250): the connect-time egress reconcile
  // default derives the runtime half of the egress superset from the store.
  store: Pick<Store, "upsertExtensionCredential" | "listExtensionCredentials" | "listRuntimeExtensions">;
  audit: AuditModule;
  loadPolicy: (spaceId: string | undefined) => Promise<PolicyConfig>;
  router: ApprovalRouter;
  /** Ask-human timeout in ms; defaults to the policy's `approvals.timeout_minutes`. */
  timeoutMs?: number;
  /** Broker seam; defaults to the production auth-broker connector. */
  broker?: BrokerConnector;
  /**
   * Catalog registration seam (issue #232): when wired, the per-session
   * connect tool routes an UNREGISTERED extension through the deterministic
   * catalog flow (lookup → draft → review gate → pin → connect) instead of
   * failing with "unknown extension".
   */
  catalogRegister?: CatalogRegisterDeps;
  /**
   * Generic MCP OAuth seam (issue #198): hosted OAuth MCPs connect through
   * it — the connect tool mints the authorization URL (shown in Slack),
   * the browser flow completes at the server's callback endpoint, and the
   * token lands in the vault. Omitted → the hosted OAuth path fails
   * closed (never falls through to the broker's provider-registry login).
   */
  mcpOAuth?: McpOAuthConnector;
  /**
   * One-time upload link (issue #196): when wired, sessions also get the
   * `connect_upload_link` mint tool — the store must be the one the upload
   * endpoint shares (the server's), so links minted here are consumable by
   * it. The minted secret lands DIRECTLY in the vault via the browser
   * endpoint, never through chat or a CLI.
   */
  uploadLink?: { store: UploadLinkStore; baseUrl: () => string };
}

/**
 * Minimal agent-session abstraction. SpaceService depends only on this — the
 * concrete driver (the OMP SDK) owns all session mechanics.
 */
export interface AgentTurnOptions {
  streamingBehavior?: "steer" | "followUp";
  /**
   * Suppress onOutput delivery for this turn (digest turns, issue #42). The
   * "message" event still fires, so callers can capture the turn's text.
   */
  silent?: boolean;
  /**
   * The inbound principal whose message STARTS this turn (issue #152). Bound
   * to the turn when a fresh turn begins; steers/follow-ups mid-turn inherit
   * the running turn's binding, so a second user's message can never
   * re-identify an in-flight turn's extension calls. Turns nobody started
   * (digest, #42) pass none — their binding fails closed to caller "agent".
   */
  principal?: string;
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
  on(event: DriverEvent, cb: (data: DriverEventData) => void): () => void;
  dispose(): Promise<void>;
  /**
   * The session's live todo plan (issue #228): the pull half of the todo
   * read seam. OMP sessions delegate to the SDK's AgentSession
   * (getTodoPhases — the state the `todo` tool writes, restored from the
   * transcript across cold starts). Absent a todo transport, a driver
   * returns an empty plan (no active plan is normal, never an error). The
   * push half is the `todo_phases` driver event, emitted when the SDK
   * finishes a todo operation.
   */
  getTodoPhases(): TodoPhase[];
  /**
   * Optional per-session model-role switch (issue #64): applies the role for
   * the NEXT turn. Optional on purpose — the interface stays
   * backward-compatible, and drivers that cannot switch mid-session
   * (the agent's own config governs) simply omit it or return a
   * not-supported result. The `use_model` tool reaches this through the
   * live-session registry (SessionModelRoleRegistry).
   */
  setModelRole?(role: ModelRole): Promise<ModelRoleSwitchResult>;
  /**
   * Turn-start model hot-swap (issue #189): re-applies the "default" role
   * against the CURRENT org/space settings so a settings change takes
   * effect on the very next turn — no session restart. The caller (space
   * service) invokes this BEFORE opening a fresh turn; drivers that cannot
   * switch mid-session omit it and the caller skips it. Best-effort:
   * failures are logged and the turn proceeds on the current model.
   */
  reapplyDefaultModelRole?(): Promise<void>;
  /**
   * The principal bound to the CURRENT turn (issue #152): the user whose
   * message started the in-flight turn. Bound when a fresh turn begins,
   * unchanged by steers/follow-ups, cleared when the turn ends. Undefined
   * between turns, for turns nobody started (digest), or when the driver
   * cannot bind — callers then fall back to "agent" (fail closed).
   * Replaces the space-level "latest inbound" source for credential
   * resolution: a second user's message mid-turn must not re-identify the
   * running turn's extension calls.
   */
  getTurnPrincipal?(): string | undefined;
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
     * Consumed by the OMP driver's memory-context injection.
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
    /**
     * Skills (issues #234/#235): already-loaded {@link Skill}s to inject
     * into this session, e.g. a space's authored skills or a work item's
     * task-level pins. The OMP driver hands them to `createAgentSession` so
     * `skill://<name>` resolves inside the session.
     */
    skills?: readonly Skill[];
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
        error: "this agent driver does not support mid-session model switches (the agent's own config governs them)",
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
/** The per-role model + thinking target (issue #64): optional overrides, defaults applied. */
export interface RoleTarget {
  modelId?: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
}

export function resolveRoleTarget(
  role: ModelRole,
  settings: SpaceModelSettings,
): RoleTarget {
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
export type DriverEvent =
  | "message"
  | "thinking"
  | "turn_start"
  | "turn_end"
  | "error"
  | "todo_phases";

/**
 * Payloads the session drivers emit per event. Consumers key off the event
 * name (a `message` carries `text`, an `error` carries `message`, …); the
 * optional fields are the union of every driver's emit sites.
 */
export interface DriverEventData {
  spaceId: string;
  /** Assistant text delivered during the turn (`message` events). */
  text?: string;
  /** Human-readable error/notice text (`error` events). */
  message?: string;
  /** Accumulated reasoning text (`thinking` events). */
  thinking?: string;
  /** Turn failure cause (`turn_end` events, and empty-completion `message` events, carrying one — issue #226). */
  error?: string;
  /**
   * The session's live todo snapshot (`todo_phases` events, issue #228):
   * emitted when the SDK's todo tool finishes an operation (the push path
   * of the driver's todo read seam). The OMP driver carries the phases the
   * tool result reported.
   */
  phases?: TodoPhase[];
}

/**
 * The listener plumbing behind {@link AgentSessionDriver.on} (issue #33).
 * Driver event semantics are shared, so the emitter lives here once: typed
 * by event name, idempotent `on` (a listener registers once), and
 * unsubscribe-by-closure.
 */
export function createEmitter<Event extends string>() {
  const listeners = new Map<Event, Set<(data: DriverEventData) => void>>();
  return {
    on(event: Event, cb: (data: DriverEventData) => void): () => void {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    },
    emit(event: Event, data: DriverEventData): void {
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

const thinkingBlockSchema = z.object({
  type: z.string(),
  thinking: z.string(),
});

const textBlockSchema = z.object({
  type: z.string(),
  text: z.string(),
});

/**
 * The thinking text of an SDK message's content blocks (issue #193).
 * `{type:"thinking"}` blocks carry the model's reasoning; unknown block
 * shapes (redactedThinking, toolCall, image, …) are ignored — fail closed,
 * never surfaced. Empty when the message carries no readable thinking.
 * Every SDK message kind carries `content`, so the param is the readable
 * slice of the SDK's AgentMessage.
 */
export function collectThinkingBlocks(message: { content?: unknown } | null): string[] {
  // A non-object message (or null) carries no readable thinking; the in-check
  // below then reads only the optional `content` property.
  if (!(message instanceof Object) || !("content" in message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    const parsed = thinkingBlockSchema.safeParse(block);
    if (!parsed.success || parsed.data.type !== "thinking" || !parsed.data.thinking.trim()) continue;
    parts.push(parsed.data.thinking.trim());
  }
  return parts;
}

/**
 * The text of an SDK message's content blocks, in content order. This is
 * the DISPLAY copy: for assistant `message_end` events the SDK deobfuscates
 * secret placeholders in text blocks before emitting to subscribers (issue
 * #221) — the streamed `text_delta` deltas carry the RAW provider text, so
 * the final message's content blocks are the authoritative, restored text.
 * Unknown block shapes (thinking, toolCall, image, …) are ignored. Empty
 * when the message carries no text blocks.
 */
export function collectTextBlocks(message: { content?: unknown } | null): string[] {
  if (!(message instanceof Object) || !("content" in message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    const parsed = textBlockSchema.safeParse(block);
    if (!parsed.success || parsed.data.type !== "text") continue;
    parts.push(parsed.data.text);
  }
  return parts;
}

/**
 * Space agent tool allowlist: conversation/read-only tools + `task` for
 * delegating to work executors. Deliberately no bash/write/edit — the space
 * agent is a participant, not an executor. The work item queue tools
 * (issue #10) are listed so the agent can create, cancel, and list work
 * items (issue #159), and (issue #22) so it can save and search memory. The connect capability
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
  "list_work_items",
  // Skill governance (issues #234/#235, Tier 1): the policy-gated writer for
  // the space's skill store — exec tier (ask-human) like create_work_item.
  "write_space_skill",
  "connect_extension",
  "memory.save",
  "memory.search",
  "session_search",
  "model_settings",
  "use_model",
  // Todo tool (issue #228): the session's planning scaffold — the WRITE
  // path of the todo state the driver reads (getTodoPhases + the
  // todo_phases push event). The SDK nudges the model to keep the plan
  // current (todo_reminder) like the CLI.
  "todo",
  // Todo snapshot (issue #228): read-tier assembly of the space's current
  // state — work items, pending approvals, scheduled jobs, in-progress
  // count, and the live "🛠 Agent's plan".
  "list_todos",
  // Settings tool (issue #67): get/set the durable org/space settings.
  "settings",
  // Admin tools (issue #73): catalog browser, stack health, deploy info
  // (anyone), first-run wizard — admin-gated like the settings tool.
  "catalog_browser",
  "stack_health",
  "deploy_info",
  "first_run_wizard",
] as const;

/**
 * The session tool name list: the space-agent allowlist (or an explicit
 * allowTools override), the persona floor, and extension tool names. The
 * persona floor only controls visibility; the policy gate still decides
 * whether a surfaced tool call is allowed (issue #130).
 *
 * The SDK's restricted sessions only surface custom tools that are ALSO
 * named here (see allowRestrictedCustomTools), so extension tools must be
 * merged into the list the driver passes.
 */
export function spaceAgentToolNames(
  extensionToolNames: readonly string[],
  allowTools?: readonly string[],
  toolFloor: readonly string[] = [],
): string[] {
  const names = allowTools ? [...allowTools] : [...SPACE_AGENT_TOOLS];
  for (const name of toolFloor) {
    if (!names.includes(name)) names.push(name);
  }
  for (const name of extensionToolNames) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Driver-level policy gate wiring (issue #69): restricted SDK sessions
 * (`restrictToolNames: true`) never evaluate inline extension factories
 * (sdk.ts), so the policy extension's `tool_call` interception is inert in
 * production. This option moves the same decision table (tier × space
 * policy → allow | deny | ask-human, audited, Slack-routed approvals) onto
 * the custom-tools bridge: every definition in `tools` — and every
 * allowlisted built-in the driver wraps — crosses the gate before it
 * executes. Definitions that run their own gate (connect_extension,
 * registry extension tools via the #53 runtime) stay in `customTools` and
 * are never double-gated.
 */
export interface DriverPolicyGateOpts extends PolicyExtensionDeps {
  /**
   * Tool definitions the gate must wrap (memory/work-item/model tools,
   * issue #69). Omitted → only allowlisted built-ins are gated.
   */
  tools?: ToolDefinition[];
}

/**
 * Allowlisted built-ins the driver can gate: re-registered as thin custom
 * definitions whose execute runs the policy gate, then delegates to the
 * SDK's native implementation via the documented same-tool `ctx.invokeTool`
 * seam. Deliberately excludes `lsp` (the SDK disables it for restricted
 * sessions — enableLsp defaults false) and `inspect_image` (model-dependent
 * lifecycle): wrapping those would surface tools the SDK itself would not
 * build. Custom definitions supplied by the caller always win over these
 * wrappers.
 */
const GATE_WRAPPED_BUILTINS = [
  "read",
  "glob",
  "grep",
  "ast_grep",
  "web_search",
  "task",
  "write",
  "edit",
  "bash",
] as const;

/** Arbitrary JSON values (tool args and stored config are JSON at the boundaries). */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Caller-declared parameter hints for the wrapped built-ins (issue #69).
 * The native implementation validates strictly and rejects bad args with
 * its own schema, so the wrapper only needs a permissive passthrough shape
 * that guides the model without drifting from the SDK's schemas.
 */
const GATE_WRAPPED_BUILTIN_PARAMS = {
  read: z.object({ path: z.string(), offset: z.number().int().optional(), limit: z.number().int().optional() }).passthrough(),
  glob: z.object({ pattern: z.string(), path: z.string().optional(), limit: z.number().int().optional() }).passthrough(),
  grep: z.object({ pattern: z.string(), path: z.string().optional(), case: z.boolean().optional() }).passthrough(),
  ast_grep: z.object({ pattern: z.string(), path: z.string().optional() }).passthrough(),
  web_search: z.object({ query: z.string() }).passthrough(),
  task: z.object({ description: z.string(), prompt: z.string(), agent: z.string().optional() }).passthrough(),
  write: z.object({ path: z.string(), content: z.string() }).passthrough(),
  edit: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }).passthrough(),
  bash: z.object({ command: z.string(), timeout: z.number().int().optional() }).passthrough(),
} satisfies Record<(typeof GATE_WRAPPED_BUILTINS)[number], ReturnType<typeof z.object>>;

const GATE_WRAPPED_BUILTIN_DESCRIPTIONS = {
  read: "Read a file from the workspace. Args: path (string, required), offset (int, optional), limit (int, optional).",
  glob: "List files matching a glob pattern. Args: pattern (string, required), path (string, optional), limit (int, optional).",
  grep: "Search file contents with a regex pattern. Args: pattern (string, required), path (string, optional), case (boolean, optional).",
  ast_grep: "Search code structurally with an AST pattern. Args: pattern (string, required), path (string, optional).",
  web_search: "Search the web. Args: query (string, required).",
  task: "Delegate a task to a subagent. Args: description (string, required), prompt (string, required), agent (string, optional).",
  write: "Write content to a file at path. Args: path (string, required), content (string, required).",
  edit: "Apply a string replacement to a file at path. Args: path (string, required), old_string (string, required), new_string (string, required).",
  bash: "Run a shell command in the workspace. Args: command (string, required), timeout (int, optional).",
} satisfies Record<(typeof GATE_WRAPPED_BUILTINS)[number], string>;

/**
 * Marks an SDK tool definition so the SDK treats it as a
 * {@link ToolDefinition} rather than a legacy CustomTool (issue #69).
 *
 * `createAgentSession`'s customTools accepts both shapes and discriminates
 * on a hidden `__isToolDefinition` flag (sdk.ts `isCustomTool`): an
 * UNMARKED plain object is treated as a CustomTool and its execute is
 * re-bound to the CustomTool signature
 * `(toolCallId, params, onUpdate, customToolContext, signal)` — which
 * silently shifts a ToolDefinition-style execute's `(signal, onUpdate,
 * ctx)` arguments and breaks `ctx.sessionManager` access. The SDK marks
 * its own converted definitions with a private symbol; the runtime check
 * reads the same-named string property, so definitions passed through this
 * helper get the full ExtensionContext (sessionManager + the same-tool
 * `ctx.invokeTool` delegation seam for wrapped built-ins).
 */
export function markToolDefinition<TDef extends ToolDefinition>(def: TDef): TDef {
  // SAFETY: spreading def preserves every ToolDefinition member; adding the marker only widens the object, never removes a member.
  return { ...def, __isToolDefinition: true } as TDef & { __isToolDefinition: boolean };
}

/**
 * opencode-go gateway tool-name constraint (issue #78): the Console Go
 * gateway validates tool names against `^[a-zA-Z0-9_-]+$` and 400s every
 * request carrying a dotted name (memory.save, memory.search, the
 * namespace extension tools — attio.* / github.* / linear.*), which is why
 * opencode sessions returned empty completions. The NEAR gateway accepts
 * dotted names; flat names are accepted by BOTH gateways, so the session's
 * model-facing tool names are flattened at the driver boundary. The
 * canonical dotted names survive everywhere that matters: the policy gate
 * and tool implementations close over the ORIGINAL definition (audit rows
 * keep `memory.save`), the extension runtime routes by its own manifest
 * tool names, and the MCP server is a separate surface — only the names
 * the model sees (prompts, wire definitions, transcripts) are flat.
 *
 * Restricted sessions cannot hook the SDK's provider payload path
 * (extension `before_provider_request` handlers are inert under
 * restrictToolNames — the SDK loads zero extensions), so a wire-level
 * rewrite is not reachable; the flatten-on-registration below is the
 * provider-boundary transform, and the "map back" happens at dispatch:
 * the model's flat call executes the SAME canonical tool implementation,
 * so attribution stays canonical.
 */
export const OPENCODE_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Flattens a tool name to the gateway-safe charset (`.` → `_`, etc.). */
export function opencodeSafeToolName(name: string): string {
  return OPENCODE_TOOL_NAME_PATTERN.test(name) ? name : name.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

/** Canonical → flat map for every tool whose name the gateway would reject. */
export function opencodeToolNameMap(names: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of names) {
    const flat = opencodeSafeToolName(name);
    if (flat !== name) map.set(name, flat);
  }
  return map;
}

/** Re-registers a tool definition under its gateway-safe name (identity when unchanged). */
export function withOpencodeSafeName<TDef extends ToolDefinition>(def: TDef): TDef {
  const name = opencodeSafeToolName(def.name);
  return name === def.name ? def : { ...def, name, label: name };
}

/**
 * Issue #183: the SDK's fresh prompt can throw two "prior run did not
 * settle" failures — the immediate `AgentBusyError` (a run is streaming at
 * prompt entry) and, after the SDK's internal 30s busy-wait, the
 * "Timed out waiting for prior agent run to finish before prompting."
 * error from turn-recovery. Both mean a ghost run outlived its turn and
 * the session is wedged: the driver must recover (abort + retry), never
 * treat them as a silent no-reply.
 */
export function isBusySettlementError(err: Error): boolean {
  return (
    err.name === "AgentBusyError" ||
    /prior agent run to finish before prompting/.test(err.message)
  );
}

/**
 * Extracts the first text content item from a tool result (issue #278),
 * for forwarding search_web's JSON payload to the presenter seam. The
 * search tool's only text item carries the full `{query,count,results}`
 * payload; concatenated text items are returned as one string so a
 * multi-item result still parses. Unshaped results yield "".
 */
function searchTextFromResult(result: { content?: Array<{ type?: string; text?: string }> }): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

/**
 * Wraps a tool definition so every call crosses the shared policy gate
 * (issue #69): load the space's effective policy, decide (tier × action),
 * audit, and route ask-human through the approval router — then run the
 * original execute only when the call is allowed. A denied call throws the
 * gate's block reason, which the SDK surfaces to the model as a blocked
 * tool result (the same shape the policy extension's `{block: true}`
 * produced). Fail closed: any gate error denies the call.
 *
 * Every gated call emits one thinking step (issue #168) when the deps carry
 * an `onToolStep` sink: in_progress "tool — allowed (tier)" on start,
 * complete on resolution; "tool — waiting for approval" while the approval
 * router is pending (the gate's onAskHuman hook); a terminal "tool —
 * denied (tier)" card on denial. Titles and the args code-card pass the
 * SAME redaction as audit payloads — secret-shaped values render
 * `[REDACTED]`, never raw.
 */
export function withPolicyGate<TDef extends ToolDefinition>(def: TDef, deps: PolicyExtensionDeps): TDef {
  const execute = def.execute;
  const actor = deps.actor ?? "agent";
  const sink = deps.onToolStep;
  // SAFETY: the wrapper spreads def unchanged and only replaces execute with a same-signature gate-wrapped implementation, preserving TDef's shape.
  return {
    ...def,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      const tier = deps.toolTier?.(def.name) ?? resolveTier(def.name);
      const stepArgs = sink !== undefined ? redact(summarizeArgs(params)) : undefined;
      const taskId = nextToolStepId();
      // #295: the human-readable footer label for the tool NAME, derived at
      // the source (no internal tool identifiers reach Slack).
      const label = humanizeToolName(def.name);
      let outcome: PolicyGateOutcome;
      try {
        outcome = await evaluatePolicyGate(
          {
            loadPolicy: (sid) => loadSpacePolicy(deps.orgPolicy, deps.store, sid),
            audit: deps.audit,
            router: deps.router,
            timeoutMs: deps.timeoutMs,
            preApproved: deps.preApproved,
            knownExtensionIds: deps.knownExtensionIds,
            toolTier: deps.toolTier,
            // Issue #168: render "waiting for approval" while the router
            // waits — the resolution (approved/denied) shares this taskId.
            onAskHuman:
              sink !== undefined
                ? () => {
                    emitToolStep(sink, {
                      spaceId,
                      taskId,
                      label,
                      title: toolStepTitle(def.name, "waiting for approval"),
                      status: "in_progress",
                      output: stepArgs,
                    });
                  }
                : undefined,
          },
          {
            tool: def.name,
            args: params,
            spaceId,
            actor,
            extensionId: deps.toolExtensionId?.(def.name),
          },
        );
      } catch (err) {
        // Fail closed: an internal gate error must never let the tool run.
        console.error("[policy] gate error (denying tool call):", err);
        throw new Error("policy: gate error — denied");
      }
      // A deliberate deny surfaces as a blocked tool result to the model,
      // the same shape the policy extension's `{block: true}` produced.
      if (!outcome.allowed) {
        // Terminal deny card: a waiting-for-approval card (ask-human) is
        // resolved here; a straight deny renders one deny step.
        emitToolStep(sink, {
          spaceId,
          taskId,
          label,
          title: toolStepTitle(def.name, `denied (${tier})`),
          status: "complete",
          outcome: "denied",
          output: stepArgs,
        });
        // Tool-outcome INFO (issue #224): the canary's tool-event seam —
        // under restrictToolNames the SDK's extension events are inert, so
        // every live call crosses this wrapper; a denied call is an
        // attributable outcome, never a silent no-reply.
        console.log(`[tool] ${def.name} → denied (${tier})`);
        throw new Error(outcome.blockReason);
      }
      if (outcome.decision === "ask-human") {
        // The waiting card (onAskHuman above) resolves as "approved".
        emitToolStep(sink, {
          spaceId,
          taskId,
          label,
          title: toolStepTitle(def.name, `approved (${tier})`),
          status: "complete",
          outcome: "approved",
          output: stepArgs,
        });
      } else {
        emitToolStep(sink, {
          spaceId,
          taskId,
          label,
          title: toolStepTitle(def.name, `allowed (${tier})`),
          status: "in_progress",
          output: stepArgs,
        });
      }
      try {
        const result = await execute.call(def, toolCallId, params, signal, onUpdate, ctx);
        // The call RAN AND RETURNED: check the card off as SUCCEEDED — the
        // only #295-footer-eligible outcome. (A call that later throws is
        // the failed path below, never succeeded.)
        if (outcome.decision !== "ask-human") {
          emitToolStep(sink, {
            spaceId,
            taskId,
            label,
            title: toolStepTitle(def.name, `allowed (${tier})`),
            status: "complete",
            outcome: "succeeded",
            output: stepArgs,
          });
        }
        // Tool-outcome INFO (issue #224): the canary's tool-event seam —
        // log the tool name + outcome so a live run attributes a store
        // effect that never landed (tool failure vs stall vs model
        // behavior). The pre-#224 run could not: no tool results/errors
        // were logged and the temp transcripts were deleted at cleanup.
        console.log(`[tool] ${def.name} → ok`);
        // Cited-search dispatch (issue #278): a SUCCESSFUL search_web call
        // forwards its parsed cited rows to the turn-presenter seam so the
        // citations reach the human as a table. Fail closed: no sink, a
        // non-search tool, an error result, or rows that fail to parse
        // NEVER dispatch — a missing key already surfaced as the tool's own
        // unavailable error, so nothing fabricated ever posts. All other
        // generic tool-step behavior is untouched.
        if (def.name === "search_web" && !result.isError) {
          const onSearchResults = deps.onSearchResults;
          if (onSearchResults) {
            const text = searchTextFromResult(result);
            const rows = parseSearchResultRows(text);
            // Fail closed: a headless call (no space) never dispatches.
            if (rows.length > 0 && spaceId !== undefined) onSearchResults(spaceId, rows);
          }
        }
        return result;
      } catch (err) {
        // A human-confirmed write that then FAILED (issue #277) is posted
        // back into the thread and remembered per (space, tool) — bounded —
        // via the router's optional failure seam: a later approval card for
        // the same tool surfaces 'last confirmed write failed'. Denials and
        // policy-allowed calls are not "confirmed writes" — only ask-human
        // approvals are. The decision is unchanged: the error still throws.
        if (outcome.decision === "ask-human") {
          deps.router.recordConfirmedWriteFailure?.(
            spaceId ?? "",
            def.name,
            err instanceof Error ? err.message : String(err),
          );
        }
        if (outcome.decision !== "ask-human") {
          emitToolStep(sink, {
            spaceId,
            taskId,
            label,
            title: toolStepTitle(def.name, `allowed (${tier})`),
            status: "complete",
            outcome: "failed",
            output: stepArgs,
          });
        }
        console.log(`[tool] ${def.name} → error: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  } as TDef;
}

/**
 * Thin definitions for allowlisted built-ins the gate must cover (issue
 * #69): gate first, then delegate to the SDK's native implementation via
 * the same-tool `ctx.invokeTool` seam (the SDK's documented way for a
 * re-registered built-in to reach the original).
 */
function gatedBuiltinDefinitions(names: readonly string[]): ToolDefinition[] {
  return names.map((name) => {
    // SAFETY: gatedBuiltinDefinitions is only called with names pre-filtered by GATE_WRAPPED_BUILTINS membership (see builtinNames below), so the lookups below always hit.
    const def: ToolDefinition = {
      name,
      label: name,
      description: GATE_WRAPPED_BUILTIN_DESCRIPTIONS[name as (typeof GATE_WRAPPED_BUILTINS)[number]],
      parameters: GATE_WRAPPED_BUILTIN_PARAMS[name as (typeof GATE_WRAPPED_BUILTINS)[number]],
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Delegation runs the unwrapped native built-in with this call's
        // context (abort signal, progress callback, provider metadata), so
        // the wrapped tool behaves exactly like the native one — the gate
        // is the only difference.
        if (!ctx.invokeTool) {
          throw new Error(`policy: built-in '${name}' has no native implementation to delegate to`);
        }
        // SAFETY: built-in params are JSON values (the wrapper schemas above are passthrough JSON shapes); invokeTool accepts the same.
        return ctx.invokeTool(params as Record<string, JsonValue>);
      },
    };
    return def;
  });
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
 * Boot-time guard (issue #80): assert the OMP SDK's model registry resolves
 * ≥1 AVAILABLE model from the agent dir's own catalog, and throw a clear
 * boot error naming the agent dir + config when it does not — never let the
 * first space prompt fail with "No model selected".
 *
 * The registry is built with the SDK's own discovery
 * (`new ModelRegistry(discoverAuthStorage(agentDir))`, models.yml pointed
 * at OUR file explicitly), so the guard checks the catalog the sessions
 * will use — the driver's {@link createOmpSdkDriver} installs that same
 * dir as the process-global agent dir at construction, so in the boot
 * paths (server + executor) the two views coincide.
 *
 * - models.yml declares providers → require ≥1 available model from THOSE
 *   providers (env key, models.yml apiKey, or broker credential). A
 *   declared-but-unavailable catalog is the #80 symptom: it used to
 *   surface as "No model selected" at the first prompt (or as silent drift
 *   to whatever catalog the machine's own agent dir offered).
 * - models.yml missing / declares no providers → lenient leg, no assertion
 *   (deployments without a catalog fall back to the SDK's bundled models
 *   and env keys, exactly the view the session gets).
 * - a malformed models.yml surfaces the SDK's own config error.
 *
 * Returns the number of available models from the declared providers, or
 * the overall available count on the lenient leg (informational).
 */
export async function assertAgentDirModelAvailable(agentDir: string): Promise<number> {
  const configPath = join(agentDir, "config.yml");
  const modelsPath = join(agentDir, "models.yml");
  // The providers OUR models.yml declares. null = file missing/unreadable/
  // unparseable → the lenient leg below (the SDK itself would also see no
  // custom config; a parse failure that the SDK DOES flag is caught via
  // registry.getError()).
  let declared: string[] | null = null;
  try {
    const parsed = parseYamlSubset(readFileSync(modelsPath, "utf8"));
    // The models.yml contract: `providers` is a mapping of provider id → config; anything else means no providers declared.
    const providers = z.record(z.string(), z.unknown()).safeParse(parsed.providers);
    declared = providers.success ? Object.keys(providers.data) : [];
  } catch {
    declared = null;
  }
  const registry = new ModelRegistry(await discoverAuthStorage(agentDir), modelsPath);
  const configError = registry.getError();
  if (configError !== undefined) {
    throw new Error(
      `bottega boot guard: ${modelsPath} failed to load: ${configError.message} ` +
        `(agent dir ${agentDir}, config: ${configPath})`,
    );
  }
  const available = registry.getAvailable();
  if (declared !== null && declared.length > 0) {
    const fromDeclared = available.filter((model) => declared.includes(model.provider));
    if (fromDeclared.length === 0) {
      throw new Error(
        `bottega boot guard: no model is available from the agent dir ${agentDir}: ` +
          `${modelsPath} declares providers [${declared.join(", ")}] but none of their models ` +
          `has configured auth (env key, models.yml apiKey, or auth-broker credential; ` +
          `config: ${configPath}). The first space prompt would fail with "No model selected" — ` +
          `refusing to boot. Configure a provider key and restart.`,
      );
    }
    return fromDeclared.length;
  }
  return available.length;
}

/**
 * The committed OMP agent-dir config template (config.yml). Under compose it
 * is mounted over the agent dir, but in host dev the agent dir is never
 * re-synced — so a stale copy from before the #78 pin lands can persist.
 */
export const OMP_CONFIG_TEMPLATE = "config/omp/config.yml";

/** What the boot-time pin sync did to the agent-dir config.yml (issue #78/#207). */
export type AgentDirPinSyncResult = "created" | "patched" | "updated" | "unchanged" | "skipped";

/**
 * Guarantees the SDK's agent-dir config.yml carries the `modelRoles` pin
 * from the committed template (issue #78 recurrence, staleness #207). The
 * SDK reads the agent dir's config.yml at session creation; when it lacks
 * the pin, the session silently falls back to the provider catalog default
 * (kimi-k2.7-code for opencode-go) instead of the pinned deepseek-v4-flash
 * — the "OMP repository fallback" — and the Console Go gateway 400s that
 * path (dotted tool names) into empty completions.
 *
 * Operator customizations are never overwritten (the #125 clobber fix):
 * a config this parser cannot read is left untouched, and a stale pin is
 * corrected IN PLACE — only the `modelRoles.default` value line changes,
 * every other block (disabledProviders, secrets, …) stays byte-identical.
 * When the org settings override the default model (`opts.orgDefault` set),
 * the pin is inert for sessions — the operator's own agent-dir pin is left
 * alone rather than clobbered. When the agent-dir config is missing
 * entirely, the template is copied (the compose-equivalent first boot).
 * Returns what was done for boot logging and tests.
 */
export function ensureAgentDirModelPin(
  agentDir: string,
  templatePath: string = OMP_CONFIG_TEMPLATE,
  opts: { orgDefault?: string } = {},
): AgentDirPinSyncResult {
  const agentConfigPath = join(agentDir, "config.yml");
  let existing: string | null = null;
  try {
    existing = readFileSync(agentConfigPath, "utf8");
  } catch (err) {
    if (!z.object({ code: z.literal("ENOENT") }).safeParse(err).success) return "skipped";
  }
  let template: string | null = null;
  try {
    template = readFileSync(templatePath, "utf8");
  } catch {
    return "skipped";
  }
  if (existing === null) {
    writeFileSync(agentConfigPath, template);
    return "created";
  }
  // An unparseable operator config is never guessed at.
  let parsed: Record<string, YamlNode>;
  try {
    parsed = parseYamlSubset(existing);
  } catch {
    return "skipped";
  }
  // The template's modelRoles block: a mapping of role → model id; anything
  // else means there is nothing to sync.
  let templateDefault: string | undefined;
  try {
    const templateParsed = parseYamlSubset(template);
    const roles = z.record(z.string(), z.unknown()).safeParse(templateParsed.modelRoles);
    const defaultRole = roles.success ? z.string().safeParse(roles.data.default) : undefined;
    templateDefault = defaultRole?.success ? defaultRole.data : undefined;
  } catch {
    return "skipped";
  }
  if (templateDefault === undefined) return "unchanged";
  if (parsed.modelRoles === undefined) {
    // No pin at all: append ONLY the template's modelRoles block (never a
    // rewrite of the operator's own blocks).
    appendFileSync(agentConfigPath, `\nmodelRoles:\n  default: ${templateDefault}\n`);
    return "patched";
  }
  // A pin exists: leave it alone when it already matches the template, when
  // the org settings override the default (the operator's pin is inert and
  // must not be clobbered — #125), or when the existing pin is unreadable.
  const agentRoles = z.record(z.string(), z.unknown()).safeParse(parsed.modelRoles);
  if (!agentRoles.success) return "unchanged";
  const agentDefaultParsed = z.string().safeParse(agentRoles.data.default);
  const agentDefault = agentDefaultParsed.success ? agentDefaultParsed.data : undefined;
  if (agentDefault === templateDefault || opts.orgDefault !== undefined) return "unchanged";
  // Stale pin (issue #207): correct the `default` value IN PLACE — the
  // rest of the operator's config stays byte-identical.
  updateAgentDirModelDefault(agentConfigPath, templateDefault);
  return "updated";
}

/** Line-level in-place correction of the `modelRoles.default` value (issue #207). */
function updateAgentDirModelDefault(agentConfigPath: string, value: string): void {
  const lines = readFileSync(agentConfigPath, "utf8").split("\n");
  let inModelRoles = false;
  let modelRolesLine = -1;
  let blockIndent = -1;
  let defaultLine = -1;
  let lastBlockLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    // Comment stripping mirrors the YAML-subset tokenizer (double-quoted
    // `#` is not a comment; `#` preceded by space/tab/start is).
    let cut = raw.length;
    let inDouble = false;
    for (let j = 0; j < raw.length; j++) {
      const c = raw[j]!;
      if (c === '"') inDouble = !inDouble;
      else if (c === "#" && !inDouble && (j === 0 || raw[j - 1] === " " || raw[j - 1] === "\t")) {
        cut = j;
        break;
      }
    }
    const text = raw.slice(0, cut).trim();
    if (text === "") continue;
    const indent = raw.length - raw.trimStart().length;
    if (!inModelRoles) {
      if (indent === 0 && text === "modelRoles:") {
        inModelRoles = true;
        modelRolesLine = i;
      }
      continue;
    }
    if (blockIndent === -1) {
      if (indent === 0) break; // empty modelRoles block
      blockIndent = indent;
    } else if (indent < blockIndent) {
      break; // block ended
    }
    lastBlockLine = i;
    const sep = text.indexOf(":");
    if (sep > 0 && text.slice(0, sep).trim() === "default" && defaultLine === -1) {
      defaultLine = i;
    }
  }
  const indentation = defaultLine !== -1 ? lines[defaultLine]!.slice(0, lines[defaultLine]!.length - lines[defaultLine]!.trimStart().length) : "  ";
  if (defaultLine !== -1) {
    lines[defaultLine] = `${indentation}default: ${value}`;
  } else if (lastBlockLine !== -1) {
    // The block has no `default` key: append one inside it.
    lines.splice(lastBlockLine + 1, 0, `${indentation}default: ${value}`);
  } else {
    // An empty `modelRoles:` block: insert the default directly under it.
    lines.splice(modelRolesLine + 1, 0, `${indentation}default: ${value}`);
  }
  writeFileSync(agentConfigPath, lines.join("\n"));
}

/**
 * Driver backed by the OMP SDK (`createAgentSession`). Sessions are
 * file-backed (SessionManager under `transcriptDir`, one JSONL per space —
 * the durable space timeline), tool-restricted to the allowlist above, and
 * registered in a private AgentRegistry (SDK requirement for concurrent
 * top-level sessions).
 *
 * Restricted sessions (restrictToolNames, hardcoded true) never evaluate
 * inline extension factories (sdk.ts), so extension-only wiring is inert:
 * the policy gate, extension-registered tools, and the memory-context
 * injection extension never run. The driver therefore wires all three on
 * the SDK's custom-tools path (issue #69):
 *
 * - `gate` moves the policy gate (issues #6/#7: tier × space policy →
 *   allow | deny | ask-human, audited, Slack-routed approvals) onto the
 *   tool bridge: every definition in `gate.tools` and every allowlisted
 *   built-in the driver wraps crosses the gate before it executes;
 * - `customTools` carries definitions that gate themselves (registry tools
 *   via the #53 runtime, the per-session connect tool, issue #52);
 * - `memoryContext` (issue #42) injects org memory flagged `inject: "1"`
 *   through the per-cold-start `appendSystemPrompt` seam — the same
 *   renderer the extension used, reached from the driver because the
 *   extension's `context` hook cannot fire in restricted sessions.
 */
export function createOmpSdkDriver(
  opts: {
    agentDir?: string;
    extensions?: ExtensionFactory[];
    /**
     * Extension tool definitions for the session toolset, or a RESOLVER
     * that builds them at session creation (issue #167): the server wires
     * a resolver that refreshes surfaces for extensions whose discovery
     * failed at boot, so a transient boot-time failure never permanently
     * starves a session of the provider's FULL toolset. A plain array
     * keeps the executor and test callers on the fixed path.
     */
    customTools?: ToolDefinition[] | (() => Promise<ToolDefinition[]>);
    /** Policy gate wiring (issue #69); see {@link DriverPolicyGateOpts}. */
    gate?: DriverPolicyGateOpts;
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
  // Issue #80: the SDK's model registry reads models.yml from the
  // PROCESS-GLOBAL agent dir (`getAgentDir()`), NOT from the session's
  // `agentDir` option — the root cause of today's model drift + "No model
  // selected" in production (the registry was reading ~/.omp/agent, so the
  // deployment's data/omp-agent catalog was never seen). Install the
  // bottega agent dir globally at construction, before any session can be
  // created, so registry AND session settings read OUR config. The dir is
  // created here so the driver is self-sufficient (agent.db etc. land
  // inside it); setAgentDir also pins PI_CODING_AGENT_DIR for subprocesses.
  if (opts.agentDir !== undefined) {
    mkdirSync(opts.agentDir, { recursive: true });
    setAgentDir(opts.agentDir);
  }
  const createSession = opts.createSession ?? createAgentSession;
  const thinkingLevel: DriverThinkingLevel = opts.thinkingLevel ?? "low";
  return {
    async createSession({ spaceId, transcriptDir, onOutput, cwd, allowTools, getPrincipal, appendSystemPrompt, getModelSettings, skills }) {
      mkdirSync(transcriptDir, { recursive: true });
      const sessionCwd = cwd ?? process.cwd();
      const sessionManager = SessionManager.create(sessionCwd, transcriptDir);
      // Missing/empty files start fresh; existing files resume the space's
      // transcript (server restarts keep history intact).
      await sessionManager.setSessionFile(sessionFilePath(transcriptDir, spaceId));
      // Issue #167: a resolver builds the toolset at session creation so a
      // provider whose discovery failed at boot is re-attempted NOW — the
      // full discovered surface lands in the session, never a partial stale
      // subset. Plain arrays pass through unchanged.
      const customToolsOption = opts.customTools;
      const sessionCustomToolsBase = Array.isArray(customToolsOption)
        ? customToolsOption
        : customToolsOption === undefined
          ? []
          : await customToolsOption();
      // The connect tool (issue #52) rides the custom-tools path — restricted
      // sessions skip extension factories — and is built per session so the
      // actor is the session's principal (personal connects record the owner).
      // The one-time upload-link mint (issue #196) rides the same path: it
      // needs the same per-session principal + space mapping.
      const sessionCustomTools = opts.connectExtension
        ? [
            ...sessionCustomToolsBase,
            connectExtensionToolDefinition({
              registry: opts.connectExtension.registry,
              store: opts.connectExtension.store,
              audit: opts.connectExtension.audit,
              broker: opts.connectExtension.broker ?? connectViaAuthBroker,
              ...(opts.connectExtension.catalogRegister !== undefined
                ? { catalogRegister: opts.connectExtension.catalogRegister }
                : undefined),
              ...(opts.connectExtension.mcpOAuth !== undefined
                ? { mcpOAuth: opts.connectExtension.mcpOAuth }
                : undefined),
              gate: {
                loadPolicy: opts.connectExtension.loadPolicy,
                router: opts.connectExtension.router,
                timeoutMs: opts.connectExtension.timeoutMs,
              },
              getPrincipal,
              spaceIdFromFile: sessionIdFromFilePath,
            }),
            ...(opts.connectExtension.uploadLink
              ? [
                  mintUploadLinkToolDefinition({
                    registry: opts.connectExtension.registry,
                    store: opts.connectExtension.uploadLink.store,
                    baseUrl: opts.connectExtension.uploadLink.baseUrl,
                    getPrincipal,
                    spaceIdFromFile: sessionIdFromFilePath,
                  }),
                ]
              : []),
          ]
        : sessionCustomToolsBase;
      // Policy gate (issue #69): the driver wraps the caller's gated
      // definitions AND the allowlisted built-ins that would otherwise run
      // with no enforcement (the extension seam is inert under restrict).
      // Built-ins the caller already defines (customTools) win; connect and
      // registry tools gate themselves and are never double-gated.
      const gate = opts.gate;
      const gatedTools = gate ? (gate.tools ?? []).map((def) => withPolicyGate(def, gate)) : [];
      const customNames = new Set(
        [...gatedTools, ...sessionCustomTools].map((def) => def.name),
      );
      const builtinNames = gate
        ? spaceAgentToolNames([...customNames], allowTools).filter(
            (name) =>
              !customNames.has(name) &&
              GATE_WRAPPED_BUILTINS.some((builtin) => builtin === name),
          )
        : [];
      const allSessionTools = [
        ...gatedTools,
        // Built-in wrappers delegate to the native tool AFTER the gate
        // (issue #69): every allowlisted built-in crosses the decision
        // table, then runs through the SDK's same-tool delegation seam.
        ...gatedBuiltinDefinitions(builtinNames).map((def) => withPolicyGate(def, gate!)),
        ...sessionCustomTools,
        // The SDK discriminates customTools by the hidden __isToolDefinition
        // flag (issue #69): unmarked objects are re-bound to the CustomTool
        // execute signature, which breaks ToolDefinition-style executes.
      ]
        .map(markToolDefinition)
        // opencode gateway tool-name transform (issue #78): every tool the
        // gateway would reject is re-registered under its flat name. The
        // policy gate wrappers above closed over the ORIGINAL definitions,
        // so decisions and audit rows keep the canonical dotted names.
        .map(withOpencodeSafeName);
      // Turn-start memory injection (#42) at the driver boundary: restricted
      // sessions cannot hook the SDK's `context` event, so org memories
      // flagged `metadata: { inject: "1" }` ride the per-cold-start
      // appendSystemPrompt seam (cold start == the first turn's start),
      // rendered with the extension's own renderer. maxEntries 0 disables
      // injection (org policy `memory.injection.enabled`).
      let effectiveAppend = appendSystemPrompt;
      if (opts.memoryContext && opts.memoryContext.enabled !== false) {
        const maxEntries = opts.memoryContext.maxEntries ?? 5;
        const maxBytes = opts.memoryContext.maxBytes ?? 4096;
        const limit = Math.min(maxEntries, MEMORY_LIMIT_MAX);
        const flagged = await opts.memoryContext.provider.search({
          query: "",
          scope: { kind: "org" },
          metadata: { inject: "1" },
          limit,
        });
        const body = renderInjection(flagged, maxEntries, maxBytes);
        if (body) effectiveAppend = effectiveAppend ? `${effectiveAppend}\n\n${body}` : body;
      }
      // Issue #199: the session's default model comes from the org/space
      // settings — but the SDK's registry resolves a raw unqualified value
      // to whichever provider lists it FIRST (opencode-go's #78-broken
      // deepseek), not the working near provider. Route the settings value
      // through the provider-aware pin resolver (#194: unqualified prefers
      // near; explicit provider qualifiers win) and hand the SDK the
      // resolved provider-qualified id. Fail closed: an unresolvable default
      // logs loudly and the session starts on the agent-dir default instead.
      let resolvedDefaultModel: string | undefined;
      try {
        const sessionSettings: (spaceId: string) => Promise<SpaceModelSettings> =
          getModelSettings ?? opts.getModelSettings ?? (async () => ({}));
        const modelSettings = await sessionSettings(spaceId);
        const defaultModel = modelSettings.model;
        if (defaultModel !== undefined && defaultModel.trim() !== "") {
          const catalog = await listAvailableModels(opts.agentDir ?? DEFAULT_MODEL_CATALOG_DIR);
          const resolution = resolveModelPin(defaultModel, catalog);
          if (resolution.ok) {
            const pin = resolution.pin;
            if (pin.kind === "id") {
              // Issue #238: the pin already carries the provider it matched
              // (or the near preference won). The pre-#238 code re-derived
              // the provider with a bare-id catalog find, which lands on the
              // FIRST same-id entry — for the org default
              // openai-codex/gpt-5.6-luna that is openai, whose egress has
              // no key (proxy 403 at CONNECT → silently empty turns). Use
              // the pin's provider; never re-derive.
              resolvedDefaultModel = `${pin.provider}/${pin.modelId}`;
            } else {
              console.error(
                `[agent-driver] session ${spaceId}: default model '${defaultModel}' resolved to a role ref, not a model — starting on the agent-dir default`,
              );
            }
          } else {
            console.error(
              `[agent-driver] session ${spaceId}: default model '${defaultModel}' is unresolvable — ${resolution.error}; starting on the agent-dir default`,
            );
          }
        }
      } catch (err) {
        console.error(
          `[agent-driver] session ${spaceId}: default model resolution failed — ${err instanceof Error ? err.message : String(err)}; starting on the agent-dir default`,
        );
      }
      const { session } = await createSession({
        cwd: sessionCwd,
        agentDir: opts.agentDir,
        sessionManager,
        agentRegistry: new AgentRegistry(),
        restrictToolNames: true,
        toolNames: spaceAgentToolNames(
          allSessionTools.map((tool) => tool.name),
          // The allowlist vocabulary stays canonical (policy/gate), but the
          // session's toolNames must name the gateway-safe forms (issue #78).
          (allowTools ? [...allowTools] : [...SPACE_AGENT_TOOLS]).map(opencodeSafeToolName),
        ),
        // Extension seam: kept for unrestricted sessions and API compat; under
        // restrictToolNames the SDK ignores it (issue #69) — the gate and the
        // gated definitions above are the live path.
        extensions: opts.extensions ?? [],
        // request-only directive (issue #55), appended to the rendered prompt.
        ...(effectiveAppend ? { appendSystemPrompt: effectiveAppend } : undefined),
        // Issue #68: keep the token budget for answers, not reasoning (see
        // the thinkingLevel option on createOmpSdkDriver). The cast bridges
        // the SDK's const-enum typing: Effort members type nominally in
        // declaration files, but the runtime values are the same strings
        // DriverThinkingLevel mirrors.
        // SAFETY: DriverThinkingLevel's strings are the SDK Effort runtime values (documented at SdkThinkingLevel).
        thinkingLevel: thinkingLevel as CreateAgentSessionOptions["thinkingLevel"],
        // Issue #199: the session starts on the RESOLVED settings default
        // (provider-qualified) — never the raw unqualified value the SDK's
        // registry would land on the wrong provider's same-named model.
        ...(resolvedDefaultModel !== undefined ? { modelPattern: [resolvedDefaultModel] } : undefined),
        // Skills (issues #234/#235): the SDK sets its active skill snapshot
        // from these, so `skill://<name>` (and the rendered `<skills>`
        // listing) resolve inside this session. Always passed — an empty
        // array is the SDK's default and a no-op.
        skills: [...(skills ?? [])],
        // Registry + connect tools (issues #50/#52) must surface in
        // restricted sessions; discovered extensions, MCP, and ambient
        // custom tools stay disabled.
        customTools: allSessionTools,
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
 * The todo tool's result snapshot (issue #228): the SDK's TodoToolDetails
 * rides `result.details.phases` on `tool_execution_end`. Structural parse —
 * a malformed result (or another tool's result shape) is skipped, never
 * thrown into the turn path.
 */
const todoResultPhasesSchema = z.object({
  details: z
    .object({
      phases: z.array(
        z.object({
          name: z.string(),
          tasks: z.array(
            z.object({
              content: z.string(),
              status: z.enum(["pending", "in_progress", "completed", "abandoned", "blocked"]),
              blocker: z.string().optional(),
            }),
          ),
        }),
      ),
    })
    .passthrough(),
}).passthrough();

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
  /**
   * Accumulated thinking text per content index of the CURRENT assistant
   * message (issue #193): `thinking_delta`/`thinking_end` fill it as the
   * provider streams reasoning, and each change emits a live "thinking"
   * driver event so the turn presenter can render the reasoning snippet
   * BEFORE the message completes. Cleared per message at message_end.
   */
  #thinkingByIndex = new Map<number, string>();
  #unsubscribe: () => void;
  /** When a prompt runs with silent: true, output is captured but not delivered. */
  #silentTurn = false;
  /**
   * The latest provider/session error observed this turn (issue #78): the
   * SDK's provider-error path emits a `message_end` whose assistant message
   * carries `stopReason: "error"` + `errorMessage` and empty content (the
   * 400 becomes an empty completion, silently dropped below). Stashing the
   * reason here lets the empty-completion path surface the REAL cause (e.g.
   * the 400 text) instead of the generic phrase. Cleared at turn_start so
   * each turn's cause is fresh; absent when the turn errored silently.
   */
  #lastError: string | undefined;
  /**
   * The principal of the CURRENT turn (issue #152): bound when a fresh turn
   * starts, untouched by steers/follow-ups, cleared at turn_end. Resolves
   * extension-call callers so a second user's message mid-turn can never
   * re-identify the running turn's credential lookups.
   */
  #turnPrincipal: string | undefined;
  /**
   * True while the driver's OWN fresh (opening) prompt is pending — the
   * whole turn, all tool rounds included (issue #183). Steers/follow-ups
   * are only legit mid-turn: when the session reports streaming but NO
   * fresh turn of ours is pending, the streaming run is a ghost
   * continuation that never settled (stream/panel path) — steering into it
   * would queue the message into a dead run (silent no-reply), so the
   * driver aborts the ghost and runs fresh instead.
   */
  #freshTurnPending = false;
  /**
   * The model role the `use_model` tool last applied (issue #189). A
   * non-default role (fast/reasoning) granted by use_model wins for the
   * turn it targets: the turn-start default re-apply is skipped ONCE so the
   * switch actually runs, then re-evaluation resumes — the following turn
   * start re-applies the settings default. `undefined`/`"default"` → no
   * override in force. Set on the applied path of setModelRole (the
   * executor's work-item pin rides the same seam and is preserved the same
   * way).
   */
  #modelRoleOverride: ModelRole | undefined;
  /**
   * True while a turn-start model re-apply (issue #189) is in flight — the
   * caller (space service) invokes {@link reapplyDefaultModelRole} before
   * opening a fresh turn, and the seam flips this synchronously so a
   * concurrent prompt steers into the opening turn instead of opening a
   * second one (the driver's isStreaming() includes it for the same
   * reason). Cleared in the seam's finally — the window is only the
   * reapply's own awaits.
   */
  #turnReapplyPending = false;

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
          } else if (ae.type === "thinking_delta") {
            // Issue #193: stream the model's reasoning live — every delta
            // re-emits so a long reasoning phase never looks frozen.
            this.#thinkingByIndex.set(ae.contentIndex, (this.#thinkingByIndex.get(ae.contentIndex) ?? "") + ae.delta);
            this.#emitThinking();
          } else if (ae.type === "thinking_end") {
            this.#thinkingByIndex.set(ae.contentIndex, ae.content);
            this.#emitThinking();
          }
          break;
        }
        case "message_end": {
          // Provider-error path (#78): the SDK's agent loop turns a failed
          // request (e.g. the replay-ordering 400) into an assistant message
          // with empty content + `errorMessage`, so the text below is empty
          // and nothing would be delivered — keep the cause for the
          // turn_end the loop emits right after.
          const errorMessage =
            event.message instanceof Object && "errorMessage" in event.message
              ? event.message.errorMessage
              : undefined;
          if (errorMessage !== undefined && errorMessage.trim()) this.#lastError = errorMessage.trim();
          // Issue #193: the message's own content blocks are the
          // authoritative thinking snapshot — on the replay path the
          // deltas above don't re-fire, so the completed reasoning rides
          // the final message instead. Prefer the content blocks (they
          // are the full text); the accumulated deltas remain the
          // fallback when a provider redacts thinking from content.
          const message =
            event.message instanceof Object && "content" in event.message ? event.message : null;
          const contentThinking = collectThinkingBlocks(message);
          if (contentThinking.length > 0) {
            this.#thinkingByIndex.clear();
            contentThinking.forEach((part, index) => this.#thinkingByIndex.set(index, part));
          }
          this.#emitThinking();
          this.#thinkingByIndex.clear();
          // Issue #221: the SDK obfuscates secrets in provider-bound
          // traffic (the SDK's env-name scanner treats
          // BOTTEGA_OAUTH_CALLBACK_BASE_URL's tunnel URL as a secret, so
          // the minted upload-link URL's base becomes a `$$HASH$$`
          // placeholder before the model sees it) and deobfuscates ONLY
          // the message_end display event — streamed text_delta deltas
          // carry the RAW provider text. The model relays the placeholder
          // verbatim, so the deltas would leak `$$…$$` into the Slack
          // reply. Prefer the message's content text blocks (the
          // deobfuscated display copy) for the delivered text; the
          // accumulated deltas remain the fallback for paths where the
          // message carries no text blocks. Only ASSISTANT messages carry
          // model-authored text: the SDK emits message_end for
          // user/toolResult messages too, whose content blocks hold the
          // inbound text — without the role gate their content would be
          // delivered back to the channel as if it were the model's
          // reply.
          const isAssistant = message !== null && "role" in message && message.role === "assistant";
          const contentText = isAssistant ? collectTextBlocks(message) : [];
          const deltaText = [...this.#textByIndex.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, part]) => part)
            .join("\n")
            .trim();
          this.#textByIndex.clear();
          const text = contentText.join("\n").trim() || deltaText;
          // Issue #226: an empty ASSISTANT completion still reaches the
          // presenter (which surfaces the visible retry note, or the churn
          // error once EMPTY_TURN_LIMIT trips) — never a silent no-reply.
          // The SDK's agent loop turns failed requests into empty assistant
          // messages; dropping them here made the #60 churn guard count
          // empties it never saw and the turn ended invisible. The cause
          // rides the empty payload so the note names it (#78). Non-assistant
          // message_end events (user/toolResult) carry no model text and
          // never deliver.
          if (isAssistant || text) {
            this.#deliver(text, isAssistant && text === "" ? this.#lastError : undefined);
          }
          break;
        }
        case "turn_start":
          // A fresh turn starts with no cause; only this turn's errors count.
          this.#lastError = undefined;
          this.#emitter.emit("turn_start", { spaceId: deps.spaceId });
          break;
        case "turn_end":
          // Carry the cause (when one exists) so the empty-completion path
          // can surface it instead of the generic phrase (#78). The turn
          // principal is NOT cleared here: the SDK's agent loop emits
          // turn_end after EVERY tool round (willContinue), so a mid-turn
          // round boundary must not drop the binding — the opening prompt's
          // resolution is the true turn end (issue #178).
          this.#emitter.emit("turn_end", { spaceId: deps.spaceId, error: this.#lastError });
          break;
        case "tool_execution_end": {
          // Issue #228 (push path): the todo tool's result carries the
          // authoritative phase snapshot (TodoToolDetails.phases); re-emit
          // it as a driver event so the presenter can render live progress
          // and the in-place plan message. Only the todo tool produces
          // result.details.phases — other tools' results are ignored, and a
          // malformed/absent snapshot is skipped (no active plan is normal,
          // never an error).
          if (event.toolName === "todo") {
            const parsed = todoResultPhasesSchema.safeParse(event.result);
            if (parsed.success) {
              this.#emitter.emit("todo_phases", {
                spaceId: deps.spaceId,
                phases: parsed.data.details.phases,
              });
            }
          }
          break;
        }
        case "notice":
          if (event.level === "error") {
            this.#lastError = event.message;
            this.#emitter.emit("error", { spaceId: deps.spaceId, message: event.message });
          }
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
      if (this.#session.isStreaming || this.#turnReapplyPending) {
        // Mid-turn: the running turn keeps its principal. The SDK's
        // isStreaming flips synchronously inside the prompt() call below,
        // so any prompt racing this one observes it and steers instead —
        // only the message that OPENS a turn binds (issue #152). A fresh
        // turn whose model re-apply is still running (issue #189: the
        // service invokes reapplyDefaultModelRole() before prompt()) is
        // equally in-flight — that seam flips `#turnReapplyPending`
        // synchronously, so a racing prompt still steers into the opening
        // turn instead of opening a second one.
        //
        // Issue #183: when the session reports streaming but NO fresh turn
        // of ours is pending, the streaming run is a GHOST — a continuation
        // (e.g. a queued steer drain after a stream/panel turn) that never
        // settled. Steering into it would queue this message into a dead
        // run: a silent no-reply. Force-settle the ghost (abort) and run
        // this message as a FRESH turn instead — loud log, never silent.
        if (!this.#freshTurnPending && this.#session.isStreaming) {
          console.error(
            `[agent-driver] session reports streaming with no fresh turn pending in ${this.#spaceId} — aborting the ghost run and starting a fresh turn (issue #183)`,
          );
          await this.#session.abort();
        } else if (opts?.streamingBehavior === "followUp") {
          await this.#session.followUp(text);
          return;
        } else {
          await this.#session.steer(text);
          return;
        }
      }
      // Fresh turn: capture the inbound principal with the turn.
      this.#turnPrincipal = opts?.principal;
      this.#freshTurnPending = true;
      try {
        // Issue #183: the opening prompt must leave the session SETTLED —
        // the busy-wait recovery + the post-turn settlement check below
        // guarantee the next prompt never hits the SDK's busy timeout.
        await this.#runFreshTurn(text);
      } finally {
        // The turn truly ends when the OPENING prompt resolves. The SDK's
        // agent loop emits turn_end after EVERY tool round (willContinue
        // true), so clearing here — never in the turn_end event handler —
        // keeps the binding for later rounds of the same turn (issue
        // #178): a continued or retried tool call must carry the turn's
        // principal, not fall back to the bridge's "agent" default.
        this.#turnPrincipal = undefined;
        this.#freshTurnPending = false;
      }
    } finally {
      this.#silentTurn = false;
    }
  }

  /**
   * Runs a FRESH turn with a run-settlement guarantee (issue #183). The
   * SDK's fresh prompt can throw `AgentBusyError` (a run is streaming at
   * prompt entry) or, after the SDK's internal 30s busy-wait, the
   * "Timed out waiting for prior agent run to finish before prompting."
   * error — both mean a prior agent run (e.g. a ghost continuation from the
   * stream/panel path) never settled, and the session would stay wedged for
   * every later message. Recovery: log the reason loudly, abort the stale
   * run (the SDK's abort force-settles it), and retry the turn ONCE. If the
   * retry also fails busy, surface the reason through the driver error
   * event (the presenter replaces the phrase with it) — never a silent
   * no-reply. After the prompt resolves, a session that STILL reports
   * streaming is a ghost run that outlived its turn: it is aborted too, so
   * the next prompt never busy-waits.
   */
  async #runFreshTurn(text: string): Promise<void> {
    try {
      await this.#session.prompt(text);
    } catch (err) {
      if (!(err instanceof Error) || !isBusySettlementError(err)) throw err;
      const reason = err.message;
      console.error(
        `[agent-driver] prior agent run did not settle before prompting in ${this.#spaceId}: ${reason} — aborting the stale run and retrying once`,
      );
      await this.#session.abort();
      try {
        await this.#session.prompt(text);
      } catch (retryErr) {
        // The session stayed wedged even after the forced settle: surface
        // the reason loudly (the presenter shows it) and rethrow.
        const retryReason = retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.error(
          `[agent-driver] session still busy after aborting the stale run in ${this.#spaceId}: ${retryReason}`,
        );
        this.#emitter.emit("error", {
          spaceId: this.#spaceId,
          message: `prior agent run did not settle: ${retryReason}`,
        });
        throw retryErr;
      }
    }
    // A turn's run must ALWAYS settle: a session that still reports
    // streaming after the opening prompt (or its retry) resolved is a ghost
    // run that outlived its turn — abort it (issue #183).
    if (this.#session.isStreaming) {
      console.error(
        `[agent-driver] agent run did not settle after the turn in ${this.#spaceId} — aborting the stale run`,
      );
      await this.#session.abort();
    }
  }

  /** The principal of the current turn (issue #152); undefined between turns. */
  getTurnPrincipal(): string | undefined {
    return this.#turnPrincipal;
  }

  /**
   * Turn-start model hot-swap (issue #189): re-applies the space's
   * "default" model role against the CURRENT org/space settings so a
   * settings change takes effect on the very next turn — no session
   * restart. The space service calls this BEFORE opening a fresh turn
   * (never mid-turn: use_model switches must survive for their turn). The
   * seam flips `#turnReapplyPending` synchronously so a concurrent prompt
   * steers into the opening turn instead of opening a second one.
   * Best-effort by design: any failure is logged and swallowed — a model
   * re-apply must never turn a user's message into a silent no-reply (the
   * turn proceeds on the session's current model).
   */
  async reapplyDefaultModelRole(): Promise<void> {
    this.#turnReapplyPending = true;
    try {
      // A pending use_model switch (fast/reasoning) wins for THIS turn: the
      // re-apply is skipped once so the switch actually runs; the following
      // turn start re-evaluates default against the settings.
      const override = this.#modelRoleOverride;
      this.#modelRoleOverride = undefined;
      if (override === undefined || override === "default") {
        await this.#reapplyDefaultRoleAtTurnStart();
      }
    } finally {
      this.#turnReapplyPending = false;
    }
  }

  /**
   * Resolves the "default" role against the CURRENT org/space settings (the
   * getModelSettings seam) and applies it through the #64 setModel path when
   * it differs from the session's active model/effort — no churn when
   * unchanged. A default that cannot be applied (e.g. its id is not in the
   * session's live catalog — a mid-run settings change to a model the
   * boot-time models.yml does not carry) is logged and skipped.
   */
  async #reapplyDefaultRoleAtTurnStart(): Promise<void> {
    try {
      const settings = await this.#getModelSettings(this.#spaceId);
      const target = resolveRoleTarget("default", settings);
      if (!target.modelId && !target.thinkingLevel) return; // nothing configured
      // Issue #199: resolve the settings value through the provider-aware
      // resolver FIRST so the churn check compares against the model the
      // switch would actually apply (near's DeepSeek-V4-Flash), not the raw
      // "deepseek-v4-flash" that can never match a near id and would force a
      // no-op switch every turn. An unresolvable default throws — the catch
      // below logs loudly and the turn keeps the session's current model.
      const resolvedId =
        target.modelId === undefined ? undefined : this.#resolveModelId(target.modelId, "turn-start default re-apply");
      const current = this.#session.model;
      const modelMatches =
        resolvedId === undefined ||
        (current !== undefined &&
          (current.id === resolvedId || `${current.provider}/${current.id}` === resolvedId));
      const levelMatches =
        target.thinkingLevel === undefined || this.#session.thinkingLevel === target.thinkingLevel;
      if (modelMatches && levelMatches) return; // already running the resolved default
      await this.setModelRole("default");
    } catch (err) {
      console.error(
        `[agent-driver] turn-start default model re-apply failed in ${this.#spaceId} — continuing with the current model: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async abort(): Promise<void> {
    await this.#session.abort();
  }

  isStreaming(): boolean {
    // A fresh turn whose model re-apply is still running counts as busy
    // (issue #189): the caller's stream-vs-fresh decision and racing
    // prompts must steer into the opening turn, never open a second one.
    return this.#session.isStreaming || this.#turnReapplyPending;
  }

  on(event: DriverEvent, cb: (data: DriverEventData) => void): () => void {
    return this.#emitter.on(event, cb);
  }

  /**
   * The session's live todo plan (issue #228, pull path): delegates to the
   * SDK session — the state the `todo` tool writes, rehydrated from the
   * transcript when the session cold-starts.
   */
  getTodoPhases(): TodoPhase[] {
    return this.#session.getTodoPhases();
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
    // SAFETY: DriverThinkingLevel mirrors the SDK Effort runtime strings (SdkThinkingLevel's doc comment); the settings values ARE those strings.
    const thinkingLevel = target.thinkingLevel as SdkThinkingLevel | undefined;
    if (target.modelId) {
      // Issue #199: route the settings value through the provider-aware
      // resolver (unqualified → prefer near; explicit provider qualifiers
      // win) — never hand the raw value to the SDK's registry, which picks
      // the wrong provider's same-named model (opencode-go's #78-broken
      // deepseek).
      const modelId = this.#resolveModelId(target.modelId, `setModelRole(${role})`);
      const model = this.#findModel(modelId);
      if (!model) {
        throw new Error(`model '${modelId}' is not available to this session`);
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
    // The applied switch is the model the session now runs; a non-default
    // role granted here (use_model / work-item pin) wins for the next turn
    // start before the default re-apply resumes (issue #189).
    this.#modelRoleOverride = role;
    return {
      applied: true,
      role,
      model: target.modelId ?? null,
      thinking_level: target.thinkingLevel ?? null,
    };
  }

  /** The session's available models in the pin resolver's catalog shape. */
  #catalog(): ModelCatalogEntry[] {
    return this.#session.getAvailableModels().map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      provider: model.provider,
    }));
  }

  /**
   * Routes a settings model value through the provider-aware pin resolver
   * (issue #199): provider-qualified ids win, unqualified values prefer
   * near (the working deepseek provider), and an unresolvable value throws
   * — the caller decides how to fail closed (the turn-start re-apply logs
   * loudly and keeps the session's current model; use_model surfaces the
   * error to the agent).
   */
  #resolveModelId(raw: string, context: string): string {
    const resolution = resolveModelPin(raw, this.#catalog());
    if (!resolution.ok) {
      throw new Error(`[agent-driver] ${context}: cannot resolve model '${raw}' — ${resolution.error}`);
    }
    if (resolution.pin.kind === "role") {
      throw new Error(`[agent-driver] ${context}: '${raw}' resolved to a role ref, not a model id`);
    }
    // Issue #238: return the provider-qualified id the pin matched — the
    // caller's re-find must never land on the first bare-id provider.
    return `${resolution.pin.provider}/${resolution.pin.modelId}`;
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

  /** The accumulated thinking text across content indexes (issue #193). */
  #accumulatedThinking(): string {
    return [...this.#thinkingByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, part]) => part)
      .join("\n")
      .trim();
  }

  /**
   * Emits the accumulated reasoning as a live "thinking" driver event
   * (issue #193): the plain presenter renders it as the in-place phrase.
   * No-op while nothing has accumulated — unknown/redacted content never
   * reaches the channel (fail closed).
   */
  #emitThinking(): void {
    const thinking = this.#accumulatedThinking();
    if (!thinking) return;
    this.#emitter.emit("thinking", { spaceId: this.#spaceId, thinking });
  }

  #deliver(text: string, error?: string): void {
    // onOutput and the "message" event are the same signal: consume one channel.
    // Silent turns (digest, #42) skip the output callback but still emit, so
    // the caller can capture the text without posting it to the space.
    if (!this.#silentTurn) this.#onOutput(this.#spaceId, text);
    this.#emitter.emit("message", { spaceId: this.#spaceId, text, error });
  }
}
