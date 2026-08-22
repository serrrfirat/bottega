import { afterAll, describe, expect, test, vi } from "bun:test";
import { z } from "zod";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, Skill, TodoPhase } from "@oh-my-pi/pi-coding-agent";
import { createStore, type Store } from "../../store/db";
import type { MemoryProvider, MemoryProviderCapabilities, MemorySaveInput, MemorySearchQuery } from "../../memory/types";
import { sessionFilePath, SessionModelRoleRegistry, FORBIDDEN_SPACE_HOST_TOOLS, spaceAgentToolNames, type AgentDriver, type AgentSessionDriver, type AgentTurnOptions } from "../drivers/agent-driver";
import { SpaceService, type SpaceServiceDeps, DIGEST_CAP, REQUEST_ONLY_DIRECTIVE, SLACK_FORMAT_DIRECTIVE, EMPTY_TURN_LIMIT, EMPTY_RESPONSE_FALLBACK, CHURN_MESSAGE, STREAM_UPDATE_INTERVAL_MS, THINKING_PHRASES, emptyResponseFallback, churnMessageText, CorrectionClassifier, classifyCorrection, type MessageClass } from "./space-service";
import { SlackTurnPresenter, StreamTurnPresenter } from "./slack-turn-presenter";
import type { ResponseMode } from "../../policy/config";
import { defaultPolicy, parseOrgConfigYaml } from "../../policy/config";
import type { SlackAction, SlackAdapter, SlackMessage } from "../adapters/slack";
import { STOP_ACTION_ID } from "../adapters/slack";
import { createAudit } from "../../policy/audit";
import { EXTENSION_CONNECTED_EVENT, ADMIN_ONBOARDING_NUDGE_EVENT, MESSAGE_RECEIVED_EVENT, MESSAGE_REPLIED_EVENT, DIGEST_FAILED_EVENT, OBJECT_ATTACHED_EVENT, TURN_STOP_EVENT } from "../../store/audit-events";
import type { WizardCheck } from "../../tools/admin";
import { buildAutoPickupDirective } from "../../tools/work-item-pickup";
import { objectToolDefinitions } from "../../tools/objects";
import { sha256Hex } from "../../tools/helpers";

// ---------------------------------------------------------------------------
// Fakes: no real model, no network. The driver seam is what keeps these tests
// hermetic — SpaceService sees only AgentSessionDriver, never OMP.
// ---------------------------------------------------------------------------

/** Event payloads the fake session emits: message text, turn bounds, errors. */
type FakeSessionEventData =
  | { spaceId: string; text: string }
  | { spaceId: string }
  | { spaceId: string; message: string }
  | { spaceId: string; error: string }
  | { spaceId: string; phases: TodoPhase[] };

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
  /**
   * When set, prompt() first emits a session `error` event (buffered by the
   * DM presenter, issue #296) then throws — models a REAL driver rejection,
   * which is always preceded by an onError/empty-completion surface. Tests
   * that the service STILL settles the pending DM request on prompt reject.
   */
  failPromptError?: string;
  /** When set, prompt() emits a message event with this text (the model's reply). */
  autoReply?: string;
  /** The principal of the current turn; mirrors the real drivers' binding (issue #152). */
  turnPrincipal: string | undefined;
  /** reapplyDefaultModelRole invocations (issue #189): the service must call the seam before each fresh turn. */
  reapplyCalls = 0;
  /** The session's live todo plan (issue #228); tests script it for the pull seam. */
  todoPhases: TodoPhase[] = [];
  /** Number of abort() calls (issue #315): Stop must abort an in-flight turn EXACTLY once. */
  abortCalls = 0;
  /**
   * When true, abort() force-settles the in-flight run the way the SDK's
   * abort settles a ghost run (issue #183): it clears the streaming state
   * and resolves the parked prompt gate so the caller's `prompt` promise
   * settles as STOPPED, and emits `turn_end` so the presenter finalizes.
   */
  forceSettleOnAbort = false;

  private readonly listeners = new Map<string, Set<(data: FakeSessionEventData) => void>>();
  private disposeGate?: { promise: Promise<void>; resolve: () => void };
  private promptGate?: { promise: Promise<void>; resolve: () => void };

  constructor(spaceId = "slack:C1") {
    this.spaceId = spaceId;
  }

  /** Turn-start model hot-swap seam (issue #189): recorded, resolves immediately. */
  async reapplyDefaultModelRole(): Promise<void> {
    this.reapplyCalls += 1;
  }

  async prompt(text: string, opts?: AgentTurnOptions): Promise<void> {
    if (this.failPrompt) throw new Error("fake prompt failure");
    if (this.failPromptError !== undefined) {
      // Model the real driver: a rejection is surfaced (onError buffers it)
      // BEFORE the prompt rejects — the service must still settle the DM.
      this.emit("error", { spaceId: this.spaceId, message: this.failPromptError });
      throw new Error("fake prompt failure after error");
    }
    this.prompts.push({ text, opts });
    // Mirrors the drivers: a FRESH turn (not streaming) binds the inbound
    // principal; a steer into the running turn keeps the turn's principal.
    if (!this.streaming) this.turnPrincipal = opts?.principal;
    if (this.deferPrompt) {
      const gate = Promise.withResolvers<void>();
      this.promptGate = gate;
      await gate.promise;
    }
    if (this.autoReply !== undefined) {
      this.emit("message", { spaceId: this.spaceId, text: this.autoReply });
    }
  }

  /** The principal bound to the current turn (issue #152). */
  getTurnPrincipal(): string | undefined {
    return this.turnPrincipal;
  }

  finishPrompt(): void {
    this.promptGate?.resolve();
    this.promptGate = undefined;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    // Mirror the SDK's abort: force-settle the in-flight run — clear the
    // streaming state, resolve a parked opening prompt (the caller's
    // prompt() settles as STOPPED), and emit turn_end so the presenter
    // finalizes the turn exactly as a natural end would. Only when the
    // test opted into the force-settle (the abort seam test drives it).
    if (this.forceSettleOnAbort) {
      this.streaming = false;
      this.finishPrompt();
      this.emit("turn_end", { spaceId: this.spaceId });
    }
  }

  isStreaming(): boolean {
    return this.streaming;
  }

  on(
    event: "message" | "turn_start" | "turn_end" | "error" | "thinking" | "todo_phases",
    cb: (data: FakeSessionEventData) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  emit(
    event: "message" | "turn_start" | "turn_end" | "error" | "thinking" | "todo_phases",
    data: FakeSessionEventData,
  ): void {
    // The turn's principal binding dies with the turn (issue #152) — the
    // next fresh turn rebinds from its own prompt's principal.
    if (event === "turn_end") this.turnPrincipal = undefined;
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }

  /** The session's live todo plan (issue #228); the fake starts plan-less. */
  getTodoPhases(): TodoPhase[] {
    return this.todoPhases;
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
  /** The session tool allowlist the service requests (space-agent default) — captured for #338 boundary assertions. */
  allowTools?: readonly string[];
  /** Space-authored skills injected at cold start (issues #234/#235). */
  skills?: readonly Skill[];
}

class FakeDriver implements AgentDriver {
  readonly created: Array<{ opts: CreateSessionOpts; session: FakeSession }> = [];
  /** When set, createSession parks until finishCreate() — proves receipt ordering (issue #119). */
  deferCreate = false;
  /** Set while createSession is parked on the defer gate (issue #119). */
  createGate?: { promise: Promise<void>; resolve: () => void };

  async createSession(opts: CreateSessionOpts): Promise<AgentSessionDriver> {
    const session = new FakeSession(opts.spaceId);
    this.created.push({ opts, session });
    if (this.deferCreate) {
      const gate = Promise.withResolvers<void>();
      this.createGate = gate;
      await gate.promise;
    }
    return session;
  }

  finishCreate(): void {
    this.createGate?.resolve();
    this.createGate = undefined;
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
  readonly prunes: Array<{ spaceId: string; keep: number }> = [];
  saved: MemorySaveInput[] = [];
  /** Digest entries (newest last): {space, since, until}. */
  digests: Array<{ space: string; since: string; until: string }> = [];

  constructor(
    readonly capabilities: MemoryProviderCapabilities = {
      consolidation: "explicit",
      digestPruning: "explicit",
    },
  ) {}

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
      key: input.scope,
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
              key: { kind: "org" } as const,
              content: "digest",
              metadata: { kind: "digest", space: newest.space, since: newest.since, until: newest.until },
              createdAt: 1000,
            },
          ]
        : [];
    }
    return [];
  }

  async pruneDigests(spaceId: string, keep: number): Promise<number> {
    this.prunes.push({ spaceId, keep });
    return 0;
  }
}

interface FakeDownloadedFile {
  name: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}

interface FakeStreamCall {
  spaceId: string;
  opts: { threadTs: string; openingText: string; recipientUserId?: string };
}

function fakeAdapter(
  opts: {
    deferPost?: boolean;
    failUpdateCalls?: number;
    failReactions?: boolean;
    downloads?: Record<string, FakeDownloadedFile | Error>;
    streaming?: boolean;
  } = {},
) {
  const { deferPost = false, failUpdateCalls = 0, failReactions = false, downloads = {}, streaming = false } = opts;
  const posts: Array<{ spaceId: string; text?: string; opts?: { threadTs?: string; blocks?: unknown[] } }> = [];
  const updates: Array<{ spaceId: string; ts: string; text?: string; opts?: { blocks?: unknown[] } }> = [];
  const reactions: Array<{ kind: "add" | "remove"; spaceId: string; ts: string }> = [];
  const streams: FakeStreamCall[] = [];
  const stops: Array<{ spaceId: string; ts: string; text?: string }> = [];
  const downloadedFileIds: string[] = [];
  const uploads: Array<{ spaceId: string; name: string; mimeType: string; content: Uint8Array }> = [];
  let releasePost = () => {};
  /** updateMessage calls still to reject (issue #120 429 simulation); fail-soft means the service must cope. */
  let failuresLeft = failUpdateCalls;
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
    async updateMessage(spaceId, ts, text, updateOpts) {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        // Slack chat.update 429 shape: rate_limited with retry_after.
        throw new Error("rate_limited");
      }
      const blocks = updateOpts?.blocks;
      updates.push(blocks !== undefined ? { spaceId, ts, text, opts: { blocks } } : { spaceId, ts, text });
    },
    async downloadFile(fileId) {
      downloadedFileIds.push(fileId);
      const file = downloads[fileId];
      if (!file) throw new Error(`missing fake download: ${fileId}`);
      if (file instanceof Error) throw file;
      return file;
    },
    async uploadFile(spaceId, name, mimeType, content) {
      uploads.push({ spaceId, name, mimeType, content });
      return `upload-${uploads.length}`;
    },
    async addReaction(spaceId, ts) {
      if (failReactions) throw new Error("missing_scope: reactions:write");
      reactions.push({ kind: "add", spaceId, ts });
    },
    async removeReaction(spaceId, ts) {
      reactions.push({ kind: "remove", spaceId, ts });
    },
    async startStream(spaceId, streamOpts) {
      streams.push({ spaceId, opts: streamOpts });
      return `stream-${streams.length}`;
    },
    async appendText() {},
    async appendTask() {},
    async stopStream(spaceId, ts, text) {
      stops.push({ spaceId, ts, text });
    },
    streamingSupported: () => streaming,
    async start() {},
    async stop() {},
  };
  return {
    adapter,
    posts,
    updates,
    reactions,
    streams,
    stops,
    downloadedFileIds,
    uploads,
    releasePost: () => releasePost(),
  };
}

function fakeStore() {
  const audit: Array<{ space_id: string | null; actor: string; event_type: string; payload: string }> = [];
  // SAFETY: the harness only exercises appendAudit/getOrgSettings; the
  // remaining Store surface is never called through this stub.
  const store = {
    appendAudit: async (entry: { space_id: string | null; actor: string; event_type: string; payload: string }) => {
      audit.push(entry);
      return audit.length;
    },
    // runWizardChecks (the default onboarding-checks seam, issue #116) reads
    // org settings; no settings blob is the normal unset state.
    getOrgSettings: () => null,
  } as Store;

  return { store, audit };
}

function msg(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return { spaceId: "slack:C1", principal: "U1", text: "hello", ts: "1.1", ...overrides };
}

function makeSpaceService(
  deps: Omit<SpaceServiceDeps, "audit" | "orgPolicy"> &
    Partial<Pick<SpaceServiceDeps, "audit" | "orgPolicy">>,
): SpaceService {
  return new SpaceService({
    audit: createAudit(deps.store),
    orgPolicy: defaultPolicy(),
    ...deps,
  });
}

const objectTestDir = mkdtempSync(join(tmpdir(), "bottega-space-objects-"));
const objectTestStores: Store[] = [];

function freshObjectStore(): Store {
  const store = createStore(join(objectTestDir, `store-${objectTestStores.length}.db`));
  objectTestStores.push(store);
  return store;
}

afterAll(() => {
  for (const store of objectTestStores) store.close();
  rmSync(objectTestDir, { recursive: true, force: true });
});

function objectToolContext(spaceId: string): ExtensionContext {
  // SAFETY: the object tools read only sessionManager.getSessionFile() from
  // the context; the rest of ExtensionContext is unused by their executes.
  return {
    sessionManager: { getSessionFile: () => join("/tmp/sessions", `${spaceId}.jsonl`) },
  } as ExtensionContext;
}

