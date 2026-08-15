import { describe, expect, test, vi } from "bun:test";
import type { Store } from "../../store/db";
import type { MemoryProvider, MemorySaveInput, MemorySearchQuery } from "../../memory/types";
import { sessionFilePath, type AgentDriver, type AgentSessionDriver, type AgentTurnOptions } from "../drivers/agent-driver";
import { SpaceService, DIGEST_CAP, type InboundMessage } from "./space-service";
import type { SlackAdapter } from "../adapters/slack";

// ---------------------------------------------------------------------------
// Fakes: no real model, no network. The driver seam is what keeps these tests
// hermetic — SpaceService sees only AgentSessionDriver, never OMP.
// ---------------------------------------------------------------------------

class FakeSession implements AgentSessionDriver {
  readonly spaceId: string;
  readonly prompts: Array<{ text: string; opts?: AgentTurnOptions }> = [];
  disposed = false;
  streaming = false;
  /** When true, prompt() parks until finishDispose() — exposes the mid-dispose window. */
  deferDispose = false;
  /** When true, prompt() parks until finishPrompt() — exposes the digest bound. */
  deferPrompt = false;
  /** When true, prompt() throws — exercises the handler's failure path. */
  failPrompt = false;
  /** When set, prompt() emits a message event with this text (the model's reply). */
  autoReply?: string;

  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  private disposeGate?: { promise: Promise<void>; resolve: () => void };
  private promptGate?: { promise: Promise<void>; resolve: () => void };

  constructor(spaceId = "slack:C1") {
    this.spaceId = spaceId;
  }

  async prompt(text: string, opts?: AgentTurnOptions): Promise<void> {
    if (this.failPrompt) throw new Error("fake prompt failure");
    this.prompts.push({ text, opts });
    if (this.deferPrompt) {
      const gate = Promise.withResolvers<void>();
      this.promptGate = gate;
      await gate.promise;
    }
    if (this.autoReply !== undefined) {
      this.emit("message", { spaceId: this.spaceId, text: this.autoReply });
    }
  }

  finishPrompt(): void {
    this.promptGate?.resolve();
    this.promptGate = undefined;
  }

  async abort(): Promise<void> {}

  isStreaming(): boolean {
    return this.streaming;
  }

  on(event: "message" | "turn_start" | "turn_end" | "error", cb: (data: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  emit(event: "message" | "turn_start" | "turn_end" | "error", data: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.deferDispose) {
      const gate = Promise.withResolvers<void>();
      this.disposeGate = gate;
      await gate.promise;
    }
  }

  finishDispose(): void {
    this.disposeGate?.resolve();
    this.disposeGate = undefined;
  }
}

interface CreateSessionOpts {
  spaceId: string;
  transcriptDir: string;
  onOutput: (spaceId: string, text: string) => void;
  getPrincipal?: () => string | undefined;
}

class FakeDriver implements AgentDriver {
  readonly created: Array<{ opts: CreateSessionOpts; session: FakeSession }> = [];

  async createSession(opts: CreateSessionOpts): Promise<AgentSessionDriver> {
    const session = new FakeSession(opts.spaceId);
    this.created.push({ opts, session });
    return session;
  }

  last(): FakeSession {
    return this.created[this.created.length - 1].session;
  }
}

/**
 * Stateful memory fake: digest saves feed back into marker lookups, so the
 * "marker advanced" behavior is observable across dispose cycles.
 */
class FakeMemoryProvider implements MemoryProvider {
  saved: MemorySaveInput[] = [];
  /** Digest entries (newest last): {space, since, until}. */
  digests: Array<{ space: string; since: string; until: string }> = [];

  async save(input: MemorySaveInput) {
    this.saved.push(input);
    if (input.metadata?.kind === "digest") {
      this.digests.push({
        space: input.metadata.space ?? "",
        since: input.metadata.since ?? "",
        until: input.metadata.until ?? "",
      });
    }
    return {
      id: `mem_${this.saved.length}`,
      scope: input.scope,
      principal: input.principal ?? null,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: 1000,
    };
  }

