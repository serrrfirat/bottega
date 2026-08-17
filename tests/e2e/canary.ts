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
 * approve), the connect intent seam, the scheduled standup digest (issue
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
import { bootHarness, type Harness } from "./harness";
import { THINKING_PHRASES } from "../../src/server/services/space-service";
import {
  EXTENSION_CALL_EVENT,
  MODEL_SWITCHED_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from "../../src/store/audit-events";
import { errorMessage } from "../../src/tools/helpers";
import { loadSpacePolicy } from "../../src/policy/config";
import { buildRegistry } from "../../src/scheduler/actions";
import { startScheduler, type Scheduler } from "../../src/scheduler/runner";
import { standupDigestAction } from "../../src/scheduler/standup";
import { createSecretFileBoundary, type CredentialBoundary } from "../../src/extensions/boundary";
import {
  createFixtureRegistry,
  FIXTURE_EXTENSION_ID,
  FIXTURE_EXTENSION_TOOL,
} from "../../src/extensions/fixture";
import type { McpBinding } from "../../src/extensions/manifest";
import type { LiveSlackTokens, SlackApiMessage } from "./slack-live";

/** Org policy for the canary (issues #79/#175): memory tools allowed,
 * work-item creation on the documented always-approve path (approver:
 * "policy"), and the fixture extension's read-tier tool allowed so the
 * extension journey crosses the policy gate (the fixture extension itself
 * is registered by the canary's own registry — see runLiveLeg). */
const CANARY_ORG_CONFIG = [
  "tools:",
  "  memory.save: allow",
  "  memory.search: allow",
  "  create_work_item: allow",
  `  ${FIXTURE_EXTENSION_TOOL}: allow`,
  "approvals:",
  "  always_approve:",
  "    - create_work_item",
  "",
].join("\n");

/** Per-journey timeout: the live model + live Slack are slow by design. */
const JOURNEY_TIMEOUT_MS = 120_000;
/** How long the canary waits for deterministic store-side effects. */
const STORE_TIMEOUT_MS = 60_000;

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
      ...(qaUserId !== undefined ? { qaUserId } : {}),
      qaUserName: deps.env.SLACK_QA_USER_NAME?.trim() || "bottega-qa",
      channelName: deps.env.SLACK_QA_CHANNEL?.trim() || "bottega-qa",
    },
    missing,
  };
}

/**
 * The real model's key (issue #71 semantics), env first then Keychain:
 * CANARY_MODEL_REF overrides everything; NEAR is preferred over
 * opencode-go — the NEAR gateway accepts the space agent's dotted tool
 * names (memory.save, ...), the opencode-go gateway rejects them (live
 * finding, issue #71). Null when nothing is available.
 */
