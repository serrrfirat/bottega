/**
 * Headless tool-family journeys for issue #363: every registered space-agent
 * tool family crosses the REAL gated session surface at least once —
 * scripted model turn → driver gate (policy.decision) → family definition →
 * observable effect (store rows / audit / outbound blocks / error text).
 *
 * Definitions are built exactly like src/server/index.ts wires them and
 * injected through cfg.gatedTools. That factory runs EAGERLY during boot,
 * so every definition closes over a LATE-BOUND store/audit pair that binds
 * to the booted instances right after bootHarness returns.
 *
 * Model-facing tool names are the gateway-safe FLAT names (#78/#148):
 * scripts call memory_save / object_list etc.; policy decisions keep the
 * canonical dotted names.
 *
 * Excluded by design (deeper contracts proven by their own suites; this
 * lane proves the gated pass-through once per family): catalog_browser /
 * stack_health / first_run_wizard probe seams (admin.test.ts), slack_read
 * adapter seams (slack-read.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { bootHarness, AutoApproveRouter, type Harness } from "./harness";
import type { StubTurn } from "./harness";
import { parseOrgConfigYaml, type PolicyConfig } from "../../src/policy/config";
import type { Store } from "../../src/store/db";
import type { AuditModule } from "../../src/policy/audit";
import { POLICY_DECISION_EVENT } from "../../src/store/audit-events";
import { settingsToolDefinitions } from "../../src/tools/settings";
import { operatorReadToolDefinitions } from "../../src/tools/operator-read";
import { objectToolDefinitions } from "../../src/tools/objects";
import { spaceSkillToolDefinitions } from "../../src/tools/space-skills";
import { kbToolDefinitions } from "../../src/tools/kb-tools";
import { chartToolDefinition } from "../../src/tools/render-chart";
import { searchWebToolDefinition } from "../../src/tools/search-web";
import { graphQueryToolDefinition } from "../../src/tools/graph-query";
import { listTodosToolDefinition } from "../../src/tools/list-todos";
import { adminToolDefinitions } from "../../src/tools/admin";

const HEADLESS_ACTOR = "U-headless-human";

/**
 * Late-bound store/audit pair for eager gatedTools factories: definitions
 * close over proxies that resolve to the real booted instances after boot.
 */
type LateBoundTools = { store: Store; audit: AuditModule; bind(h: Harness): void };

function lateBind(): LateBoundTools {
  let real: { store: Store; audit: AuditModule } | null = null;
  const proxied = <T extends object>(pick: () => T): T =>
    // SAFETY: the proxy target is intentionally empty; every property read is
    // redirected to the bound dependency in the `get` trap below.
    new Proxy({} as T, {
      get(_t, prop: PropertyKey) {
        if (real === null) throw new Error("late-bound tools used before bootHarness returned");
        const target = pick();
        // SAFETY: Proxy `get` receives a key from the target object; keyof T is
        // the exact property domain exposed by the late-bound dependency.
        const value = prop in target ? target[prop as keyof T] : undefined;
        return value instanceof Function ? value.bind(target) : value;
      },
    });
  const store = proxied(() => real!.store);
  const audit = proxied(() => real!.audit);
  return { store, audit, bind: (h) => { real = { store: h.store, audit: h.audit }; } };
}

type PolicyDecision = { tool?: string; decision?: string };

async function decisions(h: Harness): Promise<PolicyDecision[]> {
  const rows = await h.store.listAudit({ limit: 300 });
  return rows.filter((row) => row.event_type === POLICY_DECISION_EVENT).map((row) => {
    // SAFETY: policy decision rows are serialized by the audit writer with
    // this optional tool/decision payload shape.
    const payload = JSON.parse(row.payload) as { tool?: string; tool_name?: string; decision?: string };
    return { tool: payload.tool ?? payload.tool_name, decision: payload.decision };
  });
}

/** The last tool-role message content the stub received. */
function lastToolText(h: Harness): string {
  const messages = h.modelStub.latestMessages();
  const tool = [...messages].reverse().find((m) => m.role === "tool");
  const parsed = z.string().safeParse(tool?.content);
  return parsed.success ? parsed.data : JSON.stringify(tool?.content ?? "");
}

