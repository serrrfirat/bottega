import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, TodoPhase, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createStore, type Store } from "../store/db";
import { MODEL_SETTINGS_CHANGED_EVENT, MODEL_SWITCHED_EVENT } from "../store/audit-events";
import { SessionModelRoleRegistry, type AgentSessionDriver, type ModelRole, type ModelRoleSwitchResult } from "../server/drivers/agent-driver";
import { createAudit } from "../policy/audit";
import { resolveModelPin, type ModelCatalogEntry } from "../models/model-pin";
import { groupModelsByProvider, modelToolsExtension, modelSettingsSchema, useModelSchema } from "./model-settings";

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

/** Fake available-model catalog (issue #192): deepseek at BOTH providers. */
const catalogFixture: ModelCatalogEntry[] = [
  { id: "gpt-sol-5.6", name: "GPT-Sol 5.6", provider: "opencode-go" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (2x usage)", provider: "opencode-go" },
  { id: "deepseek-ai/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash", provider: "near" },
];

function loadTools(
  store: Store,
  opts: { modelRoles?: SessionModelRoleRegistry; listModels?: (agentDir: string) => Promise<ModelCatalogEntry[]> } = {},
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  // SAFETY: the extension factory only calls pi.registerTool, so a double exposing just that member satisfies the executed path.
  const pi = { registerTool: (t: ToolDefinition) => void tools.push(t) } as ExtensionAPI;
  modelToolsExtension(store, {
    audit: createAudit(store),
    modelRoles: opts.modelRoles,
    listModels: opts.listModels ?? (async () => catalogFixture),
  })(pi);
  return tools;
}

function ctxFor(spaceId: string): ExtensionContext {
  // SAFETY: the tools only read ctx.sessionManager.getSessionFile(); a fake with just that member exercises the executed path.
  return {
    sessionManager: { getSessionFile: (): string | undefined => join("/tmp/sessions", `${spaceId}.jsonl`) },
  } as ExtensionContext;
}

function resultText(res: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  // SAFETY: every tool in this suite returns a single text content block.
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
  /** No todo plan (issue #228): the model tools never read it. */
  getTodoPhases(): TodoPhase[] {
    return [];
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
  test("reads the current settings (empty by default) plus the available catalog (issue #192)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    const tool = loadTools(s).find((t) => t.name === "model_settings")!;
    const res = await tool.execute("tc1", {}, undefined, undefined, ctxFor(space.id));
    expect(res.isError).not.toBe(true);
    expect(JSON.parse(resultText(res))).toEqual({ available_models: groupModelsByProvider(catalogFixture) });
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
    expect(JSON.parse(resultText(resB))).toEqual({ available_models: groupModelsByProvider(catalogFixture) });
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
    // SAFETY: the tool only reads ctx.sessionManager.getSessionFile(); null here means "no session file".
    const noCtx = { sessionManager: { getSessionFile: (): string | undefined | null => null } } as ExtensionContext;
    const res = await tool.execute("tc1", {}, undefined, undefined, noCtx);
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/space session/);
  });
});

describe("model catalog surface (issue #192)", () => {
  test("get returns the available models grouped by provider, sorted deterministically", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C9" });
    const tool = loadTools(s).find((t) => t.name === "model_settings")!;
    const res = await tool.execute("tc1", {}, undefined, undefined, ctxFor(space.id));
    expect(res.isError).not.toBe(true);
    expect(JSON.parse(resultText(res))).toEqual({ available_models: groupModelsByProvider(catalogFixture) });
    // The grouping: providers sorted, each provider's models by id — the
    // same deepseek-v4-flash id appears under BOTH providers, so the agent
    // sees where each lives.
    expect(JSON.parse(resultText(res)).available_models).toEqual([
      {
        provider: "near",
        models: [{ id: "deepseek-ai/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" }],
      },
      {
        provider: "opencode-go",
        models: [
          { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (2x usage)" },
          { id: "gpt-sol-5.6", name: "GPT-Sol 5.6" },
        ],
      },
    ]);
  });

  test("a catalog failure fails closed with a tool error instead of a partial settings read", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C10" });
    const tool = loadTools(s, { listModels: async () => Promise.reject(new Error("registry boom")) }).find(
      (t) => t.name === "model_settings",
    )!;
    const res = await tool.execute("tc1", {}, undefined, undefined, ctxFor(space.id));
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("registry boom");
  });

  test("exact provider/id and friendly provider-aware names resolve against the listed ids (#185 pin)", () => {
    // "deepseek-ai/DeepSeek-V4-Flash" — the exact id the catalog lists.
    expect(resolveModelPin("deepseek-ai/DeepSeek-V4-Flash", catalogFixture)).toEqual({
      ok: true,
      pin: { kind: "id", modelId: "deepseek-ai/DeepSeek-V4-Flash" },
    });
    // "use the near deepseek" → the NEAR provider's deepseek (never
    // opencode-go's same-named bare id).
    expect(resolveModelPin("near deepseek", catalogFixture)).toEqual({
      ok: true,
      pin: { kind: "id", modelId: "deepseek-ai/DeepSeek-V4-Flash" },
    });
    // "the near deepseek" → resolves to near's deepseek.
    expect(resolveModelPin("the near deepseek", catalogFixture)).toEqual({
      ok: true,
      pin: { kind: "id", modelId: "deepseek-ai/DeepSeek-V4-Flash" },
    });
    // The provider-UNQUALIFIED "deepseek v4" also resolves — near wins the
    // tie (issue #194): near is the WORKING provider, so an unqualified
    // deepseek name must never land on opencode-go's #78-broken model by
    // default. A tie without near still fails closed as ambiguous.
    expect(resolveModelPin("deepseek v4", catalogFixture)).toEqual({
      ok: true,
      pin: { kind: "id", modelId: "deepseek-ai/DeepSeek-V4-Flash" },
    });
    const stillAmbiguous = resolveModelPin("deepseek v4", [
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (2x usage)", provider: "opencode-go" },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "opencode-zen" },
    ]);
    expect(stillAmbiguous.ok).toBe(false);
    if (!stillAmbiguous.ok) {
      expect(stillAmbiguous.error).toContain("ambiguous");
    }
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

  test("surfaces the driver's not-supported result when the session omits setModelRole", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C8" });
    const registry = new SessionModelRoleRegistry();
    // A session WITHOUT the optional setModelRole hook: the registry still
    // reports the not-supported result through the documented channel.
    const plain: AgentSessionDriver = {
      prompt: async () => {},
      abort: async () => {},
      isStreaming: () => false,
      on: () => () => {},
      dispose: async () => {},
      getTodoPhases: () => [],
    };
    registry.set(space.id, plain);
    const tool = loadTools(s, { modelRoles: registry }).find((t) => t.name === "use_model")!;
    const res = await tool.execute("tc1", { role: "default" }, undefined, undefined, ctxFor(space.id));
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/does not support mid-session model switches/);
  });

  test("fails without a space session", async () => {
    const tool = loadTools(freshStore(), { modelRoles: new SessionModelRoleRegistry() }).find((t) => t.name === "use_model")!;
    // SAFETY: the tool only reads ctx.sessionManager.getSessionFile(); null here means "no session file".
    const noCtx = { sessionManager: { getSessionFile: (): string | undefined | null => null } } as ExtensionContext;
    const res = await tool.execute("tc1", { role: "fast" }, undefined, undefined, noCtx);
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/space session/);
  });

  test("rejects unknown roles at the schema", () => {
    expect(useModelSchema.safeParse({ role: "default" }).success).toBe(true);
    expect(useModelSchema.safeParse({ role: "turbo" }).success).toBe(false);
  });
});