  async search(query: MemorySearchQuery) {
    if (query.metadata?.kind === "digest") {
      const matches = this.digests.filter((d) => d.space === query.metadata!.space);
      const newest = matches[matches.length - 1];
      return newest
        ? [
            {
              id: "mem_digest",
              scope: "org" as const,
              principal: null,
              content: "digest",
              metadata: { kind: "digest", space: newest.space, since: newest.since, until: newest.until },
              createdAt: 1000,
            },
          ]
        : [];
    }
    return [];
  }
}

function fakeAdapter(): {
  adapter: SlackAdapter;
  posts: Array<{ spaceId: string; text: string; opts?: { threadTs?: string } }>;
  updates: Array<{ spaceId: string; ts: string; text: string }>;
} {
  const posts: Array<{ spaceId: string; text: string; opts?: { threadTs?: string } }> = [];
  const updates: Array<{ spaceId: string; ts: string; text: string }> = [];
  const adapter: SlackAdapter = {
    async postMessage(spaceId, text, opts) {
      posts.push({ spaceId, text, opts });
      return `ts-${posts.length}`; // deterministic ts per post
    },
    async updateMessage(spaceId, ts, text) {
      updates.push({ spaceId, ts, text });
    },
    async start() {},
    async stop() {},
  };
  return { adapter, posts, updates };
}

function fakeStore(): {
  store: Store;
  audit: Array<{ space_id: string | null; actor: string; event_type: string; payload: string }>;
} {
  const audit: Array<{ space_id: string | null; actor: string; event_type: string; payload: string }> = [];
  const store = {
    appendAudit: async (entry: { space_id: string | null; actor: string; event_type: string; payload: string }) => {
      audit.push(entry);
      return audit.length;
    },
  } as unknown as Store;
  return { store, audit };
}

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { spaceId: "slack:C1", principal: "U1", text: "hello", ts: "1.1", ...overrides };
}

