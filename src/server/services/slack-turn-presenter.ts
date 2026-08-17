/**
 * SlackTurnPresenter (issue #153 extraction, #168 streaming renderer).
 *
 * Turn rendering for one Slack space, extracted from SpaceService: the
 * thinking phrase, the 👀 receipt reaction, the streaming (steer) update
 * coalescing, the reply latency audit, the churn guard, and the threading
 * rule all live here. SpaceService keeps session/connect/learning/digest
 * lifecycle and delegates every channel-visible effect to the presenter.
 *
 * Two implementations:
 *
 *  - {@link SlackTurnPresenter} — the phrase + in-place-edit renderer
 *    (issues #40/#60/#119/#120, extracted verbatim). One thinking message
 *    per space, rotated on receipt/turn_start, replaced in place by the
 *    final reply; steered (streaming) turns coalesce edits to at most one
 *    per {@link STREAM_UPDATE_INTERVAL_MS} with a final-delivery guarantee.
 *  - {@link StreamTurnPresenter} — the Slack-native thinking-panel renderer
 *    (issue #168). The thinking phrase becomes the `chat.startStream`
 *    opening; every gated tool call renders a `task_update` thinking-step
 *    card (in_progress → complete / denied / waiting-for-approval); interim
 *    reply text appends as `markdown_text` chunks on the same coalescing
 *    cadence; `turn_end` calls `chat.stopStream` with the final reply as
 *    the closing block. CHANNELS only: DMs (slack:D*) always use the
 *    phrase renderer (issue #180), because the panel is a threaded reply.
 *    Falls back to the phrase renderer — permanently, per boot — the
 *    moment the workspace/app lacks the Agents feature or a stream call
 *    fails (feature-detect once, never per message; a failed stream never
 *    drops the reply).
 *
 * Step source (issue #168): every gated tool call — the driver's
 * `withPolicyGate` wrapper and the extension runtime — emits
 * {@link ToolStepEvent}s through a {@link ToolStepSink}; SpaceService
 * routes them to the space's presenter. Titles and outputs are composed
 * and redacted AT THE SOURCE (the same redaction the audit module applies)
 * so secret-shaped values never reach Slack.
 */
import type { Store } from "../../store/db";
import {
  ADMIN_ONBOARDING_NUDGE_EVENT,
  MESSAGE_RECEIVED_EVENT,
  MESSAGE_REPLIED_EVENT,
} from "../../store/audit-events";
import { redact } from "../../policy/audit";
import { onboardingGuideText, type WizardCheck } from "../../tools/admin";
import {
  channelFromSpaceId,
  isDmChannel,
  type SlackAdapter,
  type SlackMessage,
} from "../adapters/slack";

/**
 * Rotating status phrases posted on message receipt (issue #119) and updated
 * in place by the real reply (or error text) when the turn completes (issue
 * #40). Since #60, every posting path is retry-safe: while a phrase is
 * pending for the space, the next rotating phrase UPDATES it in place
 * instead of posting a second message, so an OMP auto-retry loop never
 * stacks phrases. A turn that ends with neither message nor error leaves the
 * phrase as-is. In streaming mode the phrase becomes the stream OPENING.
 * Exported (and re-exported by space-service) so e2e canary tests can
 * assert the in-place replacement.
 */