describe("SpaceService durable object ingest (issue #124)", () => {
  test("stores inbound files, audits them, and puts the object id in the agent turn", async () => {
    const store = freshObjectStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    const bytes = new TextEncoder().encode("name,value\nalpha,1");
    const { adapter, downloadedFileIds } = fakeAdapter({
      downloads: {
        F1: { name: "report.csv", mimeType: "text/csv", size: bytes.byteLength, bytes },
      },
    });
    const driver = new FakeDriver();
    const orgPolicy = defaultPolicy();
    const service = makeSpaceService({
      store,
      adapter,
      driver,
      audit: createAudit(store),
      orgPolicy,
      onboardingChecks: () => [],
    });

    await service.handleInboundMessage(
      msg({
        spaceId: space.id,
        files: [{ id: "F1", name: "report.csv", mimeType: "text/csv", size: bytes.byteLength }],
      }),
    );

    expect(downloadedFileIds).toEqual(["F1"]);
    const objects = await store.listObjects(space.id);
    expect(objects).toHaveLength(1);
    const object = objects[0]!;
    expect(object.name).toBe("report.csv");
    expect(object.mime).toBe("text/csv");
    expect(object.sha256).toBe(sha256Hex("name,value\nalpha,1"));
    const storedBytes = await store.readObjectBytes(object.id);
    if (!storedBytes) throw new Error("attached object bytes are missing");
    expect(new TextDecoder().decode(storedBytes)).toBe("name,value\nalpha,1");
    expect(driver.last().prompts[0]!.text).toBe(
      `hello\n[attachment: report.csv (text/csv, ${bytes.byteLength} B) — object ${object.id}]`,
    );

    const auditRows = await store.listAudit({ space: space.id, event_type: OBJECT_ATTACHED_EVENT });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.actor).toBe("U1");
    expect(JSON.parse(auditRows[0]!.payload)).toEqual({
      id: object.id,
      name: object.name,
      mime: object.mime,
      size: object.size,
      sha256: object.sha256,
      by: "U1",
    });
    await service.stop();
  });

  test("skips oversized files with the configured limit in the turn and no object row", async () => {
    const store = freshObjectStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C2" });
    const { adapter, downloadedFileIds } = fakeAdapter();
    const driver = new FakeDriver();
    const orgPolicy = defaultPolicy();
    orgPolicy.objects.maxSizeBytes = 3;
    const service = makeSpaceService({
      store,
      adapter,
      driver,
      audit: createAudit(store),
      orgPolicy,
      onboardingChecks: () => [],
    });

    await service.handleInboundMessage(
      msg({
        spaceId: space.id,
        text: "",
        files: [{ id: "F2", name: "large.pdf", mimeType: "application/pdf", size: 4 }],
      }),
    );

    expect(downloadedFileIds).toEqual([]);
    expect(await store.listObjects(space.id)).toEqual([]);
    expect(driver.last().prompts[0]!.text).toBe("[attachment skipped: large.pdf exceeds 3B limit]");
    await service.stop();
  });

  test("reports a download failure in the turn and still prompts the agent", async () => {
    const store = freshObjectStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C3" });
    const { adapter } = fakeAdapter({ downloads: { F3: new Error("Slack download unavailable") } });
    const driver = new FakeDriver();
    const orgPolicy = defaultPolicy();
    const service = makeSpaceService({
      store,
      adapter,
      driver,
      audit: createAudit(store),
      orgPolicy,
      onboardingChecks: () => [],
    });

    await service.handleInboundMessage(
      msg({
        spaceId: space.id,
        text: "summarize this",
        files: [{ id: "F3", name: "broken.csv", mimeType: "text/csv", size: 12 }],
      }),
    );

    expect(await store.listObjects(space.id)).toEqual([]);
    expect(driver.last().prompts[0]!.text).toBe(
      "summarize this\n[attachment failed: broken.csv: Slack download unavailable]",
    );
    await service.stop();
  });

  test("ingested CSV is readable through object.get while PDF returns an explicit format error", async () => {
    const store = freshObjectStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C4" });
    const csvBytes = new TextEncoder().encode("a,b\n1,2");
    const pdfBytes = new TextEncoder().encode("%PDF");
    const { adapter } = fakeAdapter({
      downloads: {
        F4: { name: "data.csv", mimeType: "text/csv", size: csvBytes.byteLength, bytes: csvBytes },
        F5: { name: "paper.pdf", mimeType: "application/pdf", size: pdfBytes.byteLength, bytes: pdfBytes },
      },
    });
    const driver = new FakeDriver();
    const orgPolicy = defaultPolicy();
    const audit = createAudit(store);
    const service = makeSpaceService({
      store,
      adapter,
      driver,
      audit,
      orgPolicy,
      onboardingChecks: () => [],
    });

    await service.handleInboundMessage(
      msg({
        spaceId: space.id,
        files: [
          { id: "F4", name: "data.csv", mimeType: "text/csv", size: csvBytes.byteLength },
          { id: "F5", name: "paper.pdf", mimeType: "application/pdf", size: pdfBytes.byteLength },
        ],
      }),
    );

    const objects = await store.listObjects(space.id);
    const csv = objects.find((object) => object.mime === "text/csv")!;
    const pdf = objects.find((object) => object.mime === "application/pdf")!;
    const get = objectToolDefinitions(store, { orgPolicy, audit, adapter }).find(
      (tool) => tool.name === "object.get",
    )!;
    const context = objectToolContext(space.id);

    const csvResult = await get.execute("tc1", { id: csv.id }, undefined, undefined, context);
    const csvText = csvResult.content.find((content) => content.type === "text");
    if (!csvText || csvText.type !== "text") throw new Error("object.get did not return text");
    expect(JSON.parse(csvText.text).content).toBe("a,b\n1,2");

    const pdfResult = await get.execute("tc2", { id: pdf.id }, undefined, undefined, context);
    const pdfText = pdfResult.content.find((content) => content.type === "text");
    if (!pdfText || pdfText.type !== "text") throw new Error("object.get did not return text");
    expect(pdfResult.isError).toBe(true);
    expect(pdfText.text).toBe(
      `object ${pdf.id}: cannot extract text from application/pdf (unsupported format)`,
    );
    await service.stop();
  });
});

describe("SpaceService space persistence (issue #188)", () => {
  const persistDir = mkdtempSync(join(tmpdir(), "bottega-space-persist-"));
  const persistStores: Store[] = [];

  function freshPersistStore(): Store {
    const s = createStore(join(persistDir, `store-${persistStores.length}.db`));
    persistStores.push(s);
    return s;
  }

  afterAll(() => {
    for (const s of persistStores) s.close();
    rmSync(persistDir, { recursive: true, force: true });
  });

  test("the first inbound message persists the space row, so per-space settings resolve", async () => {
    const store = freshPersistStore();
    const service = makeSpaceService({ store, adapter: fakeAdapter().adapter, driver: new FakeDriver() });
    try {
      await service.handleInboundMessage({ spaceId: "slack:C188", principal: "U1", text: "hi", ts: "1.0" });

      const space = await store.getSpace("slack:C188");
      expect(space).not.toBeNull();
      expect(space?.platform).toBe("slack");
      expect(space?.channel_id).toBe("C188");
      expect(space?.policy_json).toBe("{}");
      expect(space?.settings).toBe("{}");

      // The row the bug was missing: model_settings / overlays now resolve
      // it instead of failing with "space not found".
      await store.updateSpaceSettings("slack:C188", { model: "deepseek-v4-flash" });
      expect(await store.getSpaceSettings("slack:C188")).toEqual({ model: "deepseek-v4-flash" });
    } finally {
      await service.stop();
      store.close();
    }
  });

  test("a later message never clobbers per-space settings", async () => {
    const store = freshPersistStore();
    const service = makeSpaceService({ store, adapter: fakeAdapter().adapter, driver: new FakeDriver() });
    try {
      await service.handleInboundMessage({ spaceId: "slack:C188b", principal: "U1", text: "first", ts: "1.0" });
      await store.updateSpaceSettings("slack:C188b", { model: "deepseek-v4-flash", reasoning_effort: "high" });

      await service.handleInboundMessage({ spaceId: "slack:C188b", principal: "U1", text: "second", ts: "2.0" });

      expect(await store.getSpaceSettings("slack:C188b")).toEqual({
        model: "deepseek-v4-flash",
        reasoning_effort: "high",
      });
      const space = await store.getSpace("slack:C188b");
      expect(space?.policy_json).toBe("{}");
      expect(space?.updated_at).toBeGreaterThanOrEqual(space?.created_at ?? 0);
    } finally {
      await service.stop();
      store.close();
    }
  });
});

