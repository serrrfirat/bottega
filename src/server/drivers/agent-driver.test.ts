import { describe, expect, test, vi } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentRegistry, ModelRegistry, SessionManager, createAgentSession, discoverAuthStorage, z, type AgentToolUpdateCallback, type CreateAgentSessionOptions, type ExtensionContext, type TodoPhase, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { connectExtensionToolDefinition } from "../../extensions/connect";
import { createFixtureRegistry, FIXTURE_EXTENSION_ID } from "../../extensions/fixture";
import type { McpBinding, JsonObject, JsonValue } from "../../extensions/manifest";
import { createExtensionRuntime } from "../../extensions/runtime";
import { extensionToolDefinitions } from "../../extensions/tools";
import type { ExtensionRuntime } from "../../extensions/runtime";
import { createAudit } from "../../policy/audit";
import { DenyRouter } from "../../policy/approval-router";
import { parseOrgConfigYaml } from "../../policy/config";
import { createStore, type ExtensionCredential, type SpaceModelSettings, type Store } from "../../store/db";
import type { OrgSettings } from "../../store/org-settings";
import type { SlackAdapter } from "../adapters/slack";
import { SlackTurnPresenter } from "../services/slack-turn-presenter";
import { EXTENSION_CALL_EVENT, POLICY_DECISION_EVENT } from "../../store/audit-events";
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
  withPolicyGate,
} from "./agent-driver";
import { searchWebToolDefinition, SEARCH_PROVIDER } from "../../tools/search-web";
import type { SearchResultRow } from "../services/slack-turn-presenter";

/**
 * Session event shapes the driver consumes, as injected by the stub
 * sessions (SDK-shaped but loosely typed: the driver must fail closed on
 * malformed events, which some tests deliberately inject).
 */