describe("SpaceService session lifecycle", () => {
  test("sessions are lazy: the first message cold-starts a session that gets the prompt", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    expect(driver.created).toHaveLength(0); // no session until a message arrives

    await service.handleInboundMessage(msg({ text: "hello", ts: "1.1" }));

    expect(driver.created).toHaveLength(1);
    expect(driver.created[0].opts.spaceId).toBe("slack:C1");
    expect(driver.last().prompts).toEqual([{ text: "hello", opts: undefined }]);
  });

  test("each space gets its own session", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ spaceId: "slack:C1" }));
    await service.handleInboundMessage(msg({ spaceId: "slack:C2" }));

    expect(driver.created).toHaveLength(2);
    expect(driver.created[0].opts.spaceId).toBe("slack:C1");
    expect(driver.created[1].opts.spaceId).toBe("slack:C2");
  });

  test("a message while the agent streams steers the running turn instead of prompting", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ text: "first" }));
    driver.last().streaming = true;
    await service.handleInboundMessage(msg({ text: "second", ts: "2.2" }));

    const session = driver.last();
    expect(driver.created).toHaveLength(1); // same session reused
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toEqual({ text: "second", opts: { streamingBehavior: "steer" } });
  });

  test("idle timeout disposes the session; the next message cold-starts a fresh one", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    vi.useFakeTimers();
    try {
      const service = new SpaceService({ store, adapter, driver, idleTimeoutMs: 20 });

      await service.handleInboundMessage(msg({ text: "first" }));
      const first = driver.last();

      vi.advanceTimersByTime(20); // idle timer fires; dispose runs
      for (let i = 0; i < 5; i++) await Promise.resolve(); // flush the dispose promise chain
      expect(first.disposed).toBe(true);

      await service.handleInboundMessage(msg({ text: "second", ts: "2.2" }));

      expect(driver.created).toHaveLength(2);
      expect(driver.last()).not.toBe(first);
      expect(driver.last().prompts).toEqual([{ text: "second", opts: undefined }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("sessions are file-backed under the transcript dir, one file per space", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver, transcriptDir: "data/sessions" });

    await service.handleInboundMessage(msg());

    expect(driver.created[0].opts.transcriptDir).toBe("data/sessions");
    expect(sessionFilePath("data/sessions", "slack:C1")).toBe("data/sessions/slack:C1.jsonl");
  });

  test("a message queued mid-dispose is dropped and audited; cold start works after dispose settles", async () => {
    const { adapter } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    vi.useFakeTimers();
    try {
      const service = new SpaceService({ store, adapter, driver, idleTimeoutMs: 20 });

      await service.handleInboundMessage(msg({ ts: "1.1" }));
      driver.last().deferDispose = true;

      vi.advanceTimersByTime(20); // idle timer fires; dispose starts and parks on the gate
      expect(driver.last().disposed).toBe(true);

      await service.handleInboundMessage(msg({ text: "during", ts: "2.2" }));

      expect(driver.last().prompts).toHaveLength(1); // dropped, never prompted
      expect(driver.created).toHaveLength(1); // no cold start while disposing
      expect(audit).toEqual([
        {
          space_id: "slack:C1",
          actor: "U1",
          event_type: "message_dropped",
          payload: JSON.stringify({ reason: "session_disposing", ts: "2.2" }),
        },
      ]);

      driver.last().finishDispose();
      for (let i = 0; i < 5; i++) await Promise.resolve(); // flush the dispose finally-block

      await service.handleInboundMessage(msg({ text: "after", ts: "3.3" }));
      expect(driver.created).toHaveLength(2); // cold start once disposal completed
      expect(driver.last().prompts).toEqual([{ text: "after", opts: undefined }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stop disposes every live session", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ spaceId: "slack:C1" }));
    await service.handleInboundMessage(msg({ spaceId: "slack:C2" }));
    await service.stop();

    expect(driver.created).toHaveLength(2);
    expect(driver.created.every(({ session }) => session.disposed)).toBe(true);
  });

  test("a failing session call is caught and logged, not thrown", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ text: "ok" }));
    driver.last().failPrompt = true;

    await expect(service.handleInboundMessage(msg({ text: "boom" }))).resolves.toBeUndefined();
    expect(driver.last().prompts).toHaveLength(1);
  });

  test("sessions get a getPrincipal getter that tracks the space's last inbound principal", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ principal: "U1", ts: "1.1" }));
    await service.handleInboundMessage(msg({ principal: "U2", ts: "2.2" }));

    expect(driver.created).toHaveLength(1); // same session, getter stays fresh
    const getPrincipal = driver.created[0].opts.getPrincipal!;
    expect(getPrincipal()).toBe("U2");
  });
});

