/**
 * Hermetic proofs for the canary journeys added in issue #175.
 *
 * The journeys themselves are live-only (real Slack + real model); this
 * file pins their deterministic mechanisms:
 *   - the scheduled-standup journey's opt-in (the JSON proactive overlay)
 *     would fail closed on a build with #150 reverted, so the journey's
 *     "assert the post" step times out into a fail — exactly how #150
 *     should have been caught on day one;
 *   - standupCronFor produces a job due ~1 minute out that fires once
 *     (never re-fires within the hour);
 *   - the extension journey's fixture MCP provider answers the fixture
 *     tool (the transport half the live leg executes through);
 *   - the full-matrix journeys (issues #149/#185/#89/#189/#188/#192/#195/
 *     #198/#196/#193): their deterministic halves — the delivery poller +
 *     delivery router round trip, the approval router's prompt → click →
 *     rewrite, the pickup directive/classification, the settings-set
 *     persistence + audit, the catalog get surface, the catalog_browser
 *     pin review gate + hot-registration, the OAuth mint + single-use
 *     state, the upload-link mint → form → vault, and the live-progress
 *     line shapes.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostedSlackMessage, SlackApiMessage } from "./slack-live";
import type { AuditRow, WorkItem } from "../../src/store/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { proactiveEnabled } from "../../src/scheduler/proactive-config";
import { parseYamlSubset } from "../../src/yaml-subset";
import { nextCronFire } from "../../src/scheduler/cron";
import { buildRegistry } from "../../src/scheduler/actions";
import { tickScheduler } from "../../src/scheduler/runner";
import { standupDigestAction } from "../../src/scheduler/standup";
import { decidePolicyCall, loadSpacePolicy, resolveTier } from "../../src/policy/config";
import {
  ADMIN_CATALOG_BROWSER_EVENT,
  APPROVAL_REQUESTED_EVENT,
  APPROVAL_RESOLVED_EVENT,
  DELIVERY_PENDING_EVENT,
  DELIVERY_REQUESTED_EVENT,
  DELIVERY_RESOLVED_EVENT,
  EXTENSION_CALL_EVENT,
  EXTENSION_CONNECTED_EVENT,
  MODEL_SETTINGS_CHANGED_EVENT,
  MODEL_SWITCHED_EVENT,
  POLICY_EXPLAINED_EVENT,
  SCHEDULER_FIRE_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from "../../src/store/audit-events";
import { operatorReadToolDefinitions } from "../../src/tools/operator-read";
import { createFixtureRegistry, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL } from "../../src/extensions/fixture";
import { createSecretFileBoundary } from "../../src/extensions/boundary";
import { pollPendingDeliveries } from "../../src/server/services/delivery-poller";
import { resolveDeliveryAction } from "../../src/server/adapters/delivery-router";
import { APPROVAL_OUTCOME_PREFIX, SlackApprovalRouter } from "../../src/server/adapters/approval-router";
import { DELIVERY_APPROVE_ACTION_ID, APPROVE_ACTION_ID } from "../../src/server/adapters/slack";
import { evaluatePolicyGate } from "../../src/policy/gate";
import { startUploadLinkServer, mintUploadLink } from "../../src/extensions/upload-link";
import { OAuthFlowStore } from "../../src/extensions/mcp-oauth";
import { SNAPSHOT_SCHEMA } from "../../src/extensions/registry";
import type { SnapshotDraft } from "../../src/extensions/fetch-catalog";
import { adminToolDefinitions } from "../../src/tools/admin";
import { modelToolsDefinitions } from "../../src/tools/model-settings";
import { resolveModelPin, type ModelCatalogEntry } from "../../src/models/model-pin";
import { classifyPickupIntent, buildAutoPickupDirective } from "../../src/tools/work-item-pickup";
import type { JsonValue, McpBinding } from "../../src/extensions/manifest";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { bootHarness, AutoApproveRouter, type Harness, type StubTurn } from "./harness";
import { opencodeSafeToolName } from "../../src/server/drivers/agent-driver";
import {
  approvalButtonValue,
  canaryBroker,
  canaryMcpOAuthConnector,
  CANARY_OAUTH_EXTENSION_ID,
  CANARY_ORG_CONFIG,
  canaryFixtureMcpTransport,
  canaryFixturePinFetch,
  createCanaryRegistry,
  FIXTURE_PIN_MCP_URL,
  defaultModelIdFor,
  defaultModelProviderFor,
  journeySemanticPickup,
  JOURNEY_TIMEOUT_MS,
  memorySavePromptFor,
  oauthAuthorizeStateFrom,
  oauthAuthorizeUrlFrom,
  postAndWait,
  PROGRESS_LINE_RE,
  standupCronFor,
  STORE_TIMEOUT_MS,
  toolCtxFor,
  toolResultText,
  uploadLinkUrlFrom,
  waitForBotReply,
} from "./canary";
const callbackPort = process.env.BOTTEGA_CALLBACK_PORT;
beforeAll(() => {
  process.env.BOTTEGA_CALLBACK_PORT = "0";
});
afterAll(() => {
  if (callbackPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
  else process.env.BOTTEGA_CALLBACK_PORT = callbackPort;
});

/** Polls until the predicate returns a truthy value (the e2e harness pattern). */
async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await fn();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error("timed out waiting for the reply");
    await Bun.sleep(50);
  }
}

describe("scheduled-standup journey mechanism (issue #175)", () => {
  test("the journey's JSON overlay enables standup — the exact shape #150 fixed", () => {
    const overlay = JSON.stringify({ proactive: { standup: true } });
    expect(proactiveEnabled(overlay, "standup")).toBe(true);
  });

  test("the journey's opt-in fails closed on a #150-reverted build, so the journey fails", () => {
    const overlay = JSON.stringify({ proactive: { standup: true } });
    // Pre-#150, proactiveEnabled parsed spaces.policy_json with
    // parseYamlSubset, which cannot read JSON (it throws on flow
    // collections / "{"-leading keys) — the throw was caught and resolved
    // to disabled. With standups disabled the scheduler never posts the
    // digest, and journeyStandup's "assert the post" wait times out into a
    // journey fail. The exact message is incidental; the throw is the
    // contract.
    expect(() => parseYamlSubset(overlay)).toThrow();
  });

  test("standupCronFor creates a job due ~1 minute out that fires once per hour", () => {
    const now = Date.UTC(2026, 7, 17, 12, 30, 15);
    const cron = standupCronFor(now);
    const first = nextCronFire(cron, now);
    // Due at the next minute boundary: within ~1 minute of creation.
    expect(first).toBeGreaterThan(now);
    expect(first - now).toBeLessThanOrEqual(60_000);
    // Fires exactly once this hour: the next occurrence is the next hour.
    expect(nextCronFire(cron, first)).toBeGreaterThanOrEqual(first + 60 * 60_000);
  });

  test("the canary's scheduler wiring fires the digest through the harness adapter (journey mechanism)", async () => {
    // The journey (issue #175) opts a space in with the JSON overlay,
    // creates a standup job due ~1 minute out, and the canary-booted
    // scheduler posts the digest through the harness adapter — the exact
    // wiring runLiveLeg uses (real runner + standup action, emulator
    // boundary here so the mechanism is provable hermetically).
    // Fixture registry only: the default config/extensions registry probes
    // real provider surfaces at boot (network), which is slow and
    // environment-dependent — this test pins the scheduler wiring, not the
    // pinned-extension surface.
    const h = await bootHarness({ registry: createFixtureRegistry() });
    try {
      const channelId = h.slack.channelId("ops")!;
      const spaceId = `slack:${channelId}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: channelId });
      const space = await h.store.getSpace(spaceId);
      // SAFETY: spaces.policy_json is a JSON document (outside-controlled);
      // parse it at this boundary and branch on the domain value.
      const overlay = z.record(z.string(), z.unknown()).parse(JSON.parse(space!.policy_json || "{}"));
      overlay.proactive = { standup: true };
      await h.store.updatePolicy(spaceId, JSON.stringify(overlay));

      const job = await h.store.createSchedulerJob({
        action: "standup_digest",
        cron: standupCronFor(Date.now()),
        params: { space: spaceId },
        spaceId,
        createdBy: "U-owner",
      });

      await tickScheduler({
        store: h.store,
        audit: h.audit,
        registry: buildRegistry([standupDigestAction]),
        memoryProvider: h.memory,
        postMessage: (sid, text) => h.adapter.postMessage(sid, text),
        loadPolicy: (sid) => loadSpacePolicy(h.orgPolicy, h.store, sid),
        log: () => {},
        now: () => job.nextFireAt + 1000,
      });

      const posts = h.slack.store.messages.all();
      const digest = posts.find((m) => m.text.includes("Standup for"));
      expect(digest).toBeDefined();
      expect(digest!.channel_id).toBe(channelId);
      const after = await h.store.getSchedulerJob(job.id);
      expect(after!.nextFireAt).toBeGreaterThan(job.nextFireAt);
    } finally {
      await h.cleanup();
    }
  });
});

describe("scheduler-lifecycle journey mechanism (issue #308)", () => {
  test("a paused due job never fires; after resume, a run-now fires it and audits SCHEDULER_FIRE_EVENT (source manual)", async () => {
    // The journey (issue #308) drives create → pause → resume → run-now in
    // the QA space. The deterministic runner half: the runner gates cron
    // claiming on `enabled`, so a DUE but paused job produces no fire row and
    // keeps lastFiredAt null; after resume a manual run-now invocation is
    // claimed and fired (source manual), writing the SCHEDULER_FIRE_EVENT.
    const h = await bootHarness({ registry: createFixtureRegistry() });
    try {
      const channelId = h.slack.channelId("ops")!;
      const spaceId = `slack:${channelId}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: channelId });
      const due = Date.now();

      const job = await h.store.createSchedulerJob({
        action: "standup_digest",
        cron: standupCronFor(due),
        params: { space: spaceId },
        spaceId,
        createdBy: "U-owner",
      });
      expect(job.enabled).toBe(true);

      const tick = (now: number) =>
        tickScheduler({
          store: h.store,
          audit: h.audit,
          registry: buildRegistry([standupDigestAction]),
          memoryProvider: h.memory,
          postMessage: (sid, text) => h.adapter.postMessage(sid, text),
          loadPolicy: (sid) => loadSpacePolicy(h.orgPolicy, h.store, sid),
          log: () => {},
          now: () => now,
        });

      // Pause → a due tick must NOT fire the job (no fire row, lastFiredAt null).
      const paused = await h.store.pauseSchedulerJob(job.id, job.revision);
      expect(paused.enabled).toBe(false);
      await tick(due + 60_000);
      const frozen = await h.store.getSchedulerJob(job.id);
      expect(frozen!.lastFiredAt).toBeNull();
      const pausedFires = (await h.store.listAudit({ space: spaceId, event_type: SCHEDULER_FIRE_EVENT })).filter(
        (row) => row.payload.includes(`"id":"${job.id}"`),
      );
      expect(pausedFires).toHaveLength(0);

      // Resume → run-now → the next tick claims + fires the manual invocation.
      const resumed = await h.store.resumeSchedulerJob(job.id, paused.revision, due + 60_000);
      expect(resumed.enabled).toBe(true);
      const invocationId = `hermetic-sj-${job.id}`;
      const enqueued = await h.store.enqueueSchedulerRunNow({
        jobId: job.id,
        expectedRevision: resumed.revision,
        invocationId,
        requestedAt: due + 60_001,
      });
      expect(enqueued.created).toBe(true);
      await tick(due + 60_002);

      const fires = (await h.store.listAudit({ space: spaceId, event_type: SCHEDULER_FIRE_EVENT })).filter(
        (row) => row.payload.includes(invocationId),
      );
      expect(fires).toHaveLength(1);
      expect(fires[0]!.payload).toContain('"source":"manual"');
      expect(fires[0]!.payload).toContain(`"id":"${job.id}"`);
      const fired = await h.store.getSchedulerJob(job.id);
      expect(fired!.lastFiredAt).not.toBeNull();
      expect(fired!.lastResult).toBe("ok");
      // The run-now fired the job exactly once (no extra cron firing this window).
      const allFires = (await h.store.listAudit({ space: spaceId, event_type: SCHEDULER_FIRE_EVENT })).filter(
        (row) => row.payload.includes(`"id":"${job.id}"`),
      );
      expect(allFires).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });
});