export function resolveModelKey(deps: TokenDeps): string | null {
  const read = (envKey: string, service: string): string | undefined => {
    const fromEnv = deps.env[envKey];
    if (fromEnv && fromEnv.trim()) return fromEnv;
    const fromKeychain = deps.keychain(service);
    return fromKeychain && fromKeychain.trim() ? fromKeychain : undefined;
  };
  if (deps.env.CANARY_MODEL_REF?.trim()) return deps.env.CANARY_MODEL_REF.trim()!;
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
 * Polls live history for the bot's reply to an inbound message: any
 * bot-authored message with non-empty text, newer than the inbound ts
 * (and threaded under it in channels — DMs reply plain, #40). Thinking
 * phrases are excluded: the real adapter replaces them in place (#40/#60).
 * Transient history errors retry; only a timeout fails the journey.
 */
async function waitForBotReply(
  h: Harness,
  channelId: string,
  opts: { afterTs: string; threadTs?: string; label: string; timeoutMs?: number },
): Promise<SlackApiMessage> {
  const live = h.liveSlack!;
  const after = parseFloat(opts.afterTs);
  const timeoutMs = opts.timeoutMs ?? JOURNEY_TIMEOUT_MS;
  let lastHistoryError: unknown;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const history = await live.history(channelId);
      const hit = history.find(
        (m) =>
          isBotMessage(h, m) &&
          m.text.trim().length > 0 &&
          !THINKING_PHRASES.includes(m.text.trim()) &&
          parseFloat(m.ts) > after &&
          (opts.threadTs === undefined || m.thread_ts === opts.threadTs),
      );
      if (hit) return hit;
    } catch (err) {
      lastHistoryError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no bot reply to "${opts.label}" in ${channelId} within ${timeoutMs}ms` +
          (lastHistoryError !== undefined ? ` (last history error: ${errorMessage(lastHistoryError)})` : ""),
      );
    }
    await Bun.sleep(750);
  }
}

/** Posts as the QA user and waits for the bot's reply; returns both ts values. */
async function postAndWait(
  h: Harness,
  channelId: string,
  text: string,
  opts: { label: string; thread?: boolean },
): Promise<{ inboundTs: string; reply: SlackApiMessage }> {
  const live = h.liveSlack!;
  const inboundTs = await live.postAsUser(channelId, text);
  const reply = await waitForBotReply(h, channelId, {
    afterTs: inboundTs,
    ...(opts.thread ? { threadTs: inboundTs } : {}),
    label: opts.label,
  });
  return { inboundTs, reply };
}

function snippet(text: string, max = 140): string {
  const t = text.trim().replaceAll("\n", " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
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

async function journeyMemory(h: Harness, channelId: string, runId: string): Promise<JourneyResult> {
  const live = h.liveSlack!;
  const word = `canary-${runId}`;
  try {
    // Save leg: the real model must call memory.save; the deterministic
    // proof is the SQLite store finding the fact afterwards.
    await postAndWait(h, channelId, `remember that the canary code word is ${word} — store it in memory`, {
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
    const rows = await waitFor(
      async () => {
        const rows = await h.store.listAudit({ space: spaceId, event_type: WORK_ITEM_CREATED_EVENT });
        return rows.length > before ? rows : undefined;
      },
      STORE_TIMEOUT_MS,
      "a new work item in the space",
    );
    const row = rows[rows.length - 1]!;
    const item = await h.store.getWorkItem((JSON.parse(row.payload) as { id: string }).id);
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
  try {
    // The connect intent seam (issue #61) routes `connect <extension>`
    // straight to the capability — no model turn. The shape must be EXACT
    // (parseConnectIntent rejects extra words), and the outcome is posted
    // back regardless of broker/key state; a reply IS the surface working.
    const { reply } = await postAndWait(h, channelId, "connect github", {
      label: "connect intent",
    });
    const permalink = await live.permalink(channelId, reply.ts);
    return {
      name: "connect-intent",
      status: "pass",
      details: [`intent routed to the connect capability; outcome: "${snippet(reply.text)}"`],
      permalink,
    };
  } catch (err) {
    return { name: "connect-intent", status: "fail", details: [errorMessage(err)] };
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
    const overlay = JSON.parse(space.policy_json || "{}") as Record<string, unknown>;
    const proactive = (typeof overlay.proactive === "object" && overlay.proactive !== null && !Array.isArray(overlay.proactive)
      ? overlay.proactive
      : {}) as Record<string, unknown>;
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

/** The live leg: boots the real stack and runs every journey. */
export async function runLiveLeg(tokens: LiveSlackTokens): Promise<CanaryResult> {
  const journeys: JourneyResult[] = [];
  let harness: Harness | undefined;
  let scheduler: Scheduler | undefined;
  try {
    harness = await bootHarness({
      realSlack: true,
      realModel: true,
      slackTokens: tokens,
      orgConfigYaml: CANARY_ORG_CONFIG,
      // The extension journey (issue #175) uses the canary's own fixture
      // registry + scripted MCP provider so the REAL runtime spine runs
      // deterministically (no network provider, no connect flow).
      registry: createFixtureRegistry(),
      mcpTransport: canaryFixtureMcpTransport,
      extensionBoundary: canaryFixtureBoundary(),
      // Real-model digests on dispose: keep the idle window well past the run.
      idleTimeoutMs: 5 * 60_000,
      liveConnect: {},
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

    // Setup: locate/create the dedicated test channel (issue #79).
    let channel: { id: string; created: boolean; invited: { bot: boolean; qa: boolean } } | undefined;
    try {
      channel = await live.ensureChannel(channelName);
      journeys.push({
        name: "setup-channel",
        status: "pass",
        details: [
          `channel #${channelName} ${channel.created ? "created" : "located"}: <#${channel.id}>`,
          `bot in channel: ${channel.invited.bot}; QA user in channel: ${channel.invited.qa}`,
        ],
      });
    } catch (err) {
      journeys.push({
        name: "setup-channel",
        status: "skip",
        details: [`channel setup failed (DM journeys still run): ${errorMessage(err)}`],
      });
    }

    journeys.push(await journeyChatReply(harness, live.dmChannelId, { label: "DM", runId }));
    if (channel) {
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
          "(set NEAR_API_KEY or CANARY_MODEL_REF as a GitHub Actions repository secret; prefer NEAR — " +
          "the opencode-go gateway rejects the agent's dotted tool names, issue #71; issue #175)",
        journeys: [],
      };
    }
    return {
      status: "skipped",
      message:
        "live-slack canary skipped — no model key (set NEAR_API_KEY or OPENCODE_API_KEY in env, " +
        "or store it: security add-generic-password -s bottega-near -a \"$(whoami)\" -w '<key>'; " +
        "prefer NEAR — the opencode-go gateway rejects the agent's dotted tool names, issue #71)",
      journeys: [],
    };
  }
  // The harness resolves the model ref from env (pickRealModelRef) and the
  // deployment catalog reads the key from env too — when the key came from
  // the Keychain, surface it into the process env first.
  if (!deps.env.NEAR_API_KEY?.trim() && !deps.env.OPENCODE_API_KEY?.trim() && !deps.env.CANARY_MODEL_REF?.trim()) {
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