export const THINKING_PHRASES = [
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

/**
 * Streaming update cadence (issue #120, kept for #168's stream appends):
 * Slack rate-limits message updates (~50/min tier) and stream appends, so a
 * dense streamed turn coalesces its updates to at most one per 400ms —
 * smooth enough to read as streaming, while a 429 (fail-soft below) merely
 * skips an interim update instead of stalling the turn. The turn's FINAL
 * reply text is always delivered — flushed on turn_end with bounded retries
 * (phrase path) or carried by the stopStream closing block (stream path) —
 * while interim updates may be skipped. Batching applies ONLY to the
 * streaming (steer) path; non-streaming replies update exactly as before.
 * Hardcoded default (no org setting).
 */
export const STREAM_UPDATE_INTERVAL_MS = 400;

/**
 * Bounded retries for the FINAL delivery (issue #120): after this many
 * consecutive final-flush failures (e.g. a hard 429), the update is dropped
 * with a log rather than hammering Slack forever. Interim updates never
 * retry on their own — they wait for the turn-end flush.
 */
const STREAM_FINAL_RETRY_LIMIT = 3;

/** Shown on a `message` event whose text is empty/whitespace (issue #60). */
export const EMPTY_RESPONSE_FALLBACK = "Hmm — I got an empty response, retrying…";

/** Surfaced once after {@link EMPTY_TURN_LIMIT} consecutive empty turns (issue #60). */
export const CHURN_MESSAGE = "I keep getting empty responses — check the model key?";

/**
 * {@link EMPTY_RESPONSE_FALLBACK} carrying the real provider/session cause
 * (issue #78): when the empty completion is a swallowed provider error (e.g.
 * the replay-ordering 400), the fallback names the cause instead of guessing.
 * Fail closed: no cause → the exact legacy phrase.
 */
export function emptyResponseFallback(cause: string | undefined): string {
  return cause && cause.trim() ? `Hmm — I got an empty response: ${cause.trim()} — retrying…` : EMPTY_RESPONSE_FALLBACK;
}

/**
 * {@link CHURN_MESSAGE} carrying the real provider/session cause (issue #78):
 * the cause supersedes the "check the model key?" guess when one exists.
 * Fail closed: no cause → the exact legacy phrase.
 */
export function churnMessageText(cause: string | undefined): string {
  return cause && cause.trim() ? `I keep getting empty responses — ${cause.trim()}` : CHURN_MESSAGE;
}

// ---------------------------------------------------------------------------
// Step source vocabulary (issue #168): the driver gate and the extension
// runtime emit these; the presenter renders them. Titles/outputs are
// composed and redacted at the source — never raw args.
// ---------------------------------------------------------------------------

/** One gated tool call's thinking step. Start and its resolution share `taskId`. */
export interface ToolStepEvent {
  /** Space the call ran in; headless calls (no space) are dropped by the sink. */
  spaceId?: string;
  /** Stable id per gated call: the in_progress card and its complete card share it. */
  taskId: string;
  /** Rendered card title, composed + redacted at the source (e.g. "github.search_issues — allowed (read)"). */
  title: string;
  /** in_progress opens a card; complete checks it off (a deny resolves as complete). */
  status: "in_progress" | "complete";
  /** Redacted args summary (the card's code block); capped by the adapter. */
  output?: string;
}

/** The step-source → presenter bridge; must never throw into the turn path. */
export type ToolStepSink = (step: ToolStepEvent) => void;

let toolStepSeq = 0;

/** Process-scoped unique id for one gated tool call's thinking step (#168). */
export function nextToolStepId(): string {
  toolStepSeq += 1;
  return `step-${toolStepSeq}`;
}

/** Slack caps task_update chunk text at 256 chars; titles are sliced defensively. */
const STEP_TITLE_MAX = 256;

/**
 * Composes a thinking-step card title and applies the SAME redaction the
 * audit module applies to payloads (issue #168): secret-shaped values in
 * tool names/qualifiers render `[REDACTED]`, never raw.
 */
export function toolStepTitle(tool: string, qualifier: string): string {
  return redact(`${tool} — ${qualifier}`).slice(0, STEP_TITLE_MAX);
}

/** Fire-and-forget sink emission; a throwing sink is logged, never thrown. */
export function emitToolStep(sink: ToolStepSink | undefined, step: ToolStepEvent): void {
  if (sink === undefined) return;
  try {
    sink(step);
  } catch (err) {
    console.error("[tool-steps] step sink failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Presenter
// ---------------------------------------------------------------------------

export interface TurnPresenterDeps {
  spaceId: string;
  adapter: SlackAdapter;
  /** Audit sink for receipt/reply latency rows (issue #119) + nudge audit rows (#116). */
  store: Store;
  /** Onboarding-check seam (issue #116); defaults to runWizardChecks(store) at the service. */
  onboardingChecks: () => WizardCheck[];
  /**
   * Shared phrase rotation (issue #153): the pre-extraction SpaceService
   * advanced ONE rotation index per turn across ALL spaces, so multi-space
   * test journeys see a global sequence. SpaceService passes one shared
   * rotation to every presenter; direct constructions default to a fresh
   * per-presenter rotation.
   */
  phraseRotation?: { next(): string };
}

/**
 * The shared THINKING_PHRASES rotation. One instance per SpaceService (all
 * spaces share the sequence, matching the pre-#153 single-class counter);
 * the streaming presenter consumes it for each turn's stream opening.
 */
export function createPhraseRotation(): { next(): string } {
  let index = 0;
  return {
    next() {
      const phrase = THINKING_PHRASES[index % THINKING_PHRASES.length];
      index += 1;
      return phrase;
    },
  };
}

/** State of one coalesced streaming update (issue #120). */
interface PendingStreamUpdate {
  /** The pending thinking-phrase ts (or stream ts) the update rewrites. */
  ts: string;
  /** Latest streamed text; older text is dropped (coalescing). */
  text: string;
  /** The turn has ended: this text is the final reply and must land. */
  final: boolean;
  /** Failed final-delivery attempts; bounded so a hard 429 cannot loop forever. */
  retries: number;
  /** The cadence timer, or null when none is armed. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The phrase + in-place-edit turn renderer (issues #40/#60/#119/#120).
 * One long-lived instance per space; SpaceService creates it lazily on the
 * first inbound message and disposes it with the session.
 */
export class SlackTurnPresenter {
  protected readonly spaceId: string;
  protected readonly adapter: SlackAdapter;
  readonly #store: Store;
  readonly #onboardingChecks: () => WizardCheck[];

  /** ts of the latest inbound message; agent replies thread under it. */
  protected lastInboundTs: string | undefined;
  /**
   * ts of the in-place thinking phrase (or the open stream, in streaming
   * mode) per space; consumed when the reply lands. NOTE: the ts is only
   * known after postMessage/startStream resolves — the posting guard below
   * covers the in-flight window so a second phrase can never be posted.
   */
  protected pendingTs: string | undefined;
  /** A phrase post/stream open is still in flight (ts not yet known). */
  #phrasePosting = false;
  /** Consecutive empty completions (churn guard, #60). */
  #emptyTurnCount = 0;
  /** Churn message already surfaced; phrases stay off (#60). */
  #churnActive = false;
  /** The current turn already delivered a message or an error (#60). */
  #turnDelivered = false;
  /**
   * The current turn is a streaming (steer) turn (issue #120): in-place
   * phrase updates coalesce on {@link STREAM_UPDATE_INTERVAL_MS} and the
   * final text always lands. Set when SpaceService steers; cleared on
   * turn_end/error/dispose and when a non-streaming turn starts.
   */
  protected streamingTurns = false;
  /** Pending coalesced streaming update (issue #120). */
  #streamUpdate: PendingStreamUpdate | undefined;
  /** True while a digest turn runs: its output must not reach the channel (#42). */
  protected digesting = false;
  /** Date.now() of the latest inbound message — the receipt→reply latency base (#119). */
  #receivedAt: number | undefined;
  /** Phrase-posting latency ms (receipt → post resolved), carried on the reply audit row (#119). */
  #phrasePostedMs: number | undefined;
  /** Inbound message tss still carrying the receipt reaction (#119). */
  #pendingReactions = new Set<string>();
  /** Onboarding-nudge dedupe snapshot (issue #116). */
  #nudged: string | undefined;
  /** Shared THINKING_PHRASES rotation (one per SpaceService; see deps). */
  readonly #phraseRotation: { next(): string };
  /**
   * True in the streaming renderer: EVERY turn is a streaming turn, so the
   * message path always coalesces into the open stream instead of taking
   * the direct replace path.
   */
  protected alwaysStream = false;

  constructor(deps: TurnPresenterDeps) {
    this.spaceId = deps.spaceId;
    this.adapter = deps.adapter;
    this.#store = deps.store;
    this.#onboardingChecks = deps.onboardingChecks;
    this.#phraseRotation = deps.phraseRotation ?? createPhraseRotation();
  }

  /**
   * Receipt (issue #119): record the inbound ts, open the turn's visible
   * message (phrase post, or stream open in streaming mode), ack with the
   * 👀 reaction, and audit the message.in row — all BEFORE the session
   * cold-start, so a slow createSession is never silent. Each is
   * fire-and-forget: the turn path never blocks on Slack latency.
   */
  onInbound(msg: SlackMessage): void {
    this.lastInboundTs = msg.ts;
    this.#postThinkingPhrase();
    this.#addReceiptReaction(msg);
    this.#auditReceipt(msg);
  }

  /** The latest inbound message ts (digest marker base, #42); undefined before the first message. */
  latestInboundTs(): string | undefined {
    return this.lastInboundTs;
  }

  /** Connect-intent path (issue #61): record the inbound ts for threading only — no phrase/reaction/audit. */
  onConnectIntent(msg: SlackMessage): void {
    this.lastInboundTs = msg.ts;
  }

  /** turn_start: rotate the phrase in place (or, streaming, keep the stream opening). */
  onTurnStart(): void {
    this.#postThinkingPhrase();
  }

  /** A message event: stream/coalesce or replace the phrase with the reply text. */
  onMessage(data: unknown): void {
    if (this.digesting) return;
    const text = typeof data === "object" && data !== null && "text" in data ? data.text : undefined;
    if (typeof text !== "string") return;
    this.#turnDelivered = true;
    if (!text.trim()) {
      // Empty completion (#60): surface a visible fallback so the retry
      // loop is never silent, and count it for the churn guard. The pending
      // ts is deliberately kept: a retry's turn_start then replaces the
      // phrase in place (or appends to the stream) instead of stacking a
      // new message. A swallowed provider error (issue #78) rides the event
      // payload; the fallback carries the cause instead of the generic phrase.
      const cause = typeof data === "object" && data !== null && "error" in data ? data.error : undefined;
      this.#countEmptyTurn(typeof cause === "string" && cause.trim() ? cause.trim() : undefined);
      if (!this.#churnActive) {
        // A coalesced streaming text must not overwrite the fallback (#120).
        this.cancelStreamUpdate();
        const pendingTs = this.pendingTs;
        if (pendingTs !== undefined) {
          const fallback = emptyResponseFallback(
            typeof cause === "string" && cause.trim() ? cause.trim() : undefined,
          );
          void this.sendTextChunk(pendingTs, fallback).catch((err) => {
            console.error(`[slack-turn-presenter] failed to update empty-response phrase in ${this.spaceId}:`, err);
          });
        }
      }
      return;
    }
    // Real text: the empty streak is over, phrases re-arm.
    this.#emptyTurnCount = 0;
    this.#churnActive = false;
    if (this.alwaysStream || this.streamingTurns) {
      // Streaming turn (#120): coalesce updates on the cadence; the turn's
      // final text is delivered by turn_end (final-delivery guarantee).
      this.#scheduleStreamUpdate(text);
      return;
    }
    this.#replaceOrPost(text);
    // The reply landed: the receipt reaction comes off and the reply
    // latency is audited (issue #119).
    this.#clearReactions();
    this.#auditReply();
  }

  /** Session error: surface it by replacing the phrase in place (or appending + closing the stream). */
  onError(data: unknown): void {
    console.error(`[slack-turn-presenter] session error (${this.spaceId}):`, data);
    if (this.digesting) return;
    this.#turnDelivered = true;
    // An error supersedes any coalesced streaming text (#120): cancel the
    // pending update so its timer can never overwrite the error surface.
    this.cancelStreamUpdate();
    this.streamingTurns = false;
    // An error is a visible outcome: it breaks the empty streak and re-arms phrases.
    this.#emptyTurnCount = 0;
    this.#churnActive = false;
    const message = typeof data === "object" && data !== null && "message" in data ? data.message : undefined;
    const base = typeof message === "string" ? message : "Something went wrong while thinking.";
    // A setup-blocked failure (provider/session) appends the one-line
    // onboarding pointer (issue #116) — bounded by the per-space dedupe.
    this.#replaceOrPost(this.#nudgeText(base));
    // An error is a visible outcome: the receipt reaction comes off and
    // the reply latency is audited (issue #119).
    this.#clearReactions();
    this.#auditReply();
    // Streaming: the error text was appended above; close the stream so no
    // dangling panel is left behind.
    void this.finishTurn().catch((err) => {
      console.error(`[slack-turn-presenter] error-path turn finalize failed in ${this.spaceId}:`, err);
    });
  }

  /**
   * Turn ended: a churn message (silent empty turns) lands BEFORE the
   * finalize so it reaches the open stream / pending phrase; then the
   * turn's message is finalized (flush the final coalesced text, or stop
   * the stream with it as the closing block); then the receipt reaction
   * and latency audit resolve for streaming turns.
   */
  onTurnEnd(data: unknown): void {
    if (this.digesting) return;
    if (!this.#turnDelivered) {
      const cause = typeof data === "object" && data !== null && "error" in data ? data.error : undefined;
      this.#countEmptyTurn(typeof cause === "string" && cause.trim() ? cause.trim() : undefined);
    }
    const finalText = this.#latestStreamedText();
    const finalized = this.finalizeTurn(finalText);
    if (this.streamingTurns || this.alwaysStream) {
      this.#clearReactions();
      this.#auditReply();
    }
    this.streamingTurns = false;
    void finalized.catch((err) => {
      console.error(`[slack-turn-presenter] turn finalize failed in ${this.spaceId}:`, err);
    });
  }

  /** Marks the current turn as a streaming (steer) turn (issue #120); called by SpaceService. */
  setSteered(streaming: boolean): void {
    this.streamingTurns = streaming;
  }

  /** Digest turns are invisible to the channel (their output is memory, #42). */
  beginDigest(): void {
    this.digesting = true;
  }

  endDigest(): void {
    this.digesting = false;
  }

  /** A gated tool-call step (issue #168); the phrase renderer has no panel, so it renders nothing. */
  onToolStep(step: ToolStepEvent): void {
    if (this.digesting) return;
    this.renderToolStep(step);
  }

  /** DMs read naturally as a plain message — no thread. Team channels (C/G) keep replies threaded. */
  replyOpts(): { threadTs?: string } | undefined {
    if (isDmChannel(channelFromSpaceId(this.spaceId))) return undefined;
    const threadTs = this.lastInboundTs;
    return threadTs === undefined ? undefined : { threadTs };
  }

  dispose(): void {
    this.lastInboundTs = undefined;
    this.pendingTs = undefined;
    this.#phrasePosting = false;
    this.#emptyTurnCount = 0;
    this.#churnActive = false;
    this.#turnDelivered = false;
    this.#receivedAt = undefined;
    this.#phrasePostedMs = undefined;
    this.#pendingReactions.clear();
    this.cancelStreamUpdate();
    this.streamingTurns = false;
    this.#nudged = undefined;
  }

  // -------------------------------------------------------------------------
  // Render seams — the streaming renderer overrides these.
  // -------------------------------------------------------------------------

  /**
   * Opens the turn's visible message with the thinking phrase; resolves
   * with its ts. Phrase renderer: postMessage. Streaming: chat.startStream
   * (falling back to postMessage when the workspace lacks the feature).
   * Deliberately NOT async in the base: the phrase path's promise chain
   * must stay microtask-identical to the pre-#153 implementation, which
   * the receipt/rotation tests' single `await` depends on.
   */
  protected openTurn(openingText: string): Promise<string | undefined> {
    return this.adapter.postMessage(this.spaceId, openingText, this.replyOpts());
  }

  /**
   * One text chunk to the turn's message. Phrase: chat.update in place.
   * Streaming: chat.appendStream markdown_text. Not async in the base for
   * the same microtask-timing reason as {@link openTurn}.
   */
  protected sendTextChunk(ts: string, text: string): Promise<void> {
    return this.adapter.updateMessage(this.spaceId, ts, text);
  }

  /**
   * Finalizes the turn's message with the final reply text. Phrase: flush
   * the pending coalesced update (bounded retries). Streaming: drop the
   * pending append and close with chat.stopStream carrying the final text
   * as the closing block.
   */
  protected async finalizeTurn(_finalText: string | undefined): Promise<void> {
    return this.#finalizeStreamUpdate();
  }

  /** Post-turn cleanup; streaming closes the stream here. */
  protected async finishTurn(): Promise<void> {}

  /** Renders one thinking-step card; the phrase renderer has no panel. */
  protected renderToolStep(_step: ToolStepEvent): void {}

  // -------------------------------------------------------------------------
  // Phrase machinery (issues #40/#60/#119/#120, extracted verbatim).
  // -------------------------------------------------------------------------

  /**
   * Posts (or rotates) the space's one thinking phrase — or opens/keeps the
   * stream, in streaming mode. Called on message receipt — BEFORE the
   * session cold-start, so a slow createSession is never silent — and on
   * turn_start, which updates the receipt phrase in place. Retry-safe
   * (#60): OMP auto-retries empty completions and each attempt fires
   * turn_start, so a pending phrase is UPDATED instead of stacking a second
   * message — one message max per space at any time. A call while a phrase
   * post is still in flight (ts unknown yet) skips posting entirely. Digest
   * turns are invisible to the channel. After the churn guard has fired
   * (#60), phrases stay off until a turn produces text or an error.
   * Captures the phrase-posting latency (receipt → post resolved) for the
   * reply audit row (issue #119).
   */
  #postThinkingPhrase(): void {
    if (this.digesting) return;
    this.#turnDelivered = false;
    if (this.#churnActive) return;
    const pendingTs = this.pendingTs;
    if (pendingTs !== undefined) {
      // A retry (or second turn) while the phrase is up: replace in place.
      // A stale coalesced streaming text must not overwrite the rotation (#120).
      this.cancelStreamUpdate();
      void this.rotateTurnOpening(pendingTs).catch((err) => {
        console.error(`[slack-turn-presenter] failed to update thinking phrase in ${this.spaceId}:`, err);
      });
      return;
    }
    if (this.#phrasePosting) return; // in flight — it becomes the phrase
    this.#phrasePosting = true;
    void this.openTurn(this.#nextPhrase())
      .then((ts) => {
        if (ts !== undefined) {
          this.pendingTs = ts;
          const receivedAt = this.#receivedAt;
          if (receivedAt !== undefined) this.#phrasePostedMs = Date.now() - receivedAt;
        }
      })
      .catch((err) => {
        console.error(`[slack-turn-presenter] failed to post thinking phrase to ${this.spaceId}:`, err);
      })
      .finally(() => {
        this.#phrasePosting = false;
      });
  }

  /** Rotates an already-pending phrase in place; streaming keeps its opening, so it does nothing. */
  protected rotateTurnOpening(pendingTs: string): Promise<void> {
    return this.sendTextChunk(pendingTs, this.#nextPhrase());
  }

  /** Next rotating phrase; advances the shared rotation. */
  #nextPhrase(): string {
    return this.#phraseRotation.next();
  }

  /**
   * Receipt ack (issue #119): adds the 👀 reaction to the inbound message
   * and remembers its ts so the reply can remove it. Fail-soft — a missing
   * `reactions:write` scope is logged by the caller's catch, never thrown
   * into the turn path.
   */
  #addReceiptReaction(msg: SlackMessage): void {
    this.#pendingReactions.add(msg.ts);
    void this.adapter.addReaction(this.spaceId, msg.ts).catch((err) => {
      console.error(`[slack-turn-presenter] failed to add receipt reaction in ${this.spaceId}:`, err);
    });
  }

  /**
   * Removes every pending receipt reaction for the space once a visible
   * outcome — reply text or error — lands (issue #119). Idempotent: the
   * pending set is cleared first, so a second call (e.g. turn_end after the
   * message handler) is a no-op.
   */
  #clearReactions(): void {
    if (this.#pendingReactions.size === 0) return;
    const pending = [...this.#pendingReactions];
    this.#pendingReactions.clear();
    for (const ts of pending) {
      void this.adapter.removeReaction(this.spaceId, ts).catch((err) => {
        console.error(`[slack-turn-presenter] failed to remove receipt reaction in ${this.spaceId}:`, err);
      });
    }
  }

  /**
   * Records the message.in audit row at receipt and starts the reply-latency
   * clock (issue #119). Payload carries only the Slack ts — never message
   * text, which can hold secrets. Fire-and-forget.
   */
  #auditReceipt(msg: SlackMessage): void {
    this.#receivedAt = Date.now();
    void this.#store
      .appendAudit({
        space_id: this.spaceId,
        actor: msg.principal,
        event_type: MESSAGE_RECEIVED_EVENT,
        payload: JSON.stringify({ ts: msg.ts }),
      })
      .catch((err) => {
        console.error(`[slack-turn-presenter] message.in audit write failed for ${this.spaceId}:`, err);
      });
  }

  /**
   * Records the message.reply audit row with receipt→reply latency (issue
   * #119). Called when a real reply or an error lands; empty completions and
   * churn messages are retry bookkeeping and write no row. Idempotent: the
   * latency base is consumed on the first call. Fire-and-forget.
   */
  #auditReply(): void {
    const receivedAt = this.#receivedAt;
    if (receivedAt === undefined) return; // no receipt recorded for this space
    const phraseMs = this.#phrasePostedMs;
    this.#receivedAt = undefined;
    this.#phrasePostedMs = undefined;
    void this.#store
      .appendAudit({
        space_id: this.spaceId,
        actor: "system",
        event_type: MESSAGE_REPLIED_EVENT,
        payload: JSON.stringify({
          latency_ms: Date.now() - receivedAt,
          ...(phraseMs !== undefined ? { phrase_ms: phraseMs } : {}),
        }),
      })
      .catch((err) => {
        console.error(`[slack-turn-presenter] message.reply audit write failed for ${this.spaceId}:`, err);
      });
  }

  /**
   * Replaces the pending thinking phrase (or appends to the stream) when one
   * exists; otherwise posts fresh (edge: the reply landed before the phrase
   * ts was captured). The pending ts is cleared either way so a reply
   * updates exactly once.
   */
  #replaceOrPost(text: string): void {
    const pendingTs = this.pendingTs;
    if (pendingTs !== undefined) {
      this.pendingTs = undefined;
      void this.sendTextChunk(pendingTs, text).catch((err) => {
        console.error(`[slack-turn-presenter] failed to update reply in ${this.spaceId}:`, err);
      });
      return;
    }
    void this.adapter.postMessage(this.spaceId, text, this.replyOpts()).catch((err) => {
      console.error(`[slack-turn-presenter] failed to post reply to ${this.spaceId}:`, err);
    });
  }

  /**
   * Streaming path (issue #120): coalesce an update — the latest streamed
   * text replaces any pending one, and a cadence timer pushes it to Slack
   * at most once per {@link STREAM_UPDATE_INTERVAL_MS}. No pending ts
   * (edge: the reply raced the phrase post) falls back to the direct path
   * so the text is never lost.
   */
  #scheduleStreamUpdate(text: string): void {
    const pendingTs = this.pendingTs;
    if (pendingTs === undefined) {
      this.#replaceOrPost(text);
      return;
    }
    const existing = this.#streamUpdate;
    if (existing) {
      existing.text = text; // latest text wins; the armed timer stays
      return;
    }
    const entry: PendingStreamUpdate = { ts: pendingTs, text, final: false, retries: 0, timer: null };
    this.#streamUpdate = entry;
    this.#armStreamTimer(entry);
  }

  /** Arms the cadence timer for a pending stream update if none is running. */
  #armStreamTimer(entry: PendingStreamUpdate): void {
    if (entry.timer !== null) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.#flushStreamUpdate();
    }, STREAM_UPDATE_INTERVAL_MS);
    entry.timer.unref?.();
  }

  /**
   * Sends the pending coalesced text now. Fail-soft (issue #120): a 429 (or
   * any error) is logged and the update is KEPT for the next attempt — never
   * thrown into the turn path. Interim failures wait for the turn-end flush;
   * final failures re-arm the timer, bounded by {@link STREAM_FINAL_RETRY_LIMIT}.
   */
  async #flushStreamUpdate(): Promise<void> {
    const entry = this.#streamUpdate;
    if (!entry) return;
    this.#streamUpdate = undefined;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    try {
      await this.sendTextChunk(entry.ts, entry.text);
    } catch (err) {
      console.error(
        `[slack-turn-presenter] streaming phrase update failed in ${this.spaceId} (${err instanceof Error ? err.message : String(err)}); keeping for the next attempt`,
      );
      if (entry.final && entry.retries >= STREAM_FINAL_RETRY_LIMIT) return; // logged; give up
      const kept: PendingStreamUpdate = { ...entry, retries: entry.retries + 1, timer: null };
      this.#streamUpdate = kept;
      if (entry.final) this.#armStreamTimer(kept); // retry the final until it lands
    }
  }

  /**
   * Turn ended: any pending coalesced update carries the FINAL reply text —
   * flush it immediately so it always lands, with bounded retries on a 429.
   */
  #finalizeStreamUpdate(): Promise<void> {
    const entry = this.#streamUpdate;
    if (!entry) return Promise.resolve();
    entry.final = true;
    entry.retries = 0;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    return this.#flushStreamUpdate();
  }

  /** The latest coalesced streamed text, if any (the turn's final reply candidate). */
  #latestStreamedText(): string | undefined {
    return this.#streamUpdate?.text;
  }

  /** Cancels any pending coalesced update (superseded text must not overwrite). */
  protected cancelStreamUpdate(): void {
    const entry = this.#streamUpdate;
    if (!entry) return;
    clearTimeout(entry.timer ?? undefined);
    this.#streamUpdate = undefined;
  }

  /**
   * Counts one empty completion; beyond {@link EMPTY_TURN_LIMIT} consecutive
   * empties, surfaces the churn message exactly once (in place of the
   * pending phrase/stream, or fresh) and silences phrases until a non-empty
   * turn — fail visible, not silent (#60). The message carries the real
   * provider/session cause when one exists (issue #78); unknown cause keeps
   * the legacy phrase. The churn boundary is the missing-model-key path of
   * the onboarding nudge (issue #116): when the shared checks fail, the
   * one-line pointer is appended here.
   */
  #countEmptyTurn(cause?: string): void {
    const count = this.#emptyTurnCount + 1;
    this.#emptyTurnCount = count;
    if (count <= EMPTY_TURN_LIMIT || this.#churnActive) return;
    this.#churnActive = true;
    this.#replaceOrPost(this.#nudgeText(churnMessageText(cause)));
  }

  /**
   * Appends the one-line onboarding pointer (issue #116) when setup is
   * incomplete: names the failing checks and points at `first_run_wizard`.
   * Deduped per space on the failing-check snapshot — a broken setup nudges
   * once until the missing set changes, and the record clears once the
   * checks pass. Fail closed: a check failure (e.g. malformed settings)
   * suppresses the nudge, never the turn output.
   */
  #nudgeText(baseText: string): string {
    let failing: WizardCheck[];
    try {
      failing = this.#onboardingChecks().filter((c) => !c.ok);
    } catch (err) {
      console.error(`[slack-turn-presenter] onboarding checks failed for ${this.spaceId}:`, err);
      return baseText;
    }
    if (failing.length === 0) {
      this.#nudged = undefined;
      return baseText;
    }
    const snapshot = failing
      .map((c) => c.name)
      .sort()
      .join(",");
    if (this.#nudged === snapshot) return baseText;
    this.#nudged = snapshot;
    void this.#store
      .appendAudit({
        space_id: this.spaceId,
        actor: "system",
        event_type: ADMIN_ONBOARDING_NUDGE_EVENT,
        payload: JSON.stringify({ checks: failing.map((c) => ({ name: c.name, ok: c.ok })) }),
      })
      .catch((err) => {
        console.error(`[slack-turn-presenter] onboarding nudge audit write failed for ${this.spaceId}:`, err);
      });
    return `${baseText}\n${onboardingGuideText(failing)}`;
  }
}

