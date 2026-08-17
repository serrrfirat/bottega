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
 *     tool (the transport half the live leg executes through).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { proactiveEnabled } from "../../src/scheduler/proactive-config";
import { parseYamlSubset } from "../../src/yaml-subset";
import { nextCronFire } from "../../src/scheduler/cron";
import { buildRegistry } from "../../src/scheduler/actions";
import { tickScheduler } from "../../src/scheduler/runner";
import { standupDigestAction } from "../../src/scheduler/standup";
import { loadSpacePolicy } from "../../src/policy/config";
import { EXTENSION_CALL_EVENT, MODEL_SWITCHED_EVENT } from "../../src/store/audit-events";
import { createFixtureRegistry, FIXTURE_EXTENSION_ID, FIXTURE_EXTENSION_TOOL } from "../../src/extensions/fixture";
import { createSecretFileBoundary } from "../../src/extensions/boundary";
import type { McpBinding } from "../../src/extensions/manifest";
import { bootHarness, type StubTurn } from "./harness";
import { opencodeSafeToolName } from "../../src/server/drivers/agent-driver";
import { canaryFixtureMcpTransport, standupCronFor } from "./canary";

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
    const h = await bootHarness();
    try {
      const channelId = h.slack.channelId("ops")!;
      const spaceId = `slack:${channelId}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: channelId });
      const space = await h.store.getSpace(spaceId);
      const overlay = JSON.parse(space!.policy_json || "{}") as Record<string, unknown>;
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
      canaryFixtureMcpTransport({ serverUrl: "in-memory", transport: "streamable-http" } as McpBinding),
    );
    const res = await client.callTool({ name: FIXTURE_EXTENSION_TOOL, arguments: { city: "canary-test" } });
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
    const h = await bootHarness({ modelTurns: turns });
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
