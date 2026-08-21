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
import { z } from "zod";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { JsonValue } from "../memory/mem0";
import { createStore } from "../store/db";
import {
  ADMIN_CATALOG_BROWSER_EVENT,
  ADMIN_DEPLOY_INFO_EVENT,
  ADMIN_FIRST_RUN_EVENT,
  ADMIN_STACK_HEALTH_EVENT,
} from "../store/audit-events";
import { decidePolicyCall, defaultPolicy, parseOrgConfigYaml, resolveTier } from "../policy/config";
import { createAudit } from "../policy/audit";
import type { AuditModule } from "../policy/audit";
import type { JsonObject } from "../extensions/manifest";
import type { ResolvedExtension } from "../extensions/registry";
import { createExtensionRegistry, parsePinnedSnapshot } from "../extensions/registry";
import { resolveExtensionSurfaces } from "../extensions/surface";
import { connectExtension, type ConnectExtensionDeps } from "../extensions/connect";
import {
  adminToolDefinitions,
  adminToolsExtension,
  defaultComposePs,
  onboardingGuideText,
  runWizardChecks,
  type AdminToolDefinition,
  type HealthProbeSeams,
  type ServiceStatus,
  type WizardCheck,
} from "./admin";

const FetchUrlSchema = z.union([
  z.string(),
  z.instanceof(URL).transform((url) => url.href),
  z.object({ url: z.string() }).transform((request) => request.url),
]);

// SAFETY: the admin tools never touch the extension context; an empty stub
// stands in for the real session context.
const noopCtx = {} as ExtensionContext;

interface AuditRow {
  actor: string;
  event_type: string;
  space_id?: string | null;
  /** Parsed audit payload: the admin.* events carry flat JSON objects. */
  payload: JsonObject;
}