describe("SpaceService output routing", () => {
  test("agent output is posted to the adapter threaded under the latest inbound message", async () => {
    const { adapter, posts } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    driver.last().emit("message", { spaceId: "slack:C1", text: "agent reply" });
    await Promise.resolve();

    expect(posts).toEqual([{ spaceId: "slack:C1", text: "agent reply", opts: { threadTs: "1.1" } }]);
  });

  test("onOutput is unconsumed: the message event is the single post channel", async () => {
    const { adapter, posts } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    driver.created[0].opts.onOutput("slack:C1", "output channel");
    await Promise.resolve();
    expect(posts).toHaveLength(0); // no double post from the legacy channel

    driver.last().emit("message", { spaceId: "slack:C1", text: "event channel" });
    await Promise.resolve();
    expect(posts).toEqual([{ spaceId: "slack:C1", text: "event channel", opts: { threadTs: "1.1" } }]);
  });

  test("turn_start posts a thinking phrase; the message event replaces it in place", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();

    session.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve(); // settle the phrase post so its ts is captured
    expect(posts).toEqual([{ spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } }]);

    session.emit("message", { spaceId: "slack:C1", text: "the answer" });
    await Promise.resolve();

    expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-1", text: "the answer" }]);
    expect(posts).toHaveLength(1); // replaced in place, nothing posted fresh
  });

  test("DM replies are plain messages (no thread); channel replies keep threading; phrases rotate", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ spaceId: "slack:D1", ts: "1.1" }));
    const dm = driver.last();
    dm.emit("turn_start", { spaceId: "slack:D1" });
    await Promise.resolve();
    dm.emit("message", { spaceId: "slack:D1", text: "dm answer" });
    await Promise.resolve();

    await service.handleInboundMessage(msg({ spaceId: "slack:C1", ts: "9.9" }));
    const channel = driver.last();
    channel.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve();
    channel.emit("message", { spaceId: "slack:C1", text: "channel answer" });
    await Promise.resolve();

    expect(posts).toEqual([
      { spaceId: "slack:D1", text: "Thinking…", opts: undefined },
      { spaceId: "slack:C1", text: "On it — thinking…", opts: { threadTs: "9.9" } },
    ]);
    expect(updates).toEqual([
      { spaceId: "slack:D1", ts: "ts-1", text: "dm answer" },
      { spaceId: "slack:C1", ts: "ts-2", text: "channel answer" },
    ]);
  });

  test("a session error replaces the thinking phrase with the error text", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve();
    session.emit("error", { spaceId: "slack:C1", message: "model exploded" });
    await Promise.resolve();

    expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-1", text: "model exploded" }]);
    expect(posts).toHaveLength(1); // phrase only; error replaced it
  });

  test("a reply with no pending phrase falls back to posting fresh", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    driver.last().emit("message", { spaceId: "slack:C1", text: "late answer" });
    await Promise.resolve();

    expect(posts).toEqual([{ spaceId: "slack:C1", text: "late answer", opts: { threadTs: "1.1" } }]);
    expect(updates).toHaveLength(0);
  });

  test("a turn that ends with neither message nor error leaves the phrase as-is", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve();
    session.emit("turn_end", { spaceId: "slack:C1" });
    await Promise.resolve();

    expect(posts).toEqual([{ spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } }]);
    expect(updates).toHaveLength(0); // phrase stays, never replaced
  });

  test("the session driver emits message events to subscribers (contract surface)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg());
    const session = driver.last();
    const received: unknown[] = [];
    const unsubscribe = session.on("message", (data) => received.push(data));
    session.emit("message", { spaceId: "slack:C1", text: "event output" });
    unsubscribe();
    session.emit("message", { spaceId: "slack:C1", text: "after unsubscribe" });

    expect(received).toEqual([{ spaceId: "slack:C1", text: "event output" }]);
  });
});