type StubSessionEvent =
  | { type: "message_end"; message: JsonObject | null }
  | { type: "message_update"; message: JsonObject; assistantMessageEvent: JsonObject }
  | { type: "turn_end"; message: JsonObject; toolResults?: JsonValue[] }
  | { type: "turn_start" }
  | { type: "notice"; level: "error"; message: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: JsonObject }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: JsonObject; isError: boolean };

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
      expect(receivedOptions?.thinkingLevel).toBe(Effort.Low);
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
      expect(receivedOptions?.thinkingLevel).toBe("off");
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

  test("space-agent allowlist: conversation/read-only + task + queue/memory/session/connect/model/settings tools, no executor tools", () => {
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
        "list_work_items",
        // Complete skill lifecycle, aligned with SPACE_AGENT_TOOLS.
        "list_space_skills",
        "get_space_skill",
        "create_space_skill",
        "update_space_skill",
        "delete_space_skill",
        "connect_extension",
        "memory.save",
        "memory.search",
        "session_search",
        "model_settings",
        "use_model",
        // Todo tooling (issue #228): the planning scaffold + the read-tier
        // snapshot of the space's live state.
        "todo",
        "list_todos",
        "settings",
        // Admin tools (issue #73): catalog browser, stack health, deploy
        // info, first-run wizard.
        "catalog_browser",
        "stack_health",
        "deploy_info",
        "first_run_wizard",
        // Scheduler lifecycle (issues #86/#308): policy-gated durable
        // create/read/update/pause/resume/run/delete surface.
        "create_scheduler_job",
        "list_scheduler_jobs",
        "update_scheduler_job",
        "pause_scheduler_job",
        "resume_scheduler_job",
        "run_scheduler_job_now",
        "delete_scheduler_job",
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

  test("a customTools RESOLVER is awaited per session creation and its definitions land in the session toolset (issue #167)", async () => {
    // The server wires the resolver so a provider whose discovery failed at
    // boot is re-attempted when a session is created — the full surface
    // lands in every session, never a partial stale subset. Hermetic: the
    // injected session factory captures the exact options the driver builds
    // (no SDK session, no model).
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-"));
    try {
      const calls: string[] = [];
      let receivedOptions: CreateAgentSessionOptions | undefined;
      const stubRuntime: ExtensionRuntime = { execute: async () => ({ ok: false, error: "stub" }) };
      const driver = createOmpSdkDriver({
        agentDir: join(dir, "agent"),
        customTools: async () => {
          calls.push("resolve");
          return extensionToolDefinitions(createFixtureRegistry().list(), { runtime: stubRuntime });
        },
        createSession: async (options) => {
          receivedOptions = options;
          throw new Error("factory stub: no real session");
        },
      });
      await expect(
        driver.createSession({ spaceId: "slack:C1", transcriptDir: join(dir, "sessions"), onOutput: () => {} }),
      ).rejects.toThrow("factory stub: no real session");
      await expect(
        driver.createSession({ spaceId: "slack:C2", transcriptDir: join(dir, "sessions"), onOutput: () => {} }),
      ).rejects.toThrow("factory stub: no real session");
      // Resolved once PER session — the refresh seam stays live (a provider
      // that comes back after the boot is picked up by the NEXT session).
      expect(calls).toEqual(["resolve", "resolve"]);
      // The resolver's definitions reached the session options: registry
      // tools ride customTools + toolNames under their gateway-safe flat
      // names (issue #78); the restricted allowlist stays.
      const customToolNames = (receivedOptions?.customTools ?? [])
        .map((tool) => tool.name)
        .filter((name) => name !== "");
      expect(customToolNames).toContain("weather_current");
      expect(receivedOptions?.toolNames).toContain("weather_current");
      expect(receivedOptions?.toolNames).not.toContain("write");
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

describe("session default model resolution (issue #199)", () => {
  /**
   * Agent dir with BOTH deepseek providers declared (the #213 live shape):
   * near serves deepseek-ai/DeepSeek-V4-Flash; opencode-go serves the
   * same-named bare deepseek-v4-flash (#78-broken). The near gateway probe
   * targets a dead loopback port so it fails fast and the declared set
   * stands — hermetic, no network.
   */
  function dualDeepseekAgentDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-model-"));
    writeFileSync(
      join(dir, "models.yml"),
      `providers:
  near:
    api: openai-completions
    baseUrl: "http://127.0.0.1:1"
    apiKey: BOTTEGA_TEST_NEAR_API_KEY
    models:
      - id: "deepseek-ai/DeepSeek-V4-Flash"
        name: "DeepSeek V4 Flash"
        contextWindow: 128000
        maxTokens: 8192
  opencode-go:
    api: openai-completions
    baseUrl: "https://opencode.example/v1"
    apiKey: OPENCODE_API_KEY
    models:
      - id: "deepseek-v4-flash"
        name: "DeepSeek V4 Flash (2x usage)"
        contextWindow: 128000
        maxTokens: 8192
`,
    );
    return dir;
  }

  function capturedOptionsDriver(agentDir: string) {
    let receivedOptions: CreateAgentSessionOptions | undefined;
    const driver = createOmpSdkDriver({
      agentDir,
      createSession: async (options) => {
        receivedOptions = options;
        throw new Error("factory stub: no real session");
      },
    });
    return { driver, options: () => receivedOptions };
  }

  test("an unqualified settings default resolves to NEAR's model in the session options — never opencode-go's (#199)", async () => {
    process.env.BOTTEGA_TEST_NEAR_API_KEY = "stub-key";
    process.env.OPENCODE_API_KEY = "stub-key";
    const dir = dualDeepseekAgentDir();
    try {
      const { driver, options } = capturedOptionsDriver(dir);
      await expect(
        driver.createSession({
          spaceId: "slack:C1",
          transcriptDir: join(dir, "sessions"),
          onOutput: () => {},
          getModelSettings: async () => ({ model: "deepseek-v4-flash" }),
        }),
      ).rejects.toThrow("factory stub: no real session");
      // The raw settings value NEVER reaches the SDK: the session options
      // carry the provider-qualified id the resolver picked (near's working
      // deepseek), so the SDK registry cannot drift to opencode-go's
      // #78-broken same-named model.
      expect(options()?.modelPattern).toEqual(["near/deepseek-ai/DeepSeek-V4-Flash"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.BOTTEGA_TEST_NEAR_API_KEY;
      delete process.env.OPENCODE_API_KEY;
    }
  });

  test("an explicit provider qualifier still wins the session default (#199)", async () => {
    process.env.BOTTEGA_TEST_NEAR_API_KEY = "stub-key";
    process.env.OPENCODE_API_KEY = "stub-key";
    const dir = dualDeepseekAgentDir();
    try {
      const { driver, options } = capturedOptionsDriver(dir);
      await expect(
        driver.createSession({
          spaceId: "slack:C1",
          transcriptDir: join(dir, "sessions"),
          onOutput: () => {},
          getModelSettings: async () => ({ model: "opencode-go/deepseek-v4-flash" }),
        }),
      ).rejects.toThrow("factory stub: no real session");
      // Explicit intent beats the near preference: the session options name
      // opencode-go's model outright.
      expect(options()?.modelPattern).toEqual(["opencode-go/deepseek-v4-flash"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.BOTTEGA_TEST_NEAR_API_KEY;
      delete process.env.OPENCODE_API_KEY;
    }
  });

  test("an unresolvable settings default fails closed — loud log, no model pin, agent-dir default", async () => {
    process.env.BOTTEGA_TEST_NEAR_API_KEY = "stub-key";
    process.env.OPENCODE_API_KEY = "stub-key";
    const dir = dualDeepseekAgentDir();
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { driver, options } = capturedOptionsDriver(dir);
      await expect(
        driver.createSession({
          spaceId: "slack:C1",
          transcriptDir: join(dir, "sessions"),
          onOutput: () => {},
          getModelSettings: async () => ({ model: "no-such-model-xyz" }),
        }),
      ).rejects.toThrow("factory stub: no real session");
      // No resolved pin: the SDK starts the session on its own default.
      expect(options()?.modelPattern).toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("default model 'no-such-model-xyz' is unresolvable"),
      );
    } finally {
      logSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
      delete process.env.BOTTEGA_TEST_NEAR_API_KEY;
      delete process.env.OPENCODE_API_KEY;
    }
  });

  test("the org-wide default beats a stale agent-dir pin in session resolution (#207)", async () => {
    process.env.BOTTEGA_TEST_NEAR_API_KEY = "stub-key";
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-org207-"));
    try {
      // The #207 evidence shape: the agent-dir config.yml pins a DEAD model
      // (near/zai-org/GLM-5.1-FP8 — the stale value), the space has NO
      // per-space settings, and the org_settings row carries the operator's
      // choice (models.default = openai-codex/gpt-5.6-luna). The catalog
      // serves the org default, so the only question is which source the
      // session resolves — the org default must WIN.
      writeFileSync(
        join(dir, "config.yml"),
        "modelRoles:\n  default: near/zai-org/GLM-5.1-FP8\n",
      );
      writeFileSync(
        join(dir, "models.yml"),
        `providers:
  near:
    api: openai-completions
    baseUrl: "http://127.0.0.1:1"
    apiKey: BOTTEGA_TEST_NEAR_API_KEY
    models:
      - id: "openai-codex/gpt-5.6-luna"
        name: "gpt-5.6-luna"
        contextWindow: 128000
        maxTokens: 8192
`,
      );
      const store = createStore(join(dir, "store.db"));
      store.setOrgSettings({ models: { default: "openai-codex/gpt-5.6-luna" } });
      const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C207" });
      let receivedOptions: CreateAgentSessionOptions | undefined;
      const driver = createOmpSdkDriver({
        agentDir: dir,
        // The composition-root wiring (issue #207): effective settings =
        // space settings with the org-wide default filling unset slots.
        getModelSettings: (spaceId) => store.getEffectiveSpaceSettings(spaceId),
        createSession: async (options) => {
          receivedOptions = options;
          throw new Error("factory stub: no real session");
        },
      });
      await expect(
        driver.createSession({ spaceId: space.id, transcriptDir: join(dir, "sessions"), onOutput: () => {} }),
      ).rejects.toThrow("factory stub: no real session");
      // The session's explicit default is the ORG value (provider-qualified
      // through the catalog), never the stale pin's dead GLM provider.
      expect(receivedOptions?.modelPattern).toEqual(["near/openai-codex/gpt-5.6-luna"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.BOTTEGA_TEST_NEAR_API_KEY;
    }
  });

  test("the org default's provider survives to the session — openai-codex, never the first same-id provider (#238)", async () => {
    process.env.BOTTEGA_TEST_OPENAI_API_KEY = "stub-key";
    process.env.BOTTEGA_TEST_OPENAI_CODEX_API_KEY = "stub-key";
    process.env.OPENCODE_API_KEY = "stub-key";
    process.env.BOTTEGA_TEST_NEAR_API_KEY = "stub-key";
    const dir = mkdtempSync(join(tmpdir(), "agent-driver-238-"));
    try {
      // The live data/omp-agent shape: openai, openai-codex, and
      // opencode-go all serve the bare id gpt-5.6-luna — and because the
      // SDK composes bundled providers in order, openai is FIRST among the
      // same-id entries (verified empirically), so the pre-#238 bare-id
      // re-find ALWAYS lands on openai. Plus near serves the slashed
      // openai-codex/gpt-5.6-luna. The org default must reach the session
      // options as ["openai-codex/gpt-5.6-luna"] — NEVER
      // ["openai/gpt-5.6-luna"]. Dropping the pin's provider sent egress
      // to api.openai.com with no key → proxy 403 at CONNECT → silently
      // empty turns on live Slack. All gateways are dead or non-routable
      // so their probes fail closed — hermetic, no network.
      writeFileSync(
        join(dir, "models.yml"),
        `providers:
  openai:
    api: openai-completions
    baseUrl: "http://127.0.0.1:1"
    apiKey: BOTTEGA_TEST_OPENAI_API_KEY
    models:
      - id: "gpt-5.6-luna"
        name: "GPT-5.6 Luna"
        contextWindow: 128000
        maxTokens: 8192
  openai-codex:
    api: openai-completions
    baseUrl: "http://127.0.0.1:1"
    apiKey: BOTTEGA_TEST_OPENAI_CODEX_API_KEY
    models:
      - id: "gpt-5.6-luna"
        name: "GPT-5.6 Luna"
        contextWindow: 128000
        maxTokens: 8192
  opencode-go:
    api: openai-completions
    baseUrl: "https://opencode.example/v1"
    apiKey: OPENCODE_API_KEY
    models:
      - id: "gpt-5.6-luna"
        name: "GPT-5.6 Luna"
        contextWindow: 128000
        maxTokens: 8192
  near:
    api: openai-completions
    baseUrl: "http://127.0.0.1:1"
    apiKey: BOTTEGA_TEST_NEAR_API_KEY
    models:
      - id: "openai-codex/gpt-5.6-luna"
        name: "gpt-5.6-luna"
        contextWindow: 128000
        maxTokens: 8192
`,
      );
      const { driver, options } = capturedOptionsDriver(dir);
      await expect(
        driver.createSession({
          spaceId: "slack:C1",
          transcriptDir: join(dir, "sessions"),
          onOutput: () => {},
          getModelSettings: async () => ({ model: "openai-codex/gpt-5.6-luna" }),
        }),
      ).rejects.toThrow("factory stub: no real session");
      // The pin's provider won: the SDK gets the openai-codex entry, never
      // the first bare-id openai one the pre-#238 find landed on.
      expect(options()?.modelPattern).toEqual(["openai-codex/gpt-5.6-luna"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.BOTTEGA_TEST_OPENAI_API_KEY;
      delete process.env.BOTTEGA_TEST_OPENAI_CODEX_API_KEY;
      delete process.env.OPENCODE_API_KEY;
      delete process.env.BOTTEGA_TEST_NEAR_API_KEY;
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
      // SAFETY: the stub implements exactly the members OmpSessionDriver
      // calls (model switching + session lifecycle); the rest of
      // AgentSession is never touched by these tests.
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
      } as never,
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
    // than silently keeping the old model. Since #199 the settings value is
    // routed through the provider-aware resolver first, so the failure is
    // the resolver's fail-closed "matches no available model" error.
    const { driver, stub } = sessionWithSettings("slack:C1", { model: "ghost-model" });
    await expect(driver.setModelRole("default")).rejects.toThrow(/ghost-model.*matches no available model/);
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

describe("OmpSessionDriver turn-start model hot-swap (issue #189)", () => {
  /**
   * Stub SDK session with model state: `setModel`/`setThinkingLevel` update
   * the active model/effort (what the driver's churn check reads), and the
   * current model starts where the caller says (the session-creation
   * resolution). Records every switch and prompt.
   */
  function statefulStubSession(initialModel: { id: string; provider: string } | null, models: Array<{ id: string; provider: string }>, initialLevel?: string) {
    let activeModel = initialModel;
    let activeLevel = initialLevel;
    const setModelCalls: Array<{ modelId: string; thinkingLevel?: string; persist?: boolean }> = [];
    const thinkingCalls: string[] = [];
    const promptCalls: string[] = [];
    // SAFETY: the stub implements exactly the members OmpSessionDriver
    // calls (model state + lifecycle); the rest of AgentSession is never
    // touched by these tests.
    const session = {
      getAvailableModels: () =>
        models.map((m) => ({ id: m.id, provider: m.provider, name: m.id, api: "openai-completions", baseUrl: "http://x", reasoning: true, input: ["text"] })),
      get model() {
        return activeModel;
      },
      get thinkingLevel() {
        return activeLevel;
      },
      setModel: async (_model: { id: string; provider: string }, _role?: string, options?: { thinkingLevel?: string; persist?: boolean }) => {
        activeModel = { id: _model.id, provider: _model.provider };
        if (options?.thinkingLevel !== undefined) activeLevel = options.thinkingLevel;
        setModelCalls.push({ modelId: _model.id, thinkingLevel: options?.thinkingLevel, persist: options?.persist });
        return { switched: true };
      },
      setThinkingLevel: (level?: string) => {
        activeLevel = level;
        thinkingCalls.push(level ?? "");
      },
      subscribe: () => () => {},
      beginDispose: () => {},
      dispose: async () => {},
      isStreaming: false,
      prompt: async (text: string) => void promptCalls.push(text),
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
    } as never;
    return { session, setModelCalls, thinkingCalls, promptCalls };
  }

  function hotSwapDriver(settings: SpaceModelSettings, initialModel: { id: string; provider: string } | null, models: Array<{ id: string; provider: string }>, initialLevel?: string) {
    const stub = statefulStubSession(initialModel, models, initialLevel);
    const driver = new OmpSessionDriver({
      spaceId: "slack:C1",
      session: stub.session,
      onOutput: () => {},
      getModelSettings: async () => settings,
    });
    return { driver, ...stub };
  }

  test("changing the org default model applies it on the very next turn — no session restart", async () => {
    const settings: SpaceModelSettings = { model: "model-a" };
    const { driver, setModelCalls, promptCalls } = hotSwapDriver(
      settings,
      { id: "model-a", provider: "opencode-go" },
      [{ id: "model-a", provider: "opencode-go" }, { id: "model-b", provider: "opencode-go" }],
    );
    // The space service's fresh-turn sequence: re-apply, then open the turn.
    await driver.reapplyDefaultModelRole();
    await driver.prompt("hello");
    // The session already runs the resolved default: no churn.
    expect(setModelCalls).toEqual([]);
    expect(promptCalls).toEqual(["hello"]);

    // The org default changes while the space is live…
    settings.model = "model-b";
    await driver.reapplyDefaultModelRole();
    await driver.prompt("hello again");
    // …and the very next turn re-applies it (hot-swap, no restart).
    expect(setModelCalls).toEqual([{ modelId: "model-b", thinkingLevel: undefined, persist: false }]);
    expect(promptCalls).toEqual(["hello", "hello again"]);
  });

  test("an unqualified settings default hot-swaps to NEAR's model — never opencode-go's same-named one (#199)", async () => {
    // The session is stuck on opencode-go's #78-broken deepseek; the org
    // default is the unqualified "deepseek-v4-flash" both providers serve.
    // The turn-start re-apply must route the raw value through the
    // provider-aware resolver and land on near's working deepseek.
    const { driver, setModelCalls } = hotSwapDriver(
      { model: "deepseek-v4-flash" },
      { id: "deepseek-v4-flash", provider: "opencode-go" },
      [
        { id: "deepseek-v4-flash", provider: "opencode-go" },
        { id: "deepseek-ai/DeepSeek-V4-Flash", provider: "near" },
      ],
    );
    await driver.reapplyDefaultModelRole();
    expect(setModelCalls).toEqual([{ modelId: "deepseek-ai/DeepSeek-V4-Flash", thinkingLevel: undefined, persist: false }]);
  });

  test("a session already on near's model sees NO churn for the same unqualified default (#199)", async () => {
    // The churn check compares against the RESOLVED id (near's
    // deepseek-ai/DeepSeek-V4-Flash) — the raw "deepseek-v4-flash" can
    // never match a near id and must not force a no-op switch every turn.
    const { driver, setModelCalls } = hotSwapDriver(
      { model: "deepseek-v4-flash" },
      { id: "deepseek-ai/DeepSeek-V4-Flash", provider: "near" },
      [
        { id: "deepseek-v4-flash", provider: "opencode-go" },
        { id: "deepseek-ai/DeepSeek-V4-Flash", provider: "near" },
      ],
    );
    await driver.reapplyDefaultModelRole();
    expect(setModelCalls).toEqual([]);
  });

  test("unchanged settings → no re-application churn across turns", async () => {
    const { driver, setModelCalls, thinkingCalls } = hotSwapDriver(
      // Qualified id form: the churn check matches via `provider/id`.
      { model: "opencode-go/model-a", reasoning_effort: "medium" },
      { id: "model-a", provider: "opencode-go" },
      [{ id: "model-a", provider: "opencode-go" }],
      "medium", // the session already runs the resolved default effort
    );
    await driver.reapplyDefaultModelRole();
    await driver.prompt("one");
    await driver.reapplyDefaultModelRole();
    await driver.prompt("two");
    await driver.reapplyDefaultModelRole();
    await driver.prompt("three");
    // The session already runs the resolved default model AND effort: the
    // turn-start re-apply is a pure no-op every time.
    expect(setModelCalls).toEqual([]);
    expect(thinkingCalls).toEqual([]);
  });

  test("use_model (fast/reasoning) still wins for its turn; the next turn re-applies default", async () => {
    const { driver, setModelCalls, promptCalls } = hotSwapDriver(
      { model: "model-a", fast_model: "fast-model" },
      { id: "model-a", provider: "opencode-go" },
      [{ id: "model-a", provider: "opencode-go" }, { id: "fast-model", provider: "opencode-go" }],
    );
    // Mid-turn the agent switches to fast via use_model (#64).
    const result = await driver.setModelRole("fast");
    expect(result.applied).toBe(true);

    // The next turn runs FAST: the turn-start default re-apply is skipped
    // once so the switch actually takes effect (no churn against it).
    await driver.reapplyDefaultModelRole();
    await driver.prompt("fast turn");
    expect(setModelCalls).toEqual([{ modelId: "fast-model", thinkingLevel: "low", persist: false }]);

    // The turn AFTER that re-evaluates against the settings and re-applies
    // the default model.
    await driver.reapplyDefaultModelRole();
    await driver.prompt("back to default");
    expect(setModelCalls).toEqual([
      { modelId: "fast-model", thinkingLevel: "low", persist: false },
      { modelId: "model-a", thinkingLevel: undefined, persist: false },
    ]);
    expect(promptCalls).toEqual(["fast turn", "back to default"]);
  });

  test("the first turn applies the settings default when the session-creation model differs", async () => {
    // The session was created on the agent-dir pin model; the space's
    // settings name a different default. The first turn hot-swaps it.
    const { driver, setModelCalls } = hotSwapDriver(
      { model: "model-a" },
      { id: "pin-default", provider: "opencode-go" },
      [{ id: "model-a", provider: "opencode-go" }],
    );
    await driver.reapplyDefaultModelRole();
    await driver.prompt("first turn");
    expect(setModelCalls).toEqual([{ modelId: "model-a", thinkingLevel: undefined, persist: false }]);
  });

  test("an effort-only settings change re-applies the model at the new effort without churn after", async () => {
    const settings: SpaceModelSettings = { model: "model-a", reasoning_effort: "high" };
    const { driver, setModelCalls, thinkingCalls } = hotSwapDriver(
      settings,
      { id: "model-a", provider: "opencode-go" },
      [{ id: "model-a", provider: "opencode-go" }],
    );
    // Session runs model-a at the driver's default low effort; the space
    // pins high. The turn start re-applies the default role (the #64 path
    // carries the effort with the model) — one switch, no further churn.
    await driver.reapplyDefaultModelRole();
    await driver.prompt("high effort");
    expect(setModelCalls).toEqual([{ modelId: "model-a", thinkingLevel: "high", persist: false }]);
    expect(thinkingCalls).toEqual([]);
    await driver.reapplyDefaultModelRole();
    await driver.prompt("still high");
    expect(setModelCalls).toEqual([{ modelId: "model-a", thinkingLevel: "high", persist: false }]); // unchanged → no re-application
  });

  test("a default the session cannot apply is logged and skipped — the turn still runs", async () => {
    const { driver, setModelCalls, promptCalls } = hotSwapDriver(
      { model: "ghost-model" },
      { id: "model-a", provider: "opencode-go" },
      [{ id: "model-a", provider: "opencode-go" }],
    );
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(driver.reapplyDefaultModelRole()).resolves.toBeUndefined();
      await expect(driver.prompt("still answers")).resolves.toBeUndefined();
      // No switch, no silent no-reply: the turn ran on the current model.
      expect(setModelCalls).toEqual([]);
      expect(promptCalls).toEqual(["still answers"]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("turn-start default model re-apply failed in slack:C1"),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test("the seam marks the session in-flight while it runs — a concurrent message steers, never a second fresh turn", async () => {
    let releaseSettings: ((settings: SpaceModelSettings) => void) | undefined;
    const settingsPromise = new Promise<SpaceModelSettings>((resolve) => {
      releaseSettings = resolve;
    });
    const stub = statefulStubSession(
      { id: "model-a", provider: "opencode-go" },
      [{ id: "model-a", provider: "opencode-go" }, { id: "model-b", provider: "opencode-go" }],
    );
    const driver = new OmpSessionDriver({
      spaceId: "slack:C1",
      session: stub.session,
      onOutput: () => {},
      getModelSettings: async () => settingsPromise, // held: the reapply is in flight
    });
    const reapply = driver.reapplyDefaultModelRole();
    // The reapply flips the driver's in-flight view SYNCHRONOUSLY, so the
    // service's stream-vs-fresh decision (and any racing prompt) steers
    // into the opening turn instead of opening a second one.
    expect(driver.isStreaming()).toBe(true);
    releaseSettings?.({ model: "model-b" });
    await reapply;
    expect(driver.isStreaming()).toBe(false);
    expect(stub.setModelCalls).toEqual([{ modelId: "model-b", thinkingLevel: undefined, persist: false }]);
  });

  test("a failing settings read never blocks the turn — best-effort, logged", async () => {
    const stub = statefulStubSession(
      { id: "model-a", provider: "opencode-go" },
      [{ id: "model-a", provider: "opencode-go" }],
    );
    const driver = new OmpSessionDriver({
      spaceId: "slack:C1",
      session: stub.session,
      onOutput: () => {},
      getModelSettings: async () => {
        throw new Error("settings store unavailable");
      },
    });
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The seam swallows the settings-read failure: the service always
      // proceeds to open the turn on the session's current model.
      await expect(driver.reapplyDefaultModelRole()).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("turn-start default model re-apply failed in slack:C1"),
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("OmpSessionDriver error surfacing (issue #78)", () => {
  /** Stub SDK session exposing the subscribe listener for event injection. */
  function stubSession() {
    let listener: ((event: StubSessionEvent) => void) | undefined;
    // SAFETY: the stub implements exactly the members OmpSessionDriver
    // calls (subscribe + lifecycle); the rest of AgentSession is never
    // touched by these tests.
    const session = {
      subscribe: (cb: (event: StubSessionEvent) => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      beginDispose: () => {},
      dispose: async () => {},
      isStreaming: false,
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      getAvailableModels: () => [],
    } as never;
    return {
      session,
      emit: (event: StubSessionEvent) => listener?.(event),
    };
  }

  test("an empty provider-error completion delivers an empty message carrying its cause (issue #226)", async () => {
    const { session, emit } = stubSession();
    const turnEnds: unknown[] = [];
    const messages: unknown[] = [];
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    driver.on("turn_end", (data) => turnEnds.push(data));
    driver.on("message", (data) => messages.push(data));

    const CAUSE = "400 No tool output found for tool call call_repro_1";
    // The SDK's provider-error shape: empty content + stopReason "error" +
    // errorMessage, then turn_end (no message_update in between).
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: CAUSE,
      },
    });
    emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "" }] } });

    // Issue #226: the empty completion IS delivered (with its cause) so the
    // presenter can surface the visible retry note — never a silent no-reply.
    // Pre-fix this was `toHaveLength(0)`: the empty turn was invisible.
    expect(messages).toEqual([{ spaceId: "slack:C1", text: "", error: CAUSE }]);
    expect(turnEnds).toEqual([{ spaceId: "slack:C1", error: CAUSE }]);
  });

  test("a message_end with real text delivers it; the cause still rides turn_end", async () => {
    const { session, emit } = stubSession();
    const turnEnds: unknown[] = [];
    const messages: unknown[] = [];
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    driver.on("turn_end", (data) => turnEnds.push(data));
    driver.on("message", (data) => messages.push(data));

    emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial " } });
    emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "partial reply" } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial reply" }], stopReason: "error", errorMessage: "boom mid-stream" } });
    emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "partial reply" }] } });

    expect(messages).toEqual([{ spaceId: "slack:C1", text: "partial reply" }]);
    expect(turnEnds).toEqual([{ spaceId: "slack:C1", error: "boom mid-stream" }]);
  });

  test("turn_start clears the previous turn's cause; silent turn_end carries none", async () => {
    const { session, emit } = stubSession();
    const turnEnds: unknown[] = [];
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    driver.on("turn_end", (data) => turnEnds.push(data));

    emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "stale cause" } });
    emit({ type: "turn_end", message: {} });
    emit({ type: "turn_start" });
    emit({ type: "turn_end", message: {} });

    expect(turnEnds).toEqual([
      { spaceId: "slack:C1", error: "stale cause" },
      { spaceId: "slack:C1", error: undefined },
    ]);
  });

  test("a notice-level error is stashed AND still emitted as a driver error event", async () => {
    const { session, emit } = stubSession();
    const errors: unknown[] = [];
    const turnEnds: unknown[] = [];
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    driver.on("error", (data) => errors.push(data));
    driver.on("turn_end", (data) => turnEnds.push(data));

    emit({ type: "notice", level: "error", message: "background flush failed" });
    emit({ type: "turn_end", message: {} });

    expect(errors).toEqual([{ spaceId: "slack:C1", message: "background flush failed" }]);
    expect(turnEnds).toEqual([{ spaceId: "slack:C1", error: "background flush failed" }]);
  });
});

describe("OmpSessionDriver todo read seam (issue #228)", () => {
  /** Stub SDK session exposing the subscribe listener + a scripted todo plan. */
  function stubSession(phases: TodoPhase[]) {
    let listener: ((event: StubSessionEvent) => void) | undefined;
    // SAFETY: the stub implements exactly the members OmpSessionDriver
    // calls (subscribe + getTodoPhases + lifecycle); the rest of
    // AgentSession is never touched by these tests.
    const session = {
      subscribe: (cb: (event: StubSessionEvent) => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      getTodoPhases: () => phases,
      beginDispose: () => {},
      dispose: async () => {},
      isStreaming: false,
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      getAvailableModels: () => [],
    } as never;
    return {
      session,
      emit: (event: StubSessionEvent) => listener?.(event),
    };
  }

  /** The SDK's todo tool result shape: TodoToolDetails under result.details. */
  function todoResult(phases: TodoPhase[]): JsonObject {
    return {
      content: [{ type: "text", text: "ok" }],
      details: { op: "init", phases, storage: "session" },
    } as unknown as JsonObject;
  }

  const PLAN: TodoPhase[] = [
    {
      name: "Research",
      tasks: [{ content: "Read the repo", status: "completed" }, { content: "Draft the section", status: "in_progress" }],
    },
    { name: "Land", tasks: [{ content: "Push + PR", status: "pending" }] },
  ];

  test("getTodoPhases returns the SDK session's live plan (pull path)", async () => {
    const { session } = stubSession(PLAN);
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });

    expect(driver.getTodoPhases()).toBe(PLAN);
  });

  test("a todo tool_execution_end pushes the result's phases as a todo_phases driver event", async () => {
    const { session, emit } = stubSession([]);
    const todoEvents: unknown[] = [];
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    driver.on("todo_phases", (data) => todoEvents.push(data));

    emit({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "todo",
      result: todoResult(PLAN),
      isError: false,
    });

    expect(todoEvents).toEqual([{ spaceId: "slack:C1", phases: PLAN }]);
  });

  test("non-todo and malformed tool executions never emit todo_phases", async () => {
    const { session, emit } = stubSession([]);
    const todoEvents: unknown[] = [];
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    driver.on("todo_phases", (data) => todoEvents.push(data));

    // Another tool's result: no details.phases, must be ignored.
    emit({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: { content: [{ type: "text", text: "file contents" }] },
      isError: false,
    });
    // The todo tool with a malformed result (no phases array): skipped, never thrown.
    emit({
      type: "tool_execution_end",
      toolCallId: "call_2",
      toolName: "todo",
      result: { content: [{ type: "text", text: "error" }], isError: true },
      isError: true,
    });
    // The todo tool carrying an empty plan: an EMPTY snapshot is still a
    // snapshot (the presenter's empty-tolerant "no active plan" path).
    emit({
      type: "tool_execution_end",
      toolCallId: "call_3",
      toolName: "todo",
      result: todoResult([]),
      isError: false,
    });

    expect(todoEvents).toEqual([{ spaceId: "slack:C1", phases: [] }]);
  });
});

describe("empty completions surface at the presenter (issue #226)", () => {
  /** Stub SDK session exposing the subscribe listener for event injection. */
  function stubSession() {
    let listener: ((event: StubSessionEvent) => void) | undefined;
    // SAFETY: the stub implements exactly the members OmpSessionDriver
    // calls (subscribe + lifecycle); the rest of AgentSession is never
    // touched by these tests.
    const session = {
      subscribe: (cb: (event: StubSessionEvent) => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      beginDispose: () => {},
      dispose: async () => {},
      isStreaming: false,
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      getAvailableModels: () => [],
    } as never;
    return {
      session,
      emit: (event: StubSessionEvent) => listener?.(event),
    };
  }

  /** The presenter's Slack surface as a recording double (no network). */
  function recordingSurface() {
    const posts: Array<{ text: string }> = [];
    const updates: Array<{ ts: string; text: string }> = [];
    let tsSeq = 0;
    const adapter = {
      async postMessage(_spaceId: string, text: string) {
        posts.push({ text });
        tsSeq += 1;
        return `post-${tsSeq}`;
      },
      async updateMessage(_spaceId: string, ts: string, text: string) {
        updates.push({ ts, text });
      },
      async downloadFile() {
        throw new Error("not used");
      },
      async uploadFile() {
        return undefined;
      },
      async addReaction() {},
      async removeReaction() {},
      async startStream() {
        throw new Error("not used");
      },
      async appendText() {},
      async appendTask() {},
      async stopStream() {},
      streamingSupported: () => false,
      async start() {},
      async stop() {},
    } as SlackAdapter;
    const store = {
      appendAudit: async (_entry: { space_id: string | null; actor: string; event_type: string; payload: string }) => 1,
      getOrgSettings: (): OrgSettings | null => null,
    } as Store;
    return { adapter, store, posts, updates };
  }

  /** Flushes the presenter's fire-and-forget promise chains (phrase post, reactions, audits). */
  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  test("a session whose model returns an empty completion produces a visible retry note at the Slack surface", async () => {
    const { session, emit } = stubSession();
    const { adapter, store, posts, updates } = recordingSurface();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter,
      store,
      onboardingChecks: () => [],
    });
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    driver.on("turn_start", () => presenter.onTurnStart());
    driver.on("message", (data) => presenter.onMessage(data));
    driver.on("turn_end", (data) => presenter.onTurnEnd(data));

    // The turn opens the way a real channel turn does: receipt phrase, then
    // the SDK's turn events. The model completes with EMPTY content.
    presenter.onInbound({ spaceId: "slack:C1", principal: "U1", text: "hello", ts: "1.1" });
    await flush();
    expect(posts.map((p) => p.text)).toEqual(["Thinking…"]);

    const CAUSE = "400 No tool output found for tool call call_repro_1";
    emit({ type: "turn_start" });
    await flush();
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: CAUSE,
      },
    });
    await flush();
    emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "" }] } });
    await flush();

    // The visible retry note replaced the phrase IN PLACE and names the
    // cause — the empty turn is never a silent no-reply. Pre-fix the driver
    // dropped the empty completion, so only the phrase rotation was visible
    // and this assertion failed (nothing emitted).
    const visible = updates.at(-1)!.text;
    expect(visible).toContain("empty response");
    expect(visible).toContain(CAUSE);
  });
});