function fakeAudit() {
  const rows: AuditRow[] = [];
  const audit: Pick<AuditModule, "appendAudit"> = {
    appendAudit: async (entry) => {
      // String payloads pass through; object payloads are JSON-serialized.
      const parsed = z.string().safeParse(entry.payload);
      const text = parsed.success ? parsed.data : JSON.stringify(entry.payload);
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
  // SAFETY: the extension factory only ever calls registerTool; the rest of
  // the ExtensionAPI surface is inert for registration.
  const pi = { registerTool: (t: ToolDefinition) => void tools.push(t) } as ExtensionAPI;
  adminToolsExtension(store, opts)(pi);
  return tools;
}

/** The parsed-args union the four admin tools accept (from their schemas). */
type AdminToolArgs = Parameters<AdminToolDefinition["execute"]>[1];

async function call(
  tool: ToolDefinition,
  params: AdminToolArgs,
): Promise<{ text: string; isError: boolean }> {
  const res = await tool.execute("call-1", params, undefined, undefined, noopCtx);
  // SAFETY: every admin tool returns its report as a single text content
  // block (the SDK tool-result contract), so content[0] is that block.
  return { text: (res.content[0] as { text: string }).text, isError: res.isError ?? false };
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function freshStore() {
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
  const manifest = {
    id,
    label,
    vendor: label,
    kind: "mcp" as const,
    mcp: { serverUrl: `https://mcp.${domain}/mcp`, transport: "streamable-http" as const },
    credentialSchema: { type: "oauth" as const, scopes: [] },
    domains: [domain],
    credentialTargets: [{ host: domain, pathPrefix: "/mcp" }],
    tools: [],
  };
  // SAFETY: the fixture carries every required field of the mcp manifest
  // variant plus a complete snapshot, so the assertion is structural only.
  return {
    manifest,
    snapshot: {
      schema: "bottega.extension-snapshot.v1" as const,
      extensionId: id,
      pinnedAt: "2026-08-16T00:00:00.000Z",
      source: { catalog: "https://integrations.sh/api.json", specId: id, vendorOfficial: true, reviewed },
      manifest,
    },
  } as ResolvedExtension;
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

/** Catalog document the stub serves — malformed docs exercise the fail-closed paths. */
interface StubCatalogDoc {
  version: number;
  data?: unknown[];
}

/** A valid MCP initialize result the endpoint doubles serve (issue #286). */
const INITIALIZE_RESULT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-11-25",
    capabilities: { tools: {} },
    serverInfo: { name: "stub-mcp", version: "1.0.0" },
  },
});

/** One URL (or prefix) → a scripted response for the endpoint doubles. */
interface StubRoute {
  match: string;
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** The endpoint doubles the pin tests rely on by default (the draft bindings
 * the completed-draft fixtures pin). Explicit routes passed by a test win. */
const DEFAULT_STUB_ROUTES: StubRoute[] = [
  {
    match: "https://mcp.linear.app/mcp",
    status: 200,
    body: INITIALIZE_RESULT,
    headers: { "content-type": "application/json" },
  },
  {
    match: "https://mcp.notion.com/mcp",
    status: 200,
    body: INITIALIZE_RESULT,
    headers: { "content-type": "application/json" },
  },
];

function stubFetch(catalog: StubCatalogDoc = CATALOG, routes: StubRoute[] = []): typeof fetch {
  const allRoutes = [...routes, ...DEFAULT_STUB_ROUTES];
  // SAFETY: the stub implements fetch's call contract (input, init?) => Promise<Response>;
  // Bun's fetch also exposes fetch.preconnect, which the catalog client never calls.
  return (async (input: string | URL | Request, _init?: RequestInit) => {
    const url = FetchUrlSchema.parse(input);
    if (url === "https://integrations.sh/api.json") {
      return new Response(JSON.stringify(catalog), { status: 200 });
    }
    const exact = allRoutes.find((r) => r.match === url);
    const route =
      exact ?? allRoutes.filter((r) => url.startsWith(r.match)).sort((a, b) => b.match.length - a.match.length)[0];
    if (route !== undefined) {
      return new Response(route.body ?? "", { status: route.status, headers: route.headers });
    }
    return new Response(JSON.stringify(catalog), { status: 200 });
  }) as typeof fetch;
}

/**
 * A COMPLETED linear draft file in `draftsDir` (the maintainer-completed /
 * in-file form: binding + credentialSchema already filled). The catalog
 * scaffold produced by the `draft` action never carries a binding — the
 * pin tests use this to exercise the completed paths.
 */
function writeCompletedDraft(draftsDir: string, overrides: Record<string, JsonValue> = {}): void {
  const draft = {
    schema: "bottega.extension-snapshot.v1",
    extensionId: "linear",
    pinnedAt: "2026-08-16T00:00:00.000Z",
    source: { catalog: "https://integrations.sh/api.json", specId: "linear", vendorOfficial: false, reviewed: false },
    manifest: {
      id: "linear",
      label: "Linear",
      vendor: "Linear",
      kind: "mcp",
      mcp: { serverUrl: "https://mcp.linear.app/mcp", transport: "streamable-http" },
      credentialSchema: { type: "oauth", scopes: ["read", "write"] },
      domains: ["linear.app"],
      credentialTargets: [{ host: "linear.app", pathPrefix: "/mcp" }],
    },
    ...overrides,
  };
  mkdirSync(draftsDir, { recursive: true });
  writeFileSync(join(draftsDir, "linear.draft.json"), JSON.stringify(draft, null, 2) + "\n");
}

/** The gmailDraft helper's domain contract used by the pin action. */
interface GmailDraft {
  schema: string;
  extensionId: string;
  pinnedAt: string;
  source: Record<string, JsonValue>;
  manifest: {
    id: string;
    label: string;
    vendor: string;
    kind: string;
    mcp: { serverUrl: string; transport: string };
    credentialSchema: { type: string; scopes?: string[] };
    domains: string[];
    credentialTargets: Array<{ host: string; pathPrefix?: string }>;
  };
}

/**
 * A gmail-googleapis-com draft carrying the REVIEWED official /mcp/v1
 * binding (issue #286 §7) — the exact override the corrected snapshot
 * pins. The catalog record only links documentation; the endpoint is a
 * human-reviewed fact, never derived.
 */
function gmailDraft(overrides: Partial<GmailDraft> = {}): GmailDraft {
  return {
    schema: "bottega.extension-snapshot.v1",
    extensionId: "gmail-googleapis-com",
    pinnedAt: "2026-08-20T00:00:00.000Z",
    source: { catalog: "https://integrations.sh/api.json", specId: "gmail-googleapis-com", vendorOfficial: false, reviewed: false },
    manifest: {
      id: "gmail-googleapis-com",
      label: "Gmail",
      vendor: "Google",
      kind: "mcp",
      mcp: { serverUrl: "https://gmailmcp.googleapis.com/mcp/v1", transport: "streamable-http" },
      credentialSchema: { type: "oauth", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
      domains: ["gmail.googleapis.com", "gmailmcp.googleapis.com"],
      credentialTargets: [{ host: "gmailmcp.googleapis.com", pathPrefix: "/mcp/v1" }],
    },
    ...overrides,
  };
}

/** Writes a draft JSON to `draftsDir/<spec>.draft.json` (the pin action's file contract). */
function writeDraft(draftsDir: string, spec: string, draft: GmailDraft): void {
  mkdirSync(draftsDir, { recursive: true });
  writeFileSync(join(draftsDir, `${spec}.draft.json`), JSON.stringify(draft, null, 2) + "\n");
}

/** The catalog doc the gmail pin's provenance re-check needs (issue #286 §7). */
const GMAIL_CATALOG: StubCatalogDoc = {
  version: 1,
  data: [
    {
      id: "mcp/gmail-googleapis-com",
      slug: "gmail-googleapis-com",
      kind: "mcp",
      name: "Gmail",
      url: "https://developers.google.com/gmail/api",
      domain: "gmail.googleapis.com",
    },
  ],
};

/** A personal-scope connect never crosses the policy gate — this seam is never invoked. */
function minimalConnectGate(): ConnectExtensionDeps["gate"] {
  return {
    loadPolicy: () => Promise.resolve(parseOrgConfigYaml("")),
    router: { request: async () => ({ approved: false }) },
  };
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
  "BOTTEGA_PROXY_CONTROL_URL",
  "BOTTEGA_PROXY_CONTROL_TOKEN",
  "BOTTEGA_PROXY_SECRETS_DIR",
  // Issue #271: the OAuth callback chain env — stack_health probes these.
  "BOTTEGA_CALLBACK_PORT",
  "BOTTEGA_OAUTH_CALLBACK_BASE_URL",
  "BOTTEGA_PUBLIC_BASE_URL_FILE",
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
    // Issue #271: the OAuth callback chain — hermetic fakes so no real
    // listener/tunnel is probed, whatever the ambient env/file says.
    callbackListener: async (port) => ({ ok: true, evidence: `tcp 127.0.0.1:${port} connected; GET /oauth/callback -> HTTP 400` }),
    publicBase: async (base) => ({ ok: true, evidence: `GET ${base} -> HTTP 404` }),
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
      const registry = createExtensionRegistry();
      for (const entry of [pinnedEntry("linear", "Linear", "linear.app"), pinnedEntry("attio", "Attio CRM", "mcp.attio.com")]) {
        registry.register(entry.manifest, entry.snapshot);
      }
      const tools = loadTools(store, {
        audit,
        registry,
        catalog: { fetchImpl: stubFetch() },
      });
      const [tool] = tools;
      const res = await call(tool, { action: "list", query: "linear" });
      expect(res.isError).toBe(false);
      // SAFETY: catalog_browser list serializes its result as JSON with
      // pinned/catalog/catalog_truncated (the exact shape asserted below).
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
      // SAFETY: the list result's pinned/catalog arrays are JSON (lengths asserted below).
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
      // SAFETY: the capped list result carries catalog + catalog_truncated (asserted below).
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
        ...(i === 0 ? { url: `https://spec${i}.example.com/docs` } : undefined), // only spec0 has url
      }));
      // 5 truly unlistable records (missing name) — more than the 3-example cap.
      for (let i = 0; i < 5; i++) {
        data.push({ id: `mcp/broken${i}`, slug: `broken${i}`, kind: "mcp", domain: "broken.io" });
      }
      const tools = loadTools(store, { catalog: { fetchImpl: stubFetch({ version: 1, data }) } });
      const res = await call(tools[0], { action: "list" });
      expect(res.isError).toBe(false);
      // SAFETY: the tolerant list result carries catalog + catalog_skipped (asserted below).
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
      const tools = loadTools(store, { catalog: { fetchImpl: stubFetch({ version: 1 }) } });
      const noData = await call(tools[0], { action: "list" });
      expect(noData.isError).toBe(true);
      expect(noData.text).toContain("no data array");

      // SAFETY: the failing stub implements fetch's call contract
      // (input, init?) => Promise<Response> — only the status differs.
      const failing = loadTools(store, {
        catalog: {
          fetchImpl: (async (_input: string | URL | Request, _init?: RequestInit) =>
            new Response("boom", { status: 503 })) as typeof fetch,
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
      // SAFETY: draft serializes its result as JSON with written_to/reviewed/
      // binding_missing/note/draft (the exact shape asserted below).
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

      // SAFETY: the draft file is this test's own writeCompletedDraft
      // serialization — JSON with extensionId/source/manifest (asserted below).
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

describe("catalog_browser pin (issue #195)", () => {
  test("pin surfaces the draft summary and refuses without the human confirmation (review gate)", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      writeCompletedDraft(draftsDir);
      const tools = loadTools(store, {
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        // the provenance re-check (pinSnapshotDraft) needs the linear entry
        catalog: { fetchImpl: stubFetch() },
      });
      const res = await call(tools[0], { action: "pin", spec: "linear" });
      expect(res.isError).toBe(true);
      // SAFETY: the review-gated pin serializes confirm_required/hosted_variant/
      // summary/note (the exact shape asserted below).
      const body = JSON.parse(res.text) as {
        confirm_required: boolean;
        hosted_variant: boolean;
        summary: { id: string; binding: Record<string, JsonValue>; credential_schema: Record<string, JsonValue> };
        note: string;
      };
      expect(body.confirm_required).toBe(true);
      expect(body.hosted_variant).toBe(true);
      expect(body.summary.id).toBe("linear");
      expect(body.summary.binding).toEqual({ serverUrl: "https://mcp.linear.app/mcp", transport: "streamable-http" });
      expect(body.summary.credential_schema).toEqual({ type: "oauth", scopes: ["read", "write"] });
      expect(body.note).toContain("REVIEW REQUIRED");
      // fail closed: nothing was pinned, nothing regenerated
      expect(existsSync(join(snapshotsDir, "linear.json"))).toBe(false);
      expect(existsSync(join(dir, "egress.yml"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("pin with the human confirmation completes a review-gated draft: snapshot written + egress regenerated", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      const egressPath = join(dir, "egress.yml");
      const devEgressPath = join(dir, "egress.dev.yml");
      // community + unreviewed in the file — the confirmation IS the review
      writeCompletedDraft(draftsDir);
      const { audit, rows } = fakeAudit();
      const tools = loadTools(store, {
        audit,
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        egressConfigPath: egressPath,
        devEgressConfigPath: devEgressPath,
        catalog: { fetchImpl: stubFetch() },
      });
      const res = await call(tools[0], { action: "pin", spec: "linear", confirm: true, vendor_official: true });
      expect(res.isError).toBe(false);
      // SAFETY: a completed pin serializes written_to/reviewed/egress_regenerated (asserted below).
      const body = JSON.parse(res.text) as { written_to: string; reviewed: boolean; egress_regenerated: string[] };
      expect(body.written_to).toBe(join(snapshotsDir, "linear.json"));
      expect(body.reviewed).toBe(true);
      expect(body.egress_regenerated).toContain(egressPath);

      const snapshot = parsePinnedSnapshot(readFileSync(join(snapshotsDir, "linear.json"), "utf8"));
      expect(snapshot.source.reviewed).toBe(true);
      expect(snapshot.source.vendorOfficial).toBe(true);
      expect(snapshot.manifest.mcp).toEqual({ serverUrl: "https://mcp.linear.app/mcp", transport: "streamable-http" });
      // the binding host was merged into the egress allowlist domains
      expect(snapshot.manifest.domains).toEqual(["linear.app", "mcp.linear.app"]);

      const egress = readFileSync(egressPath, "utf8");
      expect(egress).toContain('"mcp.linear.app"');
      expect(existsSync(devEgressPath)).toBe(true);
      expect(readFileSync(devEgressPath, "utf8")).toContain('"*"');

      // the pinned dir seeds a registry that resolves the provider
      const registry = createExtensionRegistry(snapshotsDir);
      expect(registry.resolve("linear")?.manifest.id).toBe("linear");

      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe(ADMIN_CATALOG_BROWSER_EVENT);
      expect(rows[0].payload["action"]).toBe("pin");
      expect(rows[0].payload["written_to"]).toBe(join(snapshotsDir, "linear.json"));
      expect(rows[0].payload["hosted_variant"]).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("pin refuses a stdio/CLI binding unless the agent verified no hosted variant (policy #195)", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      const egressPath = join(dir, "egress.yml");
      const devEgressPath = join(dir, "egress.dev.yml");
      writeCompletedDraft(draftsDir, {
        manifest: {
          id: "linear",
          label: "Linear",
          vendor: "Linear",
          kind: "mcp",
          mcp: { command: "linear-mcp", transport: "stdio" },
          credentialSchema: { type: "api_key" },
          domains: ["linear.app"],
          credentialTargets: [{ host: "linear.app" }],
        },
      });
      const tools = loadTools(store, {
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        egressConfigPath: egressPath,
        devEgressConfigPath: devEgressPath,
        catalog: { fetchImpl: stubFetch() },
      });
      const refused = await call(tools[0], { action: "pin", spec: "linear", confirm: true });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("NOT an official hosted streamable-http MCP");
      expect(refused.text).toContain("no_hosted_variant: true");
      expect(existsSync(join(snapshotsDir, "linear.json"))).toBe(false);

      const pinned = await call(tools[0], { action: "pin", spec: "linear", confirm: true, no_hosted_variant: true });
      expect(pinned.isError).toBe(false);
      const snapshot = parsePinnedSnapshot(readFileSync(join(snapshotsDir, "linear.json"), "utf8"));
      expect(snapshot.manifest.mcp).toEqual({ command: "linear-mcp", transport: "stdio" });
      expect(snapshot.manifest.credentialSchema).toEqual({ type: "api_key" });
      // a stdio binding has no remote host — domains stay the scaffold's
      expect(snapshot.manifest.domains).toEqual(["linear.app"]);
    } finally {
      cleanup();
    }
  });

  test("pin fails closed: missing spec, unknown draft, incomplete binding", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      const tools = loadTools(store, {
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        catalog: { fetchImpl: stubFetch() },
      });

      const noSpec = await call(tools[0], { action: "pin" });
      expect(noSpec.isError).toBe(true);
      expect(noSpec.text).toContain("spec");

      const unknown = await call(tools[0], { action: "pin", spec: "ghost" });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain("no draft");

      // the catalog scaffold draft has no binding — pin must refuse it as incomplete
      const drafted = await call(tools[0], { action: "draft", spec: "linear" });
      expect(drafted.isError).toBe(false);
      const incomplete = await call(tools[0], { action: "pin", spec: "linear", confirm: true });
      expect(incomplete.isError).toBe(true);
      expect(incomplete.text).toContain("incomplete");
      expect(existsSync(join(snapshotsDir, "linear.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("full chat flow: draft → confirm → pin → start connect as me (hosted OAuth, temp dirs)", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      const egressPath = join(dir, "egress.yml");
      const devEgressPath = join(dir, "egress.dev.yml");
      const notionCatalog = {
        version: 1,
        data: [
          ...CATALOG.data,
          {
            id: "mcp/notion",
            slug: "notion",
            kind: "mcp",
            name: "Notion",
            url: "https://developers.notion.com/reference/mcp",
            domain: "notion.com",
          },
        ],
      };
      const tools = loadTools(store, {
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        egressConfigPath: egressPath,
        devEgressConfigPath: devEgressPath,
        catalog: { fetchImpl: stubFetch(notionCatalog) },
      });
      const [tool] = tools;

      // 1. draft (the agent finds the official hosted MCP per #146)
      const drafted = await call(tool, { action: "draft", spec: "notion" });
      expect(drafted.isError).toBe(false);
      expect(existsSync(join(draftsDir, "notion.draft.json"))).toBe(true);

      // 2. pin with the completed binding, NO confirm → review gate refuses
      const refused = await call(tool, {
        action: "pin",
        spec: "notion",
        binding: { serverUrl: "https://mcp.notion.com/mcp", transport: "streamable-http" },
        credential_schema: { type: "oauth", scopes: ["read", "write"] },
        vendor_official: true,
      });
      expect(refused.isError).toBe(true);
      // SAFETY: the refused pin serializes the same review-gate summary shape (asserted below).
      const refusedBody = JSON.parse(refused.text) as {
        confirm_required: boolean;
        hosted_variant: boolean;
        summary: { id: string; binding: Record<string, JsonValue>; credential_schema: Record<string, JsonValue> };
      };
      expect(refusedBody.confirm_required).toBe(true);
      expect(refusedBody.hosted_variant).toBe(true);
      expect(refusedBody.summary.id).toBe("notion");
      expect(refusedBody.summary.binding).toEqual({ serverUrl: "https://mcp.notion.com/mcp", transport: "streamable-http" });
      expect(refusedBody.summary.credential_schema).toEqual({ type: "oauth", scopes: ["read", "write"] });
      expect(existsSync(join(snapshotsDir, "notion.json"))).toBe(false);

      // 3. the human confirms in-channel → pin completes
      const pinned = await call(tool, {
        action: "pin",
        spec: "notion",
        confirm: true,
        binding: { serverUrl: "https://mcp.notion.com/mcp", transport: "streamable-http" },
        credential_schema: { type: "oauth", scopes: ["read", "write"] },
        vendor_official: true,
      });
      expect(pinned.isError).toBe(false);
      // SAFETY: the completed notion pin serializes written_to/reviewed/note (asserted below).
      const pinnedBody = JSON.parse(pinned.text) as { written_to: string; reviewed: boolean; note: string };
      expect(pinnedBody.written_to).toBe(join(snapshotsDir, "notion.json"));
      expect(pinnedBody.reviewed).toBe(true);
      expect(pinnedBody.note).toContain("connect_extension");

      const snapshot = parsePinnedSnapshot(readFileSync(join(snapshotsDir, "notion.json"), "utf8"));
      expect(snapshot.extensionId).toBe("notion");
      expect(snapshot.source.reviewed).toBe(true);
      expect(snapshot.source.vendorOfficial).toBe(true);
      expect(snapshot.manifest.mcp).toEqual({ serverUrl: "https://mcp.notion.com/mcp", transport: "streamable-http" });
      expect(snapshot.manifest.credentialSchema).toEqual({ type: "oauth", scopes: ["read", "write"] });
      expect(snapshot.manifest.domains).toEqual(["notion.com", "mcp.notion.com"]);

      // egress regenerated with the hosted MCP host allowlisted
      const egress = readFileSync(egressPath, "utf8");
      expect(egress).toContain('"mcp.notion.com"');
      expect(egress).toContain('"notion.com"');
      expect(existsSync(devEgressPath)).toBe(true);

      // 4. connect as me against the temp snapshots dir. Hosted OAuth starts
      // the browser flow; the callback records the credential after consent.
      const oauthStarts: Array<{
        extension: string;
        provider: string;
        label: string;
        scope: string;
        actor: string;
        spaceId?: string;
      }> = [];
      const outcome = await connectExtension(
        { extension: "notion", scope: "personal", actor: "UADA" },
        {
          registry: createExtensionRegistry(snapshotsDir),
          store,
          audit: createAudit(store),
          broker: async () => {
            throw new Error("hosted OAuth must not use the broker login path");
          },
          mcpOAuth: {
            start: async (input) => {
              oauthStarts.push(input);
              return {
                ok: true,
                authorizationUrl: "https://auth.example/authorize?state=notion-test",
                message: "Open this link to authorize Notion",
              };
            },
            probeCallbackBase: async () => ({ ok: true, base: "https://callback.example" }),
          },
          gate: minimalConnectGate(),
        },
      );
      expect(outcome).toEqual({
        ok: true,
        credential: null,
        message: "Open this link to authorize Notion",
      });
      expect(oauthStarts).toEqual([
        {
          extension: "notion",
          provider: "notion",
          label: "Notion",
          scope: "personal",
          actor: "UADA",
          spaceId: undefined,
        },
      ]);
      expect(await store.listExtensionCredentials("notion")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("pin with a legacy token_endpoint param is REFUSED — the record no longer carries one (issue #284)", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      const egressPath = join(dir, "egress.yml");
      const devEgressPath = join(dir, "egress.dev.yml");
      writeCompletedDraft(draftsDir);
      const { audit, rows } = fakeAudit();
      const tools = loadTools(store, {
        audit,
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        egressConfigPath: egressPath,
        devEgressConfigPath: devEgressPath,
        catalog: { fetchImpl: stubFetch() },
      });

      // Issue #284: the OAuth token endpoint is gone from the record (the
      // SDK owns OAuth via its own RFC 8414 discovery; the egress proxy
      // never mints). The tool contract no longer carries `token_endpoint`
      // (zod strips unknown params), and the pinned snapshot is
      // endpoint-free — no mint machinery anywhere in the regenerated
      // egress.
      const pinned = await call(tools[0], {
        action: "pin",
        spec: "linear",
        confirm: true,
        vendor_official: true,
        token_endpoint: "https://mcp.linear.app/record-token",
      });
      expect(pinned.isError).toBe(false);
      const snapshot = parsePinnedSnapshot(readFileSync(join(snapshotsDir, "linear.json"), "utf8"));
      expect(snapshot.manifest.kind).toBe("mcp");
      if (snapshot.manifest.kind !== "mcp") throw new Error("expected an mcp manifest");
      expect("tokenEndpoint" in snapshot.manifest.mcp).toBe(false);
      const egress = readFileSync(egressPath, "utf8");
      expect(egress).toContain("mcp.linear.app");
      expect(egress).not.toContain("token_endpoint:");
      expect(egress).not.toContain("linear-oauth.json");
      expect(egress).not.toContain("- name: oauth_token");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload["token_endpoint"]).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("an OAuth pin regenerates egress with the domain allowlisted and NO oauth_token transform (issue #284)", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      const egressPath = join(dir, "egress.yml");
      const devEgressPath = join(dir, "egress.dev.yml");
      writeCompletedDraft(draftsDir);
      const { audit, rows } = fakeAudit();
      const tools = loadTools(store, {
        audit,
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        egressConfigPath: egressPath,
        devEgressConfigPath: devEgressPath,
        catalog: { fetchImpl: stubFetch() },
      });

      const pinned = await call(tools[0], {
        action: "pin",
        spec: "linear",
        confirm: true,
        vendor_official: true,
      });
      expect(pinned.isError).toBe(false);
      // The pinned snapshot's mcp binding carries NO token endpoint.
      const snapshot = parsePinnedSnapshot(readFileSync(join(snapshotsDir, "linear.json"), "utf8"));
      expect(snapshot.manifest.kind).toBe("mcp");
      if (snapshot.manifest.kind !== "mcp") throw new Error("expected an mcp manifest");
      expect("tokenEndpoint" in snapshot.manifest.mcp).toBe(false);
      // The regenerated egress allowlists the binding host with NO mint
      // machinery (the SDK sends its own bearer).
      const egress = readFileSync(egressPath, "utf8");
      expect(egress).toContain("mcp.linear.app");
      expect(egress).not.toContain("token_endpoint:");
      expect(egress).not.toContain("linear-oauth.json");
      expect(egress).not.toContain("- name: oauth_token");
      // The audit row carries no token_endpoint either.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload["token_endpoint"]).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("pin hot-reloads: registers the snapshot into the LIVE registry — a following session's toolset includes the extension without a restart", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      const egressPath = join(dir, "egress.yml");
      const devEgressPath = join(dir, "egress.dev.yml");
      // pinned manifest tools keep the surface hermetic (no tools/list discovery)
      writeCompletedDraft(draftsDir, {
        manifest: {
          id: "linear",
          label: "Linear",
          vendor: "Linear",
          kind: "mcp",
          mcp: { serverUrl: "https://mcp.linear.app/mcp", transport: "streamable-http" },
          credentialSchema: { type: "oauth", scopes: ["read", "write"] },
          domains: ["linear.app"],
          credentialTargets: [{ host: "linear.app", pathPrefix: "/mcp" }],
          tools: [{ name: "linear_search", tier: "read", description: "Search Linear" }],
        },
      });
      // the LIVE registry the runtime resolves against (#172) — booted empty
      const registry = createExtensionRegistry();
      const tools = loadTools(store, {
        registry,
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        egressConfigPath: egressPath,
        devEgressConfigPath: devEgressPath,
        catalog: { fetchImpl: stubFetch() },
      });
      // a pre-pin session's surface has no linear (nothing registered)
      const bootSurfaces = await resolveExtensionSurfaces(registry.list());
      expect(bootSurfaces.has("linear")).toBe(false);

      const res = await call(tools[0], { action: "pin", spec: "linear", confirm: true, vendor_official: true });
      expect(res.isError).toBe(false);
      // SAFETY: the hot-reload pin result serializes live_registry/proxy_reload/note (asserted below).
      const body = JSON.parse(res.text) as { live_registry: string; proxy_reload: string; note: string };
      expect(body.live_registry).toBe("registered");
      expect(body.proxy_reload).toBe("unset");
      expect(body.note).toContain("no restart");

      // the pin registered into the LIVE registry instance
      expect(registry.resolve("linear")?.manifest.id).toBe("linear");
      expect(registry.list().map((e) => e.manifest.id)).toContain("linear");

      // a FOLLOWING session resolves its toolset from the LIVE registry
      // (session-creation path — pinned tools resolve without discovery):
      // the extension is there WITHOUT a restart
      const nextSessionSurfaces = await resolveExtensionSurfaces(registry.list());
      expect(nextSessionSurfaces.has("linear")).toBe(true);
      expect(nextSessionSurfaces.get("linear")?.map((t) => t.name)).toEqual(["linear_search"]);

      // re-pinning the same extension is idempotent: still live, no error
      const repin = await call(tools[0], { action: "pin", spec: "linear", confirm: true, vendor_official: true });
      expect(repin.isError).toBe(false);
      // SAFETY: the repin result is the same hot-reload pin shape; only live_registry is read.
      expect((JSON.parse(repin.text) as { live_registry: string }).live_registry).toBe("registered");
    } finally {
      cleanup();
    }
  });

  test("pin hot-reloads: reloads the dev proxy AFTER the egress regen (stubbed management API)", async () => {
    const { store, dir, cleanup } = freshStore();
    const env = backupEnv();
    const originalFetch = globalThis.fetch;
    try {
      process.env.BOTTEGA_PROXY_CONTROL_URL = "http://iron-proxy:9092";
      process.env.BOTTEGA_PROXY_CONTROL_TOKEN = "test-management-token";
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      const egressPath = join(dir, "egress.yml");
      const devEgressPath = join(dir, "egress.dev.yml");
      writeCompletedDraft(draftsDir);
      const reloadCalls: Array<{ url: string; method?: string; authorization?: string }> = [];
      // SAFETY: the stub implements fetch's call contract (input, init?) => Promise<Response>;
      // the pin path calls it exactly once for the /v1/reload POST (asserted below).
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: { method?: string; headers?: Record<string, string> },
      ) => {
        // the reload must fire AFTER the egress regen wrote both configs
        expect(existsSync(egressPath)).toBe(true);
        expect(existsSync(devEgressPath)).toBe(true);
        reloadCalls.push({
          url: input instanceof Request ? input.url : input.toString(),
          method: init?.method,
          authorization: init?.headers?.["Authorization"],
        });
        return new Response("ok", { status: 200 });
      }) as typeof fetch;
      const tools = loadTools(store, {
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        egressConfigPath: egressPath,
        devEgressConfigPath: devEgressPath,
        catalog: { fetchImpl: stubFetch() },
      });
      const res = await call(tools[0], { action: "pin", spec: "linear", confirm: true, vendor_official: true });
      expect(res.isError).toBe(false);
      // SAFETY: the proxy-reload pin result serializes proxy_reload/egress_regenerated (asserted below).
      const body = JSON.parse(res.text) as { proxy_reload: string; egress_regenerated: string[] };
      expect(body.proxy_reload).toBe("ok");
      expect(body.egress_regenerated).toContain(egressPath);
      expect(reloadCalls).toHaveLength(1);
      expect(reloadCalls[0]!.url).toBe("http://iron-proxy:9092/v1/reload");
      expect(reloadCalls[0]!.method).toBe("POST");
      expect(reloadCalls[0]!.authorization).toBe("Bearer test-management-token");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv(env);
      cleanup();
    }
  });

  test("pin hot-reloads fail closed: a failed proxy reload is surfaced loudly (result + audit) while the snapshot still lands", async () => {
    const { store, dir, cleanup } = freshStore();
    const env = backupEnv();
    const originalFetch = globalThis.fetch;
    try {
      process.env.BOTTEGA_PROXY_CONTROL_URL = "http://iron-proxy:9092";
      process.env.BOTTEGA_PROXY_CONTROL_TOKEN = "test-management-token";
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      const egressPath = join(dir, "egress.yml");
      const devEgressPath = join(dir, "egress.dev.yml");
      writeCompletedDraft(draftsDir);
      const { audit, rows } = fakeAudit();
      // SAFETY: the failing stub implements fetch's call contract — only the status differs.
      globalThis.fetch = (async (
        _input: string | URL | Request,
        _init?: { method?: string; headers?: Record<string, string> },
      ) => new Response("unavailable", { status: 503 })) as typeof fetch;
      const tools = loadTools(store, {
        audit,
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        egressConfigPath: egressPath,
        devEgressConfigPath: devEgressPath,
        catalog: { fetchImpl: stubFetch() },
      });
      const res = await call(tools[0], { action: "pin", spec: "linear", confirm: true, vendor_official: true });
      // loud: the pin result flags the failure (isError + explicit warning)
      expect(res.isError).toBe(true);
      expect(res.text).toContain("PROXY RELOAD FAILED");
      expect(res.text).toContain("503");
      // the snapshot still landed
      expect(existsSync(join(snapshotsDir, "linear.json"))).toBe(true);
      expect(readFileSync(egressPath, "utf8")).toContain('"mcp.linear.app"');
      // audited with the failure
      const pinRow = rows.find((r) => r.payload["action"] === "pin");
      expect(pinRow?.payload["proxy_reload"]).toBe("failed");
      expect(String(pinRow?.payload["proxy_reload_error"])).toContain("503");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv(env);
      cleanup();
    }
  });

  test("pin accepts an exact reviewed override endpoint the probe validates (Gmail /mcp/v1) and pins it verbatim (issue #286)", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      const egressPath = join(dir, "egress.yml");
      const devEgressPath = join(dir, "egress.dev.yml");
      writeDraft(draftsDir, "gmail-googleapis-com", gmailDraft());
      const { audit, rows } = fakeAudit();
      const tools = loadTools(store, {
        audit,
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        egressConfigPath: egressPath,
        devEgressConfigPath: devEgressPath,
        catalog: {
          fetchImpl: stubFetch(GMAIL_CATALOG, [
            {
              match: "https://gmailmcp.googleapis.com/mcp/v1",
              status: 200,
              body: INITIALIZE_RESULT,
              headers: { "content-type": "application/json" },
            },
          ]),
        },
      });

      const res = await call(tools[0], {
        action: "pin",
        spec: "gmail-googleapis-com",
        confirm: true,
        vendor_official: true,
      });
      expect(res.isError).toBe(false);
      // SAFETY: the completed pin serializes written_to/reviewed/egress_regenerated (asserted below).
      const body = JSON.parse(res.text) as { written_to: string; reviewed: boolean; egress_regenerated: string[] };
      expect(body.written_to).toBe(join(snapshotsDir, "gmail-googleapis-com.json"));
      expect(body.reviewed).toBe(true);
      expect(body.egress_regenerated).toContain(egressPath);

      // The pinned snapshot carries the EXACT reviewed /mcp/v1 override —
      // never a derived mcp.gmail.googleapis.com, never /mcp.
      const snapshot = parsePinnedSnapshot(readFileSync(join(snapshotsDir, "gmail-googleapis-com.json"), "utf8"));
      expect(snapshot.source.reviewed).toBe(true);
      expect(snapshot.source.vendorOfficial).toBe(true);
      expect(snapshot.source.specId).toBe("gmail-googleapis-com");
      expect(snapshot.manifest.mcp).toEqual({
        serverUrl: "https://gmailmcp.googleapis.com/mcp/v1",
        transport: "streamable-http",
      });
      expect(snapshot.manifest.credentialSchema).toEqual({
        type: "oauth",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      });
      expect(snapshot.manifest.domains).toEqual(["gmail.googleapis.com", "gmailmcp.googleapis.com"]);

      // Egress allowlists the VALIDATED binding host (OAuth — no secrets
      // entry, no mint transform; the SDK owns the bearer).
      const egress = readFileSync(egressPath, "utf8");
      expect(egress).toContain('"gmailmcp.googleapis.com"');
      expect(egress).toContain('"gmail.googleapis.com"');
      expect(egress).not.toContain("- name: oauth_token");
      expect(egress).not.toContain("gmail-oauth.json");
      expect(existsSync(devEgressPath)).toBe(true);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload["action"]).toBe("pin");
      expect(rows[0]!.payload["spec"]).toBe("gmail-googleapis-com");
    } finally {
      cleanup();
    }
  });

  test("pin REFUSES a binding endpoint that fails the probe (Gmail /mcp 404) — no snapshot, no egress, auditable (issue #286)", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      const egressPath = join(dir, "egress.yml");
      const devEgressPath = join(dir, "egress.dev.yml");
      // The broken pin: https://gmailmcp.googleapis.com/mcp (a 404).
      writeDraft(draftsDir, "gmail-googleapis-com", gmailDraft({ manifest: { ...gmailDraft().manifest, mcp: { serverUrl: "https://gmailmcp.googleapis.com/mcp", transport: "streamable-http" } } }));
      const { audit, rows } = fakeAudit();
      const tools = loadTools(store, {
        audit,
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        egressConfigPath: egressPath,
        devEgressConfigPath: devEgressPath,
        catalog: {
          fetchImpl: stubFetch(GMAIL_CATALOG, [{ match: "https://gmailmcp.googleapis.com/mcp", status: 404 }]),
        },
      });

      // The refusal fires even WITH the human's confirmation — the probe is
      // the gate that runs BEFORE the review gate.
      const res = await call(tools[0], {
        action: "pin",
        spec: "gmail-googleapis-com",
        confirm: true,
        vendor_official: true,
      });
      expect(res.isError).toBe(true);
      // §8: the refusal carries the probe evidence and the recovery step.
      expect(res.text).toContain('refusing to pin "gmail-googleapis-com"');
      expect(res.text).toContain("failed the MCP validation probe");
      expect(res.text).toContain("HTTP 404");
      expect(res.text).toContain("no snapshot was written and egress is unchanged");
      // Fail closed: nothing persisted, no egress, no hot-register.
      expect(existsSync(join(snapshotsDir, "gmail-googleapis-com.json"))).toBe(false);
      expect(existsSync(egressPath)).toBe(false);
      expect(existsSync(devEgressPath)).toBe(false);
      // The refusal is auditable (action=pin_refused with the evidence).
      const refused = rows.find((r) => r.payload["action"] === "pin_refused");
      expect(refused).toBeDefined();
      expect(refused!.payload["reason"]).toBe("mcp_validation_probe_failed");
      expect(refused!.payload["endpoint"]).toBe("https://gmailmcp.googleapis.com/mcp");
      expect(String(refused!.payload["evidence"])).toContain("HTTP 404");
    } finally {
      cleanup();
    }
  });

  test("pin REFUSES a plain-http binding endpoint (HTTPS-only) without ever probing it (issue #286)", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      const draftsDir = join(dir, "drafts");
      const snapshotsDir = join(dir, "snapshots");
      const egressPath = join(dir, "egress.yml");
      writeDraft(draftsDir, "gmail-googleapis-com", gmailDraft({ manifest: { ...gmailDraft().manifest, mcp: { serverUrl: "http://gmailmcp.googleapis.com/mcp/v1", transport: "streamable-http" } } }));
      let probed = false;
      // SAFETY: the counting stub implements fetch's call contract.
      const countingFetch = (async (input: string | URL | Request) => {
        const url = FetchUrlSchema.parse(input);
        if (url === "https://integrations.sh/api.json") {
          return new Response(JSON.stringify(GMAIL_CATALOG), { status: 200 });
        }
        probed = true;
        return new Response("", { status: 200 });
      }) as typeof fetch;
      const tools = loadTools(store, {
        catalogDraftsDir: draftsDir,
        catalogSnapshotsDir: snapshotsDir,
        egressConfigPath: egressPath,
        catalog: { fetchImpl: countingFetch },
      });

      const res = await call(tools[0], { action: "pin", spec: "gmail-googleapis-com", confirm: true });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("refusing to pin");
      expect(res.text).toContain("must be https");
      expect(probed).toBe(false); // never a byte to an unencrypted endpoint
      expect(existsSync(join(snapshotsDir, "gmail-googleapis-com.json"))).toBe(false);
      expect(existsSync(egressPath)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

/**
 * Writes an executable `docker` shim into a temp bin dir and returns helpers
 * to put it first on PATH. The shim prints the canned stdout for
 * `docker compose ps --format json <service>` regardless of args (issue #297:
 * Docker Compose v5 emits a single JSON object instead of an array).
 */
interface FakeDockerBin {
  withBin: () => void;
  restore: () => void;
  cleanup: () => void;
}

function fakeDockerBin(stdout: string): FakeDockerBin {
  const bin = mkdtempSync(join(tmpdir(), "bottega-docker-"));
  const outFile = join(bin, "out.json");
  writeFileSync(outFile, stdout);
  const docker = join(bin, "docker");
  writeFileSync(docker, `#!/bin/sh\ncat "${outFile}"\n`);
  chmodSync(docker, 0o755);
  const pathBackup = process.env.PATH;
  const withBin = () => {
    process.env.PATH = `${bin}:${pathBackup ?? ""}`;
  };
  const restore = () => {
    if (pathBackup === undefined) delete process.env.PATH;
    else process.env.PATH = pathBackup;
  };
  const cleanup = () => rmSync(bin, { recursive: true, force: true });
  return { withBin, restore, cleanup };
}

describe("stack_health (issue #73)", () => {
  test("all services up via local probes → ok result with per-service evidence", async () => {
    const { store, cleanup } = freshStore();
    const env = backupEnv();
    try {
      // Issue #271: pin the callback port so the listener row is probed
      // (fake seam → up), not honestly unknown on the ephemeral posture;
      // and point the public base at the env so the base row is probed too
      // (a worktree may have no data/public-base-url).
      process.env.BOTTEGA_CALLBACK_PORT = "18776";
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "https://tunnel-a.trycloudflare.com";
      const { audit, rows } = fakeAudit();
      const tool = findTool(loadTools(store, { audit, health: allUpProbes() }), "stack_health");
      const res = await call(tool, {});
      expect(res.isError).toBe(false);
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(body.ok).toBe(true);
      expect(body.services.map((s) => s.service).sort()).toEqual([
        "broker",
        "executor",
        "gateway",
        "iron-proxy",
        "mem0",
        // Issue #271: the OAuth callback chain rows.
        "oauth-callback-listener",
        "public-callback-base",
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
      restoreEnv(env);
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
        callbackListener: async (port) => ({ ok: true, evidence: `tcp 127.0.0.1:${port} connected; GET /oauth/callback -> HTTP 400` }),
        publicBase: async (base) => ({ ok: true, evidence: `GET ${base} -> HTTP 404` }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      const res = await call(tool, {});
      expect(res.isError).toBe(true);
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
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
        callbackListener: async (port) => ({ ok: true, evidence: `tcp 127.0.0.1:${port} connected; GET /oauth/callback -> HTTP 400` }),
        publicBase: async (base) => ({ ok: true, evidence: `GET ${base} -> HTTP 404` }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      const res = await call(tool, {});
      expect(res.isError).toBe(true);
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
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
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
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
        callbackListener: async (port) => ({ ok: true, evidence: `tcp 127.0.0.1:${port} connected; GET /oauth/callback -> HTTP 400` }),
        publicBase: async (base) => ({ ok: true, evidence: `GET ${base} -> HTTP 404` }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      await call(tool, {});
      expect(probed.some((url) => url.startsWith("http://mem0.internal:9000"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("callback listener row: up when the stable port serves the OAuth callback route (issue #271)", async () => {
    const { store, dir, cleanup } = freshStore();
    const env = backupEnv();
    try {
      process.env.BOTTEGA_CALLBACK_PORT = "18777";
      process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = join(dir, "no-public-base");
      delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      const probes: Required<HealthProbeSeams> = {
        ...allUpProbes(),
        callbackListener: async (port) => ({ ok: true, evidence: `tcp 127.0.0.1:${port} connected; GET /oauth/callback -> HTTP 400` }),
        publicBase: async (base) => ({ ok: true, evidence: `GET ${base} -> HTTP 404` }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      const res = await call(tool, {});
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(res.isError).toBe(false);
      expect(body.ok).toBe(true);
      const listener = body.services.find((s) => s.service === "oauth-callback-listener");
      expect(listener).toBeDefined();
      expect(listener!.status).toBe("up");
      expect(listener!.evidence).toContain("18777");
    } finally {
      restoreEnv(env);
      cleanup();
    }
  });

  test("callback listener row fails loudly, naming the port, when nothing listens (issue #271)", async () => {
    const { store, dir, cleanup } = freshStore();
    const env = backupEnv();
    try {
      process.env.BOTTEGA_CALLBACK_PORT = "18778";
      process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = join(dir, "no-public-base");
      delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      const probes: Required<HealthProbeSeams> = {
        ...allUpProbes(),
        callbackListener: async (port) => ({ ok: false, evidence: `tcp 127.0.0.1:${port} failed: connect ECONNREFUSED` }),
        publicBase: async (base) => ({ ok: true, evidence: `GET ${base} -> HTTP 404` }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      const res = await call(tool, {});
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(res.isError).toBe(true);
      expect(body.ok).toBe(false);
      const listener = body.services.find((s) => s.service === "oauth-callback-listener");
      expect(listener).toBeDefined();
      expect(listener!.status).toBe("down");
      expect(listener!.evidence).toContain("18778");
    } finally {
      restoreEnv(env);
      cleanup();
    }
  });

  test("callback listener row reports the ephemeral-port posture when BOTTEGA_CALLBACK_PORT is unset (issue #271)", async () => {
    const { store, dir, cleanup } = freshStore();
    const env = backupEnv();
    try {
      delete process.env.BOTTEGA_CALLBACK_PORT;
      process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = join(dir, "no-public-base");
      delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      const tool = findTool(loadTools(store, { health: allUpProbes() }), "stack_health");
      const res = await call(tool, {});
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(body.ok).toBe(true);
      const listener = body.services.find((s) => s.service === "oauth-callback-listener");
      expect(listener).toBeDefined();
      expect(listener!.status).toBe("unknown");
      expect(listener!.evidence).toContain("ephemeral");
    } finally {
      restoreEnv(env);
      cleanup();
    }
  });

  test("public callback base row: up when the tunnel base answers (issue #271)", async () => {
    const { store, dir, cleanup } = freshStore();
    const env = backupEnv();
    try {
      process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = join(dir, "no-public-base");
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "https://tunnel-a.trycloudflare.com";
      const probes: Required<HealthProbeSeams> = {
        ...allUpProbes(),
        callbackListener: async (port) => ({ ok: true, evidence: `tcp 127.0.0.1:${port} connected; GET /oauth/callback -> HTTP 400` }),
        publicBase: async (base) => ({ ok: true, evidence: `GET ${base} -> HTTP 404` }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      const res = await call(tool, {});
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(res.isError).toBe(false);
      expect(body.ok).toBe(true);
      const base = body.services.find((s) => s.service === "public-callback-base");
      expect(base).toBeDefined();
      expect(base!.status).toBe("up");
      expect(base!.evidence).toContain("tunnel-a.trycloudflare.com");
    } finally {
      restoreEnv(env);
      cleanup();
    }
  });

  test("public callback base row fails loudly when the tunnel base is dead (issue #271)", async () => {
    const { store, dir, cleanup } = freshStore();
    const env = backupEnv();
    try {
      process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = join(dir, "no-public-base");
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "https://dead.tunnel.example";
      const probes: Required<HealthProbeSeams> = {
        ...allUpProbes(),
        callbackListener: async (port) => ({ ok: true, evidence: `tcp 127.0.0.1:${port} connected; GET /oauth/callback -> HTTP 400` }),
        publicBase: async (base) => ({ ok: false, evidence: `GET ${base} -> HTTP 502` }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      const res = await call(tool, {});
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(res.isError).toBe(true);
      expect(body.ok).toBe(false);
      const base = body.services.find((s) => s.service === "public-callback-base");
      expect(base).toBeDefined();
      expect(base!.status).toBe("down");
      expect(base!.evidence).toContain("dead.tunnel.example");
    } finally {
      restoreEnv(env);
      cleanup();
    }
  });

  test("public callback base row reports the loopback-only posture when no base is configured (issue #271)", async () => {
    const { store, dir, cleanup } = freshStore();
    const env = backupEnv();
    try {
      process.env.BOTTEGA_PUBLIC_BASE_URL_FILE = join(dir, "no-public-base");
      delete process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
      const tool = findTool(loadTools(store, { health: allUpProbes() }), "stack_health");
      const res = await call(tool, {});
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(body.ok).toBe(true);
      const base = body.services.find((s) => s.service === "public-callback-base");
      expect(base).toBeDefined();
      expect(base!.status).toBe("unknown");
      expect(base!.evidence).toContain("loopback");
    } finally {
      restoreEnv(env);
      cleanup();
    }
  });

  test("absent optional services report unknown (not down, not probed) when compose is available (issue #297)", async () => {
    const { store, cleanup } = freshStore();
    const env = backupEnv();
    try {
      // Intended local dev topology (scripts/dev.sh): broker + iron-proxy
      // run; gateway and mem0 are not part of the running project.
      process.env.BOTTEGA_CALLBACK_PORT = "18780";
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "https://tunnel-a.trycloudflare.com";
      const composeState = new Map<string, { state: string; health: string; restartCount: number }>([
        ["broker", { state: "running", health: "", restartCount: 0 }],
        ["iron-proxy", { state: "running", health: "", restartCount: 0 }],
      ]);
      const probed: string[] = [];
      const probes: Required<HealthProbeSeams> = {
        composePs: async (service) => {
          const s = composeState.get(service);
          // Compose ran but the service is not in the running project.
          return s ? { available: true, state: s.state, health: s.health, restartCount: s.restartCount } : { available: true };
        },
        httpGet: async (url) => {
          probed.push(url);
          return { ok: true, evidence: `GET ${url} -> HTTP 200` };
        },
        tcpConnect: async (host, port) => {
          probed.push(`tcp:${host}:${port}`);
          return { ok: true, evidence: `tcp ${host}:${port} connected` };
        },
        callbackListener: async (port) => ({ ok: true, evidence: `tcp 127.0.0.1:${port} connected; GET /oauth/callback -> HTTP 400` }),
        publicBase: async (base) => ({ ok: true, evidence: `GET ${base} -> HTTP 404` }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      const res = await call(tool, {});
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(res.isError).toBe(false);
      expect(body.ok).toBe(true);
      const byService = new Map(body.services.map((s) => [s.service, s]));
      // Present services are up via compose.
      expect(byService.get("broker")!.status).toBe("up");
      expect(byService.get("broker")!.method).toBe("compose");
      expect(byService.get("iron-proxy")!.status).toBe("up");
      // Absent-but-optional services are honestly unknown, never down.
      expect(byService.get("gateway")!.status).toBe("unknown");
      expect(byService.get("mem0")!.status).toBe("unknown");
      // No Docker-internal HTTP/TCP fallback probes ran for absent services.
      expect(probed).toEqual([]);
    } finally {
      restoreEnv(env);
      cleanup();
    }
  });

  test("absent executor reports unknown, not down, when compose is available but it is not in the project (issue #297)", async () => {
    const { store, cleanup } = freshStore();
    const env = backupEnv();
    try {
      process.env.BOTTEGA_CALLBACK_PORT = "18781";
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "https://tunnel-a.trycloudflare.com";
      // broker + iron-proxy run; executor is NOT part of the running project.
      const composeState = new Map<string, { state: string; health: string; restartCount: number }>([
        ["broker", { state: "running", health: "", restartCount: 0 }],
        ["iron-proxy", { state: "running", health: "", restartCount: 0 }],
      ]);
      const probes: Required<HealthProbeSeams> = {
        composePs: async (service) => {
          const s = composeState.get(service);
          return s ? { available: true, state: s.state, health: s.health, restartCount: s.restartCount } : { available: true };
        },
        httpGet: async (url) => ({ ok: true, evidence: `GET ${url} -> HTTP 200` }),
        tcpConnect: async (host, port) => ({ ok: true, evidence: `tcp ${host}:${port} connected` }),
        callbackListener: async (port) => ({ ok: true, evidence: `tcp 127.0.0.1:${port} connected; GET /oauth/callback -> HTTP 400` }),
        publicBase: async (base) => ({ ok: true, evidence: `GET ${base} -> HTTP 404` }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      const res = await call(tool, {});
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(res.isError).toBe(false);
      expect(body.ok).toBe(true);
      const executor = body.services.find((s) => s.service === "executor");
      expect(executor).toBeDefined();
      expect(executor!.status).toBe("unknown");
      expect(executor!.method).toBe("compose");
      expect(executor!.evidence).toContain("not in the running project");
    } finally {
      restoreEnv(env);
      cleanup();
    }
  });

  test("overall ok in the intended dev topology: broker+iron-proxy up, optional services absent (issue #297)", async () => {
    const { store, cleanup } = freshStore();
    const env = backupEnv();
    try {
      process.env.BOTTEGA_CALLBACK_PORT = "18782";
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "https://tunnel-a.trycloudflare.com";
      const composeState = new Map<string, { state: string; health: string; restartCount: number }>([
        ["broker", { state: "running", health: "", restartCount: 0 }],
        ["iron-proxy", { state: "running", health: "", restartCount: 0 }],
      ]);
      const probes: Required<HealthProbeSeams> = {
        composePs: async (service) => {
          const s = composeState.get(service);
          return s ? { available: true, state: s.state, health: s.health, restartCount: s.restartCount } : { available: true };
        },
        httpGet: async (url) => ({ ok: true, evidence: `GET ${url} -> HTTP 200` }),
        tcpConnect: async (host, port) => ({ ok: true, evidence: `tcp ${host}:${port} connected` }),
        callbackListener: async (port) => ({ ok: true, evidence: `tcp 127.0.0.1:${port} connected; GET /oauth/callback -> HTTP 400` }),
        publicBase: async (base) => ({ ok: true, evidence: `GET ${base} -> HTTP 404` }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      const res = await call(tool, {});
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(res.isError).toBe(false);
      expect(body.ok).toBe(true);
      const byService = new Map(body.services.map((s) => [s.service, s]));
      expect(byService.get("broker")!.status).toBe("up");
      expect(byService.get("iron-proxy")!.status).toBe("up");
      expect(byService.get("gateway")!.status).toBe("unknown");
      expect(byService.get("mem0")!.status).toBe("unknown");
      expect(byService.get("executor")!.status).toBe("unknown");
    } finally {
      restoreEnv(env);
      cleanup();
    }
  });

  test("dev topology: broker absent from compose by name but reachable on its configured host URL reports up (issue #297)", async () => {
    const { store, cleanup } = freshStore();
    const env = backupEnv();
    try {
      // scripts/dev.sh starts the vault as compose service `auth-broker`, so
      // `docker compose ps --format json broker` has no row; but it exports
      // OMP_AUTH_BROKER_URL=http://127.0.0.1:8765, which IS host-reachable and
      // must report up rather than unknown/down. iron-proxy runs in compose.
      process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:8765";
      process.env.BOTTEGA_CALLBACK_PORT = "18783";
      process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL = "https://tunnel-a.trycloudflare.com";
      const composeState = new Map<string, { state: string; health: string; restartCount: number }>([
        ["iron-proxy", { state: "running", health: "", restartCount: 0 }],
      ]);
      const probed: string[] = [];
      const probes: Required<HealthProbeSeams> = {
        composePs: async (service) => {
          const s = composeState.get(service);
          return s ? { available: true, state: s.state, health: s.health, restartCount: s.restartCount } : { available: true };
        },
        httpGet: async (url) => {
          probed.push(url);
          return { ok: true, evidence: `GET ${url} -> HTTP 200` };
        },
        tcpConnect: async (host, port) => ({ ok: true, evidence: `tcp ${host}:${port} connected` }),
        callbackListener: async (port) => ({ ok: true, evidence: `tcp 127.0.0.1:${port} connected; GET /oauth/callback -> HTTP 400` }),
        publicBase: async (base) => ({ ok: true, evidence: `GET ${base} -> HTTP 404` }),
      };
      const tool = findTool(loadTools(store, { health: probes }), "stack_health");
      const res = await call(tool, {});
      // SAFETY: stack_health serializes ok + the per-service status array (asserted below).
      const body = JSON.parse(res.text) as { ok: boolean; services: ServiceStatus[] };
      expect(res.isError).toBe(false);
      expect(body.ok).toBe(true);
      const byService = new Map(body.services.map((s) => [s.service, s]));
      // broker probed its configured host URL (not a compose row, not a
      // Docker-internal name).
      expect(byService.get("broker")!.status).toBe("up");
      expect(byService.get("broker")!.method).toBe("http");
      expect(probed.some((url) => url.startsWith("http://127.0.0.1:8765"))).toBe(true);
      // iron-proxy up via compose; Docker-internal-only targets stay unknown.
      expect(byService.get("iron-proxy")!.status).toBe("up");
      expect(byService.get("gateway")!.status).toBe("unknown");
      expect(byService.get("mem0")!.status).toBe("unknown");
      expect(byService.get("executor")!.status).toBe("unknown");
      // No Docker-internal hostname was DNS-probed from the host.
      expect(probed.every((url) => !url.includes("auth-gateway") && !url.includes("auth-broker") && !url.includes(":4000"))).toBe(true);
    } finally {
      restoreEnv(env);
      cleanup();
    }
  });
});

describe("defaultComposePs (issue #297)", () => {
  test("parses a single JSON object (Docker Compose v5), not only an array", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bottega-compose-cwd-"));
    const fake = fakeDockerBin(JSON.stringify({ Service: "iron-proxy", State: "running", Health: "", RestartCount: 0 }));
    try {
      fake.withBin();
      // SAFETY: defaultComposePs parses whatever the docker shim prints.
      const result = await defaultComposePs("iron-proxy", cwd);
      expect(result.available).toBe(true);
      expect(result.state).toBe("running");
      expect(result.health).toBe("");
      expect(result.restartCount).toBe(0);
    } finally {
      fake.restore();
      fake.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("no row for a service absent from the project is available:true, no fallback state (issue #297)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bottega-compose-cwd-"));
    const fake = fakeDockerBin("[]");
    try {
      fake.withBin();
      const result = await defaultComposePs("gateway", cwd);
      expect(result.available).toBe(true);
      expect(result.state).toBeUndefined();
    } finally {
      fake.restore();
      fake.cleanup();
      rmSync(cwd, { recursive: true, force: true });
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
      // SAFETY: deploy_info serializes image_tag/commit/uptime_seconds/config_dir (asserted below).
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
      // SAFETY: with no image tag/commit the tool reports null for both (asserted below).
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
      process.env.BOTTEGA_PROXY_SECRETS_DIR = join(dir, "data", "proxy-secrets");
      const tool = findTool(
        loadTools(store, {
          gitTokenFile: join(dir, "data", "secrets", "github-pat"),
          egressConfigPath: join(dir, "egress.yml"),
        }),
        "first_run_wizard",
      );
      const res = await call(tool, {});
      expect(res.isError).toBe(true);
      // SAFETY: first_run_wizard serializes ok/passed/total/checks with fix instructions (asserted below).
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
      // Issue #201: the fixes point at the vault provisioning path too.
      expect(byName.get("slack_tokens")!.fix).toContain("connect_upload_link");
      expect(byName.get("model_key")!.ok).toBe(false);
      expect(byName.get("model_key")!.fix).toContain("auth-broker vault");
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
      const proxySecretsDir = join(dir, "data", "proxy-secrets");
      mkdirSync(proxySecretsDir, { recursive: true });
      writeFileSync(join(proxySecretsDir, "opencode.secret"), "proxy-key", { mode: 0o600 });
      process.env.BOTTEGA_PROXY_SECRETS_DIR = proxySecretsDir;
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
      // SAFETY: the passing wizard result serializes ok/passed/checks (asserted below).
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
      // SAFETY: the wizard result serializes the per-check ok flags (asserted below).
      const body = JSON.parse(res.text) as { checks: Array<{ name: string; ok: boolean }> };
      const pat = body.checks.find((c) => c.name === "git_pat");
      expect(pat!.ok).toBe(false);

      store.setOrgSettings({ allow_loose_pat: true });
      const loose = await call(tool, {});
      // SAFETY: the allow_loose_pat rerun serializes the same checks shape (asserted below).
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
      // SAFETY: the wizard result's checks carry detail evidence (asserted below).
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
      // SAFETY: the wizard tool surfaces the same checks runWizardChecks returns (asserted below).
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
