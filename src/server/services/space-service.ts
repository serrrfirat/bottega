import { createOmpSdkDriver, type AgentDriver, type AgentSessionDriver } from "../drivers/agent-driver";
import { MESSAGE_DROPPED_EVENT } from "../../store/audit-events";
import type { Store } from "../../store/db";
import { channelFromSpaceId, isDmChannel, type SlackAdapter } from "../adapters/slack";

export interface InboundMessage {
  spaceId: string;
  principal: string;
  text: string;
  ts: string;
}

export interface SpaceServiceDeps {
  store: Store;
  adapter: SlackAdapter;
  /** Session factory seam; defaults to the OMP SDK driver. */
  driver?: AgentDriver;
  /** Idle timeout before a space's live session is disposed. Default 30 min. */
  idleTimeoutMs?: number;
  /** Directory for file-backed space transcripts. Default data/sessions. */
  transcriptDir?: string;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TRANSCRIPT_DIR = "data/sessions";

/**
 * Rotating status phrases posted on turn_start and replaced in place by the
 * real reply (or error text) when the turn completes (issue #40). A turn
 * that ends with neither message nor error leaves the phrase as-is.
 */
const THINKING_PHRASES = [
  "Thinking…",
  "On it — thinking…",
  "Give me a second…",
  "Working on it…",
  "Let me think…",
];

interface LiveSession {
  spaceId: string;
  session: AgentSessionDriver;
  idleTimer: ReturnType<typeof setTimeout>;
  disposing: boolean;
}

/**
 * One long-lived agent session per active space. Sessions are created lazily
 * on the first message, disposed after an idle timeout (cache eviction only —
 * transcripts are file-backed and never deleted), and cold-started from the
 * space's transcript file on the next message.
 */
export class SpaceService {
  readonly #store: Store;
  readonly #adapter: SlackAdapter;
  readonly #driver: AgentDriver;
  readonly #idleTimeoutMs: number;
  readonly #transcriptDir: string;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #creating = new Map<string, Promise<LiveSession>>();
  /** ts of the latest inbound message per space; agent replies thread under it. */
  readonly #lastInboundTs = new Map<string, string>();
  /** ts of the in-place thinking phrase per space; consumed when the reply lands. */
  readonly #pendingThinkingTs = new Map<string, string>();
  /** Rotates THINKING_PHRASES one step per turn. */
  #phraseIndex = 0;

  constructor(deps: SpaceServiceDeps) {
    this.#store = deps.store;
    this.#adapter = deps.adapter;
    this.#driver = deps.driver ?? createOmpSdkDriver();
    this.#idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#transcriptDir = deps.transcriptDir ?? DEFAULT_TRANSCRIPT_DIR;
  }