describe("SpaceService session lifecycle", () => {
  test("sessions are lazy: the first message cold-starts a session that gets the prompt", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    expect(driver.created).toHaveLength(0); // no session until a message arrives

    await service.handleInboundMessage(msg({ text: "hello", ts: "1.1" }));

    expect(driver.created).toHaveLength(1);
    expect(driver.created[0].opts.spaceId).toBe("slack:C1");
    expect(driver.last().prompts).toEqual([{ text: "hello", opts: { principal: "U1" } }]);
  });

  test("a space's authored skills are injected at cold start (issues #234/#235)", async () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), "bottega-space-skills-inject-"));
    const prev = process.env.BOTTEGA_SKILLS_DIR;
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    try {
      process.env.BOTTEGA_SKILLS_DIR = skillsRoot;
      mkdirSync(join(skillsRoot, "slack:C1", "memo"), { recursive: true });
      writeFileSync(
        join(skillsRoot, "slack:C1", "memo", "SKILL.md"),
        "---\nname: memo\ndescription: Note the reminder.\n---\nRecord it.\n",
      );
      const service = makeSpaceService({ store, adapter, driver });

      await service.handleInboundMessage(msg({ text: "remind me", ts: "1.1" }));

      const opts = driver.created[0].opts;
      expect(opts.skills?.map((s) => s.name)).toContain("memo");
      const memo = opts.skills!.find((s) => s.name === "memo")!;
      expect(memo.source).toBe("space:slack:C1");
      expect(memo.baseDir).toBe(join(skillsRoot, "slack:C1", "memo"));
    } finally {
      if (prev === undefined) delete process.env.BOTTEGA_SKILLS_DIR;
      else process.env.BOTTEGA_SKILLS_DIR = prev;
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });

  test("a fresh turn re-applies the default model role before prompting; a steer does not (issue #189)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    // Fresh turn: the service hot-swaps the default model (the driver's
    // reapplyDefaultModelRole seam) BEFORE opening the prompt.
    await service.handleInboundMessage(msg({ text: "first", ts: "1.1" }));
    const session = driver.last();
    expect(session.reapplyCalls).toBe(1);
    expect(session.prompts).toEqual([{ text: "first", opts: { principal: "U1" } }]);

    // A correction message into a streaming turn is a STEER — the seam
    // must NOT run again mid-turn (a use_model switch made during the turn
    // would be clobbered by a re-apply before it ever ran).
    session.streaming = true;
    await service.handleInboundMessage(msg({ text: "wait, use the other model", ts: "2.1" }));
    expect(session.reapplyCalls).toBe(1);
    expect(session.prompts[1]!.opts?.streamingBehavior).toBe("steer");
  });

  test("live sessions register in the model-role registry and unregister on dispose (issue #64)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    vi.useFakeTimers();
    try {
      const modelRoles = new SessionModelRoleRegistry();
      const service = makeSpaceService({ store, adapter, driver, modelRoles, idleTimeoutMs: 20 });

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
    const service = makeSpaceService({ store, adapter, driver });

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
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ text: "first" }));
    driver.last().streaming = true;
    await service.handleInboundMessage(msg({ text: "wait, use the other file", ts: "2.2" }));

    const session = driver.last();
    expect(driver.created).toHaveLength(1); // same session reused
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toEqual({
      text: "wait, use the other file",
      opts: { streamingBehavior: "steer", principal: "U1" },
    });
  });

  test("idle timeout disposes the session; the next message cold-starts a fresh one", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    vi.useFakeTimers();
    try {
      const service = makeSpaceService({ store, adapter, driver, idleTimeoutMs: 20 });

      await service.handleInboundMessage(msg({ text: "first" }));
      const first = driver.last();

      vi.advanceTimersByTime(20); // idle timer fires; dispose runs
      for (let i = 0; i < 5; i++) await Promise.resolve(); // flush the dispose promise chain
      expect(first.disposed).toBe(true);

      await service.handleInboundMessage(msg({ text: "second", ts: "2.2" }));

      expect(driver.created).toHaveLength(2);
      expect(driver.last()).not.toBe(first);
      expect(driver.last().prompts).toEqual([{ text: "second", opts: { principal: "U1" } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Issue #281: after a successful connect, the connected space's session
  // toolset must refresh WITHOUT a restart. The SDK mounts a session's tools
  // once, so the refresh disposes the stale long-lived session and the next
  // inbound message cold-starts it from the SAME transcript file with the
  // refreshed extension surfaces (exactly what a server restart does, minus
  // the restart). No-op when there is no live session for the space.
  test("refreshExtensionTools disposes the stale session so the next turn cold-starts with refreshed tools", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ text: "first" }));
    const first = driver.last();
    expect(driver.created).toHaveLength(1);

    // A connect for this space completes → refresh the toolset without a
    // restart: the stale session is disposed.
    await service.refreshExtensionTools("slack:C1", "notion");

    for (let i = 0; i < 5; i++) await Promise.resolve(); // flush the dispose promise chain
    expect(first.disposed).toBe(true);

    // The next turn cold-starts a FRESH session (new toolset) that resumes
    // the space's transcript.
    await service.handleInboundMessage(msg({ text: "second", ts: "2.2" }));
    expect(driver.created).toHaveLength(2);
    expect(driver.last()).not.toBe(first);
    expect(driver.last().spaceId).toBe("slack:C1");
    expect(driver.last().prompts).toEqual([{ text: "second", opts: { principal: "U1" } }]);
  });

  test("refreshExtensionTools no-ops when the space has no live session", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.refreshExtensionTools("slack:C1", "notion");
    expect(driver.created).toHaveLength(0); // nothing created/disposed
  });

  test("sessions are file-backed under the transcript dir, one file per space", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, transcriptDir: "data/sessions" });

    await service.handleInboundMessage(msg());

    expect(driver.created[0].opts.transcriptDir).toBe("data/sessions");
    expect(sessionFilePath("data/sessions", "slack:C1")).toBe("data/sessions/slack:C1.jsonl");
  });

  test("a message queued mid-dispose is dropped and audited; cold start works after dispose settles", async () => {
    const { adapter, posts, reactions } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    vi.useFakeTimers();
    try {
      const service = makeSpaceService({ store, adapter, driver, idleTimeoutMs: 20 });

      await service.handleInboundMessage(msg({ ts: "1.1" }));
      driver.last().deferDispose = true;

      vi.advanceTimersByTime(20); // idle timer fires; dispose starts and parks on the gate
      for (let i = 0; i < 5; i++) await Promise.resolve(); // flush the async dispose start (digest awaits before session.dispose)
      expect(driver.last().disposed).toBe(true);

      await service.handleInboundMessage(msg({ text: "during", ts: "2.2" }));

      expect(driver.last().prompts).toHaveLength(1); // dropped, never prompted
      expect(driver.created).toHaveLength(1); // no cold start while disposing
      // The dropped message gets no phrase and no reaction (issue #119: a
      // receipt claim must not outlive a message that is discarded); the
      // first message's receipt activity stands alone.
      expect(posts).toHaveLength(1);
      expect(reactions).toEqual([{ kind: "add", spaceId: "slack:C1", ts: "1.1" }]);
      expect(audit).toEqual([
        {
          space_id: "slack:C1",
          actor: "U1",
          event_type: MESSAGE_RECEIVED_EVENT,
          payload: JSON.stringify({ ts: "1.1" }),
        },
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
      expect(driver.last().prompts).toEqual([{ text: "after", opts: { principal: "U1" } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stop disposes every live session", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

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
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ text: "ok" }));
    driver.last().failPrompt = true;

    await expect(service.handleInboundMessage(msg({ text: "boom" }))).resolves.toBeUndefined();
    expect(driver.last().prompts).toHaveLength(1);
  });

  test("the getPrincipal getter resolves the CURRENT TURN's principal, not the space's latest inbound (issue #152)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ principal: "UA", ts: "1.1" }));
    const session = driver.last();

    // A's turn is in flight (mid-tool-call); user B sends a CORRECTION →
    // the message STEERS the running turn, and the turn's binding must
    // stay A's — B's personal credential must never resolve for A's
    // extension calls.
    session.streaming = true;
    await service.handleInboundMessage(msg({ principal: "UB", text: "no wait, use the other key", ts: "2.2" }));
    expect(session.prompts[1].opts?.streamingBehavior).toBe("steer");
    const getPrincipal = driver.created[0].opts.getPrincipal!;
    expect(getPrincipal()).toBe("UA");

    // The turn ends (binding drops, fail closed), then B's own message
    // starts B's turn → B binds for B's extension calls.
    session.streaming = false;
    session.emit("turn_end", { spaceId: "slack:C1" });
    expect(getPrincipal()).toBeUndefined(); // between turns: no caller identity

    await service.handleInboundMessage(msg({ principal: "UB", ts: "3.3" }));
    expect(session.prompts[2].opts).toEqual({ principal: "UB" }); // fresh turn
    expect(getPrincipal()).toBe("UB");
  });

  test("issue #338: the default space session surfaces create_work_item, never a host shell/filesystem/subagent tool", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    // A shell request arrives on the Slack channel. The service cold-starts
    // the default space session (no explicit executor allowTools), so the
    // session's requested tool surface must be the #338-boundaried space
    // allowlist: the ONLY local-work delegation surface is create_work_item
    // (which dispatches into a one-job Docker sandbox); no host-native
    // shell/filesystem/subagent tool may be present.
    await service.handleInboundMessage(msg({ text: "run git status in a shell", ts: "1.1" }));

    expect(driver.created).toHaveLength(1);
    const sessionTools = driver.created[0]!.opts.allowTools ?? [];
    // Sanctioned surfaces: orchestration/conversation + the work-delegation
    // tool that routes local execution into the sandbox.
    expect(sessionTools).toContain("create_work_item");
    expect(sessionTools).toContain("web_search");
    // No host-native surface (issue #338): a shell request cannot execute
    // locally — the only path is create_work_item.
    for (const forbidden of FORBIDDEN_SPACE_HOST_TOOLS) {
      expect(sessionTools).not.toContain(forbidden);
    }
    // The service wires the boundary at the shared assembly point.
    expect([...sessionTools].sort()).toEqual(
      spaceAgentToolNames([], undefined, [], { applyHostToolBoundary: true }).sort(),
    );
    // The conversation surface still answers (the model decides the reply).
    expect(driver.last().prompts).toEqual([{ text: "run git status in a shell", opts: { principal: "U1" } }]);
  });
});

describe("SpaceService output routing", () => {
  test("agent output is posted to the adapter threaded under the latest inbound message", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    driver.last().emit("message", { spaceId: "slack:C1", text: "agent reply" });
    await Promise.resolve();

    // The phrase posted at receipt; the reply replaced it in place.
    expect(posts).toEqual([{ spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } }]);
    expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-1", text: "agent reply" }]);
  });

  test("onOutput is unconsumed: the message event is the single post channel", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    driver.created[0].opts.onOutput("slack:C1", "output channel");
    await Promise.resolve();
    expect(posts).toEqual([{ spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } }]); // receipt phrase only
    expect(updates).toHaveLength(0); // no double post from the legacy channel

    driver.last().emit("message", { spaceId: "slack:C1", text: "event channel" });
    await Promise.resolve();
    expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-1", text: "event channel" }]); // replaced in place
    expect(posts).toHaveLength(1);
  });

  test("turn_start posts a thinking phrase; the message event replaces it in place", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();

    // The phrase is already up from receipt (issue #119); turn_start rotates it.
    expect(posts).toEqual([{ spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } }]);

    session.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve(); // settle the phrase post so its ts is captured
    expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-1", text: "On it — thinking…" }]);

    session.emit("message", { spaceId: "slack:C1", text: "the answer" });
    await Promise.resolve();

    expect(updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: "ts-1", text: "the answer" });
    expect(posts).toHaveLength(1); // replaced in place, nothing posted fresh
  });

  test("DM replies are plain messages (no thread); channel replies keep threading (issue #296)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();

    // DM: the plain phrase presenter owns DMs (issue #180) — ONE plain post,
    // never a thread_ts, and the final answer edits the SAME card at request
    // settlement (issue #296). Constructed directly: the DM routing contract
    // is the presenter's, and session creation is flaky in this test env.
    const dm = new SlackTurnPresenter({ spaceId: "slack:D1", adapter, store, onboardingChecks: () => [] });
    dm.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    for (let i = 0; i < 3; i++) await Promise.resolve();
    dm.onMessage({ spaceId: "slack:D1", text: "dm answer" });
    dm.onRequestSettled();
    for (let i = 0; i < 3; i++) await Promise.resolve();

    // Channel: replies thread under the inbound message (issue #40) and
    // replace the same line.
    const channel = new SlackTurnPresenter({ spaceId: "slack:C1", adapter, store, onboardingChecks: () => [] });
    channel.onInbound(msg({ spaceId: "slack:C1", ts: "9.9" }));
    for (let i = 0; i < 3; i++) await Promise.resolve();
    channel.onMessage({ spaceId: "slack:C1", text: "channel answer" });
    for (let i = 0; i < 3; i++) await Promise.resolve();

    // DM: exactly ONE post (never a thread_ts) and the body rides the plain
    // `text` key — no attachment, no color bar (owner veto #296-reopened).
    // The channel reply threads under the inbound (issue #40) and carries
    // plain text too.
    expect(posts).toEqual([
      { spaceId: "slack:D1", text: THINKING_PHRASES[0], opts: undefined },
      { spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "9.9" } },
    ]);
    expect(posts.filter((p) => p.spaceId === "slack:D1").every((p) => p.opts?.threadTs === undefined)).toBe(true);
    // The DM final answer edits the SAME message in place as plain text.
    const dmFinal = updates.find((u) => u.spaceId === "slack:D1" && u.ts === "ts-1");
    expect(dmFinal).toBeDefined();
    expect(dmFinal!.opts).toBeUndefined();
    expect(dmFinal!.text).toBe("dm answer");
  });

  test("a DM with streaming support still takes the plain phrase path (no stream, no thread); a channel turn opens the thinking stream (issue #180)", async () => {
    const { adapter, posts, updates, streams, stops } = fakeAdapter({ streaming: true });
    const { store } = fakeStore();

    // DM: constructed directly WITH streaming supported — it still uses the
    // plain phrase presenter (no stream open, never a thread_ts), one card,
    // final answer edits it at settlement.
    const dm = new SlackTurnPresenter({ spaceId: "slack:D1", adapter, store, onboardingChecks: () => [] });
    dm.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    for (let i = 0; i < 3; i++) await Promise.resolve();
    dm.onMessage({ spaceId: "slack:D1", text: "dm answer" });
    dm.onRequestSettled();
    for (let i = 0; i < 3; i++) await Promise.resolve();

    // Channel with streaming: the StreamTurnPresenter opens the panel.
    const channel = new StreamTurnPresenter({ spaceId: "slack:C1", adapter, store, onboardingChecks: () => [] });
    channel.onInbound(msg({ spaceId: "slack:C1", ts: "9.9" }));
    for (let i = 0; i < 3; i++) await Promise.resolve();
    channel.onMessage({ spaceId: "slack:C1", text: "channel answer" });
    channel.onTurnEnd({ spaceId: "slack:C1" });
    for (let i = 0; i < 3; i++) await Promise.resolve();

    // DM: one plain message, phrase replaced in place with the final answer —
    // no stream call and no thread_ts anywhere on the DM surface (issue #180).
    expect(streams.map((s) => s.spaceId)).toEqual(["slack:C1"]);
    expect(streams[0].opts.threadTs).toBe("9.9");
    expect(posts.filter((p) => p.spaceId === "slack:D1").every((p) => p.opts?.threadTs === undefined)).toBe(true);
    // DM final answer: the message EDITS in place as plain text — the body
    // rides the text key, no attachment (owner veto #296-reopened).
    const dmStreamFinal = updates.find((u) => u.spaceId === "slack:D1" && u.ts === "ts-1");
    expect(dmStreamFinal).toBeDefined();
    expect(dmStreamFinal!.opts).toBeUndefined();
    expect(dmStreamFinal!.text).toBe("dm answer");
    // The DM surface never opened a stream (plain phrase path throughout).
    expect(streams.filter((s) => s.spaceId === "slack:D1")).toHaveLength(0);
    // Channel: the panel opened (threaded under the inbound ts) and
    // closed with the final reply as the stopStream block.
    expect(stops).toEqual([{ spaceId: "slack:C1", ts: "stream-1", text: "channel answer" }]);
  });