describe("operator-home policy-explanation journey mechanism (issue #320)", () => {
  test("explain_policy on a read-tier allow-list tool reports allow/no-approval matching policy state, and is audited without an approval row", async () => {
    // The journey (issue #320) invokes the operator-home surface in a space:
    // the read-tier allow-list tool explanation must agree with the pure
    // decision table (allow, approval_required false) and write a
    // policy.explained audit row — never an approval.requested row.
    const h = await bootHarness({ registry: createFixtureRegistry(), orgConfigYaml: "tools:\n  list_scheduler_jobs: allow\n" });
    try {
      const channelId = h.slack.channelId("ops")!;
      const spaceId = `slack:${channelId}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: channelId });
      const [, explain] = operatorReadToolDefinitions(h.store, {
        audit: h.audit,
        orgPolicy: h.orgPolicy,
        actorForSpace: () => "U-owner",
      });

      const readTierTool = "list_scheduler_jobs";
      const run = (tool: ToolDefinition, params: { tool?: string }) =>
        tool.execute("call-1", params, undefined, undefined, toolCtxFor(h, spaceId));
      const runResult = await run(explain!, { tool: readTierTool });
      // SAFETY: explain_policy returns a single text block carrying the JSON
      // PolicyExplanation (see operator-read.ts); the boundary parse below
      // reads exactly the four fields the journey asserts.
      const explanation = JSON.parse(toolResultText(runResult)) as {
        tool: string;
        space: string;
        tier: string;
        decision: string;
        approval_required: boolean;
      };
      const effective = await loadSpacePolicy(h.orgPolicy, h.store, spaceId);
      expect(explanation.tool).toBe(readTierTool);
      expect(explanation.space).toBe(spaceId);
      expect(explanation.tier).toBe(resolveTier(readTierTool));
      expect(explanation.tier).toBe("read");
      expect(explanation.decision).toBe(decidePolicyCall(effective, readTierTool).decision);
      expect(explanation.decision).toBe("allow");
      expect(explanation.approval_required).toBe(false);

      const explained = await h.store.listAudit({ space: spaceId, event_type: POLICY_EXPLAINED_EVENT });
      expect(explained).toHaveLength(1);
      expect(explained[0]!.payload).toContain(readTierTool);
      expect(await h.store.listAudit({ space: spaceId, event_type: APPROVAL_REQUESTED_EVENT })).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });
});

describe("canary journey windows (issue #215)", () => {
  test("the reply window gives live codex/luna tool-loop turns headroom, and the store window follows it", () => {
    // Live finding (run msykwxhj-155u): complex real-model turns (tool
    // loops through iron-proxy) legitimately exceed the old 120s window —
    // every journey that hit one timed out while the turn was still
    // streaming. The window is the journey's polling contract; the store
    // window is raised with it so store checks that follow a slow turn
    // keep headroom.
    expect(JOURNEY_TIMEOUT_MS).toBe(300_000);
    expect(STORE_TIMEOUT_MS).toBeGreaterThan(60_000); // raised with the reply window
  });
});

describe("memory journey scope pin (issue #224)", () => {
  test("the memory save prompt names the ORG scope explicitly — the text the journey posts to the model", () => {
    // Live finding (run msypizpb-qt3): the journey asked the model to
    // "store the canary code word in memory" then polled
    // h.memory.search(scope: "org"). The model (luna) saved with
    // scope: "user" (natural for a DM — proven in run msymugpa's
    // surviving transcript: memory_save executed with {scope: "user"}),
    // the org-scope search never found the fact, and the journey timed
    // out ("timed out after 90000ms waiting for the remembered fact").
    // The tool did NOT fail; the contract was ambiguous. The fix pins the
    // scope in the posted prompt. Red on the pre-fix code: the prompt was
    // "… — store it in memory" with no scope, so this assertion fails.
    const prompt = memorySavePromptFor("probe-run");
    expect(prompt).toContain("canary-probe-run");
    expect(prompt).toContain("ORG memory");
    expect(prompt).toContain("scope: org");
  });

  test("the ORG-scope search is the journey's deterministic round-trip proof, and the prompt's word must round-trip through it", async () => {
    // The journey's assertion is a REAL memory round-trip: the posted word
    // must survive a save → org-scope store search. The prompt builder is
    // the posted text; the search the journey runs is the org store. This
    // test drives both halves against the REAL SQLite memory provider: the
    // word from the prompt is saved to org scope and found by the exact
    // search the journey runs (memory.search, scope org, limit 5).
    const h = await bootHarness({ registry: createCanaryRegistry() });
    try {
      const prompt = memorySavePromptFor("round-trip-run");
      const word = /canary code word is (canary-[A-Za-z0-9-]+)/.exec(prompt)?.[1];
      expect(word).toBeDefined();
      await h.memory.save({ scope: { kind: "org" }, content: `the canary code word is ${word}`, metadata: {} });
      const found = await h.memory.search({ query: word!, scope: { kind: "org" }, limit: 5 });
      expect(found.some((e) => e.content.includes(word!))).toBe(true);
      // A person-scope save (the pre-fix model's user-scope choice) must NOT
      // satisfy the org-scope proof — that asymmetry is the bug #224 fixes.
      await h.memory.save({ scope: { kind: "person", principal: "U-owner" }, content: `user-only ${word}`, metadata: {} });
      const orgOnly = await h.memory.search({ query: word!, scope: { kind: "org" }, limit: 5 });
      expect(orgOnly.some((e) => e.content.includes("user-only"))).toBe(false);
    } finally {
      await h.cleanup();
    }
  });
});

describe("channel chat-reply thread polling (issue #212)", () => {
  test("waitForBotReply finds an IN-THREAD bot reply via conversations.replies when history only has top-level messages", async () => {
    // Live finding (run msyggnjh-123m): in channels the bot answered the
    // ping IN-THREAD (conversations.replies shows the reply 0.8s after the
    // ping's ts) but the journey timed out — conversations.history returns
    // ONLY top-level messages, so a threaded reply never appeared to the
    // poll. The stub client mirrors the live handle: history returns the
    // top-level QA ping (no bot rows), replies returns the threaded bot
    // reply — the journey must poll the thread (postAndWait(thread: true)
    // passes threadTs: inboundTs) to see it.
    const pingTs = "1787000000.000100";
    const botReply: SlackApiMessage = {
      ts: "1787000000.000900",
      channel: "C1",
      bot_id: "B-bot",
      text: "in-thread bot reply",
      thread_ts: pingTs,
    };
    // SAFETY: the stub only exposes the sync members waitForBotReply reads
    // (history/replies for the poll, botUserId/qaUserId for isBotMessage);
    // the rest of the Harness surface is unused in this mechanism test.
    const h = {
      liveSlack: {
        botUserId: "B-bot",
        qaUserId: "U-qa",
        history: async (_channelId: string) => [{ ts: pingTs, channel: "C1", user: "U-qa", text: "canary ping" }],
        replies: async (_channelId: string, _threadTs: string) => [botReply],
      },
    } as Harness;
    const reply = await waitForBotReply(h, "C1", {
      afterTs: pingTs,
      threadTs: pingTs,
      label: "channel ping",
      timeoutMs: 2_000,
    });
    expect(reply.text).toBe("in-thread bot reply");
  });

  test("postAndWait(thread: true) polls conversations.replies with the POSTED message's ts — the thread root the bot threads under (#215 live shape)", async () => {
    // Live finding (run msykwxhj-155u after #212): the QA ping posts
    // TOP-LEVEL — postAsUser sends no thread_ts — and the bot answers
    // IN-THREAD under the ping's own ts, which makes THAT ts the thread
    // root. The journey must pass the posted message's ts to
    // conversations.replies (the only API that returns in-thread
    // messages). The stub mirrors Slack's real rejection — invalid_
    // arguments for any ts that is not the root — so the journey only
    // resolves by polling the right ts. Asserting the polled ts is the
    // contract: the stub throws for a wrong ts.
    const pingTs = "1787000000.000100"; // top-level post; its own ts becomes the root
    const botReply: SlackApiMessage = {
      ts: "1787000000.000900",
      channel: "C1",
      bot_id: "B-bot",
      text: "in-thread bot reply",
      thread_ts: pingTs,
    };
    const polled: string[] = [];
    // SAFETY: the stub only exposes the live-Slack members postAndWait
    // reads (postAsUser/replies for the thread poll, botUserId/qaUserId
    // for isBotMessage); the rest of the Harness surface is unused here.
    const h = {
      liveSlack: {
        botUserId: "B-bot",
        qaUserId: "U-qa",
        postAsUser: async (_channelId: string, _text: string) => ({ ts: pingTs }), // real live shape: no thread_ts on a top-level post
        replies: async (_channelId: string, ts: string) => {
          polled.push(ts);
          if (ts !== pingTs) throw new Error("slack api conversations.replies: invalid_arguments");
          return [
            { ts: pingTs, channel: "C1", user: "U-qa", text: "canary ping" },
            botReply,
          ];
        },
      },
    } as Harness;
    const { inboundTs, reply } = await postAndWait(h, "C1", "canary ping", {
      label: "channel ping",
      thread: true,
    });
    expect(reply.text).toBe("in-thread bot reply");
    expect(inboundTs).toBe(pingTs);
    expect(polled.every((ts) => ts === pingTs)).toBe(true);
  });

  test("a conversations.replies invalid_arguments rejection (non-thread ts) falls back to conversations.history and still finds the reply (issue #215)", async () => {
    // Live finding (run msykwxhj-155u): the ping posts top-level and
    // Slack's real conversations.replies REJECTS its ts with
    // invalid_arguments while the inbound is not (yet) a thread root — a
    // steered ping (no phrase of its own) never becomes one. The journey
    // must not error into a timeout: it falls back to conversations.
    // history for that iteration, which sees a top-level-shaped reply.
    // The stub mirrors Slack's real rejection exactly: replies() throws
    // invalid_arguments for the non-thread ts. Red on the pre-fix code:
    // without the fallback the rejection is recorded and the poll times
    // out.
    const pingTs = "1787000000.000100";
    const topLevelReply: SlackApiMessage = {
      ts: "1787000000.000900",
      channel: "C1",
      bot_id: "B-bot",
      text: "top-level bot reply",
    };
    const calls: string[] = [];
    // SAFETY: the stub only exposes the live-Slack members waitForBotReply
    // reads (replies/history for the poll fallback, botUserId/qaUserId);
    // the rest of the Harness surface is unused in this mechanism test.
    const h = {
      liveSlack: {
        botUserId: "B-bot",
        qaUserId: "U-qa",
        postAsUser: async (_channelId: string, _text: string) => ({ ts: pingTs }),
        replies: async (_channelId: string, ts: string): Promise<SlackApiMessage[]> => {
          calls.push(`replies:${ts}`);
          throw new Error("slack api conversations.replies: invalid_arguments");
        },
        history: async (_channelId: string) => {
          calls.push("history");
          return [
            { ts: pingTs, channel: "C1", user: "U-qa", text: "canary ping" },
            topLevelReply,
          ];
        },
      },
    } as Harness;
    const reply = await waitForBotReply(h, "C1", {
      afterTs: pingTs,
      threadTs: pingTs,
      label: "channel ping",
      timeoutMs: 2_000,
    });
    expect(reply.text).toBe("top-level bot reply");
    expect(calls[0]).toBe(`replies:${pingTs}`); // conversations.replies is the first eye
    expect(calls).toContain("history"); // its rejection falls back to history
  });

  test("a live-progress line is never the reply — the poll keeps waiting for the real text (issue #224)", async () => {
    // Live finding (run msypizpb-qt3): the live model returned empty
    // completions for the ping turns. The DM turn's phrase was edited to
    // the elapsed progress line "Thinking… 0s" (the plain presenter's
    // progress tick) and the DM journey MATCHED it as the reply — a false
    // pass that hid the no-reply — while the channel turn (stream
    // presenter: no progress tick) honestly timed out. A progress line is
    // turn decoration; a real reply replaces the phrase in place. The stub
    // posts the progress line first; the poll must skip it and only
    // resolve on the real reply. Red on the pre-fix code: the poll matched
    // "Thinking… 0s" immediately and never saw the real reply.
    const pingTs = "1787000000.000100";
    const progressLine: SlackApiMessage = {
      ts: "1787000000.000300",
      channel: "C1",
      bot_id: "B-bot",
      text: "Thinking… 0s",
    };
    const realReply: SlackApiMessage = {
      ts: "1787000000.000900",
      channel: "C1",
      bot_id: "B-bot",
      text: "ok — the actual reply",
    };
    let polls = 0;
    // SAFETY: the stub only exposes the live-Slack members waitForBotReply
    // reads (history for the poll, botUserId/qaUserId for isBotMessage);
    // the rest of the Harness surface is unused in this mechanism test.
    const h = {
      liveSlack: {
        botUserId: "B-bot",
        qaUserId: "U-qa",
        history: async (_channelId: string) => {
          polls += 1;
          return [
            { ts: pingTs, channel: "C1", user: "U-qa", text: "canary ping" },
            // The progress line stays until the real reply replaces it.
            ...(polls > 1 ? [realReply] : [progressLine]),
          ];
        },
      },
    } as Harness;
    const reply = await waitForBotReply(h, "C1", {
      afterTs: pingTs,
      label: "progress false pass",
      timeoutMs: 5_000,
    });
    expect(reply.text).toBe("ok — the actual reply");
    expect(polls).toBeGreaterThan(1); // the progress line was skipped, not matched
  });
});

describe("extension-call journey mechanism (issue #175)", () => {
  test("the canary's fixture MCP provider answers the fixture tool", async () => {
    const client = new Client({ name: "canary-fixture-test", version: "0.0.0" });
    await client.connect(
      // SAFETY: the fixture transport ignores the binding entirely (in-process
      // linked pair); the placeholder only satisfies the transport seam's type.
      canaryFixtureMcpTransport({ serverUrl: "in-memory", transport: "streamable-http" } as McpBinding),
    );
    const res = await client.callTool({ name: FIXTURE_EXTENSION_TOOL, arguments: { city: "canary-test" } });
    // SAFETY: the canary fixture provider's callTool only ever returns text
    // content blocks; the first text block carries the sunny-in response.
    const text =
      (res.content as Array<{ type: string; text?: string }>).find((block) => block.type === "text")?.text ?? "";
    expect(text).toBe("sunny in canary-test");
    await client.close();
  });

  test("the journey's runtime spine executes the fixture tool through the harness (audit allow + reply)", async () => {
    // The live journey (issue #175) drives the fixture tool through the
    // REAL runtime: policy gate → credential ladder → boundary write → MCP
    // call → audit. The stub model scripts the tool call; everything else
    // is the canary's exact wiring (fixture registry, transport, boundary
    // with a temp secrets dir so the write stays out of the repo).
    // The driver flattens dotted names for the MODEL-facing toolset (issue
    // #78: weather.current → weather_current) while the canonical name
    // survives in the runtime + audit rows — the stub calls what the model
    // would see, and the assertions stay canonical.
    const modelToolName = opencodeSafeToolName(FIXTURE_EXTENSION_TOOL);
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: modelToolName, args: { city: "canary-test" } }] },
      { type: "text", text: "sunny in canary-test" },
    ];
    const secretsDir = mkdtempSync(join(tmpdir(), "bottega-canary-boundary-"));
    const h = await bootHarness({
      orgConfigYaml: ["tools:", `  ${FIXTURE_EXTENSION_TOOL}: allow`, ""].join("\n"),
      modelTurns: turns,
      registry: createFixtureRegistry(),
      mcpTransport: canaryFixtureMcpTransport,
      extensionBoundary: createSecretFileBoundary({
        resolveSecret: async () => "canary-fixture-secret",
        secretsDir,
      }),
    });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      await h.store.upsertExtensionCredential({
        provider: FIXTURE_EXTENSION_ID,
        identityKey: "canary-fixture",
        owner: null,
        scope: "org",
        brokerCredentialId: 0,
      });
      const before = (await h.store.listAudit({ space: spaceId, event_type: EXTENSION_CALL_EVENT })).length;
      await h.deliverMessage(dm, `call ${FIXTURE_EXTENSION_TOOL} for canary-test`);
      await h.modelStub.waitForRequests(2, 20_000);

      const rows = await h.store.listAudit({ space: spaceId, event_type: EXTENSION_CALL_EVENT });
      expect(rows.length).toBeGreaterThan(before);
      // SAFETY: the extension-call audit payload carries the tool name + the
      // gate decision (the runtime's own serialization, asserted below).
      const payload = JSON.parse(rows[rows.length - 1]!.payload) as { tool?: string; decision?: string };
      expect(payload.tool).toBe(FIXTURE_EXTENSION_TOOL);
      expect(payload.decision).toBe("allow");
      // The reply update lands a beat after the turn (in-place phrase
      // edit, chat-memory's pattern) — poll for it.
      const reply = await waitFor(() =>
        h.slack.store.messages.all().find((m) => m.text.includes("sunny in canary-test")),
      );
      expect(reply).toBeDefined();
    } finally {
      await h.cleanup();
    }
  });
});

describe("tool-execution observability (issue #224)", () => {
  test("a gated tool call logs its RESULT at INFO through the harness seam (the driver's withPolicyGate wrapper)", async () => {
    // The canary's tool-event seam (issue #224): under restrictToolNames
    // the SDK's extension tool events are inert, so every live tool call
    // crosses the driver's withPolicyGate wrapper — the harness path. The
    // pre-#224 run (msypizpb-qt3) could not attribute the "timed out
    // waiting for the store effect" failures: no tool results/errors were
    // logged and the temp transcripts were deleted at cleanup. The seam
    // must log toolName + outcome at INFO. Driving a real gated memory.save
    // call through the harness and capturing console output proves the
    // line fires exactly where a live run's stdout would show it.
    const modelToolName = opencodeSafeToolName("memory.save");
    const turns: StubTurn[] = [
      {
        type: "tool_calls",
        calls: [{ name: modelToolName, args: { content: "canary-observability-probe", scope: "org" } }],
      },
      { type: "text", text: "remembered" },
    ];
    const h = await bootHarness({
      orgConfigYaml: CANARY_ORG_CONFIG,
      modelTurns: turns,
      registry: createCanaryRegistry(),
    });
    try {
      const dm = h.slack.dmChannelId;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const lines: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      try {
        await h.deliverMessage(dm, "remember the probe word in org memory");
        await h.modelStub.waitForRequests(2, 20_000);
      } finally {
        spy.mockRestore();
      }
      expect(lines.some((l) => /\[tool\] memory\.save → ok/.test(l))).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});

describe("model-role-switch journey mechanism (issue #175)", () => {
  test("the journey's use_model fast round-trip switches the live session and audits", async () => {
    // The live journey (issue #175) asks for the fast model; the model
    // calls use_model, the OMP session's per-session hook applies the
    // switch (fast → low effort, the space has no model settings), and the
    // switch is audited. The stub model scripts the tool call; the harness
    // wires the model-role registry + getModelSettings exactly like the
    // server (issue #64).
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "use_model", args: { role: "fast" } }] },
      { type: "text", text: "fast model engaged" },
    ];
    const h = await bootHarness({ modelTurns: turns, registry: createFixtureRegistry() });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const before = (await h.store.listAudit({ space: spaceId, event_type: MODEL_SWITCHED_EVENT })).length;
      await h.deliverMessage(dm, "use the fast model for this");
      await h.modelStub.waitForRequests(2, 20_000);

      const rows = await h.store.listAudit({ space: spaceId, event_type: MODEL_SWITCHED_EVENT });
      expect(rows.length).toBeGreaterThan(before);
      // SAFETY: the model-switched audit payload carries the resolved role
      // (the runtime's own serialization, asserted below).
      const payload = JSON.parse(rows[rows.length - 1]!.payload) as { role?: string };
      expect(payload.role).toBe("fast");
    } finally {
      await h.cleanup();
    }
  });
});

describe("delivery-approval journey mechanism (issue #149)", () => {
  test("the poller announces the prompt and the router resolves approve → review → done (the journey's wiring)", async () => {
    // Fixture registry only: the default config/extensions registry probes
    // real provider surfaces at boot (network), which is slow and
    // environment-dependent — the canary's own registry is the exact
    // wiring runLiveLeg uses.
    const h = await bootHarness({ registry: createCanaryRegistry() });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const item = await h.store.createWorkItem({
        space_id: spaceId,
        requester: "U-owner",
        description: "canary delivery fixture",
        delivery: "git",
        repo: "serrrfirat/bottega",
      });
      await h.audit.appendAudit({
        space_id: spaceId,
        actor: "executor",
        event_type: DELIVERY_PENDING_EVENT,
        payload: JSON.stringify({ id: item.id, pr_url: "https://github.com/serrrfirat/bottega/pull/1", summary: "s" }),
      });

      const posted = await pollPendingDeliveries(h.store, h.adapter);
      expect(posted).toBe(1);
      const prompt = h.slack.store.messages.all().find((m) => m.text.includes("PR ready:"));
      expect(prompt).toBeDefined();
      const requested = await h.store.listAudit({ space: spaceId, event_type: DELIVERY_REQUESTED_EVENT });
      expect(JSON.parse(requested[requested.length - 1]!.payload)).toMatchObject({ id: item.id });

      // Idempotent: a second poll never double-announces.
      expect(await pollPendingDeliveries(h.store, h.adapter)).toBe(0);

      const resolved = await resolveDeliveryAction(
        { store: h.store, adapter: h.adapter },
        {
          actionId: DELIVERY_APPROVE_ACTION_ID,
          value: item.id,
          spaceId,
          principal: "U-owner",
          messageTs: prompt!.ts,
        },
      );
      expect(resolved).toBe(true);
      const decisions = await h.store.listAudit({ space: spaceId, event_type: DELIVERY_RESOLVED_EVENT });
      expect(JSON.parse(decisions[decisions.length - 1]!.payload)).toMatchObject({
        id: item.id,
        approved: true,
        approver: "U-owner",
      });
      // The prompt rewrite is best-effort by design (the audit row is the
      // decision) — poll briefly; a flaky chat.update never fails the gate.
      const rewritten = await waitFor(
        () => h.slack.store.messages.all().find((m) => m.ts === prompt!.ts && m.text.includes("Delivery approved")),
        2_000,
      );
      expect(rewritten).toBeDefined();

      // The executor's post-wait path: working → review (with the approval)
      // → done (with the delivery result).
      await h.store.transitionWorkItem(item.id, "open", "claimed", { by: "executor" });
      await h.store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
      await h.store.transitionWorkItem(item.id, "working", "review", { approval: { approver: "U-owner" }, by: "executor" });
      const done = await h.store.transitionWorkItem(item.id, "review", "done", {
        result: JSON.stringify({ pr_url: "https://github.com/serrrfirat/bottega/pull/1", summary: "s" }),
        by: "executor",
      });
      expect(done.state).toBe("done");
    } finally {
      await h.cleanup();
    }
  });
});

describe("org-settings approval journey mechanism (issue #151)", () => {
  test("SlackApprovalRouter posts the prompt with buttons and handleAction resolves the click (the journey's seam)", async () => {
    const posted: Array<{ spaceId: string; text?: string; blocks?: unknown[] }> = [];
    const updated: Array<{ spaceId: string; ts: string; text?: string }> = [];
    const router = new SlackApprovalRouter({
      adapter: {
        postMessage: async (spaceId, text, opts) => {
          posted.push({ spaceId, text, blocks: opts?.blocks });
          return "1.000001";
        },
        updateMessage: async (spaceId, ts, text) => {
          updated.push({ spaceId, ts, text });
        },
      },
      timeoutMs: 60_000,
    });
    const pending = router.request({
      tool: "model_settings",
      args: { set: { reasoning_effort: "low" } },
      reason: "write-tier",
      spaceId: "slack:C1",
      actor: "U-owner",
    });
    expect(posted.length).toBe(1);
    // Issue #277: the prompt carries the HUMANIZED payload (labeled rows,
    // not flat JSON) — the posted text is the plain-text form of the blocks.
    expect(posted[0]!.text).toBe('Approval required for model_settings — • *Set:* {"reasoning_effort":"low"}');
    const value = approvalButtonValue({
      ts: "1.000001",
      text: "",
      blocks: posted[0]!.blocks,
    });
    expect(value).toBeDefined();
    await router.handleAction({
      actionId: APPROVE_ACTION_ID,
      value: value!,
      spaceId: "slack:C1",
      principal: "U-owner",
      messageTs: "1.000001",
    });
    const resolution = await pending;
    expect(resolution).toEqual({ approved: true, approver: "U-owner" });
    expect(updated.length).toBe(1);
    expect(updated[0]!.text).toContain("Approved by <@U-owner>");
  });

  test("the settled outcome text satisfies the journey's APPROVAL_OUTCOME_PREFIX rewrite predicate (issue #242)", async () => {
    const posted: Array<{ spaceId: string; text?: string; blocks?: unknown[] }> = [];
    const updated: Array<{ spaceId: string; ts: string; text?: string }> = [];
    const router = new SlackApprovalRouter({
      adapter: {
        postMessage: async (spaceId, text, opts) => {
          posted.push({ spaceId, text, blocks: opts?.blocks });
          return "1.000003";
        },
        updateMessage: async (spaceId, ts, text) => {
          updated.push({ spaceId, ts, text });
        },
      },
      timeoutMs: 60_000,
    });
    const pending = router.request({
      tool: "model_settings",
      args: { set: { reasoning_effort: "low" } },
      reason: "write-tier",
      spaceId: "slack:C1",
      actor: "U-owner",
    });
    const value = approvalButtonValue({
      ts: "1.000003",
      text: "",
      blocks: posted[0]!.blocks,
    });
    expect(value).toBeDefined();
    await router.handleAction({
      actionId: APPROVE_ACTION_ID,
      value: value!,
      spaceId: "slack:C1",
      principal: "U-owner",
      messageTs: "1.000003",
    });
    await expect(pending).resolves.toEqual({ approved: true, approver: "U-owner" });
    // Issue #242: the rewritten message must satisfy the journey's own rewrite
    // predicate (canary.ts:1382 waits on startsWith(APPROVAL_OUTCOME_PREFIX));
    // the prefix is the router's mrkdwn form, exported as the single source of
    // truth instead of a divergent copy in the canary.
    expect(updated[0]!.text!.startsWith(APPROVAL_OUTCOME_PREFIX)).toBe(true);
  });

  test("the policy gate round trip audits approval.requested → approval.resolved", async () => {
    const h = await bootHarness({ orgConfigYaml: CANARY_ORG_CONFIG, registry: createCanaryRegistry() });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const posted: Array<{ spaceId: string; text?: string; blocks?: unknown[] }> = [];
      const router = new SlackApprovalRouter({
        adapter: {
          postMessage: async (spaceId, text, opts) => {
            posted.push({ spaceId, text, blocks: opts?.blocks });
            return "1.000002";
          },
          updateMessage: async () => {},
        },
        timeoutMs: 60_000,
      });
      const gate = evaluatePolicyGate(
        { loadPolicy: (sid) => loadSpacePolicy(h.orgPolicy, h.store, sid), audit: h.audit, router, timeoutMs: 60_000 },
        { tool: "model_settings", args: { set: { reasoning_effort: "low" } }, spaceId, actor: "U-owner" },
      );
      // The gate writes its audit rows BEFORE the router posts the prompt —
      // wait for the post to land, then read the button value.
      const postedPrompt = await waitFor(() => posted[0]);
      expect(postedPrompt).toBeDefined();
      const value = approvalButtonValue({
        ts: "1.000002",
        text: "",
        blocks: postedPrompt!.blocks,
      });
      expect(value).toBeDefined();
      await router.handleAction({
        actionId: APPROVE_ACTION_ID,
        value: value!,
        spaceId,
        principal: "U-owner",
        messageTs: "1.000002",
      });
      await expect(gate).resolves.toMatchObject({ allowed: true });
      const resolved = await h.store.listAudit({ space: spaceId, event_type: APPROVAL_RESOLVED_EVENT });
      expect(JSON.parse(resolved[resolved.length - 1]!.payload)).toMatchObject({
        tool: "model_settings",
        approved: true,
        approver: "U-owner",
      });
      const requested = await h.store.listAudit({ space: spaceId, event_type: APPROVAL_REQUESTED_EVENT });
      expect(requested.length).toBeGreaterThan(0);
    } finally {
      await h.cleanup();
    }
  });
});

describe("model hot-swap + catalog surface mechanisms (issues #189/#192)", () => {
  test("the settings tool set persists the default + audits before/after; the get surfaces available_models", async () => {
    const h = await bootHarness({ orgConfigYaml: CANARY_ORG_CONFIG, registry: createCanaryRegistry() });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const settings = modelToolsDefinitions(h.store, { audit: h.audit, agentDir: h.agentDir }).find(
        (t) => t.name === "model_settings",
      )!;
      const get = await settings.execute("tc1", {}, undefined, undefined, toolCtxFor(h, spaceId));
      expect(get.isError).not.toBe(true);
      // SAFETY: model_settings serializes its result as JSON with a single
      // text block carrying available_models (asserted below).
      const body = JSON.parse((get.content[0] as { text: string }).text) as {
        available_models?: Array<{ provider: string; models: unknown[] }>;
      };
      expect(body.available_models?.length).toBeGreaterThan(0);

      const set = await settings.execute(
        "tc2",
        { set: { model: "stub-v1", reasoning_effort: "high" } },
        undefined,
        undefined,
        toolCtxFor(h, spaceId),
      );
      expect(set.isError).not.toBe(true);
      expect(await h.store.getSpaceSettings(spaceId)).toMatchObject({ model: "stub-v1", reasoning_effort: "high" });
      const changed = await h.store.listAudit({ space: spaceId, event_type: MODEL_SETTINGS_CHANGED_EVENT });
      // SAFETY: the settings-changed audit payload carries the new settings
      // object under `after` (the runtime's own JSON serialization).
      const payload = JSON.parse(changed[changed.length - 1]!.payload) as { after?: Record<string, JsonValue> };
      expect(payload.after).toMatchObject({ model: "stub-v1", reasoning_effort: "high" });
    } finally {
      await h.cleanup();
    }
  });

  test("defaultModelIdFor keeps a provider-qualified model ref qualified (issue #243)", () => {
    // The org default (issue #214) pins the codex model through its provider;
    // stripping the qualifier made the turn-start re-apply resolve the bare
    // id ambiguous and the session silently kept its current model.
    expect(defaultModelIdFor("openai-codex/gpt-5.6-luna")).toBe("openai-codex/gpt-5.6-luna");
    // The near/opencode special forms still normalize to their resolve-forms
    // (near-preference picks the single working provider at re-apply).
    expect(defaultModelIdFor("near/deepseek-ai/DeepSeek-V4-Flash")).toBe("deepseek-ai/DeepSeek-V4-Flash");
    expect(defaultModelIdFor("opencode-go/deepseek-v4-flash")).toBe("deepseek-v4-flash");
    // The provider the journey forces a resolution to: the ref's provider,
    // except for the near/opencode forms the resolver normalizes itself.
    expect(defaultModelProviderFor("openai-codex/gpt-5.6-luna")).toBe("openai-codex");
    expect(defaultModelProviderFor("near/deepseek-ai/DeepSeek-V4-Flash")).toBeUndefined();
    expect(defaultModelProviderFor("opencode-go/deepseek-v4-flash")).toBeUndefined();
  });

  test("the qualified hot-swap default re-applies to its pinned provider over the live-shape catalog (issue #243)", () => {
    // The live deployment catalog (config/omp/models.yml + SDK built-ins +
    // gateway probe merges): FOUR providers carry gpt-5.6-luna — openai,
    // openai-codex and opencode-go as bare ids, and near serving the slashed
    // codex id (issue #238's resolution shape). A bare "gpt-5.6-luna"
    // re-apply ties across them and either loses to near's #194 preference or
    // errors ambiguous — never pins openai-codex.
    const liveCatalog: ModelCatalogEntry[] = [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna (Codex)", provider: "openai-codex" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "opencode-go" },
      { id: "openai-codex/gpt-5.6-luna", name: "GPT-5.6 Luna (near)", provider: "near" },
    ];
    const ref = "openai-codex/gpt-5.6-luna";
    const target = defaultModelIdFor(ref);
    const resolution = resolveModelPin(target, liveCatalog);
    if (!resolution.ok || resolution.pin.kind !== "id") {
      throw new Error(`stored default '${target}' would not re-apply — ${resolution.ok ? "role ref" : resolution.error}`);
    }
    // The swap is APPLIED only when the stored default pins the operator's
    // provider: pre-fix the stripped bare id resolved via near's preference,
    // so the next turn ran a different provider while persistence passed.
    expect(resolution.pin.provider).toBe("openai-codex");
    // Same tripwire over the ambiguity shape (no near winner): a bare id
    // fails closed as ambiguous; the qualified id pins openai-codex.
    const noNearWinner = liveCatalog.filter((m) => m.provider !== "near");
    const bare = resolveModelPin("gpt-5.6-luna", noNearWinner);
    expect(bare.ok).toBe(false);
    const qualified = resolveModelPin(target, noNearWinner);
    if (!qualified.ok || qualified.pin.kind !== "id") {
      throw new Error(`stored default '${target}' ambiguous without near — ${qualified.ok ? "role ref" : qualified.error}`);
    }
    expect(qualified.pin.provider).toBe("openai-codex");
  });
});

describe("semantic auto-pickup mechanism (issue #89)", () => {
  test("the canary org config enables auto_pickup and the directive + classifier gate drafts on confidence", () => {
    expect(CANARY_ORG_CONFIG).toContain("auto_pickup: true");
    expect(classifyPickupIntent("implement the checkout flow", { enabled: true, threshold: "high" })).toBe("draft");
    expect(classifyPickupIntent("could you implement the checkout flow?", { enabled: true, threshold: "high" })).toBe(
      "ask",
    );
    expect(classifyPickupIntent("implement the checkout flow", { enabled: false })).toBe("none");
    const directive = buildAutoPickupDirective();
    expect(directive).toContain("CONFIRMABLE DRAFT");
    expect(directive).toContain("create_work_item");
  });
});

describe("extension-pin journey mechanism (issue #195)", () => {
  test("catalog_browser pin refuses without the human confirmation and pins + hot-registers with it", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bottega-canary-pin-test-"));
    const draftsDir = join(tempRoot, "drafts");
    const snapshotsDir = join(tempRoot, "snapshots");
    const egressPath = join(tempRoot, "egress.yml");
    const devEgressPath = join(tempRoot, "egress.dev.yml");
    const spec = "fixture.pin";
    const h = await bootHarness({ registry: createCanaryRegistry() });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const draft: SnapshotDraft = {
        schema: SNAPSHOT_SCHEMA,
        extensionId: spec,
        pinnedAt: new Date().toISOString(),
        source: { catalog: "canary://fixture", specId: spec, vendorOfficial: true, reviewed: false },
        manifest: {
          id: spec,
          label: "Fixture Pin MCP",
          vendor: "bottega-fixtures",
          kind: "mcp",
          domains: ["fixture-pin.example.com"],
          credentialTargets: [{ host: "fixture-pin.example.com", pathPrefix: "/mcp" }],
          mcp: { serverUrl: FIXTURE_PIN_MCP_URL, transport: "streamable-http" },
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
        // Issue #291: the fixture endpoint is a placeholder domain — the
        // #286 validation probe must see the injected SDK-valid verdict,
        // not a real network attempt (which fails and refuses the pin).
        catalog: { fetchImpl: canaryFixturePinFetch() },
      }).find((t) => t.name === "catalog_browser")!;
      const params = {
        action: "pin",
        spec,
        binding: { serverUrl: FIXTURE_PIN_MCP_URL, transport: "streamable-http" },
        credential_schema: { type: "api_key", domains: ["fixture-pin.example.com"] },
        vendor_official: true,
      } as const;

      const refused = await catalogBrowser.execute("tc1", params, undefined, undefined, toolCtxFor(h, spaceId));
      expect(refused.isError).toBe(true);
      // SAFETY: the pin tool replies with a single text content block whose
      // text carries the review-gate confirmation demand (asserted below).
      expect((refused.content[0] as { text: string }).text).toContain("confirm");
      expect(h.extensionRegistry.resolve(spec)).toBeUndefined();

      const pinned = await catalogBrowser.execute("tc2", { ...params, confirm: true }, undefined, undefined, toolCtxFor(h, spaceId));
      expect(pinned.isError).not.toBe(true);
      // SAFETY: the pin tool replies with a single text block whose JSON
      // carries reviewed/live_registry (the tool's own serialization).
      const body = JSON.parse((pinned.content[0] as { text: string }).text) as {
        reviewed?: unknown;
        live_registry?: unknown;
      };
      expect(body.reviewed).toBe(true);
      expect(body.live_registry).toBe("registered");
      expect(h.extensionRegistry.resolve(spec)).toBeDefined();
      const audit = await h.store.listAudit({ event_type: ADMIN_CATALOG_BROWSER_EVENT });
      const pinRow = audit.find((r) => {
        // SAFETY: the admin audit payload carries the action + spec fields
        // (the tool's own serialization); the filter reads only those.
        const p = JSON.parse(r.payload) as { action?: unknown; spec?: unknown };
        return p.action === "pin" && p.spec === spec;
      });
      expect(pinRow).toBeDefined();
    } finally {
      await h.cleanup();
    }
  });

  test("the journey's OAuth fixture.pin regenerates the egress configs — allowlisted domains, NO oauth_token transform (#284)", async () => {
    // The #195 journey pins fixture.pin with an oauth credentialSchema
    // (the preferred hosted-OAuth shape). Pre-#284 the pin's egress
    // regeneration demanded a verified token endpoint
    //   egress config generation: the OAuth extension "fixture.pin" has no
    //   verified token endpoint — add one to OAUTH_TOKEN_ENDPOINTS
    // Issue #284 removes the mint machinery entirely: the record carries
    // no endpoint, the SDK owns OAuth, and the regenerated config simply
    // allowlists the fixture's domains with no oauth_token transform. The
    // draft/params below are the journey's EXACT shape (canary.ts
    // journeyExtensionPin) driven through the real catalog_browser tool;
    // the deployed config/egress.yml is untouched (temp dirs).
    const tempRoot = mkdtempSync(join(tmpdir(), "bottega-canary-pin-oauth-"));
    const draftsDir = join(tempRoot, "drafts");
    const snapshotsDir = join(tempRoot, "snapshots");
    const egressPath = join(tempRoot, "egress.yml");
    const devEgressPath = join(tempRoot, "egress.dev.yml");
    const spec = "fixture.pin";
    const h = await bootHarness({ registry: createCanaryRegistry() });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const draft: SnapshotDraft = {
        schema: SNAPSHOT_SCHEMA,
        extensionId: spec,
        pinnedAt: new Date().toISOString(),
        source: { catalog: "canary://fixture", specId: spec, vendorOfficial: true, reviewed: false },
        manifest: {
          id: spec,
          label: "Fixture Pin MCP",
          vendor: "bottega-fixtures",
          kind: "mcp",
          domains: ["fixture-pin.example.com"],
          credentialTargets: [{ host: "fixture-pin.example.com", pathPrefix: "/mcp" }],
          mcp: { serverUrl: FIXTURE_PIN_MCP_URL, transport: "streamable-http" },
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
        // Issue #291: the fixture endpoint is a placeholder domain — the
        // #286 validation probe must see the injected SDK-valid verdict,
        // not a real network attempt (which fails and refuses the pin).
        catalog: { fetchImpl: canaryFixturePinFetch() },
      }).find((t) => t.name === "catalog_browser")!;
      // The journey's pin params: OAuth credential schema (issue #195 —
      // hosted OAuth is the preferred binding; the api_key variant the
      // older hermetic test pins does NOT exercise the oauth_token
      // regeneration path this journey runs).
      const params = {
        action: "pin",
        spec,
        binding: { serverUrl: FIXTURE_PIN_MCP_URL, transport: "streamable-http" },
        credential_schema: { type: "oauth", scopes: ["read"] },
        vendor_official: true,
      } as const;

      const refused = await catalogBrowser.execute("tc1", params, undefined, undefined, toolCtxFor(h, spaceId));
      expect(refused.isError).toBe(true);
      const pinned = await catalogBrowser.execute(
        "tc2",
        { ...params, confirm: true },
        undefined,
        undefined,
        toolCtxFor(h, spaceId),
      );
      expect(pinned.isError).not.toBe(true);
      // SAFETY: the pin tool replies with a single text block whose JSON
      // carries reviewed/live_registry/egress_regenerated (its own serialization).
      const body = JSON.parse((pinned.content[0] as { text: string }).text) as {
        reviewed?: unknown;
        live_registry?: unknown;
        egress_regenerated?: unknown[];
      };
      expect(body.reviewed).toBe(true);
      expect(body.live_registry).toBe("registered");
      expect(body.egress_regenerated).toEqual([egressPath, devEgressPath]);
      // Issue #284: the OAuth fixture's domains allowlist (as allowlist
      // entries), but NO oauth_token transform is emitted (the SDK owns
      // OAuth — the proxy is transport/allowlist only and never mints).
      const egress = readFileSync(egressPath, "utf8");
      expect(egress).not.toContain("- name: oauth_token");
      expect(egress).not.toContain('token_endpoint: "https://fixture-pin.example.com/token"');
      expect(egress).toContain('- "fixture-pin.example.com"');
      expect(readFileSync(devEgressPath, "utf8")).not.toContain("- name: oauth_token");
    } finally {
      await h.cleanup();
    }
  });

  test("a rejected probe verdict refuses the pin — zero snapshot/egress/hot-register mutation (issue #291)", async () => {
    // The #286 validation probe runs BEFORE the review gate: even with the
    // human's confirm=true the pin must refuse when the injected endpoint
    // fails validation (HTTP 404 here) — no snapshot, no egress regen, no
    // hot-register, and an auditable pin_refused row. This pins the
    // hermetic seam's invalid leg through the real catalog_browser tool
    // (the admin-tool probe refusal is also covered in admin.test.ts).
    const tempRoot = mkdtempSync(join(tmpdir(), "bottega-canary-pin-refused-"));
    const draftsDir = join(tempRoot, "drafts");
    const snapshotsDir = join(tempRoot, "snapshots");
    const egressPath = join(tempRoot, "egress.yml");
    const devEgressPath = join(tempRoot, "egress.dev.yml");
    const spec = "fixture.pin";
    const h = await bootHarness({ registry: createCanaryRegistry() });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const draft: SnapshotDraft = {
        schema: SNAPSHOT_SCHEMA,
        extensionId: spec,
        pinnedAt: new Date().toISOString(),
        source: { catalog: "canary://fixture", specId: spec, vendorOfficial: true, reviewed: false },
        manifest: {
          id: spec,
          label: "Fixture Pin MCP",
          vendor: "bottega-fixtures",
          kind: "mcp",
          domains: ["fixture-pin.example.com"],
          credentialTargets: [{ host: "fixture-pin.example.com", pathPrefix: "/mcp" }],
          mcp: { serverUrl: FIXTURE_PIN_MCP_URL, transport: "streamable-http" },
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
        // The invalid leg: the fixture endpoint answers HTTP 404 — the
        // real validator rejects the probe before the review gate.
        catalog: { fetchImpl: canaryFixturePinFetch("invalid") },
      }).find((t) => t.name === "catalog_browser")!;

      // confirm=true is passed on purpose: the probe gate runs BEFORE the
      // review gate, so even the human's confirmation cannot pin a
      // rejected endpoint.
      const refused = await catalogBrowser.execute(
        "tc-refused",
        {
          action: "pin",
          spec,
          binding: { serverUrl: FIXTURE_PIN_MCP_URL, transport: "streamable-http" },
          credential_schema: { type: "oauth", scopes: ["read"] },
          vendor_official: true,
          confirm: true,
        },
        undefined,
        undefined,
        toolCtxFor(h, spaceId),
      );
      expect(refused.isError).toBe(true);
      // The pin tool replies with a single text block whose text carries
      // the refusal + probe evidence (the tool's own serialization); the
      // guard narrows the SDK content union to the text member.
      const refusedBlock = refused.content[0];
      const text = refusedBlock !== undefined && refusedBlock.type === "text" ? refusedBlock.text : "";
      expect(text).toContain("failed the MCP validation probe");
      expect(text).toContain("HTTP 404");
      expect(text).toContain("no snapshot was written and egress is unchanged");
      // Fail closed: nothing persisted, no egress regen, no hot-register.
      expect(existsSync(join(snapshotsDir, "fixture.pin.json"))).toBe(false);
      expect(existsSync(egressPath)).toBe(false);
      expect(existsSync(devEgressPath)).toBe(false);
      expect(h.extensionRegistry.resolve(spec)).toBeUndefined();
      // The refusal is auditable (action=pin_refused with the evidence).
      const audit = await h.store.listAudit({ event_type: ADMIN_CATALOG_BROWSER_EVENT });
      const refusedRow = audit.find((r) => {
        // SAFETY: the admin audit payload carries the action + reason
        // fields (the tool's own serialization); the filter reads only those.
        const p = JSON.parse(r.payload) as { action?: unknown; reason?: unknown };
        return p.action === "pin_refused" && p.reason === "mcp_validation_probe_failed";
      });
      expect(refusedRow).toBeDefined();
    } finally {
      await h.cleanup();
    }
  });
});

describe("MCP OAuth + upload-link journey mechanisms (issues #198/#196)", () => {
  test("the OAuth mint persists a single-use flow row and the state replay is denied", async () => {
    const h = await bootHarness({ registry: createCanaryRegistry() });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const connector = canaryMcpOAuthConnector(() => h.store);
      const start = await connector.start({
        extension: CANARY_OAUTH_EXTENSION_ID,
        provider: CANARY_OAUTH_EXTENSION_ID,
        label: "Fixture OAuth MCP",
        scope: "personal",
        actor: "U-owner",
        spaceId,
      });
      expect(start.ok).toBe(true);
      const state = /[?&]state=([^&\s]+)/.exec(start.ok ? start.authorizationUrl : "")?.[1];
      expect(state).toBeDefined();
      expect(h.store.getOAuthFlow(state!)).not.toBeNull();
      expect(h.store.consumeOAuthFlow(state!).ok).toBe(true);
      expect(h.store.consumeOAuthFlow(state!).ok).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  test("the journey's state extraction round-trips the minted flow token from the Slack-rendered authorize URL (#212)", async () => {
    // Live finding (run msyggnjh-123m): the mcp-oauth journey failed on the
    // state check. Slack renders URLs in POSTED message text as <url>, and
    // the journey reads the URL back from history — the extraction must
    // stop the URL and the state at the `>` (and at whitespace/&) or the
    // captured state carries a trailing `>` and the callback's flow consume
    // (the single-use gate) never matches the minted row. The connector
    // mints the state (the flow token) into the authorize URL; this test
    // drives the journey's extraction over the exact Slack-rendered reply
    // shape and asserts the parsed state consumes the minted flow exactly
    // once (the callback path the journey uses).
    const h = await bootHarness({ registry: createCanaryRegistry() });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const connector = canaryMcpOAuthConnector(() => h.store);
      const start = await connector.start({
        extension: CANARY_OAUTH_EXTENSION_ID,
        provider: CANARY_OAUTH_EXTENSION_ID,
        label: "Fixture OAuth MCP",
        scope: "personal",
        actor: "U-owner",
        spaceId,
      });
      expect(start.ok).toBe(true);
      const authorizationUrl = start.ok ? start.authorizationUrl : "";
      // Slack's message text stores every URL as <url> — the reply the
      // journey's history poll reads back.
      const slackReply =
        `Open this link to authorize Fixture OAuth MCP: <${authorizationUrl}> — ` +
        "after you authorize in the browser, Fixture OAuth MCP is connected.";
      const state = oauthAuthorizeStateFrom(slackReply);
      expect(state).toBeDefined();
      const flowStore = new OAuthFlowStore(h.store);
      expect(flowStore.consume(state!).ok).toBe(true);
      expect(flowStore.consume(state!).ok).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  test("the state extraction decodes Slack's &amp; entity — the EXACT live reply from run msyi15gi-iwa (#212 follow-up)", () => {
    // Live finding (run msyi15gi-iwa): the mcp-oauth journey failed with
    // "authorization URL carries no state". The posted reply's URL carries
    // Slack's entity rendering — `&amp;state=` — so the #212 extraction
    // (a raw `[?&]state=` regex over the URL) never matches and the
    // journey reports no state. The manual live reply is reproduced
    // VERBATIM below (state UGthrC1Ewux1UrUg9lAZlkYD is the actual minted
    // flow token from that run). The fix decodes the entity before query
    // parsing; the full URL must also extract (the journey's detail line
    // shows it) with the entity decoded to the real separator.
    const liveReply =
      "Open this link to authorize Fixture OAuth MCP: " +
      "<https://oauth.fixture.test/authorize?client_id=canary-fixture&amp;state=UGthrC1Ewux1UrUg9lAZlkYD> " +
      "— after you authorize in the browser, Fixture OAuth MCP is connected.";
    expect(oauthAuthorizeStateFrom(liveReply)).toBe("UGthrC1Ewux1UrUg9lAZlkYD");
    expect(oauthAuthorizeUrlFrom(liveReply)).toBe(
      "https://oauth.fixture.test/authorize?client_id=canary-fixture&state=UGthrC1Ewux1UrUg9lAZlkYD",
    );
  });

  test("mint → form → POST stores the secret through the same connect path; the link is single-use", async () => {
    const h = await bootHarness({ registry: createCanaryRegistry() });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const uploadLink = startUploadLinkServer({
        store: h.store,
        registry: h.extensionRegistry,
        audit: h.audit,
        broker: canaryBroker,
        gate: {
          loadPolicy: (sid) => loadSpacePolicy(h.orgPolicy, h.store, sid),
          router: AutoApproveRouter,
        },
      });
      try {
        const minted = await mintUploadLink(
          { extension: FIXTURE_EXTENSION_ID, scope: "personal", actor: "U-owner", spaceId },
          {
            registry: h.extensionRegistry,
            store: uploadLink.store,
            baseUrl: () => uploadLink.baseUrl,
            // Issue #211: hermetic — the canary mints the loopback URL, never
            // a live probe of the ambient public base (the suite must not
            // touch the network).
            resolvePublicBase: async () => ({ base: undefined, warning: undefined }),
          },
        );
        expect(minted.ok).toBe(true);
        const url = minted.ok ? minted.url : "";
        const form = await fetch(url);
        expect(form.status).toBe(200);
        expect(await form.text()).toContain('name="secret"');

        const body = new FormData();
        body.append("secret", "canary-upload-secret");
        const upload = await fetch(url, { method: "POST", body });
        expect(upload.status).toBe(200);
        expect(await upload.text()).toContain("Saved to the vault");

        const credentials = await h.store.listExtensionCredentials(FIXTURE_EXTENSION_ID);
        expect(credentials.some((c) => c.scope === "personal" && c.owner === "U-owner")).toBe(true);
        const connected = await h.store.listAudit({ space: spaceId, event_type: EXTENSION_CONNECTED_EVENT });
        expect(connected.length).toBeGreaterThan(0);
        expect(await fetch(url).then((r) => r.status)).toBe(404);
      } finally {
        uploadLink.stop();
      }
    } finally {
      await h.cleanup();
    }
  });

  test("the journey's upload-URL extraction stops at the relay copy and Slack's angle brackets (#212)", () => {
    // Live finding (run msyggnjh-123m): the mint reply text was
    //   <http://127.0.0.1:64204/upload/<token>\nRelay this upload link
    //   exactly as written — never construct, reformat, or substitute the
    //   URL.
    // Slack wraps the URL in <>, and the mint tool appends the relay-copy
    // line (uploadLinkRelayText) — the journey captured the WHOLE thing as
    // "malformed upload URL". The extraction must return only the link.
    const token = "A1b2C3d4E5f6G7h8I9j0K1l2";
    const expected = `http://127.0.0.1:64204/upload/${token}`;
    const liveReply =
      `<${expected}\n` + "Relay this upload link exactly as written — never construct, reformat, or substitute the URL.";
    expect(uploadLinkUrlFrom(liveReply)).toBe(expected);
    // The unwrapped tool-result shape (what the journey reads directly from
    // the mint tool) extracts the same link.
    const toolResult = `${expected}\nRelay this upload link exactly as written — never construct, reformat, or substitute the URL.`;
    expect(uploadLinkUrlFrom(toolResult)).toBe(expected);
    // A genuinely malformed reply (no loopback link) still fails closed.
    expect(uploadLinkUrlFrom("no link here")).toBeUndefined();
  });

  test("the extraction stops at the first newline after a BARE public-base URL — the EXACT live reply from run msypizpb-qt3 (#224)", () => {
    // Live finding (run msypizpb-qt3): with a public base configured
    // (BOTTEGA_OAUTH_CALLBACK_BASE_URL — the deployment's cloudflared
    // tunnel), the mint returns a REAL https URL, and the journey failed
    // with "mint returned a malformed upload URL: <the URL + the relay
    // copy>". The #212 fix covered only the <url>-wrapped LOOPBACK shape;
    // the live shape is a BARE url + newline + relay copy. The reply below
    // is the run's failure text reproduced VERBATIM. The extraction must
    // return ONLY the URL. Red on the pre-fix code: the loopback-only
    // regex matched nothing, so this assertion fails (undefined).
    const liveReply =
      "https://across-sbjct-insulin-lessons.trycloudflare.com/upload/9n-QApeWOmi3gvuw62E94qk9\n" +
      "Relay this upload link exactly as written — never construct, reformat, or substitute the URL.";
    expect(uploadLinkUrlFrom(liveReply)).toBe(
      "https://across-sbjct-insulin-lessons.trycloudflare.com/upload/9n-QApeWOmi3gvuw62E94qk9",
    );
    // The wrapped-Slack shape with a PUBLIC base extracts the same way
    // (the #212 angle-bracket stop still holds for https hosts).
    expect(
      uploadLinkUrlFrom(
        "<https://across-sbjct-insulin-lessons.trycloudflare.com/upload/9n-QApeWOmi3gvuw62E94qk9>\n" +
          "Relay this upload link exactly as written — never construct, reformat, or substitute the URL.",
      ),
    ).toBe("https://across-sbjct-insulin-lessons.trycloudflare.com/upload/9n-QApeWOmi3gvuw62E94qk9");
  });
});

describe("live-progress line shapes (issue #193)", () => {
  test("the journey's regex matches the step / thinking / elapsed shapes, never the static phrase", () => {
    expect(PROGRESS_LINE_RE.test("⚙️ github.search_issues — allowed (read)")).toBe(true);
    expect(PROGRESS_LINE_RE.test("🧠 the model is reasoning about the fix")).toBe(true);
    expect(PROGRESS_LINE_RE.test("Thinking… 3s")).toBe(true);
    expect(PROGRESS_LINE_RE.test("Thinking…")).toBe(false);
    expect(PROGRESS_LINE_RE.test("ok")).toBe(false);
  });
});

describe("no-reply timeout diagnosis (issue #245)", () => {
  test("a bot turn that never replies times out WITH what it posted — turn opened, tool lines, and the empty-response churn guard", async () => {
    // Live finding (run mt01tgvw-48n): a no-reply wait reported only
    // "no bot reply to ... within Nms" while the bot had visibly opened a
    // turn — the bare message hid the failure mode. The stub returns ONLY
    // bot-authored non-reply rows after the inbound: a ⚙️ progress line, a
    // 🧠 thinking line, the adapter's EMPTY_RESPONSE_FALLBACK, and the
    // CHURN_MESSAGE guard. Red on the pre-fix code TWICE over: the
    // fallback row matched the reply filter, so waitForBotReply
    // false-PASSED on the churn turn (resolved with the fallback instead
    // of timing out) — and a true timeout carried no diagnosis. Post-fix
    // the wait times out and the error names the cause.
    const pingTs = "1787000000.000100";
    const botRows: SlackApiMessage[] = [
      { ts: "1787000000.000110", channel: "C1", bot_id: "B-bot", text: "⚙️ github.search_issues — allowed (read)" },
      { ts: "1787000000.000120", channel: "C1", bot_id: "B-bot", text: "🧠 the model is reasoning about the fix" },
      { ts: "1787000000.000130", channel: "C1", bot_id: "B-bot", text: "Hmm — I got an empty response, retrying…" },
      { ts: "1787000000.000140", channel: "C1", bot_id: "B-bot", text: "I keep getting empty responses — check the model key?" },
    ];
    // SAFETY: the stub only exposes the sync members waitForBotReply reads
    // (history for the poll, botUserId/qaUserId for isBotMessage); the
    // rest of the Harness surface is unused in this mechanism test.
    const h = {
      liveSlack: {
        botUserId: "B-bot",
        qaUserId: "U-qa",
        history: async (_channelId: string) => [
          { ts: pingTs, channel: "C1", user: "U-qa", text: "canary ping" },
          ...botRows,
        ],
        replies: async (_channelId: string, _threadTs: string): Promise<SlackApiMessage[]> => [],
      },
    } as Harness;
    let error: Error | undefined;
    try {
      await waitForBotReply(h, "C1", {
        afterTs: pingTs,
        label: "churn diagnostics ping",
        timeoutMs: 300,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    // Pre-fix this resolved (the fallback false-passed as a "reply") and
    // then the message assertions below failed; post-fix it rejects.
    expect(error).toBeDefined();
    const message = error?.message ?? "";
    // Turn opened: the diagnosis counts the bot rows and calls out that
    // none reads as a reply.
    expect(message).toMatch(/the bot posted \d+ message\(s\) after the ask but none reads as a reply/);
    // Tool / progress lines surface verbatim (issue #245).
    expect(message).toContain("⚙️ github.search_issues — allowed (read)");
    expect(message).toContain("🧠 the model is reasoning about the fix");
    // The empty-response churn guard names the recovery (issue #245).
    expect(message).toMatch(/empty-response churn hit the recovery guard — check the model key/);
  });
});

describe("auto-pickup explicit-confirm gate (issue #245)", () => {
  test("a work item created during the draft wait (no in-channel confirmation) fails the journey instead of passing the count-poll", async () => {
    // The pickup journey's item poll only proves "a WORK_ITEM_CREATED_EVENT
    // row appeared after the inbound"; it cannot tell whether the item came
    // from the human's in-channel confirmation (the #89 explicit-confirm
    // contract) or PREMATURELY from the draft ask alone. A gate regression
    // (auto-pickup creates without confirming) would PASS the count-poll.
    // This stub simulates exactly that: history has the draft ask (no
    // confirmation is ever posted — postAsUser never returns a confirm
    // reply) while the audit store grows the premature created row on the
    // second listAudit call (the count-poll BELOW the confirm, where the
    // pre-fix journey reads it). RED on pre-fix: the journey reports
    // "pass" (the premature row satisfied the count-poll); GREEN now: the
    // draft-wait gate fails it with the diagnostic.
    const spaceId = "slack:C1";
    const fixture = "canary pickup fixture hermetic";
    const prematureRow: AuditRow = {
      id: 1,
      ts: 101,
      space_id: spaceId,
      actor: "space",
      event_type: WORK_ITEM_CREATED_EVENT,
      payload: JSON.stringify({ id: "wi-1", requester: "space", assignee: null }),
    };
    const prematureItem: WorkItem = {
      id: "wi-1",
      space_id: spaceId,
      requester: "space",
      assignee: null,
      description: `${fixture} — add a docstring to the project README explaining the canary`,
      repo: null,
      pr_url: null,
      pr_branch: null,
      base_branch: null,
      delivery: "chat",
      model: null,
      reasoning_effort: null,
      skills: "[]",
      state: "open",
      approvals: "[]",
      evidence: "[]",
      result: null,
      forked_from: null,
      fork_json: null,
      created_at: 101,
      updated_at: 101,
    };
    let listAudits = 0;
    // SAFETY: journeySemanticPickup reads only the live Slack post/history/
    // permalink methods and store list/get methods supplied by this double;
    // each method returns the complete owner contract used by that journey.
    const h = {
      liveSlack: {
        botUserId: "B-bot",
        qaUserId: "U-qa",
        postAsUser: async (_channelId: string, _text: string): Promise<PostedSlackMessage> => ({
          ts: "100.000001",
        }),
        // The draft ask lands; NO confirmation reply ever does (the item was
        // created without the in-channel confirmation, the regression under
        // test).
        history: async (_channelId: string): Promise<SlackApiMessage[]> => [
          { ts: "100.000001", channel: "C1", user: "U-qa", text: "canary ping" },
          { ts: "101.000002", channel: "C1", bot_id: "B-bot", text: "here is the draft — confirm to create the item" },
        ],
        permalink: async (_channelId: string, _ts: string): Promise<string | undefined> =>
          `https://example/p/${_ts}`,
      },
      store: {
        // First call is the journey's `before` snapshot (no rows yet); every
        // later read finds the premature created row.
        listAudit: async (_opts?: { space?: string; event_type?: string }): Promise<AuditRow[]> => {
          listAudits += 1;
          return listAudits === 1 ? [] : [prematureRow];
        },
        getWorkItem: async (_id: string): Promise<WorkItem | null> => prematureItem,
      },
    } as Harness;
    const result = await journeySemanticPickup(h, "C1", "hermetic");
    // Pre-fix this was "pass" (the count-poll below the confirm read the
    // premature row as success); post-fix the draft-wait gate fails loudly.
    expect(result.status).toBe("fail");
    expect(result.details.join(" ")).toContain("item created without confirmation draft");
  });

  test(
    "the pickup fixture match is case-insensitive (the model capitalizes the sentence start)",
    // @ts-expect-error bun's runtime honors test(name, {timeout}, fn) even
    // though bun 1.3.14's bundled .d.ts omits the options overload — the
    // journey's internal explicit-confirm gate window (PICKUP_GATE_WINDOW_MS)
    // is a fixed 5s no-op poll, so this full-success-path test needs >5s to
    // clear the default 5000ms timeout.
    { timeout: 30_000 },
    async () => {
    const spaceId = "slack:C1";
    // The item was created correctly; the model rewrote the description with
    // a capital-C at the sentence start — the fixture ("canary pickup fixture
    // hermetic-case", lower-case) is STILL present, so the journey must pass
    // (pre-fix this failed on a case-sensitive `.includes(fixture)`).
    const createdItem: WorkItem = {
      id: "wi-2",
      space_id: spaceId,
      requester: "space",
      assignee: null,
      description: `Canary pickup fixture hermetic-case — add a docstring to the project README explaining the canary`,
      repo: null,
      pr_url: null,
      pr_branch: null,
      base_branch: null,
      delivery: "chat",
      model: null,
      reasoning_effort: null,
      skills: "[]",
      state: "open",
      approvals: "[]",
      forked_from: null,
      fork_json: null,
      evidence: "[]",
      result: null,
      created_at: 101,
      updated_at: 101,
    };
    const createdRow: AuditRow = {
      id: 2,
      ts: 201,
      space_id: spaceId,
      actor: "space",
      event_type: WORK_ITEM_CREATED_EVENT,
      payload: JSON.stringify({ id: "wi-2", requester: "space", assignee: null }),
    };
    let listAudits = 0;
    let posts = 0;
    let confirmed = false;
    // SAFETY: journeySemanticPickup reads only the live Slack post/history/
    // permalink methods and store list/get methods supplied by this double.
    const h = {
      liveSlack: {
        botUserId: "B-bot",
        qaUserId: "U-qa",
        postAsUser: async (_channelId: string, _text: string): Promise<PostedSlackMessage> => {
          posts += 1;
          // The human's in-channel confirmation is the SECOND post
          // ("confirmed — create the work item now"); only after it may the
          // store observe the created row.
          if (posts === 2) confirmed = true;
          return { ts: `${200 + posts}.00000${posts}` };
        },
        // The draft ask lands, then the human's confirmation reply lands —
        // both bot replies drive waitForBotReply to completion.
        history: async (_channelId: string): Promise<SlackApiMessage[]> => [
          { ts: "201.000001", channel: "C1", user: "U-qa", text: "implement a canary pickup fixture" },
          { ts: "202.000002", channel: "C1", bot_id: "B-bot", text: "here is the draft — confirm to create the item" },
          { ts: "203.000003", channel: "C1", user: "U-qa", text: "confirmed — create the work item now" },
          { ts: "204.000004", channel: "C1", bot_id: "B-bot", text: "created wi-2" },
        ],
        permalink: async (_channelId: string, _ts: string): Promise<string | undefined> =>
          `https://example/p/${_ts}`,
      },
      store: {
        // No created row is ever visible until the human confirms in-channel
        // (the #245 explicit-confirm gate): the premature-gate polls during
        // the draft window all see zero rows, and the confirm count-poll
        // only observes the row after `confirmed` flips.
        listAudit: async (
          _opts?: { space?: string; event_type?: string },
        ): Promise<AuditRow[]> => {
          listAudits += 1;
          return confirmed ? [createdRow] : [];
        },
        getWorkItem: async (_id: string): Promise<WorkItem | null> => createdItem,
      },
    } as Harness;
    const result = await journeySemanticPickup(h, "C1", "hermetic-case");
    // The capitalized (sentence-start) fixture must still match — the fix.
    expect(result.status).toBe("pass");
    expect(result.details.join(" ")).toContain("wi-2");
  });
});
