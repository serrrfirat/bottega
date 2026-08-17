import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createStore, type Store } from "../store/db";
import { MODEL_SETTINGS_CHANGED_EVENT, MODEL_SWITCHED_EVENT } from "../store/audit-events";
import { SessionModelRoleRegistry, type AgentSessionDriver, type ModelRole, type ModelRoleSwitchResult } from "../server/drivers/agent-driver";
import { createAudit } from "../policy/audit";
import { modelToolsExtension, modelSettingsSchema, useModelSchema } from "./model-settings";

const dir = mkdtempSync(join(tmpdir(), "bottega-model-tools-"));
const stores: Store[] = [];
function freshStore(): Store {
  const s = createStore(join(dir, `store-${stores.length}.db`));
  stores.push(s);
  return s;
}

afterAll(() => {
  for (const s of stores) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function loadTools(store: Store, opts: { modelRoles?: SessionModelRoleRegistry } = {}): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const pi = { registerTool: (t: ToolDefinition) => void tools.push(t) } as unknown as ExtensionAPI;
  modelToolsExtension(store, { audit: createAudit(store), modelRoles: opts.modelRoles })(pi);
  return tools;
}

function ctxFor(spaceId: string): ExtensionContext {
  return {
    sessionManager: { getSessionFile: () => join("/tmp/sessions", `${spaceId}.jsonl`) },
  } as unknown as ExtensionContext;
}

function resultText(res: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  return (res.content[0] as { text: string }).text;
}

/** A fake live session whose setModelRole records calls (the OMP driver's hook shape). */
class FakeModelSession implements AgentSessionDriver {
  readonly switched: Array<{ role: ModelRole; result: ModelRoleSwitchResult }> = [];
  async setModelRole(role: ModelRole): Promise<ModelRoleSwitchResult> {
    const result: ModelRoleSwitchResult = {
      applied: true,
      role,
      model: role === "fast" ? "fast-model" : "deep-model",
      thinking_level: role === "fast" ? "low" : "high",
    };
    this.switched.push({ role, result });
    return result;
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  isStreaming(): boolean {
    return false;
  }
  on(): () => void {
    return () => {};
  }
  async dispose(): Promise<void> {}
}

describe("model tools registration", () => {
  test("registers model_settings and use_model as write-tier tools", () => {
    const tools = loadTools(freshStore());
    expect(tools.map((t) => t.name).sort()).toEqual(["model_settings", "use_model"]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.parameters).toBeDefined();
      expect(t.approval).toBe("write");
    }
  });
});

describe("model_settings", () => {
  test("reads the current settings (empty by default)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    const tool = loadTools(s).find((t) => t.name === "model_settings")!;
    const res = await tool.execute("tc1", {}, undefined, undefined, ctxFor(space.id));
    expect(res.isError).not.toBe(true);
    expect(JSON.parse(resultText(res))).toEqual({});
  });

  test("set writes a partial update, persists per space, and audits before/after", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C2" });
    const tool = loadTools(s).find((t) => t.name === "model_settings")!;

    const res = await tool.execute(
      "tc1",
      { set: { model: "deepseek-v4-flash", reasoning_effort: "medium" } },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    expect(JSON.parse(resultText(res))).toEqual({ model: "deepseek-v4-flash", reasoning_effort: "medium" });
    // Persisted in the space's settings column — the read path returns it.
    expect(await s.getSpaceSettings(space.id)).toEqual({ model: "deepseek-v4-flash", reasoning_effort: "medium" });

    // A later set merges onto the stored settings instead of replacing them.
    const res2 = await tool.execute(
      "tc1",
      { set: { fast_model: "flash-lite" } },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res2.isError).not.toBe(true);
    expect(JSON.parse(resultText(res2))).toEqual({
      model: "deepseek-v4-flash",
      reasoning_effort: "medium",
      fast_model: "flash-lite",
    });

    const rows = await s.listAudit({ space: space.id, event_type: MODEL_SETTINGS_CHANGED_EVENT });
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      before: {},
      after: { model: "deepseek-v4-flash", reasoning_effort: "medium" },
      by: "agent",
    });
    expect(JSON.parse(rows[1]!.payload)).toEqual({
      before: { model: "deepseek-v4-flash", reasoning_effort: "medium" },
      after: { model: "deepseek-v4-flash", reasoning_effort: "medium", fast_model: "flash-lite" },
      by: "agent",
    });
  });

  test("settings are scoped per space", async () => {
    const s = freshStore();
    const a = await s.getOrCreateSpace({ platform: "slack", channel_id: "C3" });
    const b = await s.getOrCreateSpace({ platform: "slack", channel_id: "C4" });
    const tool = loadTools(s).find((t) => t.name === "model_settings")!;
    await tool.execute("tc1", { set: { model: "m-a" } }, undefined, undefined, ctxFor(a.id));
    const resB = await tool.execute("tc1", {}, undefined, undefined, ctxFor(b.id));
    expect(JSON.parse(resultText(resB))).toEqual({});
  });

  test("rejects invalid reasoning_effort values at the schema", () => {
    expect(modelSettingsSchema.safeParse({ set: { reasoning_effort: "high" } }).success).toBe(true);
    expect(modelSettingsSchema.safeParse({ set: { reasoning_effort: "ultra" } }).success).toBe(false);
    expect(modelSettingsSchema.safeParse({ set: {} }).success).toBe(true);
    expect(modelSettingsSchema.safeParse({ set: { model: "" } }).success).toBe(false);
  });

  test("an empty set object is rejected at execution", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C5" });
    const tool = loadTools(s).find((t) => t.name === "model_settings")!;
    const res = await tool.execute("tc1", { set: {} }, undefined, undefined, ctxFor(space.id));
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("at least one field");
  });

  test("set succeeds on a DM space once the row exists after first contact (issue #188)", async () => {
    const s = freshStore();
    // The inbound path upserts the space row on first contact (issue #188);
    // model_settings then resolves it instead of failing "space not found".
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "D188" });
    const tool = loadTools(s).find((t) => t.name === "model_settings")!;
    const res = await tool.execute(
      "tc1",
      { set: { model: "deepseek-v4-flash" } },
      undefined,
      undefined,
      ctxFor(space.id),
    );
    expect(res.isError).not.toBe(true);
    expect(JSON.parse(resultText(res))).toEqual({ model: "deepseek-v4-flash" });
    expect(await s.getSpaceSettings(space.id)).toEqual({ model: "deepseek-v4-flash" });
  });

  test("fails without a space session", async () => {
    const tool = loadTools(freshStore()).find((t) => t.name === "model_settings")!;
    const noCtx = { sessionManager: { getSessionFile: () => null } } as unknown as ExtensionContext;
    const res = await tool.execute("tc1", {}, undefined, undefined, noCtx);
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/space session/);
  });
});

