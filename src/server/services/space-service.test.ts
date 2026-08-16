import { describe, expect, test, vi } from "bun:test";
import type { Store, ExtensionCredential } from "../../store/db";
import type { MemoryProvider, MemorySaveInput, MemorySearchQuery } from "../../memory/types";
import { sessionFilePath, SessionModelRoleRegistry, type AgentDriver, type AgentSessionDriver, type AgentTurnOptions } from "../drivers/agent-driver";
import { SpaceService, DIGEST_CAP, REQUEST_ONLY_DIRECTIVE, SLACK_FORMAT_DIRECTIVE, EMPTY_TURN_LIMIT, EMPTY_RESPONSE_FALLBACK, CHURN_MESSAGE, parseConnectIntent } from "./space-service";
import type { ResponseMode } from "../../policy/config";
import { parseOrgConfigYaml } from "../../policy/config";
import type { SlackAdapter, SlackMessage } from "../adapters/slack";
import type { ConnectExtensionDeps } from "../../extensions/connect";
import { createFixtureRegistry } from "../../extensions/fixture";
import { DenyRouter, type ApprovalRequest, type ApprovalResolution, type ApprovalRouter } from "../../policy/approval-router";
import type { AuditModule } from "../../policy/audit";
import { EXTENSION_CONNECTED_EVENT, POLICY_DECISION_EVENT, ADMIN_ONBOARDING_NUDGE_EVENT } from "../../store/audit-events";
import type { WizardCheck } from "../../tools/admin";

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
  appendSystemPrompt?: string;
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

function fakeAdapter(opts: { deferPost?: boolean } = {}): {
  adapter: SlackAdapter;
  posts: Array<{ spaceId: string; text: string; opts?: { threadTs?: string } }>;
  updates: Array<{ spaceId: string; ts: string; text: string }>;
  releasePost: () => void;
} {
  const { deferPost = false } = opts;
  const posts: Array<{ spaceId: string; text: string; opts?: { threadTs?: string } }> = [];
  const updates: Array<{ spaceId: string; ts: string; text: string }> = [];
  let releasePost = () => {};
  const adapter: SlackAdapter = {
    async postMessage(spaceId, text, postOpts) {
      posts.push({ spaceId, text, opts: postOpts });
      if (deferPost) {
        await new Promise<void>((resolve) => {
          releasePost = resolve;
        });
      }
      return `ts-${posts.length}`; // deterministic ts per post
    },
    async updateMessage(spaceId, ts, text) {
      updates.push({ spaceId, ts, text });
    },
    async start() {},
    async stop() {},
  };
  return { adapter, posts, updates, releasePost: () => releasePost() };
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
    // runWizardChecks (the default onboarding-checks seam, issue #116) reads
    // org settings; no settings blob is the normal unset state.
    getOrgSettings: () => null,
  } as unknown as Store;
  return { store, audit };
}

