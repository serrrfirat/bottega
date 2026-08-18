import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRegistry,
  createAgentSession,
  z,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type Extension,
  type ExtensionUIContext,
  type LoadExtensionsResult,
} from "@oh-my-pi/pi-coding-agent";
import { parseYamlSubset } from "../../yaml-subset";
import { createAudit } from "../../policy/audit";
import { DenyRouter } from "../../policy/approval-router";
import { parseOrgConfigYaml } from "../../policy/config";
import { createStore } from "../../store/db";
import {
  assertAgentDirModelAvailable,
  createOmpSdkDriver,
  ensureAgentDirModelPin,
  opencodeSafeToolName,
  sessionFilePath,
  SPACE_AGENT_TOOLS,
  spaceAgentToolNames,
} from "./agent-driver";

/**
 * Direct hermetic coverage for createOmpSdkDriver / OmpSessionDriver (issue
 * #176 — the audit's highest-risk coverage gap). Unlike the fakes used
 * elsewhere, these tests exercise the REAL driver factory: real OMP SDK
 * sessions where a session can be created without a model call (lifecycle,
 * cold restore), the injected createSession seam where a session cannot
 * (exact options the driver builds, event plumbing), and the pure
 * agent-dir guards (#80 pin, #78 error preservation) as file/registry
 * behavior. No network, no model call.
 */

/** The SDK event shapes the error-surfacing test injects through the stub's emit seam. */
type InjectedSdkEvent =
  | {
      type: "message_end";
      message: {
        role: "assistant";
        content: Array<{ type: "text"; text: string }>;
        stopReason: string;
        errorMessage?: string;
      };
    }
  | { type: "turn_end"; message: { role: "assistant"; content: Array<{ type: "text"; text: string }> } };

/** Stub SDK session: captures the subscribe listener so tests can inject events. */
function stubSdkSession() {
  let listener: AgentSessionEventListener | undefined;
  const session: Partial<AgentSession> = {
    subscribe: (cb: AgentSessionEventListener) => {
      listener = cb;
      return () => {
        listener = undefined;
      };
    },
    beginDispose: () => {},
    dispose: async () => {},
    isStreaming: false,
    prompt: async (_text: string) => true,
    steer: async (_text: string) => {},
    followUp: async (_text: string) => {},
    abort: async () => {},
    getAvailableModels: () => [],
  };
  return {
    session,
    emit: (event: InjectedSdkEvent) => {
      // SAFETY: the injected events are the SDK's message_end/turn_end shapes
      // carrying the fields the driver reads; absent optional fields are inert.
      listener?.(event as AgentSessionEvent);
    },
  };
}