describe("OmpSessionDriver live thinking (issue #193)", () => {
  /** Stub SDK session exposing the subscribe listener for event injection. */
  function stubSession() {
    let listener: ((event: StubSessionEvent) => void) | undefined;
    // SAFETY: the stub implements exactly the members OmpSessionDriver
    // calls (subscribe + lifecycle); the rest of AgentSession is never
    // touched by these tests.
    const session = {
      subscribe: (cb: (event: StubSessionEvent) => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      beginDispose: () => {},
      dispose: async () => {},
      isStreaming: false,
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      getAvailableModels: () => [],
    } as never;
    return {
      session,
      emit: (event: StubSessionEvent) => listener?.(event),
    };
  }

  test("thinking deltas stream as live 'thinking' events; message_end carries the final reasoning", async () => {
    const { session, emit } = stubSession();
    const thinking: unknown[] = [];
    const messages: unknown[] = [];
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    driver.on("thinking", (data) => thinking.push(data));
    driver.on("message", (data) => messages.push(data));

    // Each delta re-emits the accumulated reasoning — a long reasoning
    // phase updates the presenter live, not only at message_end.
    emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Let me " } });
    emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "check the repo" } });
    expect(thinking).toEqual([
      { spaceId: "slack:C1", thinking: "Let me" }, // accumulated text is trimmed
      { spaceId: "slack:C1", thinking: "Let me check the repo" },
    ]);

    // The completed message's content blocks are the authoritative final
    // snapshot (replay path — deltas don't re-fire on recovery).
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Let me check the repo" }] } });
    expect(thinking.at(-1)).toEqual({ spaceId: "slack:C1", thinking: "Let me check the repo" });

    // A following text-only message emits no thinking (per-message reset).
    emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
    // Issue #226: the thinking-only message_end above is an empty completion
    // (reasoning without deliverable text — the #60 root cause) and now
    // still delivers an empty message event so the presenter surfaces the
    // retry note; the text message delivers normally.
    expect(messages).toEqual([
      { spaceId: "slack:C1", text: "" },
      { spaceId: "slack:C1", text: "hi" },
    ]);
    expect(thinking).toHaveLength(3);
  });

  test("multiple thinking blocks join in content order; unknown shapes never emit (fail closed)", async () => {
    const { session, emit } = stubSession();
    const thinking: unknown[] = [];
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    driver.on("thinking", (data) => thinking.push(data));

    // Two blocks on one message: content-order join at message_end.
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "first pass" },
          { type: "toolCall", name: "bash" },
          { type: "thinking", thinking: "second pass" },
        ],
      },
    });
    expect(thinking).toEqual([{ spaceId: "slack:C1", thinking: "first pass\nsecond pass" }]);

    // Redacted / empty / unknown content blocks carry no readable thinking:
    // nothing is emitted, never a crash into the turn path.
    thinking.length = 0;
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "redactedThinking", data: "opaque" }] } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "   " }] } });
    emit({ type: "message_end", message: { role: "assistant", content: "not-an-array" } });
    emit({ type: "message_end", message: null });
    expect(thinking).toHaveLength(0);
  });
});