function msg(overrides: Partial<SlackMessage> = {}): SlackMessage {
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

  test("live sessions register in the model-role registry and unregister on dispose (issue #64)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    vi.useFakeTimers();
    try {
      const modelRoles = new SessionModelRoleRegistry();
      const service = new SpaceService({ store, adapter, driver, modelRoles, idleTimeoutMs: 20 });

      expect(modelRoles.has("slack:C1")).toBe(false);
      await service.handleInboundMessage(msg());

      // The live session is the use_model switch target while it lives.
      expect(modelRoles.has("slack:C1")).toBe(true);

      vi.advanceTimersByTime(20); // idle timer fires; dispose runs
      for (let i = 0; i < 5; i++) await Promise.resolve(); // flush the dispose finally-block
      expect(modelRoles.has("slack:C1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
    // All-pass checks: this test is about the error surface, not the
    // onboarding nudge (issue #116).
    const service = new SpaceService({ store, adapter, driver, onboardingChecks: () => [] });

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

  test("a retry's turn_start updates the pending phrase in place — one message max (issue #60)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();

    session.emit("turn_start", { spaceId: "slack:C1" }); // first attempt
    await Promise.resolve();
    session.emit("turn_start", { spaceId: "slack:C1" }); // OMP auto-retry: another attempt
    await Promise.resolve();

    expect(posts).toHaveLength(1); // exactly one phrase posted
    expect(posts[0]).toEqual({ spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } });
    expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-1", text: "On it — thinking…" }]); // replaced in place
  });

  test("a turn_start while the phrase post is in flight never posts a second phrase (issue #60)", async () => {
    const { adapter, posts, updates, releasePost } = fakeAdapter({ deferPost: true });
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();

    session.emit("turn_start", { spaceId: "slack:C1" }); // post parked in flight
    await Promise.resolve();
    session.emit("turn_start", { spaceId: "slack:C1" }); // retry before the ts is known
    await Promise.resolve();
    expect(posts).toHaveLength(1); // second turn_start must not post

    releasePost(); // the in-flight post resolves; it becomes the one phrase
    await Promise.resolve();
    await Promise.resolve();
    session.emit("turn_start", { spaceId: "slack:C1" }); // now it updates in place
    await Promise.resolve();

    expect(posts).toHaveLength(1);
    expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-1", text: "On it — thinking…" }]);
  });

  test("an empty message text replaces the phrase with the empty-response fallback (issue #60)", async () => {
    for (const empty of ["", "   ", "\n\t"]) {
      const { adapter, posts, updates } = fakeAdapter();
      const { store } = fakeStore();
      const driver = new FakeDriver();
      const service = new SpaceService({ store, adapter, driver });

      await service.handleInboundMessage(msg({ ts: "1.1" }));
      const session = driver.last();
      session.emit("turn_start", { spaceId: "slack:C1" });
      await Promise.resolve();
      session.emit("message", { spaceId: "slack:C1", text: empty });
      await Promise.resolve();

      expect(posts).toHaveLength(1); // phrase only
      expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-1", text: EMPTY_RESPONSE_FALLBACK }]);
    }
  });

  test("an empty completion is counted, and a later real reply resets the streak (issue #60)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    for (let i = 0; i < EMPTY_TURN_LIMIT; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await Promise.resolve();
      session.emit("message", { spaceId: "slack:C1", text: "" });
      await Promise.resolve();
    }
    expect(posts).toHaveLength(1); // never stacked, even across empties
    // Each turn: a rotation update (turn_start, i>0) plus a fallback update
    // (empty message) — all replaced in place on the same ts.
    expect(updates).toHaveLength(EMPTY_TURN_LIMIT * 2 - 1);
    expect(updates.every((u) => u.spaceId === "slack:C1" && u.ts === "ts-1")).toBe(true);
    expect(updates.filter((u) => u.text === EMPTY_RESPONSE_FALLBACK)).toHaveLength(EMPTY_TURN_LIMIT);

    // A real reply ends the streak and replaces the phrase.
    session.emit("message", { spaceId: "slack:C1", text: "finally an answer" });
    await Promise.resolve();
    expect(updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: "ts-1", text: "finally an answer" });
    expect(posts).toHaveLength(1);
  });

  test(`${EMPTY_TURN_LIMIT + 1} empty turns surface one churn message, then phrases stop posting (issue #60)`, async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    // All-pass checks: this test is about the churn surface, not the
    // onboarding nudge (issue #116).
    const service = new SpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    // Real retry-loop shape: silent turn_start/turn_end pairs (empty output is
    // filtered before the message event by both drivers).
    for (let i = 0; i < EMPTY_TURN_LIMIT + 1; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await Promise.resolve();
      session.emit("turn_end", { spaceId: "slack:C1" });
      await Promise.resolve();
    }

    expect(posts).toHaveLength(1); // one phrase, never stacked
    // Three in-place rotations + one churn message = all on the same ts.
    expect(updates).toEqual([
      { spaceId: "slack:C1", ts: "ts-1", text: "On it — thinking…" },
      { spaceId: "slack:C1", ts: "ts-1", text: "Give me a second…" },
      { spaceId: "slack:C1", ts: "ts-1", text: "Working on it…" },
      { spaceId: "slack:C1", ts: "ts-1", text: CHURN_MESSAGE },
    ]);

    // Silence: further retries neither post nor update.
    session.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve();
    session.emit("turn_end", { spaceId: "slack:C1" });
    await Promise.resolve();
    expect(posts).toHaveLength(1);
    expect(updates).toHaveLength(EMPTY_TURN_LIMIT + 1);

    // A non-empty turn re-arms phrases and posts fresh (churn message is final).
    session.emit("message", { spaceId: "slack:C1", text: "recovered" });
    await Promise.resolve();
    expect(posts).toHaveLength(2); // churn message + fresh reply
    expect(posts[1]).toEqual({ spaceId: "slack:C1", text: "recovered", opts: { threadTs: "1.1" } });
    session.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve();
    expect(posts).toHaveLength(3); // phrases are back
  });

  test("empty message events past the limit surface one churn message, then silence (issue #60)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    for (let i = 0; i < EMPTY_TURN_LIMIT + 1; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await Promise.resolve();
      session.emit("message", { spaceId: "slack:C1", text: "" });
      await Promise.resolve();
    }

    expect(posts).toHaveLength(1); // one message total, replaced in place throughout
    expect(updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: "ts-1", text: CHURN_MESSAGE });

    session.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve();
    session.emit("message", { spaceId: "slack:C1", text: "" });
    await Promise.resolve();
    expect(posts).toHaveLength(1);
    // Rotations (N) + fallbacks (N) + churn (1) — churn shown exactly once.
    expect(updates).toHaveLength(EMPTY_TURN_LIMIT * 2 + 1);
  });

  test("dispose clears the pending phrase and churn state (issue #60)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    // Push the space into churn-silenced state with a pending phrase.
    for (let i = 0; i < EMPTY_TURN_LIMIT + 1; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await Promise.resolve();
      session.emit("turn_end", { spaceId: "slack:C1" });
      await Promise.resolve();
    }
    expect(posts).toHaveLength(1);
    expect(updates.at(-1)?.text).toBe(CHURN_MESSAGE);

    await service.stop(); // dispose every live session

    // A cold start must not inherit the stale pending ts or the churn silence.
    await service.handleInboundMessage(msg({ ts: "2.2" }));
    const fresh = driver.last();
    expect(fresh).not.toBe(session);
    fresh.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve();
    expect(posts).toHaveLength(2); // fresh phrase posted: pending cleared, silence lifted
    fresh.emit("message", { spaceId: "slack:C1", text: "the answer" });
    await Promise.resolve();
    expect(updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: "ts-2", text: "the answer" });
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