const TOOL_ALLOWLIST = [
  "memory.save", "memory.search", "memory.forget", "model_settings", "use_model",
  "settings", "settings_org_write", "audit_search", "explain_policy", "usage_summary",
  "object.create", "object.list", "object.get", "list_space_skills", "get_space_skill",
  "create_space_skill", "update_space_skill", "delete_space_skill", "kb_ingest", "search_web",
  "render_chart", "graph_query", "list_todos", "deploy_info",
] as const;

const ORG_YAML = [
  "tools:",
  ...TOOL_ALLOWLIST.map((name) => `  ${name}: allow`),
  "approvals:",
  "  always_approve:",
  "    - settings_org_write",
  "    - create_space_skill",
].join("\n");

describe("headless tool families (issue #363)", () => {
  test("memory family round-trips through the real gate and emits an audit", async () => {
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "memory_save", args: { scope: "org", content: "headless tool coverage" } }] },
      { type: "tool_calls", calls: [{ name: "memory_search", args: { query: "headless tool coverage", scope: "org", limit: 5 } }] },
      { type: "text", text: "memory complete" },
    ];
    const h = await bootHarness({ headless: true, orgConfigYaml: ORG_YAML, modelTurns: turns });
    try {
      await h.deliverMessage(h.slack.dmChannelId, "save and find the coverage note");
      await h.modelStub.waitForRequests(3);
      const found = await h.memory.search({ query: "headless tool coverage", scope: { kind: "org" }, limit: 5 });
      expect(found.some((entry) => entry.content === "headless tool coverage")).toBe(true);
      expect((await decisions(h)).some((row) => row.tool === "memory.save" && row.decision === "allow")).toBe(true);
    } finally { await h.cleanup(); }
  });

  test("model settings switches the request model and unknown tools fail closed", async () => {
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "use_model", args: { role: "fast" } }] },
      { type: "tool_calls", calls: [{ name: "definitely_not_a_tool", args: {} }] },
      { type: "text", text: "done" },
    ];
    const h = await bootHarness({ headless: true, orgConfigYaml: ORG_YAML, modelTurns: turns });
    try {
      await h.deliverMessage(h.slack.dmChannelId, "switch model then try an unknown operation");
      await h.modelStub.waitForRequests(3);
      expect(h.modelStub.requests[1]?.model).toContain("stub");
      expect(
        h.modelStub.requests.some((r) => r.messages.some((m) => m.role === "tool")),
      ).toBe(true);
      // Unknown name → hard SDK-level failure ("not found"), never a
      // silent pass-through; the deny-decision contract for KNOWN-but-
      // denied tools is covered by the policy suites.
      expect(lastToolText(h)).toContain("definitely_not_a_tool");
    } finally { await h.cleanup(); }
  });

  test("settings write persists; org-scope crosses the exec approval gate", async () => {
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "settings", args: { scope: "org", set: { response_mode: "request-only" } } }] },
      { type: "text", text: "settings updated" },
    ];
    let orgPolicyRef: PolicyConfig | undefined;
    const late = lateBind();
    const h = await bootHarness({
      headless: true,
      orgConfigYaml: ORG_YAML,
      modelTurns: turns,
      gatedTools: () => [
        ...settingsToolDefinitions(late.store, {
          audit: late.audit,
          actor: HEADLESS_ACTOR,
          gate: { loadPolicy: async () => orgPolicyRef ?? parseOrgConfigYaml(ORG_YAML), router: AutoApproveRouter },
        }),
      ],
    });
    late.bind(h);
    orgPolicyRef = h.orgPolicy;
    try {
      await h.deliverMessage(h.slack.dmChannelId, "switch the org to request-only responses");
      await h.modelStub.waitForRequests(2);
      const settingsRow = (await h.store.listAudit({ limit: 100 })).find((r) => r.event_type === "settings.changed");
      expect(settingsRow).toBeDefined();
      expect((await decisions(h)).some((row) => row.tool === "settings" && row.decision === "allow")).toBe(true);
    } finally { await h.cleanup(); }
  });

  test("operator-read trio answers from the real audit trail", async () => {
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "audit_search", args: { event: "message.in", limit: 5 } }] },
      { type: "tool_calls", calls: [{ name: "explain_policy", args: { tool: "memory.save" } }] },
      { type: "tool_calls", calls: [{ name: "usage_summary", args: {} }] },
      { type: "text", text: "operator briefed" },
    ];
    const late = lateBind();
    const h = await bootHarness({
      headless: true,
      orgConfigYaml: ORG_YAML,
      modelTurns: turns,
      gatedTools: ({ store }) =>
        operatorReadToolDefinitions(store, {
          audit: late.audit,
          orgPolicy: parseOrgConfigYaml(ORG_YAML),
          actorForSpace: () => HEADLESS_ACTOR,
          canReadSpace: async () => true,
        }),
    });
    late.bind(h);
    try {
      await h.deliverMessage(h.slack.dmChannelId, "brief me");
      await h.modelStub.waitForRequests(4);
      const allowNames = (await decisions(h)).filter((r) => r.decision === "allow").map((r) => r.tool);
      for (const name of ["audit_search", "explain_policy", "usage_summary"]) {
        expect(allowNames).toContain(name);
      }
      expect(lastToolText(h).length).toBeGreaterThan(0);
    } finally { await h.cleanup(); }
  });

  test("objects create/list round-trips durable bytes", async () => {
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "object_create", args: { name: "notes.txt", content: "coverage bytes" } }] },
      { type: "tool_calls", calls: [{ name: "object_list", args: {} }] },
      { type: "text", text: "object stored" },
    ];
    const h = await bootHarness({
      headless: true,
      orgConfigYaml: ORG_YAML,
      modelTurns: turns,
      gatedTools: ({ store }) => objectToolDefinitions(store, { orgPolicy: parseOrgConfigYaml(ORG_YAML), actor: HEADLESS_ACTOR }),
    });
    try {
      await h.deliverMessage(h.slack.dmChannelId, "store these notes");
      await h.modelStub.waitForRequests(3);
      expect(lastToolText(h)).toContain("notes.txt");
    } finally { await h.cleanup(); }
  });

  test("space-skills lifecycle runs under a temp skills root", async () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), "headless-skills-"));
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "create_space_skill", args: {
            name: "deploy-runbook",
            document: "---\nname: deploy-runbook\ndescription: Steps for deploys\n---\n# steps\ndo it",
          } }] },
      { type: "tool_calls", calls: [{ name: "get_space_skill", args: { name: "deploy-runbook" } }] },
      { type: "text", text: "skill ready" },
    ];
    const late = lateBind();
    const h = await bootHarness({
      headless: true,
      orgConfigYaml: ORG_YAML,
      modelTurns: turns,
      gatedTools: ({ store }) =>
        spaceSkillToolDefinitions(store, { audit: late.audit, actor: HEADLESS_ACTOR, skillsRoot }),
    });
    late.bind(h);
    try {
      await h.deliverMessage(h.slack.dmChannelId, "write the runbook skill");
      await h.modelStub.waitForRequests(3);
      const combined = h.modelStub.requests
        .map((r) => [...r.messages].reverse().find((m) => m.role === "tool"))
        .map((m) => {
          const parsed = z.string().safeParse(m?.content);
          return parsed.success ? parsed.data : JSON.stringify(m?.content ?? "");
        })
        .join("\n");
      expect(combined).toContain("do it");
    } finally {
      await h.cleanup();
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });

  test("kb_ingest enqueues worker jobs on the job bus", async () => {
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "kb_ingest", args: {} }] },
      { type: "text", text: "refresh queued" },
    ];
    const h = await bootHarness({
      headless: true,
      orgConfigYaml: ORG_YAML,
      modelTurns: turns,
      gatedTools: ({ store }) =>
        kbToolDefinitions({
          store,
          config: { sources: [{ id: "docs", url: "http://127.0.0.1:9/unreachable.md", type: "url" }] },
        }),
    });
    try {
      await h.deliverMessage(h.slack.dmChannelId, "refresh knowledge base");
      await h.modelStub.waitForRequests(2);
      const db = h.store.getDb();
      // SAFETY: this aggregate query always returns one row with its numeric
      // COUNT(*) value under the `n` alias.
      const queued = db.query("SELECT COUNT(*) AS n FROM worker_jobs WHERE kind = 'kb'").get() as { n: number };
      expect(queued.n).toBeGreaterThanOrEqual(1);
    } finally { await h.cleanup(); }
  });

  test("search_web fails closed when the SearXNG service is unavailable", async () => {
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "search_web", args: { query: "bottega" } }] },
      { type: "text", text: "search unavailable" },
    ];
    const h = await bootHarness({
      headless: true,
      orgConfigYaml: ORG_YAML,
      modelTurns: turns,
      gatedTools: () => [
        searchWebToolDefinition({
          fetch: async () => {
            throw new Error("SearXNG unavailable");
          },
        }),
      ],
    });
    try {
      await h.deliverMessage(h.slack.dmChannelId, "search the web please");
      await h.modelStub.waitForRequests(2);
      expect(lastToolText(h)).toMatch(/unreachable|connect|unavailable|failed/i);
    } finally {
      await h.cleanup();
    }
  });

  test("render_chart posts exactly one Slack block through the presenter sink", async () => {
    const charts: Array<{ spaceId: string; block: { type: string } }> = [];
    const turns: StubTurn[] = [
      {
        type: "tool_calls",
        calls: [{
          name: "render_chart",
          args: { type: "pie", title: "Deploys", segments: [{ label: "ok", value: 9 }, { label: "failed", value: 1 }] },
        }],
      },
      { type: "text", text: "chart posted" },
    ];
    const h = await bootHarness({
      headless: true,
      orgConfigYaml: ORG_YAML,
      modelTurns: turns,
      gatedTools: () => [chartToolDefinition({ postChart: (spaceId, block) => charts.push({ spaceId, block }) })],
    });
    try {
      await h.deliverMessage(h.slack.dmChannelId, "chart deploys");
      await h.modelStub.waitForRequests(2);
      expect(charts).toHaveLength(1);
      expect(charts[0]!.block.type).toBe("data_visualization");
      expect(charts[0]!.spaceId).toBe(`slack:${h.slack.dmChannelId}`);
    } finally { await h.cleanup(); }
  });

  test("graph_query and list_todos answer against shared state", async () => {
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "graph_query", args: { query: "what is deployed" } }] },
      { type: "tool_calls", calls: [{ name: "list_todos", args: {} }] },
      { type: "text", text: "state summarized" },
    ];
    const h = await bootHarness({
      headless: true,
      orgConfigYaml: ORG_YAML,
      modelTurns: turns,
      gatedTools: ({ store }) => [graphQueryToolDefinition(store), listTodosToolDefinition(store)],
    });
    try {
      await h.deliverMessage(h.slack.dmChannelId, "what is pending anywhere");
      await h.modelStub.waitForRequests(3);
      const allowNames = (await decisions(h)).filter((r) => r.decision === "allow").map((r) => r.tool);
      expect(allowNames).toContain("graph_query");
      expect(allowNames).toContain("list_todos");
    } finally { await h.cleanup(); }
  });

  test("admin deploy_info reports deployment identity", async () => {
    const turns: StubTurn[] = [
      { type: "tool_calls", calls: [{ name: "deploy_info", args: {} }] },
      { type: "text", text: "identity reported" },
    ];
    const h = await bootHarness({
      headless: true,
      orgConfigYaml: ORG_YAML,
      modelTurns: turns,
      gatedTools: ({ store }) => adminToolDefinitions(store),
    });
    try {
      await h.deliverMessage(h.slack.dmChannelId, "what build is this");
      await h.modelStub.waitForRequests(2);
      expect(lastToolText(h)).toMatch(/uptime|image|commit|null|tag/i);
    } finally { await h.cleanup(); }
  });
});