describe("SpaceService DM request settlement (issue #296)", () => {
  test("a REJECTED fresh DM request still settles its card to the error and clears the request (issue #296)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    // First message creates the session and settles normally.
    await service.handleInboundMessage(msg({ spaceId: "slack:D1", ts: "1.1" }));
    const session = driver.last();
    expect(posts.filter((p) => p.spaceId === "slack:D1")).toHaveLength(1);

    // A second message starts a FRESH DM request whose prompt REJECTS after
    // the driver buffered an error (onError). The service MUST still settle
    // the card to that error and never leave the request wedged.
    session.failPromptError = "provider exploded";
    await service.handleInboundMessage(msg({ spaceId: "slack:D1", ts: "2.2" }));
    // The rejected request's error settles as plain text on the one message —
    // no attachment, no color bar (owner veto #296-reopened).
    const dmError = updates.filter(
      (u) => u.spaceId === "slack:D1" && u.text === "provider exploded",
    );
    expect(dmError).toHaveLength(1); // the rejected request finalized the error on its one message
    expect(dmError[0]!.ts).toBe("ts-2"); // the ERROR replaced the SAME message ts, no second post

    // The request cleared: a THIRD message opens a FRESH card (not a wedged
    // reuse of the stuck request) and settles normally.
    session.failPromptError = undefined;
    await service.handleInboundMessage(msg({ spaceId: "slack:D1", ts: "3.3" }));
    const dmPosts = posts.filter((p) => p.spaceId === "slack:D1");
    expect(dmPosts).toHaveLength(3); // three distinct request cards
    const lastUpdate = updates.at(-1)!;
    expect(lastUpdate.ts).toBe("ts-3"); // the third request's own card
  });

  test("a REJECTED drained DM request settles its card and drains the NEXT queued message exactly once (issue #296)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    // Turn 1 runs (streaming); two independent messages queue behind it.
    await service.handleInboundMessage(msg({ spaceId: "slack:D1", ts: "1.1" }));
    const session = driver.last();
    await Promise.resolve();
    session.streaming = true;
    await service.handleInboundMessage(msg({ spaceId: "slack:D1", text: "queued A", ts: "2.2" }));
    await service.handleInboundMessage(msg({ spaceId: "slack:D1", text: "queued B", ts: "3.3" }));
    expect(session.prompts).toHaveLength(1); // both queued, neither prompted yet

    // Turn 1 ends; the queue drains. The FIRST drained turn's prompt REJECTS
    // after buffering an error — the service must settle the drained card to
    // the error AND still drain the second queued message.
    session.streaming = false;
    session.failPromptError = "drained exploded";
    session.emit("turn_end", { spaceId: "slack:D1" });
    for (let i = 0; i < 12; i++) await Promise.resolve();

    // BOTH queued messages drained as their own fresh requests, and EACH
    // rejected drained request surfaced the buffered error exactly once —
    // as a same-message edit, or (the reply-races-phrase-post edge) a
    // fresh final post. The error lands as plain text — never an
    // attachment (owner veto #296-reopened). This is the regression: a
    // rejected drained DM must still settle + drain the NEXT queued message
    // exactly once (issue #296).
    const carryError = (u: { text?: string }) => u.text === "drained exploded";
    const explodedUpdates = updates.filter((u) => u.spaceId === "slack:D1" && carryError(u));
    const explodedPosts = posts.filter((p) => p.spaceId === "slack:D1" && carryError(p));
    expect(explodedUpdates.length + explodedPosts.length).toBe(2); // queued A + queued B
    // The queue fully drained and no request is wedged: a NEW fresh turn runs.
    session.failPromptError = undefined;
    await service.handleInboundMessage(msg({ spaceId: "slack:D1", text: "fresh after drain", ts: "4.4" }));
    expect(posts.filter((p) => p.spaceId === "slack:D1").length).toBeGreaterThanOrEqual(4); // fresh message, not queued/stuck
    const lastUpdate = updates.at(-1)!;
    expect(lastUpdate.opts).toBeUndefined(); // the fresh turn's message is plain text
    expect(lastUpdate.text).toBe("Done."); // settled normally
  });
});

  test("a session error replaces the thinking phrase with the error text", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    // All-pass checks: this test is about the error surface, not the
    // onboarding nudge (issue #116).
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve();
    session.emit("error", { spaceId: "slack:C1", message: "model exploded" });
    await Promise.resolve();

    expect(updates).toEqual([
      { spaceId: "slack:C1", ts: "ts-1", text: "On it — thinking…" },
      { spaceId: "slack:C1", ts: "ts-1", text: "model exploded" },
    ]);
    expect(posts).toHaveLength(1); // phrase only; error replaced it
  });

  test("a turn whose model call errors with the proxy mint string produces a visible error reply naming the remedy (issue #218)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve();
    // The driver surfaces the proxy's 502 body (oauth_token failed to
    // mint) as the session error — the exact live failure from issue #218.
    session.emit("error", {
      spaceId: "slack:C1",
      message: '{"error":"oauth_token failed to mint an access token","grant":"refresh_token"}',
    });
    await Promise.resolve();

    const visible = updates.at(-1)!.text;
    expect(visible).toContain("codex login"); // the remedy, not the raw error
    expect(visible).toContain("restart the server");
    expect(visible).not.toContain("oauth_token failed to mint");
    expect(posts).toHaveLength(1); // phrase only; the remedy replaced it
    await service.stop();
  });

  test("an empty reply whose cause is a bare 403 maps to the mint remedy at the churn boundary (issue #218)", async () => {
    const { adapter, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    for (let i = 0; i <= EMPTY_TURN_LIMIT; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await Promise.resolve();
      session.emit("message", { spaceId: "slack:C1", text: "", error: "403" });
      await Promise.resolve();
    }

    // The per-turn fallback and the churn message both carry the remedy.
    for (const u of updates) {
      if (u.text?.includes("codex login") ?? false) {
        expect(u.text).toContain("restart the server");
      }
    }
    expect(updates.at(-1)!.text).toContain("codex login");
    expect(updates.at(-1)!.text).not.toContain("check the model key?");
    await service.stop();
  });

  test("a reply that lands while the phrase post is in flight falls back to posting fresh", async () => {
    const { adapter, posts, updates, releasePost } = fakeAdapter({ deferPost: true });
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" })); // phrase post parks in flight
    driver.last().emit("message", { spaceId: "slack:C1", text: "late answer" });
    await Promise.resolve();

    expect(posts).toEqual([
      { spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } },
      { spaceId: "slack:C1", text: "late answer", opts: { threadTs: "1.1" } },
    ]);
    expect(updates).toHaveLength(0);

    releasePost(); // settle the later post; the phrase ts was never captured, so nothing collapses
    await Promise.resolve();
    await Promise.resolve();
    expect(posts).toHaveLength(2);
  });

  test("a turn that ends with neither message nor error leaves the phrase as-is", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve();
    session.emit("turn_end", { spaceId: "slack:C1" });
    await Promise.resolve();

    expect(posts).toEqual([{ spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } }]);
    expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-1", text: "On it — thinking…" }]); // rotation only; phrase stays
  });

  test("a retry's turn_start updates the pending phrase in place — one message max (issue #60)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();

    session.emit("turn_start", { spaceId: "slack:C1" }); // first attempt
    await Promise.resolve();
    session.emit("turn_start", { spaceId: "slack:C1" }); // OMP auto-retry: another attempt
    await Promise.resolve();

    expect(posts).toHaveLength(1); // exactly one phrase posted (at receipt, issue #119)
    expect(posts[0]).toEqual({ spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } });
    expect(updates).toEqual([
      { spaceId: "slack:C1", ts: "ts-1", text: "On it — thinking…" },
      { spaceId: "slack:C1", ts: "ts-1", text: "Give me a second…" },
    ]); // each retry replaced in place
  });

  test("a turn_start while the phrase post is in flight never posts a second phrase (issue #60)", async () => {
    const { adapter, posts, updates, releasePost } = fakeAdapter({ deferPost: true });
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

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
      const service = makeSpaceService({ store, adapter, driver });

      await service.handleInboundMessage(msg({ ts: "1.1" }));
      const session = driver.last();
      session.emit("turn_start", { spaceId: "slack:C1" });
      await Promise.resolve();
      session.emit("message", { spaceId: "slack:C1", text: empty });
      await Promise.resolve();

      expect(posts).toHaveLength(1); // phrase only
      expect(updates).toEqual([
        { spaceId: "slack:C1", ts: "ts-1", text: "On it — thinking…" },
        { spaceId: "slack:C1", ts: "ts-1", text: EMPTY_RESPONSE_FALLBACK },
      ]);
    }
  });

  test("an empty completion is counted, and a later real reply resets the streak (issue #60)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    for (let i = 0; i < EMPTY_TURN_LIMIT; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await Promise.resolve();
      session.emit("message", { spaceId: "slack:C1", text: "" });
      await Promise.resolve();
    }
    expect(posts).toHaveLength(1); // never stacked, even across empties
    // Each turn: a rotation update (turn_start) plus a fallback update
    // (empty message) — all replaced in place on the same ts.
    expect(updates).toHaveLength(EMPTY_TURN_LIMIT * 2);
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
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

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
    // Four in-place rotations (receipt made the first turn_start a rotation
    // too) + one churn message = all on the same ts.
    expect(updates).toEqual([
      { spaceId: "slack:C1", ts: "ts-1", text: "On it — thinking…" },
      { spaceId: "slack:C1", ts: "ts-1", text: "Give me a second…" },
      { spaceId: "slack:C1", ts: "ts-1", text: "Working on it…" },
      { spaceId: "slack:C1", ts: "ts-1", text: "Let me think…" },
      { spaceId: "slack:C1", ts: "ts-1", text: CHURN_MESSAGE },
    ]);

    // Silence: further retries neither post nor update.
    session.emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve();
    session.emit("turn_end", { spaceId: "slack:C1" });
    await Promise.resolve();
    expect(posts).toHaveLength(1);
    expect(updates).toHaveLength(EMPTY_TURN_LIMIT + 2);

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
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

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
    // Rotations (N+1: the receipt phrase turns the first turn_start into a
    // rotation) + fallbacks (N) + churn (1) — churn shown exactly once.
    expect(updates).toHaveLength(EMPTY_TURN_LIMIT * 2 + 2);
  });

  test("a provider-error cause rides the churn message, still bounded by the churn guard (issue #78)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg());
    const session = driver.last();
    const CAUSE = "400 No tool output found for tool call call_repro_1";
    for (let i = 0; i < EMPTY_TURN_LIMIT + 1; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await Promise.resolve();
      session.emit("turn_end", { spaceId: "slack:C1", error: CAUSE });
      await Promise.resolve();
    }
    expect(posts).toHaveLength(1); // one phrase, never stacked
    const churn = updates.at(-1)!.text;
    expect(churn).toContain(CAUSE);
    expect(churn).toContain(CHURN_MESSAGE.split(" — ")[0]!); // same churn shape
    expect(churn).not.toContain("check the model key?"); // cause supersedes the guess

    // Churn guard holds: further error-empties neither post nor update.
    const updateCount = updates.length;
    for (let i = 0; i < 3; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await Promise.resolve();
      session.emit("turn_end", { spaceId: "slack:C1", error: CAUSE });
      await Promise.resolve();
    }
    expect(updates).toHaveLength(updateCount);
    expect(posts).toHaveLength(1);

    // A real reply ends the streak, re-arms phrases, and posts fresh.
    session.emit("message", { spaceId: "slack:C1", text: "recovered" });
    await Promise.resolve();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual({ spaceId: "slack:C1", text: "recovered", opts: { threadTs: "1.1" } });
  });

  test("an empty message event carries the provider-error cause in the fallback (issue #78)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg());
    const session = driver.last();
    const CAUSE = "400 No tool output found for tool call call_repro_1";
    session.emit("message", { spaceId: "slack:C1", text: "", error: CAUSE });
    await Promise.resolve();

    expect(posts).toHaveLength(1); // phrase only
    expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-1", text: emptyResponseFallback(CAUSE) }]);
    expect(updates[0]!.text).toContain(CAUSE);
    expect(updates[0]!.text).not.toContain("Hmm — I got an empty response, retrying…");
  });

  test("an unknown/absent cause keeps the exact legacy phrases (issue #78)", async () => {
    // Fail closed at the boundary: no cause, or whitespace-only, → legacy text.
    expect(emptyResponseFallback(undefined)).toBe(EMPTY_RESPONSE_FALLBACK);
    expect(emptyResponseFallback("")).toBe(EMPTY_RESPONSE_FALLBACK);
    expect(emptyResponseFallback("   ")).toBe(EMPTY_RESPONSE_FALLBACK);
    expect(churnMessageText(undefined)).toBe(CHURN_MESSAGE);
    expect(churnMessageText("")).toBe(CHURN_MESSAGE);

    // And the churn path end-to-end: turn_end without a cause → exact phrase.
    const { adapter, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg());
    const session = driver.last();
    for (let i = 0; i < EMPTY_TURN_LIMIT + 1; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await Promise.resolve();
      session.emit("turn_end", { spaceId: "slack:C1" });
      await Promise.resolve();
    }
    expect(updates.at(-1)!.text).toBe(CHURN_MESSAGE);
  });

  test("dispose clears the pending phrase and churn state (issue #60)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

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
    const service = makeSpaceService({ store, adapter, driver });

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

describe("SpaceService streaming phrase batching (issue #120)", () => {
  test("a streamed turn coalesces in-place updates to the cadence and always delivers the final text", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });
    vi.useFakeTimers();
    try {
      // Cold start, then steer the running (streaming) session. The receipt
      // phrase (issue #119), the steer's in-place rotation, and the steer's
      // FRESH phrase (issue #215) settle before we measure.
      await service.handleInboundMessage(msg({ ts: "1.1" }));
      const session = driver.last();
      session.streaming = true;
      await service.handleInboundMessage(msg({ text: "wait, use the other file", ts: "2.2" }));
      for (let i = 0; i < 3; i++) await Promise.resolve();
      expect(posts).toHaveLength(2); // receipt phrase + the steer's own phrase (#215)
      const base = updates.length;

      // Burst of stream chunks inside one turn: coalesced, nothing sent yet.
      for (const chunk of ["The", "The quick", "The quick brown", "The quick brown fox"]) {
        session.emit("message", { spaceId: "slack:C1", text: chunk });
      }
      await Promise.resolve();
      expect(updates).toHaveLength(base); // batched: no per-chunk spam

      vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS); // one cadence tick
      await Promise.resolve();
      expect(updates).toHaveLength(base + 1); // at most one update per tick
      expect(updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: "ts-2", text: "The quick brown fox" }); // latest text only

      // More chunks, turn ends before the next tick: the final text still lands.
      session.emit("message", { spaceId: "slack:C1", text: "The quick brown fox jumps" });
      session.emit("message", { spaceId: "slack:C1", text: "The quick brown fox jumps over the lazy dog" });
      session.emit("turn_end", { spaceId: "slack:C1" });
      await Promise.resolve();

      expect(updates).toHaveLength(base + 2); // tick update + final flush
      expect(updates.at(-1)).toEqual({
        spaceId: "slack:C1",
        ts: "ts-2", // the steer's phrase — the reply target newer than the steer inbound (#215)
        text: "The quick brown fox jumps over the lazy dog", // the full reply
      });
      expect(posts).toHaveLength(2); // receipt + steer phrase; the reply edits the steer's line
    } finally {
      vi.useRealTimers();
    }
  });

  test("a rate-limited interim update is logged and skipped, but the final text still lands (issue #120)", async () => {
    // Three updateMessage calls: the steer's in-place rotation, the interim
    // stream flush, and the final flush — the first two 429; the final
    // flush (turn_end) succeeds and must still land.
    const { adapter, posts, updates } = fakeAdapter({ failUpdateCalls: 2 });
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });
    vi.useFakeTimers();
    try {
      await service.handleInboundMessage(msg({ ts: "1.1" }));
      const session = driver.last();
      session.streaming = true;
      await service.handleInboundMessage(msg({ text: "wait, use the other file", ts: "2.2" }));
      for (let i = 0; i < 3; i++) await Promise.resolve();

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        session.emit("message", { spaceId: "slack:C1", text: "interim text" });
        vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS); // cadence tick → 429
        await Promise.resolve();
        expect(updates).toHaveLength(0); // rate-limited: nothing landed
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("streaming phrase update failed in slack:C1"),
        ); // logged, fail-soft — never thrown into the turn path

        // The turn's final text arrives; turn ends before the next tick.
        session.emit("message", { spaceId: "slack:C1", text: "final full reply" });
        session.emit("turn_end", { spaceId: "slack:C1" });
        await Promise.resolve();
        expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-2", text: "final full reply" }]); // the steer's line
      } finally {
        errorSpy.mockRestore();
      }
      expect(posts).toHaveLength(2); // receipt + the steer's own phrase (#215)
    } finally {
      vi.useRealTimers();
    }
  });

  test("non-streaming replies update in place immediately — no batching, no duplication (issue #120)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    await Promise.resolve(); // receipt phrase post settles
    session.emit("message", { spaceId: "slack:C1", text: "the answer" });
    await Promise.resolve();
    session.emit("turn_end", { spaceId: "slack:C1" });
    await Promise.resolve();

    expect(updates).toEqual([{ spaceId: "slack:C1", ts: "ts-1", text: "the answer" }]); // immediate, exactly once
    expect(posts).toHaveLength(1); // phrase only; replaced in place
  });
});

