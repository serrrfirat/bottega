import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent";
import type { MemoryEntry, MemoryForgetInput, MemoryProvider, MemorySaveInput } from "../../memory/types";
import { scopeKeyLabel } from "../../memory/types";
import { createAudit } from "../../policy/audit";
import { defaultPolicy } from "../../policy/config";
import { createStore, type Store } from "../../store/db";
import { MEMORY_AUTO_SAVED_EVENT } from "../../store/audit-events";
import type { AgentDriver, AgentSessionDriver, AgentTurnOptions } from "../drivers/agent-driver";
import type { SlackAdapter } from "../adapters/slack";
import { createLearningService, type LearningLogger, type LearningService } from "./learning";
import { SpaceService } from "./space-service";

/** Payloads FakeSession actually emits to listeners: turn framing or a message text. */
type SessionEventData = { spaceId: string } | { spaceId: string; text: string };

class FakeSession implements AgentSessionDriver {
  readonly listeners = new Map<string, Set<(data: SessionEventData) => void>>();
  readonly prompts: string[] = [];
  disposed = false;
  streaming = false;

  constructor(
    readonly spaceId: string,
    private readonly scriptedReply?: string,
    private readonly onOutput: (spaceId: string, text: string) => void = () => {},
  ) {}

  async prompt(text: string, _opts?: AgentTurnOptions): Promise<void> {
    this.prompts.push(text);
    this.emit("turn_start", { spaceId: this.spaceId });
    if (this.scriptedReply !== undefined) {
      this.onOutput(this.spaceId, this.scriptedReply);
      this.emit("message", { spaceId: this.spaceId, text: this.scriptedReply });
    }
    this.emit("turn_end", { spaceId: this.spaceId });
  }

  complete(reply: string): void {
    this.emit("turn_start", { spaceId: this.spaceId });
    this.emit("message", { spaceId: this.spaceId, text: reply });
    this.emit("turn_end", { spaceId: this.spaceId });
  }

  async abort(): Promise<void> {}
  isStreaming(): boolean { return this.streaming; }
  /** No todo plan (issue #228): the learning side-sessions have none. */
  getTodoPhases(): TodoPhase[] { return []; }
  on(event: "message" | "turn_start" | "turn_end" | "error", cb: (data: SessionEventData) => void): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(cb);
    return () => listeners?.delete(cb);
  }
  async dispose(): Promise<void> { this.disposed = true; }

  private emit(event: string, data: SessionEventData): void {
    for (const listener of this.listeners.get(event) ?? []) listener(data);
  }
}