describe("response mode → session prompt directive (issue #55)", () => {
  test("request-only sessions append the request-only directive after the Slack format directive", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({
      store,
      adapter,
      driver,
      responseModeFor: async (): Promise<ResponseMode> => "request-only",
    });

    await service.handleInboundMessage(msg());

    expect(driver.created).toHaveLength(1);
    expect(driver.created[0].opts.appendSystemPrompt).toBe(
      `${SLACK_FORMAT_DIRECTIVE}\n\n${REQUEST_ONLY_DIRECTIVE}`,
    );
    await service.stop();
  });

  test("always and mention sessions carry the Slack format directive", async () => {
    for (const mode of ["always", "mention"] as const) {
      const { adapter } = fakeAdapter();
      const { store } = fakeStore();
      const driver = new FakeDriver();
      const service = new SpaceService({
        store,
        adapter,
        driver,
        responseModeFor: async (): Promise<ResponseMode> => mode,
      });

      await service.handleInboundMessage(msg({ spaceId: `slack:${mode}` }));

      expect(driver.created).toHaveLength(1);
      expect(driver.created[0].opts.appendSystemPrompt).toBe(SLACK_FORMAT_DIRECTIVE);
      await service.stop();
    }
  });

  test("without a resolver the default mode is always (still formats for Slack)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg());

    expect(driver.created[0].opts.appendSystemPrompt).toBe(SLACK_FORMAT_DIRECTIVE);
    await service.stop();
  });
});

describe("parseConnectIntent (issue #61)", () => {
  test("exact connect shapes parse; everything else is null", () => {
    expect(parseConnectIntent("connect github")).toEqual({ extension: "github", scope: "personal" });
    expect(parseConnectIntent("connect github as org")).toEqual({ extension: "github", scope: "org" });
    expect(parseConnectIntent("connect github as me")).toEqual({ extension: "github", scope: "personal" });
    expect(parseConnectIntent("connect fixture.weather as org")).toEqual({ extension: "fixture.weather", scope: "org" });
    // Case-insensitive keyword + scope, whole-phrase match.
    expect(parseConnectIntent("Connect GitHub as Org")).toEqual({ extension: "GitHub", scope: "org" });
    expect(parseConnectIntent("  connect linear as me  ")).toEqual({ extension: "linear", scope: "personal" });

    // Any deviation stays agent territory.
    expect(parseConnectIntent("connect github please")).toBeNull();
    expect(parseConnectIntent("can you connect github")).toBeNull();
    expect(parseConnectIntent("connect github as org now")).toBeNull();
    expect(parseConnectIntent("connect github with key 123")).toBeNull();
    expect(parseConnectIntent("connect github, please")).toBeNull();
    expect(parseConnectIntent("connect")).toBeNull();
    expect(parseConnectIntent("")).toBeNull();
    expect(parseConnectIntent("connection github")).toBeNull();
  });
});

