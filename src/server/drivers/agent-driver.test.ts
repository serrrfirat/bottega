import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, SessionManager, createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { connectExtensionToolDefinition } from "../../extensions/connect";
import { createFixtureRegistry } from "../../extensions/fixture";
import { extensionToolDefinitions } from "../../extensions/tools";
import type { ExtensionRuntime } from "../../extensions/runtime";
import { createAudit } from "../../policy/audit";
import { DenyRouter } from "../../policy/approval-router";
import { parseOrgConfigYaml } from "../../policy/config";
import { createStore } from "../../store/db";
import { createOmpSdkDriver, sessionIdFromFilePath, SPACE_AGENT_TOOLS, spaceAgentToolNames } from "./agent-driver";

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

  test("space-agent allowlist: conversation/read-only + task + queue/memory/connect tools, no executor tools", () => {
    // The space agent is a participant, not an executor: it may read the
    // workspace, delegate via task, and use the work-item + memory tools —
    // never write/bash/edit (those are EXECUTOR_TOOLS in executor.ts). The
    // connect capability (issue #52) is listed here; its definition rides
    // the custom-tools path, see createOmpSdkDriver.
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