class RecordingAdapter implements SlackAdapter {
  readonly visibleText: string[] = [];
  async postMessage(_spaceId: string, text: string): Promise<string | undefined> {
    this.visibleText.push(text);
    return "thinking-ts";
  }
  async updateMessage(_spaceId: string, _ts: string, text: string): Promise<void> {
    this.visibleText.push(text);
  }
  async addReaction(): Promise<void> {}
  async removeReaction(): Promise<void> {}
  async downloadFile(): Promise<{ name: string; mimeType: string; size: number; bytes: Uint8Array }> {
    return { name: "file.bin", mimeType: "application/octet-stream", size: 0, bytes: new Uint8Array() };
  }
  async uploadFile(): Promise<string | undefined> {
    return undefined;
  }
  async startStream(): Promise<string | undefined> {
    throw new Error("not used");
  }
  async appendText(): Promise<void> {}
  async appendTask(): Promise<void> {}
  async stopStream(): Promise<void> {}
  streamingSupported(): boolean {
    return false;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

interface CreatedSideSession {
  session: FakeSession;
  allowTools: readonly string[] | undefined;
}

class ScriptedDriver implements AgentDriver {
  readonly created: CreatedSideSession[] = [];

  constructor(private readonly replies: string[]) {}

  async createSession(opts: Parameters<AgentDriver["createSession"]>[0]): Promise<AgentSessionDriver> {
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error("no scripted extraction reply");
    const session = new FakeSession(opts.spaceId, reply, opts.onOutput);
    this.created.push({ session, allowTools: opts.allowTools });
    return session;
  }
}

class RecordingMemory implements MemoryProvider {
  readonly capabilities = {
    consolidation: "unsupported",
    digestPruning: "unsupported",
    forget: "unsupported",
  } as const;

  async pruneDigests(): Promise<number> {
    throw new Error("learning must not prune memory");
  }
  async forget(_input: MemoryForgetInput): Promise<never> {
    throw new Error("fake memory provider does not support forget");
  }
  readonly saved: MemorySaveInput[] = [];

  constructor(private readonly reject?: (input: MemorySaveInput) => boolean) {}

  async save(input: MemorySaveInput): Promise<MemoryEntry> {
    if (this.reject?.(input)) throw new Error("provider rejected secret");
    this.saved.push(input);
    return {
      id: `m-${this.saved.length}`,
      key: input.scope,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: Date.now(),
      provenance: { source: "tool", spaceId: null, principal: null, scopeLabel: scopeKeyLabel(input.scope) },
    };
  }

  async search(): Promise<MemoryEntry[]> { return []; }
}

class RecordingLogger implements LearningLogger {
  readonly errors: Array<{ message: string; error?: unknown }> = [];
  error(message: string, cause?: unknown): void { this.errors.push({ message, error: cause }); }
}

interface Harness {
  dir: string;
  store: Store;
  driver: ScriptedDriver;
  memory: RecordingMemory;
  logger: RecordingLogger;
  learning: LearningService;
  cleanup(): void;
}

function makeHarness(options: {
  replies?: string[];
  autoExtract?: boolean;
  reject?: (input: MemorySaveInput) => boolean;
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bottega-learning-"));
  const store = createStore(join(dir, "learning.db"));
  const driver = new ScriptedDriver(options.replies ?? []);
  const memory = new RecordingMemory(options.reject);
  const logger = new RecordingLogger();
  const learning = createLearningService({
    driver,
    memory,
    audit: createAudit(store),
    autoExtract: options.autoExtract,
    maxTurns: 1,
    transcriptDir: join(dir, "side-sessions"),
    logger,
  });
  return {
    dir,
    store,
    driver,
    memory,
    logger,
    learning,
    cleanup() {
      learning.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function observeTurn(learning: LearningService, spaceId: string, principal: string, input: string, reply: string): FakeSession {
  const session = new FakeSession(spaceId);
  learning.attachSession(spaceId, session);
  learning.recordInput({ spaceId, principal, text: input, ts: "1.1" });
  session.complete(reply);
  return session;
}

describe("learning service", () => {
  test("routes channel facts to org scope, DM facts to user scope, and audits each batch", async () => {
    const h = makeHarness({
      replies: ["- The Atlas team prefers small pull requests.", "- Ada prefers concise status updates."],
    });
    try {
      const channel = observeTurn(h.learning, "slack:C123", "U-CHANNEL", "We prefer small pull requests on Atlas.", "Understood.");
      expect([...channel.listeners.keys()]).toEqual(["message", "turn_end"]);
      await h.learning.drain();
      observeTurn(h.learning, "slack:D456", "U-ADA", "I prefer concise status updates.", "I will keep them short.");
      await h.learning.drain();

      expect(h.logger.errors).toEqual([]);
      expect(h.driver.created).toHaveLength(2);
      expect(h.memory.saved).toEqual([
        {
          scope: { kind: "channel", spaceId: "slack:C123" },
          content: "The Atlas team prefers small pull requests.",
          metadata: { source: "auto_extract" },
        },
        {
          scope: { kind: "person", principal: "U-ADA" },
          content: "Ada prefers concise status updates.",
          metadata: { source: "auto_extract" },
        },
      ]);
      expect(h.driver.created).toHaveLength(2);
      expect(h.driver.created.every(({ allowTools }) => allowTools?.length === 0)).toBe(true);
      expect(h.driver.created.every(({ session }) => session.disposed)).toBe(true);
      expect(h.driver.created[0].session.prompts[0]).toContain('HUMAN MESSAGE:\n"We prefer small pull requests on Atlas."');

      const rows = await h.store.listAudit({ event_type: MEMORY_AUTO_SAVED_EVENT });
      expect(rows.map((row) => ({ actor: row.actor, space: row.space_id, payload: JSON.parse(row.payload) }))).toEqual([
        { actor: "system", space: "slack:C123", payload: { scope: "channel", count: 1 } },
        { actor: "system", space: "slack:D456", payload: { scope: "person", count: 1 } },
      ]);
    } finally {
      h.cleanup();
    }
  });

  test("SpaceService forwards completed human turns to learning", async () => {
    const h = makeHarness({
      replies: ["Understood.", "- The Atlas team prefers small pull requests."],
    });
    const adapter = new RecordingAdapter();
    const spaces = new SpaceService({
      store: h.store,
      adapter,
      audit: createAudit(h.store),
      orgPolicy: defaultPolicy(),
      driver: h.driver,
      learning: h.learning,
      onboardingChecks: () => [],
    });
    try {
      await spaces.handleInboundMessage({
        spaceId: "slack:C123",
        principal: "U1",
        text: "We prefer small pull requests on Atlas.",
        ts: "1.1",
      });
      await h.learning.drain();

      expect(h.memory.saved.map((input) => input.content)).toEqual([
        "The Atlas team prefers small pull requests.",
      ]);
      expect(adapter.visibleText).not.toContain("- The Atlas team prefers small pull requests.");
    } finally {
      await spaces.stop();
      h.cleanup();
    }
  });

  test("org knob off attaches no listener and performs no model call or save", async () => {
    const h = makeHarness({ autoExtract: false, replies: ["- This must not save."] });
    try {
      observeTurn(h.learning, "slack:C123", "U1", "Remember this.", "Okay.");
      await h.learning.drain();

      expect(h.driver.created).toEqual([]);
      expect(h.memory.saved).toEqual([]);
      expect(await h.store.listAudit({ event_type: MEMORY_AUTO_SAVED_EVENT })).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("provider save rejection is logged and swallowed while later facts still save", async () => {
    const h = makeHarness({
      replies: ["- Ada's Vault record must stay private.\n- Ada prefers paired reviews."],
      reject: (input) => input.content.includes("Vault record"),
    });
    try {
      observeTurn(h.learning, "slack:D456", "U-ADA", "My Vault record must stay private; I prefer paired reviews.", "Noted.");
      await expect(h.learning.drain()).resolves.toBeUndefined();

      expect(h.memory.saved.map((input) => input.content)).toEqual(["Ada prefers paired reviews."]);
      expect(h.logger.errors).toHaveLength(1);
      expect(h.logger.errors[0].message).toContain("memory save rejected");
      const rows = await h.store.listAudit({ event_type: MEMORY_AUTO_SAVED_EVENT });
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].payload)).toEqual({ scope: "person", count: 1 });
    } finally {
      h.cleanup();
    }
  });

  test("ignores executor and headless sessions", async () => {
    const h = makeHarness({ replies: ["- This must not save."] });
    try {
      observeTurn(h.learning, "work-item:42", "executor", "internal task", "done");
      await h.learning.drain();
      expect(h.driver.created).toEqual([]);
      expect(h.memory.saved).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});
