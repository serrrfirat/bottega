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
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { parseYamlSubset } from "../../yaml-subset";
import type { MemoryProvider } from "../../memory/types";
import { MEMORY_LIMIT_MAX } from "../../memory/types";
import type { SpaceModelSettings } from "../../store/db";
import { renderInjection } from "../../tools/memory-context";
import {
  connectExtensionToolDefinition,
  connectViaAuthBroker,
  type BrokerConnector,
} from "../../extensions/connect";
import type { ExtensionRegistry } from "../../extensions/registry";
import type { AuditModule } from "../../policy/audit";
import type { ApprovalRouter } from "../../policy/approval-router";
import type { PolicyConfig } from "../../policy/config";
import { loadSpacePolicy } from "../../policy/config";
import { evaluatePolicyGate, type PolicyGateOutcome } from "../../policy/gate";
import type { PolicyExtensionDeps } from "../../policy/extension";
import type { Store } from "../../store/db";

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
  "session_search",
  "model_settings",
  "use_model",
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

/**
 * Caller-declared parameter hints for the wrapped built-ins (issue #69).
 * The native implementation validates strictly and rejects bad args with
 * its own schema, so the wrapper only needs a permissive passthrough shape
 * that guides the model without drifting from the SDK's schemas.
 */
const GATE_WRAPPED_BUILTIN_PARAMS: Record<(typeof GATE_WRAPPED_BUILTINS)[number], ReturnType<typeof z.object>> = {
  read: z.object({ path: z.string(), offset: z.number().int().optional(), limit: z.number().int().optional() }).passthrough(),
  glob: z.object({ pattern: z.string(), path: z.string().optional(), limit: z.number().int().optional() }).passthrough(),
  grep: z.object({ pattern: z.string(), path: z.string().optional(), case: z.boolean().optional() }).passthrough(),
  ast_grep: z.object({ pattern: z.string(), path: z.string().optional() }).passthrough(),
  web_search: z.object({ query: z.string() }).passthrough(),
  task: z.object({ description: z.string(), prompt: z.string(), agent: z.string().optional() }).passthrough(),
  write: z.object({ path: z.string(), content: z.string() }).passthrough(),
  edit: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }).passthrough(),
  bash: z.object({ command: z.string(), timeout: z.number().int().optional() }).passthrough(),
};

const GATE_WRAPPED_BUILTIN_DESCRIPTIONS: Record<(typeof GATE_WRAPPED_BUILTINS)[number], string> = {
  read: "Read a file from the workspace. Args: path (string, required), offset (int, optional), limit (int, optional).",
  glob: "List files matching a glob pattern. Args: pattern (string, required), path (string, optional), limit (int, optional).",
  grep: "Search file contents with a regex pattern. Args: pattern (string, required), path (string, optional), case (boolean, optional).",
  ast_grep: "Search code structurally with an AST pattern. Args: pattern (string, required), path (string, optional).",
  web_search: "Search the web. Args: query (string, required).",
  task: "Delegate a task to a subagent. Args: description (string, required), prompt (string, required), agent (string, optional).",
  write: "Write content to a file at path. Args: path (string, required), content (string, required).",
  edit: "Apply a string replacement to a file at path. Args: path (string, required), old_string (string, required), new_string (string, required).",
  bash: "Run a shell command in the workspace. Args: command (string, required), timeout (int, optional).",
};

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
  return { ...def, __isToolDefinition: true } as TDef & { __isToolDefinition: boolean };
}

/**
 * opencode-go gateway tool-name constraint (issue #78): the Console Go
 * gateway validates tool names against `^[a-zA-Z0-9_-]+$` and 400s every
 * request carrying a dotted name (memory.save, memory.search, the
 * namespace extension tools — attio.* / github.* / linear.*), which is why
 * opencode sessions returned empty completions. NEAR/GLM accept dotted
 * names; flat names are accepted by BOTH gateways, so the session's
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
 * Wraps a tool definition so every call crosses the shared policy gate
 * (issue #69): load the space's effective policy, decide (tier × action),
 * audit, and route ask-human through the approval router — then run the
 * original execute only when the call is allowed. A denied call throws the
 * gate's block reason, which the SDK surfaces to the model as a blocked
 * tool result (the same shape the policy extension's `{block: true}`
 * produced). Fail closed: any gate error denies the call.
 */