/**
 * The Slack-native thinking-panel renderer (issue #168): chat.startStream
 * opens the panel with the thinking phrase; every gated tool call renders a
 * `task_update` step card; interim reply text appends as markdown_text on
 * the same coalescing cadence as the phrase renderer; turn_end closes with
 * chat.stopStream carrying the final reply as the closing block.
 *
 * Fallback (fail closed): the first stream failure — a workspace without
 * the Agents feature, missing recipient_team_id, a rate limit — switches
 * this renderer to the phrase+edit path PERMANENTLY (per boot) and the
 * adapter remembers the failure, so no turn ever pays the failed call twice
 * and no reply is dropped.
 */
export class StreamTurnPresenter extends SlackTurnPresenter {
  /** ts of the OPEN stream; undefined between turns / after a fallback. */
  #streamTs: string | undefined;
  /** False once a stream call failed: the phrase renderer takes over for the boot. */
  #streamMode = true;

  constructor(deps: TurnPresenterDeps) {
    super(deps);
    this.alwaysStream = true;
  }

  /**
   * Opens the stream with the thinking phrase as the opening chunk. Slack
   * streams are ALWAYS threaded replies, so SpaceService never routes DMs
   * here (issue #180): the plain phrase+edit path owns DM spaces, and this
   * renderer only ever sees channel spaces (or a fallback, which keeps
   * top-level posts). A failed open falls back to the phrase post — the
   * reply path never depends on streaming.
   */
  protected async openTurn(openingText: string): Promise<string | undefined> {
    if (!this.#streamMode || !this.adapter.streamingSupported()) return super.openTurn(openingText);
    const threadTs = this.lastInboundTs;
    if (threadTs === undefined) return super.openTurn(openingText);
    try {
      const ts = await this.adapter.startStream(this.spaceId, { threadTs, openingText });
      if (ts !== undefined) this.#streamTs = ts;
      return ts;
    } catch (err) {
      this.#streamMode = false;
      console.error(
        `[slack-turn-presenter] chat.startStream failed in ${this.spaceId} — falling back to phrase+edit for the boot:`,
        err,
      );
      return super.openTurn(openingText);
    }
  }

  /** Interim reply text appends to the stream (markdown_text) on the cadence. */
  protected async sendTextChunk(ts: string, text: string): Promise<void> {
    if (!this.#streamMode) return super.sendTextChunk(ts, text);
    await this.adapter.appendText(this.spaceId, ts, text);
  }

  /**
   * turn_end: the final reply lands as the stopStream closing block (the
   * pending coalesced append is dropped — it was superseded by the final).
   * In fallback mode the base flush delivers it via chat.update as before.
   */
  protected async finalizeTurn(finalText: string | undefined): Promise<void> {
    if (!this.#streamMode || this.#streamTs === undefined) {
      return super.finalizeTurn(finalText);
    }
    // The stream is the turn message: a pending coalesced append is
    // superseded by the final stopStream block, so drop it. The pending
    // ts is consumed with the stream — the next turn opens a fresh panel
    // instead of appending to the closed one.
    this.cancelStreamUpdate();
    const ts = this.#streamTs;
    this.#streamTs = undefined;
    this.pendingTs = undefined;
    await this.#stopWithRetry(ts, finalText);
  }

  /** Post-turn: close the stream when one is open (error path, no final text). */
  protected async finishTurn(): Promise<void> {
    if (!this.#streamMode || this.#streamTs === undefined) return;
    const ts = this.#streamTs;
    this.#streamTs = undefined;
    this.pendingTs = undefined;
    await this.#stopWithRetry(ts, undefined);
  }

  /** One thinking-step card per gated tool call (issue #168). */
  protected renderToolStep(step: ToolStepEvent): void {
    if (!this.#streamMode || this.#streamTs === undefined) return; // no panel in fallback mode
    void this.adapter
      .appendTask(this.spaceId, this.#streamTs, {
        id: step.taskId,
        title: step.title,
        status: step.status,
        ...(step.output !== undefined ? { output: step.output } : {}),
      })
      .catch((err) => {
        console.error(`[slack-turn-presenter] failed to append task step in ${this.spaceId}:`, err);
      });
  }

  /** chat.stopStream with bounded retries (a 429 must not drop the final reply). */
  async #stopWithRetry(ts: string, text: string | undefined): Promise<void> {
    let retries = 0;
    for (;;) {
      try {
        await this.adapter.stopStream(this.spaceId, ts, text);
        return;
      } catch (err) {
        if (retries >= STREAM_FINAL_RETRY_LIMIT) {
          console.error(
            `[slack-turn-presenter] stopStream failed in ${this.spaceId} after ${retries} retries:`,
            err,
          );
          return;
        }
        retries += 1;
        await new Promise((resolve) => setTimeout(resolve, STREAM_UPDATE_INTERVAL_MS));
      }
    }
  }
}
