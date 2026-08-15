import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpDriver } from "./acp-driver";
import type { AgentSessionDriver } from "./agent-driver";
import { SpaceService, type InboundMessage } from "./space-service";
import type { SlackAdapter } from "./slack";
import type { Store } from "../store/db";

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

async function launch(scenario: string, opts: { sessionTimeoutMs?: number } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "acp-driver-"));
  const logfile = join(dir, "server.log");
  const driver = createAcpDriver({
    command: "bun",
    args: ["run", FIXTURE, scenario, logfile],
    sessionTimeoutMs: opts.sessionTimeoutMs ?? 5_000,
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
    const adapter: SlackAdapter = {
      async postMessage(spaceId, text, opts) {
        posts.push({ spaceId, text, opts });
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
      await service.start();
      const msg: InboundMessage = { spaceId: "slack:C1", principal: "U1", text: "hello", ts: "1.1" };
      await service.handleInboundMessage(msg);
      const deadline = Date.now() + 3_000;
      while (posts.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(posts).toEqual([{ spaceId: "slack:C1", text: "Hello, world!", opts: { threadTs: "1.1" } }]);
    } finally {
      await service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