describe("SpaceService steer visibility (issue #215)", () => {
  test("a steered message gets a FRESH phrase (threaded under the steer, newer than it) and the final reply edits THAT phrase", async () => {
    // Live finding (run msykwxhj-155u): a message steered into a running
    // turn reuses the ORIGINAL turn's phrase — the final reply edits a
    // message OLDER than the steer inbound, so any poller filtering by the
    // steer's ts never sees it (no-reply stalls). The steer must post its
    // OWN phrase (new ts, on the steer message's own thread) and the final
    // reply must edit that message.
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    // Open turn 1 (fresh): the receipt phrase posts and is captured (ts-1).
    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    await Promise.resolve(); // the phrase post settles (pendingTs = ts-1)

    // A correction message (2.2) steers into the running turn: the service
    // marks the turn streaming — the steer must post a FRESH phrase on the
    // steer's own line, threaded under the steer inbound (2.2) and NEWER
    // than it.
    session.streaming = true;
    await service.handleInboundMessage(msg({ text: "wait, use the other file", ts: "2.2" }));
    for (let i = 0; i < 3; i++) await Promise.resolve(); // rotation + steer phrase post settle

    expect(posts).toEqual([
      { spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } },
      { spaceId: "slack:C1", text: "Give me a second…", opts: { threadTs: "2.2" } },
    ]);

    // The combined turn's reply: it must EDIT the steer phrase (ts-2, the
    // message posted AFTER the steer inbound), never the original phrase
    // (ts-1, older than the steer inbound).
    session.emit("message", { spaceId: "slack:C1", text: "the combined reply" });
    session.emit("turn_end", { spaceId: "slack:C1" });
    await Promise.resolve();
    expect(updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: "ts-2", text: "the combined reply" });
  });
});

describe("SpaceService queue-by-default (issue #219)", () => {
  test("an independent message mid-turn QUEUES (no steer); the '+N waiting' indicator shows and clears; each queued message drains as its own fresh turn in arrival order", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });
    vi.useFakeTimers();
    try {
      // Open turn 1 (fresh); the receipt phrase posts and is captured.
      await service.handleInboundMessage(msg({ text: "first", ts: "1.1" }));
      const session = driver.last();
      for (let i = 0; i < 3; i++) await Promise.resolve(); // phrase post settles (pendingTs = ts-1)
      session.streaming = true;

      // An independent message mid-turn QUEUES — never a steer prompt.
      await service.handleInboundMessage(msg({ text: "what is the weather", ts: "2.2" }));
      expect(session.prompts).toHaveLength(1); // no steer into the running turn

      // The indicator appears on the current phrase line.
      vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS);
      await Promise.resolve();
      expect(updates.some((u) => u.text?.includes("+1 waiting") ?? false)).toBe(true);

      // A second queued message bumps the count on the same line.
      await service.handleInboundMessage(msg({ text: "and another thing", ts: "3.3" }));
      vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS);
      await Promise.resolve();
      expect(updates.some((u) => u.text?.includes("+2 waiting") ?? false)).toBe(true);

      // The running turn ends → ONE queued message drains as its own fresh
      // turn (own phrase, own reply, no streamingBehavior), in arrival order.
      session.emit("message", { spaceId: "slack:C1", text: "first reply" });
      session.streaming = false; // the driver reports idle after turn_end
      session.emit("turn_end", { spaceId: "slack:C1" });
      for (let i = 0; i < 3; i++) await Promise.resolve();
      expect(session.prompts[1]).toEqual({ text: "what is the weather", opts: { principal: "U1" } });
      expect(session.prompts[1].opts?.streamingBehavior).toBeUndefined();

      // The drain turn ends → the SECOND message drains; the queue is empty.
      session.emit("message", { spaceId: "slack:C1", text: "reply to the weather" });
      session.streaming = false;
      session.emit("turn_end", { spaceId: "slack:C1" });
      for (let i = 0; i < 3; i++) await Promise.resolve();
      expect(session.prompts[2]).toEqual({ text: "and another thing", opts: { principal: "U1" } });
      expect(session.prompts[3]).toBeUndefined(); // nothing left to drain

      // The drained turns answered on their own visible lines (threaded
      // under the drained messages, not the original turn's phrase).
      expect(posts.some((p) => p.opts?.threadTs === "2.2")).toBe(true);
      expect(posts.some((p) => p.opts?.threadTs === "3.3")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a correction marker mid-turn steers the running turn on the existing steer path (issue #219)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ text: "first", ts: "1.1" }));
    const session = driver.last();
    session.streaming = true;
    await service.handleInboundMessage(msg({ text: "wait, actually use python instead", ts: "2.2" }));

    expect(session.prompts).toHaveLength(2); // steered, never queued
    expect(session.prompts[1]).toEqual({
      text: "wait, actually use python instead",
      opts: { streamingBehavior: "steer", principal: "U1" },
    });
  });

  test("a correction arriving after the safe window (final output committed) QUEUES instead of steering (issue #219)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ text: "first", ts: "1.1" }));
    const session = driver.last();
    session.streaming = true;
    // The turn already committed final output: the safe window is closed.
    session.emit("message", { spaceId: "slack:C1", text: "partial answer" });
    await Promise.resolve();

    await service.handleInboundMessage(msg({ text: "no wait, use the other file", ts: "2.2" }));
    expect(session.prompts).toHaveLength(1); // NOT steered — queued

    session.streaming = false; // the driver reports idle after turn_end
    session.emit("turn_end", { spaceId: "slack:C1" });
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(session.prompts[1]).toEqual({ text: "no wait, use the other file", opts: { principal: "U1" } });
    expect(session.prompts[1].opts?.streamingBehavior).toBeUndefined(); // its own fresh turn
  });

  test("a correction arriving while a tool call is in flight QUEUES instead of interrupting the tool (issue #219)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ text: "first", ts: "1.1" }));
    const session = driver.last();
    session.streaming = true;
    // A gated tool call is mid-flight (a side-effecting call must never be
    // interrupted): the safe window is closed.
    service.routeToolStep({
      spaceId: "slack:C1",
      taskId: "t1",
      title: "github.search_issues — allowed (read)",
      status: "in_progress",
    });

    await service.handleInboundMessage(msg({ text: "stop, use the other repo", ts: "2.2" }));
    expect(session.prompts).toHaveLength(1); // queued, never steered into the tool

    session.streaming = false; // the driver reports idle after turn_end
    session.emit("turn_end", { spaceId: "slack:C1" });
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(session.prompts[1].opts?.streamingBehavior).toBeUndefined();
  });

  test("an ambiguous mid-turn message QUEUES (fail-safe: unclassifiable never interrupts) (issue #219)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ text: "first", ts: "1.1" }));
    const session = driver.last();
    session.streaming = true;
    await service.handleInboundMessage(msg({ text: "hmm let me think about this", ts: "2.2" }));

    expect(session.prompts).toHaveLength(1); // queued, never interrupted
    session.streaming = false; // the driver reports idle after turn_end
    session.emit("turn_end", { spaceId: "slack:C1" });
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(session.prompts[1]).toEqual({ text: "hmm let me think about this", opts: { principal: "U1" } });
  });

  test("an injectable model seam promotes only AMBIGUOUS input; the default classifier is deterministic-only (issue #219)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const seam = vi.fn(async (text: string): Promise<MessageClass> => (text === "ambiguous one" ? "correction" : "independent"));
    const service = makeSpaceService({ store, adapter, driver, classifier: new CorrectionClassifier(seam) });

    await service.handleInboundMessage(msg({ text: "first", ts: "1.1" }));
    const session = driver.last();
    session.streaming = true;

    // Ambiguous input reaches the seam; the seam says correction → steers.
    await service.handleInboundMessage(msg({ text: "ambiguous one", ts: "2.2" }));
    expect(seam).toHaveBeenCalledTimes(1);
    expect(session.prompts[1].opts?.streamingBehavior).toBe("steer");

    // A clear correction never reaches the seam (deterministic first).
    await service.handleInboundMessage(msg({ text: "wait, use the other file", ts: "3.3" }));
    expect(seam).toHaveBeenCalledTimes(1);

    // The DEFAULT classifier has no seam: ambiguous always queues.
    const { adapter: adapter2 } = fakeAdapter();
    const { store: store2 } = fakeStore();
    const driver2 = new FakeDriver();
    const service2 = makeSpaceService({ store: store2, adapter: adapter2, driver: driver2 });
    await service2.handleInboundMessage(msg({ text: "first", ts: "1.1" }));
    const session2 = driver2.last();
    session2.streaming = true;
    await service2.handleInboundMessage(msg({ text: "hmm, not sure", ts: "2.2" }));
    expect(session2.prompts).toHaveLength(1); // queued
  });
});