export function withPolicyGate<TDef extends ToolDefinition>(def: TDef, deps: PolicyExtensionDeps): TDef {
  const execute = def.execute;
  const actor = deps.actor ?? "agent";
  return {
    ...def,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
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
      if (!outcome.allowed) throw new Error(outcome.blockReason);
      return execute.call(def, toolCallId, params, signal, onUpdate, ctx);
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
        return ctx.invokeTool(params as Record<string, unknown>);
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
    const providers = parsed.providers;
    if (providers !== undefined && typeof providers === "object" && !Array.isArray(providers)) {
      declared = Object.keys(providers);
    } else {
      declared = [];
    }
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

/**
 * Guarantees the SDK's agent-dir config.yml carries the `modelRoles` pin
 * from the committed template (issue #78 recurrence). The SDK reads the
 * agent dir's config.yml at session creation; when it lacks the pin, the
 * session silently falls back to the provider catalog default
 * (kimi-k2.7-code for opencode-go) instead of the pinned deepseek-v4-flash
 * — the "OMP repository fallback" — and the Console Go gateway 400s that
 * path (dotted tool names) into empty completions.
 *
 * Operator customizations are never overwritten: a config that already
 * defines `modelRoles` (or that this parser cannot read) is left untouched,
 * and only the pin block is appended to a stale file. When the agent-dir
 * config is missing entirely, the template is copied (the compose-equivalent
 * first boot). Returns what was done for boot logging and tests.
 */
export function ensureAgentDirModelPin(agentDir: string, templatePath: string = OMP_CONFIG_TEMPLATE): "created" | "patched" | "unchanged" | "skipped" {
  const agentConfigPath = join(agentDir, "config.yml");
  let existing: string | null = null;
  try {
    existing = readFileSync(agentConfigPath, "utf8");
  } catch (err) {
    if (!(typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT")) return "skipped";
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
  // Already pinned, or an unparseable file: leave the operator's config alone.
  try {
    const parsed = parseYamlSubset(existing);
    if (parsed.modelRoles !== undefined) return "unchanged";
  } catch {
    return "skipped";
  }
  // Render the template's modelRoles block (e.g. `default: <provider>/<model>`).
  let roleBlock: string | null = null;
  try {
    const templateParsed = parseYamlSubset(template);
    const roles = templateParsed.modelRoles;
    if (roles === undefined || typeof roles !== "object" || Array.isArray(roles)) return "unchanged";
    const lines = Object.entries(roles)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => `  ${key}: ${value}`);
    if (lines.length === 0) return "unchanged";
    roleBlock = `\nmodelRoles:\n${lines.join("\n")}\n`;
  } catch {
    return "skipped";
  }
  appendFileSync(agentConfigPath, roleBlock);
  return "patched";
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
    customTools?: ToolDefinition[];
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
              (GATE_WRAPPED_BUILTINS as readonly string[]).includes(name),
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
          scope: "org",
          metadata: { inject: "1" },
          limit,
        });
        const body = renderInjection(flagged, maxEntries, maxBytes);
        if (body) effectiveAppend = effectiveAppend ? `${effectiveAppend}\n\n${body}` : body;
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
        ...(effectiveAppend ? { appendSystemPrompt: effectiveAppend } : {}),
        // Issue #68: keep the token budget for answers, not reasoning (see
        // the thinkingLevel option on createOmpSdkDriver). The cast bridges
        // the SDK's const-enum typing: Effort members type nominally in
        // declaration files, but the runtime values are the same strings
        // DriverThinkingLevel mirrors.
        thinkingLevel: thinkingLevel as CreateAgentSessionOptions["thinkingLevel"],
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
          // Provider-error path (#78): the SDK's agent loop turns a failed
          // request (e.g. the replay-ordering 400) into an assistant message
          // with empty content + `errorMessage`, so the text below is empty
          // and nothing would be delivered — keep the cause for the
          // turn_end the loop emits right after.
          const errorMessage = (event.message as { errorMessage?: unknown } | null)?.errorMessage;
          if (typeof errorMessage === "string" && errorMessage.trim()) this.#lastError = errorMessage.trim();
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
          // A fresh turn starts with no cause; only this turn's errors count.
          this.#lastError = undefined;
          this.#emitter.emit("turn_start", { spaceId: deps.spaceId });
          break;
        case "turn_end":
          // Carry the cause (when one exists) so the empty-completion path
          // can surface it instead of the generic phrase (#78).
          this.#emitter.emit("turn_end", { spaceId: deps.spaceId, error: this.#lastError });
          break;
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
