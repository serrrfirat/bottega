/**
 * Journey 5 (issue #73): the four admin surfaces are LIVE in a restricted
 * real-SDK session — catalog browser, stack health, deploy info, first-run
 * wizard — gated like the settings tool (write tier → org-settings access;
 * deploy_info read tier) and audited on EVERY invocation (`admin.*` rows on
 * top of the gate's `policy.decision` rows).
 *
 * Same shape as journey 4 (#69): the REAL `createAgentSession` runs through
 * the e2e harness; the model calls each tool; assertions are
 * observable-contract — gate decisions, audit rows, tool results, and the
 * draft file the catalog browser writes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootHarness, type EmulatorMessage, type Harness, type StubTurn } from "./harness";
import type { JsonValue } from "../../src/extensions/manifest";
import {
  ADMIN_CATALOG_BROWSER_EVENT,
  ADMIN_DEPLOY_INFO_EVENT,
  ADMIN_FIRST_RUN_EVENT,
  ADMIN_STACK_HEALTH_EVENT,
  POLICY_DECISION_EVENT,
} from "../../src/store/audit-events";
import { adminToolDefinitions } from "../../src/tools/admin";

const dirs: Array<{ cleanup(): Promise<void> }> = [];
afterAll(async () => {
  for (const h of dirs.splice(0)) await h.cleanup();
});

async function harness(turns: StubTurn[], orgConfigYaml: string): Promise<Harness> {
  const draftsDir = mkdtempSync(join(tmpdir(), "bottega-admin-e2e-"));
  const h = await bootHarness({
    modelTurns: turns,
    orgConfigYaml,
    gatedTools: ({ store, audit, registry }) =>
      adminToolDefinitions(store, {
        audit,
        registry,
        catalogDraftsDir: draftsDir,
        // Hermetic probes: the journey must not depend on docker or the
        // host network (the hermetic unit tests cover the real probe
        // defaults; here every service answers up).
        health: {
          composePs: async () => ({ available: false }),
          httpGet: async (url) => ({ ok: true, evidence: `GET ${url} -> HTTP 200` }),
          tcpConnect: async (host, port) => ({ ok: true, evidence: `tcp ${host}:${port} connected` }),
        },
        // Hermetic catalog: the journey must not hit integrations.sh.
        catalog: {
          // SAFETY: the stub implements fetch's call contract (input, init?) => Promise<Response>;
          // Bun's fetch also exposes fetch.preconnect, which the catalog client never calls.
          fetchImpl: (async (_input: string | URL | Request, _init?: RequestInit) =>
            new Response(
              JSON.stringify({
                version: 1,
                data: [
                  {
                    id: "mcp/linear",
                    slug: "linear",
                    kind: "mcp",
                    name: "Linear",
                    description: "Manage issues in Linear.",
                    url: "https://linear.app/docs/mcp",
                    domain: "linear.app",
                  },
                ],
              }),
              { status: 200 },
            )) as typeof fetch,
        },
      }),
  });
  dirs.push(h);
  return h;
}

/** Audit rows for one event type, payload parsed. */
async function auditRows(h: Harness, eventType: string) {
  const rows = (await h.audit.listAudit({})).filter((r) => r.event_type === eventType);
  // SAFETY: audit payloads are JSON documents (the tools serialize flat
  // objects via JSON.stringify); the parsed rows carry JsonValue members.
  return rows.map((row) => JSON.parse(row.payload) as Record<string, JsonValue>);
}

/** Polls the emulator for an outbound message (posts land a beat after the turn). */
async function waitForReply(h: Harness, text: string, timeoutMs = 5_000): Promise<EmulatorMessage | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = h.messages(h.slack.dmChannelId).find((m) => m.text === text);
    if (reply) return reply;
    await Bun.sleep(50);
  }
  return undefined;
}

