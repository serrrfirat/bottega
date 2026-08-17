/**
 * Shared AgentDriver conformance suite (issue #173): OMP and ACP held to
 * one contract — every option either honored or loudly rejected, never
 * silently ignored (the #154 fail-open: `allowTools: []` meant "zero tools"
 * but the ACP driver handed out the full toolset).
 *
 * The pattern is `src/memory/conformance.test.ts`: one suite, run by every
 * implementation. `driverConformance(makeHost, capabilities)` registers the
 * suite; each runner (below) supplies a host that drives its driver the way
 * the suite can observe it:
 *
 * - the OMP leg runs the REAL `createOmpSdkDriver` (temp agent dir, no
 *   network) with the SDK session factory injected — the driver's option
 *   plumbing is exercised end to end while a stub SDK session simulates the
 *   turn mechanics hermetically (docs/test-coverage.md gap #1);
 * - the ACP leg runs the driver against the scripted fake ACP server
 *   (real child process, real stdio JSON-RPC).
 *
 * `capabilities` is the driver's claim: supported → the suite asserts the
 * option is HONORED; unsupported → the suite asserts a loud `unsupported`
 * rejection. That forces #154's capability decision into the interface.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent";
import { createAudit } from "../../policy/audit";
import { DenyRouter } from "../../policy/approval-router";
import { loadSpacePolicy, parseOrgConfigYaml } from "../../policy/config";
import { createStore } from "../../store/db";
import { POLICY_DECISION_EVENT } from "../../store/audit-events";
import { createAcpDriver, type AcpPolicyContext } from "./acp-driver";
import {
  createOmpSdkDriver,
  sessionFilePath,
  sessionIdFromFilePath,
  SPACE_AGENT_TOOLS,
  type AgentDriver,
  type AgentSessionDriver,
  type AgentTurnOptions,
} from "./agent-driver";

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface DriverConformanceCapabilities {
  /**
   * allowTools restriction honored (`[]` → zero tools, `[x]` → exactly x).
   * False → createSession with a restricting allowTools must throw
   * `unsupported` (the #154 fail-open case).
   */
  allowTools: boolean;
  /** appendSystemPrompt honored and observable. False → createSession must throw `unsupported`. */
  appendSystemPrompt: boolean;
  /** prompt({silent: true}) suppresses the space surface while still emitting "message". False → prompt must throw `unsupported`. */
  silent: boolean;
  /** streamingBehavior honored: mid-turn prompts are queued/dispatched, never dropped. */
  streamingBehavior: boolean;
  /** Per-turn principal (prompt({principal})) binds mid-turn and clears at turn end; the getPrincipal option is consumed. */
  principal: boolean;
  /** setModelRole works or reports not-supported through the documented result (never a silent no-op). */
  setModelRole: boolean;
  /** getModelSettings is honored (drives setModelRole resolution). False → createSession must throw `unsupported`. */
  getModelSettings: boolean;
  /** Session file materialized under transcriptDir; sessionIdFromFilePath round-trips. */
  transcript: boolean;
}

/**
 * Per-leg harness. The suite drives the driver through the public
 * AgentSessionDriver surface plus the observation seams a leg can provide
 * (the OMP injected-factory capture; the ACP wire log).
 */