describe("SpaceService durable pending-turn recovery (issue #312)", () => {
  const durableDir = mkdtempSync(join(tmpdir(), "bottega-durable-turns-"));
  const durableStores: Store[] = [];

  /** A real SQLite store on its own temp path — the only way pending_turns actually persists (issue #312). */
  function freshDurableStore(): Store {
    const s = createStore(join(durableDir, `store-${durableStores.length}.db`));
    durableStores.push(s);
    return s;
  }

  afterAll(() => {
    for (const s of durableStores) s.close();
    rmSync(durableDir, { recursive: true, force: true });
  });

  test("a crash-mid-queue turn is recovered and delivered exactly once after restart; not re-delivered on a second restart", async () => {
    const store = freshDurableStore();
    const { adapter } = fakeAdapter();
    const driver1 = new FakeDriver();
    const service1 = makeSpaceService({ store, adapter, driver: driver1, onboardingChecks: () => [] });

    // Turn 1 opens (streaming); an independent message QUEUES in memory AND
    // persists to the durable pending_turns backstop (issue #312).
    await service1.handleInboundMessage(msg({ text: "first", ts: "1.1" }));
    const session1 = driver1.last();
    for (let i = 0; i < 3; i++) await Promise.resolve();
    session1.streaming = true;
    await service1.handleInboundMessage(msg({ text: "crash me", ts: "2.2" }));
    expect(session1.prompts).toHaveLength(1); // queued, never prompted
    expect((await store.listPendingTurns("slack:C1")).map((r) => r.ts)).toEqual(["2.2"]);

    // Simulate a crash: stop the service WITHOUT the queued turn ever
    // draining or settling, so the durable row is left 'pending' for a
    // restart's recovery pass to re-serve exactly once.
    await service1.stop();

    // Restart against the SAME store: a fresh SpaceService cold-starts from
    // the durable backstop and recovers the crash-mid-queue turn.
    const { adapter: adapter2 } = fakeAdapter();
    const driver2 = new FakeDriver();
    const service2 = makeSpaceService({ store, adapter: adapter2, driver: driver2 });
    await service2.handleInboundMessage(msg({ text: "fresh after restart", ts: "9.1" }));
    const session2 = driver2.last();
    for (let i = 0; i < 3; i++) await Promise.resolve();

    // The fresh turn 9.1 ends → the drained queue serves the RECOVERED turn
    // exactly once as its own fresh turn (arrival order, own principal).
    session2.emit("message", { spaceId: "slack:C1", text: "nine one reply" });
    session2.streaming = false;
    session2.emit("turn_end", { spaceId: "slack:C1" });
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(session2.prompts[1]).toEqual({ text: "crash me", opts: { principal: "U1" } });
    expect(session2.prompts[2]).toBeUndefined();

    // The recovered turn settled → the durable row is marked done so a
    // SECOND restart never re-delivers it (issue #312 drain persistence).
    const rows = await store.listPendingTurns("slack:C1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ts: "2.2", status: "done" });
    await service2.stop();

    // A SECOND restart against the SAME store must NOT re-deliver the now-
    // done turn: its recovery pass finds nothing eligible, so the next cold
    // start only prompts fresh messages — "crash me" is never served again.
    const { adapter: adapter3 } = fakeAdapter();
    const driver3 = new FakeDriver();
    const service3 = makeSpaceService({ store, adapter: adapter3, driver: driver3 });
    await service3.handleInboundMessage(msg({ text: "third life", ts: "19.1" }));
    const session3 = driver3.last();
    for (let i = 0; i < 3; i++) await Promise.resolve();
    session3.streaming = false;
    session3.emit("message", { spaceId: "slack:C1", text: "third reply" });
    session3.emit("turn_end", { spaceId: "slack:C1" });
    for (let i = 0; i < 3; i++) await Promise.resolve();
    // Only the fresh message prompted — the recovered turn was never re-served.
    expect(session3.prompts.map((p) => p.text)).toEqual(["third life"]);
    await service3.stop();
    store.close();
  });

  test("a completed turn is never re-delivered: recovery returns nothing once done", async () => {
    const store = freshDurableStore();
    await store.enqueuePendingTurn({ spaceId: "slack:C1", ts: "1.1", principal: "U1", text: "done already" });
    await store.completePendingTurn("slack:C1", "1.1");

    // A restart's recovery pass must not re-serve a completed turn.
    expect(await store.recoverPendingTurns("slack:C1", 60_000)).toEqual([]);
    expect((await store.listPendingTurns("slack:C1"))[0]?.status).toBe("done");
    store.close();
  });

  test("two racing recoveries claim a pending turn for exactly one claimant", async () => {
    const store = freshDurableStore();
    await store.enqueuePendingTurn({ spaceId: "slack:C1", ts: "1.1", principal: "U1", text: "race me" });

    // Two restart passes racing the same claim: the store's atomic lease
    // must hand the row to exactly ONE claimant (the loser sees the winner's
    // fresh 'claimed' lease and gets nothing).
    const [first, second] = await Promise.all([
      store.recoverPendingTurns("slack:C1", 60_000),
      store.recoverPendingTurns("slack:C1", 60_000),
    ]);
    const claimants = [first, second].filter((claims) => claims.length === 1);
    expect(claimants).toHaveLength(1);
    expect(claimants[0]?.[0]).toMatchObject({ spaceId: "slack:C1", ts: "1.1", text: "race me" });
    store.close();
  });

  test("a claimed-but-unfinished turn is reclaimed only after its lease expires (crash-mid-drain)", async () => {
    const store = freshDurableStore();
    await store.enqueuePendingTurn({ spaceId: "slack:C1", ts: "1.1", principal: "U1", text: "leased" });

    // First recovery claims the turn under a lease (status 'claimed').
    const claimed = await store.recoverPendingTurns("slack:C1", 60_000);
    expect(claimed).toHaveLength(1);

    // Within the lease window a racing/restart recovery must NOT reclaim it.
    expect(await store.recoverPendingTurns("slack:C1", 60_000)).toEqual([]);

    // Force the lease to expire, then recover: the crash-mid-drain turn is
    // reclaimed exactly once (never lost) — but the same lease semantics
    // still prevent a second concurrent recovery from double-claiming.
    store
      .getDb()
      .query("UPDATE pending_turns SET lease_until = 1 WHERE space_id = ? AND ts = ?")
      .run("slack:C1", "1.1");
    const [a, b] = await Promise.all([
      store.recoverPendingTurns("slack:C1", 60_000),
      store.recoverPendingTurns("slack:C1", 60_000),
    ]);
    const claimants = [a, b].filter((claims) => claims.length === 1);
    expect(claimants).toHaveLength(1);
    expect(claimants[0]?.[0]).toMatchObject({ spaceId: "slack:C1", ts: "1.1", text: "leased" });
    store.close();
  });
});

describe("SpaceService threaded inbound turns (issue #289)", () => {
  test("two sequential requests in one Slack thread get reaction-only receipts and two distinct final replies under the same root", async () => {
    const { adapter, posts, updates, reactions, streams } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    // Request 1: a reply inside the root thread (root ts=1.0, reply ts=1.1).
    await service.handleInboundMessage(msg({ text: "first", ts: "1.1", threadTs: "1.0" }));
    const session = driver.last();
    for (let i = 0; i < 3; i++) await Promise.resolve();

    // Reaction-only receipt: NO placeholder post, NO stream open — the old
    // behavior posted a thinking phrase threaded under the inbound reply.
    expect(posts).toHaveLength(0);
    expect(streams).toHaveLength(0);
    expect(reactions).toEqual([{ kind: "add", spaceId: "slack:C1", ts: "1.1" }]);

    // Answer 1: a NEW message under the ROOT — never an edit of a placeholder.
    session.emit("message", { spaceId: "slack:C1", text: "answer one" });
    session.emit("turn_end", { spaceId: "slack:C1" });
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(posts).toEqual([{ spaceId: "slack:C1", text: "answer one", opts: { threadTs: "1.0" } }]);
    expect(updates).toHaveLength(0);

    // Request 2 in the SAME thread: its own fresh turn answering under the
    // same root — no placeholder, no reuse/edit of request 1's line.
    await service.handleInboundMessage(msg({ text: "second", ts: "2.1", threadTs: "1.0" }));
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(posts).toHaveLength(1); // still no placeholder posted
    session.emit("message", { spaceId: "slack:C1", text: "answer two" });
    session.emit("turn_end", { spaceId: "slack:C1" });
    for (let i = 0; i < 3; i++) await Promise.resolve();

    // Two DISTINCT final postMessage calls under the same root, request order.
    expect(posts).toEqual([
      { spaceId: "slack:C1", text: "answer one", opts: { threadTs: "1.0" } },
      { spaceId: "slack:C1", text: "answer two", opts: { threadTs: "1.0" } },
    ]);
    expect(updates).toHaveLength(0); // no final updateMessage calls

    // Both receipts acked and removed; message.in + message.reply audits for both.
    expect(reactions).toEqual([
      { kind: "add", spaceId: "slack:C1", ts: "1.1" },
      { kind: "remove", spaceId: "slack:C1", ts: "1.1" },
      { kind: "add", spaceId: "slack:C1", ts: "2.1" },
      { kind: "remove", spaceId: "slack:C1", ts: "2.1" },
    ]);
    const inAudits = audit.filter((a) => a.event_type === MESSAGE_RECEIVED_EVENT);
    expect(inAudits.map((a) => JSON.parse(a.payload).ts)).toEqual(["1.1", "2.1"]);
    expect(audit.filter((a) => a.event_type === MESSAGE_REPLIED_EVENT)).toHaveLength(2);
  });

  test("queued thread requests drain one fresh turn each: request1 → answer1 → request2 → answer2, all under the same root", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });
    vi.useFakeTimers();
    try {
      // Turn 1 runs (threaded request 1).
      await service.handleInboundMessage(msg({ text: "first", ts: "1.1", threadTs: "1.0" }));
      const session = driver.last();
      for (let i = 0; i < 3; i++) await Promise.resolve();
      session.streaming = true;

      // Request 2 in the same thread QUEUES (reaction-only; no second prompt).
      await service.handleInboundMessage(msg({ text: "second", ts: "2.1", threadTs: "1.0" }));
      expect(session.prompts).toHaveLength(1);

      // Turn 1 answers; its turn_end drains request 2 as its own fresh turn.
      session.emit("message", { spaceId: "slack:C1", text: "answer one" });
      session.streaming = false;
      session.emit("turn_end", { spaceId: "slack:C1" });
      for (let i = 0; i < 3; i++) await Promise.resolve();
      expect(session.prompts[1]).toEqual({ text: "second", opts: { principal: "U1" } });

      session.emit("message", { spaceId: "slack:C1", text: "answer two" });
      for (let i = 0; i < 3; i++) await Promise.resolve();

      // FIFO: request1 → answer1 → request2 → answer2, each reply a distinct
      // post under the SAME root — never an edit and never a nested thread.
      expect(session.prompts.map((p) => p.text)).toEqual(["first", "second"]);
      expect(posts).toEqual([
        { spaceId: "slack:C1", text: "answer one", opts: { threadTs: "1.0" } },
        { spaceId: "slack:C1", text: "answer two", opts: { threadTs: "1.0" } },
      ]);
      expect(updates).toHaveLength(0);
      expect(posts[0]).not.toEqual(posts[1]); // distinct messages, distinct ts
    } finally {
      vi.useRealTimers();
    }
  });

  test("a threaded request that errors still lands a fresh terminal reply under the root", async () => {
    const { adapter, posts, updates, reactions } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ text: "do it", ts: "1.1", threadTs: "1.0" }));
    const session = driver.last();
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(posts).toHaveLength(0); // reaction-only receipt

    session.emit("error", { spaceId: "slack:C1", message: "provider exploded" });
    for (let i = 0; i < 3; i++) await Promise.resolve();

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ spaceId: "slack:C1", opts: { threadTs: "1.0" } });
    expect(posts[0]!.text).toContain("provider exploded");
    expect(updates).toHaveLength(0);
    expect(reactions.at(-1)).toEqual({ kind: "remove", spaceId: "slack:C1", ts: "1.1" });
  });

  test("a queued top-level message during a threaded turn never retargets it: A's reply posts under the root; B's phrase appears only when B drains (issue #289 review)", async () => {
    const { adapter, posts, updates, reactions } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    // Threaded request A (root 1.0): reaction-only receipt, no placeholder.
    await service.handleInboundMessage(msg({ text: "threaded A", ts: "1.1", threadTs: "1.0" }));
    const session = driver.last();
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(posts).toHaveLength(0);
    expect(reactions).toEqual([{ kind: "add", spaceId: "slack:C1", ts: "1.1" }]);
    session.streaming = true;

    // Top-level B arrives mid-turn: QUEUES. It must not post a placeholder
    // nor retarget the running threaded turn's reply target.
    await service.handleInboundMessage(msg({ text: "top-level B", ts: "5.0" }));
    expect(session.prompts).toHaveLength(1); // queued, never prompted
    expect(posts).toHaveLength(0); // no B placeholder at queue time
    expect(reactions).toEqual([
      { kind: "add", spaceId: "slack:C1", ts: "1.1" },
      { kind: "add", spaceId: "slack:C1", ts: "5.0" },
    ]); // B still acked at queue time

    // A completes: its reply posts FRESH under the ROOT — never under B's ts.
    session.emit("message", { spaceId: "slack:C1", text: "A answer" });
    await Promise.resolve();
    expect(posts).toEqual([{ spaceId: "slack:C1", text: "A answer", opts: { threadTs: "1.0" } }]);
    expect(updates).toHaveLength(0); // no edit of a placeholder (B never got one)

    // B drains: only NOW does B's own phrase post under B's ts (5.0).
    session.streaming = false;
    session.emit("turn_end", { spaceId: "slack:C1" });
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(session.prompts[1]).toEqual({ text: "top-level B", opts: { principal: "U1" } });
    expect(posts.some((p) => p.opts?.threadTs === "5.0" && p.text === THINKING_PHRASES[0])).toBe(true);
  });

  test("a queued message from a DIFFERENT thread root never retargets the running threaded turn (issue #289 review)", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    // Threaded A (root 1.0) runs.
    await service.handleInboundMessage(msg({ text: "threaded A", ts: "1.1", threadTs: "1.0" }));
    const session = driver.last();
    for (let i = 0; i < 3; i++) await Promise.resolve();
    session.streaming = true;

    // C arrives from a DIFFERENT thread (root 2.0): queues; must not swap
    // the running turn's root.
    await service.handleInboundMessage(msg({ text: "other thread C", ts: "6.6", threadTs: "2.0" }));
    expect(session.prompts).toHaveLength(1);

    // A answers under ITS root 1.0 — never under C's root 2.0.
    session.emit("message", { spaceId: "slack:C1", text: "A answer" });
    await Promise.resolve();
    expect(posts).toEqual([{ spaceId: "slack:C1", text: "A answer", opts: { threadTs: "1.0" } }]);

    // C drains: its reply lands under ITS OWN root 2.0.
    session.streaming = false;
    session.emit("turn_end", { spaceId: "slack:C1" });
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(session.prompts[1]).toEqual({ text: "other thread C", opts: { principal: "U1" } });
    session.emit("message", { spaceId: "slack:C1", text: "C answer" });
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(posts).toEqual([
      { spaceId: "slack:C1", text: "A answer", opts: { threadTs: "1.0" } },
      { spaceId: "slack:C1", text: "C answer", opts: { threadTs: "2.0" } },
    ]);
    expect(updates).toHaveLength(0);
  });

  test("a threaded drain re-arms steering: a correction mid-drained-turn steers instead of queueing (issue #289 review)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    // Turn 1 (top-level) runs; a threaded request queues mid-turn.
    await service.handleInboundMessage(msg({ text: "first", ts: "1.1" }));
    const session = driver.last();
    for (let i = 0; i < 3; i++) await Promise.resolve();
    session.streaming = true;
    await service.handleInboundMessage(msg({ text: "threaded queued", ts: "2.1", threadTs: "1.0" }));
    expect(session.prompts).toHaveLength(1);

    // Turn 1 delivers and ends → the threaded request drains as its own
    // fresh turn (reaction-only).
    session.emit("message", { spaceId: "slack:C1", text: "first answer" });
    await Promise.resolve();
    session.streaming = false;
    session.emit("turn_end", { spaceId: "slack:C1" });
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(session.prompts[1]).toEqual({ text: "threaded queued", opts: { principal: "U1" } });

    // The drained turn runs; a correction in the same thread must STEER it
    // — the drain resets the delivered flag, re-opening the safe window.
    session.streaming = true;
    await service.handleInboundMessage(msg({ text: "wait, actually use python instead", ts: "3.1", threadTs: "1.0" }));
    expect(session.prompts).toHaveLength(3);
    expect(session.prompts[2]!.opts?.streamingBehavior).toBe("steer");
  });
});

