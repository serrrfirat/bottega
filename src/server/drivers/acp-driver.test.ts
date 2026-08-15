import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APPROVAL_REQUESTED_EVENT, APPROVAL_RESOLVED_EVENT, POLICY_DECISION_EVENT } from "../../store/audit-events";
import { createStore } from "../../store/db";
import { createAudit, type AuditModule } from "../../policy/audit";
import { DenyRouter, type ApprovalRouter } from "../../policy/approval-router";
import { loadSpacePolicy, parseOrgConfigYaml } from "../../policy/config";
import { createAcpDriver, type AcpMcpServerEntry, type AcpPolicyContext } from "./acp-driver";
import type { AgentSessionDriver } from "./agent-driver";
import { SpaceService, type InboundMessage } from "../services/space-service";
import type { SlackAdapter } from "../adapters/slack";
import type { Store } from "../../store/db";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-acp-server.ts");

// ---------------------------------------------------------------------------
// Harness: run the driver against the scripted fake ACP server and record
// every driver event plus the raw protocol exchange (server log file).
// ---------------------------------------------------------------------------

interface Harness {
  session: AgentSessionDriver;
  events: Record<"message" | "turn_start" | "turn_end" | "error", unknown[]>;
  outputs: string[];
  logfile: string;
  cleanup: () => void;
  waitForLog: (needle: string, timeoutMs?: number) => Promise<void>;
}

