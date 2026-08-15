import { createOmpSdkDriver, type AgentDriver, type AgentSessionDriver } from "../drivers/agent-driver";
import { MESSAGE_DROPPED_EVENT } from "../../store/audit-events";
import type { Store } from "../../store/db";
import type { SlackAdapter } from "../adapters/slack";

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
      onOutput: (sid, text) => this.#postOutput(sid, text),
    });
    session.on("error", (data) => console.error(`[space-service] session error (${spaceId}):`, data));
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
      this.#sessions.delete(spaceId);
    }
  }

  #postOutput(spaceId: string, text: string): void {
    this.#adapter.postMessage(spaceId, text, { threadTs: this.#lastInboundTs.get(spaceId) }).catch((err) => {
      console.error(`[space-service] failed to post reply to ${spaceId}:`, err);
    });
  }
}
