/**
 * Admin tools tests (issue #73): the four setup/onboarding surfaces —
 * catalog browser, stack health, deploy info, first-run wizard.
 *
 * - registration + gating: three admin tools are write-tier (org-settings
 *   access via the policy gate, mirrored from #67), deploy_info is read
 *   tier (anyone);
 * - catalog browser: list matches pinned snapshots + the integrations.sh
 *   catalog (stub fetch), capped with a truncation flag; draft writes an
 *   UNREVIEWED draft into the drafts dir — never the live snapshots dir,
 *   never installed; catalog failures fail closed;
 * - stack health: per-service status with evidence; any DOWN service fails
 *   the result loudly; compose state when docker is available; the
 *   executor is unknown (not down) without docker;
 * - deploy info: image tag / commit / uptime / config dir;
 * - first-run wizard: every check pass/fail with the fix instruction;
 *   PAT mode 0600 enforced (allow_loose_pat opts out);
 * - every invocation audits its admin.* event.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createStore } from "../store/db";
import {
  ADMIN_CATALOG_BROWSER_EVENT,
  ADMIN_DEPLOY_INFO_EVENT,
  ADMIN_FIRST_RUN_EVENT,
  ADMIN_STACK_HEALTH_EVENT,
} from "../store/audit-events";
import { decidePolicyCall, defaultPolicy, resolveTier } from "../policy/config";
import type { AuditModule } from "../policy/audit";
import type { ResolvedExtension } from "../extensions/registry";
import {
  adminToolDefinitions,
  adminToolsExtension,
  onboardingGuideText,
  runWizardChecks,
  type HealthProbeSeams,
  type ServiceStatus,
  type WizardCheck,
} from "./admin";

const noopCtx = {} as unknown as ExtensionContext;

interface AuditRow {
  actor: string;
  event_type: string;
  space_id?: string | null;
  payload: Record<string, unknown>;
}

function fakeAudit(): { audit: Pick<AuditModule, "appendAudit">; rows: AuditRow[] } {
  const rows: AuditRow[] = [];
  const audit: Pick<AuditModule, "appendAudit"> = {
    appendAudit: async (entry) => {
      const text = typeof entry.payload === "string" ? entry.payload : JSON.stringify(entry.payload);
      rows.push({
        actor: entry.actor,
        event_type: entry.event_type,
        space_id: entry.space_id ?? null,
        payload: JSON.parse(text),
      });
      return rows.length;
    },
  };
  return { audit, rows };
}

function loadTools(
  store: ReturnType<typeof createStore>,
  opts: Parameters<typeof adminToolDefinitions>[1] = {},
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const pi = { registerTool: (t: ToolDefinition) => void tools.push(t) } as unknown as ExtensionAPI;
  adminToolsExtension(store, opts)(pi);
  return tools;
}

async function call(
  tool: ToolDefinition,
  params: unknown,
): Promise<{ text: string; isError: boolean }> {
  const res = await tool.execute("call-1", params, undefined, undefined, noopCtx);
  return { text: (res.content[0] as { text: string }).text, isError: res.isError ?? false };
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function freshStore(): { store: ReturnType<typeof createStore>; dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "bottega-admin-"));
  const store = createStore(join(dir, "test.db"));
  return {
    store,
    dir,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A minimal fake pinned extension (read-only by the tool). */
function pinnedEntry(id: string, label: string, domain: string, reviewed = true): ResolvedExtension {
  return {
    manifest: { id, label, vendor: label, kind: "mcp", domains: [domain], tools: [] },
    snapshot: {
      schema: "bottega.extension-snapshot.v1",
      extensionId: id,
      pinnedAt: "2026-08-16T00:00:00.000Z",
      source: { catalog: "https://integrations.sh/api.json", specId: id, vendorOfficial: true, reviewed },
    },
  } as unknown as ResolvedExtension;
}

const CATALOG = {
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
    {
      id: "mcp/attio",
      slug: "attio",
      kind: "mcp",
      name: "Attio CRM",
      url: "https://docs.attio.com/mcp",
      domain: "mcp.attio.com",
    },
  ],
};

