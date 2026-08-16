import type { AgentDriver, AgentSessionDriver } from "../drivers/agent-driver";
import { DIGEST_FAILED_EVENT, MESSAGE_DROPPED_EVENT } from "../../store/audit-events";
import type { Store } from "../../store/db";
import type { MemoryProvider } from "../../memory/types";
import type { ResponseMode } from "../../policy/config";
import { channelFromSpaceId, isDmChannel, type SlackAdapter, type SlackMessage } from "../adapters/slack";

/** Digests kept per space; older ones are still in the transcript (issue #42). */
export const DIGEST_CAP = 20;
/** Bound on the digest summarization turn (issue #42). */
export const DEFAULT_DIGEST_TIMEOUT_MS = 60_000;

export interface SpaceServiceDeps {
  store: Store;
  adapter: SlackAdapter;
  /** Session factory seam. */
  driver: AgentDriver;
  /** Idle timeout before a space's live session is disposed. Default 30 min. */
  idleTimeoutMs?: number;
  /** Directory for file-backed space transcripts. Default data/sessions. */
  transcriptDir?: string;
  /**
   * Memory provider: enables digest-on-idle (issue #42). Without it, dispose
   * never digests. Digests are saved directly (org scope, kind=digest) and
   * the newest digest's `until` doubles as the next run's marker.
   */
  memoryProvider?: MemoryProvider;
  /**
   * Digest cap hook: prune digest memories for the space beyond `keep`
   * (defaults to nothing — the SQLite wiring supplies the real cap).
   */
  digestPrune?: (spaceId: string, keep: number) => Promise<void> | void;
  /** Bound for the digest summary turn. Default 60s. */
  digestTimeoutMs?: number;
  /**
   * Per-space response mode (issue #55); defaults to `always`. Request-only
   * spaces append {@link REQUEST_ONLY_DIRECTIVE} to the session prompt; the
   * evaluation happens at session creation, so a mode change applies on the
   * next cold start (sessions are disposed after the idle timeout).
   */
  responseModeFor?: (spaceId: string) => ResponseMode | Promise<ResponseMode>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TRANSCRIPT_DIR = "data/sessions";

/**
 * System-prompt directive for `request-only` spaces (issue #55): the adapter
 * forwards everything so context stays coherent, so the agent itself must
 * decide when to act — explicit requests get work, chatter gets silence.
 */
export const REQUEST_ONLY_DIRECTIVE =
  "Act only on explicit requests; stay silent on chatter — reply briefly or not at all.";

/**
 * Rotating status phrases posted on turn_start and replaced in place by the
 * real reply (or error text) when the turn completes (issue #40). Since #60,
 * turn_start is retry-safe: while a phrase is pending for the space, the next
 * rotating phrase UPDATES it in place instead of posting a second message, so
 * an OMP auto-retry loop never stacks phrases. A turn that ends with neither
 * message nor error leaves the phrase as-is.
 */
const THINKING_PHRASES = [
  "Thinking…",
  "On it — thinking…",
  "Give me a second…",
  "Working on it…",
  "Let me think…",
];

/**
 * Consecutive empty completions that trip the churn guard (issue #60): beyond
 * this many, one visible churn message replaces the phrase and phrases stay
 * off until a non-empty turn. Root cause: reasoning-only output (content
 * empty when the token budget is consumed by reasoning) or a stale gateway
 * route — either way OMP auto-retries and every retry re-fires turn_start.
 */
export const EMPTY_TURN_LIMIT = 3;

/** Shown on a `message` event whose text is empty/whitespace (issue #60). */
export const EMPTY_RESPONSE_FALLBACK = "Hmm — I got an empty response, retrying…";

/** Surfaced once after {@link EMPTY_TURN_LIMIT} consecutive empty turns (issue #60). */
export const CHURN_MESSAGE = "I keep getting empty responses — check the model key?";

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
  readonly #memoryProvider: MemoryProvider | undefined;
  readonly #digestPrune: ((spaceId: string, keep: number) => Promise<void> | void) | undefined;
  readonly #digestTimeoutMs: number;
  readonly #responseModeFor: (spaceId: string) => ResponseMode | Promise<ResponseMode>;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #creating = new Map<string, Promise<LiveSession>>();
  /** ts of the latest inbound message per space; agent replies thread under it. */
  readonly #lastInboundTs = new Map<string, string>();
  /** Principal of the latest inbound message per space (memory injection, #42). */
  readonly #lastPrincipal = new Map<string, string>();
  /**
   * ts of the in-place thinking phrase per space; consumed when the reply lands.
   * NOTE: the ts is only known after postMessage resolves — the posting guard
   * below covers the in-flight window so a second phrase can never be posted.
   */
  readonly #pendingThinkingTs = new Map<string, string>();
  /**
   * Spaces whose phrase postMessage is still in flight (ts not yet known).
   * A turn_start during this window skips posting — the in-flight post
   * becomes the space's one phrase (issue #60: stacking is impossible).
   */
  readonly #phrasePosting = new Set<string>();
  /**
   * Consecutive empty completions per space (churn guard, #60). Reset by any
   * non-empty message or error; a new inbound message does not reset it, so
   * phrases stay off until a turn actually produces text.
   */
  readonly #emptyTurnCount = new Map<string, number>();
  /** Spaces whose churn message is already surfaced; phrases stay off (#60). */
  readonly #churnActive = new Set<string>();
  /** Spaces whose current turn already delivered a message or an error (#60). */
  readonly #turnDelivered = new Set<string>();
  /** Spaces mid-digest turn: their output must not reach the channel (#42). */
  readonly #digesting = new Set<string>();
  /** Rotates THINKING_PHRASES one step per turn. */
  #phraseIndex = 0;

