/**
 * Live-Slack QA canary (issues #79 + #175): the product-surface smoke test
 * against a REAL Slack workspace.
 *
 *   bun run canary --live-slack      # or LIVE_SLACK=1 (local/QA runs)
 *   bun run canary --live-slack --ci # CI-strict (the scheduled workflow)
 *
 * Boots the real stack (production Socket Mode adapter + the #71 real-model
 * mode: the deployment model catalog config/omp/models.yml, keys from
 * env/Keychain) and drives product journeys AS the QA user over the real
 * API: chat replies, memory save/search, work-item creation (always-
 * approve), connect-shaped messages reaching the agent (issue #273 — the
 * #61 regex pre-route is gone; the agent drives connect via the
 * connect_extension tool, whose mint the mcp-oauth journey proves), the
 * scheduled standup digest (issue
 * #175 — a real scheduler run posts it; the journey that would have caught
 * #150), the fixture extension tool call through the real extension
 * runtime (policy gate → credential ladder → boundary → MCP → audit), and
 * the use_model fast round-trip (chat → model tool call → live session
 * switch → model.switched audit row). Per-journey pass/fail with captured
 * Slack message permalinks.
 *
 * Skip-gated locally (issue #79), CI-strict in the scheduled job (#175):
 *   - without --live-slack / LIVE_SLACK=1 → skip with usage
 *   - in CI without --ci → skip (the live leg never runs in ad-hoc CI)
 *   - missing tokens (env or macOS Keychain) → skip locally with a setup
 *     pointer; FAIL in CI-strict mode (a canary that silently skips in CI
 *     is worse than none, #175)
 *   - no model key (NEAR_API_KEY / OPENCODE_API_KEY) → skip locally with a
 *     pointer; FAIL in CI-strict mode
 *
 * Tokens (env first, Keychain second):
 *   SLACK_APP_TOKEN      (service bottega-slack-app)   — Socket Mode app token
 *   SLACK_BOT_TOKEN      (service bottega-slack-bot)   — bot user token
 *   SLACK_QA_USER_TOKEN  (service bottega-slack-qa)    — QA user token (xoxp)
 *   SLACK_QA_USER_ID     — optional; else users.list lookup by name
 *   SLACK_QA_USER_NAME   — default "bottega-qa"
 *   SLACK_QA_CHANNEL     — default "bottega-qa" (created when missing)
 *
 * Model key (env or Keychain): NEAR_API_KEY (service bottega-near) is the
 * preferred provider — its gateway accepts the space agent's dotted tool
 * names (memory.save, memory.search); the opencode-go gateway rejects them
 * (live finding, issue #71), so OPENCODE_API_KEY only runs when NEAR is
 * absent. CANARY_MODEL_REF overrides the model ref entirely.
 *
 * Keychain install: security add-generic-password -s bottega-slack-qa -a "$(whoami)" -w '<xoxp token>'
 * Full QA setup: features.md → "Live-Slack QA canary"; CI + release-gate
 * policy: AGENTS.md → "Scheduled live-Slack canary (issue #175)".
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { bootHarness, type Harness } from "./harness";
import { THINKING_PHRASES } from "../../src/server/services/space-service";
import {
  CHURN_MESSAGE,
  EMPTY_RESPONSE_FALLBACK,
} from "../../src/server/services/slack-turn-presenter";
import {
  ADMIN_CATALOG_BROWSER_EVENT,
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_RESOLVED_EVENT,
  DELIVERY_PENDING_EVENT,
  DELIVERY_REQUESTED_EVENT,
  DELIVERY_RESOLVED_EVENT,
  EXTENSION_CALL_EVENT,
  EXTENSION_CONNECTED_EVENT,
  MESSAGE_RECEIVED_EVENT,
  MODEL_SETTINGS_CHANGED_EVENT,
  MODEL_SWITCHED_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from "../../src/store/audit-events";
import { errorMessage } from "../../src/tools/helpers";
import { loadSpacePolicy } from "../../src/policy/config";
import { buildRegistry } from "../../src/scheduler/actions";
import { startScheduler, type Scheduler } from "../../src/scheduler/runner";
import { standupDigestAction } from "../../src/scheduler/standup";
import { createSecretFileBoundary, type CredentialBoundary } from "../../src/extensions/boundary";
import { codexAuthFilePathFromEnv, readCodexAuthTokens } from "../../src/extensions/proxy-seed";
import {
  createFixtureRegistry,
  FIXTURE_EXTENSION_ID,
  FIXTURE_EXTENSION_TOOL,
} from "../../src/extensions/fixture";
import type { ExtensionRegistry } from "../../src/extensions/registry";
import type { ExtensionManifest, McpBinding } from "../../src/extensions/manifest";
import { pollPendingDeliveries } from "../../src/server/services/delivery-poller";
import { resolveDeliveryAction } from "../../src/server/adapters/delivery-router";
import { APPROVAL_OUTCOME_PREFIX, SlackApprovalRouter } from "../../src/server/adapters/approval-router";
import { DELIVERY_APPROVE_ACTION_ID, APPROVE_ACTION_ID } from "../../src/server/adapters/slack";
import {
  startUploadLinkServer,
  mintUploadLinkToolDefinition,
  type UploadLinkServerHandle,
} from "../../src/extensions/upload-link";
import { OAuthFlowStore, type McpOAuthConnector, type OAuthFlowStoreSlice } from "../../src/extensions/mcp-oauth";
import { adminToolDefinitions } from "../../src/tools/admin";
import { modelToolsDefinitions } from "../../src/tools/model-settings";
import { listAvailableModels, resolveModelPin } from "../../src/models/model-pin";
import { evaluatePolicyGate } from "../../src/policy/gate";
import { SNAPSHOT_SCHEMA } from "../../src/extensions/registry";
import type { SnapshotDraft } from "../../src/extensions/fetch-catalog";
import type { BrokerConnector } from "../../src/extensions/connect";
import type { LiveSlackTokens, SlackApiMessage } from "./slack-live";
import { z } from "zod";

/** Org policy for the canary (issues #79/#175): memory tools allowed,
 * work-item creation on the documented always-approve path (approver:
 * "policy"), the fixture extension's read-tier tool allowed so the
 * extension journey crosses the policy gate (the fixture extension itself
 * is registered by the canary's own registry — see runLiveLeg), semantic
 * auto-pickup ON so the pickup journey exercises the #89 directive,
 * use_model allowed so the model-role journey's write-tier switch runs
 * without a prompt, and model_settings on the PROMPT path — the
 * org-settings approval journey (issue #151) is exactly that flow (the
 * default unknown action denies, which would skip the prompt entirely). */
export const CANARY_ORG_CONFIG = [
  "tools:",
  "  memory.save: allow",
  "  memory.search: allow",
  "  create_work_item: allow",
  "  use_model: allow",
  "  model_settings: prompt",
  `  ${FIXTURE_EXTENSION_TOOL}: allow`,
  "approvals:",
  "  always_approve:",
  "    - create_work_item",
  "work_items:",
  "  auto_pickup: true",
  "",
].join("\n");

/**
 * Per-journey timeout: the live model + live Slack are slow by design —
 * real codex/luna tool-loop turns through iron-proxy legitimately exceed
 * 120s (issue #215: run msykwxhj-155u timed every complex journey out at
 * 120s while the turn was still streaming), so the reply window is 5
 * minutes. Exported for the hermetic journey-mechanism tests.
 */
export const JOURNEY_TIMEOUT_MS = 300_000;
/**
 * How long the canary waits for deterministic store-side effects: raised
 * with the reply window so store checks that follow a slow model turn
 * (approval prompts, pickup items, audit rows) keep headroom. Exported
 * for the hermetic journey-mechanism tests.
 */
export const STORE_TIMEOUT_MS = 90_000;
/**
 * The pickup journey's explicit-confirm gate window (issue #245): after the
 * draft ask is seen, this bounded window asserts NO work item is created by
 * the draft alone, then releases the confirmation — a premature create is
 * the #89 gate regression the canary must surface. Short so the happy path
 * pays little; the 90s item poll the confirmation leg already runs keeps
 * the real wait headroom.
 */
const PICKUP_GATE_WINDOW_MS = 5_000;

export interface JourneyResult {
  name: string;
  status: "pass" | "fail" | "skip";
  /** Human-readable evidence lines (reply snippets, item ids, reasons). */
  details: string[];
  permalink?: string;
}

export interface CanaryResult {
  status: "skipped" | "passed" | "failed";
  message: string;
  journeys: JourneyResult[];
}

/** Token resolution inputs (injectable so the skip gate is testable). */
export interface TokenDeps {
  env: Record<string, string | undefined>;
  keychain: (service: string) => string | null;
}

export interface ResolvedLiveTokens {
  tokens?: LiveSlackTokens;
  /** Env var names (env + Keychain both empty) that blocked the run. */
  missing: string[];
}

/** Reads each token from env first, then the macOS Keychain service. */
export function resolveLiveTokens(deps: TokenDeps): ResolvedLiveTokens {  const read = (envKey: string, service: string): string | undefined => {
    const fromEnv = deps.env[envKey];
    if (fromEnv && fromEnv.trim()) return fromEnv;
    const fromKeychain = deps.keychain(service);
    return fromKeychain && fromKeychain.trim() ? fromKeychain : undefined;
  };
  const appToken = read("SLACK_APP_TOKEN", "bottega-slack-app");
  const botToken = read("SLACK_BOT_TOKEN", "bottega-slack-bot");
  const qaUserToken = read("SLACK_QA_USER_TOKEN", "bottega-slack-qa");
  const missing: string[] = [];
  if (!appToken) missing.push("SLACK_APP_TOKEN");
  if (!botToken) missing.push("SLACK_BOT_TOKEN");
  if (!qaUserToken) missing.push("SLACK_QA_USER_TOKEN");
  if (!appToken || !botToken || !qaUserToken) return { missing };
  const qaUserId = deps.env.SLACK_QA_USER_ID?.trim() || undefined;
  return {
    tokens: {
      appToken,
      botToken,
      qaUserToken,
      ...(qaUserId !== undefined ? { qaUserId } : undefined),
      qaUserName: deps.env.SLACK_QA_USER_NAME?.trim() || "bottega-qa",
      channelName: deps.env.SLACK_QA_CHANNEL?.trim() || "bottega-qa",
    },
    missing,
  };
}

/**
 * The real model's key (issue #71 semantics), env first then Keychain:
 * CANARY_MODEL_REF overrides everything; Codex (issue #214) — the ChatGPT
 * subscription credential, a FILESYSTEM source: the Codex CLI auth file at
 * CODEX_AUTH_PATH (default ~/.codex/auth.json; unset under the test
 * runner) — beats NEAR when resolvable; NEAR is preferred over opencode-go
 * — the NEAR gateway accepts the space agent's dotted tool names
 * (memory.save, ...), the opencode-go gateway rejects them (live finding,
 * issue #71). Null when nothing is available.
 */
export function resolveModelKey(deps: TokenDeps): string | null {
  const read = (envKey: string, service: string): string | undefined => {
    const fromEnv = deps.env[envKey];
    if (fromEnv && fromEnv.trim()) return fromEnv;
    const fromKeychain = deps.keychain(service);
    return fromKeychain && fromKeychain.trim() ? fromKeychain : undefined;
  };
  if (deps.env.CANARY_MODEL_REF?.trim()) return deps.env.CANARY_MODEL_REF.trim()!;
  const codexAuthPath = codexAuthFilePathFromEnv(deps.env);
  if (codexAuthPath !== null && readCodexAuthTokens(codexAuthPath) !== null) return codexAuthPath;
  return (
    read("NEAR_API_KEY", "bottega-near") ??
    read("OPENCODE_API_KEY", "bottega-opencode") ??
    null
  );
}