describe("OmpSessionDriver per-turn principal (issue #152/#178)", () => {
  /**
   * Stub SDK session: controllable streaming, records prompt/steer/followUp,
   * injectable events. The SDK's `prompt` resolves only when the WHOLE turn
   * ends (all tool rounds + the final message), so the stub's prompt stays
   * pending until the test calls `endTurn()` — that is what makes
   * per-round `turn_end` events distinguishable from the true turn end.
   */
  function stubTurnSession() {
    let listener: ((event: StubSessionEvent) => void) | undefined;
    let streaming = false;
    let finishTurn: (() => void) | undefined;
    const calls: Array<{ kind: "prompt" | "steer" | "followUp"; text: string }> = [];
    // SAFETY: the stub implements exactly the members OmpSessionDriver
    // calls (streaming prompt lifecycle + event injection); the rest of
    // AgentSession is never touched by these tests.
    const session = {
      subscribe: (cb: (event: StubSessionEvent) => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      beginDispose: () => {},
      dispose: async () => {},
      get isStreaming() {
        return streaming;
      },
      prompt: async (text: string) => {
        streaming = true;
        calls.push({ kind: "prompt", text });
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        streaming = false;
      },
      steer: async (text: string) => {
        calls.push({ kind: "steer", text });
      },
      followUp: async (text: string) => {
        calls.push({ kind: "followUp", text });
      },
      abort: async () => {},
      getAvailableModels: () => [],
    } as never;
    return {
      session,
      calls,
      emit: (event: StubSessionEvent) => listener?.(event),
      setStreaming: (v: boolean) => {
        streaming = v;
      },
      endTurn: () => {
        finishTurn?.();
        finishTurn = undefined;
      },
    };
  }

  test("a fresh prompt binds the inbound principal; steer/followUp keep it; the opening prompt's resolution drops it", async () => {
    const { session, emit, endTurn } = stubTurnSession();
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });

    // A's message opens the turn: A is bound for every call in the turn.
    // The opening prompt stays pending until endTurn() — like the SDK's
    // prompt, which resolves only when the whole turn completes.
    const opening = driver.prompt("a's message", { principal: "UA" });
    expect(driver.getTurnPrincipal()).toBe("UA");

    // B steers into A's in-flight turn: the binding stays A's — B's
    // personal credential must never resolve for A's extension calls.
    await driver.prompt("b's message", { streamingBehavior: "steer", principal: "UB" });
    await driver.prompt("b's follow-up", { streamingBehavior: "followUp", principal: "UB" });
    expect(driver.getTurnPrincipal()).toBe("UA");

    // The SDK's agent loop emits turn_end after EVERY tool round
    // (willContinue true): a round boundary is NOT the turn end, so the
    // binding must survive it (issue #178).
    emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "round done" }] } });
    expect(driver.getTurnPrincipal()).toBe("UA");

    // The turn truly ends when the OPENING prompt resolves: the binding
    // drops (fail closed between turns — the next fresh turn rebinds).
    endTurn();
    await opening;
    expect(driver.getTurnPrincipal()).toBeUndefined();

    // B's own message starts B's turn: B binds.
    const second = driver.prompt("b's next message", { principal: "UB" });
    expect(driver.getTurnPrincipal()).toBe("UB");
    endTurn();
    await second;
  });

  test("a turn nobody started (digest) binds no principal", async () => {
    const { session, endTurn } = stubTurnSession();
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });

    const opening = driver.prompt("summarize", { silent: true });
    expect(driver.getTurnPrincipal()).toBeUndefined();
    endTurn();
    await opening;
    expect(driver.getTurnPrincipal()).toBeUndefined();
  });

  test("a continued tool round in the same turn keeps the turn principal — never 'agent' (issue #178)", async () => {
    const { session, emit, endTurn } = stubTurnSession();
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });

    // The user's write request opens the turn: the principal binds once.
    const opening = driver.prompt("can you create a test issue", { principal: "U0B9QUPCTJ5" });
    expect(driver.getTurnPrincipal()).toBe("U0B9QUPCTJ5");

    // Round 1: the first tool call runs under the principal.
    emit({ type: "turn_start" });
    emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "github_issue_write", args: {} });
    expect(driver.getTurnPrincipal()).toBe("U0B9QUPCTJ5");
    emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "github_issue_write", result: { content: [] }, isError: false });
    // Round boundary: the SDK's agent loop emits turn_end + turn_start
    // between rounds. The old code cleared the binding here — the retry
    // then hit the credential ladder as caller "agent" (#178's live
    // evidence: extension.call {tool:"issue_write", actor:"agent"}).
    emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "github_issue_write", arguments: {} }] }, toolResults: [] });
    expect(driver.getTurnPrincipal()).toBe("U0B9QUPCTJ5");

    // Round 2: the model's retried write call executes under the SAME
    // principal — the personal credential still resolves.
    emit({ type: "turn_start" });
    emit({ type: "tool_execution_start", toolCallId: "call_2", toolName: "github_issue_write", args: {} });
    expect(driver.getTurnPrincipal()).toBe("U0B9QUPCTJ5");
    emit({ type: "tool_execution_end", toolCallId: "call_2", toolName: "github_issue_write", result: { content: [] }, isError: true });
    emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "toolCall", id: "call_2", name: "github_issue_write", arguments: {} }] }, toolResults: [] });
    expect(driver.getTurnPrincipal()).toBe("U0B9QUPCTJ5");

    // The turn ends when the opening prompt resolves: the binding drops.
    endTurn();
    await opening;
    expect(driver.getTurnPrincipal()).toBeUndefined();
  });

  test("full path: one execution per tool call, every round audited with the turn principal + resolved credential — no wire-name 'agent' duplicate (issue #178)", async () => {
    const { session, emit, endTurn } = stubTurnSession();
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });

    const store = createStore(":memory:");
    const boundaryCalls: ExtensionCredential[] = [];
    const mcpTransport = (_binding: McpBinding): Transport => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        return { content: [{ type: "text", text: `sunny in ${String(request.params.arguments?.["city"] ?? "")}` }] };
      });
      void server.connect(serverTransport);
      return clientTransport;
    };
    const runtime = createExtensionRuntime({
      registry: createFixtureRegistry(),
      store,
      audit: createAudit(store),
      // org denied so the ladder resolves the CALLER's personal row (never
      // falls through to an org credential for the wrong principal).
      orgPolicy: parseOrgConfigYaml("tools:\n  unknown: allow\nextensions:\n  org_credentials: deny\n"),
      router: DenyRouter,
      boundary: {
        async runWithAuthorization(request, invoke) {
          boundaryCalls.push(request.credential);
          return invoke({
            callId: request.callId,
            placeholder: "test-placeholder",
            signal: new AbortController().signal,
          });
        },
      },
      mcpTransport,
    });
    await store.upsertExtensionCredential({
      provider: FIXTURE_EXTENSION_ID,
      identityKey: "email:u0b9qupctj5@example.com",
      owner: "U0B9QUPCTJ5",
      scope: "personal",
      brokerCredentialId: 2,
    });
    const [definition] = extensionToolDefinitions(createFixtureRegistry().list(), {
      runtime,
      // The server adapter wires exactly this seam (issue #152): the caller
      // of every extension call is the turn principal of the space the
      // session file names.
      getCaller: () => driver.getTurnPrincipal(),
    });
    // SAFETY: execute() reads only ctx.sessionManager.getSessionFile() here;
    // the stub provides exactly that and the rest is never touched.
    const ctx: Parameters<typeof definition.execute>[4] = {
      sessionManager: { getSessionFile: () => "slack:C1.jsonl" },
    } as never;

    // The user's write request opens the turn: the principal binds once.
    const opening = driver.prompt("can you create a test issue", { principal: "U0B9QUPCTJ5" });
    expect(driver.getTurnPrincipal()).toBe("U0B9QUPCTJ5");

    // Round 1: ONE tool request → exactly ONE execution, audited with the
    // turn principal + the resolved personal credential.
    emit({ type: "turn_start" });
    const first = await definition.execute("call_1", { city: "Lisbon" }, undefined, undefined, ctx);
    expect(first.isError).not.toBe(true);
    let rows = await store.listAudit({ event_type: EXTENSION_CALL_EVENT });
    expect(rows).toHaveLength(1);
    // SAFETY: audit payloads are JSON.stringify'd by the runtime before the
    // row is written; the assertion reads only the fields it names.
    const payload0 = JSON.parse(rows[0]!.payload) as JsonObject;
    expect(payload0).toMatchObject({
      actor: "U0B9QUPCTJ5",
      decision: "allow",
    });
    expect(payload0["credential_id"]).toBeTruthy();
    expect(boundaryCalls).toHaveLength(1);
    expect(boundaryCalls[0]!.owner).toBe("U0B9QUPCTJ5");
    emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "weather.current", arguments: {} }] }, toolResults: [] });

    // Round 2 (the model's retry): the SAME principal is still bound — the
    // ladder resolves the personal credential again, never "agent", and the
    // second call is a distinct execution (not a duplicate of round 1).
    emit({ type: "turn_start" });
    const second = await definition.execute("call_2", { city: "Porto" }, undefined, undefined, ctx);
    expect(second.isError).not.toBe(true);
    rows = await store.listAudit({ event_type: EXTENSION_CALL_EVENT });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // SAFETY: audit payloads are JSON.stringify'd by the runtime before
      // the row is written; the assertion reads only named fields.
      const payload = JSON.parse(row.payload) as JsonObject;
      expect(payload).toMatchObject({ actor: "U0B9QUPCTJ5", decision: "allow" });
    }
    expect(boundaryCalls).toHaveLength(2);
    expect(boundaryCalls[1]!.owner).toBe("U0B9QUPCTJ5");
    emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "toolCall", id: "call_2", name: "weather.current", arguments: {} }] }, toolResults: [] });

    // The turn ends when the opening prompt resolves: fail closed between turns.
    endTurn();
    await opening;
    expect(driver.getTurnPrincipal()).toBeUndefined();
    store.close();
  });
});