describe("SpaceService run settlement after a stream/panel turn (issue #183)", () => {
  test("a stream/panel turn followed by another message: the second turn runs fresh and its reply lands — no busy wedge", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    // Turn one: the agent starts streaming (the stream/panel path). A
    // second message STEERS the running turn.
    await service.handleInboundMessage(msg({ text: "first", ts: "1.1" }));
    const session = driver.last();
    expect(session.prompts).toHaveLength(1);
    session.streaming = true;
    await service.handleInboundMessage(msg({ text: "wait, use the other file", ts: "2.2" }));
    expect(session.prompts[1].opts?.streamingBehavior).toBe("steer");

    // The stream turn settles: the reply streams, turn_end fires, and the
    // session is idle again (no ghost run left behind).
    session.emit("message", { spaceId: "slack:C1", text: "stream reply" });
    await Promise.resolve();
    session.emit("turn_end", { spaceId: "slack:C1" });
    await Promise.resolve();
    session.streaming = false;

    // A THIRD message after the stream turn must run a FRESH turn (never a
    // busy timeout, never a silent steer into a dead run) and its reply
    // must land — the phrase/reply always arrive. The reply keeps editing
    // the steer's own phrase (ts-2), the newest visible line (#215).
    session.autoReply = "reply to the third";
    await service.handleInboundMessage(msg({ text: "third", ts: "3.3" }));
    expect(session.prompts[2].opts?.streamingBehavior).toBeUndefined(); // fresh turn, not a steer
    await Promise.resolve();
    expect(updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: "ts-2", text: "reply to the third" });
    expect(posts).toHaveLength(2); // receipt phrase + the steer's own phrase — never a silent no-reply
  });
});