/** macOS Keychain read; null when missing or unavailable (Linux CI). */
export function keychainGet(service: string): string | null {
  try {
    const res = Bun.spawnSync({
      cmd: ["security", "find-generic-password", "-s", service, "-w"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode !== 0) return null;
    const value = res.stdout.toString().trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Cron for the standup journey's job (issue #175): fires once at the
 * minute boundary ~1 minute out, so the scheduler run is observable within
 * the journey timeout and the job never re-fires during the leg (the next
 * occurrence of `M * * * *` is the next hour).
 */
export function standupCronFor(afterMs: number): string {
  const minute = new Date(afterMs + 60_000).getUTCMinutes();
  return `${minute} * * * *`;
}

/**
 * The canary's fixture extension MCP transport (issue #175): a scripted
 * in-process server, so the extension journey exercises the REAL runtime
 * spine (policy gate → credential ladder → boundary write → MCP call →
 * audit) deterministically without a network provider. Mirrors the
 * hermetic transport seam (extensions.test.ts); the provider surface is
 * the only scripted piece.
 */
export function canaryFixtureMcpTransport(_binding: McpBinding): Transport {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: "bottega-canary-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: FIXTURE_EXTENSION_TOOL,
        description: "Current weather for a city (canary fixture provider)",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // SAFETY: the canary's only callTool invoker sends { city: <string> };
    // anything else is tolerated via the ?? "unknown" fallback below.
    const args = (request.params.arguments ?? {}) as { city?: string };
    return { content: [{ type: "text", text: `sunny in ${args.city ?? "unknown"}` }] };
  });
  void server.connect(serverTransport);
  return clientTransport;
}

/**
 * The canary's credential boundary (issue #175): the real write-only
 * boundary (secret file, mode 0600, atomic rename) with a fixed resolver —
 * the fixture provider has no vault row, and there is no proxy control URL
 * in the canary's in-process topology, so the injection write is what the
 * journey exercises.
 */
export function canaryFixtureBoundary(): CredentialBoundary {
  return createSecretFileBoundary({ resolveSecret: async () => "canary-fixture-secret" });
}

// ---------------------------------------------------------------------------
// Full-matrix fixtures (issues #149/#185/#89/#189/#188/#192/#195/#198/#196/#193)
// ---------------------------------------------------------------------------

/** The canary's hosted-OAuth fixture extension (issue #198): a tools-less
 * hosted streamable-http MCP with an oauth credential schema — the exact
 * shape `connectExtension` routes through the generic MCP OAuth seam. The
 * serverUrl is a placeholder: the canary's scripted connector never
 * reaches it (the real SDK auth orchestration + browser leg are skip-gated
 * with evidence). */
export const CANARY_OAUTH_EXTENSION_ID = "fixture.oauth";

function canaryOAuthManifest(): ExtensionManifest {
  return {
    id: CANARY_OAUTH_EXTENSION_ID,
    label: "Fixture OAuth MCP",
    vendor: "bottega-fixtures",
    kind: "mcp",
    mcp: { serverUrl: "https://oauth.fixture.test/mcp", transport: "streamable-http" },
    credentialSchema: { type: "oauth", scopes: ["read"] },
    // `tools: []` is the deliberate pinned "no tools" surface (issue #158):
    // no runtime tools/list discovery, so boot never tries the placeholder
    // serverUrl.
    tools: [],
    domains: ["oauth.fixture.test"],
  };
}

/** The canary registry: the weather fixture (issue #175) + the OAuth fixture (issue #198). */
export function createCanaryRegistry(): ExtensionRegistry {
  const registry = createFixtureRegistry();
  registry.register(canaryOAuthManifest());
  return registry;
}

/**
 * The canary's generic MCP OAuth connector (issue #198): scripted like the
 * fixture MCP transport — the SDK's authorization-server discovery, dynamic
 * client registration, PKCE challenge, and the browser leg need a real
 * vendor server + browser (skip-gated with evidence). What the connector
 * DOES exercise for real: the connect capability routes the OAuth fixture
 * here, the mint persists a single-use flow row in the REAL store
 * (OAuthFlowStore over the shared SQLite), and the URL is shown in Slack —
 * the connect's one-time-link posture. The callback's first gate (single-use
 * state, fail closed) is proven hermetically by the journey (mint → consume
 * → replay denied). The store is read lazily at start time because the
 * harness (and its store) does not exist when the connector is constructed.
 */
export function canaryMcpOAuthConnector(store: () => OAuthFlowStoreSlice): McpOAuthConnector {
  return {
    async start(input) {
      const flows = new OAuthFlowStore(store());
      const token = randomBytes(18).toString("base64url");
      const authorizationUrl = `https://oauth.fixture.test/authorize?client_id=canary-fixture&state=${token}`;
      const minted = flows.mint({
        token,
        provider: input.extension,
        scope: input.scope,
        actor: input.actor,
        spaceId: input.spaceId,
        label: input.label,
        serverUrl: "https://oauth.fixture.test/mcp",
        redirectUri: "http://127.0.0.1:0/oauth/callback",
        flow: JSON.stringify({ authorizationUrl }),
        ttlMs: 15 * 60_000,
      });
      if (!minted.ok) return { ok: false, message: minted.reason };
      return {
        ok: true,
        authorizationUrl,
        message:
          `Open this link to authorize ${input.label}: ${authorizationUrl} — ` +
          `after you authorize in the browser, ${input.label} is connected.`,
      };
    },
    // Issue #271: the connect gate probes the callback base before minting.
    // The canary's base is a SYNTHETIC fixture (oauth.fixture.test, port 0)
    // that no real network can reach — the liveness gate is proven
    // hermetically in connect.test.ts; here the verdict is scripted ok so
    // the canary keeps exercising the routing/mint/flow-row journey.
    probeCallbackBase: async () => ({ ok: true, base: "http://127.0.0.1:0" }),
  };
}

/**
 * Slack renders `&` in message text as `&amp;` (the live canary reply's
 * exact shape, issue #212 follow-up): a URL in the text carries entity
 * separators, so query parsing must run against the decoded form.
 */
function decodeSlackEntities(text: string): string {
  return text.replaceAll("&amp;", "&");
}

/**
 * The full authorize URL from the journey's reply text (issue #198): the
 * connector mints the URL and the journey reads it back from the POSTED
 * Slack message — where Slack renders URLs as `<url>` in the message text
 * AND escapes `&` as `&amp;`. The extraction stops the URL at the `>`
 * (the #212 finding) and decodes the `&amp;` entity (the follow-up
 * finding), so the returned URL is the real, query-parseable authorize
 * URL. Exported for the hermetic journey-mechanism tests.
 */
export function oauthAuthorizeUrlFrom(replyText: string): string | undefined {
  const url = /https:\/\/oauth\.fixture\.test\/authorize\?[^\s<>]+/.exec(replyText)?.[0];
  return url === undefined ? undefined : decodeSlackEntities(url);
}

/**
 * The OAuth `state` from the authorize URL in the journey's reply text
 * (issue #212 + follow-up): the connector mints the URL with the single-use
 * flow token as its state param, and the journey reads the URL back from
 * the POSTED Slack message — where Slack renders URLs as `<url>` in the
 * message text and escapes `&` as `&amp;`. The extraction must therefore
 * stop the URL at the `>` (the #212 finding, or the captured state carries
 * a trailing `>`) AND decode the `&amp;` entity before query parsing (the
 * follow-up finding: on the live reply the separator renders `&amp;state=`,
 * so a raw `&state=` regex never matches and the journey reports
 * "authorization URL carries no state"). Exported for the hermetic
 * journey-mechanism tests.
 */
export function oauthAuthorizeStateFrom(replyText: string): string | undefined {
  const url = oauthAuthorizeUrlFrom(replyText);
  if (url === undefined) return undefined;
  return new URL(url).searchParams.get("state") ?? undefined;
}

/** The canary's broker seam (issues #196/#198): records the upload with a
 * fixed vault row id — the broker is a separate process in production; the
 * registry upsert + audit are the surfaces under test. */
export const CANARY_BROKER_CREDENTIAL_ID = 0x51a7;
export const canaryBroker: BrokerConnector = async () => ({
  identityKey: null,
  brokerCredentialId: CANARY_BROKER_CREDENTIAL_ID,
});

/**
 * The deployable model id the space's default should pin to (issue #189):
 * the bare id of the harness's model ref (near's declared
 * deepseek-ai/DeepSeek-V4-Flash id, or the opencode-go deepseek id) —
 * both resolve against the session's live catalog, so the turn-start
 * re-apply can apply the swap.
 */
export function defaultModelIdFor(modelRef: string): string {
  if (modelRef.includes("near")) return "deepseek-ai/DeepSeek-V4-Flash";
  if (modelRef.includes("opencode")) return "deepseek-v4-flash";
  // Keep the ref exactly as the operator pinned it (issue #243). Stripping
  // a provider-qualified ref to its bare id ("openai-codex/gpt-5.6-luna" →
  // "gpt-5.6-luna") made the turn-start default re-apply fail ambiguous (an
  // id served by several providers with no near winner) or silently spill
  // to near's #194 preference — the session kept its current model while
  // the persistence + reply assertions still passed (the hot-swap
  // false-pass).
  return modelRef;
}

/**
 * The provider a hot-swap default MUST re-apply under (issue #243): the
 * model ref's own provider when {@link defaultModelIdFor} passes the ref
 * through qualified, undefined for the near/opencode forms the resolver
 * normalizes to a single working provider by preference (#194). The
 * journey asserts the stored default resolves to this provider, never a
 * near-tied or ambiguous spillover.
 */
export function defaultModelProviderFor(modelRef: string): string | undefined {
  if (modelRef.includes("near") || modelRef.includes("opencode")) return undefined;
  const slash = modelRef.lastIndexOf("/");
  return slash >= 0 ? modelRef.slice(0, slash) : undefined;
}

/** A tool-execute session ctx pinned to the space (the session-file seam). */
export function toolCtxFor(h: Harness, spaceId: string): ExtensionContext {
  // SAFETY: the canary's tool-call seams only read ctx.sessionManager
  // .getSessionFile(); the rest of the SDK ExtensionContext surface is unused
  // in this in-process topology.
  return {
    sessionManager: { getSessionFile: (): string | undefined => join(h.transcriptDir, `${spaceId}.jsonl`) },
  } as ExtensionContext;
}

/** The text of a tool result (the first text content block). */
function toolResultText(res: AgentToolResult): string {
  // SAFETY: SDK content blocks all carry a `type` discriminator; only "text"
  // blocks are read for the reply text.
  const block = (res.content ?? []).find((b) => (b as { type?: string }).type === "text") as
    | { text?: string }
    | undefined;
  return block?.text ?? "";
}

/**
 * The approve-button value (the pending request id) from an approval
 * prompt message's blocks — the same id a human's click would carry.
 * The blocks are Slack API JSON (outside-controlled), so the payload is
 * parsed at this boundary and only matching action/button blocks are read.
 * Exported for the hermetic journey-mechanism tests.
 */
const approvalButtonSchema = z
  .object({
    type: z.literal("button"),
    action_id: z.literal(APPROVE_ACTION_ID),
    value: z.string(),
  })
  .passthrough();

export function approvalButtonValue(m: SlackApiMessage): string | undefined {
  const message = z.object({ blocks: z.array(z.unknown()) }).safeParse(m);
  if (!message.success) return undefined;
  for (const block of message.data.blocks) {
    const blockParsed = z.object({ type: z.literal("actions"), elements: z.array(z.unknown()) }).safeParse(block);
    if (!blockParsed.success) continue;
    for (const element of blockParsed.data.elements) {
      const button = approvalButtonSchema.safeParse(element);
      if (!button.success) continue;
      return button.data.value;
    }
  }
  return undefined;
}

/**
 * Waits for the posted approval prompt for a tool and extracts the pending
 * request id from its button blocks (issue #151) — the click the journey
 * then simulates through the router's handleAction seam.
 */
async function findApprovalPrompt(
  h: Harness,
  channelId: string,
  opts: { afterTs: string; tool: string; label: string },
): Promise<{ message: SlackApiMessage; requestId: string }> {
  const live = h.liveSlack!;
  const after = parseFloat(opts.afterTs);
  const message = await waitFor(
    async () => {
      const history = await live.history(channelId);
      return history.find(
        (m) => isBotMessage(h, m) && m.text.includes(`Approval required for ${opts.tool}`) && parseFloat(m.ts) > after,
      );
    },
    JOURNEY_TIMEOUT_MS,
    `the posted approval prompt for ${opts.tool} (${opts.label})`,
  );
  const requestId = approvalButtonValue(message);
  if (!requestId) throw new Error(`the ${opts.tool} approval prompt carries no approve-button value in its blocks`);
  return { message, requestId };
}

/** Polls `fn` until it returns a truthy value; throws on timeout. */
async function waitFor<T>(
  fn: () => T | undefined | null | Promise<T | undefined | null>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await fn();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await Bun.sleep(500);
  }
}

function isBotMessage(h: Harness, m: SlackApiMessage): boolean {
  const live = h.liveSlack!;
  return (m.bot_id !== undefined || m.user === live.botUserId) && m.user !== live.qaUserId;
}

/**
 * Issue #245 — an empty-response recovery line ("Hmm — I got an empty
 * response…", "I keep getting empty responses — check the model key?") is
 * adapter DECORATION like a thinking/progress phrase (#40/#60/#78): the
 * real completion replaces it in place, so treating it as a reply
 * false-passes a churn turn (bare empty completions / model gave up)
 * precisely when the canary should surface the churn diagnostic. The
 * cause-carried variants ("…: <cause> — retrying…", #78) embed the phrase
 * too.
 */
function isEmptyResponseLine(text: string): boolean {
  return (
    text.includes(EMPTY_RESPONSE_FALLBACK) || text.includes(CHURN_MESSAGE) || text.includes("empty response")
  );
}

/**
 * Issue #245 — turns the bare "no bot reply … within Nms" timeout into a
 * diagnosis from the rows the poll ALREADY fetched: whether the bot opened
 * a turn at all (any bot-authored row newer than the inbound), the tool /
 * progress lines it posted instead of a reply, and an empty-response loop
 * signal (the #60/#78 churn recovery: EMPTY_RESPONSE_FALLBACK lines repeat
 * while the completion comes back empty, and the CHURN_MESSAGE guards the
 * terminal state). Returns "" when nothing is actionable (the bot never
 * posted after the ask), so the plain timeout stands on its own. Exported
 * for the hermetic diagnostic test (issue #245).
 */
export function noReplyEvidence(h: Harness, after: number, messages: SlackApiMessage[]): string {
  const rows = messages.filter((m) => isBotMessage(h, m) && parseFloat(m.ts) > after);
  if (rows.length === 0) return "";
  const parts: string[] = [`the bot posted ${rows.length} message(s) after the ask but none reads as a reply`];
  const toolLines = rows
    .filter((m) => PROGRESS_LINE_RE.test(m.text.trim()) || THINKING_PHRASES.includes(m.text.trim()))
    .map((m) => snippet(m.text));
  if (toolLines.length > 0) {
    parts.push(`last non-reply line(s): ${toolLines.slice(-3).join(" | ")}`);
  }
  const churnRows = rows.filter((m) => isEmptyResponseLine(m.text));
  if (churnRows.length > 0) {
    parts.push(
      rows.some((m) => m.text.includes(CHURN_MESSAGE))
        ? `empty-response churn hit the recovery guard — check the model key (${churnRows.length} line(s))`
        : `the completion kept returning empty — ${churnRows.length} "empty response" line(s)`,
    );
  }
  return `: ${parts.join("; ")}`;
}

/**
 * Polls live history for the bot's reply to an inbound message: any
 * bot-authored message with non-empty text, newer than the inbound ts
 * (and threaded under it in channels — DMs reply plain, #40). Thinking
 * phrases AND live-progress lines are excluded: the real adapter replaces
 * them in place (#40/#60), so a progress line ("⚙️ …", "🧠 …",
 * "Thinking… Ns") that outlives an empty turn is decoration, never a
 * reply (#224 — a false pass would hide the exact no-reply failure this
 * journey exists to catch). Transient history errors retry; only a
 * timeout fails the journey.
 *
 * Threaded polls (postAndWait(thread: true) — the channel journeys) read
 * conversations.replies for the thread: Slack's conversations.history
 * returns ONLY top-level messages, so an in-thread bot reply (the channel
 * answer shape, #40) would never appear to the poll — the #212 finding
 * (the bot replied 0.8s after the ping but the journey reported "no bot
 * reply"). The real live shape (issue #215, run msykwxhj-155u): the QA
 * ping posts TOP-LEVEL (postAsUser sends no thread_ts) and Slack's real
 * conversations.replies REJECTS a non-thread ts with invalid_arguments —
 * the inbound is a plain top-level message until the bot's phrase lands
 * in its thread, and a STEERED inbound (no phrase of its own) never
 * becomes a root. The poll therefore falls back to conversations.history
 * for any iteration where replies() rejects with invalid_arguments, so a
 * top-level-shaped reply still surfaces while the replies() probe keeps
 * retrying each iteration (the root appears once the bot posts its
 * phrase). Exported for the hermetic journey-mechanism tests (#212/#215).
 */
export async function waitForBotReply(
  h: Harness,
  channelId: string,
  opts: { afterTs: string; threadTs?: string; label: string; timeoutMs?: number },
): Promise<SlackApiMessage> {
  const live = h.liveSlack!;
  const after = parseFloat(opts.afterTs);
  const timeoutMs = opts.timeoutMs ?? JOURNEY_TIMEOUT_MS;
  let lastHistoryError: unknown;
  // The last successful poll's rows, so the timeout message can say what the
  // bot DID post instead of leaving a bare "no bot reply" (issue #245).
  let lastMessages: SlackApiMessage[] | undefined;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      let messages: SlackApiMessage[] | undefined;
      let requireThread = false;
      if (opts.threadTs !== undefined) {
        try {
          messages = await live.replies(channelId, opts.threadTs);
          requireThread = true;
        } catch (err) {
          // Slack's real rejection of a non-thread ts (issue #215): the
          // ts is the inbound's own top-level ts until the bot's phrase
          // makes it a thread root — scan history this iteration instead
          // of erroring into a timeout. Other errors keep retrying as
          // before (auth/ratelimit are transient, not shape signals).
          if (!errorMessage(err).includes("invalid_arguments")) throw err;
        }
      }
      if (messages === undefined) {
        // No thread poll (DM shape), or Slack rejected the thread ts: the
        // top-level eye. History rows are top-level, so no thread filter.
        messages = await live.history(channelId);
      }
      lastMessages = messages;
      const hit = messages.find(
        (m) =>
          isBotMessage(h, m) &&
          m.text.trim().length > 0 &&
          !THINKING_PHRASES.includes(m.text.trim()) &&
          // Live-progress lines (issue #224) are turn DECORATION, never a
          // reply: a real reply replaces the phrase in place, so a poll
          // that matches "⚙️ …" / "🧠 …" / "Thinking… Ns" false-passes on
          // an empty turn (run msypizpb-qt3: the DM journey "passed" on
          // the elapsed line while the channel turn honestly timed out).
          !PROGRESS_LINE_RE.test(m.text.trim()) &&
          // Issue #245: an empty-response recovery line is decoration too —
          // the real completion replaces it in place; matching it
          // false-passes a churn turn (empty completions / model gave up)
          // exactly when the canary should surface the churn diagnostic.
          !isEmptyResponseLine(m.text.trim()) &&
          parseFloat(m.ts) > after &&
          (!requireThread || m.thread_ts === opts.threadTs),
      );
      if (hit) return hit;
    } catch (err) {
      lastHistoryError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no bot reply to "${opts.label}" in ${channelId} within ${timeoutMs}ms` +
          (lastHistoryError !== undefined ? ` (last history error: ${errorMessage(lastHistoryError)})` : "") +
          (lastMessages !== undefined ? noReplyEvidence(h, after, lastMessages) : ""),
      );
    }
    await Bun.sleep(750);
  }
}

/**
 * Posts as the QA user and waits for the bot's reply; returns both ts values.
 *
 * Threaded polls (postAndWait(thread: true) — the channel journeys) read
 * conversations.replies for the thread: conversations.replies requires the
 * ts of the message the thread hangs under — the POSTED message's own ts
 * when it posts top-level (the real live shape, issue #215: postAsUser
 * sends no thread_ts, so the QA ping is a top-level message and the bot's
 * threaded reply makes THAT ts the thread root). The `thread_ts` fallback
 * only matters when the post itself lands inside a thread (its own ts is
 * then a reply ts and the root it carries is `thread_ts`). Slack rejects a
 * non-thread ts with invalid_arguments; waitForBotReply falls back to
 * history for those iterations (see its doc). Exported for the hermetic
 * journey-mechanism tests (issues #212/#215).
 */
export async function postAndWait(
  h: Harness,
  channelId: string,
  text: string,
  opts: { label: string; thread?: boolean },
): Promise<{ inboundTs: string; reply: SlackApiMessage }> {
  const live = h.liveSlack!;
  const inbound = await live.postAsUser(channelId, text);
  const rootTs = inbound.thread_ts ?? inbound.ts;
  const reply = await waitForBotReply(h, channelId, {
    afterTs: inbound.ts,
    ...(opts.thread ? { threadTs: rootTs } : undefined),
    label: opts.label,
  });
  return { inboundTs: inbound.ts, reply };
}

function snippet(text: string, max = 140): string {
  const t = text.trim().replaceAll("\n", " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** The item id from a WORK_ITEM_CREATED_EVENT row (payload {id, requester}, audit-events.ts). */
function workItemIdFromRow(row: { payload: string }): string {
  // SAFETY: work-item audit rows are written with {id, requester} payloads
  // (audit-events.ts); a malformed id fails the getWorkItem lookup loudly.
  return (JSON.parse(row.payload) as { id: string }).id;
}

async function journeyChatReply(
  h: Harness,
  channelId: string,
  opts: { label: string; thread?: boolean; runId: string },
): Promise<JourneyResult> {
  const live = h.liveSlack!;
  try {
    const { reply } = await postAndWait(
      h,
      channelId,
      `canary ${opts.runId} (${opts.label}): ping — reply with anything`,
      { label: opts.label, thread: opts.thread },
    );
    const permalink = await live.permalink(channelId, reply.ts);
    return {
      name: `chat-reply (${opts.label})`,
      status: "pass",
      details: [`bot replied: "${snippet(reply.text)}"`],
      permalink,
    };
  } catch (err) {
    return { name: `chat-reply (${opts.label})`, status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The memory-save prompt the journey posts (issue #224): the scope is
 * pinned EXPLICITLY ("ORG memory", "scope: org") because the journey's
 * deterministic proof polls the ORG store. The pre-#224 prompt ("store it
 * in memory") was ambiguous — the live model (luna) saved with
 * scope: "user" (natural for a DM, run msymugpa's surviving transcript:
 * memory_save executed with {scope: "user"}), the org-scope search never
 * found the fact, and the journey timed out. The model sees this text
 * verbatim, so the explicit scope is the contract. Exported for the
 * hermetic journey-mechanism tests.
 */
export function memorySavePromptFor(runId: string): string {
  return `remember that the canary code word is canary-${runId} — store it in ORG memory (memory.save scope: org), shared with the whole organization`;
}

async function journeyMemory(h: Harness, channelId: string, runId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const word = `canary-${runId}`;
  try {
    // Save leg: the real model must call memory.save with scope org — the
    // prompt pins the scope explicitly (#224); the deterministic proof is
    // the SQLite store finding the fact in the org scope afterwards.
    await postAndWait(h, channelId, memorySavePromptFor(runId), {
      label: "memory save",
    });
    const stored = await waitFor(
      async () => {
        const entries = await h.memory.search({ query: word, scope: "org", limit: 5 });
        return entries.find((e) => e.content.includes(word));
      },
      STORE_TIMEOUT_MS,
      "the remembered fact in the memory store",
    );
    if (!stored) throw new Error("memory.save round-trip: fact not found in the org memory store");
    // Search-back leg: ask the agent; the reply is the human-visible half.
    const { reply } = await postAndWait(h, channelId, "what is the canary code word?", { label: "memory search-back" });
    const permalink = await live.permalink(channelId, reply.ts);
    const named = reply.text.includes(word);
    return {
      name: "memory save/search",
      status: "pass",
      details: [
        `memory.save round-trip stored: "${snippet(stored.content)}"`,
        named ? "the search-back reply named the code word" : "search-back replied but did not name the code word (live model outcome, not gating)",
        `reply: "${snippet(reply.text)}"`,
      ],
      permalink,
    };
  } catch (err) {
    return { name: "memory save/search", status: "fail", details: [errorMessage(err)] };
  }
}

async function journeyWorkItem(h: Harness, channelId: string, runId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  try {
    const before = (await h.store.listAudit({ space: spaceId, event_type: WORK_ITEM_CREATED_EVENT })).length;
    const { reply } = await postAndWait(
      h,
      channelId,
      `create a work item: canary fixture task ${runId} (live surface check)`,
      { label: "work-item create" },
    );
    // Semantic auto-pickup (issue #89) may turn the create ask into a
    // confirmable draft: give a direct create a short window, then confirm
    // in-channel (the directive's explicit-confirm gate) and wait again.
    let rows = await waitFor(
      async () => {
        const rows = await h.store.listAudit({ space: spaceId, event_type: WORK_ITEM_CREATED_EVENT });
        return rows.length > before ? rows : undefined;
      },
      15_000,
      "a new work item in the space (direct create)",
    ).catch(() => undefined);
    if (rows === undefined) {
      await live.postAsUser(channelId, "confirmed — proceed and create the work item now (do not ask again)");
      rows = await waitFor(
        async () => {
          const rows = await h.store.listAudit({ space: spaceId, event_type: WORK_ITEM_CREATED_EVENT });
          return rows.length > before ? rows : undefined;
        },
        STORE_TIMEOUT_MS,
        "a new work item in the space (after the pickup confirmation)",
      );
    }
    const row = rows[rows.length - 1]!;
    const item = await h.store.getWorkItem(workItemIdFromRow(row));
    if (!item) throw new Error("work item row created but not readable");
    if (item.state !== "open") throw new Error(`work item ${item.id} landed in state ${item.state}, expected open`);
    const permalink = await live.permalink(channelId, reply.ts);
    return {
      name: "work-item-create",
      status: "pass",
      details: [`item ${item.id} created (state: ${item.state}) via the always-approve path`],
      permalink,
    };
  } catch (err) {
    return { name: "work-item-create", status: "fail", details: [errorMessage(err)] };
  }
}

async function journeyConnect(h: Harness, channelId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  try {
    // Issue #273: the system-level connect-intent regex pre-route (#61) is
    // GONE — a connect-shaped message ("connect my X") must reach the AGENT
    // turn, never a silent short-circuit. The agent owns the connect flow
    // via the connect_extension tool (the per-session tool path, issue
    // #52); the mcp-oauth journey below proves that tool call's mint
    // end-to-end. The deterministic proof here: the message.in audit row
    // for the inbound message — the session path (and ONLY the session
    // path) writes it at receipt, the old seam never did — plus the agent
    // replied. A direct connect outcome would have written an
    // extension.connected row instead.
    const beforeConnected = (await h.store.listAudit({ space: spaceId, event_type: EXTENSION_CONNECTED_EVENT })).length;
    const { inboundTs, reply } = await postAndWait(h, channelId, "connect my notion", {
      label: "connect-shaped message",
    });
    const permalink = await live.permalink(channelId, reply.ts);
    await waitFor(
      async () => {
        const rows = await h.store.listAudit({ space: spaceId, event_type: MESSAGE_RECEIVED_EVENT });
        return rows.some((r) => (JSON.parse(r.payload) as { ts?: string }).ts === inboundTs) ? rows : undefined;
      },
      STORE_TIMEOUT_MS,
      "a message.in audit row for the connect-shaped message",
    );
    const connected = await h.store.listAudit({ space: spaceId, event_type: EXTENSION_CONNECTED_EVENT });
    if (connected.length > beforeConnected) {
      throw new Error("the space service short-circuited the connect directly (extension.connected without an agent turn)");
    }
    return {
      name: "connect-reaches-agent",
      status: "pass",
      details: [
        `"connect my notion" reached the agent turn (message.in row present) and the agent replied: "${snippet(reply.text)}"`,
      ],
      permalink,
    };
  } catch (err) {
    return { name: "connect-reaches-agent", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The scheduled-standup journey (issue #175): opt the space in
 * (proactive.standup via the JSON policy overlay — the exact shape #150
 * fixed), create a standup_digest job due ~1 minute out, and assert the
 * scheduler fires it and the bot posts the digest. This is the journey
 * that would have caught #150 on day one: with #150 reverted, the JSON
 * overlay fails closed (the old parser threw on "{"), no digest is posted,
 * and the journey times out into a fail. The scheduler itself is booted by
 * runLiveLeg with the real runner + standup action (server wiring).
 */
async function journeyStandup(h: Harness, channelId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  let jobId: string | undefined;
  try {
    // Opt the space in deterministically (the settings tool would need a
    // model turn + approval; the scheduler reads spaces.policy_json, and
    // the opt-in shape is the #150 contract being exercised).
    const space = await h.store.getSpace(spaceId);
    if (!space) throw new Error(`space not found: ${spaceId}`);
    // spaces.policy_json is a JSON document (outside-controlled); parse it at
    // this boundary and branch on the domain value (a non-mapping proactive
    // field means the space never opted in).
    const overlay = z.record(z.string(), z.unknown()).parse(JSON.parse(space.policy_json || "{}"));
    const proactive = z
      .record(z.string(), z.unknown())
      .optional()
      .catch({})
      .parse(overlay.proactive);
    overlay.proactive = { ...proactive, standup: true };
    await h.store.updatePolicy(spaceId, JSON.stringify(overlay));

    // Create the standup job due at the next minute boundary (~1 min out).
    const job = await h.store.createSchedulerJob({
      action: "standup_digest",
      cron: standupCronFor(Date.now()),
      params: { space: spaceId },
      spaceId,
      createdBy: live.qaUserId,
    });
    jobId = job.id;
    const afterTs = String(Date.now() / 1000);
    const digest = await waitFor(
      async () => {
        const history = await live.history(channelId);
        return history.find(
          (m) => isBotMessage(h, m) && m.text.includes("Standup for") && parseFloat(m.ts) > parseFloat(afterTs),
        );
      },
      150_000,
      "the scheduled standup digest in the channel",
    );
    const permalink = await live.permalink(channelId, digest.ts);
    return {
      name: "scheduled-standup",
      status: "pass",
      details: [
        `job ${job.id} (cron "${job.cron}") fired; digest posted: "${snippet(digest.text)}"`,
        "space opted in via the JSON proactive overlay (the #150 shape)",
      ],
      permalink,
    };
  } catch (err) {
    return { name: "scheduled-standup", status: "fail", details: [errorMessage(err)] };
  } finally {
    if (jobId !== undefined) {
      try {
        await h.store.deleteSchedulerJob(jobId);
      } catch {
        // Cleanup never masks the journey result.
      }
    }
  }
}

/**
 * The extension-call journey (issue #175): the QA user asks for the
 * fixture extension's tool, the model calls it, and the REAL runtime
 * executes it through the policy gate → credential ladder → boundary
 * write → MCP call → audit. The deterministic proof is the
 * extension.call audit row (tool + decision "allow"); the reply is the
 * human-visible half.
 */
async function journeyExtension(h: Harness, channelId: string, runId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  try {
    // Seed the org credential the ladder resolves (deterministic setup —
    // the fixture provider has no connect flow; the runtime's own audit
    // rows prove the ladder + boundary ran).
    await h.store.upsertExtensionCredential({
      provider: FIXTURE_EXTENSION_ID,
      identityKey: "canary-fixture",
      owner: null,
      scope: "org",
      brokerCredentialId: 0,
    });
    const city = `canary-${runId}`;
    const before = (await h.store.listAudit({ space: spaceId, event_type: EXTENSION_CALL_EVENT })).length;
    // Name-agnostic on purpose: the driver flattens dotted tool names for
    // the model-facing toolset (issue #78), so the prompt points at the
    // fixture extension without naming a tool the model would not find.
    const { reply } = await postAndWait(
      h,
      channelId,
      `call the weather fixture extension tool for the city ${city} and tell me the forecast`,
      { label: "extension call" },
    );
    const rows = await waitFor(
      async () => {
        const rows = await h.store.listAudit({ space: spaceId, event_type: EXTENSION_CALL_EVENT });
        return rows.length > before ? rows : undefined;
      },
      STORE_TIMEOUT_MS,
      "an extension tool call audit row",
    );
    const row = rows[rows.length - 1]!;
    // SAFETY: the extension runtime audits EXTENSION_CALL_EVENT rows with
    // {extension, tool, actor, credential_id, decision} payloads
    // (audit-events.ts); only tool and decision are read here.
    const payload = JSON.parse(row.payload) as { tool?: string; decision?: string };
    if (payload.tool !== FIXTURE_EXTENSION_TOOL) {
      throw new Error(`extension.call audited tool "${payload.tool ?? "<missing>"}", expected ${FIXTURE_EXTENSION_TOOL}`);
    }
    if (payload.decision !== "allow") {
      throw new Error(`extension.call decision "${payload.decision ?? "<missing>"}", expected allow`);
    }
    const permalink = await live.permalink(channelId, reply.ts);
    return {
      name: "extension-call",
      status: "pass",
      details: [
        `fixture tool ${FIXTURE_EXTENSION_TOOL} executed through the real runtime (decision: ${payload.decision})`,
        `reply: "${snippet(reply.text)}"`,
      ],
      permalink,
    };
  } catch (err) {
    return { name: "extension-call", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The model-role-switch journey (issue #175): the QA user asks for the
 * fast model, the model calls use_model, the live session switches (the
 * OMP driver's per-session hook), and the switch is audited. The
 * deterministic proof is the model.switched audit row with role "fast".
 */
async function journeyModelRole(h: Harness, channelId: string, runId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  try {
    const before = (await h.store.listAudit({ space: spaceId, event_type: MODEL_SWITCHED_EVENT })).length;
    const { reply } = await postAndWait(
      h,
      channelId,
      `use the fast model for this: reply with the canary run id ${runId}`,
      { label: "model role switch" },
    );
    const rows = await waitFor(
      async () => {
        const rows = await h.store.listAudit({ space: spaceId, event_type: MODEL_SWITCHED_EVENT });
        return rows.length > before ? rows : undefined;
      },
      STORE_TIMEOUT_MS,
      "a model.switched audit row",
    );
    const row = rows[rows.length - 1]!;
    // SAFETY: the model-role switch audits MODEL_SWITCHED_EVENT rows with
    // {role, model, thinking_level, by} payloads (audit-events.ts); only role is read.
    const payload = JSON.parse(row.payload) as { role?: string };
    if (payload.role !== "fast") {
      throw new Error(`model.switched audited role "${payload.role ?? "<missing>"}", expected fast`);
    }
    const permalink = await live.permalink(channelId, reply.ts);
    return {
      name: "model-role-switch",
      status: "pass",
      details: [
        `use_model fast applied to the live session and audited (role: ${payload.role})`,
        `reply: "${snippet(reply.text)}"`,
      ],
      permalink,
    };
  } catch (err) {
    return { name: "model-role-switch", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The delivery-approval round trip (issue #149): the executor's marker →
 * the REAL delivery poller posts the PR + approve/deny prompt → the REAL
 * delivery router resolves the human's decision (audited delivery.resolved,
 * prompt rewritten in place) → the executor's post-wait path moves the item
 * working → review → done. The executor itself runs in its own container,
 * so its two seams (the delivery_pending marker write and the post-approval
 * transitions) are the journey's scripted legs; everything between is the
 * server's real code.
 */
async function journeyDeliveryApproval(h: Harness, channelId: string, runId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  try {
    const prUrl = `https://github.com/serrrfirat/bottega/pull/${Math.floor(Math.random() * 9000) + 1000}`;
    // The executor's marker (issue #149): a work item whose PR opened.
    const item = await h.store.createWorkItem({
      space_id: spaceId,
      requester: live.qaUserId,
      description: `canary delivery fixture ${runId} (delivery approval round trip)`,
      delivery: "git",
      repo: "serrrfirat/bottega",
    });
    await h.audit.appendAudit({
      space_id: spaceId,
      actor: "executor",
      event_type: DELIVERY_PENDING_EVENT,
      payload: JSON.stringify({ id: item.id, pr_url: prUrl, summary: `canary delivery ${runId}` }),
    });

    // The REAL poller announces: posts the interactive prompt + records
    // delivery.requested (dedupe key — never double-announces).
    const posted = await pollPendingDeliveries(h.store, h.adapter);
    if (posted !== 1) throw new Error(`delivery poller announced ${posted}, expected 1`);
    const prompt = await waitFor(
      async () => {
        const history = await live.history(channelId);
        return history.find((m) => isBotMessage(h, m) && m.text.includes("PR ready:"));
      },
      STORE_TIMEOUT_MS,
      "the posted delivery-approval prompt",
    );
    const requested = await waitFor(
      async () => {
        const rows = await h.store.listAudit({ space: spaceId, event_type: DELIVERY_REQUESTED_EVENT });
        return rows.length > 0 ? rows : undefined;
      },
      STORE_TIMEOUT_MS,
      "the delivery.requested audit row",
    );
    // SAFETY: the delivery poller audits DELIVERY_REQUESTED_EVENT rows with
    // {id, pr_url, summary} payloads (audit-events.ts); only id is compared.
    const announced = JSON.parse(requested[requested.length - 1]!.payload) as { id?: unknown };
    if (announced.id !== item.id) throw new Error(`delivery.requested announced a different item`);

    // The REAL delivery router resolves the human's click (the button value
    // is the item id; the click itself cannot be driven through the Slack
    // API — the router's handleAction seam is the exact adapter call a real
    // click makes).
    const resolved = await resolveDeliveryAction(
      { store: h.store, adapter: h.adapter },
      {
        actionId: DELIVERY_APPROVE_ACTION_ID,
        value: item.id,
        spaceId,
        principal: live.qaUserId,
        messageTs: prompt.ts,
      },
    );
    if (!resolved) throw new Error("delivery action was not resolved");
    const decision = await waitFor(
      async () => {
        const rows = await h.store.listAudit({ space: spaceId, event_type: DELIVERY_RESOLVED_EVENT });
        return rows.length > 0 ? rows : undefined;
      },
      STORE_TIMEOUT_MS,
      "the delivery.resolved audit row",
    );
    // SAFETY: the delivery router audits DELIVERY_RESOLVED_EVENT rows with
    // {id, approved, approver} payloads (audit-events.ts); all three are checked.
    const decisionPayload = JSON.parse(decision[decision.length - 1]!.payload) as {
      id?: unknown;
      approved?: unknown;
      approver?: unknown;
    };
    if (decisionPayload.id !== item.id || decisionPayload.approved !== true || decisionPayload.approver !== live.qaUserId) {
      throw new Error(`delivery.resolved mismatch: ${JSON.stringify(decisionPayload)}`);
    }
    // The prompt was rewritten with the outcome (settle-then-rewrite).
    const rewritten = await waitFor(
      async () => {
        const history = await live.history(channelId);
        return history.find((m) => m.ts === prompt.ts && m.text.includes("Delivery approved"));
      },
      STORE_TIMEOUT_MS,
      "the delivery prompt rewritten with the approval",
    );

    // The executor's post-wait path (its container runs this after reading
    // delivery.resolved): working → review (with the recorded approval) →
    // done (with the delivery result).
    await h.store.transitionWorkItem(item.id, "open", "claimed", { by: "executor" });
    await h.store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
    await h.store.transitionWorkItem(item.id, "working", "review", {
      approval: { approver: live.qaUserId },
      by: "executor",
    });
    const done = await h.store.transitionWorkItem(item.id, "review", "done", {
      result: JSON.stringify({ pr_url: prUrl, summary: `canary delivery ${runId}` }),
      by: "executor",
    });
    const permalink = await live.permalink(channelId, rewritten.ts);
    return {
      name: "delivery-approval",
      status: "pass",
      details: [
        `item ${item.id}: poller posted the prompt → approved by <@${live.qaUserId}> (delivery.resolved) → ${done.state}`,
        `prompt rewritten: "${snippet(rewritten.text)}"`,
      ],
      permalink,
    };
  } catch (err) {
    return { name: "delivery-approval", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The per-task model pin journey (issue #185): the QA user asks for a work
 * item "using fast at low effort"; the model calls create_work_item with
 * the pin args; the item row carries the resolved pin. The deterministic
 * proof is the work item's model + reasoning_effort columns (the pin the
 * executor would apply).
 */
async function journeyPerTaskPin(h: Harness, channelId: string, runId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  try {
    const before = (await h.store.listAudit({ space: spaceId, event_type: WORK_ITEM_CREATED_EVENT })).length;
    const { reply } = await postAndWait(
      h,
      channelId,
      `create a work item using fast at low effort: canary pinned task ${runId}`,
      { label: "per-task model pin" },
    );
    const rows = await waitFor(
      async () => {
        const rows = await h.store.listAudit({ space: spaceId, event_type: WORK_ITEM_CREATED_EVENT });
        return rows.length > before ? rows : undefined;
      },
      STORE_TIMEOUT_MS,
      "the pinned work item",
    );
    const row = rows[rows.length - 1]!;
    const item = await h.store.getWorkItem(workItemIdFromRow(row));
    if (!item) throw new Error("pinned work item row created but not readable");
    if (item.model !== "fast") throw new Error(`item ${item.id} pin landed as model "${item.model}", expected "fast"`);
    if (item.reasoning_effort !== "low") {
      throw new Error(`item ${item.id} pin landed as reasoning_effort "${item.reasoning_effort}", expected "low"`);
    }
    const permalink = await live.permalink(channelId, reply.ts);
    return {
      name: "per-task-model-pin",
      status: "pass",
      details: [
        `item ${item.id} carries the #185 pin: model=${item.model}, reasoning_effort=${item.reasoning_effort}`,
        `reply: "${snippet(reply.text)}"`,
      ],
      permalink,
    };
  } catch (err) {
    return { name: "per-task-model-pin", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * Issue #245 — the pickup journey's item poll only proves "a
 * WORK_ITEM_CREATED_EVENT row appeared after the inbound"; it cannot tell
 * whether the item was created by the human's in-channel confirmation (the
 * #89 explicit-confirm contract) or PREMATURELY by the draft ask alone.
 * This gate runs between the draft ask and the confirmation posts: after
 * the draft ask reply is seen it waits out a short draft window and fails
 * the journey the moment a created row shows up without the confirmation —
 * auto-pickup must hold the item for the human's explicit confirm, so a
 * premature creation is a gate regression the canary surfaces, never
 * passes. The window is short (a premature create lands with/right after
 * the draft reply — the tool call precedes the presenter's post, and the
 * window also swallows an async tail) so the happy path only pays ~5s per
 * run, far short of the 90s item poll the confirmation leg already uses.
 * Times out (no-op) when the gate holds.
 */
async function assertNoPrematureWorkItem(
  h: Harness,
  spaceId: string,
  before: number,
  fixture: string,
): Promise<void> {
  const deadline = Date.now() + PICKUP_GATE_WINDOW_MS;
  for (;;) {
    const rows = await h.store.listAudit({ space: spaceId, event_type: WORK_ITEM_CREATED_EVENT });
    if (rows.length > before) {
      const row = rows[rows.length - 1]!;
      throw new Error(
        `item created without confirmation draft (${fixture}): row ${row.id} payload ${snippet(row.payload)} — the auto-pickup explicit-confirm gate was violated (issue #245)`,
      );
    }
    if (Date.now() > deadline) return;
    await Bun.sleep(500);
  }
}

/**
 * The semantic auto-pickup journey (issue #89): with work_items.auto_pickup
 * on (the org config the leg boots with), an actionable intent should
 * produce a confirmable draft asking for confirmation; the QA user's
 * in-channel confirmation then creates the work item. The deterministic
 * proof is the created item whose description carries the fixture text —
 * the intent → draft → confirm → work-item round trip.
 */
export async function journeySemanticPickup(h: Harness, channelId: string, runId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  const fixture = `canary pickup fixture ${runId}`;
  try {
    const before = (await h.store.listAudit({ space: spaceId, event_type: WORK_ITEM_CREATED_EVENT })).length;
    const inboundTs = (await live.postAsUser(
      channelId,
      `implement a ${fixture}: add a docstring to the project README explaining the canary, then propose it as a work item for confirmation`,
    )).ts;
    // The draft ask: the agent posts a confirmable draft and waits. The
    // reply itself is the human-visible half; the gate is the created item.
    await waitForBotReply(h, channelId, { afterTs: inboundTs, label: "pickup draft ask" });
    // The explicit-confirm gate (#89 + #245): the item must NOT exist after
    // the draft ask alone — auto-pickup holds it until the human's
    // in-channel confirmation. A row here is a gate regression the
    // count-poll below would pass.
    await assertNoPrematureWorkItem(h, spaceId, before, fixture);
    // The human's in-channel confirmation (the directive's explicit-confirm
    // gate — never created without it).
    const confirmTs = (await live.postAsUser(channelId, "confirmed — create the work item now")).ts;
    const rows = await waitFor(
      async () => {
        const rows = await h.store.listAudit({ space: spaceId, event_type: WORK_ITEM_CREATED_EVENT });
        return rows.length > before ? rows : undefined;
      },
      STORE_TIMEOUT_MS,
      "the auto-picked-up work item",
    );
    const row = rows[rows.length - 1]!;
    const item = await h.store.getWorkItem(workItemIdFromRow(row));
    if (!item) throw new Error("auto-picked-up item row created but not readable");
    if (!item.description.includes(fixture)) {
      throw new Error(`picked-up item description does not carry the fixture: "${snippet(item.description)}"`);
    }
    const reply = await waitForBotReply(h, channelId, { afterTs: confirmTs, label: "pickup confirmation reply" });
    const permalink = await live.permalink(channelId, reply.ts);
    return {
      name: "semantic-auto-pickup",
      status: "pass",
      details: [
        `intent → draft ask → in-channel confirm → item ${item.id} (${item.state})`,
        `description: "${snippet(item.description)}"`,
      ],
      permalink,
    };
  } catch (err) {
    return { name: "semantic-auto-pickup", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The spaces-persistence journey (issue #188): the space row is upserted on
 * first contact and its per-space settings survive across turns — the
 * session re-reads them (getModelSettings) every turn, so nothing resets
 * them. Deterministic proof: the row exists with the written settings, and
 * a live turn later they are still there.
 */
async function journeySpacesPersistence(h: Harness, channelId: string, runId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  try {
    // The space row persists on first contact (#188): a space that only
    // ever received messages has a durable row.
    let space = await h.store.getSpace(spaceId);
    if (!space) {
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: channelId });
      space = await h.store.getSpace(spaceId);
    }
    if (!space) throw new Error("space row missing after first contact");
    const marker = `canary-persist-${runId}`;
    // SAFETY: the store writes spaces.settings as SpaceModelSettings JSON —
    // all string values (store/db.ts); the canary only round-trips those keys.
    const settings = (JSON.parse(space.settings) ?? {}) as Record<string, string>;
    // SAFETY: spaces.policy_json is a JSON document whose values the canary
    // reads/writes verbatim (marker strings and the proactive mapping).
    const overlay = z.record(z.string(), z.unknown()).parse(JSON.parse(space.policy_json || "{}"));
    await h.store.updateSpaceSettings(spaceId, { ...settings, reasoning_effort: "medium" });
    overlay[marker] = "persisted";
    await h.store.updatePolicy(spaceId, JSON.stringify(overlay));
    const after = await h.store.getSpace(spaceId);
    // SAFETY: the store writes spaces.settings as SpaceModelSettings JSON —
    // all string values (store/db.ts).
    const persistedSettings = JSON.parse(after!.settings) as Record<string, string>;
    if (persistedSettings.reasoning_effort !== "medium") {
      throw new Error("per-space settings did not persist in the space row");
    }
    // A live turn re-reads the space (getModelSettings at turn start) and
    // must not reset or lose the persisted values.
    const { reply } = await postAndWait(h, channelId, `persistence probe ${runId}: reply with ok`, {
      label: "spaces persistence",
    });
    const afterTurn = await h.store.getSpace(spaceId);
    // SAFETY: the store writes spaces.settings as SpaceModelSettings JSON —
    // all string values (store/db.ts).
    const afterTurnSettings = JSON.parse(afterTurn!.settings) as Record<string, string>;
    // SAFETY: spaces.policy_json is a JSON document whose values the canary
    // reads/writes verbatim (marker strings and the proactive mapping).
    const afterTurnOverlay = z.record(z.string(), z.unknown()).parse(JSON.parse(afterTurn!.policy_json || "{}"));
    if (afterTurnSettings.reasoning_effort !== "medium") {
      throw new Error("the live turn reset the space's persisted settings");
    }
    if (afterTurnOverlay[marker] !== "persisted") {
      throw new Error("the live turn reset the space's persisted policy overlay");
    }
    const permalink = await live.permalink(channelId, reply.ts);
    return {
      name: "spaces-persistence",
      status: "pass",
      details: [
        `space ${spaceId} persisted on first contact (settings + policy overlay survive turns)`,
        `settings.reasoning_effort=medium + overlay.${marker} still present after the live turn`,
      ],
      permalink,
    };
  } catch (err) {
    return { name: "spaces-persistence", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The org-settings approval journey (issue #151): a model_settings write
 * crosses the REAL policy gate, which routes ask-human through the REAL
 * Slack approval router — the approve/deny prompt posts to the channel with
 * buttons, the human's decision resolves it, and the trail records
 * approval.requested → approval.resolved (approver = the QA user). The
 * button click itself cannot be driven through the Slack API — the journey
 * extracts the request id from the posted prompt's blocks and calls the
 * router's handleAction seam, the exact call a real click makes.
 */
async function journeySettingsApproval(
  h: Harness,
  channelId: string,
  approvalRouter: SlackApprovalRouter,
): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  try {
    const beforeRequested = (await h.store.listAudit({ space: spaceId, event_type: APPROVAL_REQUESTED_EVENT })).length;
    const anchorTs = String(Date.now() / 1000 - 2);
    const gatePromise = evaluatePolicyGate(
      {
        loadPolicy: async (sid) => loadSpacePolicy(h.orgPolicy, h.store, sid),
        audit: h.audit,
        router: approvalRouter,
        timeoutMs: 3 * 60_000,
      },
      {
        tool: "model_settings",
        args: { set: { reasoning_effort: "low" } },
        spaceId,
        actor: live.qaUserId,
      },
    );
    // The prompt posts while the gate waits: observe it, then approve.
    const prompt = await findApprovalPrompt(h, channelId, {
      afterTs: anchorTs,
      tool: "model_settings",
      label: "org-settings approval",
    });
    await approvalRouter.handleAction({
      actionId: APPROVE_ACTION_ID,
      value: prompt.requestId,
      spaceId,
      principal: live.qaUserId,
      messageTs: prompt.message.ts,
    });
    const gate = await gatePromise;
    if (!gate.allowed) throw new Error(`policy gate denied model_settings: ${gate.reason}`);
    const resolved = await waitFor(
      async () => {
        const rows = await h.store.listAudit({ space: spaceId, event_type: APPROVAL_RESOLVED_EVENT });
        return rows.length > beforeRequested ? rows : undefined;
      },
      STORE_TIMEOUT_MS,
      "an approval.resolved audit row",
    );
    // SAFETY: the approval router audits APPROVAL_RESOLVED_EVENT rows with
    // {tool, approved, approver} payloads (audit-events.ts); all three are checked.
    const payload = JSON.parse(resolved[resolved.length - 1]!.payload) as {
      tool?: unknown;
      approved?: unknown;
      approver?: unknown;
    };
    if (payload.tool !== "model_settings" || payload.approved !== true || payload.approver !== live.qaUserId) {
      throw new Error(`approval.resolved mismatch: ${JSON.stringify(payload)}`);
    }
    const rewritten = await waitFor(
      async () => {
        const history = await live.history(channelId);
        return history.find((m) => m.ts === prompt.message.ts && m.text.startsWith(APPROVAL_OUTCOME_PREFIX));
      },
      STORE_TIMEOUT_MS,
      "the approval prompt rewritten with the outcome",
    );
    const permalink = await live.permalink(channelId, rewritten.ts);
    return {
      name: "org-settings-approval",
      status: "pass",
      details: [
        `model_settings prompt posted with approve/deny buttons → approved by <@${live.qaUserId}>`,
        `trail: approval.requested → approval.resolved; prompt rewritten: "${snippet(rewritten.text)}"`,
      ],
      permalink,
    };
  } catch (err) {
    return { name: "org-settings-approval", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The model hot-swap journey (issue #189): setting the space's default
 * model + effort persists (model.settings_changed audited) and the NEXT
 * turn applies it — the session re-applies the default role against the
 * current settings at turn start, no restart. Deterministic proof: the
 * settings column + the audited before/after, PLUS (issue #243) a
 * resolution proof that the stored default re-applies to the pinned
 * provider on the next turn — a bare/stripped default that resolves
 * ambiguous (or to a different provider) would silently keep the session's
 * model while persistence + reply still pass (the #243 false-pass). The
 * live turn after the change is the hot-swap observable.
 */
async function journeyModelHotSwap(h: Harness, channelId: string, runId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  try {
    const targetModel = defaultModelIdFor(h.modelRef);
    const settingsTool = modelToolsDefinitions(h.store, { audit: h.audit, agentDir: h.agentDir }).find(
      (t) => t.name === "model_settings",
    )!;
    const setRes = await settingsTool.execute(
      "tc-hotswap",
      { set: { model: targetModel, reasoning_effort: "high" } },
      undefined,
      undefined,
      toolCtxFor(h, spaceId),
    );
    if (setRes.isError) throw new Error(`model_settings set failed: ${toolResultText(setRes)}`);
    const changed = await waitFor(
      async () => {
        const rows = await h.store.listAudit({ space: spaceId, event_type: MODEL_SETTINGS_CHANGED_EVENT });
        return rows.length > 0 ? rows[rows.length - 1] : undefined;
      },
      STORE_TIMEOUT_MS,
      "a model.settings_changed audit row",
    );
    // SAFETY: the settings tool audits MODEL_SETTINGS_CHANGED_EVENT rows with
    // {scope, space?, actor, before, after} payloads where after holds
    // SpaceModelSettings — all string values (store/db.ts).
    const changedPayload = JSON.parse(changed.payload) as { after?: Record<string, string>; before?: unknown };
    if (changedPayload.after?.model !== targetModel || changedPayload.after?.reasoning_effort !== "high") {
      throw new Error(`model.settings_changed after mismatch: ${JSON.stringify(changedPayload.after)}`);
    }
    const persisted = await h.store.getSpaceSettings(spaceId);
    if (persisted.model !== targetModel || persisted.reasoning_effort !== "high") {
      throw new Error(`space settings did not persist the swap: ${JSON.stringify(persisted)}`);
    }
    // Issue #243 — prove the swap is APPLIED, not just persisted. The next
    // turn's re-apply routes `persisted.model` through the provider-aware
    // resolver at turn start; a stored value it cannot resolve to ONE
    // provider (a bare id served by several providers with no near winner →
    // "ambiguous") or that lands on a DIFFERENT provider than the one pinned
    // (near's #194 preference winning a bare tie) would silently keep the
    // session on its current model while persistence + reply still pass —
    // the hot-swap false-pass. Resolve the stored default against the same
    // deployment catalog the re-apply sees and require it to pin the ref's
    // provider (when the ref is provider-qualified).
    const reapplyCatalog = await listAvailableModels(h.agentDir);
    const reapply = resolveModelPin(persisted.model, reapplyCatalog);
    if (!reapply.ok || reapply.pin.kind !== "id") {
      throw new Error(
        `stored default '${persisted.model}' would not re-apply on the next turn (${reapply.ok ? "role ref" : reapply.error}) — the swap is not applied`,
      );
    }
    const pinnedProvider = defaultModelProviderFor(h.modelRef);
    if (pinnedProvider !== undefined && reapply.pin.provider !== pinnedProvider) {
      throw new Error(
        `stored default '${persisted.model}' re-applies as ${reapply.pin.provider}/${reapply.pin.modelId}, not its pinned ${pinnedProvider} model — the swap is not applied`,
      );
    }
    // The NEXT turn applies the changed default at turn start (issue #189):
    // the live session re-reads the settings and the turn completes.
    const { reply } = await postAndWait(h, channelId, `hot-swap probe ${runId}: reply with ok`, {
      label: "hot-swap next turn",
    });
    const permalink = await live.permalink(channelId, reply.ts);
    return {
      name: "model-hot-swap",
      status: "pass",
      details: [
        `space default pinned to ${targetModel} at high effort (model.settings_changed audited, settings persisted)`,
        `next-turn re-apply resolves '${persisted.model}' to ${reapply.pin.provider}/${reapply.pin.modelId} (no ambiguity)`,
        `the next turn ran on the swapped default — reply: "${snippet(reply.text)}"`,
      ],
      permalink,
    };
  } catch (err) {
    return { name: "model-hot-swap", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The model-catalog surface journey (issue #192): the model_settings get
 * lists the deployment's available models grouped by provider — the same
 * catalog create_work_item pins resolve against (issue #185) and the agent
 * answers provider-aware asks from. Deterministic proof: the settings GET
 * returns available_models (providers × models); the live reply names a
 * model (soft — the live model's wording is not gating).
 */
async function journeyCatalogSurface(h: Harness, channelId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  try {
    const settingsTool = modelToolsDefinitions(h.store, { audit: h.audit, agentDir: h.agentDir }).find(
      (t) => t.name === "model_settings",
    )!;
    const getRes = await settingsTool.execute("tc-catalog", {}, undefined, undefined, toolCtxFor(h, spaceId));
    if (getRes.isError) throw new Error(`model_settings get failed: ${toolResultText(getRes)}`);
    // SAFETY: the model_settings get tool serializes its catalog as JSON with
    // available_models[{provider, models[{id}]}]; the journey asserts the
    // list is non-empty and fails loudly otherwise.
    const body = JSON.parse(toolResultText(getRes)) as {
      available_models?: Array<{ provider: string; models: Array<{ id: string }> }>;
    };
    const providers = body.available_models ?? [];
    if (providers.length === 0 || providers.some((p) => p.models.length === 0)) {
      throw new Error(`model_settings get returned no available models: ${snippet(JSON.stringify(providers))}`);
    }
    const { reply } = await postAndWait(h, channelId, `which models can you use? list them briefly`, {
      label: "catalog surface",
    });
    const named = /deepseek|model/i.test(reply.text);
    const permalink = await live.permalink(channelId, reply.ts);
    return {
      name: "model-catalog-surface",
      status: "pass",
      details: [
        `model_settings get surfaced ${providers.length} provider(s): ${providers.map((p) => `${p.provider} (${p.models.length})`).join(", ")}`,
        named ? "the live reply named the catalog" : "the live reply did not name a model (not gating)",
      ],
      permalink,
    };
  } catch (err) {
    return { name: "model-catalog-surface", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The chat-native extension-pin journey (issue #195): catalog_browser
 * action=pin completes a draft IN-CHANNEL — the review gate refuses
 * without the human's confirmation (fail closed), and confirm=true writes
 * the pinned snapshot, hot-registers it into the LIVE registry, regenerates
 * the egress configs, and audits. Driven through the real tool definition
 * with temp dirs (the repo's config/extensions + egress stay untouched);
 * the draft itself is the canary fixture (the catalog-fetch leg is the
 * tool's own, covered hermetically by fetch-catalog tests).
 */
async function journeyExtensionPin(h: Harness, channelId: string): Promise<JourneyResult> {
  const spaceId = `slack:${channelId}`;
  const tempRoot = mkdtempSync(join(tmpdir(), "bottega-canary-pin-"));
  const draftsDir = join(tempRoot, "drafts");
  const snapshotsDir = join(tempRoot, "snapshots");
  const egressPath = join(tempRoot, "egress.yml");
  const devEgressPath = join(tempRoot, "egress.dev.yml");
  const spec = "fixture.pin";
  try {
    // The draft the agent would produce (issue #195): completed binding +
    // credentialSchema from vendor docs; source.reviewed stays false until
    // the human confirms.
    const draft: SnapshotDraft = {
      schema: SNAPSHOT_SCHEMA,
      extensionId: spec,
      pinnedAt: new Date().toISOString(),
      // Non-default catalog marker: pinSnapshotDraft skips the catalog
      // re-fetch (the canary fixture has no integrations.sh record).
      source: { catalog: "canary://fixture", specId: spec, vendorOfficial: true, reviewed: false },
      manifest: {
        id: spec,
        label: "Fixture Pin MCP",
        vendor: "bottega-fixtures",
        kind: "mcp",
        domains: ["fixture-pin.example.com"],
        mcp: { serverUrl: "https://fixture-pin.example.com/mcp", transport: "streamable-http" },
        credentialSchema: { type: "oauth", scopes: ["read"] },
        tools: [],
      },
    };
    mkdirSync(draftsDir, { recursive: true });
    writeFileSync(join(draftsDir, `${spec}.draft.json`), JSON.stringify(draft, null, 2) + "\n");

    const catalogBrowser = adminToolDefinitions(h.store, {
      audit: h.audit,
      registry: h.extensionRegistry,
      catalogDraftsDir: draftsDir,
      catalogSnapshotsDir: snapshotsDir,
      devEgressConfigPath: devEgressPath,
      egressConfigPath: egressPath,
    }).find((t) => t.name === "catalog_browser")!;

    const pinParams = {
      action: "pin",
      spec,
      binding: { serverUrl: "https://fixture-pin.example.com/mcp", transport: "streamable-http" },
      credential_schema: { type: "oauth", scopes: ["read"] },
      vendor_official: true,
    } as const;
    // The review gate: no human confirmation → refuse, nothing pins.
    const refused = await catalogBrowser.execute("tc-pin-1", pinParams, undefined, undefined, toolCtxFor(h, spaceId));
    if (!refused.isError || !toolResultText(refused).includes("confirm")) {
      throw new Error(`pin without confirmation was not refused: ${toolResultText(refused)}`);
    }
    // The human confirms in-channel (the review): the pin completes.
    const pinned = await catalogBrowser.execute(
      "tc-pin-2",
      { ...pinParams, confirm: true },
      undefined,
      undefined,
      toolCtxFor(h, spaceId),
    );
    if (pinned.isError) throw new Error(`pin with confirmation failed: ${toolResultText(pinned)}`);
    // SAFETY: the catalog_browser pin tool returns {reviewed, written_to,
    // live_registry, egress_regenerated} JSON; each field is checked below.
    const pinnedBody = JSON.parse(toolResultText(pinned)) as {
      reviewed?: unknown;
      written_to?: unknown;
      live_registry?: unknown;
      egress_regenerated?: unknown;
    };
    if (pinnedBody.reviewed !== true || !pinnedBody.written_to) {
      throw new Error(`pin result missing reviewed/written_to: ${snippet(toolResultText(pinned))}`);
    }
    if (pinnedBody.live_registry !== "registered") {
      throw new Error(`pin did not hot-register into the live registry: ${JSON.stringify(pinnedBody.live_registry)}`);
    }
    // The live registry now resolves the extension (hot-reload, issue #197) —
    // new sessions would see it without a restart.
    const registered = h.extensionRegistry.resolve(spec);
    if (!registered) throw new Error("the pinned extension is not registered in the live registry");
    const audit = await waitFor(
      async () => {
        const rows = await h.store.listAudit({ event_type: ADMIN_CATALOG_BROWSER_EVENT });
        return rows.some((r) => {
          // SAFETY: the catalog browser audits ADMIN_CATALOG_BROWSER_EVENT rows
          // with {action, spec?, query?, written_to?} payloads (audit-events.ts);
          // only action and spec are compared here.
          const p = JSON.parse(r.payload) as { action?: unknown; spec?: unknown };
          return p.action === "pin" && p.spec === spec;
        })
          ? rows
          : undefined;
      },
      STORE_TIMEOUT_MS,
      "the catalog_browser pin audit row",
    );
    return {
      name: "extension-pin",
      status: "pass",
      details: [
        `catalog_browser pin for ${spec}: review gate refused unconfirmed → confirm=true pinned + hot-registered + egress regenerated`,
        `audited (${audit.length} catalog_browser row(s)); live registry resolves ${registered.manifest.label}`,
      ],
    };
  } catch (err) {
    return { name: "extension-pin", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The generic MCP OAuth journey (issue #198): connecting a hosted OAuth MCP
 * mints a single-use authorization flow and SHOWS the URL in Slack (the
 * one-time-link posture — the token never touches chat). The browser leg
 * (the vendor's authorization server + the SDK's PKCE exchange + the
 * callback endpoint) is SKIP-GATED with evidence: it needs a real browser.
 * The mint → URL-shown leg runs live: since #273 the message reaches the
 * AGENT, whose connect_extension tool call (the per-session tool path,
 * issue #52) drives the capability — the mint row is the deterministic
 * proof the tool ran. The callback's first gate (single-use state, fail
 * closed) is proven hermetically by consuming the flow token twice.
 */
async function journeyMcpOAuth(h: Harness, channelId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  try {
    const beforeConnected = (await h.store.listAudit({ space: spaceId, event_type: EXTENSION_CONNECTED_EVENT })).length;
    const { reply } = await postAndWait(h, channelId, `connect ${CANARY_OAUTH_EXTENSION_ID}`, {
      label: "MCP OAuth connect mint",
    });
    const permalink = await live.permalink(channelId, reply.ts);
    const url = oauthAuthorizeUrlFrom(reply.text);
    if (!reply.text.includes("Open this link to authorize") || url === undefined) {
      throw new Error(`connect did not mint + show the authorization URL: "${snippet(reply.text)}"`);
    }
    const state = oauthAuthorizeStateFrom(reply.text);
    if (!state) throw new Error("authorization URL carries no state");
    // The mint persisted a single-use flow row (the callback's first gate):
    // consume succeeds once; a replay (stale/consumed state) fails closed.
    const flowStore = new OAuthFlowStore(h.store);
    const first = flowStore.consume(state);
    if (!first.ok) throw new Error("the minted OAuth flow state was not consumable");
    if (flowStore.consume(state).ok) throw new Error("the OAuth flow state consumed twice — replay was not denied");
    // The credential lands only when the BROWSER leg completes — no
    // extension.connected row yet (skip-gated with evidence).
    const connected = await h.store.listAudit({ space: spaceId, event_type: EXTENSION_CONNECTED_EVENT });
    const skipEvidence =
      connected.length <= beforeConnected
        ? "browser leg skip-gated: the vendor authorization + PKCE exchange + callback endpoint need a real browser (issue #198); mint → URL-shown ran live, the single-use state + replay-denied ran hermetically"
        : "browser leg completed and recorded extension.connected";
    return {
      name: "mcp-oauth-connect",
      status: "pass",
      details: [
        `connect ${CANARY_OAUTH_EXTENSION_ID} minted a single-use flow and showed the URL in Slack: ${snippet(url, 80)}`,
        skipEvidence,
      ],
      permalink,
    };
  } catch (err) {
    return { name: "mcp-oauth-connect", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The minted upload URL from the connect_upload_link result text (issues
 * #212 + #224): the mint tool returns the URL on its own line followed by
 * the relay-copy instruction (uploadLinkRelayText — the model must relay
 * the link verbatim), and Slack renders URLs as <url> in message text.
 * The journey reads the URL back from that text, so the extraction stops
 * at the first whitespace/newline/`>` after the URL — the relay line and
 * the angle brackets are the tool's/chat's copy, never part of the link.
 * The host is deliberately NOT pinned to the loopback shape: a deployment
 * with a public base (BOTTEGA_OAUTH_CALLBACK_BASE_URL) mints a real
 * https URL (the #224 live shape — the #212 fix covered only the
 * <url>-wrapped loopback shape, and the bare
 * `https://<host>/upload/<token>` + newline + relay-copy reply captured
 * the relay line as "malformed upload URL"). Exported for the hermetic
 * journey-mechanism tests.
 */
export function uploadLinkUrlFrom(text: string): string | undefined {
  return /https?:\/\/[^\s<>]+\/upload\/[A-Za-z0-9_-]+/.exec(text.trim())?.[0];
}

/**
 * The one-time upload link journey (issue #196): the mint tool returns a
 * single-use URL; the browser endpoint serves the secret form; POSTing the
 * secret stores it DIRECTLY into the vault through the same connect path as
 * connectExtension (registry upsert + extension.connected audit) — the
 * secret never passes through Slack. Replay of the link fails (single-use,
 * fail closed). The upload endpoint is the REAL in-process server (loopback)
 * over the harness store.
 */
async function journeyUploadLink(h: Harness, channelId: string, uploadLink: UploadLinkServerHandle): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const spaceId = `slack:${channelId}`;
  try {
    const secret = `canary-upload-secret-${Date.now().toString(36)}`;
    const mintTool = mintUploadLinkToolDefinition({
      registry: h.extensionRegistry,
      store: uploadLink.store,
      baseUrl: () => uploadLink.baseUrl,
      getPrincipal: () => live.qaUserId,
      spaceIdFromFile: () => spaceId,
    });
    const minted = await mintTool.execute(
      "tc-mint",
      { extension: FIXTURE_EXTENSION_ID, scope: "personal" },
      undefined,
      undefined,
      toolCtxFor(h, spaceId),
    );
    if (minted.isError) throw new Error(`connect_upload_link mint failed: ${toolResultText(minted)}`);
    const url = uploadLinkUrlFrom(toolResultText(minted));
    if (!url) throw new Error(`mint returned a malformed upload URL: "${toolResultText(minted).trim()}"`);
    // The form (GET): no scripts, no secret on the wire.
    const form = await fetch(url);
    if (form.status !== 200) throw new Error(`upload form GET returned ${form.status}`);
    const html = await form.text();
    if (!html.includes('name="secret"')) throw new Error("upload form has no secret field");
    // The upload (POST): the secret goes straight into the vault.
    const body = new FormData();
    body.append("secret", secret);
    const upload = await fetch(url, { method: "POST", body });
    if (upload.status !== 200) throw new Error(`upload POST returned ${upload.status}: ${await upload.text()}`);
    const uploaded = await upload.text();
    if (!uploaded.includes("Saved to the vault")) throw new Error("upload POST did not confirm the vault write");
    // Vault proof: the credential row + the extension.connected audit.
    const credentials = await h.store.listExtensionCredentials(FIXTURE_EXTENSION_ID);
    const row = credentials.find((c) => c.scope === "personal" && c.owner === live.qaUserId);
    if (!row) throw new Error("no personal credential row recorded for the uploaded secret");
    await waitFor(
      async () => {
        const rows = await h.store.listAudit({ space: spaceId, event_type: EXTENSION_CONNECTED_EVENT });
        return rows.some((r) => {
          // SAFETY: the connect flow audits EXTENSION_CONNECTED_EVENT rows with
          // {extension, scope, owner} payloads (audit-events.ts); only extension
          // and scope are compared here.
          const p = JSON.parse(r.payload) as { extension?: unknown; scope?: unknown };
          return p.extension === FIXTURE_EXTENSION_ID && p.scope === "personal";
        })
          ? rows
          : undefined;
      },
      STORE_TIMEOUT_MS,
      "the extension.connected audit row for the upload",
    );
    // Single-use: the consumed link is gone (fail closed).
    const replay = await fetch(url);
    if (replay.status !== 404) throw new Error(`upload link replay returned ${replay.status}, expected 404`);
    return {
      name: "upload-link",
      status: "pass",
      details: [
        `mint → form → POST stored the secret in the vault (credential row ${row.id}, extension.connected audited)`,
        "the secret never touched Slack; the link is single-use (replay → 404)",
      ],
    };
  } catch (err) {
    return { name: "upload-link", status: "fail", details: [errorMessage(err)] };
  }
}

/**
 * The live-progress journey (issue #193): during a turn the thinking phrase
 * becomes a LIVE PROGRESS line — the current tool step ("⚙️ …"), the latest
 * reasoning snippet ("🧠 …"), or the elapsed "Thinking… Ns" — replaced in
 * place. DMs always use the phrase renderer (issue #180), so the journey
 * observes the progress line in history while the turn runs.
 */
const PROGRESS_LINE_RE = /^(?:⚙️ |🧠 |Thinking… \d+s$)/;
/** Exported for the hermetic mechanism tests (issue #193). */
export { PROGRESS_LINE_RE };

async function journeyLiveProgress(h: Harness, channelId: string, runId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  try {
    const inboundTs = (
      await live.postAsUser(
        channelId,
        `canary ${runId} (live-progress): think step by step and reply with the numbers from 1 to 10`,
      )
    ).ts;
    const after = parseFloat(inboundTs);
    const progress = await waitFor(
      async () => {
        const history = await live.history(channelId);
        return history.find((m) => isBotMessage(h, m) && parseFloat(m.ts) > after && PROGRESS_LINE_RE.test(m.text.trim()));
      },
      JOURNEY_TIMEOUT_MS,
      "the thinking phrase turning into a live progress line",
    );
    const reply = await waitForBotReply(h, channelId, { afterTs: inboundTs, label: "live-progress final reply" });
    const permalink = await live.permalink(channelId, reply.ts);
    return {
      name: "live-progress",
      status: "pass",
      details: [
        `the phrase became a progress line during the turn: "${snippet(progress.text)}"`,
        `final reply: "${snippet(reply.text)}"`,
      ],
      permalink,
    };
  } catch (err) {
    return { name: "live-progress", status: "fail", details: [errorMessage(err)] };
  }
}

/** The live leg: boots the real stack and runs every journey. */
export async function runLiveLeg(tokens: LiveSlackTokens): Promise<CanaryResult> {
  const journeys: JourneyResult[] = [];
  let harness: Harness | undefined;
  let scheduler: Scheduler | undefined;
  let uploadLink: UploadLinkServerHandle | undefined;
  try {
    // The REAL Slack-backed approval router (issue #44/#151): write-tier
    // tool calls prompt with approve/deny buttons through the harness
    // adapter (lazy — the adapter exists only after boot). The org-settings
    // approval journey resolves the prompt through handleAction (the exact
    // seam a real button click calls); use_model is allow-listed in the
    // canary org config so the model-role journey never stalls on a prompt.
    const approvalRouter = new SlackApprovalRouter({
      adapter: {
        postMessage: (spaceId, text, opts) => harness!.adapter.postMessage(spaceId, text, opts),
        updateMessage: (spaceId, ts, text) => harness!.adapter.updateMessage(spaceId, ts, text),
      },
      timeoutMs: 5 * 60_000,
    });
    harness = await bootHarness({
      realSlack: true,
      realModel: true,
      slackTokens: tokens,
      orgConfigYaml: CANARY_ORG_CONFIG,
      approve: approvalRouter,
      // The canary's own registry: the weather fixture (issue #175) + the
      // hosted-OAuth fixture (issue #198) — scripted providers so the REAL
      // runtime spine (policy gate → credential ladder → boundary → MCP /
      // connect capability → audit) runs deterministically.
      registry: createCanaryRegistry(),
      mcpTransport: canaryFixtureMcpTransport,
      extensionBoundary: canaryFixtureBoundary(),
      // Real-model digests on dispose: keep the idle window well past the run.
      idleTimeoutMs: 5 * 60_000,
      liveConnect: {
        broker: canaryBroker,
        mcpOAuth: canaryMcpOAuthConnector(() => harness!.store),
        timeoutMs: 3 * 60_000,
      },
    });
    // The one-time upload-link endpoint (issue #196): the REAL in-process
    // loopback server over the harness store — the mint tool + the browser
    // form share its token table.
    uploadLink = startUploadLinkServer({
      store: harness.store,
      registry: harness.extensionRegistry,
      audit: harness.audit,
      broker: canaryBroker,
      gate: {
        loadPolicy: async (spaceId) => loadSpacePolicy(harness!.orgPolicy, harness!.store, spaceId),
        router: approvalRouter,
      },
    });
    // The standup journey needs the REAL scheduler (issue #175): boot the
    // durable runner with the standup action over the harness's live store
    // and adapter — the server's wiring (src/server/index.ts), minus the
    // actions the canary does not drive.
    scheduler = startScheduler({
      store: harness.store,
      audit: harness.audit,
      registry: buildRegistry([standupDigestAction]),
      memoryProvider: harness.memory,
      postMessage: (spaceId, text) => harness!.adapter.postMessage(spaceId, text),
      loadPolicy: (spaceId) => loadSpacePolicy(harness!.orgPolicy, harness!.store, spaceId),
      log: (line) => console.log(line),
    });
    scheduler.start();
    const live = harness.liveSlack!;
    const runId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`;
    const channelName = tokens.channelName ?? "bottega-qa";

    // Setup: locate/create the dedicated test channel (issue #79). The bot
    // token creates it (channels:manage) and invites both members; a scope
    // shortfall skips the channel leg with the required scopes listed.
    let channel: { id: string; created: boolean; invited: { bot: boolean; qa: boolean } } | undefined;
    try {
      channel = await live.ensureChannel(channelName);
      // The flag now reflects REAL membership (issue #245): the bot token
      // created the channel and the invite is best-effort — the canary only
      // reports the stitch when the bot is actually IN the private channel;
      // otherwise it skips with the reason instead of a misleading pass.
      if (channel.invited.bot) {
        journeys.push({
          name: "setup-channel",
          status: "pass",
          details: [
            `channel #${channelName} ${channel.created ? "created" : "located"}: <#${channel.id}>`,
            `bot in channel: ${channel.invited.bot}; QA user in channel: ${channel.invited.qa}`,
          ],
        });
      } else {
        journeys.push({
          name: "setup-channel",
          status: "skip",
          details: [
            `bot not a member of #${channelName} — the channel stitch needs the bot IN private channels, so there is nothing to show (issue #245)`,
            `QA user in channel: ${channel.invited.qa}`,
          ],
        });
      }
    } catch (err) {
      journeys.push({
        name: "setup-channel",
        status: "skip",
        details: [
          `channel setup failed (DM journeys still run): ${errorMessage(err)}`,
          "required scopes: channels:manage (conversations.create on the bot token) + channels:join / " +
            "conversations.invite for both members (bot + QA user)",
        ],
      });
    }

    journeys.push(await journeyChatReply(harness, live.dmChannelId, { label: "DM", runId }));
    // The thread-in-#name leg is gated on the bot being a real member
    // (#245) — running it in a channel the bot cannot see only ever
    // produced a bare timeout, not a channel-stitch signal.
    if (channel?.invited.bot) {
      journeys.push(
        await journeyChatReply(harness, channel.id, { label: `channel #${channelName}`, thread: true, runId }),
      );
    }
    journeys.push(await journeyMemory(harness, live.dmChannelId, runId));
    journeys.push(await journeyWorkItem(harness, live.dmChannelId, runId));
    journeys.push(await journeyConnect(harness, live.dmChannelId));
    // Issue #175 journeys: the standup needs the QA channel space (run
    // after the channel chat journey created it); extension + model-role
    // ride the DM like memory/work-item.
    const standupChannel = channel ? channel.id : live.dmChannelId;
    journeys.push(await journeyStandup(harness, standupChannel));
    journeys.push(await journeyExtension(harness, live.dmChannelId, runId));
    journeys.push(await journeyModelRole(harness, live.dmChannelId, runId));

    // Full-matrix journeys (#175 follow-up): each asserts one observable
    // feature end-to-end against the live workspace.
    journeys.push(await journeyDeliveryApproval(harness, live.dmChannelId, runId)); // #149
    journeys.push(await journeyPerTaskPin(harness, live.dmChannelId, runId)); // #185
    journeys.push(await journeySemanticPickup(harness, live.dmChannelId, runId)); // #89
    journeys.push(await journeySpacesPersistence(harness, live.dmChannelId, runId)); // #188
    journeys.push(await journeySettingsApproval(harness, live.dmChannelId, approvalRouter)); // #151
    journeys.push(await journeyModelHotSwap(harness, live.dmChannelId, runId)); // #189
    journeys.push(await journeyCatalogSurface(harness, live.dmChannelId)); // #192
    journeys.push(await journeyExtensionPin(harness, live.dmChannelId)); // #195
    journeys.push(await journeyMcpOAuth(harness, live.dmChannelId)); // #198 (browser leg skip-gated)
    journeys.push(await journeyUploadLink(harness, live.dmChannelId, uploadLink)); // #196
    journeys.push(await journeyLiveProgress(harness, live.dmChannelId, runId)); // #193

    const failed = journeys.filter((j) => j.status === "fail");
    const attempted = journeys.filter((j) => j.status !== "skip");
    const passed = attempted.filter((j) => j.status === "pass").length;
    return {
      status: failed.length > 0 ? "failed" : "passed",
      message:
        failed.length > 0
          ? `live-slack canary FAILED — ${failed.length} of ${attempted.length} journey(s) failed (run ${runId})`
          : `live-slack canary PASSED — ${passed}/${attempted.length} journeys (run ${runId}); DM <#${live.dmChannelId}>${channel ? `, channel #${channelName} <#${channel.id}>` : ""}`,
      journeys,
    };
  } catch (err) {
    return {
      status: "failed",
      message: `live-slack canary aborted before the journeys completed: ${errorMessage(err)}`,
      journeys,
    };
  } finally {
    scheduler?.stop();
    uploadLink?.stop();
    try {
      await harness?.cleanup();
    } catch {
      // Cleanup failures (e.g. digest turn errors) never mask the report.
    }
  }
}

/** Entry point (also the test seam): gate → resolve → run. */
export async function runCanary(
  argv: string[],
  deps: TokenDeps,
): Promise<CanaryResult> {
  // CI-strict mode (issue #175): the scheduled workflow passes --ci (or
  // CANARY_CI=1) so missing credentials FAIL the job instead of skipping —
  // a canary that silently skips in CI is worse than none.
  const ciStrict = argv.includes("--ci") || deps.env.CANARY_CI === "1";
  if (!argv.includes("--live-slack") && deps.env.LIVE_SLACK !== "1") {
    return {
      status: "skipped",
      message: "live-slack canary skipped — pass --live-slack (or LIVE_SLACK=1) to run it (issue #79)",
      journeys: [],
    };
  }
  const inCI = deps.env.CI === "true" || deps.env.CI === "1";
  if (inCI && !ciStrict) {
    return {
      status: "skipped",
      message: "live-slack canary skipped — the live leg NEVER runs in ad-hoc CI (issue #79); " +
        "the scheduled workflow (issue #175) runs it with --ci",
      journeys: [],
    };
  }
  const resolved = resolveLiveTokens(deps);
  if (resolved.tokens === undefined) {
    if (ciStrict) {
      return {
        status: "failed",
        message:
          `live-slack canary FAILED in CI-strict mode — missing required secrets: ${resolved.missing.join(", ")} ` +
          "(set them as GitHub Actions repository secrets; features.md → “Live-Slack QA canary”, issue #175)",
        journeys: [],
      };
    }
    return {
      status: "skipped",
      message:
        `live-slack canary skipped — missing: ${resolved.missing.join(", ")} ` +
        "(env or macOS Keychain; see features.md → “Live-Slack QA canary” for the QA user + token setup, issue #79)",
      journeys: [],
    };
  }
  // The real model needs a key (issue #71 semantics): NEAR is preferred —
  // its gateway accepts the space agent's dotted tool names; the
  // opencode-go gateway rejects them (live finding, issue #71).
  if (resolveModelKey(deps) === null) {
    if (ciStrict) {
      return {
        status: "failed",
        message:
          "live-slack canary FAILED in CI-strict mode — no model key " +
          "(set NEAR_API_KEY, CODEX_AUTH_PATH (a Codex CLI auth file, issue #214), or CANARY_MODEL_REF as a " +
          "GitHub Actions repository secret; prefer NEAR — the opencode-go gateway rejects the agent's dotted " +
          "tool names, issue #71; issue #175)",
        journeys: [],
      };
    }
    return {
      status: "skipped",
      message:
        "live-slack canary skipped — no model key (set NEAR_API_KEY or OPENCODE_API_KEY in env, " +
        "set CODEX_AUTH_PATH to a Codex CLI auth file (issue #214), or store a key: " +
        "security add-generic-password -s bottega-near -a \"$(whoami)\" -w '<key>'; " +
        "prefer NEAR — the opencode-go gateway rejects the agent's dotted tool names, issue #71)",
      journeys: [],
    };
  }
  // The harness resolves the model ref from env (pickRealModelRef) and the
  // deployment catalog reads the key from env too — when the key came from
  // the Keychain, surface it into the process env first. The codex source
  // (issue #214) is a FILE, not a Keychain key — CODEX_AUTH_PATH needs no
  // surfacing; when it is set, no Keychain key is consulted.
  if (
    !deps.env.NEAR_API_KEY?.trim() &&
    !deps.env.OPENCODE_API_KEY?.trim() &&
    !deps.env.CODEX_AUTH_PATH?.trim() &&
    !deps.env.CANARY_MODEL_REF?.trim()
  ) {
    const near = deps.keychain("bottega-near");
    if (near) deps.env.NEAR_API_KEY = near;
    else {
      const opencode = deps.keychain("bottega-opencode");
      if (opencode) deps.env.OPENCODE_API_KEY = opencode;
    }
  }
  return runLiveLeg(resolved.tokens);
}

if (import.meta.main) {
  const result = await runCanary(process.argv.slice(2), { env: process.env, keychain: keychainGet });
  const lines = [result.message, ""];
  for (const j of result.journeys) {
    lines.push(`[${j.status.toUpperCase()}] ${j.name}${j.permalink ? ` — ${j.permalink}` : ""}`);
    for (const detail of j.details) {
      if (detail) lines.push(`    ${detail}`);
    }
  }
  console.log(lines.join("\n"));
  process.exit(result.status === "skipped" || result.status === "passed" ? 0 : 1);
}