describe("SpaceService connect intent (issue #61)", () => {
  /** Approved-request router for org connects; DenyRouter is the default. */
  class RecordingRouter implements ApprovalRouter {
    readonly requests: ApprovalRequest[] = [];
    constructor(private resolution: ApprovalResolution = { approved: true }) {}
    async request(d: ApprovalRequest): Promise<ApprovalResolution> {
      this.requests.push(d);
      return this.resolution;
    }
  }

  interface ConnectHarness {
    deps: ConnectExtensionDeps;
    adapter: SlackAdapter;
    posts: Array<{ spaceId: string; text: string; opts?: { threadTs?: string } }>;
    store: Store;
    driver: FakeDriver;
    brokerCalls: Array<{ provider: string; credentialType: string; apiKey?: string }>;
    audit: Array<{ space_id?: string | null; actor: string; event_type: string; payload: unknown }>;
    rows: ExtensionCredential[];
  }

  function makeConnectHarness(opts: { router?: ApprovalRouter } = {}): ConnectHarness {
    const { adapter, posts } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const brokerCalls: Array<{ provider: string; credentialType: string; apiKey?: string }> = [];
    const audit: Array<{ space_id?: string | null; actor: string; event_type: string; payload: unknown }> = [];
    const rows: ExtensionCredential[] = [];
    const registry = createFixtureRegistry();
    const deps: ConnectExtensionDeps = {
      registry,
      store: {
        upsertExtensionCredential: async (input: {
          provider: string;
          identityKey: string;
          owner: string | null;
          scope: "org" | "personal";
          brokerCredentialId: number;
        }) => {
          const credential: ExtensionCredential = {
            id: `cred_${rows.length + 1}`,
            provider: input.provider,
            identity_key: input.identityKey,
            owner: input.owner,
            scope: input.scope,
            broker_credential_id: input.brokerCredentialId,
            created_at: 0,
          };
          rows.push(credential);
          return credential;
        },
      } as unknown as ConnectExtensionDeps["store"],
      audit: {
        appendAudit: async (entry) => {
          audit.push(entry);
          return audit.length;
        },
        listAudit: async () => [],
      } as AuditModule,
      broker: async (input) => {
        brokerCalls.push(input);
        return { identityKey: null, brokerCredentialId: 9 };
      },
      gate: {
        loadPolicy: () => Promise.resolve(parseOrgConfigYaml("tools:\n  connect_extension: allow\n")),
        router: opts.router ?? DenyRouter,
      },
    };
    return { deps, adapter, posts, store, driver, brokerCalls, audit, rows };
  }

  test("connect <ext> as me connects for the sender with no agent turn", async () => {
    const h = makeConnectHarness();
    const service = new SpaceService({ store: h.store, adapter: h.adapter, driver: h.driver, connect: h.deps });

    await service.handleInboundMessage(msg({ text: "connect fixture.weather as me", ts: "2.2" }));

    // No session, no agent tool call: the capability answered directly.
    expect(h.driver.created).toHaveLength(0);
    expect(h.posts).toEqual([
      { spaceId: "slack:C1", text: "Fixture Weather connected as @U1", opts: { threadTs: "2.2" } },
    ]);
    expect(h.brokerCalls).toEqual([{ provider: "fixture.weather", credentialType: "api_key" }]);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]!.scope).toBe("personal");
    expect(h.rows[0]!.owner).toBe("U1");
    expect(h.rows[0]!.broker_credential_id).toBe(9);

    const connected = h.audit.find((e) => e.event_type === EXTENSION_CONNECTED_EVENT);
    expect(connected).toMatchObject({
      space_id: "slack:C1",
      actor: "U1",
      payload: { extension: "fixture.weather", scope: "personal", owner: "U1" },
    });
    // Personal connects are unprivileged: no policy decision row.
    expect(h.audit.filter((e) => e.event_type === POLICY_DECISION_EVENT)).toHaveLength(0);
  });

  test("bare connect <ext> defaults to the sender's personal account", async () => {
    const h = makeConnectHarness();
    const service = new SpaceService({ store: h.store, adapter: h.adapter, driver: h.driver, connect: h.deps });

    await service.handleInboundMessage(msg({ text: "Connect fixture.weather", principal: "U2", ts: "3.3" }));

    expect(h.driver.created).toHaveLength(0);
    expect(h.posts[0]!.text).toBe("Fixture Weather connected as @U2");
    expect(h.rows[0]!.scope).toBe("personal");
    expect(h.rows[0]!.owner).toBe("U2");
  });

  test("connect <ext> as org crosses the gate; denied without approval", async () => {
    const h = makeConnectHarness({ router: DenyRouter });
    const service = new SpaceService({ store: h.store, adapter: h.adapter, driver: h.driver, connect: h.deps });

    await service.handleInboundMessage(msg({ text: "connect fixture.weather as org" }));

    expect(h.driver.created).toHaveLength(0);
    expect(h.posts[0]!.text).toBe("policy: approval denied");
    expect(h.brokerCalls).toHaveLength(0);
    expect(h.rows).toHaveLength(0);
    const decisions = h.audit.filter((e) => e.event_type === POLICY_DECISION_EVENT);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload).toMatchObject({ tool: "connect_extension", decision: "ask-human" });
  });

  test("connect <ext> as org with an approving router connects the org account", async () => {
    const h = makeConnectHarness({ router: new RecordingRouter() });
    const service = new SpaceService({ store: h.store, adapter: h.adapter, driver: h.driver, connect: h.deps });

    await service.handleInboundMessage(msg({ text: "connect fixture.weather as org" }));

    expect(h.driver.created).toHaveLength(0);
    expect(h.posts[0]!.text).toBe("Fixture Weather connected as an organization");
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]!.scope).toBe("org");
    expect(h.rows[0]!.owner).toBeNull();
    const connected = h.audit.find((e) => e.event_type === EXTENSION_CONNECTED_EVENT);
    expect(connected!.payload).toMatchObject({ extension: "fixture.weather", scope: "org", owner: null });
  });

  test("unknown extensions post the failure without a session", async () => {
    const h = makeConnectHarness();
    const service = new SpaceService({ store: h.store, adapter: h.adapter, driver: h.driver, connect: h.deps });

    await service.handleInboundMessage(msg({ text: "connect nope.xyz as me" }));

    expect(h.driver.created).toHaveLength(0);
    expect(h.posts[0]!.text).toContain('unknown extension "nope.xyz"');
    expect(h.brokerCalls).toHaveLength(0);
  });

  test("non-matching messages stay agent territory (session gets the prompt)", async () => {
    const h = makeConnectHarness();
    const texts = [
      "connect fixture.weather please",
      "can you connect github as an org?",
      "connect fixture.weather as org now",
      "what weather do you know?",
    ];
    for (const text of texts) {
      const { adapter } = fakeAdapter();
      const { store } = fakeStore();
      const driver = new FakeDriver();
      const service = new SpaceService({ store, adapter, driver, connect: h.deps });
      await service.handleInboundMessage(msg({ text }));
      expect(driver.created).toHaveLength(1);
      expect(driver.last().prompts[0]!.text).toBe(text);
      await service.stop();
    }
  });

  test("without connect deps every message goes to the agent", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ text: "connect fixture.weather as me" }));

    expect(driver.created).toHaveLength(1);
    expect(driver.last().prompts[0]!.text).toBe("connect fixture.weather as me");
    await service.stop();
  });
});

