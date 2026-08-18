import { afterAll, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createStore, type Store, type ExtensionCredential } from "../../store/db";
import type { MemoryProvider, MemorySaveInput, MemorySearchQuery } from "../../memory/types";
import { sessionFilePath, SessionModelRoleRegistry, type AgentDriver, type AgentSessionDriver, type AgentTurnOptions } from "../drivers/agent-driver";
import { SpaceService, type SpaceServiceDeps, DIGEST_CAP, REQUEST_ONLY_DIRECTIVE, SLACK_FORMAT_DIRECTIVE, EMPTY_TURN_LIMIT, EMPTY_RESPONSE_FALLBACK, CHURN_MESSAGE, STREAM_UPDATE_INTERVAL_MS, emptyResponseFallback, churnMessageText, parseConnectIntent } from "./space-service";
import type { ResponseMode } from "../../policy/config";
import { defaultPolicy, parseOrgConfigYaml } from "../../policy/config";
import type { SlackAdapter, SlackMessage } from "../adapters/slack";
import type { ConnectExtensionDeps } from "../../extensions/connect";
import { createFixtureRegistry } from "../../extensions/fixture";
import { DenyRouter, type ApprovalRequest, type ApprovalResolution, type ApprovalRouter } from "../../policy/approval-router";
import { createAudit } from "../../policy/audit";
import { EXTENSION_CONNECTED_EVENT, POLICY_DECISION_EVENT, ADMIN_ONBOARDING_NUDGE_EVENT, MESSAGE_RECEIVED_EVENT, MESSAGE_REPLIED_EVENT, DIGEST_FAILED_EVENT, OBJECT_ATTACHED_EVENT } from "../../store/audit-events";
import type { WizardCheck } from "../../tools/admin";
import { buildAutoPickupDirective } from "../../tools/work-item-pickup";
import { objectToolDefinitions } from "../../tools/objects";
import { sha256Hex } from "../../tools/memory";

// ---------------------------------------------------------------------------
// Fakes: no real model, no network. The driver seam is what keeps these tests
// hermetic — SpaceService sees only AgentSessionDriver, never OMP.
// ---------------------------------------------------------------------------