export interface ConformanceHost {
  /** A fresh driver instance for this test. */
  createDriver(): AgentDriver;
  /** A fresh driver whose next turn fails at the transport level (error event). */
  createFailingDriver(): AgentDriver;
  /** Fresh temp transcript dir for this test's sessions. */
  transcriptDir: string;
  /** Space id for this test's sessions. */
  spaceId: string;
  /**
   * The exact options the driver passed to its underlying session factory
   * (OMP's injected createSession seam), or null when unobservable (ACP).
   */
  capturedOptions(): Record<string, unknown> | null;
  /** The tool allowlist the driver passed to the underlying session, or null when unobservable. */
  sessionToolNames(): readonly string[] | null;
  /** The underlying agent's wire log (ACP fake-server log), or null. */
  wireLog(): string | null;
  /** Resolve once the underlying agent logged `needle`; reject on timeout. */
  waitForWire?(needle: string, timeoutMs?: number): Promise<void>;
  /** Run one prompt turn to completion (message delivered, turn ended). */
  prompt(session: AgentSessionDriver, text: string, opts?: AgentTurnOptions): Promise<void>;
  /**
   * Begin a streaming turn that stays in flight. `firstChunk` resolves once
   * output is streaming; `finish` completes the turn and resolves when its
   * output was delivered.
   */
  beginStreamingTurn(
    session: AgentSessionDriver,
    text: string,
    opts?: AgentTurnOptions,
  ): Promise<{ finish: () => Promise<void>; firstChunk: Promise<void> }>;
  /** Mid-turn dispatch records (steer/followUp) when observable, else null. */
  turnCalls?(): Array<{ kind: "steer" | "followUp" | "prompt"; text: string }> | null;
  /** Optional: prove the createSession getPrincipal option is consumed (not dropped). */
  assertGetPrincipalConsumed?(): Promise<void>;
  /** Tear down temp dirs / child processes. */
  cleanup(): Promise<void>;
}