describe("journey 5: admin setup/onboarding tools live in a restricted session (issue #73)", () => {
  test(
    "catalog_browser list + stack_health run through the gate, audited admin.*, and the turn completes",
    async () => {
      const h = await harness(
        [
          { type: "tool_calls", calls: [{ name: "catalog_browser", args: { action: "list", query: "linear" } }] },
          { type: "text", text: "catalog done" },
          { type: "tool_calls", calls: [{ name: "stack_health", args: {} }] },
          { type: "text", text: "health done" },
        ],
        "tools:\n  catalog_browser: allow\n  stack_health: allow\n",
      );
      try {
        await h.deliverMessage(h.slack.dmChannelId, "what extensions match linear?");
        await h.deliverMessage(h.slack.dmChannelId, "check the stack");
        await h.modelStub.waitForRequests(4);

        // Both calls crossed the gate with allow decisions (known tools,
        // write tier + allow policy).
        const decisions = await auditRows(h, POLICY_DECISION_EVENT);
        const catalogDecision = decisions.find((row) => row.tool === "catalog_browser");
        expect(catalogDecision).toBeDefined();
        expect(catalogDecision!.decision).toBe("allow");
        expect(catalogDecision!.tier).toBe("write");
        const healthDecision = decisions.find((row) => row.tool === "stack_health");
        expect(healthDecision).toBeDefined();
        expect(healthDecision!.decision).toBe("allow");
        expect(healthDecision!.tier).toBe("write");

        // Every invocation audited its admin.* row.
        const catalogRows = await auditRows(h, ADMIN_CATALOG_BROWSER_EVENT);
        expect(catalogRows).toHaveLength(1);
        expect(catalogRows[0].action).toBe("list");
        expect(catalogRows[0].query).toBe("linear");
        const healthRows = await auditRows(h, ADMIN_STACK_HEALTH_EVENT);
        expect(healthRows).toHaveLength(1);
        expect(healthRows[0].ok).toBe(true);

        // Both turns completed with the scripted replies.
        expect(await waitForReply(h, "catalog done")).toBeDefined();
        expect(await waitForReply(h, "health done")).toBeDefined();
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "catalog_browser draft writes an unreviewed draft (never installed) and audits it",
    async () => {
      const h = await harness(
        [
          { type: "tool_calls", calls: [{ name: "catalog_browser", args: { action: "draft", spec: "linear" } }] },
          { type: "text", text: "drafted" },
        ],
        "tools:\n  catalog_browser: allow\n",
      );
      try {
        await h.deliverMessage(h.slack.dmChannelId, "draft the linear extension");
        await h.modelStub.waitForRequests(2);

        const rows = await auditRows(h, ADMIN_CATALOG_BROWSER_EVENT);
        expect(rows).toHaveLength(1);
        expect(rows[0].action).toBe("draft");
        // The audit payload's written_to is the absolute draft path the
        // tool reported — parsed at the boundary; a non-string fails loudly.
        const writtenTo = z.string().parse(rows[0].written_to);
        expect(existsSync(writtenTo)).toBe(true);
        // SAFETY: the draft file is the catalog browser's own serialized
        // draft JSON (source/manifest asserted below).
        const draft = JSON.parse(readFileSync(writtenTo, "utf8")) as {
          source: { reviewed: boolean };
          manifest: { id: string };
        };
        expect(draft.source.reviewed).toBe(false);
        expect(draft.manifest.id).toBe("linear");

        const reply = await waitForReply(h, "drafted");
        expect(reply).toBeDefined();
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "deploy_info is read-tier: allowed for anyone, audited admin.deploy_info",
    async () => {
      const h = await harness(
        [{ type: "tool_calls", calls: [{ name: "deploy_info", args: {} }] }, { type: "text", text: "identity" }],
        "tools:\n  deploy_info: allow\n",
      );
      try {
        await h.deliverMessage(h.slack.dmChannelId, "what version are we?");
        await h.modelStub.waitForRequests(2);

        const decisions = await auditRows(h, POLICY_DECISION_EVENT);
        const deployDecision = decisions.find((row) => row.tool === "deploy_info");
        expect(deployDecision).toBeDefined();
        expect(deployDecision!.decision).toBe("allow");
        expect(deployDecision!.tier).toBe("read");

        const rows = await auditRows(h, ADMIN_DEPLOY_INFO_EVENT);
        expect(rows).toHaveLength(1);
        expect(rows[0].uptime_seconds).toBeTypeOf("number");
        expect(rows[0].config_dir).toBeTypeOf("string");

        const reply = await waitForReply(h, "identity");
        expect(reply).toBeDefined();
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "first_run_wizard fails loudly in a bare deployment and audits its checks",
    async () => {
      // This test file runs in its own process; scrub the deployment env so
      // the wizard sees a bare deployment deterministically.
      const keys = [
        "SLACK_APP_TOKEN",
        "SLACK_BOT_TOKEN",
        "OPENCODE_API_KEY",
        "NEAR_API_KEY",
        "OMP_AUTH_BROKER_TOKEN",
        "OMP_AUTH_BROKER_URL",
      ];
      const saved = new Map(keys.map((k) => [k, process.env[k]]));
      try {
        for (const key of keys) delete process.env[key];
        const h = await harness(
          [
            { type: "tool_calls", calls: [{ name: "first_run_wizard", args: {} }] },
            { type: "text", text: "wizard ran" },
          ],
          "tools:\n  first_run_wizard: allow\n",
        );
        try {
          await h.deliverMessage(h.slack.dmChannelId, "run the first-run checklist");
          await h.modelStub.waitForRequests(2);

          const decisions = await auditRows(h, POLICY_DECISION_EVENT);
          const wizardDecision = decisions.find((row) => row.tool === "first_run_wizard");
          expect(wizardDecision).toBeDefined();
          expect(wizardDecision!.decision).toBe("allow");
          expect(wizardDecision!.tier).toBe("write");

          const rows = await auditRows(h, ADMIN_FIRST_RUN_EVENT);
          expect(rows).toHaveLength(1);
          expect(rows[0].ok).toBe(false);
          // The wizard's checks array is parsed at the boundary; a malformed
          // payload fails the test loudly instead of being narrowed blindly.
          const checks = z.array(z.object({ name: z.string(), ok: z.boolean() })).parse(rows[0].checks);
          expect(checks).toHaveLength(6);
          expect(checks.find((c) => c.name === "slack_tokens")!.ok).toBe(false);

          const reply = await waitForReply(h, "wizard ran");
          expect(reply).toBeDefined();
        } finally {
          await h.cleanup();
        }
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
    30_000,
  );

  test(
    "a denied admin tool never runs: gate blocks with decision + audit, no admin.* row",
    async () => {
      const h = await harness(
        [
          { type: "tool_calls", calls: [{ name: "stack_health", args: {} }] },
          { type: "text", text: "blocked" },
        ],
        "tools:\n  stack_health: deny\n",
      );
      try {
        await h.deliverMessage(h.slack.dmChannelId, "is everything up?");
        await h.modelStub.waitForRequests(2);

        const decisions = await auditRows(h, POLICY_DECISION_EVENT);
        const healthDecision = decisions.find((row) => row.tool === "stack_health");
        expect(healthDecision).toBeDefined();
        expect(healthDecision!.decision).toBe("deny");

        // The denied call never executed: no admin.* row, no probe side effects.
        const healthRows = await auditRows(h, ADMIN_STACK_HEALTH_EVENT);
        expect(healthRows).toHaveLength(0);

        const reply = await waitForReply(h, "blocked");
        expect(reply).toBeDefined();
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );
});
