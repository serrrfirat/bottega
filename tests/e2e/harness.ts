/**
 * E2E harness (issue #66): the REAL bottega stack with emulated boundaries.
 *
 * Every component a journey exercises is the production component:
 *   - store          real SQLite on a temp file (src/store/db.ts)
 *   - audit / policy real audit module + org config + per-space overlay
 *   - memory         real SQLite provider sharing the store's db handle
 *   - driver         real `createOmpSdkDriver` with the project wiring
 *                    (policy gate on the custom-tools bridge, work items,
 *                    memory tools, memory-context injection via the
 *                    appendSystemPrompt seam — issue #69) — pointed at the
 *                    model stub by a per-test models.yml `baseUrl` override
 *                    in a temp agent dir
 *   - spaceService   real SpaceService (thinking phrases, digest-on-idle,
 *                    response modes)
 *   - Slack          real adapter (`createSlackAdapter`) for OUTBOUND
 *                    (chat.postMessage / chat.update hit @emulators/slack);
 *                    INBOUND is driven through the real Bolt router via
 *                    `app.processEvent` (the #29 seam — the exact function
 *                    `createSlackAdapter` installs on its app), so no
 *                    socket connection and no Slack API call ever runs
 *   - model          a local OpenAI-compatible stub (Bun.serve) scripted
 *                    per test: text replies and tool calls, both streaming
 *                    (SSE) and non-streaming request shapes, never empty
 *                    (an exhausted script falls back to a plain "ok" turn)
 *
 * Boundaries that stay emulated: Slack (emulator), the model (stub), and
 * the filesystem (temp dirs). Docker legs (mem0, iron-proxy, real OMP)
 * stay skip-gated — this harness is hermetic and CI-safe.
 *
 * Live-Slack canary mode (issue #79): `bootHarness({ realSlack: true,
 * realModel: true, slackTokens })` swaps BOTH boundaries for the real
 * product surface — the production Socket Mode adapter (real workspace,
 * real tokens) and the real model provider (the #71 deployment model
 * catalog, config/omp/models.yml, keys from env/Keychain). Inbound is
 * driven through the real API as the QA user (chat.postMessage as_user)
 * and outbound is read back via conversations.history. This mode NEVER
 * runs in CI and is skip-gated on tokens; the QA canary runner
 * (tests/e2e/canary.ts) owns that gate.
 */
import { App, type Logger } from "@slack/bolt";
import { createServer } from "@emulators/core";
import slackPlugin, { getSlackStore, seedFromConfig } from "@emulators/slack";
import type { SlackStore } from "@emulators/slack";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "../../src/store/db";
import { createStore } from "../../src/store/db";
import type { AuditModule } from "../../src/policy/audit";
import { createAudit } from "../../src/policy/audit";
import type { ApprovalRouter } from "../../src/policy/approval-router";
import { loadOrgConfig, loadSpacePolicy, type PolicyConfig } from "../../src/policy/config";
import type { MemoryProvider } from "../../src/memory/types";
import { createSqliteMemoryProvider, pruneDigestMemories } from "../../src/memory/sqlite";
import { workItemToolDefinitions } from "../../src/tools/work-items";
import { memoryToolDefinitions } from "../../src/tools/memory";
import type { ExtensionRegistry } from "../../src/extensions/registry";
import { createExtensionRegistry } from "../../src/extensions/registry";
import { createExtensionRuntime } from "../../src/extensions/runtime";
import { extensionToolDefinitions } from "../../src/extensions/tools";
import { connectViaAuthBroker, type BrokerConnector, type ConnectExtensionDeps } from "../../src/extensions/connect";
import { bootLiveSlack, type LiveSlackHandle, type LiveSlackTokens } from "./slack-live";
import type { McpBinding } from "../../src/extensions/manifest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import type { AgentDriver } from "../../src/server/drivers/agent-driver";
import { createOmpSdkDriver } from "../../src/server/drivers/agent-driver";
import {
  createSlackAdapter,
  registerActionHandler,
  registerMessageHandler,
  type SlackAction,
  type SlackAdapter,
} from "../../src/server/adapters/slack";
import { SpaceService } from "../../src/server/services/space-service";