describe("OmpSessionDriver run settlement (issue #183)", () => {
  /**
   * Stub SDK session exposing the busy-wait failure the SDK throws when a
   * prior agent run never settled: prompt() throws the SDK's
   * "Timed out waiting for prior agent run to finish before prompting."
   * error while the agent run is still "streaming", and the caller recovers
   * by aborting. The stub records prompt/steer/abort calls and lets the
   * test drive the streaming flag.
   *
   * - `failBusyTimes`: how many prompt() calls throw the busy error before
   *   succeeding (the SDK's one-shot timeout; the driver aborts + retries).
   * - `ghostAfterPrompt`: when true, a successful prompt leaves the session
   *   STILL streaming (the run never settled — the driver must abort it).
   */
  function busyStubSession() {
    let streaming = false;
    let failBusyTimes = 0;
    let ghostAfterPrompt = false;
    const calls: Array<{ kind: "prompt" | "steer" | "followUp" | "abort"; text?: string }> = [];
    // SAFETY: the stub implements exactly the members OmpSessionDriver
    // calls (busy-wait prompt/abort lifecycle); the rest of AgentSession is
    // never touched by these tests.
    const session = {
      subscribe: () => () => {},
      beginDispose: () => {},
      dispose: async () => {},
      get isStreaming() {
        return streaming;
      },
      prompt: async (text: string) => {
        calls.push({ kind: "prompt", text });
        if (failBusyTimes > 0) {
          failBusyTimes -= 1;
          streaming = true; // a prior run is streaming — the SDK busy-waits then throws
          throw new Error("Timed out waiting for prior agent run to finish before prompting.");
        }
        streaming = ghostAfterPrompt; // settled unless the test wants a ghost
      },
      steer: async (text: string) => {
        calls.push({ kind: "steer", text });
      },
      followUp: async (text: string) => {
        calls.push({ kind: "followUp", text });
      },
      abort: async () => {
        calls.push({ kind: "abort" });
        streaming = false;
      },
      getAvailableModels: () => [],
    } as never;
    return {
      session,
      calls,
      setStreaming: (v: boolean) => {
        streaming = v;
      },
      setFailBusyTimes: (n: number) => {
        failBusyTimes = n;
      },
      setGhostAfterPrompt: (v: boolean) => {
        ghostAfterPrompt = v;
      },
    };
  }

  test("a fresh prompt that hits the SDK's busy-wait aborts the stale run and retries once — the turn still runs", async () => {
    const { session, calls, setFailBusyTimes } = busyStubSession();
    const errors: unknown[] = [];
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    driver.on("error", (data) => errors.push(data));
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // The session reports idle, but the prior agent run never settled: the
    // first fresh prompt throws the SDK's busy-wait timeout. The driver
    // must recover — abort the stale run, retry once — never throw into the
    // caller (which would be a silent no-reply for the user).
    setFailBusyTimes(1);
    await expect(driver.prompt("second message", { principal: "U1" })).resolves.toBeUndefined();
    expect(calls.filter((c) => c.kind === "abort")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "prompt")).toHaveLength(2); // original + retry
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("prior agent run did not settle before prompting in slack:C1"),
    );
    // The retry RAN (no busy error surfaced, no silent no-reply).
    expect(errors).toHaveLength(0);
    expect(driver.getTurnPrincipal()).toBeUndefined(); // turn ended cleanly
  });

  test("a fresh prompt that stays busy even after the abort surfaces loudly via the error event", async () => {
    const { session, calls, setFailBusyTimes } = busyStubSession();
    const errors: unknown[] = [];
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    driver.on("error", (data) => errors.push(data));
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    setFailBusyTimes(2); // original AND the retry both hit the busy-wait
    await expect(driver.prompt("second message", { principal: "U1" })).rejects.toThrow(
      "Timed out waiting for prior agent run to finish before prompting.",
    );
    expect(calls.filter((c) => c.kind === "abort")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "prompt")).toHaveLength(2);
    // The reason surfaces through the driver error event (the presenter
    // replaces the thinking phrase with it) — never a silent no-reply.
    expect(errors).toEqual([
      { spaceId: "slack:C1", message: expect.stringContaining("prior agent run did not settle") },
    ]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("session still busy after aborting"));
  });

  test("a turn that ends without settling its run is aborted loudly — the next prompt never hits the busy-wait", async () => {
    const { session, calls, setGhostAfterPrompt } = busyStubSession();
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // The prompt RESOLVES, but the session still reports streaming — a
    // ghost run outlived its turn (the stream/panel path's queued
    // continuation). The driver must abort it so the next prompt never
    // busy-waits, and log the reason loudly.
    setGhostAfterPrompt(true);
    await driver.prompt("first message", { principal: "U1" });
    expect(calls.filter((c) => c.kind === "abort")).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("agent run did not settle after the turn in slack:C1"),
    );
  });

  test("steering into a ghost run (streaming, no fresh turn pending) aborts it and runs fresh — never a silent queue", async () => {
    const { session, calls, setStreaming } = busyStubSession();
    const driver = new OmpSessionDriver({ spaceId: "slack:C1", session, onOutput: () => {} });
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // A prior stream/panel turn left the session reporting streaming with
    // NO fresh turn of ours pending: steering would queue into a dead run
    // (silent no-reply). The driver force-settles the ghost and runs the
    // message as a fresh turn.
    setStreaming(true);
    await driver.prompt("after the stream turn", { streamingBehavior: "steer", principal: "U1" });
    expect(calls.filter((c) => c.kind === "abort")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "steer")).toHaveLength(0); // never steered into the ghost
    expect(calls.filter((c) => c.kind === "prompt")).toHaveLength(1); // ran fresh instead
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("no fresh turn pending in slack:C1"),
    );
    expect(driver.getTurnPrincipal()).toBeUndefined(); // fresh turn ended cleanly
  });
});