describe("use_model", () => {
  test("switches the live session's role, returns what was applied, and audits", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C6" });
    const registry = new SessionModelRoleRegistry();
    const fake = new FakeModelSession();
    registry.set(space.id, fake);
    const tool = loadTools(s, { modelRoles: registry }).find((t) => t.name === "use_model")!;

    const res = await tool.execute("tc1", { role: "fast" }, undefined, undefined, ctxFor(space.id));
    expect(res.isError).not.toBe(true);
    expect(JSON.parse(resultText(res))).toEqual({
      applied: true,
      role: "fast",
      model: "fast-model",
      thinking_level: "low",
    });
    expect(fake.switched).toEqual([
      {
        role: "fast",
        result: { applied: true, role: "fast", model: "fast-model", thinking_level: "low" },
      },
    ]);

    const rows = await s.listAudit({ space: space.id, event_type: MODEL_SWITCHED_EVENT });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      role: "fast",
      model: "fast-model",
      thinking_level: "low",
      by: "agent",
    });
  });

  test("reports a clear error when no live session is registered", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C7" });
    const registry = new SessionModelRoleRegistry();
    const tool = loadTools(s, { modelRoles: registry }).find((t) => t.name === "use_model")!;
    const res = await tool.execute("tc1", { role: "reasoning" }, undefined, undefined, ctxFor(space.id));
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/no live agent session/);
    expect(await s.listAudit({ event_type: MODEL_SWITCHED_EVENT })).toHaveLength(0);
  });

  test("surfaces the driver's not-supported result (ACP path)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C8" });
    const registry = new SessionModelRoleRegistry();
    // A session WITHOUT the optional setModelRole hook: the registry is what
    // the ACP driver would be if it omitted the hook entirely.
    const plain = { prompt: async () => {} };
    registry.set(space.id, plain as never);
    const tool = loadTools(s, { modelRoles: registry }).find((t) => t.name === "use_model")!;
    const res = await tool.execute("tc1", { role: "default" }, undefined, undefined, ctxFor(space.id));
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/does not support mid-session model switches/);
  });

  test("fails without a space session", async () => {
    const tool = loadTools(freshStore(), { modelRoles: new SessionModelRoleRegistry() }).find((t) => t.name === "use_model")!;
    const noCtx = { sessionManager: { getSessionFile: () => null } } as unknown as ExtensionContext;
    const res = await tool.execute("tc1", { role: "fast" }, undefined, undefined, noCtx);
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/space session/);
  });

  test("rejects unknown roles at the schema", () => {
    expect(useModelSchema.safeParse({ role: "default" }).success).toBe(true);
    expect(useModelSchema.safeParse({ role: "turbo" }).success).toBe(false);
  });
});