/** Bot token seeded into the Slack emulator; the adapter authenticates with it. */
const BOT_TOKEN = "xoxb-bottega-e2e-test";
/** App token for the inbound Bolt app; never used (no socket, #29 seam). */
const APP_TOKEN = "xapp-bottega-e2e-test";
/** Seeded emulator users: the bot's identity and the human. */
const BOT_USER_NAME = "bottega";
const HUMAN_USER_NAME = "owner";
/** The model catalog entry the stub serves. */
const STUB_PROVIDER = "e2e-stub";
const STUB_MODEL_ID = "stub-v1";
export const STUB_MODEL_REF = `${STUB_PROVIDER}/${STUB_MODEL_ID}`;

// ---------------------------------------------------------------------------
// Model stub
// ---------------------------------------------------------------------------

/** One scripted tool call the model stub returns. */
export interface StubToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** One scripted model turn: a plain text reply or one or more tool calls. */
export type StubTurn =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: StubToolCall[]; text?: string };

/** A parsed /chat/completions request the stub received (for assertions). */
export interface StubRequest {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: unknown }>;
}

/** Fallback turn when the script is exhausted or empty — reasoning-safe. */
const DEFAULT_TURN: StubTurn = { type: "text", text: "ok" };

/**
 * OpenAI-compatible chat completions stub. Serves both `stream: true`
 * (SSE, the shape the OMP SDK requests) and plain JSON responses, records
 * every request for assertions, and resolves waiters so tests park on the
 * Nth request instead of sleeping.
 */
export interface ModelStub {
  /** `http://127.0.0.1:<port>/v1` — the models.yml `baseUrl` override. */
  baseUrl: string;
  /** Every `/chat/completions` request, in arrival order (deep-copied). */
  requests: StubRequest[];
  /** Replaces the scripted turn queue (the last entry repeats when exhausted). */
  respond(turns: StubTurn[]): void;
  /** Appends one turn to the queue. */
  push(turn: StubTurn): void;
  /** Resolves once at least `n` requests have arrived (rejects on timeout). */
  waitForRequests(n: number, timeoutMs?: number): Promise<void>;
  /** The latest request's messages (assertion convenience). */
  latestMessages(): StubRequest["messages"];
  stop(): void;
}

function createModelStub(): ModelStub {
  let turns: StubTurn[] = [];
  const requests: StubRequest[] = [];
  const waiters: Array<() => void> = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: STUB_MODEL_ID, object: "model" }] });
      }
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as {
        model?: string;
        stream?: boolean;
        messages?: Array<{ role: string; content: unknown }>;
        stream_options?: { include_usage?: boolean };
      };
      requests.push({
        model: String(body.model ?? ""),
        stream: body.stream === true,
        messages: (body.messages ?? []).map((m) => ({ role: m.role, content: m.content })),
      });
      while (waiters.length > 0) waiters.shift()!();

      const turn = turns.length > 0 ? (turns.shift() as StubTurn) : DEFAULT_TURN;
      // Realistic model latency: the space service posts a thinking phrase
      // at turn_start and replaces it when the reply lands — an instant
      // response can race the phrase post's ts capture, so the stub waits
      // like a real model would.
      await Bun.sleep(50);
      if (body.stream === true) {
        return new Response(streamingSseBody(turn, body.stream_options?.include_usage === true), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      return Response.json(jsonBody(turn));
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    respond(next: StubTurn[]) {
      turns = [...next];
    },
    push(turn: StubTurn) {
      turns.push(turn);
    },
    waitForRequests(n: number, timeoutMs = 15_000): Promise<void> {
      if (requests.length >= n) return Promise.resolve();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timer = setTimeout(() => {
        reject(new Error(`model stub: timed out after ${timeoutMs}ms waiting for ${n} requests (got ${requests.length})`));
      }, timeoutMs);
      timer.unref?.();
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push(wake);
      return promise;
    },
    latestMessages() {
      return requests.length > 0 ? requests[requests.length - 1]!.messages : [];
    },
    stop() {
      server.stop(true);
    },
  };
}

function sseChunk(payload: unknown): string {
  const base = {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model: STUB_MODEL_ID,
    choices: payload,
  };
  return `data: ${JSON.stringify(base)}\n\n`;
}

function sseUsageChunk(): string {
  return [
    "data: ",
    JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: 1,
      model: STUB_MODEL_ID,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    "\n\n",
  ].join("");
}

