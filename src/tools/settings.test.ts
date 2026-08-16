/**
 * Settings tool tests (issue #67 Part B).
 *
 * The tool is the agent's surface for the durable org/per-space settings:
 * - set/get round trip against the real store (org + space scopes);
 * - partial merges never drop existing knobs;
 * - fail-closed sets (invalid knob → error result, NOTHING written);
 * - every successful set audits `settings.changed` with before/after;
 * - DB-first precedence: a settings blob overrides the config file floor;
 * - policy gating: write-tier + explicit deny denies.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createStore } from "../store/db";
import { SETTINGS_CHANGED_EVENT } from "../store/audit-events";
import { decidePolicyCall, defaultPolicy, resolveTier } from "../policy/config";
import type { AuditModule } from "../policy/audit";
import { settingsToolsExtension, settingsArgsSchema, settingsSetSchema } from "./settings";

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
  opts?: { audit?: Pick<AuditModule, "appendAudit">; actor?: string },
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const pi = { registerTool: (t: ToolDefinition) => void tools.push(t) } as unknown as ExtensionAPI;
  settingsToolsExtension(store, opts)(pi);
  return tools;
}

async function call(
  tool: ToolDefinition,
  params: unknown,
): Promise<{ text: string; isError: boolean }> {
  const res = await tool.execute("call-1", params, undefined, undefined, noopCtx);
  return { text: (res.content[0] as { text: string }).text, isError: res.isError ?? false };
}

function freshStore(): { store: ReturnType<typeof createStore>; dir: string; cleanup(): void } {
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
      const [tool] = loadTools(store);
      const set1 = await call(tool, {
        scope: "org",
        set: { response_mode: "mention", approvals: { timeout_minutes: 12 } },
      });
      expect(set1.isError).toBe(false);
      const after1 = JSON.parse(set1.text) as {
        settings: { response_mode: string; approvals: { timeout_minutes: number } };
      };
      expect(after1.settings.response_mode).toBe("mention");
      expect(after1.settings.approvals.timeout_minutes).toBe(12);

      // Partial merge: a second set touches one knob and keeps the rest.
      const set2 = await call(tool, { scope: "org", set: { workspaces_dir: "/tmp/ws" } });
      expect(set2.isError).toBe(false);
      const after2 = JSON.parse(set2.text) as {
        settings: { response_mode: string; approvals: { timeout_minutes: number }; workspaces_dir: string };
      };
      expect(after2.settings.response_mode).toBe("mention");
      expect(after2.settings.approvals.timeout_minutes).toBe(12);
      expect(after2.settings.workspaces_dir).toBe("/tmp/ws");

      const got = await call(tool, { scope: "org" });
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

  test("invalid set fails closed and writes nothing", async () => {
    const { store, cleanup } = freshStore();
    try {
      const [tool] = loadTools(store);
      await call(tool, { scope: "org", set: { response_mode: "mention" } });
      const bad = await call(tool, { scope: "org", set: { approvals: { timeout_minutes: 0 } } });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("timeout_minutes");
      const got = await call(tool, { scope: "org" });
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

  test("every successful set audits settings.changed with before/after", async () => {
    const { store, cleanup } = freshStore();
    try {
      const { audit, rows } = fakeAudit();
      const [tool] = loadTools(store, { audit, actor: "U1" });
      await call(tool, { scope: "org", set: { response_mode: "mention" } });
      await call(tool, { scope: "org", set: { response_mode: "request-only" } });
      expect(rows).toHaveLength(2);
      expect(rows[0].event_type).toBe(SETTINGS_CHANGED_EVENT);
      expect(rows[0].actor).toBe("U1");
      expect(rows[0].payload["before"]).toEqual({});
      expect(rows[0].payload["after"]).toEqual({ response_mode: "mention" });
      expect(rows[1].payload["before"]).toEqual({ response_mode: "mention" });
      expect(rows[1].payload["after"]).toEqual({ response_mode: "request-only" });
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
      writeFileSync(join(configDir, "config.yml"), "response_mode: always\n");
      process.env.BOTTEGA_CONFIG_DIR = configDir;
      const [tool] = loadTools(store);
      await call(tool, { scope: "org", set: { response_mode: "request-only" } });
      const got = await call(tool, { scope: "org" });
      const body = JSON.parse(got.text) as { policy: { response_mode: string } };
      expect(body.policy.response_mode).toBe("request-only");
    } finally {
      if (savedDir === undefined) delete process.env.BOTTEGA_CONFIG_DIR;
      else process.env.BOTTEGA_CONFIG_DIR = savedDir;
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
  });
});
