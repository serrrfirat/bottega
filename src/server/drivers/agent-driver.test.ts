import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentRegistry, ModelRegistry, SessionManager, createAgentSession, discoverAuthStorage, z, type CreateAgentSessionOptions, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { connectExtensionToolDefinition } from "../../extensions/connect";
import { createFixtureRegistry } from "../../extensions/fixture";
import { extensionToolDefinitions } from "../../extensions/tools";
import type { ExtensionRuntime } from "../../extensions/runtime";
import { createAudit } from "../../policy/audit";
import { DenyRouter } from "../../policy/approval-router";
import { parseOrgConfigYaml } from "../../policy/config";
import { createStore, type SpaceModelSettings } from "../../store/db";
import { POLICY_DECISION_EVENT } from "../../store/audit-events";
import {
  assertAgentDirModelAvailable,
  createOmpSdkDriver,
  OmpSessionDriver,
  opencodeSafeToolName,
  opencodeToolNameMap,
  resolveRoleTarget,
  sessionIdFromFilePath,
  SPACE_AGENT_TOOLS,
  spaceAgentToolNames,
} from "./agent-driver";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

describe("omp sdk agent driver", () => {
  test("createSession materializes the space transcript file and disposes cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const transcriptDir = join(dir, "sessions");
      const spaceFile = join(transcriptDir, "slack:C1.jsonl");
      const driver = createOmpSdkDriver({ agentDir: join(dir, "agent") });
      const session = await driver.createSession({
        spaceId: "slack:C1",
        transcriptDir,
        onOutput: () => {},
      });
      // The durable space timeline exists at the exact session-file path and
      // carries a JSONL header (non-empty) — the transcript the server restarts
      // from (see SessionManager.setSessionFile).
      expect(existsSync(spaceFile)).toBe(true);
      const header = readFileSync(spaceFile, "utf8").split("\n")[0];
      expect(header.startsWith('{"type":"title"')).toBe(true);
      expect(session.isStreaming()).toBe(false);
      await session.dispose();
      // Dispose is terminal and non-destructive: the transcript survives.
      expect(existsSync(spaceFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restart resumes the same space transcript without resetting it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const transcriptDir = join(dir, "sessions");
      const spaceFile = join(transcriptDir, "slack:C1.jsonl");
      const driver = createOmpSdkDriver({ agentDir: join(dir, "agent") });
      const options = { spaceId: "slack:C1", transcriptDir, onOutput: () => {} };

      const first = await driver.createSession(options);
      await first.dispose();
      const beforeRestart = readFileSync(spaceFile, "utf8");

      const second = await driver.createSession(options);
      await second.dispose();
      const afterRestart = readFileSync(spaceFile, "utf8");

      // A fresh session on a missing file materializes the same header, so
      // byte equality alone is ambiguous; the point is the file was NOT
      // truncated, emptied, or moved by the restart cycle — history at the
      // same path survives dispose + re-create.
      expect(existsSync(spaceFile)).toBe(true);
      expect(afterRestart).toBe(beforeRestart);
      expect(afterRestart.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("allowTools override is accepted and plumbed to the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const driver = createOmpSdkDriver({ agentDir: join(dir, "agent") });
      const session = await driver.createSession({
        spaceId: "slack:C1",
        transcriptDir: join(dir, "sessions"),
        onOutput: () => {},
        allowTools: ["read", "grep"],
      });
      expect(session.isStreaming()).toBe(false);
      await session.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("memoryContext wiring creates sessions with the injection extension (issue #42)", async () => {
    // The driver builds the memory-context extension per session around the
    // session's getPrincipal; a real SDK session must accept it at creation
    // and dispose cleanly (the extension only acts on LLM calls, so no prompt).
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const provider = {
        save: async () => {
          throw new Error("unused");
        },
        search: async () => [],
      };
      const driver = createOmpSdkDriver({
        agentDir: join(dir, "agent"),
        memoryContext: { provider, maxEntries: 2, enabled: true },
      });
      const session = await driver.createSession({
        spaceId: "slack:C1",
        transcriptDir: join(dir, "sessions"),
        onOutput: () => {},
        getPrincipal: () => "U1",
      });
      expect(session.isStreaming()).toBe(false);
      await session.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appendSystemPrompt (request-only directive) is accepted and plumbed to session creation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const driver = createOmpSdkDriver({ agentDir: join(dir, "agent") });
      const session = await driver.createSession({
        spaceId: "slack:C1",
        transcriptDir: join(dir, "sessions"),
        onOutput: () => {},
        appendSystemPrompt: "Act only on explicit requests; stay silent on chatter — reply briefly or not at all.",
      });
      expect(session.isStreaming()).toBe(false);
      await session.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("thinkingLevel defaults to low and reaches createAgentSession (issue #68)", async () => {
    // Hermetic: the injected session factory captures the exact options the
    // driver builds — no SDK session is created. The default must be "low"
    // so the space agent's token budget goes to answers, not reasoning
    // (deepseek-v4-flash returned empty responses when reasoning consumed
    // the whole budget, #60/#68).
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      let receivedOptions: CreateAgentSessionOptions | undefined;
      const driver = createOmpSdkDriver({
        agentDir: join(dir, "agent"),
        createSession: async (options) => {
          receivedOptions = options;
          throw new Error("factory stub: no real session");
        },
      });
      await expect(
        driver.createSession({
          spaceId: "slack:C1",
          transcriptDir: join(dir, "sessions"),
          onOutput: () => {},
        }),
      ).rejects.toThrow("factory stub: no real session");
      expect(receivedOptions?.thinkingLevel).toBe("low" as CreateAgentSessionOptions["thinkingLevel"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("thinkingLevel override is passed through to createAgentSession (issue #68)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      let receivedOptions: CreateAgentSessionOptions | undefined;
      const driver = createOmpSdkDriver({
        agentDir: join(dir, "agent"),
        thinkingLevel: "off",
        createSession: async (options) => {
          receivedOptions = options;
          throw new Error("factory stub: no real session");
        },
      });
      await expect(
        driver.createSession({
          spaceId: "slack:C1",
          transcriptDir: join(dir, "sessions"),
          onOutput: () => {},
        }),
      ).rejects.toThrow("factory stub: no real session");
      // "off" disables reasoning entirely — the documented fallback knob.
      expect(receivedOptions?.thinkingLevel).toBe("off" as CreateAgentSessionOptions["thinkingLevel"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sessions materialize the SDK agent state in the passed agentDir", async () => {
    // Behavioral proof the agentDir option is honored: the OMP SDK keeps its
    // agent store (agent.db) in the directory the driver was given, not the
    // caller's default (~/.omp/agent). This is the seam that keeps server
    // boots reading config/omp templates instead of a home-directory agent.
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const agentDir = join(dir, "agent");
      const driver = createOmpSdkDriver({ agentDir });
      const session = await driver.createSession({
        spaceId: "slack:C1",
        transcriptDir: join(dir, "sessions"),
        onOutput: () => {},
      });
      await session.dispose();
      expect(existsSync(join(agentDir, "agent.db"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("space-agent allowlist: conversation/read-only + task + queue/memory/connect/model/settings tools, no executor tools", () => {
    // The space agent is a participant, not an executor: it may read the
    // workspace, delegate via task, and use the work-item + memory + model
    // tools — never write/bash/edit (those are EXECUTOR_TOOLS in
    // executor.ts). The connect capability (issue #52) is listed here; its
    // definition rides the custom-tools path, see createOmpSdkDriver. The
    // model tools (issue #64) are the chat settings/role-switch surface;
    // the settings tool (issue #67) is the durable org/space settings
    // surface.
    const allowed: readonly string[] = SPACE_AGENT_TOOLS;
    expect([...allowed].sort()).toEqual(
      [
        "read",
        "glob",
        "grep",
        "ast_grep",
        "web_search",
        "inspect_image",
        "lsp",
        "task",
        "create_work_item",
        "work_item_cancel",
        "connect_extension",
        "memory.save",
        "memory.search",
        "model_settings",
        "use_model",
        "settings",
        // Admin tools (issue #73): catalog browser, stack health, deploy
        // info, first-run wizard.
        "catalog_browser",
        "stack_health",
        "deploy_info",
        "first_run_wizard",
      ].sort(),
    );
    expect(SPACE_AGENT_TOOLS).not.toContain("write");
    expect(SPACE_AGENT_TOOLS).not.toContain("bash");
    expect(SPACE_AGENT_TOOLS).not.toContain("edit");
  });

  test("spaceAgentToolNames merges extension tools after the allowlist", () => {
    expect(spaceAgentToolNames(["weather.current"])).toEqual([...SPACE_AGENT_TOOLS, "weather.current"]);
    // allowTools override still wins; extension tools append to it.
    expect(spaceAgentToolNames(["weather.current"], ["read", "grep"])).toEqual(["read", "grep", "weather.current"]);
    expect(spaceAgentToolNames(["read"])).toEqual([...SPACE_AGENT_TOOLS]); // deduped
  });

  test("fixture extension tool appears in the space agent's toolset", async () => {
    // The driver hides the session behind AgentSessionDriver, so the toolset
    // contract is pinned here with the EXACT session options createOmpSdkDriver
    // builds (restrictToolNames + spaceAgentToolNames + customTools +
    // allowRestrictedCustomTools): a registered extension's tool must surface
    // in the restricted space-agent toolset alongside the allowlist.
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const registry = createFixtureRegistry();
      // Session-surface tests only: no tool executes, so a stub runtime
      // proves the bridge still yields definitions (execution is the #53
      // runtime's job, tested in extensions/runtime.test.ts).
      const stubRuntime: ExtensionRuntime = { execute: async () => ({ ok: false, error: "stub" }) };
      const customTools = extensionToolDefinitions(registry.list(), { runtime: stubRuntime });
      mkdirSync(join(dir, "sessions"), { recursive: true });
      const sessionManager = SessionManager.create(process.cwd(), join(dir, "sessions"));
      await sessionManager.setSessionFile(join(dir, "sessions", "slack:C1.jsonl"));
      const { session } = await createAgentSession({
        cwd: process.cwd(),
        agentDir: join(dir, "agent"),
        sessionManager,
        agentRegistry: new AgentRegistry(),
        restrictToolNames: true,
        toolNames: spaceAgentToolNames(registry.toolNames()),
        customTools,
        allowRestrictedCustomTools: true,
        extensions: [],
      });
      const active = session.getActiveToolNames();
      expect(active).toContain("weather.current");
      expect(active).toContain("read");
      expect(active).toContain("grep");
      expect(active).not.toContain("write"); // restricted: no executor tools
      session.beginDispose();
      await session.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("createOmpSdkDriver accepts registry customTools and creates sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const stubRuntime: ExtensionRuntime = { execute: async () => ({ ok: false, error: "stub" }) };
      const customTools = extensionToolDefinitions(createFixtureRegistry().list(), { runtime: stubRuntime });
      const driver = createOmpSdkDriver({ agentDir: join(dir, "agent"), customTools });
      const session = await driver.createSession({
        spaceId: "slack:C1",
        transcriptDir: join(dir, "sessions"),
        onOutput: () => {},
      });
      expect(session.isStreaming()).toBe(false);
      await session.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("connect_extension appears in the space agent's toolset when wired (issue #52)", async () => {
    // The connect tool is built per session by createOmpSdkDriver (custom
    // tools + toolNames + allowRestrictedCustomTools); this pins the exact
    // session options the driver builds, mirroring the fixture test above.
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const store = createStore(join(dir, "test.db"));
      try {
        const registry = createFixtureRegistry();
        const customTools = [
          ...extensionToolDefinitions(registry.list(), {
            runtime: { execute: async () => ({ ok: false, error: "stub" }) },
          }),
          connectExtensionToolDefinition({
            registry,
            store,
            audit: createAudit(store),
            broker: async () => ({ identityKey: "email:ada@example.com", brokerCredentialId: 1 }),
            gate: {
              loadPolicy: () => Promise.resolve(parseOrgConfigYaml("")),
              router: DenyRouter,
            },
            getPrincipal: () => "UADA",
            spaceIdFromFile: sessionIdFromFilePath,
          }),
        ];
        mkdirSync(join(dir, "sessions"), { recursive: true });
        const sessionManager = SessionManager.create(process.cwd(), join(dir, "sessions"));
        await sessionManager.setSessionFile(join(dir, "sessions", "slack:C1.jsonl"));
        const { session } = await createAgentSession({
          cwd: process.cwd(),
          agentDir: join(dir, "agent"),
          sessionManager,
          agentRegistry: new AgentRegistry(),
          restrictToolNames: true,
          toolNames: spaceAgentToolNames(customTools.map((tool) => tool.name)),
          customTools,
          allowRestrictedCustomTools: true,
          extensions: [],
        });
        const active = session.getActiveToolNames();
        expect(active).toContain("connect_extension");
        expect(active).toContain("weather.current");
        expect(active).not.toContain("write"); // restricted: no executor tools
        session.beginDispose();
        await session.dispose();
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveRoleTarget (issue #64)", () => {
  const settings: SpaceModelSettings = {
    model: "deepseek-v4-flash",
    reasoning_effort: "medium",
    fast_model: "flash-lite",
    reasoning_model: "deepseek-reasoner",
  };

  test("default → space model at the space's default effort", () => {
    expect(resolveRoleTarget("default", settings)).toEqual({
      modelId: "deepseek-v4-flash",
      thinkingLevel: "medium",
    });
  });

  test("fast → fast_model (falls back to model) at fixed low effort", () => {
    expect(resolveRoleTarget("fast", settings)).toEqual({ modelId: "flash-lite", thinkingLevel: "low" });
    expect(resolveRoleTarget("fast", { model: "m" })).toEqual({ modelId: "m", thinkingLevel: "low" });
  });

  test("reasoning → reasoning_model (falls back to model) at reasoning_effort, default high", () => {
    expect(resolveRoleTarget("reasoning", settings)).toEqual({
      modelId: "deepseek-reasoner",
      thinkingLevel: "medium",
    });
    expect(resolveRoleTarget("reasoning", { model: "m" })).toEqual({ modelId: "m", thinkingLevel: "high" });
    expect(resolveRoleTarget("reasoning", { model: "m", reasoning_effort: "off" })).toEqual({
      modelId: "m",
      thinkingLevel: "off",
    });
  });

  test("unconfigured slots yield no switch (applied: false path)", () => {
    expect(resolveRoleTarget("default", {})).toEqual({});
    expect(resolveRoleTarget("fast", { fast_model: "f" })).toEqual({ modelId: "f", thinkingLevel: "low" });
    expect(resolveRoleTarget("reasoning", { reasoning_effort: "high" })).toEqual({ thinkingLevel: "high" });
  });
});

describe("OmpSessionDriver.setModelRole (issue #64)", () => {
  /** A stub SDK session: records model/thinking switches, serves a fixed model list. */
  function stubSession(models: Array<{ id: string; provider: string }> = []) {
    const calls: Array<{ modelId: string; thinkingLevel?: string; persist?: boolean }> = [];
    const thinkingCalls: string[] = [];
    return {
      session: {
        getAvailableModels: () =>
          models.map((m) => ({ id: m.id, provider: m.provider, name: m.id, api: "openai-completions", baseUrl: "http://x", reasoning: true, input: ["text"] })),
        setModel: async (_model: { id: string }, _role?: string, options?: { thinkingLevel?: string; persist?: boolean }) => {
          calls.push({ modelId: _model.id, thinkingLevel: options?.thinkingLevel, persist: options?.persist });
          return { switched: true };
        },
        setThinkingLevel: (level?: string) => void thinkingCalls.push(level ?? ""),
        subscribe: () => () => {},
        beginDispose: () => {},
        dispose: async () => {},
        isStreaming: false,
        prompt: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
      } as unknown as AgentSession,
      calls,
      thinkingCalls,
    };
  }

  function sessionWithSettings(spaceId: string, settings: SpaceModelSettings, models: Array<{ id: string; provider: string }> = []) {
    const stub = stubSession(models);
    const driver = new OmpSessionDriver({
      spaceId,
      session: stub.session,
      onOutput: () => {},
      getModelSettings: async () => settings,
    });
    return { driver, stub };
  }

  test("fast role applies fast_model at low effort, non-persisting", async () => {
    const { driver, stub } = sessionWithSettings(
      "slack:C1",
      { model: "deep-model", fast_model: "flash-lite" },
      [{ id: "flash-lite", provider: "opencode-go" }, { id: "deep-model", provider: "opencode-go" }],
    );
    const result = await driver.setModelRole("fast");
    expect(result).toEqual({ applied: true, role: "fast", model: "flash-lite", thinking_level: "low" });
    expect(stub.calls).toEqual([{ modelId: "flash-lite", thinkingLevel: "low", persist: false }]);
  });

  test("default role applies the space model; a missing model id fails closed", async () => {
    // Model not in the session's available set → the switch throws rather
    // than silently keeping the old model.
    const { driver, stub } = sessionWithSettings("slack:C1", { model: "ghost-model" });
    await expect(driver.setModelRole("default")).rejects.toThrow(/ghost-model.*not available/);
    expect(stub.calls).toEqual([]);
  });

  test("an effort-only switch (reasoning with no model slots) calls setThinkingLevel", async () => {
    const { driver, stub } = sessionWithSettings("slack:C1", { reasoning_effort: "high" });
    const result = await driver.setModelRole("reasoning");
    expect(result).toEqual({ applied: true, role: "reasoning", model: null, thinking_level: "high" });
    expect(stub.calls).toEqual([]);
    expect(stub.thinkingCalls).toEqual(["high"]);
  });

  test("no settings → applied: false without touching the session", async () => {
    const { driver, stub } = sessionWithSettings("slack:C1", {});
    const result = await driver.setModelRole("default");
    expect(result).toEqual({
      applied: false,
      role: "default",
      model: null,
      thinking_level: null,
      reason: "no model settings configured for this space",
    });
    expect(stub.calls).toEqual([]);
    expect(stub.thinkingCalls).toEqual([]);
  });
});

describe("process-global agent dir + boot guard (issue #80)", () => {
  const PROVIDER = "agentdir-test";
  const MODEL_ID = "model-1";
  const STUB_BASE_URL = "http://127.0.0.1:4891/v1";

  /** A temp agent dir whose models.yml declares ONE provider with an inline key. */
  function agentDirWithCatalog(): { agentDir: string; cleanup(): void } {
    const dir = mkdtempSync(join(tmpdir(), "agentdir-issue80-"));
    const agentDir = join(dir, "omp-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models.yml"),
      [
        "providers:",
        `  ${PROVIDER}:`,
        "    api: openai-completions",
        `    baseUrl: "${STUB_BASE_URL}"`,
        '    apiKey: "issue80-inline-key"',
        "    models:",
        `      - id: ${MODEL_ID}`,
        '        name: "Issue 80 Test Model"',
        "        contextWindow: 128000",
        "        maxTokens: 4096",
        "",
      ].join("\n"),
    );
    return { agentDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("driver construction installs the agent dir as the process-global dir (the #9 seam moves into the driver)", async () => {
    const { agentDir, cleanup } = agentDirWithCatalog();
    try {
      createOmpSdkDriver({ agentDir });
      // The registry the SDK sessions build reads models.yml from
      // getAgentDir() — it must now be OUR dir, with PI_CODING_AGENT_DIR
      // pinned for subprocesses (the old workaround env, set by the driver).
      expect(getAgentDir()).toBe(resolve(agentDir));
      expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
    } finally {
      cleanup();
    }
  });

  test("the real SDK registry resolves the models.yml model after driver construction — no env hacks", async () => {
    const { agentDir, cleanup } = agentDirWithCatalog();
    try {
      createOmpSdkDriver({ agentDir });
      // The session path: discoverAuthStorage(agentDir) + new ModelRegistry
      // (models.yml from the process-global dir) — exactly what
      // createAgentSession does.
      const registry = new ModelRegistry(await discoverAuthStorage(agentDir));
      expect(registry.getError()).toBeUndefined();
      const model = registry.find(PROVIDER, MODEL_ID);
      expect(model?.baseUrl).toBe(STUB_BASE_URL); // OUR models.yml, not ~/.omp/agent
      const available = registry.getAvailable();
      expect(available.some((m) => m.provider === PROVIDER)).toBe(true);
      // The boot guard agrees: ≥1 available model from OUR declared providers.
      await expect(assertAgentDirModelAvailable(agentDir)).resolves.toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  test("boot guard fails with a clear message when OUR catalog has no available model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdir-issue80-"));
    const agentDir = join(dir, "omp-agent");
    mkdirSync(agentDir, { recursive: true });
    // A provider declared with ONLY a baseUrl (no apiKey, no models, no
    // `auth: none`) is a valid override-only entry — and it has no auth, so
    // the registry reports it unavailable: the exact state that used to
    // surface as "No model selected" at the first prompt.
    writeFileSync(
      join(agentDir, "models.yml"),
      [
        "providers:",
        `  ${PROVIDER}:`,
        "    api: openai-completions",
        `    baseUrl: "${STUB_BASE_URL}"`,
        "",
      ].join("\n"),
    );
    try {
      createOmpSdkDriver({ agentDir });
      await expect(assertAgentDirModelAvailable(agentDir)).rejects.toThrow(
        /bottega boot guard: no model is available from the agent dir .*models\.yml.*config\.yml/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("boot guard skips the assertion when models.yml is missing (no catalog → bundled/env view, no fail-fast)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdir-issue80-"));
    const agentDir = join(dir, "omp-agent");
    mkdirSync(agentDir, { recursive: true });
    try {
      createOmpSdkDriver({ agentDir });
      // No models.yml → lenient leg: the guard RESOLVES (no fail-fast)
      // instead of failing the boot. The count is the SDK's bundled/env
      // view, which the full suite's process-global model cache populates —
      // assert the contract (resolves, non-negative), not an order-dependent
      // literal.
      await expect(assertAgentDirModelAvailable(agentDir)).resolves.toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("opencode tool-name transform (issue #78)", () => {
  test("opencodeSafeToolName flattens gateway-rejected names, leaves safe names alone", () => {
    expect(opencodeSafeToolName("memory.save")).toBe("memory_save");
    expect(opencodeSafeToolName("memory.search")).toBe("memory_search");
    expect(opencodeSafeToolName("linear.search_issues")).toBe("linear_search_issues");
    expect(opencodeSafeToolName("attio.contacts.list")).toBe("attio_contacts_list");
    expect(opencodeSafeToolName("create_work_item")).toBe("create_work_item");
    expect(opencodeSafeToolName("read")).toBe("read");
    expect(opencodeToolNameMap(["memory.save", "read", "memory.search"])).toEqual(
      new Map([
        ["memory.save", "memory_save"],
        ["memory.search", "memory_search"],
      ]),
    );
  });

  test("the driver registers flat session names while the gate audits the canonical name", async () => {
    // Hermetic: the injected session factory captures the exact options the
    // driver builds. The gated definition keeps its canonical name in the
    // gate's closure, so the model-facing (flat) name and the audit
    // (canonical) name coexist — the opencode gateway sees no dots and the
    // attribution trail keeps memory.save.
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const store = createStore(join(dir, "test.db"));
      const audit = createAudit(store);
      const orgPolicy = parseOrgConfigYaml("tools:\n  memory.save: allow\n");
      let receivedOptions: CreateAgentSessionOptions | undefined;
      const driver = createOmpSdkDriver({
        agentDir: join(dir, "agent"),
        gate: {
          orgPolicy,
          audit,
          router: DenyRouter,
          store,
          tools: [
            {
              name: "memory.save",
              label: "memory.save",
              description: "Save a memory",
              parameters: z.object({ content: z.string() }),
              async execute() {
                return { content: [{ type: "text", text: "saved" }] };
              },
            },
          ],
        },
        createSession: async (options) => {
          receivedOptions = options;
          throw new Error("factory stub: no real session");
        },
      });
      await expect(
        driver.createSession({
          spaceId: "slack:C1",
          transcriptDir: join(dir, "sessions"),
          onOutput: () => {},
        }),
      ).rejects.toThrow("factory stub: no real session");

      // Session-facing surface is flat: the gateway-safe name is what the
      // model sees on the wire and in toolNames.
      const flatDef = receivedOptions?.customTools?.find(
        (tool): tool is ToolDefinition => "name" in tool && tool.name === "memory_save",
      );
      expect(flatDef).toBeDefined();
      expect(receivedOptions?.customTools?.some((tool) => "name" in tool && tool.name === "memory.save")).toBe(false);
      expect(receivedOptions?.toolNames).toContain("memory_save");
      expect(receivedOptions?.toolNames).not.toContain("memory.save");

      // Executing the flat definition crosses the gate under the CANONICAL
      // name: the policy decision row and the audit trail keep memory.save.
      const result = await flatDef!.execute(
        "call_1",
        { content: "x" },
        undefined,
        undefined,
        {
          sessionManager: { getSessionFile: () => join(dir, "sessions", "slack:C1.jsonl") },
        } as never,
      );
      expect(result).toEqual({ content: [{ type: "text", text: "saved" }] });
      const rows = await store.listAudit({ event_type: POLICY_DECISION_EVENT });
      const decisions = rows.map((row) => JSON.parse(row.payload) as { tool: string; decision: string });
      expect(decisions.find((row) => row.tool === "memory.save")?.decision).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