  async handleInboundMessage(msg: InboundMessage): Promise<void> {
    try {
      const live = await this.#sessionFor(msg.spaceId);
      if (!live) {
        // Session is mid-dispose: drop the message and audit the drop.
        await this.#store.appendAudit({
          space_id: msg.spaceId,
          actor: msg.principal,
          event_type: MESSAGE_DROPPED_EVENT,
          payload: JSON.stringify({ reason: "session_disposing", ts: msg.ts }),
        });
        return;
      }
      this.#lastInboundTs.set(msg.spaceId, msg.ts);
      if (live.session.isStreaming()) {
        await live.session.prompt(msg.text, { streamingBehavior: "steer" });
      } else {
        await live.session.prompt(msg.text);
      }
    } catch (err) {
      console.error(`[space-service] failed to handle message in ${msg.spaceId}:`, err);
    }
  }

  async stop(): Promise<void> {
    const live = [...this.#sessions.values()];
    await Promise.all(live.map((entry) => this.#disposeSession(entry.spaceId)));
  }

  /** Returns null when the space's session is mid-dispose (message must be dropped). */
  #sessionFor(spaceId: string): Promise<LiveSession | null> {
    const existing = this.#sessions.get(spaceId);
    if (existing) return Promise.resolve(existing.disposing ? null : existing);
    const inFlight = this.#creating.get(spaceId);
    if (inFlight) return inFlight;
    const created = this.#createLive(spaceId);
    this.#creating.set(spaceId, created);
    void created.then(
      () => this.#creating.delete(spaceId),
      () => this.#creating.delete(spaceId),
    );
    return created;
  }

  async #createLive(spaceId: string): Promise<LiveSession> {
    const session = await this.#driver.createSession({
      spaceId,
      transcriptDir: this.#transcriptDir,
      // Output arrives on the session's event channel below. onOutput is the
      // same signal (both drivers emit both), so it must stay unconsumed or
      // every reply would be posted twice.
      onOutput: () => {},
    });
    session.on("turn_start", (data) => this.#onTurnStart(spaceId, data));
    session.on("message", (data) => this.#onSessionMessage(spaceId, data));
    session.on("error", (data) => this.#onSessionError(spaceId, data));
    const live: LiveSession = {
      spaceId,
      session,
      disposing: false,
      idleTimer: setTimeout(() => void this.#disposeSession(spaceId), this.#idleTimeoutMs),
    };
    // Unref so a long-lived idle timer never keeps the process (or test run) alive.
    live.idleTimer.unref?.();
    this.#sessions.set(spaceId, live);
    return live;
  }

  async #disposeSession(spaceId: string): Promise<void> {
    const live = this.#sessions.get(spaceId);
    if (!live || live.disposing) return;
    live.disposing = true;
    clearTimeout(live.idleTimer);
    try {
      await live.session.dispose();
    } catch (err) {
      console.error(`[space-service] dispose failed for ${spaceId}:`, err);
    } finally {
      this.#pendingThinkingTs.delete(spaceId);
      this.#sessions.delete(spaceId);
    }
  }

  /**
   * Turn started: post a rotating thinking phrase immediately so the space
   * shows activity, and remember its ts to replace in place when the reply
   * (or an error) lands. A turn that ends with neither leaves the phrase.
   */
  #onTurnStart(spaceId: string, _data: unknown): void {
    const phrase = THINKING_PHRASES[this.#phraseIndex % THINKING_PHRASES.length];
    this.#phraseIndex += 1;
    void this.#adapter
      .postMessage(spaceId, phrase, this.#replyOpts(spaceId))
      .then((ts) => {
        if (ts !== undefined) this.#pendingThinkingTs.set(spaceId, ts);
      })
      .catch((err) => {
        console.error(`[space-service] failed to post thinking phrase to ${spaceId}:`, err);
      });
  }

  /** Complete reply text: replace the thinking phrase in place (or post fresh). */
  #onSessionMessage(spaceId: string, data: unknown): void {
    const text = (data as { text?: unknown }).text;
    if (typeof text !== "string") return;
    this.#replaceOrPost(spaceId, text);
  }

  /** Session error: surface it by replacing the thinking phrase in place. */
  #onSessionError(spaceId: string, data: unknown): void {
    console.error(`[space-service] session error (${spaceId}):`, data);
    const message = (data as { message?: unknown }).message;
    this.#replaceOrPost(spaceId, typeof message === "string" ? message : "Something went wrong while thinking.");
  }

  /**
   * Replaces the pending thinking phrase in place when one exists; otherwise
   * posts fresh (edge: the reply landed before the phrase ts was captured).
   * The pending ts is cleared either way so a reply updates exactly once.
   */
  #replaceOrPost(spaceId: string, text: string): void {
    const pendingTs = this.#pendingThinkingTs.get(spaceId);
    if (pendingTs !== undefined) {
      this.#pendingThinkingTs.delete(spaceId);
      void this.#adapter.updateMessage(spaceId, pendingTs, text).catch((err) => {
        console.error(`[space-service] failed to update reply in ${spaceId}:`, err);
      });
      return;
    }
    void this.#adapter.postMessage(spaceId, text, this.#replyOpts(spaceId)).catch((err) => {
      console.error(`[space-service] failed to post reply to ${spaceId}:`, err);
    });
  }

  /**
   * DMs read naturally as a plain message — no thread. Team channels (C/G)
   * keep replies threaded under the latest inbound message.
   */
  #replyOpts(spaceId: string): { threadTs?: string } | undefined {
    if (isDmChannel(channelFromSpaceId(spaceId))) return undefined;
    const threadTs = this.#lastInboundTs.get(spaceId);
    return threadTs === undefined ? undefined : { threadTs };
  }
}