describe("process-global agent dir + boot guard (issue #80)", () => {
  const PROVIDER = "agentdir-test";
  const MODEL_ID = "model-1";
  const STUB_BASE_URL = "http://127.0.0.1:4891/v1";

  /** A temp agent dir whose models.yml declares ONE provider with an inline key. */
  function agentDirWithCatalog() {
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
      // SAFETY: execute() reads only ctx.sessionManager.getSessionFile();
      // the stub provides exactly that and the rest is never touched.
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
      // SAFETY: the policy gate writes the decision payload via
      // JSON.stringify of { tool, decision } before auditing.
      const decisions = rows.map((row) => JSON.parse(row.payload) as { tool: string; decision: string });
      expect(decisions.find((row) => row.tool === "memory.save")?.decision).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("withPolicyGate thinking-step emission (issue #168)", () => {
  interface StepSinkCall {
    spaceId?: string;
    taskId: string;
    title: string;
    status: "in_progress" | "complete";
    output?: string;
  }

  function gatedReadTool(opts: {
    orgYaml?: string;
    sink?: (step: StepSinkCall) => void;
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "gate-steps-"));
    const store = createStore(join(dir, "test.db"));
    const audit = createAudit(store);
    const steps: StepSinkCall[] = [];
    const sink = opts.sink ?? ((step) => steps.push(step));
    const orgPolicy = parseOrgConfigYaml(opts.orgYaml ?? "tools:\n  read: allow\n");
    const tool = withPolicyGate(
      {
        name: "read",
        label: "Read file",
        description: "Reads a file",
        parameters: z.object({ path: z.string() }),
        async execute(_toolCallId: string, _params: { path: string; api_key?: string }, _signal: AbortSignal | undefined, _onUpdate: AgentToolUpdateCallback | undefined, _ctx: ExtensionContext) {
          return { content: [{ type: "text", text: "file contents" }] };
        },
      },
      {
        orgPolicy,
        audit,
        router: DenyRouter,
        store,
        onToolStep: sink,
      },
    );
    const cleanup = () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    };
    // SAFETY: execute() reads only ctx.sessionManager.getSessionFile(); the
    // stub provides exactly that and the rest is never touched.
    const ctx = { sessionManager: { getSessionFile: () => join(dir, "sessions", "slack:C1.jsonl") } } as never;
    return { tool, steps, ctx, cleanup };
  }

  test("an allowed call emits in_progress then complete on one shared card", async () => {
    const { tool, steps, ctx, cleanup } = gatedReadTool();
    try {
      const result = await tool.execute("c1", { path: "/x" }, undefined, undefined, ctx);
      expect(result).toEqual({ content: [{ type: "text", text: "file contents" }] });
      expect(steps).toHaveLength(2);
      expect(steps[0]).toMatchObject({ spaceId: "slack:C1", status: "in_progress", title: "read — allowed (read)" });
      expect(steps[1]).toMatchObject({ spaceId: "slack:C1", status: "complete", title: "read — allowed (read)" });
      expect(steps[0]!.taskId).toBe(steps[1]!.taskId);
    } finally {
      cleanup();
    }
  });

  test("a denied call emits a single terminal deny step", async () => {
    const { tool, steps, ctx, cleanup } = gatedReadTool({ orgYaml: "tools:\n  read: deny\n" });
    try {
      await expect(tool.execute("c1", { path: "/x" }, undefined, undefined, ctx)).rejects.toThrow("denies");
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({ spaceId: "slack:C1", status: "complete", title: "read — denied (read)" });
    } finally {
      cleanup();
    }
  });

  test("secret-shaped args are redacted in the step output, never raw", async () => {
    const { tool, steps, ctx, cleanup } = gatedReadTool();
    try {
      await tool.execute("c1", { path: "/x", api_key: "sk-ant-api03-0123456789abcdef" }, undefined, undefined, ctx);
      const joined = steps.map((s) => s.output ?? "").join(" ");
      expect(joined).not.toContain("sk-ant-api03-0123456789abcdef");
      expect(joined).toContain("[REDACTED]");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// search_web cited-table dispatch (issue #278): a SUCCESSFUL search_web call
// through the policy gate must hand its parsed cited rows to the
// onSearchResults sink (the presenter's blocks seam) — the acceptance is
// "the cited table reaches the human", not just JSON to the model. Fail
// closed: a missing key or a non-search tool never dispatches.
// ---------------------------------------------------------------------------

describe("withPolicyGate search_web cited-result dispatch (issue #278)", () => {
  function searchToolHarness(opts: { sink?: (spaceId: string, results: readonly SearchResultRow[]) => void } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "search-dispatch-"));
    const store = createStore(join(dir, "test.db"));
    const audit = createAudit(store);
    const orgPolicy = parseOrgConfigYaml("tools:\n  search_web: allow\n");
    const secretDir = join(dir, "secrets");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, `${SEARCH_PROVIDER}.secret`), "tvly-stub", { mode: 0o600 });
    const calls: Array<{ spaceId: string; results: readonly SearchResultRow[] }> = [];
    const sink = opts.sink ?? ((spaceId, results) => void calls.push({ spaceId, results }));
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          results: [
            { title: "Bottega", url: "https://example.com/bottega", content: "The harness." },
            { title: "Proxy", url: "https://example.com/proxy", snippet: "Keys ride a seam." },
          ],
        }),
    });
    const tool = withPolicyGate(
      searchWebToolDefinition({ baseUrl: `http://127.0.0.1:${server.port}`, secretsDir: secretDir }),
      {
        orgPolicy,
        audit,
        router: DenyRouter,
        store,
        onSearchResults: sink,
      },
    );
    const cleanup = () => {
      server.stop(true);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    };
    // SAFETY: execute() reads only ctx.sessionManager.getSessionFile(); the
    // stub provides exactly that and the rest is never touched.
    const ctx = { sessionManager: { getSessionFile: () => join(dir, "sessions", "slack:C1.jsonl") } } as never;
    return { tool, calls, ctx, cleanup, secretDir };
  }

  test("a successful search_web call dispatches its parsed cited rows to the sink", async () => {
    const { tool, calls, ctx, cleanup } = searchToolHarness();
    try {
      const res = await tool.execute("c1", { query: "bottega" }, undefined, undefined, ctx);
      expect(res.isError).toBeFalsy();
      // The acceptance: the cited table actually reached the human, so the
      // gate forwarded the rows (the presenter posts them as blocks).
      expect(calls).toHaveLength(1);
      expect(calls[0]!.spaceId).toBe("slack:C1");
      expect(calls[0]!.results).toHaveLength(2);
      expect(calls[0]!.results[0]!.url).toBe("https://example.com/bottega");
      expect(calls[0]!.results[1]!.url).toBe("https://example.com/proxy");
    } finally {
      cleanup();
    }
  });

  test("an unseeded key fails closed AND never dispatches (fail closed end-to-end)", async () => {
    const { tool, calls, ctx, cleanup, secretDir } = searchToolHarness();
    try {
      // Remove the seeded key: the tool must report unavailable and the
      // sink must NOT fire (a fabricated/empty result must never post).
      rmSync(join(secretDir, `${SEARCH_PROVIDER}.secret`));
      const res = await tool.execute("c1", { query: "bottega" }, undefined, undefined, ctx);
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain("unavailable");
      expect(calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
