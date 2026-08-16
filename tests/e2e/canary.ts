/**
 * Live-Slack QA canary (issue #79): the product-surface smoke test against a
 * REAL Slack workspace.
 *
 *   bun run canary --live-slack      # or LIVE_SLACK=1
 *
 * Boots the real stack (production Socket Mode adapter + the #71 real-model
 * mode: the deployment model catalog config/omp/models.yml, keys from
 * env/Keychain) and drives product journeys AS the QA user over the real
 * API: chat replies, memory save/search, work-item creation (always-
 * approve), and the connect intent seam. Per-journey pass/fail with
 * captured Slack message permalinks.
 *
 * Skip-gated, NEVER in CI:
 *   - without --live-slack / LIVE_SLACK=1 → skip with usage
 *   - in CI → skip (this leg exists for manual/QA runs only)
 *   - missing tokens (env or macOS Keychain) → skip with a setup pointer
 *   - no model key (NEAR_API_KEY / OPENCODE_API_KEY) → skip with a pointer
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
 * Full QA setup: features.md → "Live-Slack QA canary".
 */
import { bootHarness, type Harness } from "./harness";
import { THINKING_PHRASES } from "../../src/server/services/space-service";
import { WORK_ITEM_CREATED_EVENT } from "../../src/store/audit-events";
import { errorMessage } from "../../src/tools/helpers";
import type { LiveSlackTokens, SlackApiMessage } from "./slack-live";

/** Org policy for the canary (issue #79): memory tools allowed, work-item
 * creation on the documented always-approve path (approver: "policy"). */
const CANARY_ORG_CONFIG = [
  "tools:",
  "  memory.save: allow",
  "  memory.search: allow",
  "  create_work_item: allow",
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

/** The live leg: boots the real stack and runs every journey. */
export async function runLiveLeg(tokens: LiveSlackTokens): Promise<CanaryResult> {
  const journeys: JourneyResult[] = [];
  let harness: Harness | undefined;
  try {
    harness = await bootHarness({
      realSlack: true,
      realModel: true,
      slackTokens: tokens,
      orgConfigYaml: CANARY_ORG_CONFIG,
      // Real-model digests on dispose: keep the idle window well past the run.
      idleTimeoutMs: 5 * 60_000,
      liveConnect: {},
    });
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
  if (!argv.includes("--live-slack") && deps.env.LIVE_SLACK !== "1") {
    return {
      status: "skipped",
      message: "live-slack canary skipped — pass --live-slack (or LIVE_SLACK=1) to run it (issue #79)",
      journeys: [],
    };
  }
  if (deps.env.CI === "true" || deps.env.CI === "1") {
    return {
      status: "skipped",
      message: "live-slack canary skipped — the live leg NEVER runs in CI (issue #79)",
      journeys: [],
    };
  }
  const resolved = resolveLiveTokens(deps);
  if (resolved.tokens === undefined) {
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