export function driverConformance(makeHost: () => ConformanceHost, capabilities: DriverConformanceCapabilities): void {
  describe("driver conformance", () => {
    let host: ConformanceHost;
    beforeEach(() => {
      host = makeHost();
    });
    afterEach(async () => {
      await host.cleanup();
    });

    test("allowTools: [] → zero tools, or createSession throws unsupported", async () => {
      const driver = host.createDriver();
      if (capabilities.allowTools) {
        const session = await driver.createSession({
          spaceId: host.spaceId,
          transcriptDir: host.transcriptDir,
          onOutput: () => {},
          allowTools: [],
        });
        // No custom tools are wired in the conformance harness, so a
        // zero-tool request must yield exactly zero session tools.
        expect(host.sessionToolNames()).toEqual([]);
        await session.dispose();
      } else {
        await expect(
          driver.createSession({
            spaceId: host.spaceId,
            transcriptDir: host.transcriptDir,
            onOutput: () => {},
            allowTools: [],
          }),
        ).rejects.toThrow(/unsupported/i);
      }
    });

    test("allowTools: [x] → exactly x is surfaced, or createSession throws unsupported", async () => {
      const driver = host.createDriver();
      if (capabilities.allowTools) {
        const session = await driver.createSession({
          spaceId: host.spaceId,
          transcriptDir: host.transcriptDir,
          onOutput: () => {},
          allowTools: ["read"],
        });
        // The allowlist reaches the underlying session exactly as requested;
        // the SDK's restricted sessions surface only these names.
        expect(host.sessionToolNames()).toEqual(["read"]);
        await session.dispose();
      } else {
        await expect(
          driver.createSession({
            spaceId: host.spaceId,
            transcriptDir: host.transcriptDir,
            onOutput: () => {},
            allowTools: ["read"],
          }),
        ).rejects.toThrow(/unsupported/i);
        // The SpaceService default (the FULL space-agent allowlist) requests
        // no narrowing and must still be accepted — nothing is silently lost.
        const session = await driver.createSession({
          spaceId: host.spaceId,
          transcriptDir: host.transcriptDir,
          onOutput: () => {},
          allowTools: [...SPACE_AGENT_TOOLS],
        });
        await session.dispose();
      }
    });

    test("appendSystemPrompt is honored and observable, or createSession throws unsupported", async () => {
      const driver = host.createDriver();
      const DIRECTIVE = "act only on explicit requests";
      if (capabilities.appendSystemPrompt) {
        const session = await driver.createSession({
          spaceId: host.spaceId,
          transcriptDir: host.transcriptDir,
          onOutput: () => {},
          appendSystemPrompt: DIRECTIVE,
        });
        const captured = host.capturedOptions();
        if (captured && "appendSystemPrompt" in captured) {
          // OMP: the directive reaches the SDK session's appendSystemPrompt.
          expect(captured.appendSystemPrompt).toBe(DIRECTIVE);
        } else if (host.waitForWire) {
          // ACP: the directive rides the first prompt's text (the only ACP
          // channel that reaches the agent's context).
          await host.prompt(session, "hi");
          await host.waitForWire(DIRECTIVE);
        }
        await session.dispose();
      } else {
        await expect(
          driver.createSession({
            spaceId: host.spaceId,
            transcriptDir: host.transcriptDir,
            onOutput: () => {},
            appendSystemPrompt: DIRECTIVE,
          }),
        ).rejects.toThrow(/unsupported/i);
      }
    });

    test("silent: true suppresses the space surface while still emitting 'message', or prompt throws unsupported", async () => {
      const driver = host.createDriver();
      const outputs: string[] = [];
      const messages: unknown[] = [];
      const session = await driver.createSession({
        spaceId: host.spaceId,
        transcriptDir: host.transcriptDir,
        onOutput: (_spaceId, text) => outputs.push(text),
      });
      session.on("message", (data) => messages.push(data));
      if (capabilities.silent) {
        await host.prompt(session, "quiet turn", { silent: true });
        // The turn's text reached the event channel but never the space surface.
        expect(messages.length).toBeGreaterThanOrEqual(1);
        expect(outputs).toEqual([]);
        // A normal turn DOES reach the surface — silent is a per-turn flag.
        await host.prompt(session, "loud turn");
        expect(outputs.length).toBeGreaterThanOrEqual(1);
      } else {
        await expect(host.prompt(session, "quiet turn", { silent: true })).rejects.toThrow(/unsupported/i);
      }
      await session.dispose();
    });

    test("streamingBehavior: a mid-turn follow-up is never dropped and the in-flight turn completes", async () => {
      const driver = host.createDriver();
      const errors: unknown[] = [];
      const session = await driver.createSession({
        spaceId: host.spaceId,
        transcriptDir: host.transcriptDir,
        onOutput: () => {},
      });
      session.on("error", (data) => errors.push(data));
      const { finish } = await host.beginStreamingTurn(session, "first");
      expect(session.isStreaming()).toBe(true);
      // Both behaviors resolve while the turn is in flight: followUp queues
      // (ACP) or dispatches the SDK follow-up (OMP); steer dispatches the SDK
      // steer (OMP) or queues identically (ACP has no steer primitive).
      await session.prompt("second", { streamingBehavior: "followUp" });
      await session.prompt("third", { streamingBehavior: "steer" });
      await finish();
      expect(session.isStreaming()).toBe(false);
      expect(errors).toEqual([]);
      if (host.turnCalls) {
        const calls = host.turnCalls() ?? [];
        expect(calls.filter((c) => c.kind === "followUp").map((c) => c.text)).toEqual(["second"]);
        expect(calls.filter((c) => c.kind === "steer").map((c) => c.text)).toEqual(["third"]);
      }
      await session.dispose();
    });

    test("per-turn principal binds mid-turn and clears at turn end (#152)", async () => {
      const driver = host.createDriver();
      const session = await driver.createSession({
        spaceId: host.spaceId,
        transcriptDir: host.transcriptDir,
        onOutput: () => {},
      });
      const { finish, firstChunk } = await host.beginStreamingTurn(session, "hello", { principal: "U1" });
      await firstChunk;
      // The principal of the message that OPENED the turn stays bound for the
      // whole turn (a second user mid-turn must never re-identify it).
      expect(session.getTurnPrincipal?.()).toBe("U1");
      await finish();
      expect(session.getTurnPrincipal?.()).toBeUndefined();
      await session.dispose();
    });

    test("createSession getPrincipal option is consumed, never silently dropped", async () => {
      const driver = host.createDriver();
      const session = await driver.createSession({
        spaceId: host.spaceId,
        transcriptDir: host.transcriptDir,
        onOutput: () => {},
        getPrincipal: () => "U9",
      });
      await host.prompt(session, "hi");
      await session.dispose();
      await host.assertGetPrincipalConsumed?.();
    });

    test("getModelSettings is honored (drives setModelRole) or createSession throws unsupported", async () => {
      const driver = host.createDriver();
      if (capabilities.getModelSettings) {
        const session = await driver.createSession({
          spaceId: host.spaceId,
          transcriptDir: host.transcriptDir,
          onOutput: () => {},
          getModelSettings: async () => ({ model: "ghost-model" }),
        });
        // The settings reached the session: the role switch resolves against
        // them and fails closed on the unavailable model instead of reporting
        // "no settings configured" (the silently-dropped-option symptom).
        await expect(session.setModelRole!("default")).rejects.toThrow(/ghost-model/);
        await session.dispose();
      } else {
        await expect(
          driver.createSession({
            spaceId: host.spaceId,
            transcriptDir: host.transcriptDir,
            onOutput: () => {},
            getModelSettings: async () => ({}),
          }),
        ).rejects.toThrow(/unsupported/i);
      }
    });

    test("cwd is honored (reaches the underlying session), or createSession throws unsupported", async () => {
      const driver = host.createDriver();
      const cwd = host.transcriptDir; // a real temp dir
      const session = await driver.createSession({ spaceId: host.spaceId, transcriptDir: host.transcriptDir, onOutput: () => {}, cwd });
      const captured = host.capturedOptions();
      if (captured && "cwd" in captured) {
        // OMP: the SDK session manager runs in the requested cwd.
        expect(captured.cwd).toBe(cwd);
      } else if (host.waitForWire) {
        // ACP: session/new carries the requested cwd to the agent.
        await host.waitForWire(JSON.stringify(cwd));
      }
      await session.dispose();
    });

    test("setModelRole works or reports not-supported through the documented path (never a silent no-op)", async () => {
      const driver = host.createDriver();
      const session = await driver.createSession({
        spaceId: host.spaceId,
        transcriptDir: host.transcriptDir,
        onOutput: () => {},
      });
      if (!session.setModelRole) {
        // Optional seam absent: nothing to assert (both shipped drivers have it).
        await session.dispose();
        return;
      }
      const result = await session.setModelRole("fast");
      expect(result).toBeDefined();
      expect(result.role).toBe("fast");
      expect(typeof result.applied).toBe("boolean");
      if (!result.applied) {
        // A not-supported switch must SAY why — a bare no-op is the failure mode.
        expect(typeof result.reason).toBe("string");
        expect(result.reason!.length).toBeGreaterThan(0);
      }
      await session.dispose();
    });

    test("event lifecycle: turn_start → message → turn_end, in order, carrying the space id", async () => {
      const driver = host.createDriver();
      const events: Array<{ kind: string; data: unknown }> = [];
      const session = await driver.createSession({
        spaceId: host.spaceId,
        transcriptDir: host.transcriptDir,
        onOutput: () => {},
      });
      session.on("turn_start", (data) => events.push({ kind: "turn_start", data }));
      session.on("message", (data) => events.push({ kind: "message", data }));
      session.on("turn_end", (data) => events.push({ kind: "turn_end", data }));
      await host.prompt(session, "hello");
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(["turn_start", "message", "turn_end"]);
      expect(events.find((e) => e.kind === "message")?.data).toMatchObject({ spaceId: host.spaceId });
      await session.dispose();
    });

    test("transport failure surfaces as an error event and the session never hangs", async () => {
      const driver = host.createFailingDriver();
      const errors: unknown[] = [];
      const session = await driver.createSession({
        spaceId: host.spaceId,
        transcriptDir: host.transcriptDir,
        onOutput: () => {},
      });
      session.on("error", (data) => errors.push(data));
      try {
        await host.prompt(session, "boom");
      } catch {
        // The prompt may reject (ACP child crash) or resolve with the error
        // surfaced on the event channel (OMP notice) — the event is the contract.
      }
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toMatchObject({ spaceId: host.spaceId });
      expect(session.isStreaming()).toBe(false);
      await session.dispose();
    });

    test("abort() during a stream ends the in-flight turn", async () => {
      const driver = host.createDriver();
      const events: Array<{ kind: string }> = [];
      const errors: unknown[] = [];
      const session = await driver.createSession({
        spaceId: host.spaceId,
        transcriptDir: host.transcriptDir,
        onOutput: () => {},
      });
      session.on("turn_start", () => events.push({ kind: "turn_start" }));
      session.on("turn_end", () => events.push({ kind: "turn_end" }));
      session.on("error", (data) => errors.push(data));
      const { finish, firstChunk } = await host.beginStreamingTurn(session, "stop me");
      await firstChunk;
      expect(session.isStreaming()).toBe(true);
      await session.abort();
      await finish();
      expect(session.isStreaming()).toBe(false);
      expect(errors).toEqual([]);
      expect(events.filter((e) => e.kind === "turn_start")).toHaveLength(1);
      expect(events.filter((e) => e.kind === "turn_end")).toHaveLength(1);
      await session.dispose();
    });

    test("dispose() is idempotent", async () => {
      const driver = host.createDriver();
      const session = await driver.createSession({
        spaceId: host.spaceId,
        transcriptDir: host.transcriptDir,
        onOutput: () => {},
      });
      await session.dispose();
      await expect(session.dispose()).resolves.toBeUndefined();
    });

    test("transcript: session file materialized under transcriptDir; sessionIdFromFilePath round-trips", async () => {
      const driver = host.createDriver();
      const session = await driver.createSession({
        spaceId: host.spaceId,
        transcriptDir: host.transcriptDir,
        onOutput: () => {},
      });
      const file = sessionFilePath(host.transcriptDir, host.spaceId);
      expect(existsSync(file)).toBe(true);
      expect(sessionIdFromFilePath(file)).toBe(host.spaceId);
      expect(sessionIdFromFilePath(join(host.transcriptDir, "slack:OTHER.jsonl"))).toBe("slack:OTHER");
      expect(sessionIdFromFilePath(null)).toBeUndefined();
      expect(sessionIdFromFilePath(undefined)).toBeUndefined();
      expect(sessionIdFromFilePath("no-extension")).toBeUndefined();
      await session.dispose();
    });
  });
}

