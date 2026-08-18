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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { proactiveEnabled } from "../../src/scheduler/proactive-config";
import { parseYamlSubset } from "../../src/yaml-subset";
import { nextCronFire } from "../../src/scheduler/cron";
import { buildRegistry } from "../../src/scheduler/actions";
import { tickScheduler } from "../../src/scheduler/runner";
import { standupDigestAction } from "../../src/scheduler/standup";
import { loadSpacePolicy } from "../../src/policy/config";
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
} from "../../src/store/audit-events";
import { createFixtureRegistry, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL } from "../../src/extensions/fixture";
import { createSecretFileBoundary } from "../../src/extensions/boundary";
import { pollPendingDeliveries } from "../../src/server/services/delivery-poller";
import { resolveDeliveryAction } from "../../src/server/adapters/delivery-router";
import { SlackApprovalRouter } from "../../src/server/adapters/approval-router";
import { DELIVERY_APPROVE_ACTION_ID, APPROVE_ACTION_ID } from "../../src/server/adapters/slack";
import { evaluatePolicyGate } from "../../src/policy/gate";
import { startUploadLinkServer, mintUploadLink } from "../../src/extensions/upload-link";
import { SNAPSHOT_SCHEMA } from "../../src/extensions/registry";
import type { SnapshotDraft } from "../../src/extensions/fetch-catalog";
import { adminToolDefinitions } from "../../src/tools/admin";
import { modelToolsDefinitions } from "../../src/tools/model-settings";
import { classifyPickupIntent, buildAutoPickupDirective } from "../../src/tools/work-item-pickup";
import type { McpBinding } from "../../src/extensions/manifest";
import { bootHarness, AutoApproveRouter, type StubTurn } from "./harness";
import { opencodeSafeToolName } from "../../src/server/drivers/agent-driver";
import {
  approvalButtonValue,
  canaryBroker,
  canaryMcpOAuthConnector,
  CANARY_OAUTH_EXTENSION_ID,
  CANARY_ORG_CONFIG,
  canaryFixtureMcpTransport,
  createCanaryRegistry,
  PROGRESS_LINE_RE,
  standupCronFor,
  toolCtxFor,
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
    const posted: Array<{ spaceId: string; text: string; blocks?: unknown[] }> = [];
    const updated: Array<{ spaceId: string; ts: string; text: string }> = [];
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
    expect(posted[0]!.text).toBe("Approval required for model_settings");
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

  test("the policy gate round trip audits approval.requested → approval.resolved", async () => {
    const h = await bootHarness({ orgConfigYaml: CANARY_ORG_CONFIG, registry: createCanaryRegistry() });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const posted: Array<{ spaceId: string; text: string; blocks?: unknown[] }> = [];
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
      const payload = JSON.parse(changed[changed.length - 1]!.payload) as { after?: Record<string, unknown> };
      expect(payload.after).toMatchObject({ model: "stub-v1", reasoning_effort: "high" });
    } finally {
      await h.cleanup();
    }
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
      const params = {
        action: "pin",
        spec,
        binding: { serverUrl: "https://fixture-pin.example.com/mcp", transport: "streamable-http" },
        credential_schema: { type: "api_key", domains: ["fixture-pin.example.com"] },
        vendor_official: true,
      } as const;

      const refused = await catalogBrowser.execute("tc1", params, undefined, undefined, toolCtxFor(h, spaceId));
      expect(refused.isError).toBe(true);
      expect((refused.content[0] as { text: string }).text).toContain("confirm");
      expect(h.extensionRegistry.resolve(spec)).toBeUndefined();

      const pinned = await catalogBrowser.execute("tc2", { ...params, confirm: true }, undefined, undefined, toolCtxFor(h, spaceId));
      expect(pinned.isError).not.toBe(true);
      const body = JSON.parse((pinned.content[0] as { text: string }).text) as {
        reviewed?: unknown;
        live_registry?: unknown;
      };
      expect(body.reviewed).toBe(true);
      expect(body.live_registry).toBe("registered");
      expect(h.extensionRegistry.resolve(spec)).toBeDefined();
      const audit = await h.store.listAudit({ event_type: ADMIN_CATALOG_BROWSER_EVENT });
      const pinRow = audit.find((r) => {
        const p = JSON.parse(r.payload) as { action?: unknown; spec?: unknown };
        return p.action === "pin" && p.spec === spec;
      });
      expect(pinRow).toBeDefined();
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
        const minted = mintUploadLink(
          { extension: FIXTURE_EXTENSION_ID, scope: "personal", actor: "U-owner", spaceId },
          { registry: h.extensionRegistry, store: uploadLink.store, baseUrl: () => uploadLink.baseUrl },
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