describe("createOmpSdkDriver lifecycle (real SDK session)", () => {
  test("createSession materializes the transcript at sessionFilePath and dispose is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-driver-lifecycle-"));
    try {
      const transcriptDir = join(dir, "sessions");
      const spaceId = "slack:C1";
      const driver = createOmpSdkDriver({ agentDir: join(dir, "agent") });
      const session = await driver.createSession({ spaceId, transcriptDir, onOutput: () => {} });

      // The durable space timeline exists at the exact session-file path with
      // a JSONL title header (the transcript the server restarts from).
      const file = sessionFilePath(transcriptDir, spaceId);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8").split("\n")[0].startsWith('{"type":"title"')).toBe(true);

      await session.dispose();
      // Idempotent: the SDK shares one settled dispose promise, so a second
      // dispose resolves instead of throwing (server restart paths + the
      // poller can both target the same session).
      await session.dispose();
      // Dispose is terminal and non-destructive: the transcript survives.
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cold restore: a prior turn in the transcript survives dispose + recreate, never truncated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-driver-coldrestore-"));
    try {
      const transcriptDir = join(dir, "sessions");
      const options = { spaceId: "slack:C1", transcriptDir, onOutput: () => {} };
      const driver = createOmpSdkDriver({ agentDir: join(dir, "agent") });

      const first = await driver.createSession(options);
      const file = sessionFilePath(transcriptDir, "slack:C1");
      // A completed turn in the SDK's own transcript format (the exact entry
      // shape the SDK appends during a live exchange — see data/sessions).
      const marker = "cold-restore marker turn";
      appendFileSync(
        file,
        JSON.stringify({
          type: "message",
          id: "aa11bb22",
          parentId: null,
          timestamp: "2026-08-17T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: marker }], attribution: "user", timestamp: 1786918585110 },
        }) + "\n",
      );
      const withTurn = readFileSync(file, "utf8");
      expect(withTurn).toContain(marker);
      await first.dispose();

      // A fresh session on the same space must resume the transcript, not
      // truncate or rewrite it: server restarts keep history intact.
      const second = await driver.createSession(options);
      const afterRestart = readFileSync(file, "utf8");
      expect(afterRestart).toContain(marker);
      expect(afterRestart).toBe(withTurn);
      await second.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createOmpSdkDriver toolset contract", () => {
  test("the created session's visible toolset is the allowlist + custom tools — never executor tools", async () => {
    // Hermetic via the injected seam: capture the EXACT options the driver
    // builds, then create a real SDK session from them and assert the
    // visible toolset. The gate mirrors the server's production wiring.
    const dir = mkdtempSync(join(tmpdir(), "omp-driver-tools-"));
    try {
      const store = createStore(join(dir, "test.db"));
      try {
        let captured: CreateAgentSessionOptions | undefined;
        const customTools = [
          {
            name: "weather.current",
            label: "weather.current",
            description: "Current weather",
            parameters: z.object({ city: z.string() }),
            async execute(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
              return { content: [{ type: "text", text: "sunny" }] };
            },
          },
          {
            name: "linear.search_issues",
            label: "linear.search_issues",
            description: "Search linear issues",
            parameters: z.object({ q: z.string() }),
            async execute(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
              return { content: [{ type: "text", text: "none" }] };
            },
          },
        ];
        const driver = createOmpSdkDriver({
          agentDir: join(dir, "agent"),
          customTools,
          gate: {
            orgPolicy: parseOrgConfigYaml(
              "tools:\n  read: allow\n  weather.current: allow\n  linear.search_issues: allow\n",
            ),
            audit: createAudit(store),
            router: DenyRouter,
            store,
          },
          createSession: async (options) => {
            captured = options;
            throw new Error("factory stub: no real session");
          },
        });
        await expect(
          driver.createSession({ spaceId: "slack:C1", transcriptDir: join(dir, "sessions"), onOutput: () => {} }),
        ).rejects.toThrow("factory stub: no real session");
        expect(captured).toBeDefined();

        // Restricted surface: the driver builds a restricted session whose
        // custom tools are allowlisted — the session's options name the full
        // allowlist (flattened for the opencode gateway, #78) + custom tools.
        expect(captured!.restrictToolNames).toBe(true);
        expect(captured!.allowRestrictedCustomTools).toBe(true);
        for (const name of SPACE_AGENT_TOOLS) {
          expect(captured!.toolNames).toContain(opencodeSafeToolName(name));
        }
        expect(captured!.toolNames).toContain("weather_current");
        expect(captured!.toolNames).toContain("linear_search_issues");
        // Custom definitions ride customTools under their gateway-safe flat
        // names — the dotted originals never reach the session.
        const customToolNames = (captured!.customTools ?? [])
          .map((tool) => tool.name)
          .filter((name) => name !== "");
        expect(customToolNames).toContain("weather_current");
        expect(customToolNames).toContain("linear_search_issues");
        expect(customToolNames).not.toContain("weather.current");

        // The REAL session built from the driver's exact options surfaces the
        // space-agent toolset: conversational/read-only tools + custom tools,
        // and never the executor tools (write/bash/edit are executor-only).
        const { session } = await createAgentSession(captured!);
        const active = session.getActiveToolNames();
        for (const name of ["read", "glob", "grep", "web_search", "task", "inspect_image"]) {
          expect(active).toContain(name);
        }
        expect(active).toContain("weather_current");
        expect(active).toContain("linear_search_issues");
        expect(active).not.toContain("write");
        expect(active).not.toContain("bash");
        expect(active).not.toContain("edit");
        session.beginDispose();
        await session.dispose();
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persona toolFloor merges into the allowlist (visibility-only, issue #130)", () => {
    // The persona floor only controls visibility: floor tools append to the
    // allowlist (deduped), after the allowlist and before extension tools.
    // The policy gate still decides whether a surfaced tool call is allowed.
    expect(spaceAgentToolNames([], undefined, ["linear.create_issue"])).toEqual([
      ...SPACE_AGENT_TOOLS,
      "linear.create_issue",
    ]);
    // Already-allowlisted floor tools dedupe.
    expect(spaceAgentToolNames([], undefined, ["read"])).toEqual([...SPACE_AGENT_TOOLS]);
    // Floor merges before extension tools.
    expect(spaceAgentToolNames(["ext.tool"], undefined, ["floor.tool"])).toEqual([
      ...SPACE_AGENT_TOOLS,
      "floor.tool",
      "ext.tool",
    ]);
    // An explicit allowTools override still gains the floor.
    expect(spaceAgentToolNames([], ["read", "grep"], ["floor.tool"])).toEqual(["read", "grep", "floor.tool"]);
  });

  test("a persona floor plumbed through allowTools reaches the session toolNames", async () => {
    // The server wires the floor exactly this way (space-service.ts):
    // allowTools: spaceAgentToolNames([], undefined, persona.toolFloor).
    const dir = mkdtempSync(join(tmpdir(), "omp-driver-floor-"));
    try {
      let captured: CreateAgentSessionOptions | undefined;
      const driver = createOmpSdkDriver({
        agentDir: join(dir, "agent"),
        createSession: async (options) => {
          captured = options;
          throw new Error("factory stub: no real session");
        },
      });
      await expect(
        driver.createSession({
          spaceId: "slack:C1",
          transcriptDir: join(dir, "sessions"),
          onOutput: () => {},
          allowTools: spaceAgentToolNames([], undefined, ["linear.create_issue"]),
        }),
      ).rejects.toThrow("factory stub: no real session");
      // The floor tool reaches the session toolNames under its gateway-safe
      // flat name (the allowlist vocabulary is flattened at the driver
      // boundary, #78); the canonical dotted name survives in the policy
      // gate's closure, never on the session surface.
      expect(captured?.toolNames).toContain("linear_create_issue");
      expect(captured?.toolNames).toContain("read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agent-dir model pin + boot guard (issue #78/#80)", () => {
  const PIN_ROLE = "openai-codex/gpt-5.6-luna";

  function tempTemplate(role = PIN_ROLE) {
    const dir = mkdtempSync(join(tmpdir(), "omp-pin-"));
    const templatePath = join(dir, "template-config.yml");
    const template = `# template\nsecrets:\n  enabled: true\nmodelRoles:\n  default: ${role}\n`;
    writeFileSync(templatePath, template);
    return { dir, templatePath, template };
  }

  test("ensureAgentDirModelPin seeds a missing agent-dir config from the template (created)", () => {
    const { dir, templatePath, template } = tempTemplate();
    try {
      const agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      expect(ensureAgentDirModelPin(agentDir, templatePath)).toBe("created");
      expect(readFileSync(join(agentDir, "config.yml"), "utf8")).toBe(template);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ensureAgentDirModelPin appends ONLY the modelRoles block to a stale-but-parseable config (patched)", () => {
    const { dir, templatePath } = tempTemplate();
    try {
      const agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      // A pre-pin operator config: parseable, no modelRoles. The template
      // ALSO carries secrets — only the modelRoles block may be appended,
      // never a rewrite of the operator's own blocks.
      const stale = "# operator config from before the pin\nsecrets:\n  enabled: true\ncustomOperator:\n  value: keep\n";
      writeFileSync(join(agentDir, "config.yml"), stale);
      expect(ensureAgentDirModelPin(agentDir, templatePath)).toBe("patched");
      const patched = readFileSync(join(agentDir, "config.yml"), "utf8");
      // The operator block is preserved verbatim; the appended suffix is
      // exactly the template's modelRoles block and nothing else.
      expect(patched).toBe(stale + `\nmodelRoles:\n  default: ${PIN_ROLE}\n`);
      expect(patched).not.toContain("# template");
      const parsed = parseYamlSubset(patched);
      expect(parsed.modelRoles).toEqual({ default: PIN_ROLE });
      expect(parsed.customOperator).toEqual({ value: "keep" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale existing pin is updated IN PLACE from the template when no org settings override (updated, #207)", () => {
    const { dir, templatePath } = tempTemplate();
    try {
      const agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      // The #207 regression: a stale pin (a dead GLM provider) survived
      // every boot because the old sync treated ANY existing modelRoles as
      // operator-owned and returned "unchanged".
      const stale =
        "# stale pin from before the re-pin\nmodelRoles:\n  default: near/zai-org/GLM-5.1-FP8\ndisabledProviders:\n  - opencode-go\n";
      writeFileSync(join(agentDir, "config.yml"), stale);
      expect(ensureAgentDirModelPin(agentDir, templatePath)).toBe("updated");
      const updated = readFileSync(join(agentDir, "config.yml"), "utf8");
      // Only the default VALUE line changed: the operator's other blocks
      // and the surrounding text survive byte-for-byte.
      const parsed = parseYamlSubset(updated);
      expect(parsed.modelRoles).toEqual({ default: PIN_ROLE });
      expect(parsed.disabledProviders).toEqual(["opencode-go"]);
      expect(updated).toContain("# stale pin from before the re-pin");
      expect(updated).not.toContain("GLM-5.1-FP8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a modelRoles block WITHOUT a default key gains the template default in place (updated, #207)", () => {
    const { dir, templatePath } = tempTemplate();
    try {
      const agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      const rolesOnly = "modelRoles:\n  fast: opencode-go/deepseek-v4-flash\nsecrets:\n  enabled: true\n";
      writeFileSync(join(agentDir, "config.yml"), rolesOnly);
      expect(ensureAgentDirModelPin(agentDir, templatePath)).toBe("updated");
      const parsed = parseYamlSubset(readFileSync(join(agentDir, "config.yml"), "utf8"));
      expect(parsed.modelRoles).toEqual({ fast: "opencode-go/deepseek-v4-flash", default: PIN_ROLE });
      expect(parsed.secrets).toEqual({ enabled: "true" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an operator-pinned agent-dir config is UNTOUCHED when org settings override the default (#125 no-clobber, #207)", () => {
    const { dir, templatePath } = tempTemplate();
    try {
      const agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      // The operator's own pin is inert once the org settings override the
      // default — clobbering it would regress #125.
      const operatorPinned = "# operator pin wins\nmodelRoles:\n  default: operator-chosen/model\nsecrets:\n  enabled: false\n";
      writeFileSync(join(agentDir, "config.yml"), operatorPinned);
      expect(ensureAgentDirModelPin(agentDir, templatePath, { orgDefault: PIN_ROLE })).toBe("unchanged");
      expect(readFileSync(join(agentDir, "config.yml"), "utf8")).toBe(operatorPinned);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a pin that already matches the template is left byte-identical (unchanged)", () => {
    const { dir, templatePath } = tempTemplate();
    try {
      const agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      const current = "# in sync\nmodelRoles:\n  default: " + PIN_ROLE + "\nsecrets:\n  enabled: false\n";
      writeFileSync(join(agentDir, "config.yml"), current);
      expect(ensureAgentDirModelPin(agentDir, templatePath)).toBe("unchanged");
      expect(readFileSync(join(agentDir, "config.yml"), "utf8")).toBe(current);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ensureAgentDirModelPin leaves an unparseable operator config untouched (skipped)", () => {
    const { dir, templatePath } = tempTemplate();
    try {
      const agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      // A flow collection is rejected by the YAML-subset parser: fail closed,
      // the operator's config is never guessed at.
      const unparseable = "approvalMode: [ask]\n";
      writeFileSync(join(agentDir, "config.yml"), unparseable);
      expect(ensureAgentDirModelPin(agentDir, templatePath)).toBe("skipped");
      expect(readFileSync(join(agentDir, "config.yml"), "utf8")).toBe(unparseable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ensureAgentDirModelPin skips when the template is missing (skipped)", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-pin-"));
    try {
      const agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      expect(ensureAgentDirModelPin(agentDir, join(dir, "missing.yml"))).toBe("skipped");
      expect(existsSync(join(agentDir, "config.yml"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the committed template pins the documented modelRoles default (#78 recurrence fix, re-pinned #213)", () => {
    // The #78 regression: a stale agent-dir config let the session silently
    // fall back to the provider catalog default (kimi-k2.7-code) and the
    // Console Go gateway 400'd into empty completions. The committed
    // template carries the pin — now the NEAR default (#213); reverting it
    // fails this named test.
    const dir = mkdtempSync(join(tmpdir(), "omp-pin-"));
    try {
      const agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      expect(ensureAgentDirModelPin(agentDir)).toBe("created");
      const parsed = parseYamlSubset(readFileSync(join(agentDir, "config.yml"), "utf8"));
      expect(parsed.modelRoles).toEqual({ default: "openai-codex/gpt-5.6-luna" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("assertAgentDirModelAvailable throws the documented triple-cause error when providers exist but no auth does (#80 regression)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-guard-"));
    try {
      const agentDir = join(dir, "omp-agent");
      mkdirSync(agentDir, { recursive: true });
      // A provider declared with ONLY a baseUrl (no env key, no models.yml
      // apiKey, no broker credential) is a valid override-only entry — and
      // it has no auth, so the registry reports it unavailable: the exact
      // state that used to surface as "No model selected" at the first
      // prompt. The guard must fail closed with all three causes named.
      writeFileSync(
        join(agentDir, "models.yml"),
        [
          "providers:",
          "  agentdir-test:",
          "    api: openai-completions",
          '    baseUrl: "http://127.0.0.1:4891/v1"',
          "",
        ].join("\n"),
      );
      await expect(assertAgentDirModelAvailable(agentDir)).rejects.toThrow(
        /bottega boot guard: no model is available from the agent dir .*: .*models\.yml declares providers \[agentdir-test\] but none of their models has configured auth \(env key, models\.yml apiKey, or auth-broker credential; config: .*config\.yml\).*refusing to boot/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("OmpSessionDriver error surfacing through the factory (issue #78)", () => {
  test("an SDK turn ending with an errorMessage carries the cause on the turn_end payload", async () => {
    // The #78 empty-completion diagnosis path, exercised through
    // createOmpSdkDriver: the driver's seam hands back a stub session, and
    // the DRIVER-BUILT OmpSessionDriver must surface the provider error the
    // same way the real session would. Reverting the #lastError preservation
    // fails this named test.
    const dir = mkdtempSync(join(tmpdir(), "omp-driver-errorsurface-"));
    try {
      const stub = stubSdkSession();
      // SDK result stand-ins: the driver consumes only `session` on this path
      // (the createSession seam's other members are never touched).
      const extensions: Extension[] = [];
      const extensionErrors: LoadExtensionsResult["errors"] = [];
      const driver = createOmpSdkDriver({
        agentDir: join(dir, "agent"),
        createSession: async () =>
          // SAFETY: test stub — the driver consumes only `session`; the inert
          // extensions/runtime/eventBus members are shape-compatible stand-ins.
          ({
            session: stub.session,
            extensionsResult: { extensions, errors: extensionErrors, runtime: {} },
            setToolUIContext: (_uiContext: ExtensionUIContext, _hasUI: boolean) => {},
            eventBus: {},
          }) as CreateAgentSessionResult,
      });
      const session = await driver.createSession({
        spaceId: "slack:C1",
        transcriptDir: join(dir, "sessions"),
        onOutput: () => {},
      });
      const turnEnds: unknown[] = [];
      const messages: unknown[] = [];
      session.on("turn_end", (data) => turnEnds.push(data));
      session.on("message", (data) => messages.push(data));

      const CAUSE = "400 No tool output found for tool call call_repro_1";
      // The SDK's provider-error shape: empty content + stopReason "error" +
      // errorMessage, then turn_end (no message_update in between).
      stub.emit({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: CAUSE },
      });
      stub.emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "" }] } });

      expect(messages).toHaveLength(0); // empty content is never delivered
      expect(turnEnds).toEqual([{ spaceId: "slack:C1", error: CAUSE }]);
      await session.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createOmpSdkDriver concurrency invariant", () => {
  test("two sessions in one process get private agent registries", async () => {
    // The OMP SDK requires a private AgentRegistry per top-level session for
    // concurrent sessions in one process (architecture.md) — the driver must
    // mint a fresh registry per createSession, never share one.
    const dir = mkdtempSync(join(tmpdir(), "omp-driver-registry-"));
    try {
      const registries: unknown[] = [];
      const driver = createOmpSdkDriver({
        agentDir: join(dir, "agent"),
        createSession: async (options) => {
          registries.push(options.agentRegistry);
          throw new Error("factory stub: no real session");
        },
      });
      await expect(
        driver.createSession({ spaceId: "slack:C1", transcriptDir: join(dir, "sessions"), onOutput: () => {} }),
      ).rejects.toThrow("factory stub: no real session");
      await expect(
        driver.createSession({ spaceId: "slack:C2", transcriptDir: join(dir, "sessions"), onOutput: () => {} }),
      ).rejects.toThrow("factory stub: no real session");
      expect(registries).toHaveLength(2);
      expect(registries[0]).toBeInstanceOf(AgentRegistry);
      expect(registries[1]).toBeInstanceOf(AgentRegistry);
      expect(registries[0]).not.toBe(registries[1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
