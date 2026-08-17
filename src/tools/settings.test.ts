/**
 * Settings tool tests (issue #67 Part B).
 *
 * The tool is the agent's surface for the durable org/per-space settings:
 * - set/get round trip against the real store (org + space scopes);
 * - partial merges never drop existing knobs;
 * - fail-closed sets (invalid knob → error result, NOTHING written);
 * - every successful set audits `settings.changed` with before/after;
 * - DB-first precedence: a settings blob overrides the config file floor;
 * - policy gating: write-tier + explicit deny denies;
 * - space-scope proactive knobs set/read/merge (issue #150).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createStore } from "../store/db";
import type { SecretsBackendMappingEntry } from "../store/org-settings";
import { SETTINGS_CHANGED_EVENT } from "../store/audit-events";
import { decidePolicyCall, defaultPolicy, loadOrgPolicy, resolveTier } from "../policy/config";
import type { AuditModule } from "../policy/audit";
import { settingsToolsExtension, settingsArgsSchema, settingsSetSchema, type SettingsToolsExtensionOpts } from "./settings";
import { z } from "zod";

/** Session-file ctx so the execute path can derive a space id (issue #151). */
// SAFETY: the settings tools only read ctx.sessionManager.getSessionFile(); a fake exposing just that member exercises the executed path.
const sessionCtx = { sessionManager: { getSessionFile: () => join("/tmp/sessions", "slack:C1.jsonl") } } as ExtensionContext;

/** Parsed audit payload JSON; the tests assert on the settings-trail and approval-gate keys. */
interface AuditPayload {
  before?: unknown;
  after?: unknown;
  scope?: string;
  approved?: boolean;
  tool?: string;
}

interface AuditRow {
  actor: string;
  event_type: string;
  space_id?: string | null;
  payload: AuditPayload;
}

interface FakeAudit {
  audit: Pick<AuditModule, "appendAudit">;
  rows: AuditRow[];
}