function streamingSseBody(turn: StubTurn, includeUsage: boolean): string {
  const chunks: string[] = [];
  if (turn.type === "tool_calls") {
    chunks.push(
      sseChunk([
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: turn.calls.map((call, i) => ({
              index: i,
              id: `call_e2e_${i}`,
              type: "function",
              function: { name: call.name, arguments: "" },
            })),
          },
          finish_reason: null,
        },
      ]),
    );
    for (const call of turn.calls) {
      chunks.push(
        sseChunk([
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { name: call.name, arguments: JSON.stringify(call.args) } }] },
            finish_reason: null,
          },
        ]),
      );
    }
    chunks.push(sseChunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]));
  } else {
    const text = turn.text.trim() || "ok";
    chunks.push(sseChunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]));
    chunks.push(sseChunk([{ index: 0, delta: { content: text }, finish_reason: null }]));
    chunks.push(sseChunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
  }
  if (includeUsage) chunks.push(sseUsageChunk());
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

function jsonBody(turn: StubTurn): Record<string, unknown> {
  if (turn.type === "tool_calls") {
    return {
      id: "chatcmpl-e2e",
      object: "chat.completion",
      created: 1,
      model: STUB_MODEL_ID,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: turn.text ?? null,
            tool_calls: turn.calls.map((call, i) => ({
              id: `call_e2e_${i}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
  return {
    id: "chatcmpl-e2e",
    object: "chat.completion",
    created: 1,
    model: STUB_MODEL_ID,
    choices: [
      { index: 0, message: { role: "assistant", content: turn.text.trim() || "ok" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

// ---------------------------------------------------------------------------
// Slack emulator + inbound Bolt app
// ---------------------------------------------------------------------------

export interface SlackEmulatorHandle {
  /** `http://127.0.0.1:<port>` — the adapter's `clientOptions.slackApiUrl` base. */
  baseUrl: string;
  /** The emulator's backing store (assert outbound messages here). */
  store: SlackStore;
  /** Channel id by seeded name ("ops", "general", …). */
  channelId(name: string): string | undefined;
  /** User id by seeded name ("owner", "bottega", …). */
  user(name: string): string | undefined;
  /** The seeded is_im DM channel id between the bot and the human. */
  dmChannelId: string;
  stop(): void;
}

/** A stored emulator message (outbound assertion shape). */
export interface EmulatorMessage {
  ts: string;
  channel_id: string;
  user: string;
  text: string;
  thread_ts?: string;
}

/**
 * The Slack boundary both modes expose: the emulator handle (live store)
 * and the live handle (cached API mirror) implement this shape, so harness
 * callers never branch on the mode for sync lookups. Live reads go through
 * {@link Harness.liveSlack} instead (fresh API reads).
 */
export interface SlackHandle {
  /** `http://127.0.0.1:<port>` (emulator) or "" (live). */
  baseUrl: string;
  /** Outbound message store: emulator storage, or a live history mirror. */
  store: {
    messages: { all(): EmulatorMessage[] };
    users: { findOneBy(field: string, value: string): { user_id?: string } | undefined };
    channels: { findOneBy(field: string, value: string): { channel_id?: string } | undefined };
  };
  /** DM channel id between the bot and the human (emulator) / QA user (live). */
  dmChannelId: string;
  channelId(name: string): string | undefined;
  user(name: string): string | undefined;
  stop(): void;
}

function bootSlackEmulator(): SlackEmulatorHandle {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);

  const emu = createServer(slackPlugin, { baseUrl: `http://127.0.0.1:${port}` });
  seedFromConfig(emu.store, emu.baseUrl, {
    team: { name: "Bottega E2E Workspace" },
    users: [{ name: HUMAN_USER_NAME }, { name: BOT_USER_NAME }],
    channels: [{ name: "ops" }],
    tokens: [{ token: BOT_TOKEN, user: BOT_USER_NAME }],
  });

  const slack = getSlackStore(emu.store);
  const botUser = slack.users.findOneBy("name", BOT_USER_NAME)!;
  const humanUser = slack.users.findOneBy("name", HUMAN_USER_NAME)!;
  // Seed a DM channel so the DM journey is deterministic: inbound events can
  // use this id and outbound replies resolve it (the emulator would
  // otherwise auto-create DMs only for real user ids, not arbitrary D ids).
  const dm = slack.channels.insert({
    channel_id: `D${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
    team_id: slack.teams.all()[0]?.team_id ?? "T000000001",
    name: HUMAN_USER_NAME,
    is_channel: false,
    is_private: true,
    is_im: true,
    is_mpim: false,
    user: humanUser.user_id,
    is_archived: false,
    topic: { value: "", creator: botUser.user_id, last_set: Math.floor(Date.now() / 1000) },
    purpose: { value: "", creator: botUser.user_id, last_set: Math.floor(Date.now() / 1000) },
    members: [botUser.user_id, humanUser.user_id],
    creator: botUser.user_id,
    num_members: 2,
  });

  const http = Bun.serve({ port, fetch: emu.app.fetch });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store: slack,
    channelId(name: string) {
      return slack.channels.findOneBy("name", name)?.channel_id;
    },
    user(name: string) {
      return slack.users.findOneBy("name", name)?.user_id;
    },
    dmChannelId: dm.channel_id,
    stop() {
      http.stop(true);
    },
  };
}

const QUIET_LOGGER = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  getLevel: () => 0,
  setLevel: () => {},
  setName: () => {},
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A router that can also resolve inbound button clicks (journey 2). */
export type HarnessApprovalRouter = ApprovalRouter & {
  handleAction?(a: SlackAction): Promise<void>;
};

/** The canary model refs (issue #71): the deployment template's providers (config/omp/models.yml). */
export const CANARY_MODEL_REFS = {
  /** Primary (issue #37): deepseek-v4-flash via the built-in opencode-go provider. */
  opencode: "opencode-go/deepseek-v4-flash",
  /** Fallback (issue #36): NEAR AI Cloud gateway. */
  near: "near/zai-org/GLM-5.1-FP8",
} as const;

/**
 * Picks the canary default model from the environment:
 *   - `CANARY_MODEL_REF`, when set, wins (explicit override);
 *   - else the NEAR fallback (`near/zai-org/GLM-5.1-FP8`) — the provider
 *     that ACCEPTS the space agent's dotted tool names (memory.save,
 *     memory.search, extension tools). The opencode-go gateway (Console Go)
 *     validates tool names against `^[a-zA-Z0-9_-]+$` and 400s on them
 *     (live canary finding, issue #71), so the opencode-go primary is used
 *     only as a last resort — journeys on it fail loudly with the
 *     transcript captured, which is the canary's diagnosis job.
 * Returns null when no key is available.
 */
export function pickRealModelRef(env: Record<string, string | undefined> = process.env): string | null {
  if (env.CANARY_MODEL_REF) return env.CANARY_MODEL_REF;
  if (env.NEAR_API_KEY) return CANARY_MODEL_REFS.near;
  if (env.OPENCODE_API_KEY) return CANARY_MODEL_REFS.opencode;
  return null;
}

export interface HarnessConfig {
  /** Scripted model turns; defaults to a single "ok" text turn (repeats). */
  modelTurns?: StubTurn[];
  /**
   * Canary mode (issue #71): the driver resolves the REAL provider — the
   * temp agent dir gets the deployment model catalog (config/omp/models.yml:
   * opencode-go primary, NEAR fallback; keys from env/Keychain) instead of
   * the stub override, and the default model role pins a real model ref.
   * The stub stays up for /v1/models-style needs; agent turns hit the real
   * gateway and model-stub requests are never asserted in canary mode.
   */
  realModel?: boolean;
  /** Canary mode: the default-role model ref; defaults to {@link pickRealModelRef}. */
  realModelRef?: string;
  /** Org policy `config.yml` text; defaults to no file → default policy. */
  orgConfigYaml?: string;
  /** Per-space policy overlay: spaceId → policy_json (e.g. response_mode). */
  spacePolicy?: Record<string, string>;
  /** SpaceService idle timeout; default 30s (journeys use ~50ms). */
  idleTimeoutMs?: number;
  /** Approval router for ask-human tool calls; defaults to auto-approve. */
  approve?: HarnessApprovalRouter;
  /** Extension registry override (fixture registries); defaults to the pinned snapshots dir. */
  registry?: ExtensionRegistry;
  /** MCP transport factory injected into the real extension runtime. */
  mcpTransport?: (binding: McpBinding) => Transport;
  /**
   * Extra SDK tool definitions merged into the session's customTools
   * (already-gated tools — e.g. registry extension tools that run through
   * the #53 runtime; the driver never double-wraps them).
   */
  customTools?: ToolDefinition[];
  /**
   * Extra SDK tool definitions the driver's policy gate must wrap before
   * execution (issue #69) — the same bucket as the memory/work-item tools.
   * A factory receives the harness's live store/audit/registry (journeys
   * wiring tools that depend on them — e.g. the admin tools, issue #73).
   */
  gatedTools?:
    | ToolDefinition[]
    | ((deps: { store: Store; audit: AuditModule; registry: ExtensionRegistry }) => ToolDefinition[]);
  /** Connect capability (issue #52/#61); omitted → the connect seams are absent. */
  connect?: ConnectExtensionDeps;
  /**
   * Live-Slack canary mode (issue #79): use the REAL Socket Mode adapter
   * against the workspace tokens instead of the emulator + processEvent.
   * Inbound posts as the QA user (chat.postMessage as_user); outbound is
   * read back via conversations.history. NEVER in CI; requires
   * {@link slackTokens} — see tests/e2e/canary.ts for the skip gate.
   */
  realSlack?: boolean;
  /** Workspace tokens for {@link realSlack}; required when realSlack is set. */
  slackTokens?: LiveSlackTokens;
  /**
   * Live canary connect wiring (issue #79): like {@link connect} but the
   * harness supplies its own store/audit/registry — only the broker seam is
   * caller's (defaults to the production connectViaAuthBroker).
   */
  liveConnect?: { broker?: BrokerConnector; timeoutMs?: number };
}

export interface Harness {
  store: Store;
  audit: AuditModule;
  memory: MemoryProvider;
  driver: AgentDriver;
  spaceService: SpaceService;
  adapter: SlackAdapter;
  /** The real Bolt app with the message + action handlers installed. */
  app: App;
  modelStub: ModelStub;
  slack: SlackHandle;
  /** Defined in realSlack mode: the live handle (fresh API reads, QA user identity). */
  liveSlack?: LiveSlackHandle;
  extensionRegistry: ExtensionRegistry;
  orgPolicy: PolicyConfig;
  /** The model ref pinned as the session default role (stub ref, or the real ref in canary mode). */
  modelRef: string;
  /** Temp OMP agent dir (models.yml + config.yml live here). */
  agentDir: string;
  /** Temp org config dir (bottega config.yml). */
  configDir: string;
  transcriptDir: string;
  /** Inbound Slack message through the real Bolt router (#29 seam). */
  deliverMessage(channelId: string, text: string, extra?: Record<string, unknown>): Promise<void>;
  /** Inbound block-action click through the real Bolt router (#44 seam). */
  deliverAction(action: {
    actionId: string;
    value: string;
    channelId: string;
    messageTs: string;
    user?: string;
  }): Promise<void>;
  /** Outbound messages stored by the emulator, optionally per channel. */
  messages(channelId?: string): EmulatorMessage[];
  /** Disposes sessions (digests on idle) and stops every server, then removes temp dirs. */
  cleanup(): Promise<void>;
}

/** Auto-approving router: write-tier tool calls (e.g. memory.save) run without a click. */
export const AutoApproveRouter: ApprovalRouter = {
  async request() {
    return { approved: true, approver: "U-e2e-harness" };
  },
};

let tsCounter = 0;
const BASE_TS_SECONDS = Math.floor(Date.now() / 1000);
function nextTs(): string {
  tsCounter += 1;
  return `${BASE_TS_SECONDS}.${String(tsCounter).padStart(6, "0")}`;
}

/**
 * Boots the real stack with emulated boundaries. Call {@link Harness.cleanup}
 * in a finally (or afterEach) — it is idempotent.
 */
export async function bootHarness(cfg: HarnessConfig = {}): Promise<Harness> {
  const realSlack = cfg.realSlack === true;
  if (realSlack && !cfg.slackTokens) {
    throw new Error(
      "bootHarness({ realSlack: true }) requires slackTokens — the live leg never runs without " +
        "workspace tokens (issue #79); use tests/e2e/canary.ts, which skip-gates on them",
    );
  }
  const tempDir = mkdtempSync(join(tmpdir(), "bottega-e2e-"));
  const configDir = join(tempDir, "config");
  const agentDir = join(tempDir, "omp-agent");
  const transcriptDir = join(tempDir, "sessions");
  const dbPath = join(tempDir, "bottega.db");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // The SDK's model registry reads models.yml from the PROCESS-global agent
  // dir (`getAgentDir()`), not from the session's agentDir option — so the
  // per-harness temp dir is installed globally (the #9 seam). Session
  // settings (config.yml) still come from the explicit agentDir option.
  setAgentDir(agentDir);

  // --- model stub + temp agent dir (models.yml baseUrl override) -----------
  const modelStub = createModelStub();
  if (cfg.modelTurns !== undefined) modelStub.respond(cfg.modelTurns);
  // Canary mode (issue #71): the agent dir gets the DEPLOYMENT model catalog
  // (config/omp/models.yml — opencode-go primary, NEAR fallback, keys from
  // env, never a stub baseUrl), so the driver resolves the real gateway.
  // The stub stays up for /v1/models-style needs; agent turns hit the real
  // provider and its requests are never asserted in canary mode.
  let modelRef: string;
  if (cfg.realModel === true) {
    const realModelRef = cfg.realModelRef ?? pickRealModelRef();
    if (realModelRef === null) {
      throw new Error(
        "canary harness: no model key in env — set OPENCODE_API_KEY or NEAR_API_KEY " +
          "(`bun run canary` loads both from the Keychain, the dev.sh pattern)",
      );
    }
    modelRef = realModelRef;
    const templatePath = join(import.meta.dir, "../../config/omp/models.yml");
    let template: string;
    try {
      template = readFileSync(templatePath, "utf8");
    } catch {
      throw new Error(`canary harness: missing model catalog template at ${templatePath}`);
    }
    writeFileSync(join(agentDir, "models.yml"), template);
  } else {
    modelRef = STUB_MODEL_REF;
    writeFileSync(
      join(agentDir, "models.yml"),
      [
        "providers:",
        `  ${STUB_PROVIDER}:`,
        "    api: openai-completions",
        `    baseUrl: "${modelStub.baseUrl}"`,
        '    apiKey: "e2e-test-key"',
        "    models:",
        `      - id: ${STUB_MODEL_ID}`,
        '        name: "E2E Stub Model"',
        "        contextWindow: 128000",
        "        maxTokens: 4096",
        "",
      ].join("\n"),
    );
  }
  // Pin the session's default model deterministically (CI and local alike):
  // settings are read from this agent dir, never the developer's ~/.omp.
  writeFileSync(join(agentDir, "config.yml"), ["modelRoles:", `  default: ${modelRef}`, ""].join("\n"));

  // --- store / audit / policy / memory -------------------------------------
  const store = createStore(dbPath);
  const audit = createAudit(store);
  if (cfg.orgConfigYaml !== undefined) {
    writeFileSync(join(configDir, "config.yml"), cfg.orgConfigYaml);
  }
  const orgPolicy = loadOrgConfig(configDir);
  const memoryProvider = createSqliteMemoryProvider(store.getDb());

  // --- Slack: emulator (outbound) + adapter + Bolt app (inbound, #29) ------
  // realSlack mode (issue #79) replaces the emulator boundary with the REAL
  // Socket Mode adapter: inbound arrives over the socket from the workspace,
  // outbound posts to it. Everything downstream (space service, driver,
  // policy) is identical either way.
  const slack: SlackHandle = realSlack
    ? await bootLiveSlack(cfg.slackTokens!)
    : bootSlackEmulator();
  const liveSlack = realSlack ? (slack as LiveSlackHandle) : undefined;
  // Per-space policy overlays accept a space id ("slack:C…"), a seeded
  // channel name ("ops"), or a raw channel id.
  for (const [spaceKey, policyJson] of Object.entries(cfg.spacePolicy ?? {})) {
    const channelId = spaceKey.startsWith("slack:")
      ? spaceKey.slice("slack:".length)
      : (slack.channelId(spaceKey) ?? spaceKey);
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: channelId });
    await store.updatePolicy(space.id, policyJson);
  }
  const responseModeFor = async (spaceId: string) => (await loadSpacePolicy(orgPolicy, store, spaceId)).responseMode;
  const humanUserId = realSlack ? liveSlack!.qaUserId : slack.user(HUMAN_USER_NAME)!;
  const botUserId = realSlack ? liveSlack!.botUserId : slack.user(BOT_USER_NAME)!;
  let spaceService: SpaceService;
  let approvalRouter: HarnessApprovalRouter;
  const adapter = createSlackAdapter(
    realSlack
      ? {
          appToken: cfg.slackTokens!.appToken,
          botToken: cfg.slackTokens!.botToken,
          onMessage: (m) => spaceService.handleInboundMessage(m),
          onAction: async (a) => {
            await approvalRouter.handleAction?.(a);
          },
          responseModeFor,
        }
      : {
          appToken: APP_TOKEN,
          botToken: BOT_TOKEN,
          onMessage: (m) => spaceService.handleInboundMessage(m),
          onAction: async (a) => {
            await approvalRouter.handleAction?.(a);
          },
          clientOptions: { slackApiUrl: `${slack.baseUrl}/api` },
          responseModeFor,
        },
  );
  // Approval router seam (issue #44): default auto-approve so write-tier
  // tool calls flow in journey 1; journeys that test approvals pass their
  // own router (the Slack button router posts through the harness adapter).
  approvalRouter = cfg.approve ?? AutoApproveRouter;

  // --- driver: real OMP SDK pointed at the stub ----------------------------
  const extensionRegistry = cfg.registry ?? createExtensionRegistry("config/extensions");
  // Connect capability (issue #52/#61): the caller's full deps, or the live
  // canary's convenience wiring (issue #79) — the harness's own
  // store/audit/registry with the production broker seam.
  const connectDeps: ConnectExtensionDeps | undefined =
    cfg.connect ??
    (cfg.liveConnect !== undefined
      ? {
          registry: extensionRegistry,
          store,
          audit,
          broker: cfg.liveConnect.broker ?? connectViaAuthBroker,
          gate: {
            loadPolicy: async (spaceId) => loadSpacePolicy(orgPolicy, store, spaceId),
            router: approvalRouter,
            ...(cfg.liveConnect.timeoutMs !== undefined ? { timeoutMs: cfg.liveConnect.timeoutMs } : {}),
          },
        }
      : undefined);
  /** Manifest tier of an extension tool, shared by the policy extension and the runtime gate (issue #53). */
  const extensionToolTier = (toolName: string) => {
    const extensionId = extensionRegistry.extensionIdForTool(toolName);
    if (extensionId === undefined) return undefined;
    return extensionRegistry.resolve(extensionId)?.manifest.tools.find((tool) => tool.name === toolName)?.tier;
  };
  // Extension tool runtime (issue #53): every extension tool call crosses
  // the policy gate → credential ladder → egress boundary → audit.
  const extensionRuntime = createExtensionRuntime({
    registry: extensionRegistry,
    store,
    audit,
    orgPolicy,
    router: approvalRouter,
    ...(cfg.mcpTransport !== undefined ? { mcpTransport: cfg.mcpTransport } : {}),
  });
  // Memory/work-item tools ride the gated customTools path (issue #69):
  // restricted SDK sessions drop extension-registered tools, so the shared
  // definitions (the same ones the extensions register) surface here and
  // cross the driver-level policy gate before executing.
  const memoryTools = memoryToolDefinitions(memoryProvider, { audit });
  const workItemTools = workItemToolDefinitions(store, { orgPolicy });
  const extraGatedTools =
    typeof cfg.gatedTools === "function" ? cfg.gatedTools({ store, audit, registry: extensionRegistry }) : cfg.gatedTools ?? [];
  const driver = createOmpSdkDriver({
    agentDir,
    customTools: [
      ...(cfg.customTools ?? []),
      ...extensionToolDefinitions(extensionRegistry.list(), { runtime: extensionRuntime }),
    ],
    // Policy gate on the custom-tools bridge (issue #69): the extension
    // seam is inert under restrictToolNames, so the gate wraps the gated
    // definitions AND the allowlisted built-ins (read/glob/grep/task/...).
    gate: {
      orgPolicy,
      audit,
      router: approvalRouter,
      store,
      toolExtensionId: (name) => extensionRegistry.extensionIdForTool(name),
      toolTier: (name) => extensionToolTier(name),
      knownExtensionIds: extensionRegistry.list().map((r) => r.manifest.id),
      tools: [...memoryTools, ...workItemTools, ...extraGatedTools],
    },
    // Connect capability (issue #52): connect_extension is built per
    // session so the actor is the requesting principal.
    ...(connectDeps !== undefined
      ? {
          connectExtension: {
            registry: connectDeps.registry,
            store: connectDeps.store,
            audit: connectDeps.audit,
            broker: connectDeps.broker,
            loadPolicy: connectDeps.gate.loadPolicy,
            router: connectDeps.gate.router,
            timeoutMs: connectDeps.gate.timeoutMs,
          },
        }
      : {}),
    memoryContext: {
      provider: memoryProvider,
      enabled: orgPolicy.memory.injection.enabled,
      maxEntries: orgPolicy.memory.injection.maxEntries,
    },
  });

  // --- space service ---------------------------------------------------------
  spaceService = new SpaceService({
    store,
    adapter,
    driver,
    responseModeFor,
    memoryProvider,
    digestPrune: (spaceId, keep) => {
      pruneDigestMemories(store.getDb(), spaceId, keep);
    },
    idleTimeoutMs: cfg.idleTimeoutMs ?? 30_000,
    transcriptDir,
    ...(connectDeps !== undefined ? { connect: connectDeps } : {}),
  });

  // --- inbound Bolt app (the #29 seam) ----------------------------------------
  // Emulator mode: the harness's own app routes processEvent-injected
  // events (never started). Live mode: the ADAPTER's app owns the Socket
  // Mode receiver — inbound arrives from the real workspace over the
  // socket — so this app is inert and no handlers are installed on it.
  const app = new App({
    appToken: realSlack ? cfg.slackTokens!.appToken : APP_TOKEN,
    // The default HTTP receiver requires a signing secret at construction;
    // it is never started, so nothing listens or talks to Slack.
    signingSecret: "test-signing-secret",
    tokenVerificationEnabled: false,
    authorize: async () => ({ botToken: realSlack ? cfg.slackTokens!.botToken : BOT_TOKEN }),
    logger: QUIET_LOGGER,
  });
  if (!realSlack) {
    registerMessageHandler(app, (m) => spaceService.handleInboundMessage(m), {
      responseModeFor,
      botUserId: () => botUserId,
    });
    registerActionHandler(app, async (a) => {
      await approvalRouter.handleAction?.(a);
    });
  }

  // Live mode: connect the Socket Mode websocket — inbound events only
  // arrive once the adapter is started (it also resolves the bot user id
  // for mention filtering via auth.test).
  if (realSlack) await adapter.start();

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await spaceService.stop();
    } finally {
      // Live mode: close the Socket Mode websocket; emulator mode the
      // adapter's app was never started, so there is nothing to stop.
      if (realSlack) await adapter.stop();
      slack.stop();
      modelStub.stop();
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };

  return {
    store,
    audit,
    memory: memoryProvider,
    driver,
    spaceService,
    adapter,
    app,
    modelStub,
    slack,
    extensionRegistry,
    orgPolicy,
    modelRef,
    agentDir,
    configDir,
    transcriptDir,
    async deliverMessage(channelId, text, extra = {}) {
      if (realSlack) {
        // Live mode: post through the REAL API as the QA user; the message
        // event then arrives over the Socket Mode websocket exactly like a
        // human's (extra event fields are an emulator-only affordance).
        await liveSlack!.postAsUser(channelId, text);
        return;
      }
      await app.processEvent({
        body: {
          type: "event_callback",
          event: { type: "message", channel: channelId, user: humanUserId, text, ts: nextTs(), ...extra },
        },
        ack: async () => {},
      });
    },
    async deliverAction({ actionId, value, channelId, messageTs, user = humanUserId }) {
      if (realSlack) {
        // Slack buttons cannot be clicked through the API — live journeys
        // use the always-approve router instead (issue #79).
        throw new Error(
          "deliverAction is unavailable in realSlack mode: Slack approval buttons cannot be " +
            "clicked via the API; use the always-approve router (issue #79)",
        );
      }
      await app.processEvent({
        body: {
          type: "block_actions",
          team: { id: "T1" },
          channel: { id: channelId },
          user: { id: user },
          message: { ts: messageTs },
          actions: [{ type: "button", action_id: actionId, value }],
        },
        ack: async () => {},
      });
    },
    // Live mode note: `messages` reflects the mirror's last refresh —
    // prefer `liveSlack.history(channelId)` for fresh reads (canary).
    messages(channelId?: string) {
      const all = slack.store.messages.all();
      return channelId ? all.filter((m) => m.channel_id === channelId) : all;
    },
    ...(liveSlack !== undefined ? { liveSlack } : {}),
    cleanup,
  };
}