/** Event payloads the fake session emits: message text, turn bounds, errors. */
type FakeSessionEventData =
  | { spaceId: string; text: string }
  | { spaceId: string }
  | { spaceId: string; message: string }
  | { spaceId: string; error: string };

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
  /** The principal of the current turn; mirrors the real drivers' binding (issue #152). */
  turnPrincipal: string | undefined;
  /** reapplyDefaultModelRole invocations (issue #189): the service must call the seam before each fresh turn. */
  reapplyCalls = 0;

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

  async abort(): Promise<void> {}

  isStreaming(): boolean {
    return this.streaming;
  }

  on(event: "message" | "turn_start" | "turn_end" | "error", cb: (data: FakeSessionEventData) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  emit(event: "message" | "turn_start" | "turn_end" | "error", data: FakeSessionEventData): void {
    // The turn's principal binding dies with the turn (issue #152) — the
    // next fresh turn rebinds from its own prompt's principal.
    if (event === "turn_end") this.turnPrincipal = undefined;
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

interface FakeDownloadedFile {
  name: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}

interface FakeStreamCall {
  spaceId: string;
  opts: { threadTs: string; openingText: string };
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
  const posts: Array<{ spaceId: string; text: string; opts?: { threadTs?: string } }> = [];
  const updates: Array<{ spaceId: string; ts: string; text: string }> = [];
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
    async updateMessage(spaceId, ts, text) {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        // Slack chat.update 429 shape: rate_limited with retry_after.
        throw new Error("rate_limited");
      }
      updates.push({ spaceId, ts, text });
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

    // A message into a streaming turn is a STEER — the seam must NOT run
    // again mid-turn (a use_model switch made during the turn would be
    // clobbered by a re-apply before it ever ran).
    session.streaming = true;
    await service.handleInboundMessage(msg({ text: "second", ts: "2.1" }));
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
    await service.handleInboundMessage(msg({ text: "second", ts: "2.2" }));

    const session = driver.last();
    expect(driver.created).toHaveLength(1); // same session reused
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toEqual({
      text: "second",
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

    // A's turn is in flight (mid-tool-call); user B messages → the message
    // STEERS the running turn, and the turn's binding must stay A's — B's
    // personal credential must never resolve for A's extension calls.
    session.streaming = true;
    await service.handleInboundMessage(msg({ principal: "UB", ts: "2.2" }));
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

  test("DM replies are plain messages (no thread); channel replies keep threading; phrases rotate", async () => {
    const { adapter, posts, updates } = fakeAdapter();
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });

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

    // Phrases post at receipt (issue #119) and rotate on turn_start; both
    // spaces hold exactly one message, replaced in place by each reply.
    expect(posts).toEqual([
      { spaceId: "slack:D1", text: "Thinking…", opts: undefined },
      { spaceId: "slack:C1", text: "Give me a second…", opts: { threadTs: "9.9" } },
    ]);
    expect(updates).toEqual([
      { spaceId: "slack:D1", ts: "ts-1", text: "On it — thinking…" },
      { spaceId: "slack:D1", ts: "ts-1", text: "dm answer" },
      { spaceId: "slack:C1", ts: "ts-2", text: "Working on it…" },
      { spaceId: "slack:C1", ts: "ts-2", text: "channel answer" },
    ]);
  });

  test("a DM with streaming support still takes the plain phrase path (no stream, no thread); a channel turn opens the thinking stream (issue #180)", async () => {
    const { adapter, posts, updates, streams, stops } = fakeAdapter({ streaming: true });
    const { store } = fakeStore();
    const driver = new FakeDriver();
    const service = makeSpaceService({ store, adapter, driver });
    try {
      await service.handleInboundMessage(msg({ spaceId: "slack:D1", ts: "1.1" }));
      const dm = driver.last();
      dm.emit("turn_start", { spaceId: "slack:D1" });
      await Promise.resolve();
      dm.emit("message", { spaceId: "slack:D1", text: "dm answer" });
      await Promise.resolve();
      dm.emit("turn_end", { spaceId: "slack:D1" });
      await Promise.resolve();

      await service.handleInboundMessage(msg({ spaceId: "slack:C1", ts: "9.9" }));
      const channel = driver.last();
      channel.emit("turn_start", { spaceId: "slack:C1" });
      await Promise.resolve();
      channel.emit("message", { spaceId: "slack:C1", text: "channel answer" });
      await Promise.resolve();
      channel.emit("turn_end", { spaceId: "slack:C1" });
      await Promise.resolve();
      await Promise.resolve();

      // DM: one plain message, phrase replaced in place — no stream call
      // and no thread_ts anywhere on the DM surface (issue #180).
      expect(streams.map((s) => s.spaceId)).toEqual(["slack:C1"]);
      expect(streams[0].opts.threadTs).toBe("9.9");
      expect(posts.filter((p) => p.spaceId === "slack:D1").every((p) => p.opts === undefined)).toBe(true);
      expect(updates).toContainEqual({ spaceId: "slack:D1", ts: "ts-1", text: "dm answer" });
      // Channel: the panel opened (threaded under the inbound ts) and
      // closed with the final reply as the stopStream block.
      expect(stops).toEqual([{ spaceId: "slack:C1", ts: "stream-1", text: "channel answer" }]);
    } finally {
      await service.stop();
    }
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
      await service.handleInboundMessage(msg({ text: "steer", ts: "2.2" }));
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
      await service.handleInboundMessage(msg({ text: "steer", ts: "2.2" }));
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

    // Steer message 2.2 into the running turn: the service marks the turn
    // streaming — the steer must post a FRESH phrase on the steer's own
    // line, threaded under the steer inbound (2.2) and NEWER than it.
    session.streaming = true;
    await service.handleInboundMessage(msg({ text: "steer", ts: "2.2" }));
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
    await service.handleInboundMessage(msg({ text: "second", ts: "2.2" }));
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
        scope: "org",
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
    const prunes: Array<{ spaceId: string; keep: number }> = [];
    const service = makeSpaceService({
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
      // SAFETY: the harness exercises only upsertExtensionCredential from
      // the store; the rest of the Store surface is unused by this path.
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
      } as ConnectExtensionDeps["store"],
      audit: {
        appendAudit: async (entry) => {
          audit.push(entry);
          return audit.length;
        },
        listAudit: async () => [],
      },
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
    const service = makeSpaceService({ store: h.store, adapter: h.adapter, driver: h.driver, connect: h.deps });

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
    const service = makeSpaceService({ store: h.store, adapter: h.adapter, driver: h.driver, connect: h.deps });

    await service.handleInboundMessage(msg({ text: "Connect fixture.weather", principal: "U2", ts: "3.3" }));

    expect(h.driver.created).toHaveLength(0);
    expect(h.posts[0]!.text).toBe("Fixture Weather connected as @U2");
    expect(h.rows[0]!.scope).toBe("personal");
    expect(h.rows[0]!.owner).toBe("U2");
  });

  test("connect <ext> as org crosses the gate; denied without approval", async () => {
    const h = makeConnectHarness({ router: DenyRouter });
    const service = makeSpaceService({ store: h.store, adapter: h.adapter, driver: h.driver, connect: h.deps });

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
    const service = makeSpaceService({ store: h.store, adapter: h.adapter, driver: h.driver, connect: h.deps });

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
    const service = makeSpaceService({ store: h.store, adapter: h.adapter, driver: h.driver, connect: h.deps });

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
      const service = makeSpaceService({ store, adapter, driver, connect: h.deps });
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
    const service = makeSpaceService({ store, adapter, driver });

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

    const nudged = updates.filter((u) => u.text.includes("first_run_wizard"));
    expect(nudged).toHaveLength(1);
    expect(nudged[0]!.text).toContain("broker_token");
    expect(nudged[0]!.text).toContain("git_pat");
    // 4 error updates total (each preceded by a phrase rotation): the first
    // carries the pointer, the rest are raw.
    expect(updates.filter((u) => u.text.startsWith("boom"))).toHaveLength(4);
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
    const nudged = updates.filter((u) => u.text.includes("first_run_wizard"));
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
    expect(updates.filter((u) => u.text.includes("first_run_wizard"))).toHaveLength(0);
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
    await service.handleInboundMessage(msg({ text: "steer", ts: "2.2" }));
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