function fakeAudit(): FakeAudit {
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

/** Approver gate: every org write is approved by a human (the legit path). */
function approveGate(store: ReturnType<typeof createStore>): NonNullable<SettingsToolsExtensionOpts["gate"]> {
  return {
    loadPolicy: async () => loadOrgPolicy(store, orgFloorDir),
    router: { request: async () => ({ approved: true, approver: "U-APPROVER" }) },
  };
}

/** Denying router: org writes are never approved (the escalation path). */
function denyGate(store: ReturnType<typeof createStore>): NonNullable<SettingsToolsExtensionOpts["gate"]> {
  return {
    loadPolicy: async () => loadOrgPolicy(store, orgFloorDir),
    router: { request: async () => ({ approved: false }) },
  };
}

function loadTools(
  store: ReturnType<typeof createStore>,
  opts?: SettingsToolsExtensionOpts,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  // SAFETY: the extension factory only calls pi.registerTool; a double exposing just that member satisfies the executed path.
  const pi = { registerTool: (t: ToolDefinition) => void tools.push(t) } as ExtensionAPI;
  settingsToolsExtension(store, opts)(pi);
  return tools;
}

async function call(
  tool: ToolDefinition,
  params: z.input<typeof settingsArgsSchema>,
): Promise<{ text: string; isError: boolean }> {
  const res = await tool.execute("call-1", params, undefined, undefined, sessionCtx);
  // SAFETY: the settings tool always replies with a single text content block.
  return { text: (res.content[0] as { text: string }).text, isError: res.isError ?? false };
}

interface FreshStore {
  store: ReturnType<typeof createStore>;
  dir: string;
  cleanup(): void;
}

function freshStore(): FreshStore {
  const dir = mkdtempSync(join(tmpdir(), "bottega-settings-"));
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

/**
 * Hermetic org floor for the approver-gate tests (issue #151). The CI
 * checkout has no repo-root config.yml — it is a gitignored
 * deployment-local override — so `loadOrgPolicy(store)` would resolve the
 * fail-closed default floor (unknownAction: deny) and deny every org write
 * before the approval router is reached. Each gate loads this known floor
 * (`unknown: allow` — the dev override the tests were written against), so
 * settings_org_write routes ask-human through the router exactly as the
 * tests intend, regardless of the ambient working directory.
 */
const ORG_FLOOR_YAML = "tools:\n  unknown: allow\nresponse_mode: always\n";
let orgFloorDir: string;

beforeAll(() => {
  orgFloorDir = mkdtempSync(join(tmpdir(), "bottega-org-floor-"));
  writeFileSync(join(orgFloorDir, "config.yml"), ORG_FLOOR_YAML);
});

afterAll(() => {
  rmSync(orgFloorDir, { recursive: true, force: true });
});

describe("settings tool registration + gating (issue #67)", () => {
  test("registers the settings tool as write-tier", () => {
    const { store, cleanup } = freshStore();
    try {
      const tools = loadTools(store);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("settings");
      expect(tools[0].approval).toBe("write");
      expect(resolveTier("settings")).toBe("write");
    } finally {
      cleanup();
    }
  });

  test("policy gate: explicit deny wins, write tier allows by default", () => {
    // Unknown tools deny (fail closed) — settings is known, so the tier
    // table decides: write tier + allow action → allow (prompts only in
    // the SDK's non-yolo approval modes).
    const { decision } = decidePolicyCall({ ...defaultPolicy(), tools: { settings: "allow" } }, "settings");
    expect(decision).toBe("allow");
    const denied = decidePolicyCall({ ...defaultPolicy(), tools: { settings: "deny" } }, "settings");
    expect(denied.decision).toBe("deny");
  });
});

describe("org scope (issue #67)", () => {
  test("get with no settings returns null settings and the effective default policy", async () => {
    const { store, cleanup } = freshStore();
    try {
      const [tool] = loadTools(store);
      const res = await call(tool, { scope: "org" });
      expect(res.isError).toBe(false);
      // SAFETY: settings.ts serializes the org get response as { scope, settings, policy }; settings is null when the blob is unset.
      const body = JSON.parse(res.text) as { scope: string; settings: unknown; policy: { response_mode: string } };
      expect(body.scope).toBe("org");
      expect(body.settings).toBeNull();
      expect(body.policy.response_mode).toBe("always");
    } finally {
      cleanup();
    }
  });

  test("set merges partially over the current blob and get round-trips", async () => {
    const { store, cleanup } = freshStore();
    try {
      const [tool] = loadTools(store, { audit: fakeAudit().audit, gate: approveGate(store) });
      const set1 = await call(tool, {
        scope: "org",
        set: { response_mode: "mention", approvals: { timeout_minutes: 12 } },
      });
      expect(set1.isError).toBe(false);
      // SAFETY: settings.ts serializes the org set response as { scope, settings, policy }; the asserted knobs come from the merged OrgSettingsInput.
      const after1 = JSON.parse(set1.text) as {
        settings: { response_mode: string; approvals: { timeout_minutes: number } };
      };
      expect(after1.settings.response_mode).toBe("mention");
      expect(after1.settings.approvals.timeout_minutes).toBe(12);

      // Partial merge: a second set touches one knob and keeps the rest.
      const set2 = await call(tool, { scope: "org", set: { workspaces_dir: "/tmp/ws" } });
      expect(set2.isError).toBe(false);
      // SAFETY: settings.ts serializes the org set response as { scope, settings, policy }; the asserted knobs come from the merged OrgSettingsInput.
      const after2 = JSON.parse(set2.text) as {
        settings: { response_mode: string; approvals: { timeout_minutes: number }; workspaces_dir: string };
      };
      expect(after2.settings.response_mode).toBe("mention");
      expect(after2.settings.approvals.timeout_minutes).toBe(12);
      expect(after2.settings.workspaces_dir).toBe("/tmp/ws");

      const got = await call(tool, { scope: "org" });
      // SAFETY: settings.ts serializes the org get response as { scope, settings, policy } via orgSettingsToInput.
      const body = JSON.parse(got.text) as {
        settings: { response_mode: string; workspaces_dir: string };
        policy: { response_mode: string };
      };
      expect(body.settings.response_mode).toBe("mention");
      // Effective policy reflects the DB blob (DB-first).
      expect(body.policy.response_mode).toBe("mention");
    } finally {
      cleanup();
    }
  });

  test("onboarding.space_id sets, round-trips, and merges (issue #116)", async () => {
    const { store, cleanup } = freshStore();
    try {
      const [tool] = loadTools(store, { audit: fakeAudit().audit, gate: approveGate(store) });
      const res = await call(tool, { scope: "org", set: { onboarding: { space_id: "slack:C123" } } });
      expect(res.isError).toBe(false);
      // SAFETY: orgSettingsToInput serializes onboarding as { space_id } inside the response's settings.
      const body = JSON.parse(res.text) as { settings: { onboarding: { space_id: string } } };
      expect(body.settings.onboarding.space_id).toBe("slack:C123");
      expect(store.getOrgSettings()?.onboarding?.spaceId).toBe("slack:C123");

      // A partial set keeps the onboarding knob.
      await call(tool, { scope: "org", set: { response_mode: "mention" } });
      const got = await call(tool, { scope: "org" });
      // SAFETY: orgSettingsToInput serializes onboarding as { space_id }; a partial set keeps the knob in the blob.
      const read = JSON.parse(got.text) as {
        settings: { response_mode: string; onboarding: { space_id: string } };
      };
      expect(read.settings.response_mode).toBe("mention");
      expect(read.settings.onboarding.space_id).toBe("slack:C123");
    } finally {
      cleanup();
    }
  });

  test("secrets_backend sets, round-trips, and merges (issue #190)", async () => {
    const { store, cleanup } = freshStore();
    try {
      const [tool] = loadTools(store, { audit: fakeAudit().audit, gate: approveGate(store) });
      const res = await call(tool, {
        scope: "org",
        set: {
          secrets_backend: {
            type: "1password-connect",
            connect_url: "http://op-connect:8080",
            mapping: { "github:api-key:github": { vault: "vault-1", item: "item-1", field: "credential" } },
          },
        },
      });
      expect(res.isError).toBe(false);
      // SAFETY: orgSettingsToInput serializes secrets_backend as { type, connect_url, mapping } with SecretsBackendMappingEntry values.
      const body = JSON.parse(res.text) as {
        settings: { secrets_backend: { type: string; connect_url: string; mapping: Record<string, SecretsBackendMappingEntry> } };
      };
      expect(body.settings.secrets_backend.type).toBe("1password-connect");
      expect(body.settings.secrets_backend.connect_url).toBe("http://op-connect:8080");
      expect(store.getOrgSettings()?.secretsBackend?.mapping?.["github:api-key:github"]?.field).toBe("credential");

      // A partial set keeps the backend; switching type back to omp-broker
      // is allowed with the (now inert) Connect keys still present.
      await call(tool, { scope: "org", set: { secrets_backend: { type: "omp-broker" } } });
      const got = await call(tool, { scope: "org" });
      // SAFETY: orgSettingsToInput serializes secrets_backend as { type, connect_url, mapping }; switching type keeps the inert Connect keys.
      const read = JSON.parse(got.text) as {
        settings: { secrets_backend: { type: string; connect_url: string; mapping: Record<string, SecretsBackendMappingEntry> } };
      };
      expect(read.settings.secrets_backend.type).toBe("omp-broker");
      expect(read.settings.secrets_backend.connect_url).toBe("http://op-connect:8080");
      expect(store.getOrgSettings()?.secretsBackend?.type).toBe("omp-broker");
    } finally {
      cleanup();
    }
  });

  test("a 1password-connect backend missing connect_url or mapping fails closed and writes nothing", async () => {
    const { store, cleanup } = freshStore();
    try {
      const [tool] = loadTools(store, { audit: fakeAudit().audit, gate: approveGate(store) });
      const missingUrl = await call(tool, {
        scope: "org",
        set: { secrets_backend: { type: "1password-connect", mapping: {} } },
      });
      expect(missingUrl.isError).toBe(true);
      expect(missingUrl.text).toContain("secrets_backend.connect_url is required");
      const missingMapping = await call(tool, {
        scope: "org",
        set: { secrets_backend: { type: "1password-connect", connect_url: "http://op-connect:8080" } },
      });
      expect(missingMapping.isError).toBe(true);
      expect(missingMapping.text).toContain("secrets_backend.mapping is required");
      expect(store.getOrgSettings()).toBeNull(); // nothing written
    } finally {
      cleanup();
    }
  });

  test("invalid set fails closed and writes nothing", async () => {
    const { store, cleanup } = freshStore();
    try {
      const [tool] = loadTools(store, { audit: fakeAudit().audit, gate: approveGate(store) });
      await call(tool, { scope: "org", set: { response_mode: "mention" } });
      const bad = await call(tool, { scope: "org", set: { approvals: { timeout_minutes: 0 } } });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("timeout_minutes");
      const got = await call(tool, { scope: "org" });
      // SAFETY: the org get response carries the stored settings; the failed set wrote nothing, so approvals stays absent.
      const body = JSON.parse(got.text) as { settings: { response_mode: string; approvals?: unknown } };
      expect(body.settings.response_mode).toBe("mention");
      expect(body.settings.approvals).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("empty set object is rejected", async () => {
    const { store, cleanup } = freshStore();
    try {
      const [tool] = loadTools(store);
      const res = await call(tool, { scope: "org", set: {} });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("at least one field");
    } finally {
      cleanup();
    }
  });

  test("org scope rejects the space-only proactive knob (fail closed, nothing written)", async () => {
    const { store, cleanup } = freshStore();
    try {
      const [tool] = loadTools(store);
      const res = await call(tool, { scope: "org", set: { proactive: { standup: true } } });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("proactive");
      expect(store.getOrgSettings()).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("every successful set audits settings.changed with before/after", async () => {
    const { store, cleanup } = freshStore();
    try {
      const { audit, rows } = fakeAudit();
      const [tool] = loadTools(store, { audit, actor: "U1", gate: approveGate(store) });
      await call(tool, { scope: "org", set: { response_mode: "mention" } });
      await call(tool, { scope: "org", set: { response_mode: "request-only" } });
      // The approver gate adds policy.decision + approval.* rows; the
      // settings.changed trail is the tool's own audit contract.
      const changed = rows.filter((r) => r.event_type === SETTINGS_CHANGED_EVENT);
      expect(changed).toHaveLength(2);
      expect(changed[0].event_type).toBe(SETTINGS_CHANGED_EVENT);
      expect(changed[0].actor).toBe("U1");
      expect(changed[0].payload["before"]).toEqual({});
      expect(changed[0].payload["after"]).toEqual({ response_mode: "mention" });
      expect(changed[1].payload["before"]).toEqual({ response_mode: "mention" });
      expect(changed[1].payload["after"]).toEqual({ response_mode: "request-only" });
      // Both writes crossed the approval router (approved by a human).
      expect(rows.filter((r) => r.event_type === "approval.resolved" && r.payload["approved"] === true)).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  test("DB blob wins over the config file floor (DB-first precedence)", async () => {
    const { store, dir, cleanup } = freshStore();
    const savedDir = process.env.BOTTEGA_CONFIG_DIR;
    try {
      const configDir = join(dir, "config");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config.yml"), "response_mode: always\ntools:\n  unknown: allow\n");
      process.env.BOTTEGA_CONFIG_DIR = configDir;
      const [tool] = loadTools(store, { audit: fakeAudit().audit, gate: approveGate(store) });
      await call(tool, { scope: "org", set: { response_mode: "request-only" } });
      const got = await call(tool, { scope: "org" });
      // SAFETY: policyView serializes response_mode from the effective policy; the DB blob overrides the config floor.
      const body = JSON.parse(got.text) as { policy: { response_mode: string } };
      expect(body.policy.response_mode).toBe("request-only");
    } finally {
      if (savedDir === undefined) delete process.env.BOTTEGA_CONFIG_DIR;
      else process.env.BOTTEGA_CONFIG_DIR = savedDir;
      cleanup();
    }
  });

  test("issue #151: org-scope writes are approver-gated — a denying router blocks the escalation, nothing written", async () => {
    const { store, cleanup } = freshStore();
    try {
      const { audit, rows } = fakeAudit();
      const [tool] = loadTools(store, { audit, gate: denyGate(store) });
      // The issue's escalation: write always_approve: ["bash"] via org
      // settings — exec-tier access the floor never approved.
      const res = await call(tool, { scope: "org", set: { approvals: { always_approve: ["bash"] } } });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("approval denied");
      expect(store.getOrgSettings()).toBeNull(); // nothing written
      // The write crossed the approval router: requested and denied, under
      // the synthetic exec-tier tool name.
      expect(
        rows.some((r) => r.event_type === "approval.requested" && r.payload["tool"] === "settings_org_write"),
      ).toBe(true);
      expect(rows.some((r) => r.event_type === "approval.resolved" && r.payload["approved"] === false)).toBe(true);

      // Clearing the extension deny list via org settings is equally gated.
      const res2 = await call(tool, { scope: "org", set: { extensions: { deny: [] } } });
      expect(res2.isError).toBe(true);
      expect(res2.text).toContain("approval denied");
      expect(store.getOrgSettings()).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("issue #151: org-scope writes without a wired approval gate fail closed", async () => {
    const { store, cleanup } = freshStore();
    try {
      const [tool] = loadTools(store); // no gate → org writes must not exist
      const res = await call(tool, { scope: "org", set: { response_mode: "mention" } });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("not enabled");
      expect(store.getOrgSettings()).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("issue #151: an approved org write lands and the response surfaces the effective policy", async () => {
    const { store, cleanup } = freshStore();
    try {
      const [tool] = loadTools(store, { audit: fakeAudit().audit, gate: approveGate(store) });
      const res = await call(tool, { scope: "org", set: { response_mode: "mention" } });
      expect(res.isError).toBe(false);
      expect(store.getOrgSettings()?.responseMode).toBe("mention");
      // SAFETY: policyView serializes always_approve from the effective policy; an empty list is the tightened default.
      const body = JSON.parse(res.text) as { policy: { always_approve: string[] } };
      // The policy view includes the tightened knobs (issue #151).
      expect(body.policy.always_approve).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("space scope (issue #67)", () => {
  test("get returns the stored overlay plus the effective policy", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const [tool] = loadTools(store);
      const res = await call(tool, { scope: "space", space: "slack:C1" });
      expect(res.isError).toBe(false);
      // SAFETY: handleSpace serializes the space get response as { scope, space, overlay, policy }.
      const body = JSON.parse(res.text) as {
        scope: string;
        space: string;
        overlay: unknown;
        policy: { response_mode: string };
      };
      expect(body.scope).toBe("space");
      expect(body.space).toBe("slack:C1");
      expect(body.policy.response_mode).toBe("always");
    } finally {
      cleanup();
    }
  });

  test("set writes the overlay (tightened at read) and audits with space_id", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const { audit, rows } = fakeAudit();
      const [tool] = loadTools(store, { audit });
      const res = await call(tool, {
        scope: "space",
        space: "slack:C1",
        set: { response_mode: "mention", extensions: { deny: ["linear"] } },
      });
      expect(res.isError).toBe(false);
      // SAFETY: handleSpace serializes the set response with overlay = the updated policy_json and policy = the effective view.
      const body = JSON.parse(res.text) as {
        overlay: { response_mode: string; extensions: { deny: string[] } };
        policy: { response_mode: string };
      };
      expect(body.overlay.response_mode).toBe("mention");
      expect(body.overlay.extensions.deny).toEqual(["linear"]);
      expect(body.policy.response_mode).toBe("mention");
      expect(rows).toHaveLength(1);
      expect(rows[0].space_id).toBe("slack:C1");
      expect(rows[0].payload["scope"]).toBe("space");
      expect(rows[0].payload["after"]).toEqual({
        response_mode: "mention",
        extensions: { deny: ["linear"] },
      });
    } finally {
      cleanup();
    }
  });

  test("proactive standup/reflection knobs set, read, and merge in the overlay (issue #150)", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const { audit, rows } = fakeAudit();
      const [tool] = loadTools(store, { audit });
      const res = await call(tool, {
        scope: "space",
        space: "slack:C1",
        set: { proactive: { standup: true } },
      });
      expect(res.isError).toBe(false);
      // SAFETY: the space overlay JSON is echoed back verbatim after the merge; proactive.standup was just written.
      const body = JSON.parse(res.text) as { overlay: { proactive: { standup: boolean } } };
      expect(body.overlay.proactive).toEqual({ standup: true });

      // Partial merge: setting reflection keeps standup.
      const res2 = await call(tool, {
        scope: "space",
        space: "slack:C1",
        set: { proactive: { reflection: true } },
      });
      // SAFETY: the space overlay JSON is echoed back verbatim after the merge; reflection was merged in on top of standup.
      const body2 = JSON.parse(res2.text) as {
        overlay: { proactive: { standup: boolean; reflection: boolean } };
      };
      expect(body2.overlay.proactive).toEqual({ standup: true, reflection: true });

      expect(rows).toHaveLength(2);
      expect(rows[0].payload["scope"]).toBe("space");
      expect(rows[0].payload["after"]).toEqual({ proactive: { standup: true } });
      expect(rows[1].payload["before"]).toEqual({ proactive: { standup: true } });
      expect(rows[1].payload["after"]).toEqual({ proactive: { standup: true, reflection: true } });
    } finally {
      cleanup();
    }
  });

  test("space scope rejects org-only knobs (fail closed, nothing written)", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const [tool] = loadTools(store);
      const res = await call(tool, { scope: "space", space: "slack:C1", set: { repos: ["acme/sandbox"] } });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("cannot set 'repos'");
      const space = await store.getSpace("slack:C1");
      expect(space?.policy_json).toBe("{}");
    } finally {
      cleanup();
    }
  });

  test("missing space id fails with a clear error", async () => {
    const { store, cleanup } = freshStore();
    try {
      const [tool] = loadTools(store);
      const res = await call(tool, { scope: "space" });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("requires `space`");
    } finally {
      cleanup();
    }
  });
});

describe("settings schemas (issue #67)", () => {
  test("args schema defaults scope to org", () => {
    expect(settingsArgsSchema.parse({}).scope).toBe("org");
    expect(settingsArgsSchema.parse({ set: { response_mode: "mention" } }).set?.response_mode).toBe("mention");
  });

  test("set schema rejects malformed knob values at the tool boundary", () => {
    const parsed = settingsSetSchema.safeParse({ response_mode: "loud" });
    expect(parsed.success).toBe(false);
    const ok = settingsSetSchema.safeParse({
      memory_backend: { base_url: "http://mem0:8000" },
      allow_loose_pat: true,
      models: { effort: "high" },
    });
    expect(ok.success).toBe(true);
    const badProactive = settingsSetSchema.safeParse({ proactive: { standup: "yes" } });
    expect(badProactive.success).toBe(false);
  });

  test("secrets_backend schema accepts a well-formed Connect backend and rejects malformed ones (issue #190)", () => {
    const ok = settingsSetSchema.safeParse({
      secrets_backend: {
        type: "1password-connect",
        connect_url: "http://op-connect:8080",
        mapping: {
          "github:api-key:github": { vault: "vault-1", item: "item-1", field: "credential", type: "api_key" },
        },
      },
    });
    expect(ok.success).toBe(true);
    const ompBroker = settingsSetSchema.safeParse({ secrets_backend: { type: "omp-broker" } });
    expect(ompBroker.success).toBe(true);
    const badType = settingsSetSchema.safeParse({ secrets_backend: { type: "infisical" } });
    expect(badType.success).toBe(false);
    const badEntry = settingsSetSchema.safeParse({
      secrets_backend: { type: "1password-connect", connect_url: "http://x", mapping: { k: { vault: "v" } } },
    });
    expect(badEntry.success).toBe(false);
  });
});