describe("SpaceService onboarding nudge (issue #116)", () => {
  function failingChecks(names: string[]): WizardCheck[] {
    return names.map((name) => ({ name, ok: false, detail: "test", fix: "test" }));
  }

  /**
   * Flushes the phrase-post promise chain (post → pending-ts capture →
   * posting-clear) — the chain is several microtask hops long, so a single
   * `await Promise.resolve()` is not enough before the next turn event.
   */
  async function flush(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  }

  test("the churn guard appends one first_run_wizard pointer naming the missing checks", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({
      store,
      adapter,
      driver,
      onboardingChecks: () => failingChecks(["model_key", "slack_tokens"]),
    });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    for (let i = 0; i < EMPTY_TURN_LIMIT + 1; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await flush();
      session.emit("turn_end", { spaceId: "slack:C1" });
      await flush();
    }

    expect(posts).toHaveLength(1); // one phrase, replaced in place
    const churn = updates.at(-1)!.text;
    expect(churn).toContain(CHURN_MESSAGE);
    expect(churn).toContain("first_run_wizard");
    expect(churn).toContain("model_key");
    expect(churn).toContain("slack_tokens");
    const nudgeAudits = audit.filter((a) => a.event_type === ADMIN_ONBOARDING_NUDGE_EVENT);
    expect(nudgeAudits).toHaveLength(1);
    expect(nudgeAudits[0]!.space_id).toBe("slack:C1");
    const payload = JSON.parse(nudgeAudits[0]!.payload) as { checks: Array<{ name: string; ok: boolean }> };
    expect(payload.checks.map((c) => c.name).sort()).toEqual(["model_key", "slack_tokens"]);
  });

  test("a session error appends the pointer once, not per message (same missing set deduped)", async () => {
    const { adapter, updates } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({
      store,
      adapter,
      driver,
      onboardingChecks: () => failingChecks(["broker_token", "git_pat"]),
    });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    // Several failing turns with the same missing set → one nudge total.
    for (let i = 0; i < 4; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await flush();
      session.emit("error", { spaceId: "slack:C1", message: `boom ${i}` });
      await flush();
    }

    const nudged = updates.filter((u) => u.text.includes("first_run_wizard"));
    expect(nudged).toHaveLength(1);
    expect(nudged[0]!.text).toContain("broker_token");
    expect(nudged[0]!.text).toContain("git_pat");
    // 4 error updates total: the first carries the pointer, the rest are raw.
    expect(updates).toHaveLength(4);
    expect(audit.filter((a) => a.event_type === ADMIN_ONBOARDING_NUDGE_EVENT)).toHaveLength(1);
  });

  test("a changed failing set nudges again naming what remains (bounded until resolved)", async () => {
    const { adapter, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    let missing = ["broker_token", "git_pat"];
    const service = new SpaceService({
      store,
      adapter,
      driver,
      onboardingChecks: () => failingChecks(missing),
    });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.emit("turn_start", { spaceId: "slack:C1" });
    await flush();
    session.emit("error", { spaceId: "slack:C1", message: "boom 1" });
    await flush();
    expect(updates.at(-1)!.text).toContain("broker_token");

    // Fix broker_token: the remaining missing set is smaller → nudge again.
    missing = ["git_pat"];
    session.emit("turn_start", { spaceId: "slack:C1" });
    await flush();
    session.emit("error", { spaceId: "slack:C1", message: "boom 2" });
    await flush();
    expect(updates.at(-1)!.text).toContain("git_pat");
    expect(updates.at(-1)!.text).not.toContain("broker_token");

    // Fully resolved: no nudge, and the dedupe record clears (a later
    // regression would nudge fresh).
    missing = [];
    session.emit("turn_start", { spaceId: "slack:C1" });
    await flush();
    session.emit("error", { spaceId: "slack:C1", message: "boom 3" });
    await flush();
    expect(updates.at(-1)!.text).toBe("boom 3");
    const nudged = updates.filter((u) => u.text.includes("first_run_wizard"));
    expect(nudged).toHaveLength(2);
  });

  test("all-pass checks never nudge, even on repeated failures", async () => {
    const { adapter, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    for (let i = 0; i < 3; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await flush();
      session.emit("error", { spaceId: "slack:C1", message: "boom" });
      await flush();
    }
    expect(updates.filter((u) => u.text.includes("first_run_wizard"))).toHaveLength(0);
    expect(updates).toHaveLength(3);
    expect(updates.every((u) => u.text === "boom")).toBe(true);
  });

  test("a check failure suppresses the nudge, never the turn output (fail closed)", async () => {
    const { adapter, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = new SpaceService({
      store,
      adapter,
      driver,
      onboardingChecks: () => {
        throw new Error("malformed settings blob");
      },
    });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    driver.last().emit("turn_start", { spaceId: "slack:C1" });
    await flush();
    driver.last().emit("error", { spaceId: "slack:C1", message: "boom" });
    await flush();
    expect(updates.at(-1)!.text).toBe("boom");
  });
});