describe("SpaceService digest-on-idle", () => {
  test("dispose digests new messages into org memory, advances the marker, and disposes", async () => {
    const { adapter } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const provider = new FakeMemoryProvider();
    const service = makeSpaceService({ store, adapter, driver, memoryProvider: provider });

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
        scope: { kind: "org" },
        content: "- first digest",
        metadata: { kind: "digest", space: "slack:C1", since: "", until: "1.1" },
      },
    ]);
    expect(first.disposed).toBe(true);
    expect(audit.filter((a) => a.event_type === DIGEST_FAILED_EVENT)).toHaveLength(0); // no failure audited

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
    const service = makeSpaceService({
      store,
      adapter,
      driver,
      memoryProvider: provider,
    });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    driver.last().autoReply = "- digest";
    await service.stop();

    expect(provider.prunes).toEqual([{ spaceId: "slack:C1", keep: DIGEST_CAP }]);
  });

  test("fails before summary or save when the configured provider cannot prune digests", async () => {
    const { adapter } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const provider = new FakeMemoryProvider({
      consolidation: "on-save",
      digestPruning: "unsupported",
    });
    const service = makeSpaceService({ store, adapter, driver, memoryProvider: provider });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.autoReply = "- must not be produced";
    await service.stop();

    expect(session.prompts).toHaveLength(1);
    expect(provider.saved).toHaveLength(0);
    expect(provider.prunes).toHaveLength(0);
    const failure = audit.find((entry) => entry.event_type === DIGEST_FAILED_EVENT);
    expect(JSON.parse(failure!.payload)).toEqual({
      reason:
        "configured memory provider does not support required digest pruning; " +
        "digest production cannot enforce the per-space retention cap",
    });
    expect(session.disposed).toBe(true);
  });

  test("no messages newer than the marker means no digest", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const provider = new FakeMemoryProvider();
    provider.digests.push({ space: "slack:C1", since: "0.1", until: "1.1" });
    const service = makeSpaceService({ store, adapter, driver, memoryProvider: provider });

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
    const service = makeSpaceService({ store, adapter, driver, memoryProvider: provider });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.failPrompt = true;
    await service.stop();

    expect(provider.saved).toHaveLength(0);
    expect(audit.filter((a) => a.event_type === DIGEST_FAILED_EVENT)).toEqual([
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
    const service = makeSpaceService({ store, adapter, driver, memoryProvider: provider });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.autoReply = ""; // turn completes with no text
    await service.stop();

    expect(provider.saved).toHaveLength(0);
    expect(audit.filter((a) => a.event_type === DIGEST_FAILED_EVENT)).toEqual([
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
    const service = makeSpaceService({
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
      expect(audit.filter((a) => a.event_type === DIGEST_FAILED_EVENT)).toEqual([
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
    const service = makeSpaceService({ store, adapter, driver, memoryProvider: provider });

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
    const service = makeSpaceService({ store, adapter, driver });

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
    const service = makeSpaceService({
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
      const service = makeSpaceService({
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
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg());

    expect(driver.created[0].opts.appendSystemPrompt).toBe(SLACK_FORMAT_DIRECTIVE);
    await service.stop();
  });
});

describe("work-items auto-pickup → session prompt directive (issue #89)", () => {
  test("auto_pickup on appends the pickup directive after the Slack format directive", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const orgPolicy = parseOrgConfigYaml("work_items:\n  auto_pickup: true\n");
    const service = makeSpaceService({ store, adapter, driver, orgPolicy });

    await service.handleInboundMessage(msg());

    expect(driver.created).toHaveLength(1);
    expect(driver.created[0].opts.appendSystemPrompt).toBe(
      `${SLACK_FORMAT_DIRECTIVE}\n\n${buildAutoPickupDirective("high")}`,
    );
    await service.stop();
  });

  test("the directive reflects the configured pickup_confidence threshold", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const orgPolicy = parseOrgConfigYaml("work_items:\n  auto_pickup: true\n  pickup_confidence: medium\n");
    const service = makeSpaceService({ store, adapter, driver, orgPolicy });

    await service.handleInboundMessage(msg());

    expect(driver.created[0].opts.appendSystemPrompt).toBe(
      `${SLACK_FORMAT_DIRECTIVE}\n\n${buildAutoPickupDirective("medium")}`,
    );
    await service.stop();
  });

  test("auto_pickup off (the default) never appends the pickup directive", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg());

    expect(driver.created[0].opts.appendSystemPrompt).toBe(SLACK_FORMAT_DIRECTIVE);
    expect(driver.created[0].opts.appendSystemPrompt).not.toContain("CONFIRMABLE DRAFT");
    await service.stop();
  });
});

describe("connect-shaped messages reach the agent turn (issue #273)", () => {
  test("'connect my X' enters the session path — message.in audit, no direct connect outcome", async () => {
    // Issue #273: the #61 regex pre-route is GONE — a connect-shaped
    // message must reach the agent turn (never a silent system-level
    // short-circuit). connect_extension (the per-session TOOL) drives the
    // connect flow from the agent side.
    const { adapter, posts } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ text: "connect my notion", ts: "2.2" }));

    // The message reached the agent turn: a session cold-started, the
    // prompt carries the verbatim message, and the receipt wrote the
    // message.in audit row.
    expect(driver.created).toHaveLength(1);
    expect(driver.last().prompts[0]!.text).toBe("connect my notion");
    const received = audit.find((a) => a.event_type === MESSAGE_RECEIVED_EVENT);
    expect(received).toMatchObject({ space_id: "slack:C1", actor: "U1" });
    // No direct connect outcome: the space service never runs the connect
    // capability itself — no extension.connected row (the seam's outcome
    // signal), and the turn's only post is the receipt phrase, never a
    // connect reply.
    expect(audit.some((a) => a.event_type === EXTENSION_CONNECTED_EVENT)).toBe(false);
    expect(posts.every((p) => p.text === THINKING_PHRASES[0])).toBe(true);
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
    const service = makeSpaceService({
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
    // SAFETY: the onboarding-nudge audit row is written by SpaceService with
    // a { checks: Array<{name, ok}> } payload (ADMIN_ONBOARDING_NUDGE_EVENT).
    const payload = JSON.parse(nudgeAudits[0]!.payload) as { checks: Array<{ name: string; ok: boolean }> };
    expect(payload.checks.map((c) => c.name).sort()).toEqual(["model_key", "slack_tokens"]);
  });

  test("a session error appends the pointer once, not per message (same missing set deduped)", async () => {
    const { adapter, updates } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({
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

    const nudged = updates.filter((u) => u.text?.includes("first_run_wizard") ?? false);
    expect(nudged).toHaveLength(1);
    expect(nudged[0]!.text).toContain("broker_token");
    expect(nudged[0]!.text).toContain("git_pat");
    // 4 error updates total (each preceded by a phrase rotation): the first
    // carries the pointer, the rest are raw.
    expect(updates.filter((u) => u.text?.startsWith("boom") ?? false)).toHaveLength(4);
    expect(audit.filter((a) => a.event_type === ADMIN_ONBOARDING_NUDGE_EVENT)).toHaveLength(1);
  });

  test("a changed failing set nudges again naming what remains (bounded until resolved)", async () => {
    const { adapter, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    let missing = ["broker_token", "git_pat"];
    const service = makeSpaceService({
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
    const nudged = updates.filter((u) => u.text?.includes("first_run_wizard") ?? false);
    expect(nudged).toHaveLength(2);
  });

  test("all-pass checks never nudge, even on repeated failures", async () => {
    const { adapter, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, onboardingChecks: () => [] });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    for (let i = 0; i < 3; i++) {
      session.emit("turn_start", { spaceId: "slack:C1" });
      await flush();
      session.emit("error", { spaceId: "slack:C1", message: "boom" });
      await flush();
    }
    expect(updates.filter((u) => u.text?.includes("first_run_wizard") ?? false)).toHaveLength(0);
    // Each error replaces the pending phrase in place (clearing its ts), so
    // only the first turn_start rotates; the rest post fresh.
    expect(updates.filter((u) => u.text === "boom")).toHaveLength(3);
    expect(updates).toHaveLength(4);
  });

  test("a check failure suppresses the nudge, never the turn output (fail closed)", async () => {
    const { adapter, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({
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

describe("SpaceService receipt responsiveness (issue #119)", () => {
  test("the phrase posts on receipt, before a slow session creation completes (issue #119)", async () => {
    const { adapter, posts, reactions } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    driver.deferCreate = true;
    const service = makeSpaceService({ store, adapter, driver });

    const inbound = service.handleInboundMessage(msg({ ts: "1.1" })); // cold-start parks on the gate
    await Promise.resolve();

    // While createSession is still pending, the space already shows the
    // phrase and the receipt reaction (issue #119).
    expect(posts).toEqual([{ spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } }]);
    expect(reactions).toEqual([{ kind: "add", spaceId: "slack:C1", ts: "1.1" }]);

    // Cold-start runs microtask hops (attachment ingest #124, response-mode
    // lookup) before createSession parks on the defer gate; wait for the
    // gate instead of assuming the hop count, then release it.
    while (driver.createGate === undefined) await Promise.resolve();
    driver.finishCreate();
    await inbound;
    expect(driver.last().prompts).toEqual([{ text: "hello", opts: { principal: "U1" } }]);
  });

  test("a receipt reaction is added on receipt and removed when the reply lands (issue #119)", async () => {
    const { adapter, reactions } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    expect(reactions).toEqual([{ kind: "add", spaceId: "slack:C1", ts: "1.1" }]);

    driver.last().emit("message", { spaceId: "slack:C1", text: "the answer" });
    await Promise.resolve();
    expect(reactions).toEqual([
      { kind: "add", spaceId: "slack:C1", ts: "1.1" },
      { kind: "remove", spaceId: "slack:C1", ts: "1.1" },
    ]);
  });

  test("a session error also clears the receipt reaction (issue #119)", async () => {
    const { adapter, reactions } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    driver.last().emit("error", { spaceId: "slack:C1", message: "boom" });
    await Promise.resolve();
    expect(reactions.at(-1)).toEqual({ kind: "remove", spaceId: "slack:C1", ts: "1.1" });
  });

  test("steered messages are each acked; the reply clears every pending reaction (issue #119)", async () => {
    const { adapter, reactions } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    driver.last().streaming = true;
    await service.handleInboundMessage(msg({ text: "wait, use the other file", ts: "2.2" }));
    expect(reactions).toEqual([
      { kind: "add", spaceId: "slack:C1", ts: "1.1" },
      { kind: "add", spaceId: "slack:C1", ts: "2.2" },
    ]);

    driver.last().emit("message", { spaceId: "slack:C1", text: "reply" });
    driver.last().emit("turn_end", { spaceId: "slack:C1" }); // streaming finals clear on turn_end
    await Promise.resolve();
    expect(reactions.filter((r) => r.kind === "remove").map((r) => r.ts).sort()).toEqual(["1.1", "2.2"]);
  });

  test("a missing reactions scope degrades to a log; the turn is unaffected (issue #119)", async () => {
    const { adapter, posts, updates, reactions } = fakeAdapter({ failReactions: true });
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    expect(reactions).toHaveLength(0); // the add failed and was logged

    driver.last().emit("turn_start", { spaceId: "slack:C1" });
    await Promise.resolve();
    driver.last().emit("message", { spaceId: "slack:C1", text: "still answers" });
    await Promise.resolve();
    expect(posts).toEqual([{ spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } }]);
    expect(updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: "ts-1", text: "still answers" });
  });

  test("audit rows carry receipt and reply timing (issue #119)", async () => {
    const { adapter } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const received = audit.find((a) => a.event_type === MESSAGE_RECEIVED_EVENT);
    expect(received).toMatchObject({
      space_id: "slack:C1",
      actor: "U1",
      payload: JSON.stringify({ ts: "1.1" }),
    });

    driver.last().emit("message", { spaceId: "slack:C1", text: "the answer" });
    await Promise.resolve();
    const replied = audit.find((a) => a.event_type === MESSAGE_REPLIED_EVENT);
    expect(replied).toMatchObject({ space_id: "slack:C1", actor: "system" });
    // SAFETY: the message.reply audit row is written by SpaceService with a
    // { latency_ms, phrase_ms? } payload (MESSAGE_REPLIED_EVENT).
    const payload = JSON.parse(replied!.payload) as { latency_ms: number; phrase_ms?: number };
    expect(payload.latency_ms).toBeGreaterThanOrEqual(0);
    expect(payload.phrase_ms).toBeGreaterThanOrEqual(0);
  });

  test("an empty completion is not a reply: no message.reply row until real text lands (issue #119)", async () => {
    const { adapter } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    driver.last().emit("message", { spaceId: "slack:C1", text: "" });
    await Promise.resolve();
    expect(audit.filter((a) => a.event_type === MESSAGE_REPLIED_EVENT)).toHaveLength(0);

    driver.last().emit("message", { spaceId: "slack:C1", text: "real answer" });
    await Promise.resolve();
    expect(audit.filter((a) => a.event_type === MESSAGE_REPLIED_EVENT)).toHaveLength(1);
  });
});

describe("classifyCorrection marker table (issue #219)", () => {
  test("clear correction markers classify as corrections", () => {
    const corrections = [
      "wait, let me clarify",
      "hold on",
      "hold up, not that one",
      "actually use python",
      "no, don't do that",
      "nope, the other one",
      "instead use the other file",
      "don't use that",
      "use python instead",
      "switch to deepseek",
      "try the other approach",
      "change that",
      "change it to the beta",
      "never mind",
      "scratch that",
      "ignore that",
      "forget it",
      "let me rephrase",
      "what i meant was the other one",
      "i meant the other one",
      "correction: use the beta",
      "rephrase that",
      "not that one",
      "wrong file",
      "that's not what I asked",
    ];
    for (const text of corrections) {
      expect(classifyCorrection(text)).toBe("correction");
    }
  });

  test("clear independent messages classify as independent (the model seam is skipped)", () => {
    const independents = [
      "what's the weather",
      "how do i set up the repo",
      "please summarize this",
      "thanks",
      "can you do X",
      "hello",
      "why is the build failing",
      "ok sounds good",
      "yes please",
    ];
    for (const text of independents) {
      expect(classifyCorrection(text)).toBe("independent");
    }
  });

  test("ambiguous messages are neither — they resolve to the queue (fail-safe)", () => {
    const ambiguous = [
      "hmm let me think about this",
      "and another thing",
      "the second one",
      "whatever",
      "",
    ];
    for (const text of ambiguous) {
      expect(classifyCorrection(text)).toBe("ambiguous");
    }
  });

  test("word boundaries keep partial matches out of the table", () => {
    // "no" must not match "not that" (a separate marker) or "nonsense";
    // "use" must not match "useful"; "wait" mid-sentence is not a marker.
    expect(classifyCorrection("not that one")).toBe("correction");
    expect(classifyCorrection("no")).toBe("correction");
    expect(classifyCorrection("nonsense aside, do X")).toBe("ambiguous");
    expect(classifyCorrection("useful summary please")).toBe("ambiguous");
    expect(classifyCorrection("i am waiting for the build")).toBe("ambiguous");
  });
});

describe("SpaceService live todo (issue #228, caller surface)", () => {
  /** A long plan: 3 steps across 2 phases, step 1 completed, step 2 in progress. */
  const LONG_PLAN: TodoPhase[] = [
    {
      name: "Research",
      tasks: [
        { content: "Read the repo", status: "completed" },
        { content: "Draft the section", status: "in_progress" },
      ],
    },
    { name: "Land", tasks: [{ content: "Push + PR", status: "pending" }] },
  ];

  test("a live todo_phases push from the session renders the in-place plan message and edits it as steps complete", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    await Promise.resolve(); // the receipt phrase post settles (ts-1)

    // The driver's push: the todo tool's tool_execution_end snapshot.
    session.emit("todo_phases", { spaceId: "slack:C1", phases: LONG_PLAN });
    await Promise.resolve();

    expect(posts).toEqual([
      { spaceId: "slack:C1", text: "Thinking…", opts: { threadTs: "1.1" } },
      {
        spaceId: "slack:C1",
        text: "🛠 Agent's plan:\n  ✅ 1. Read the repo\n  ⏳ 2. Draft the section\n  ⏳ 3. Push + PR",
        opts: { threadTs: "1.1" },
      },
    ]);

    // Step 2 completes: the SAME plan message is edited in place.
    session.emit("todo_phases", {
      spaceId: "slack:C1",
      phases: [
        {
          name: "Research",
          tasks: [
            { content: "Read the repo", status: "completed" },
            { content: "Draft the section", status: "completed" },
          ],
        },
        { name: "Land", tasks: [{ content: "Push + PR", status: "in_progress" }] },
      ],
    });
    await Promise.resolve();
    expect(posts).toHaveLength(2); // never a second plan message
    expect(updates).toContainEqual({
      spaceId: "slack:C1",
      ts: "ts-2",
      text: "🛠 Agent's plan:\n  ✅ 1. Read the repo\n  ✅ 2. Draft the section\n  ⏳ 3. Push + PR",
    });

    await service.stop();
  });

  test("getTodoPhases pulls the live session's plan; no session → an empty plan (normal, not an error)", async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

    // No live session yet: empty plan.
    expect(service.getTodoPhases("slack:C1")).toEqual([]);

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last();
    session.todoPhases = LONG_PLAN;

    // The list_todos wiring reads exactly this (the driver's pull seam).
    expect(service.getTodoPhases("slack:C1")).toBe(LONG_PLAN);

    // A disposed session's plan is gone with it — the next cold start
    // rehydrates from the transcript (the SDK's getTodoPhases).
    await service.stop();
    expect(service.getTodoPhases("slack:C1")).toEqual([]);
  });
});

/**
 * Test-domain model of the active-turn Stop control block (issue #315): a
 * Block Kit section carrying a danger-button accessory whose `action_id`
 * is the turn-abort control. Validated at the adapter boundary with a zod
 * schema so the test asserts the proven wire shape instead of hand-walking
 * an unparsed representation.
 */
const stopControlBlockSchema = z.object({
  type: z.literal("section"),
  accessory: z.object({
    action_id: z.string(),
    value: z.string(),
    style: z.string(),
  }),
});
type StopControlBlock = z.infer<typeof stopControlBlockSchema>;

/**
 * Decodes every stop-control block among a post's outbound blocks, parsing
 * the unparsed `unknown[]` the fake adapter hands back at its boundary.
 */
function stopControlBlocksOf(p: { opts?: { blocks?: unknown[] } }): StopControlBlock[] {
  const blocks = p.opts?.blocks ?? [];
  return blocks.flatMap((b) => {
    const parsed = stopControlBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data] : [];
  });
}

describe("SpaceService stopTurn (issue #315, caller-level)", () => {
  /**
   * The active-turn Stop control's onAction closure — the EXACT routing the
   * index boot uses for a `bottega_stop` action (issue #315): delivery and
   * scheduler action ids have their own durable resolvers elsewhere in the
   * boot, and every OTHER non-stop action id is not expected here, so the
   * router forwards only what this suite drives. The closure is exercised
   * by the routing tests below; `stopTurn` is the service-level caller
   * surface it invokes.
   */
  function stopRouter(spaceService: SpaceService, rejectNonStop = false) {
    return (a: SlackAction): void => {
      if (a.actionId === STOP_ACTION_ID) {
        void spaceService.stopTurn(a.spaceId, a.principal);
        return;
      }
      if (rejectNonStop) throw new Error(`unexpected non-stop action: ${a.actionId}`);
    };
  }

  /**
   * Opens a live turn (fire-and-forget) and returns the created FakeSession,
   * flushing microtasks until the async cold start lands so tests never race
   * `driver.last()`. The returned `turnDone` settles when the turn's prompt
   * settles (a Stop's abort force-settles it).
   */
  async function openLiveTurn(
    service: SpaceService,
    driver: FakeDriver,
  ): Promise<{ turnDone: Promise<void>; session: FakeSession }> {
    const turnDone = service.handleInboundMessage(msg({ ts: "1.1" }));
    for (let i = 0; i < 20 && driver.created.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { turnDone, session: driver.last() };
  }

  test("a Stop action routed exactly once aborts an in-flight turn and settles it as stopped (audited)", async () => {
    const { adapter } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, stopControl: true });
    // A live session whose opening prompt is parked mid-run (in flight).
    const { turnDone, session } = await openLiveTurn(service, driver);
    session.streaming = true; // the SDK reports the run is streaming
    session.deferPrompt = true; // the opening prompt is parked (a real run awaiting the model)
    session.forceSettleOnAbort = true; // abort force-settles the parked run like the SDK
    await new Promise<void>((resolve) => setImmediate(resolve)); // receipt + phrase settle; the prompt is parked

    const router = stopRouter(service, true);
    router({ actionId: STOP_ACTION_ID, value: "slack:C1", spaceId: "slack:C1", principal: "U-stop", messageTs: "1.1" });
    // The abort is fire-and-forget from the router; flush it.
    await turnDone;

    // The turn aborted EXACTLY once and settled (the parked prompt resolved).
    expect(session.abortCalls).toBe(1);
    expect(session.streaming).toBe(false);
    await expect(turnDone).resolves.toBeUndefined();

    // The Stop was audited with the clicker and the stopped outcome.
    const stopAudits = audit.filter((a) => a.event_type === TURN_STOP_EVENT);
    expect(stopAudits).toHaveLength(1);
    expect(stopAudits[0]).toMatchObject({ space_id: "slack:C1", actor: "U-stop" });
    expect(JSON.parse(stopAudits[0]!.payload)).toEqual({ by: "U-stop", stopped: true });

    await service.stop();
  });

  test("a second Stop does not double-settle: idempotent once the turn is no longer in flight", async () => {
    const { adapter } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, stopControl: true });
    const { turnDone, session } = await openLiveTurn(service, driver);
    session.streaming = true;
    session.deferPrompt = true;
    session.forceSettleOnAbort = true;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const router = stopRouter(service, true);
    const action = { actionId: STOP_ACTION_ID, value: "slack:C1", spaceId: "slack:C1", principal: "U-stop", messageTs: "1.1" };
    router(action);
    await turnDone; // first Stop settles the turn
    expect(session.abortCalls).toBe(1);

    // Second Stop: the turn is no longer streaming → no-op, no double abort.
    router(action);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.abortCalls).toBe(1);

    // Both Stops audited: the first stopped, the second was a no-op.
    const stopAudits = audit.filter((a) => a.event_type === TURN_STOP_EVENT);
    expect(stopAudits).toHaveLength(2);
    expect(stopAudits.map((a) => JSON.parse(a.payload))).toEqual([
      { by: "U-stop", stopped: true },
      { by: "U-stop", stopped: false },
    ]);

    await service.stop();
  });

  test("a Stop for a non-live space is rejected: no abort, audited as stopped=false", async () => {
    const { adapter } = fakeAdapter();
    const { store, audit } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, stopControl: true });

    // No live session at all (never created) → Stop is a rejected no-op.
    const router = stopRouter(service, true);
    router({ actionId: STOP_ACTION_ID, value: "slack:C999", spaceId: "slack:C999", principal: "U-evil", messageTs: "9.9" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(driver.created).toHaveLength(0); // nobody aborted or cold-started
    const stopAudits = audit.filter((a) => a.event_type === TURN_STOP_EVENT);
    expect(stopAudits).toHaveLength(1);
    expect(stopAudits[0]).toMatchObject({ space_id: "slack:C999", actor: "U-evil" });
    expect(JSON.parse(stopAudits[0]!.payload)).toEqual({ by: "U-evil", stopped: false });
  });

  test("an in-flight Stop renders the stop control until the turn settles", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver, stopControl: true });

    await service.handleInboundMessage(msg({ ts: "1.1" }));
    const session = driver.last()!;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // A live turn: turn_start mounts the Stop control; turn_end clears it.
    session.emit("turn_start", { spaceId: "slack:C1" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    session.emit("turn_end", { spaceId: "slack:C1" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The control was mounted (a block post carrying the Stop button) and
    // cleared (an update to empty blocks on the control's own ts).
    const controlPosts = posts.filter((p) => stopControlBlocksOf(p).length > 0);
    expect(controlPosts).toHaveLength(1);
    const accessory = stopControlBlocksOf(controlPosts[0]!)[0]?.accessory;
    expect(accessory).toMatchObject({ action_id: STOP_ACTION_ID, value: "slack:C1", style: "danger" });
    expect(updates.some((u) => u.opts?.blocks && u.opts.blocks.length === 0)).toBe(true);

    await service.stop();
  });
});