describe("SpaceService digest-on-idle", () => {
  test("dispose digests new messages into org memory, advances the marker, and disposes", async () => {
    const { adapter } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const provider = new FakeMemoryProvider();
    const service = new SpaceService({ store, adapter, driver, memoryProvider: provider });

    await service.handleInboundMessage(msg({ text: "hello", ts: "1.1" }));
    const first = driver.last();
    first.autoReply = "- first digest";
    await service.stop();

    // Digest turn: one silent summary prompt whose output was captured.
    expect(first.prompts).toHaveLength(2);
    expect(first.prompts[1].text).toContain("Summarize this conversation so far");
    expect(first.prompts[1].opts).toEqual({ silent: true });
    expect(provider.saved).toEqual([
      {
        scope: "org",
        content: "- first digest",
        metadata: { kind: "digest", space: "slack:C1", since: "", until: "1.1" },
      },
    ]);
    expect(first.disposed).toBe(true);
    expect(audit).toHaveLength(0); // no failure audited

    // Marker advanced: the next digest reads `until` from the newest digest.
    await service.handleInboundMessage(msg({ text: "more", ts: "2.2" }));
    const second = driver.last();
    second.autoReply = "- second digest";
    await service.stop();

    expect(second.prompts[1].text).toContain("since 1.1");
    expect(provider.saved).toHaveLength(2);
    expect(provider.saved[1].metadata).toEqual({ kind: "digest", space: "slack:C1", since: "1.1", until: "2.2" });
    expect(second.disposed).toBe(true);
  });

  test("prunes to the digest cap after a successful save", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const provider = new FakeMemoryProvider();
    const prunes: Array<{ spaceId: string; keep: number }> = [];
    const service = new SpaceService({
      store,
      adapter,
      driver,
      memoryProvider: provider,
      digestPrune: async (spaceId, keep) => void prunes.push({ spaceId, keep }),
    });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    driver.last().autoReply = "- digest";
    await service.stop();

    expect(prunes).toEqual([{ spaceId: "slack:C1", keep: DIGEST_CAP }]);
  });

  test("no messages newer than the marker means no digest", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const provider = new FakeMemoryProvider();
    provider.digests.push({ space: "slack:C1", since: "0.1", until: "1.1" });
    const service = new SpaceService({ store, adapter, driver, memoryProvider: provider });

    await service.handleInboundMessage(msg({ ts: "1.1" })); // same ts as the marker
    await service.stop();

    expect(driver.last().prompts).toHaveLength(1); // the message only, no digest turn
    expect(provider.saved).toHaveLength(0);
    expect(driver.last().disposed).toBe(true);
  });

  test("a failing summary turn audits digest.failed and still disposes", async () => {
    const { adapter } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const provider = new FakeMemoryProvider();
    const service = new SpaceService({ store, adapter, driver, memoryProvider: provider });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.failPrompt = true;
    await service.stop();

    expect(provider.saved).toHaveLength(0);
    expect(audit).toEqual([
      {
        space_id: "slack:C1",
        actor: "system",
        event_type: "digest.failed",
        payload: JSON.stringify({ reason: "fake prompt failure" }),
      },
    ]);
    expect(session.disposed).toBe(true);
  });

  test("an empty summary is a digest failure, audited, and dispose proceeds", async () => {
    const { adapter } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const provider = new FakeMemoryProvider();
    const service = new SpaceService({ store, adapter, driver, memoryProvider: provider });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.autoReply = ""; // turn completes with no text
    await service.stop();

    expect(provider.saved).toHaveLength(0);
    expect(audit).toEqual([
      {
        space_id: "slack:C1",
        actor: "system",
        event_type: "digest.failed",
        payload: JSON.stringify({ reason: "empty summary" }),
      },
    ]);
    expect(session.disposed).toBe(true);
  });

  test("a digest turn that never settles times out, audits, and disposes", async () => {
    const { adapter } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const provider = new FakeMemoryProvider();
    const service = new SpaceService({
      store,
      adapter,
      driver,
      memoryProvider: provider,
      digestTimeoutMs: 10,
    });
    vi.useFakeTimers();
    try {
      await service.handleInboundMessage(msg({ ts: "1.1" }));
      const session = driver.last();
      session.deferPrompt = true; // prompt never resolves on its own
      const stopPromise = service.stop();
      for (let i = 0; i < 10; i++) await Promise.resolve(); // let the digest reach withTimeout
      vi.advanceTimersByTime(10); // the digest bound fires
      for (let i = 0; i < 10; i++) await Promise.resolve(); // flush the timeout chain

      expect(provider.saved).toHaveLength(0);
      expect(audit).toEqual([
        {
          space_id: "slack:C1",
          actor: "system",
          event_type: "digest.failed",
          payload: expect.stringContaining("timed out"),
        },
      ]);
      session.finishPrompt(); // let the parked turn settle so dispose proceeds
      await stopPromise;
      expect(session.disposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a streaming session is not idle: dispose skips the digest and does not hijack the turn", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const provider = new FakeMemoryProvider();
    const service = new SpaceService({ store, adapter, driver, memoryProvider: provider });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.streaming = true;
    session.autoReply = "- digest";
    await service.stop();

    expect(session.prompts).toHaveLength(1); // no digest turn steered into the stream
    expect(provider.saved).toHaveLength(0);
    expect(session.disposed).toBe(true);
  });

  test("without a memory provider dispose never digests", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.autoReply = "- digest";
    await service.stop();

    expect(session.prompts).toHaveLength(1); // no digest turn
    expect(session.disposed).toBe(true);
  });
});