// ---------------------------------------------------------------------------
// Runner 1: the OMP SDK driver (hermetic: real createOmpSdkDriver, temp agent
// dir, no network — the session factory is injected so a stub SDK session
// simulates turn mechanics while the driver's option plumbing runs for real).
// ---------------------------------------------------------------------------

const OMP_CAPABILITIES: DriverConformanceCapabilities = {
  allowTools: true,
  appendSystemPrompt: true,
  silent: true,
  streamingBehavior: true,
  principal: true,
  setModelRole: true,
  getModelSettings: true,
  transcript: true,
};

function makeOmpHost(): ConformanceHost {
  const dir = mkdtempSync(join(tmpdir(), "omp-conformance-"));
  const transcriptDir = join(dir, "sessions");
  const spaceId = "slack:CONFORMANCE";
  let captured: CreateAgentSessionOptions | null = null;
  let failNext = false;
  let currentControls: Controls | null = null;

  interface Controls {
    emit(event: unknown): void;
    release(): void;
    calls: Array<{ kind: "prompt" | "steer" | "followUp"; text: string }>;
    disposeCalls: number;
    abortCalls: number;
  }

  function freshControls(): { controls: Controls; session: AgentSession } {
    let listener: ((event: unknown) => void) | undefined;
    let finishPrompt: (() => void) | undefined;
    let streaming = false;
    const controls: Controls = {
      calls: [],
      disposeCalls: 0,
      abortCalls: 0,
      emit: (event) => listener?.(event),
      release: () => {
        finishPrompt?.();
        finishPrompt = undefined;
      },
    };
    const session = {
      subscribe: (cb: (event: unknown) => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      beginDispose: () => void controls.disposeCalls++,
      dispose: async () => void controls.disposeCalls++,
      get isStreaming() {
        return streaming;
      },
      prompt: async (text: string) => {
        controls.calls.push({ kind: "prompt", text });
        streaming = true;
        // Held until the harness releases it: the suite emits the SDK's
        // turn events while the prompt is in flight (the SDK's prompt
        // resolves only when the WHOLE turn ends).
        const { promise, resolve } = Promise.withResolvers<void>();
        finishPrompt = resolve;
        await promise;
        streaming = false;
      },
      steer: async (text: string) => void controls.calls.push({ kind: "steer", text }),
      followUp: async (text: string) => void controls.calls.push({ kind: "followUp", text }),
      abort: async () => void controls.abortCalls++,
      getAvailableModels: () => [],
      setThinkingLevel: () => {},
    } as unknown as AgentSession;
    return { controls, session };
  }

  function createDriver(): AgentDriver {
    captured = null;
    failNext = false;
    return createOmpSdkDriver({
      agentDir: join(dir, "agent"),
      createSession: async (options) => {
        captured = options;
        const { controls, session } = freshControls();
        currentControls = controls;
        // The driver only destructures `session` from the result; the rest of
        // the SDK surface is stubbed so the type contract is met.
        return {
          session,
          extensionsResult: { loadedExtensions: [] } as unknown as CreateAgentSessionResult["extensionsResult"],
          setToolUIContext: () => {},
          eventBus: {} as CreateAgentSessionResult["eventBus"],
        };
      },
    });
  }

  function createFailingDriver(): AgentDriver {
    const driver = createDriver();
    failNext = true;
    return driver;
  }

  /** The standard turn the harness produces: one message, correct ordering. */
  function emitTurn(controls: Controls, text = "Hello, world!"): void {
    controls.emit({ type: "turn_start" });
    controls.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
    });
    controls.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text },
    });
    controls.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    controls.emit({ type: "turn_end", message: {} });
  }

  return {
    createDriver,
    createFailingDriver,
    transcriptDir,
    spaceId,
    capturedOptions: () => (captured as unknown as Record<string, unknown> | null) ?? null,
    sessionToolNames: () => captured?.toolNames ?? null,
    wireLog: () => null,
    prompt: async (session, text, opts) => {
      const controls = currentControls;
      if (!controls) throw new Error("omp conformance host: no session created");
      const p = session.prompt(text, opts);
      if (failNext) {
        failNext = false;
        controls.emit({ type: "notice", level: "error", message: "transport failure injected by conformance harness" });
        controls.emit({ type: "turn_end", message: {} });
      } else {
        emitTurn(controls);
      }
      controls.release();
      await p;
    },
    beginStreamingTurn: async (session, text, opts) => {
      const controls = currentControls;
      if (!controls) throw new Error("omp conformance host: no session created");
      const p = session.prompt(text, opts);
      controls.emit({ type: "turn_start" });
      controls.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello, " },
      });
      return {
        firstChunk: Promise.resolve(),
        finish: async () => {
          controls.emit({
            type: "message_update",
            message: {},
            assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello, world!" },
          });
          controls.emit({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "Hello, world!" }] },
          });
          controls.emit({ type: "turn_end", message: {} });
          controls.release();
          await p;
        },
      };
    },
    turnCalls: () => currentControls?.calls ?? null,
    assertGetPrincipalConsumed: async () => {
      // Acceptance covered by the suite test above (session created + runs);
      // the option's deep wiring (connect actor, memory context) is pinned in
      // agent-driver.test.ts.
    },
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Runner 2: the ACP driver against the scripted fake ACP server.
// ---------------------------------------------------------------------------