function stubFetch(catalog: unknown = CATALOG): typeof fetch {
  return (async () => new Response(JSON.stringify(catalog), { status: 200 })) as unknown as typeof fetch;
}

interface EnvBackup {
  keys: string[];
  values: Record<string, string | undefined>;
}

const ENV_KEYS = [
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "OPENCODE_API_KEY",
  "NEAR_API_KEY",
  "OMP_AUTH_BROKER_TOKEN",
  "OMP_AUTH_BROKER_URL",
  "BOTTEGA_IMAGE_TAG",
  "EXECUTOR_GIT_TOKEN_FILE",
];

function backupEnv(): EnvBackup {
  const values: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) values[key] = process.env[key];
  return { keys: [...ENV_KEYS], values };
}

function restoreEnv(backup: EnvBackup): void {
  for (const key of backup.keys) {
    const value = backup.values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** All services up via local probes, no docker. */
function allUpProbes(): Required<HealthProbeSeams> {
  return {
    composePs: async () => ({ available: false }),
    httpGet: async (url) => ({ ok: true, evidence: `GET ${url} -> HTTP 200` }),
    tcpConnect: async (host, port) => ({ ok: true, evidence: `tcp ${host}:${port} connected` }),
  };
}

describe("admin tools registration + gating (issue #73)", () => {
  test("registers four tools with the #67 mirror tiers", () => {
    const { store, cleanup } = freshStore();
    try {
      const tools = loadTools(store);
      expect(tools.map((t) => t.name).sort()).toEqual([
        "catalog_browser",
        "deploy_info",
        "first_run_wizard",
        "stack_health",
      ]);
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect(byName.get("catalog_browser")!.approval).toBe("write");
      expect(byName.get("stack_health")!.approval).toBe("write");
      expect(byName.get("first_run_wizard")!.approval).toBe("write");
      expect(byName.get("deploy_info")!.approval).toBe("read");
      expect(resolveTier("catalog_browser")).toBe("write");
      expect(resolveTier("stack_health")).toBe("write");
      expect(resolveTier("first_run_wizard")).toBe("write");
      expect(resolveTier("deploy_info")).toBe("read");
    } finally {
      cleanup();
    }
  });

  test("policy gate: admin tools are known write-tier tools; explicit deny wins", () => {
    // Mirrors the settings-tool gating contract (#67): known + write tier
    // + allow action → allow (prompts only in non-yolo approval modes).
    for (const tool of ["catalog_browser", "stack_health", "first_run_wizard"]) {
      const { decision } = decidePolicyCall({ ...defaultPolicy(), tools: { [tool]: "allow" } }, tool);
      expect(decision).toBe("allow");
      const denied = decidePolicyCall({ ...defaultPolicy(), tools: { [tool]: "deny" } }, tool);
      expect(denied.decision).toBe("deny");
    }
    // deploy_info is read-tier: an explicit allow never prompts (read
    // tier + allow action → allow); the fail-closed default still denies
    // it like every unlisted tool.
    const allowed = decidePolicyCall({ ...defaultPolicy(), tools: { deploy_info: "allow" } }, "deploy_info");
    expect(allowed.decision).toBe("allow");
    expect(allowed.reason).toContain("allowed by policy");
    expect(decidePolicyCall(defaultPolicy(), "deploy_info").decision).toBe("deny");
  });
});

describe("catalog_browser (issue #73)", () => {
  test("list returns pinned snapshots + catalog matches, filtered by query", async () => {
    const { store, cleanup } = freshStore();
    try {
      const { audit, rows } = fakeAudit();
      const tools = loadTools(store, {
        audit,
        registry: { list: () => [pinnedEntry("linear", "Linear", "linear.app"), pinnedEntry("attio", "Attio CRM", "mcp.attio.com")] },
        catalog: { fetchImpl: stubFetch() },
      });
      const [tool] = tools;
      const res = await call(tool, { action: "list", query: "linear" });
      expect(res.isError).toBe(false);
      const body = JSON.parse(res.text) as {
        pinned: Array<{ id: string }>;
        catalog: Array<{ slug: string; url: string }>;
        catalog_truncated: boolean;
      };
      expect(body.pinned.map((e) => e.id)).toEqual(["linear"]);
      expect(body.catalog.map((e) => e.slug)).toEqual(["linear"]);
      expect(body.catalog[0].url).toBe("https://linear.app/docs/mcp");
      expect(body.catalog_truncated).toBe(false);

      const all = await call(tool, { action: "list" });
      const allBody = JSON.parse(all.text) as { pinned: unknown[]; catalog: unknown[] };
      expect(allBody.pinned).toHaveLength(2);
      expect(allBody.catalog).toHaveLength(2);

      expect(rows).toHaveLength(2);
      expect(rows[0].event_type).toBe(ADMIN_CATALOG_BROWSER_EVENT);
      expect(rows[0].payload["action"]).toBe("list");
      expect(rows[0].payload["query"]).toBe("linear");
    } finally {
      cleanup();
    }
  });

  test("list caps the catalog at 50 matches with a truncation flag", async () => {
    const { store, cleanup } = freshStore();
    try {
      const many = {
        version: 1,
        data: Array.from({ length: 60 }, (_, i) => ({
          id: `mcp/spec${i}`,
          slug: `spec${i}`,
          kind: "mcp",
          name: `Spec ${i}`,
          url: `https://example.com/${i}`,
          domain: `spec${i}.example.com`,
        })),
      };
      const tools = loadTools(store, { catalog: { fetchImpl: stubFetch(many) } });
      const res = await call(tools[0], { action: "list", query: "spec" });
      const body = JSON.parse(res.text) as { catalog: unknown[]; catalog_truncated: boolean };
      expect(body.catalog).toHaveLength(50);
      expect(body.catalog_truncated).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("list tolerates a broadly url-less catalog: entries listed, url omitted, skipped capped", async () => {
    const { store, cleanup } = freshStore();
    try {
      const data: unknown[] = Array.from({ length: 6 }, (_, i) => ({
        id: `mcp/spec${i}`,
        slug: `spec${i}`,
        kind: "mcp",
        name: `Spec ${i}`,
        domain: `spec${i}.example.com`,
        ...(i === 0 ? { url: `https://spec${i}.example.com/docs` } : {}), // only spec0 has url
      }));
      // 5 truly unlistable records (missing name) — more than the 3-example cap.
      for (let i = 0; i < 5; i++) {
        data.push({ id: `mcp/broken${i}`, slug: `broken${i}`, kind: "mcp", domain: "broken.io" });
      }
      const tools = loadTools(store, { catalog: { fetchImpl: stubFetch({ version: 1, data }) } });
      const res = await call(tools[0], { action: "list" });
      expect(res.isError).toBe(false);
      const body = JSON.parse(res.text) as {
        catalog: Array<{ slug: string; url?: string }>;
        catalog_skipped: { count: number; examples: Array<{ spec_id: string }> };
      };
      expect(body.catalog).toHaveLength(6);
      expect(body.catalog[0].url).toBe("https://spec0.example.com/docs");
      expect(body.catalog[1].url).toBeUndefined();
      // Compact diagnostics: total count + up to 3 examples, never the full wall.
      expect(body.catalog_skipped.count).toBe(5);
      expect(body.catalog_skipped.examples).toHaveLength(3);
    } finally {
      cleanup();
    }
  });

  test("unreachable or malformed catalog fails closed (error result, no guesses)", async () => {
    const { store, cleanup } = freshStore();
    try {
      const tools = loadTools(store, { catalog: { fetchImpl: stubFetch({}) } });
      const noData = await call(tools[0], { action: "list" });
      expect(noData.isError).toBe(true);
      expect(noData.text).toContain("no data array");

      const failing = loadTools(store, {
        catalog: {
          fetchImpl: (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch,
        },
      });
      const unreachable = await call(failing[0], { action: "list" });
      expect(unreachable.isError).toBe(true);
      expect(unreachable.text).toContain("HTTP 503");
    } finally {
      cleanup();
    }
  });

  test("draft writes an UNREVIEWED draft into the drafts dir — never installed", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "config", "extensions", "drafts");
      const { audit, rows } = fakeAudit();
      const tools = loadTools(store, {
        audit,
        catalogDraftsDir: draftsDir,
        catalog: { fetchImpl: stubFetch() },
      });
      const res = await call(tools[0], { action: "draft", spec: "linear" });
      expect(res.isError).toBe(false);
      const body = JSON.parse(res.text) as {
        written_to: string;
        reviewed: boolean;
        binding_missing: boolean;
        note: string;
        draft: { source: { reviewed: boolean } };
      };
      expect(body.written_to).toBe(join(draftsDir, "linear.draft.json"));
      expect(body.reviewed).toBe(false);
      expect(body.binding_missing).toBe(true);
      // Catalog entries carry no MCP/CLI binding: the note must explicitly
      // instruct web_search research of the vendor's OFFICIAL server (issue #146).
      expect(body.note).toContain("NO MCP/CLI binding");
      expect(body.note).toContain("web_search");
      expect(body.note).toContain("OFFICIAL MCP server");
      expect(body.note).toContain("do NOT guess or use community URLs");
      expect(body.draft.source.reviewed).toBe(false);
      expect(existsSync(join(draftsDir, "linear.draft.json"))).toBe(true);

      const written = JSON.parse(readFileSync(join(draftsDir, "linear.draft.json"), "utf8")) as {
        extensionId: string;
        source: { reviewed: boolean };
        manifest: { id: string };
      };
      expect(written.extensionId).toBe("linear");
      expect(written.manifest.id).toBe("linear");
      expect(written.source.reviewed).toBe(false);

      // The draft lives in the drafts subdir — the registry scans only
      // top-level *.json, so the draft can never fail the boot.
      expect(existsSync(join(dir, "config", "extensions", "attio.json"))).toBe(false);
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe(ADMIN_CATALOG_BROWSER_EVENT);
      expect(rows[0].payload["action"]).toBe("draft");
      expect(rows[0].payload["spec"]).toBe("linear");
    } finally {
      cleanup();
    }
  });

  test("draft fails closed: missing or unknown spec", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "drafts");
      const tools = loadTools(store, { catalogDraftsDir: draftsDir, catalog: { fetchImpl: stubFetch() } });
      const noSpec = await call(tools[0], { action: "draft" });
      expect(noSpec.isError).toBe(true);
      expect(noSpec.text).toContain("spec");

      const unknownSpec = await call(tools[0], { action: "draft", spec: "not-in-catalog" });
      expect(unknownSpec.isError).toBe(true);
      expect(unknownSpec.text).toContain('not found');
      expect(existsSync(draftsDir)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("stack_health (issue #73)", () => {
  test("all services up via local probes → ok result with per-service evidence", async () => {
    const { store, cleanup } = freshStore();
    try {
      const { audit, rows } = fakeAudit();
      const tool = findTool(loadTools(store, { audit, health: allUpProbes() }), "stack_health");
      const res = await call(tool, {});
      expect(res.isError).toBe(false);
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(body.ok).toBe(true);
      expect(body.services.map((s) => s.service).sort()).toEqual([
        "broker",
        "executor",
        "gateway",
        "iron-proxy",
        "mem0",
      ]);
      for (const svc of body.services) {
        // The four network services answer their local probes; the
        // executor has no listening port, so it reports unknown (not down).
        if (svc.service === "executor") {
          expect(svc.status).toBe("unknown");
          expect(svc.evidence).toContain("no listening port");
        } else {
          expect(svc.status).toBe("up");
        }
        expect(svc.evidence.length).toBeGreaterThan(0);
      }
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe(ADMIN_STACK_HEALTH_EVENT);
      expect(rows[0].payload["ok"]).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a down service fails the result loudly with evidence", async () => {
    const { store, cleanup } = freshStore();
    try {
      const probes: Required<HealthProbeSeams> = {
        composePs: async () => ({ available: false }),
        httpGet: async (url) => ({ ok: url.includes("healthz"), evidence: `GET ${url} -> HTTP ${url.includes("healthz") ? 200 : 500}` }),
        tcpConnect: async (host, port) => ({ ok: true, evidence: `tcp ${host}:${port} connected` }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      const res = await call(tool, {});
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(body.ok).toBe(false);
      const mem0 = body.services.find((s) => s.service === "mem0");
      expect(mem0!.status).toBe("down");
      expect(mem0!.evidence).toContain("HTTP 500");
    } finally {
      cleanup();
    }
  });

  test("compose state wins when docker is available (running + healthy vs restarts)", async () => {
    const { store, cleanup } = freshStore();
    try {
      const composeState = new Map<string, { state: string; health: string; restartCount: number }>([
        ["broker", { state: "running", health: "healthy", restartCount: 0 }],
        ["gateway", { state: "running", health: "", restartCount: 0 }],
        ["iron-proxy", { state: "running", health: "", restartCount: 0 }],
        ["mem0", { state: "restarting", health: "", restartCount: 3 }],
        ["executor", { state: "running", health: "", restartCount: 0 }],
      ]);
      const probes: Required<HealthProbeSeams> = {
        composePs: async (service) => {
          const s = composeState.get(service)!;
          return { available: true, state: s.state, health: s.health, restartCount: s.restartCount };
        },
        httpGet: async () => ({ ok: true, evidence: "unused" }),
        tcpConnect: async () => ({ ok: true, evidence: "unused" }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      const res = await call(tool, {});
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      const byService = new Map(body.services.map((s) => [s.service, s]));
      expect(byService.get("broker")!.status).toBe("up");
      expect(byService.get("broker")!.method).toBe("compose");
      expect(byService.get("gateway")!.status).toBe("up");
      expect(byService.get("mem0")!.status).toBe("down");
      expect(byService.get("mem0")!.evidence).toContain("restarting");
      expect(byService.get("executor")!.status).toBe("up");
    } finally {
      cleanup();
    }
  });

  test("executor without docker is unknown (no listening port), never a fabricated down", async () => {
    const { store, cleanup } = freshStore();
    try {
      const tool = findTool(loadTools(store, { health: allUpProbes() }), "stack_health");
      const res = await call(tool, {});
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(body.ok).toBe(true);
      const executor = body.services.find((s) => s.service === "executor");
      expect(executor!.status).toBe("unknown");
      expect(executor!.evidence).toContain("no listening port");
    } finally {
      cleanup();
    }
  });

  test("mem0 probe target follows the org settings memory_backend.base_url", async () => {
    const { store, cleanup } = freshStore();
    try {
      store.setOrgSettings({ memory_backend: { base_url: "http://mem0.internal:9000" } });
      const probed: string[] = [];
      const probes: Required<HealthProbeSeams> = {
        composePs: async () => ({ available: false }),
        httpGet: async (url) => {
          probed.push(url);
          return { ok: true, evidence: `GET ${url} -> HTTP 200` };
        },
        tcpConnect: async () => ({ ok: true, evidence: "tcp ok" }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      await call(tool, {});
      expect(probed.some((url) => url.startsWith("http://mem0.internal:9000"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("deploy_info (issue #73)", () => {
  test("reports image tag, commit, uptime, and config dir; audited", async () => {
    const envBackup = backupEnv();
    const { store, cleanup } = freshStore();
    try {
      process.env.BOTTEGA_IMAGE_TAG = "2026.08.16-abc1234";
      const { audit, rows } = fakeAudit();
      const tool = findTool(
        loadTools(store, {
          audit,
          gitCommit: () => "deadbeef".repeat(5),
          configDir: () => "/tmp/bottega-config",
        }),
        "deploy_info",
      );
      const res = await call(tool, {});
      expect(res.isError).toBe(false);
      const body = JSON.parse(res.text) as { image_tag: string; commit: string; uptime_seconds: number; config_dir: string };
      expect(body.image_tag).toBe("2026.08.16-abc1234");
      expect(body.commit).toBe("deadbeef".repeat(5));
      expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
      expect(body.config_dir).toBe("/tmp/bottega-config");
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe(ADMIN_DEPLOY_INFO_EVENT);
      expect(rows[0].payload["image_tag"]).toBe("2026.08.16-abc1234");
    } finally {
      restoreEnv(envBackup);
      cleanup();
    }
  });

  test("unset image tag and unresolvable commit report null, not a guess", async () => {
    const envBackup = backupEnv();
    const { store, cleanup } = freshStore();
    try {
      delete process.env.BOTTEGA_IMAGE_TAG;
      const tool = findTool(loadTools(store, { gitCommit: () => null }), "deploy_info");
      const res = await call(tool, {});
      const body = JSON.parse(res.text) as { image_tag: string | null; commit: string | null };
      expect(body.image_tag).toBeNull();
      expect(body.commit).toBeNull();
    } finally {
      restoreEnv(envBackup);
      cleanup();
    }
  });
});

describe("first_run_wizard (issue #73)", () => {
  test("a bare deployment fails every check with a fix instruction", async () => {
    const envBackup = backupEnv();
    const { store, dir, cleanup } = freshStore();
    try {
      for (const key of ENV_KEYS) delete process.env[key];
      const tool = findTool(
        loadTools(store, {
          gitTokenFile: join(dir, "data", "secrets", "github-pat"),
          egressConfigPath: join(dir, "egress.yml"),
        }),
        "first_run_wizard",
      );
      const res = await call(tool, {});
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.text) as {
        ok: boolean;
        passed: number;
        total: number;
        checks: Array<{ name: string; ok: boolean; fix: string }>;
      };
      expect(body.ok).toBe(false);
      expect(body.total).toBe(6);
      expect(body.passed).toBe(1); // memory: SQLite fallback always passes
      const byName = new Map(body.checks.map((c) => [c.name, c]));
      expect(byName.get("slack_tokens")!.ok).toBe(false);
      expect(byName.get("slack_tokens")!.fix).toContain("slack-app-manifest.yml");
      expect(byName.get("model_key")!.ok).toBe(false);
      expect(byName.get("broker_token")!.ok).toBe(false);
      expect(byName.get("broker_token")!.fix).toContain("auth-broker");
      expect(byName.get("git_pat")!.ok).toBe(false);
      expect(byName.get("git_pat")!.fix).toContain("install -m 0600");
      expect(byName.get("egress_allowlist")!.ok).toBe(false);
      expect(byName.get("egress_allowlist")!.fix).toContain("generate.ts");
      expect(byName.get("memory_backend")!.ok).toBe(true);
    } finally {
      restoreEnv(envBackup);
      cleanup();
    }
  });

  test("a configured deployment passes every check", async () => {
    const envBackup = backupEnv();
    const { store, dir, cleanup } = freshStore();
    try {
      process.env.SLACK_APP_TOKEN = "xapp-1-real";
      process.env.SLACK_BOT_TOKEN = "xoxb-real";
      process.env.OPENCODE_API_KEY = "sk-real";
      process.env.OMP_AUTH_BROKER_TOKEN = "bt-real";
      process.env.OMP_AUTH_BROKER_URL = "http://auth-broker:8765";
      const dataDir = join(dir, "data", "secrets");
      mkdirSync(dataDir, { recursive: true });
      const tokenFile = join(dataDir, "github-pat");
      writeFileSync(tokenFile, "github_pat_real", { mode: 0o600 });
      const egressPath = join(dir, "egress.yml");
      writeFileSync(egressPath, 'transforms:\n  - name: allowlist\n    config:\n      domains:\n        - "cloud-api.near.ai"\n');
      const { audit, rows } = fakeAudit();
      const tool = findTool(
        loadTools(store, {
          audit,
          gitTokenFile: tokenFile,
          egressConfigPath: egressPath,
        }),
        "first_run_wizard",
      );
      const res = await call(tool, {});
      expect(res.isError).toBe(false);
      const body = JSON.parse(res.text) as { ok: boolean; passed: number; checks: Array<{ name: string; ok: boolean }> };
      expect(body.ok).toBe(true);
      expect(body.passed).toBe(6);
      for (const check of body.checks) expect(check.ok).toBe(true);
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe(ADMIN_FIRST_RUN_EVENT);
      expect(rows[0].payload["ok"]).toBe(true);
    } finally {
      restoreEnv(envBackup);
      cleanup();
    }
  });

  test("PAT file mode other than 0600 fails; allow_loose_pat opts out (local dev)", async () => {
    const envBackup = backupEnv();
    const { store, dir, cleanup } = freshStore();
    try {
      const tokenFile = join(dir, "github-pat");
      writeFileSync(tokenFile, "pat");
      chmodSync(tokenFile, 0o644); // explicit — writeFileSync mode is umask-masked (0077 here)
      const tool = findTool(loadTools(store, { gitTokenFile: tokenFile, egressConfigPath: join(dir, "missing.yml") }), "first_run_wizard");
      const res = await call(tool, {});
      const body = JSON.parse(res.text) as { checks: Array<{ name: string; ok: boolean }> };
      const pat = body.checks.find((c) => c.name === "git_pat");
      expect(pat!.ok).toBe(false);

      store.setOrgSettings({ allow_loose_pat: true });
      const loose = await call(tool, {});
      const looseBody = JSON.parse(loose.text) as { checks: Array<{ name: string; ok: boolean }> };
      expect(looseBody.checks.find((c) => c.name === "git_pat")!.ok).toBe(true);
    } finally {
      restoreEnv(envBackup);
      cleanup();
    }
  });

  test("mem0 configured via settings passes with the base_url as evidence", async () => {
    const envBackup = backupEnv();
    const { store, dir, cleanup } = freshStore();
    try {
      for (const key of ENV_KEYS) delete process.env[key];
      store.setOrgSettings({ memory_backend: { base_url: "http://mem0:8000" } });
      const tool = findTool(
        loadTools(store, {
          gitTokenFile: join(dir, "nope"),
          egressConfigPath: join(dir, "nope.yml"),
        }),
        "first_run_wizard",
      );
      const res = await call(tool, {});
      const body = JSON.parse(res.text) as { checks: Array<{ name: string; ok: boolean; detail: string }> };
      const memory = body.checks.find((c) => c.name === "memory_backend");
      expect(memory!.ok).toBe(true);
      expect(memory!.detail).toContain("http://mem0:8000");
    } finally {
      restoreEnv(envBackup);
      cleanup();
    }
  });
});

describe("runWizardChecks extraction (issue #116)", () => {
  test("the shared checks are exactly what the wizard tool surfaces (one source of truth)", async () => {
    const envBackup = backupEnv();
    const { store, dir, cleanup } = freshStore();
    try {
      for (const key of ENV_KEYS) delete process.env[key];
      const gitTokenFile = join(dir, "data", "secrets", "github-pat");
      const egressConfigPath = join(dir, "egress.yml");
      const direct = runWizardChecks(store, { gitTokenFile, egressConfigPath });
      expect(direct).toHaveLength(6);
      const tool = findTool(loadTools(store, { gitTokenFile, egressConfigPath }), "first_run_wizard");
      const res = await call(tool, {});
      const body = JSON.parse(res.text) as { checks: WizardCheck[] };
      expect(direct).toEqual(body.checks);
    } finally {
      restoreEnv(envBackup);
      cleanup();
    }
  });

  test("onboardingGuideText names the failing checks and points at the wizard", () => {
    const text = onboardingGuideText([
      { name: "model_key", ok: false, detail: "d", fix: "f" },
      { name: "git_pat", ok: false, detail: "d", fix: "f" },
    ]);
    expect(text).toContain("model_key");
    expect(text).toContain("git_pat");
    expect(text).toContain("first_run_wizard");
  });
});