  constructor(deps: SpaceServiceDeps) {
    this.#store = deps.store;
    this.#adapter = deps.adapter;
    this.#driver = deps.driver;
    this.#idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#transcriptDir = deps.transcriptDir ?? DEFAULT_TRANSCRIPT_DIR;
    this.#memoryProvider = deps.memoryProvider;
    this.#digestPrune = deps.digestPrune;
    this.#digestTimeoutMs = deps.digestTimeoutMs ?? DEFAULT_DIGEST_TIMEOUT_MS;
    this.#responseModeFor = deps.responseModeFor ?? (() => "always");
  }

  async handleInboundMessage(msg: SlackMessage): Promise<void> {
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
      this.#lastPrincipal.set(msg.spaceId, msg.principal);
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
    const mode = await this.#responseModeFor(spaceId);
    const appendSystemPrompt = mode === "request-only" ? REQUEST_ONLY_DIRECTIVE : undefined;
    const session = await this.#driver.createSession({
      spaceId,
      transcriptDir: this.#transcriptDir,
      appendSystemPrompt,
      // Output arrives on the session's event channel below. onOutput is the
      // same signal (both drivers emit both), so it must stay unconsumed or
      // every reply would be posted twice.
      onOutput: () => {},
      // Memory-context injection seam (#42): re-read the space's current
      // principal on every LLM call so user-scope search stays fresh.
      getPrincipal: () => this.#lastPrincipal.get(spaceId),
    });
    session.on("turn_start", () => this.#onTurnStart(spaceId));
    session.on("message", (data) => this.#onSessionMessage(spaceId, data));
    session.on("error", (data) => this.#onSessionError(spaceId, data));
    session.on("turn_end", (data) => this.#onTurnEnd(spaceId, data));
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
    // Digest-on-idle (#42): summarize the conversation into org memory
    // before the session is gone. Fail-soft — never blocks disposal
    // (#maybeDigestOnIdle audits its own failures).
    await this.#maybeDigestOnIdle(live);
    try {
      await live.session.dispose();
    } catch (err) {
      console.error(`[space-service] dispose failed for ${spaceId}:`, err);
    } finally {
      // Session-scoped inbound state: no event can fire after dispose
      // resolves (both drivers unsubscribe/kill), and the next inbound
      // re-sets both maps.
      this.#lastInboundTs.delete(spaceId);
      this.#lastPrincipal.delete(spaceId);
      this.#pendingThinkingTs.delete(spaceId);
      this.#phrasePosting.delete(spaceId);
      this.#emptyTurnCount.delete(spaceId);
      this.#churnActive.delete(spaceId);
      this.#turnDelivered.delete(spaceId);
      this.#sessions.delete(spaceId);
    }
  }

  /**
   * Turn started: post a rotating thinking phrase immediately so the space
   * shows activity, and remember its ts to replace in place when the reply
   * (or an error) lands. Retry-safe (#60): OMP auto-retries empty completions
   * and each attempt fires turn_start, so a pending phrase is UPDATED with
   * the next rotating phrase instead of stacking a second message — one
   * message max per space at any time. A turn_start while a phrase post is
   * still in flight (ts unknown yet) skips posting entirely. Digest turns
   * are invisible to the channel (their output is memory, #42). After the
   * churn guard has fired (#60), phrases stay off until a turn produces
   * text or an error — no new posts, not just no updates.
   */
  #onTurnStart(spaceId: string): void {
    if (this.#digesting.has(spaceId)) return;
    this.#turnDelivered.delete(spaceId);
    if (this.#churnActive.has(spaceId)) return;
    const pendingTs = this.#pendingThinkingTs.get(spaceId);
    if (pendingTs !== undefined) {
      // A retry (or second turn) while the phrase is up: replace in place.
      void this.#adapter.updateMessage(spaceId, pendingTs, this.#nextPhrase()).catch((err) => {
        console.error(`[space-service] failed to update thinking phrase in ${spaceId}:`, err);
      });
      return;
    }
    if (this.#phrasePosting.has(spaceId)) return; // in flight — it becomes the phrase
    this.#phrasePosting.add(spaceId);
    void this.#adapter
      .postMessage(spaceId, this.#nextPhrase(), this.#replyOpts(spaceId))
      .then((ts) => {
        if (ts !== undefined) this.#pendingThinkingTs.set(spaceId, ts);
      })
      .catch((err) => {
        console.error(`[space-service] failed to post thinking phrase to ${spaceId}:`, err);
      })
      .finally(() => {
        this.#phrasePosting.delete(spaceId);
      });
  }

  /** Next rotating phrase; advances the shared rotation index. */
  #nextPhrase(): string {
    const phrase = THINKING_PHRASES[this.#phraseIndex % THINKING_PHRASES.length];
    this.#phraseIndex += 1;
    return phrase;
  }

  /** Complete reply text: replace the thinking phrase in place (or post fresh). */
  #onSessionMessage(spaceId: string, data: unknown): void {
    if (this.#digesting.has(spaceId)) return;
    const text = (data as { text?: unknown }).text;
    if (typeof text !== "string") return;
    this.#turnDelivered.add(spaceId);
    if (!text.trim()) {
      // Empty completion (#60): replace the phrase with a visible fallback so
      // the retry loop is never silent, and count it for the churn guard. The
      // pending ts is deliberately kept: a retry's turn_start then replaces
      // the phrase in place instead of stacking a new message.
      this.#countEmptyTurn(spaceId);
      if (!this.#churnActive.has(spaceId)) {
        const pendingTs = this.#pendingThinkingTs.get(spaceId);
        if (pendingTs !== undefined) {
          void this.#adapter.updateMessage(spaceId, pendingTs, EMPTY_RESPONSE_FALLBACK).catch((err) => {
            console.error(`[space-service] failed to update empty-response phrase in ${spaceId}:`, err);
          });
        }
      }
      return;
    }
    // Real text: the empty streak is over, phrases re-arm.
    this.#emptyTurnCount.delete(spaceId);
    this.#churnActive.delete(spaceId);
    this.#replaceOrPost(spaceId, text);
  }

  /** Session error: surface it by replacing the thinking phrase in place. */
  #onSessionError(spaceId: string, data: unknown): void {
    console.error(`[space-service] session error (${spaceId}):`, data);
    if (this.#digesting.has(spaceId)) return;
    this.#turnDelivered.add(spaceId);
    // An error is a visible outcome: it breaks the empty streak and re-arms phrases.
    this.#emptyTurnCount.delete(spaceId);
    this.#churnActive.delete(spaceId);
    const message = (data as { message?: unknown }).message;
    this.#replaceOrPost(spaceId, typeof message === "string" ? message : "Something went wrong while thinking.");
  }

  /**
   * Turn ended without a delivered message or error (#60): an empty
   * completion. Both drivers filter empty text before the "message" event
   * (`if (text) deliver`), so the retry loop arrives here as silent
   * turn_start/turn_end pairs — this is what must trip the churn guard.
   */
  #onTurnEnd(spaceId: string, _data: unknown): void {
    if (this.#digesting.has(spaceId)) return;
    if (this.#turnDelivered.has(spaceId)) return;
    this.#countEmptyTurn(spaceId);
  }

  /**
   * Counts one empty completion for the space; beyond {@link EMPTY_TURN_LIMIT}
   * consecutive empties, surfaces {@link CHURN_MESSAGE} exactly once (in place
   * of the pending phrase, or fresh) and silences phrases until a non-empty
   * turn — fail visible, not silent (#60).
   */
  #countEmptyTurn(spaceId: string): void {
    const count = (this.#emptyTurnCount.get(spaceId) ?? 0) + 1;
    this.#emptyTurnCount.set(spaceId, count);
    if (count <= EMPTY_TURN_LIMIT || this.#churnActive.has(spaceId)) return;
    this.#churnActive.add(spaceId);
    this.#replaceOrPost(spaceId, CHURN_MESSAGE);
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

  /**
   * Digest-on-idle (issue #42): when the space has inbound messages newer
   * than the newest digest's `until` marker, run a bounded silent summary
   * turn on the live session, save it as an org-scope digest memory, and
   * prune to the cap. Any failure audits `digest.failed` and returns — the
   * caller always disposes. No new messages → no digest.
   */
  async #maybeDigestOnIdle(live: LiveSession): Promise<void> {
    const provider = this.#memoryProvider;
    if (!provider) return;
    const spaceId = live.spaceId;
    try {
      // Not idle: a turn is in flight. Digests run on idle only — steering a
      // digest into a live turn would hijack it (and the messages are still
      // in the transcript, so the next idle digest covers them).
      if (live.session.isStreaming()) return;
      const marker = await this.#newestDigestUntil(provider, spaceId);
      const lastTs = this.#lastInboundTs.get(spaceId);
      if (!lastTs || (marker !== null && Number(lastTs) <= Number(marker))) return;
      const summary = await this.#runDigestTurn(live, marker);
      if (!summary) {
        await this.#auditDigestFailure(spaceId, "empty summary");
        return;
      }
      await provider.save({
        scope: "org",
        content: summary,
        metadata: { kind: "digest", space: spaceId, since: marker ?? "", until: lastTs },
      });
      await this.#digestPrune?.(spaceId, DIGEST_CAP);
    } catch (err) {
      await this.#auditDigestFailure(spaceId, err instanceof Error ? err.message : String(err));
    }
  }

  /** The `until` of the newest digest for the space — the next run's marker. */
  async #newestDigestUntil(provider: MemoryProvider, spaceId: string): Promise<string | null> {
    const [newest] = await provider.search({
      query: "",
      scope: "org",
      metadata: { kind: "digest", space: spaceId },
      limit: 1,
    });
    return newest ? (newest.metadata.until ?? null) : null;
  }

  /**
   * One bounded silent summary turn; returns the captured digest text. The
   * space is marked as digesting so turn_start/message/error handlers skip
   * the channel — the digest is memory, not a reply (#42).
   */
  async #runDigestTurn(live: LiveSession, marker: string | null): Promise<string> {
    const spaceId = live.spaceId;
    this.#digesting.add(spaceId);
    let captured = "";
    const offMessage = live.session.on("message", (data) => {
      const text = (data as { text?: unknown } | null)?.text;
      if (typeof text === "string" && text.trim()) captured = text;
    });
    try {
      const instruction = marker
        ? `Summarize the messages in this conversation since ${marker} as a compact bulleted digest. Reply with only the digest text, no preamble.`
        : "Summarize this conversation so far as a compact bulleted digest. Reply with only the digest text, no preamble.";
      await withTimeout(live.session.prompt(instruction, { silent: true }), this.#digestTimeoutMs);
    } finally {
      offMessage();
      this.#digesting.delete(spaceId);
    }
    return captured.trim();
  }

  async #auditDigestFailure(spaceId: string, reason: string): Promise<void> {
    try {
      await this.#store.appendAudit({
        space_id: spaceId,
        actor: "system",
        event_type: DIGEST_FAILED_EVENT,
        payload: JSON.stringify({ reason }),
      });
    } catch (err) {
      console.error(`[space-service] digest.failed audit write failed for ${spaceId}:`, err);
    }
  }
}

/** Rejects with a timeout error after `ms`; the underlying promise keeps running. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`digest turn timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