const ACP_CAPABILITIES: DriverConformanceCapabilities = {
  // ACP v1 has no tool-restriction field — an allowTools request that
  // narrows the space-agent allowlist throws unsupported (honored-or-throws).
  allowTools: false,
  // The request-only directive rides the first prompt's text.
  appendSystemPrompt: true,
  silent: true,
  // No steer primitive: mid-turn prompts queue behind the in-flight turn.
  streamingBehavior: true,
  principal: true,
  // setModelRole reports not-supported through the documented result.
  setModelRole: true,
  // Per-space model settings are meaningless (no mid-session switches) —
  // createSession throws unsupported rather than drop the option.
  getModelSettings: false,
  // The driver materializes the session file like the OMP driver.
  transcript: true,
};

const ACP_FIXTURE = join(import.meta.dir, "fixtures", "fake-acp-server.ts");

function makeAcpHost(): ConformanceHost {
  const dir = mkdtempSync(join(tmpdir(), "acp-conformance-"));
  const logfile = join(dir, "server.log");
  const transcriptDir = join(dir, "sessions");
  const spaceId = "slack:CONFORMANCE";

  function createDriverFor(args: string[], policy?: AcpPolicyContext): AgentDriver {
    return createAcpDriver({ command: "bun", args, sessionTimeoutMs: 5_000, policy });
  }

  const happyArgs = ["run", ACP_FIXTURE, "happy", logfile];
  const crashArgs = ["run", ACP_FIXTURE, "crash", logfile];

  // The ACP leg drives a REAL child process (the scripted fake server) over
  // real stdio — its clock cannot be faked, so wire-assertions poll the log
  // the child appends (same pattern as acp-driver.test.ts's waitForLog).
  const waitForWire = async (needle: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (readFileSync(logfile, "utf8").includes(needle)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for wire needle: ${needle}\nlog:\n${readFileSync(logfile, "utf8")}`);
  };
  const wireLog = (): string | null => (existsSync(logfile) ? readFileSync(logfile, "utf8") : null);

  return {
    createDriver: () => createDriverFor(happyArgs),
    createFailingDriver: () => createDriverFor(crashArgs),
    transcriptDir,
    spaceId,
    capturedOptions: () => null,
    sessionToolNames: () => null,
    wireLog,
    waitForWire,
    prompt: async (session, text, opts) => {
      await session.prompt(text, opts);
    },
    beginStreamingTurn: async (session, text, opts) => {
      const p = session.prompt(text, opts);
      // The fake server streams its first chunk quickly; the turn stays in
      // flight until the agent answers the prompt.
      await waitForWire('"text":"Hello, "');
      return {
        firstChunk: Promise.resolve(),
        finish: async () => {
          await p;
        },
      };
    },
    assertGetPrincipalConsumed: async () => {
      const policyDir = mkdtempSync(join(tmpdir(), "acp-principal-"));
      const store = createStore(join(policyDir, "test.db"));
      const audit = createAudit(store);
      const orgPolicy = parseOrgConfigYaml("tools:\n  read: allow\n  unknown: deny\n");
      const permissionArgs = [
        "run",
        ACP_FIXTURE,
        "permission",
        logfile,
        JSON.stringify({ toolCall: { toolCallId: "c1", title: "Read", kind: "read", rawInput: { path: "/x" } } }),
      ];
      const driver = createDriverFor(permissionArgs, {
        orgPolicy,
        loadPolicy: (spaceId) => loadSpacePolicy(orgPolicy, store, spaceId),
        audit,
        router: DenyRouter,
      });
      const session = await driver.createSession({
        spaceId,
        transcriptDir,
        onOutput: () => {},
        // The space's current principal (issue #42): ACP consumes it as the
        // permission-gate actor — proof the option is honored, not dropped.
        getPrincipal: () => "U9",
      });
      await waitForWire('"outcome":"selected","optionId":"allow_once"');
      await session.dispose();
      const deadline = Date.now() + 2_000;
      let row: { actor: string | null; payload: string } | null = null;
      while (Date.now() < deadline) {
        const rows = await audit.listAudit({ event_type: POLICY_DECISION_EVENT });
        if (rows.length > 0) {
          row = rows.at(-1)!;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(row).not.toBeNull();
      expect(row!.actor).toBe("U9");
      expect(JSON.parse(row!.payload) as Record<string, unknown>).toMatchObject({ tool: "read", decision: "allow" });
      store.close();
      rmSync(policyDir, { recursive: true, force: true });
    },
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("driver conformance — OMP SDK driver", () => {
  driverConformance(makeOmpHost, OMP_CAPABILITIES);
});

describe("driver conformance — ACP driver (fake server)", () => {
  driverConformance(makeAcpHost, ACP_CAPABILITIES);
});