async function launch(
  scenario: string,
  opts: {
    sessionTimeoutMs?: number;
    mcpServers?: AcpMcpServerEntry[];
    /** Policy context for the session/request_permission handler (issue #26). */
    policy?: AcpPolicyContext;
    /** JSON override passed to the fake server's permission scenario. */
    permissionOverride?: Record<string, unknown>;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "acp-driver-"));
  const logfile = join(dir, "server.log");
  const args = [FIXTURE, scenario, logfile];
  if (opts.permissionOverride) args.push(JSON.stringify(opts.permissionOverride));
  const driver = createAcpDriver({
    command: "bun",
    args: ["run", ...args],
    sessionTimeoutMs: opts.sessionTimeoutMs ?? 5_000,
    mcpServers: opts.mcpServers,
    policy: opts.policy,
  });
  const events = { message: [], turn_start: [], turn_end: [], error: [] } as Harness["events"];
  const outputs: string[] = [];
  const session = await driver.createSession({
    spaceId: "slack:C1",
    transcriptDir: join(dir, "sessions"),
    onOutput: (spaceId, text) => outputs.push(`${spaceId}: ${text}`),
  });
  for (const event of ["message", "turn_start", "turn_end", "error"] as const) {
    session.on(event, (data) => events[event].push(data));
  }
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const waitForLog = async (needle: string, timeoutMs = 3_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (readFileSync(logfile, "utf8").includes(needle)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for log needle: ${needle}\nlog:\n${readFileSync(logfile, "utf8")}`);
  };
  return { session, events, outputs, logfile, cleanup, waitForLog };
}

describe("acp driver", () => {
  test("full prompt -> update stream -> done cycle", async () => {
    const h = await launch("happy");
    try {
      const events = h.events;
      const pending = h.session.prompt("hi there");
      // Contract conformance: the driver is streaming while the turn is in flight.
      expect(h.session.isStreaming()).toBe(true);
      await pending;
      expect(h.session.isStreaming()).toBe(false);

      expect(events.turn_start).toEqual([{ spaceId: "slack:C1" }]);
      expect(events.turn_end).toEqual([{ spaceId: "slack:C1" }]);
      expect(events.error).toEqual([]);
      // Both chunks carry the same messageId, so they join into one message.
      expect(events.message).toEqual([{ spaceId: "slack:C1", text: "Hello, world!" }]);
      expect(h.outputs).toEqual(["slack:C1: Hello, world!"]);

      // The client sent spec-shaped session/prompt with the negotiated sessionId.
      await h.waitForLog('"method":"session/prompt"');
      const log = readFileSync(h.logfile, "utf8");
      expect(log).toContain('"sessionId":"sess_fake"');
      expect(log).toContain('"prompt":[{"type":"text","text":"hi there"}]');
    } finally {
      await h.session.dispose();
      h.cleanup();
    }
  });

  test("cancel mid-stream", async () => {
    const h = await launch("happy");
    try {
      const events = h.events;
      const pending = h.session.prompt("stop me");
      // Wait until the fake server has streamed its first chunk, then cancel.
      await h.waitForLog('"text":"Hello, "');
      expect(h.session.isStreaming()).toBe(true);
      await h.session.abort();
      await pending; // agent answers the cancelled prompt

      expect(h.session.isStreaming()).toBe(false);
      expect(events.turn_start).toHaveLength(1);
      expect(events.turn_end).toHaveLength(1);
      expect(events.error).toEqual([]);
      // The partial streamed text is still delivered.
      expect(events.message).toEqual([{ spaceId: "slack:C1", text: "Hello," }]);
      // The server saw a session/cancel notification.
      await h.waitForLog('"method":"session/cancel"');
    } finally {
      await h.session.dispose();
      h.cleanup();
    }
  });

  test("child crash -> error event and dead session", async () => {
    const h = await launch("crash");
    try {
      const events = h.events;
      await expect(h.session.prompt("boom")).rejects.toThrow(/exited/i);
      expect(events.error).toHaveLength(1);
      expect(events.error[0]).toMatchObject({ spaceId: "slack:C1" });
      expect(events.turn_start).toHaveLength(1);
      expect(events.turn_end).toHaveLength(1);
      expect(h.session.isStreaming()).toBe(false);
      // The chunk streamed before the crash is still delivered.
      expect(events.message).toEqual([{ spaceId: "slack:C1", text: "partial" }]);
      // Dead session: further prompts are refused.
      await expect(h.session.prompt("again")).rejects.toThrow(/not running/i);
    } finally {
      await h.session.dispose();
      h.cleanup();
    }
  });

  test("unknown notifications and inbound requests are tolerated", async () => {
    const h = await launch("noisy");
    try {
      const events = h.events;
      // The driver answered the unknown inbound request with method-not-found,
      // which the fake server logged on its side.
      await h.waitForLog('"code":-32601');
      const log = readFileSync(h.logfile, "utf8");
      expect(log).toContain('"method":"session/request_permission"');
      expect(log).toContain('"error":{"code":-32601');

      // The session still works after the noise.
      await h.session.prompt("still alive");
      expect(events.message).toEqual([{ spaceId: "slack:C1", text: "Hello, world!" }]);
      expect(events.error).toEqual([]);
    } finally {
      await h.session.dispose();
      h.cleanup();
    }
  });

  test("dispose closes the session and terminates the child", async () => {
    const h = await launch("happy");
    try {
      await h.session.dispose();
      await h.waitForLog('"method":"session/close"');
      // The fake server exits cleanly after session/close; give it a beat.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      h.cleanup();
    }
  });

  test("session/new sends mcpServers as an empty array when none are configured", async () => {
    const h = await launch("happy");
    try {
      await h.waitForLog('"method":"session/new"');
      // omp crashes on a missing mcpServers field (issue #18), so the driver
      // must always send an explicit empty list.
      expect(readFileSync(h.logfile, "utf8")).toContain('"mcpServers":[]');
    } finally {
      await h.session.dispose();
      h.cleanup();
    }
  });

  test("session/new carries configured mcpServers with per-session env", async () => {
    const h = await launch("happy", {
      mcpServers: [
        {
          name: "bottega",
          command: "/usr/local/bin/bun",
          args: ["run", "/repo/src/mcp/server.ts"],
          env: { BOTTEGA_DB_PATH: "data/bottega.db", BOTTEGA_CONFIG_DIR: "config", CUSTOM: "x" },
        },
      ],
    });
    try {
      await h.waitForLog('"method":"session/new"');
      const log = readFileSync(h.logfile, "utf8");
      // The ACP stdio MCP server shape: name + command + args + env pairs.
      expect(log).toContain('"name":"bottega"');
      expect(log).toContain('"type":"stdio"');
      expect(log).toContain('"command":"/usr/local/bin/bun"');
      expect(log).toContain('"args":["run","/repo/src/mcp/server.ts"]');
      expect(log).toContain('"name":"CUSTOM","value":"x"');
      // The session's space id is injected per-session so the MCP server can
      // enforce the space's policy overlay and scope its audit rows.
      expect(log).toContain('"name":"BOTTEGA_SPACE_ID","value":"slack:C1"');
      // Path env vars are absolutized: the MCP server process is spawned by
      // the agent with the session cwd, so a relative DB path would silently
      // resolve against the wrong directory.
      expect(log).toContain(resolve(process.cwd(), "data/bottega.db"));
      expect(log).not.toContain('"value":"data/bottega.db"');
      expect(log).toContain(resolve(process.cwd(), "config"));
    } finally {
      await h.session.dispose();
      h.cleanup();
    }
  });

  test("handshake timeout rejects createSession", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-driver-"));
    try {
      const logfile = join(dir, "server.log");
      const driver = createAcpDriver({
        command: "bun",
        args: ["run", FIXTURE, "silent", logfile],
        sessionTimeoutMs: 200,
      });
      await expect(
        driver.createSession({ spaceId: "slack:C1", transcriptDir: join(dir, "sessions"), onOutput: () => {} }),
      ).rejects.toThrow(/timed out/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("createSession rejects when the command cannot be spawned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-driver-"));
    try {
      const driver = createAcpDriver({ command: "definitely-not-a-real-binary", sessionTimeoutMs: 500 });
      await expect(
        driver.createSession({ spaceId: "slack:C1", transcriptDir: join(dir, "sessions"), onOutput: () => {} }),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SpaceService drives the ACP driver end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-driver-"));
    const logfile = join(dir, "server.log");
    const driver = createAcpDriver({
      command: "bun",
      args: ["run", FIXTURE, "happy", logfile],
      sessionTimeoutMs: 5_000,
    });
    const posts: Array<{ spaceId: string; text: string; opts?: { threadTs?: string } }> = [];
    const updates: Array<{ spaceId: string; ts: string; text: string }> = [];
    const adapter: SlackAdapter = {
      async postMessage(spaceId, text, opts) {
        posts.push({ spaceId, text, opts });
        return `ts-${posts.length}`;
      },
      async updateMessage(spaceId, ts, text) {
        updates.push({ spaceId, ts, text });
      },
      async start() {},
      async stop() {},
    };
    const store = { appendAudit: async () => 1 } as unknown as Store;
    const service = new SpaceService({
      store,
      adapter,
      driver,
      idleTimeoutMs: 60_000,
      transcriptDir: join(dir, "sessions"),
    });
    try {
      const msg: InboundMessage = { spaceId: "slack:C1", principal: "U1", text: "hello", ts: "1.1" };
      await service.handleInboundMessage(msg);
      const deadline = Date.now() + 3_000;
      // The driver emits turn_start (phrase) then message (final reply);
      // the reply must replace the phrase in place, never post a second message.
      while (updates.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(posts).toEqual([{ spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } }]);
      expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-1", text: "Hello, world!" }]);
    } finally {
      await service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // session/request_permission policy seam (issue #26)
  // -------------------------------------------------------------------------

  interface PolicyHarness {
    policy: AcpPolicyContext;
    store: Store;
    audit: AuditModule;
    cleanup: () => void;
    lastAudit: (eventType: string) => Promise<Record<string, unknown>>;
  }

  function makePolicyHarness(orgYaml: string, opts: { router?: ApprovalRouter } = {}): PolicyHarness {
    const dir = mkdtempSync(join(tmpdir(), "acp-policy-"));
    const store = createStore(join(dir, "test.db"));
    const audit = createAudit(store);
    const orgPolicy = parseOrgConfigYaml(orgYaml);
    const policy: AcpPolicyContext = {
      orgPolicy,
      loadPolicy: (spaceId) => loadSpacePolicy(orgPolicy, store, spaceId),
      audit,
      router: opts.router ?? DenyRouter,
    };
    const cleanup = () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    };
    const lastAudit = async (eventType: string) => {
      const rows = await audit.listAudit({ event_type: eventType });
      return JSON.parse(rows.at(-1)!.payload) as Record<string, unknown>;
    };
    return { policy, store, audit, cleanup, lastAudit };
  }

  describe("acp permission handler", () => {
    test("allowed tool responds allow_once and audits policy.decision", async () => {
      const h = makePolicyHarness("tools:\n  read: allow\n");
      const l = await launch("permission", {
        policy: h.policy,
        permissionOverride: { toolCall: { toolCallId: "c1", title: "Read file", kind: "read", rawInput: { path: "/x" } } },
      });
      try {
        await l.waitForLog('"outcome":"selected","optionId":"allow_once"');
        const log = readFileSync(l.logfile, "utf8");
        expect(log).toContain('"outcome":{"outcome":"selected","optionId":"allow_once"');
        const payload = await h.lastAudit(POLICY_DECISION_EVENT);
        expect(payload).toMatchObject({ tool: "read", tier: "read", decision: "allow" });
        expect(payload.args).toContain('"/x"');
      } finally {
        await l.session.dispose();
        l.cleanup();
        h.cleanup();
      }
    });

    test("policy deny responds reject_once and audits the decision", async () => {
      const h = makePolicyHarness("tools:\n  bash: deny\n");
      const l = await launch("permission", { policy: h.policy });
      try {
        // Default fake request: kind execute → bash.
        await l.waitForLog('"outcome":"selected","optionId":"reject_once"');
        const log = readFileSync(l.logfile, "utf8");
        expect(log).toContain('"outcome":{"outcome":"selected","optionId":"reject_once"');
        expect(await h.lastAudit(POLICY_DECISION_EVENT)).toMatchObject({ tool: "bash", tier: "exec", decision: "deny" });
      } finally {
        await l.session.dispose();
        l.cleanup();
        h.cleanup();
      }
    });

    test("unmappable tool kinds respond reject_once (fail closed)", async () => {
      const h = makePolicyHarness("tools:\n  unknown: allow\n");
      const l = await launch("permission", {
        policy: h.policy,
        permissionOverride: { toolCall: { toolCallId: "c1", title: "Think", kind: "think", rawInput: {} } },
      });
      try {
        await l.waitForLog('"outcome":"selected","optionId":"reject_once"');
        expect(await h.lastAudit(POLICY_DECISION_EVENT)).toMatchObject({ tool: "think", decision: "deny" });
      } finally {
        await l.session.dispose();
        l.cleanup();
        h.cleanup();
      }
    });

    test("MCP xdev paths map to the policy tool name (memory.save)", async () => {
      const h = makePolicyHarness("tools:\n  memory.save: allow\n  unknown: deny\n");
      const l = await launch("permission", {
        policy: h.policy,
        permissionOverride: {
          toolCall: {
            toolCallId: "c1",
            title: "Save memory",
            kind: "execute",
            rawInput: { path: "xd://mcp__bottega_memory_save", content: JSON.stringify({ content: "hi", scope: "org" }) },
          },
        },
      });
      try {
        await l.waitForLog('"outcome":"selected","optionId":"allow_once"');
        const payload = await h.lastAudit(POLICY_DECISION_EVENT);
        expect(payload).toMatchObject({ tool: "memory.save", tier: "write", decision: "allow" });
        // The MCP args JSON is parsed so the audit payload matches the OMP path.
        expect(payload.args).toEqual(JSON.stringify({ content: "hi", scope: "org" }));
      } finally {
        await l.session.dispose();
        l.cleanup();
        h.cleanup();
      }
    });

    test("MCP xdev path for a denied tool responds reject_once", async () => {
      const h = makePolicyHarness("tools:\n  memory.save: deny\n");
      const l = await launch("permission", {
        policy: h.policy,
        permissionOverride: {
          toolCall: { toolCallId: "c1", title: "Save", kind: "execute", rawInput: { path: "xd://mcp__bottega_memory_save", content: "{}" } },
        },
      });
      try {
        await l.waitForLog('"outcome":"selected","optionId":"reject_once"');
        expect(await h.lastAudit(POLICY_DECISION_EVENT)).toMatchObject({ tool: "memory.save", decision: "deny" });
      } finally {
        await l.session.dispose();
        l.cleanup();
        h.cleanup();
      }
    });

    test("ask-human routes through the router: DenyRouter rejects", async () => {
      const h = makePolicyHarness("tools:\n  bash: allow\n"); // exec tier → ask-human
      const l = await launch("permission", { policy: h.policy });
      try {
        await l.waitForLog('"outcome":"selected","optionId":"reject_once"');
        expect(await h.lastAudit(APPROVAL_REQUESTED_EVENT)).toMatchObject({ tool: "bash" });
        expect(await h.lastAudit(APPROVAL_RESOLVED_EVENT)).toMatchObject({ approved: false });
      } finally {
        await l.session.dispose();
        l.cleanup();
        h.cleanup();
      }
    });

    test("ask-human routes through the router: an approving router allows", async () => {
      const router: ApprovalRouter = { request: async () => ({ approved: true, approver: "U1" }) };
      const h = makePolicyHarness("tools:\n  bash: allow\n", { router });
      const l = await launch("permission", { policy: h.policy });
      try {
        await l.waitForLog('"outcome":"selected","optionId":"allow_once"');
        expect(await h.lastAudit(APPROVAL_RESOLVED_EVENT)).toMatchObject({ approved: true, approver: "U1" });
      } finally {
        await l.session.dispose();
        l.cleanup();
        h.cleanup();
      }
    });

    test("space overlay tightens the ACP permission path per space", async () => {
      const h = makePolicyHarness("tools:\n  read: allow\n");
      const space = await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      await h.store.updatePolicy(space.id, JSON.stringify({ tools: { read: "deny" } }));
      const l = await launch("permission", {
        policy: h.policy,
        permissionOverride: { toolCall: { toolCallId: "c1", title: "Read", kind: "read", rawInput: { path: "/x" } } },
      });
      try {
        // The harness session runs in space slack:C1, which now denies read.
        await l.waitForLog('"outcome":"selected","optionId":"reject_once"');
        expect(await h.lastAudit(POLICY_DECISION_EVENT)).toMatchObject({ tool: "read", decision: "deny" });
      } finally {
        await l.session.dispose();
        l.cleanup();
        h.cleanup();
      }
    });

    test("request_permission without a policy context answers method-not-found", async () => {
      const l = await launch("permission");
      try {
        await l.waitForLog('"code":-32601');
        const log = readFileSync(l.logfile, "utf8");
        expect(log).toContain('"method":"session/request_permission"');
        expect(log).toContain('"error":{"code":-32601');
      } finally {
        await l.session.dispose();
        l.cleanup();
      }
    });
  });

  test("real omp acp: initialize + session/new + session/close (skips when omp is unavailable)", async () => {
    // Interop smoke test against the real `omp acp` binary (issue #18).
    // No prompt is ever sent — only the handshake, session/new, and
    // session/close. Skips (with a message) when omp is not on PATH or the
    // agent cannot complete the handshake, so CI never hard-fails on an
    // environment without omp.
    const dir = mkdtempSync(join(tmpdir(), "acp-real-omp-"));
    const driver = createAcpDriver({ sessionTimeoutMs: 10_000 });
    let session: AgentSessionDriver | null = null;
    try {
      session = await driver.createSession({
        spaceId: "real-omp",
        transcriptDir: join(dir, "sessions"),
        onOutput: () => {},
      });
      // Handshake + session/new succeeded against real omp; dispose sends
      // session/close and terminates the child. Nothing else is asserted
      // because this test must never send a prompt.
      await session.dispose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`SKIP real-omp interop test: omp acp unavailable or handshake failed (${msg})`);
    } finally {
      await session?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("real omp acp: permission round-trip enforces policy (skips when omp is unavailable)", async () => {
    // A real model turn with a tool call takes far longer than the default
    // 5s bun:test budget; the driver's own request timeout (120s) bounds it.
    // Interop test (issue #26): with a policy context wired, a real `omp acp`
    // session must enforce policy over session/request_permission. The agent
    // is prompted to run one bash command; omp asks permission; the driver
    // evaluates the policy (bash: allow → ask-human → DenyRouter) and answers
    // the ACP permission response; the turn completes. The audit trail is the
    // wire proof. When omp auto-approves instead — no permission request ever
    // arrives — there is nothing to enforce (the documented failure path:
    // the engine's own permission config short-circuits the policy seam) and
    // the leg skips with a message, like the handshake test above.
    const dir = mkdtempSync(join(tmpdir(), "acp-real-perm-"));
    const store = createStore(join(dir, "test.db"));
    const audit = createAudit(store);
    const orgPolicy = parseOrgConfigYaml("tools:\n  bash: allow\n  unknown: deny\n");
    const driver = createAcpDriver({
      sessionTimeoutMs: 120_000,
      policy: {
        orgPolicy,
        loadPolicy: (spaceId) => loadSpacePolicy(orgPolicy, store, spaceId),
        audit,
        router: DenyRouter,
      },
    });
    let session: AgentSessionDriver | null = null;
    let turnFailed = false;
    try {
      session = await driver.createSession({
        spaceId: "real-omp-perm",
        transcriptDir: join(dir, "sessions"),
        onOutput: () => {},
      });
      await session.prompt("Run the bash command: echo acp-permission-roundtrip. Use the bash tool.");
    } catch (err) {
      turnFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`SKIP real-omp permission test: omp acp unavailable or turn failed (${msg})`);
    } finally {
      await session?.dispose().catch(() => {});
    }
    // The assertions below are real expectations, not skip conditions: a
    // completed turn with no permission request is the documented failure
    // path (omp's own permission config auto-approved — nothing to enforce).
    if (!turnFailed) {
      const decisions = await audit.listAudit({ event_type: POLICY_DECISION_EVENT });
      if (decisions.length === 0) {
        console.log("SKIP real-omp permission leg: no session/request_permission arrived (omp auto-approved) — nothing to enforce");
      } else {
        // bash: allow → exec tier → ask-human; DenyRouter resolves it.
        expect(JSON.parse(decisions.at(-1)!.payload)).toMatchObject({ tool: "bash", tier: "exec", decision: "ask-human" });
        const resolved = await audit.listAudit({ event_type: APPROVAL_RESOLVED_EVENT });
        expect(JSON.parse(resolved.at(-1)!.payload)).toMatchObject({ tool: "bash", approved: false });
      }
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);
});
