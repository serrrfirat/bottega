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
 *    (issues #40/#60/#119/#120/#193, extracted verbatim). One thinking
 *    message per space, rotated on receipt/turn_start; during the turn the
 *    phrase is a LIVE PROGRESS line (issue #193) — current tool step,
 *    latest thinking snippet, or the elapsed "Thinking… Ns" — coalesced on
 *    {@link STREAM_UPDATE_INTERVAL_MS} and replaced in place by the final
 *    reply; steered (streaming) turns coalesce edits to at most one per
 *    cadence with a final-delivery guarantee.
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
import { z } from "zod";
import type { TodoPhase, TodoStatus } from "@oh-my-pi/pi-coding-agent";
import type { Store } from "../../store/db";
import {
  ADMIN_ONBOARDING_NUDGE_EVENT,
  MESSAGE_RECEIVED_EVENT,
  MESSAGE_REPLIED_EVENT,
} from "../../store/audit-events";
import { redact } from "../../policy/audit";
import { onboardingGuideText, type WizardCheck } from "../../tools/admin";
import { codexMintFailureText } from "../../extensions/proxy-seed";
import {
  channelFromSpaceId,
  isDmChannel,
  type SlackAdapter,
  type SlackMessage,
} from "../adapters/slack";

/**
 * The driver session's event payloads, decoded at the presenter boundary
 * (the session emitter's callback hands them as untyped data). The schemas
 * mirror exactly what the drivers emit: `message` = reply text plus the
 * optional swallowed-error cause (issue #78), `error` = the failure
 * message, `turn_end` = the optional failure cause (issue #178),
 * `thinking` = the live reasoning snippet (issue #193).
 */
export const MessageEventSchema = z.object({
  spaceId: z.string().optional(),
  text: z.string().optional(),
  error: z.string().optional(),
});
export type MessageEvent = z.infer<typeof MessageEventSchema>;

export const ErrorEventSchema = z.object({
  spaceId: z.string().optional(),
  message: z.string().optional(),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export const TurnEndEventSchema = z.object({
  spaceId: z.string().optional(),
  error: z.string().optional(),
});
export type TurnEndEvent = z.infer<typeof TurnEndEventSchema>;

export const ThinkingEventSchema = z.object({
  spaceId: z.string().optional(),
  thinking: z.string().optional(),
});
export type ThinkingEvent = z.infer<typeof ThinkingEventSchema>;

/**
 * The driver's live todo snapshot (issue #228): the `todo_phases` event —
 * the phases the SDK's todo tool reported on the tool_execution_end push
 * (or the pull read through getTodoPhases, same shape). Empty-tolerant: no
 * phases means "no active plan", which is normal, never an error.
 */
export const TodoPhasesEventSchema = z.object({
  spaceId: z.string().optional(),
  phases: z
    .array(
      z.object({
        name: z.string(),
        tasks: z.array(
          z.object({
            content: z.string(),
            status: z.enum(["pending", "in_progress", "completed", "abandoned", "blocked"]),
            blocker: z.string().optional(),
          }),
        ),
      }),
    )
    .optional(),
});
export type TodoPhasesEvent = z.infer<typeof TodoPhasesEventSchema>;

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
 * The live-progress phrase (issue #193) coalesces on the SAME cadence.
 * Hardcoded default (no org setting).
 */
export const STREAM_UPDATE_INTERVAL_MS = 400;

/**
 * Live-progress line cap (issue #193): the in-place phrase shows the
 * current tool step or the latest reasoning snippet at most this many
 * characters — a progress HINT, never a document. Long reasoning renders
 * as its tail (the most recent reasoning, which keeps moving); long step
 * titles render as their head (the tool name stays visible).
 */
export const THINKING_SNIPPET_MAX = 200;

/**
 * Bounded retries for the FINAL delivery (issue #120): after this many
 * consecutive final-flush failures (e.g. a hard 429), the update is dropped
 * with a log rather than hammering Slack forever. Interim updates never
 * retry on their own — they wait for the turn-end flush. A stopStream that
 * exhausts this budget flips the presenter to the phrase path so the final
 * reply still lands (issue #181).
 */
export const STREAM_FINAL_RETRY_LIMIT = 3;

/** Shown on a `message` event whose text is empty/whitespace (issue #60). */
export const EMPTY_RESPONSE_FALLBACK = "Hmm — I got an empty response, retrying…";

/** Surfaced once after {@link EMPTY_TURN_LIMIT} consecutive empty turns (issue #60). */
export const CHURN_MESSAGE = "I keep getting empty responses — check the model key?";

/**
 * {@link EMPTY_RESPONSE_FALLBACK} carrying the real provider/session cause
 * (issue #78): when the empty completion is a swallowed provider error (e.g.
 * the replay-ordering 400), the fallback names the cause instead of guessing.
 * A Codex mint failure (issue #218) supersedes BOTH — the visible reply is
 * the recovery path, never the generic retry phrase.
 * Fail closed: no cause → the exact legacy phrase.
 */
export function emptyResponseFallback(cause: string | undefined): string {
  const remedy = codexMintFailureText(cause);
  if (remedy !== null) return remedy;
  return cause && cause.trim() ? `Hmm — I got an empty response: ${cause.trim()} — retrying…` : EMPTY_RESPONSE_FALLBACK;
}

/**
 * {@link CHURN_MESSAGE} carrying the real provider/session cause (issue #78):
 * the cause supersedes the "check the model key?" guess when one exists.
 * A Codex mint failure (issue #218) supersedes BOTH — the churn message is
 * the recovery path, never the guess.
 * Fail closed: no cause → the exact legacy phrase.
 */
export function churnMessageText(cause: string | undefined): string {
  const remedy = codexMintFailureText(cause);
  if (remedy !== null) return remedy;
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
// Live todo rendering (issue #228): the session's todo plan rendered two
// ways — a one-line progress indicator that rides the thinking phrase
// (multi-step turns) and the in-place "🛠 Agent's plan" message (long
// turns). Both are pure over the SDK's TodoPhase[] shape, shared by the
// presenter (live path) and the list_todos tool (snapshot path) so the two
// surfaces never drift.
// ---------------------------------------------------------------------------

/** A plan line's content cap; longer task text head-truncates. */
export const PLAN_LINE_MAX = 200;

/** Status icon per todo task status (the issue #228 plan rendering). */
export function todoStatusIcon(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "✅";
    case "blocked":
      return "⛔";
    case "abandoned":
      return "⊘";
    default:
      return "⏳"; // pending + in_progress share the "not done yet" marker
  }
}

/** Head-caps a plan line; long task text keeps its start. */
function capPlanLine(text: string): string {
  if (text.length <= PLAN_LINE_MAX) return text;
  return `${text.slice(0, PLAN_LINE_MAX - 1)}…`;
}

/**
 * The "🛠 Agent's plan" message body: one numbered line per task across
 * the phases, status-icon prefixed (the issue #228 shape). Empty-tolerant:
 * an empty plan renders the explicit "no active plan" line — normal, never
 * an error. Blocked tasks carry their blocker note.
 */
export function renderTodoPlan(phases: readonly TodoPhase[]): string {
  const tasks = phases.flatMap((phase) => phase.tasks);
  const lines =
    tasks.length === 0
      ? ["no active plan"]
      : tasks.map((task, index) => {
          const line = `${todoStatusIcon(task.status)} ${index + 1}. ${capPlanLine(task.content)}`;
          return task.status === "blocked" && task.blocker ? `${line} — ${task.blocker}` : line;
        });
  return `🛠 Agent's plan:\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

/**
 * The long-turn heuristic (issue #228): a plan qualifies for the in-place
 * plan message when it has >= 3 steps AND spans >= 2 phases with tasks —
 * a heuristic on the todo state, never wall-clock.
 */
export function isLongPlan(phases: readonly TodoPhase[]): boolean {
  const phasesWithTasks = phases.filter((phase) => phase.tasks.length > 0);
  const totalTasks = phasesWithTasks.reduce((sum, phase) => sum + phase.tasks.length, 0);
  return totalTasks >= 3 && phasesWithTasks.length >= 2;
}

/**
 * The current (next actionable) step of the flattened plan (issue #228):
 * the first in_progress task, or the first pending/blocked one when
 * nothing is running yet. `index` is 1-based over the flattened plan.
 * Undefined when the plan has < 2 steps or everything is done/abandoned —
 * short turns show nothing extra. Shared by the phrase indicator and the
 * list_todos snapshot.
 */
export function todoProgress(
  phases: readonly TodoPhase[],
): { index: number; total: number; current: string } | undefined {
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length < 2) return undefined;
  const order: readonly TodoStatus[] = ["in_progress", "pending", "blocked"];
  let found: { task: (typeof tasks)[number]; index: number } | undefined;
  for (const status of order) {
    const index = tasks.findIndex((task) => task.status === status);
    if (index !== -1) {
      found = { task: tasks[index]!, index };
      break;
    }
  }
  if (found === undefined) return undefined; // all completed/abandoned
  return { index: found.index + 1, total: tasks.length, current: capPlanLine(found.task.content) };
}

/**
 * The multi-step phrase indicator (issue #228): "🛠 2/3 — drafting the PR"
 * for the current step — see {@link todoProgress}. Undefined when the plan
 * has < 2 steps or nothing is actionable — short turns show nothing extra.
 */
export function todoProgressLine(phases: readonly TodoPhase[]): string | undefined {
  const progress = todoProgress(phases);
  return progress === undefined ? undefined : `🛠 ${progress.index}/${progress.total} — ${progress.current}`;
}

// ---------------------------------------------------------------------------
// Search-citation table rendering (issue #278): the search_web tool returns
// structured results; a turn that used them posts a table block (headers +
// capped rows with an elided tail count) alongside the citations actually
// used. Pure so the presenter seam is unit-testable without Slack.
// ---------------------------------------------------------------------------

/** One structured search result a turn used (issue #278) — the search_web tool's shape. */
export interface SearchResultRow {
  title: string;
  url: string;
  snippet: string;
}

/** Max rows the citations table renders; the remainder folds into the elided tail count. */
export const SEARCH_TABLE_MAX_ROWS = 6;

/**
 * Renders the search-results citation blocks: a header row, one section
 * per result (capped at {@link SEARCH_TABLE_MAX_ROWS} — a line for the
 * elided tail count when more came back), and a closing "sources used"
 * section listing every cited URL so the turn's claims carry their source.
 * Pure Slack block objects (the same shape {@link buildApprovalBlocks}
 * emits); never throws on empty input (empty renders a no-sources section).
 */
export function renderSearchResultBlocks(
  results: readonly SearchResultRow[],
  maxRows: number = SEARCH_TABLE_MAX_ROWS,
): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🔎 Search results (cited)" },
    },
  ];
  const shown = results.slice(0, maxRows);
  for (const result of shown) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `• *${result.title || result.url}*\n${result.snippet}\n${result.url}`,
      },
    });
  }
  const elided = results.length - shown.length;
  if (elided > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `…and ${elided} more result${elided === 1 ? "" : "s"} not shown.` }],
    });
  }
  if (results.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No search results to cite._" },
    });
  }
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Sources used:*\n${shown.map((r) => `<${r.url}>`).join("\n") || "_none_"}`,
    },
  });
  return blocks;
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
export function createPhraseRotation() {
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
  /**
   * True when the entry carries a LIVE-PROGRESS line (issue #193), false
   * for real streamed reply text. A real-text entry must never be
   * overwritten by a progress line — the reply wins, the progress yields.
   */
  progress?: boolean;
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
  /**
   * Inbound tss whose 👀 receipt ack already fired (issue #183). Slack
   * redelivers the same inbound message (same ts); without this, each
   * redelivery re-fired addReaction and hit `already_reacted`. Dedupe by
   * ts: one ack per unique inbound message, cleared on dispose.
   */
  #ackedReactions = new Set<string>();
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
  /**
   * Live progress (issue #193): the CURRENT tool step's title and the
   * latest thinking snippet drive the in-place progress line — priority
   * step > thinking > elapsed "Thinking… Ns". The elapsed tick timer
   * re-renders the line on {@link STREAM_UPDATE_INTERVAL_MS} so a long
   * silent turn (no step, no thinking) never looks frozen, and
   * {@link #lastProgressText} skips identical re-renders.
   */
  #currentStepTitle: string | undefined;
  #latestThinking: string | undefined;
  #lastProgressText: string | undefined;
  #progressTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A gated tool call is IN FLIGHT (issue #219): the safe window — the
   * only phase where a correction may steer the running turn — excludes
   * mid-tool interrupts. Tracked on the base so the streaming renderer
   * (which overrides renderToolStep for panel cards) reports the same
   * gate; see {@link canSteer}.
   */
  protected toolStepInFlight = false;
  /** Messages queued behind the running turn (issue #219); the visible "+N waiting" count. */
  #waitingCount = 0;
  /**
   * The session's live todo plan (issue #228): the latest snapshot the
   * driver pushed (tool_execution_end). Survives turns — the SDK's todo
   * state is per-session and persists across turns — and is cleared only
   * on dispose. Drives the phrase's "🛠 N/M" indicator and the in-place
   * plan message.
   */
  #todoPhases: TodoPhase[] = [];
  /**
   * ts of the in-place "🛠 Agent's plan" message (issue #228): one per
   * space, posted on the first qualifying snapshot of a turn and EDITED in
   * place as steps complete — the same phrase+edit mechanics as the
   * thinking phrase. End-of-turn cleanup decision: LEAVE the final state
   * as the turn's record (boring option) — deleting would need an extra
   * Slack call + permission and would destroy the record; the left-behind
   * message shows the CURRENT final state, never a stale one.
   */
  #planTs: string | undefined;
  /** The plan message's post is still in flight (ts not yet known). */
  #planPosting = false;
  /** The last rendered plan body; identical snapshots skip the edit. */
  #lastPlanText: string | undefined;

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
    // A new turn: the previous turn's progress state is stale (#193). The
    // opening phrase (and the elapsed tick) take over from here.
    this.#currentStepTitle = undefined;
    this.#latestThinking = undefined;
    this.#lastProgressText = undefined;
    this.#postThinkingPhrase();
    this.#addReceiptReaction(msg);
    this.#auditReceipt(msg);
  }

  /** The latest inbound message ts (digest marker base, #42); undefined before the first message. */
  latestInboundTs(): string | undefined {
    return this.lastInboundTs;
  }

  /** turn_start: rotate the phrase in place (or, streaming, keep the stream opening). */
  onTurnStart(): void {
    this.#postThinkingPhrase();
  }

  /** A message event: stream/coalesce or replace the phrase with the reply text. */
  onMessage(data: MessageEvent): void {
    if (this.digesting) return;
    const text = data.text;
    if (text === undefined) return;
    this.#turnDelivered = true;
    if (!text.trim()) {
      // Empty completion (#60): surface a visible fallback so the retry
      // loop is never silent, and count it for the churn guard. The pending
      // ts is deliberately kept: a retry's turn_start then replaces the
      // phrase in place (or appends to the stream) instead of stacking a
      // new message. A swallowed provider error (issue #78) rides the event
      // payload; the fallback carries the cause instead of the generic phrase.
      const cause = data.error?.trim() || undefined;
      this.#countEmptyTurn(cause);
      if (!this.#churnActive) {
        // A coalesced streaming text must not overwrite the fallback (#120);
        // neither may the elapsed tick (#193) — the fallback IS the visible
        // state until the retry's turn_start re-arms the progress.
        this.cancelStreamUpdate();
        this.#cancelProgressTimer();
        const pendingTs = this.pendingTs;
        if (pendingTs !== undefined) {
          const fallback = emptyResponseFallback(cause);
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
  onError(data: ErrorEvent): void {
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
    // A Codex mint failure (issue #218) maps to the recovery path — the raw
    // proxy error string would read as an empty-response rerun, not a fix.
    const base = codexMintFailureText(data.message) ?? data.message ?? "Something went wrong while thinking.";
    console.log(`presenter: turn error ${this.spaceId} ${base.replaceAll("\n", " ")}`);
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
  onTurnEnd(data: TurnEndEvent): void {
    if (this.digesting) return;
    if (!this.#turnDelivered) {
      this.#countEmptyTurn(data.error?.trim() || undefined);
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

  /**
   * Marks the current turn as a streaming (steer) turn (issue #120); called
   * by SpaceService. Issue #215: a message STEERED into a running turn must
   * be visible to any poller filtering by the steer's own ts — the original
   * turn's phrase (ts older than the steer inbound) can never carry the
   * combined turn's final reply. Every steer posts a FRESH phrase on the
   * steer message's own line (new ts, threaded under the steer inbound),
   * which becomes the pending final-reply target: the steered user sees
   * their own progress line and the reply edits a message newer than their
   * message. The stream renderer (alwaysStream) skips this — its open
   * stream IS the steer's line and a second stream can never open
   * mid-turn.
   */
  setSteered(streaming: boolean): void {
    if (streaming && !this.alwaysStream) {
      this.#postSteerPhrase();
    }
    this.streamingTurns = streaming;
  }

  /**
   * Issue #219 safe-window gate: a correction may steer the running turn
   * ONLY while the turn is still in reasoning/phrase state — no final
   * reply committed (a message or error already landed) and no gated tool
   * call in flight (a side-effecting call must never be interrupted).
   * Past that window, even corrections queue; the next turn sees them
   * (near-equivalent, no risk of corrupting a half-done tool action).
   */
  canSteer(): boolean {
    return !this.digesting && !this.#turnDelivered && !this.toolStepInFlight;
  }

  /**
   * Issue #219 (queue-by-default): SpaceService reports the per-space queue
   * length; the CURRENT live line carries a visible "+N waiting" suffix
   * while messages wait, and the suffix drops as the queue drains. The
   * indicator rides the phrase/progress line only — never the final reply
   * text (turnDelivered lines are left untouched; the next turn's phrase
   * re-decorates).
   */
  setQueueLength(count: number): void {
    this.#waitingCount = Math.max(0, count);
    if (this.digesting) return;
    if (this.#turnDelivered) return; // the final reply owns the line; the next phrase re-decorates
    this.#renderProgressNow();
  }

  /**
   * Issue #219: a queued message's turn starts. The running turn's reply
   * already landed; this opens the drained turn's OWN visible line (fresh
   * phrase, threaded under the drained message) and re-arms the live
   * progress. The receipt reaction and message.in audit already happened
   * at queue time (onInbound), so neither repeats here.
   */
  onQueueDrain(msgTs: string): void {
    this.lastInboundTs = msgTs;
    this.#currentStepTitle = undefined;
    this.#latestThinking = undefined;
    this.#lastProgressText = undefined;
    this.#postThinkingPhrase();
  }

  /** Digest turns are invisible to the channel (their output is memory, #42). */
  beginDigest(): void {
    this.digesting = true;
  }

  endDigest(): void {
    this.digesting = false;
  }

  /** A gated tool-call step (issue #168); the phrase renderer shows it as the live progress line. */
  onToolStep(step: ToolStepEvent): void {
    if (this.digesting) return;
    this.renderToolStep(step);
  }

  /**
  /** A live thinking chunk from the driver (issue #193): the phrase renderer
   * shows the latest reasoning snippet in place while the turn runs. The
   * streaming renderer ignores it (the panel renders steps, not phrases).
   */
  onThinking(data: ThinkingEvent): void {
    if (this.digesting) return;
    this.renderThinking(data);
  }

  /**
   * A live todo snapshot from the driver (issue #228): the phrase renderer
   * appends the "🛠 N/M — current step" indicator to the progress line and
   * keeps the in-place plan message current for long turns. Digest turns
   * skip the rendering (their output is memory, #42).
   */
  onTodoPhases(data: TodoPhasesEvent): void {
    if (this.digesting) return;
    this.renderTodoPhases(data);
  }

  /**
   * Render seam (issue #228): the base renderer stores the snapshot, then
   * re-renders the live progress line and the plan message. The streaming
   * renderer overrides this to keep the plan message but never touch the
   * panel surface (mirrors renderThinking).
   */
  protected renderTodoPhases(data: TodoPhasesEvent): void {
    this.updateTodoSnapshot(data.phases ?? []);
    this.#renderProgressNow();
  }

  /**
   * Stores the snapshot and re-renders the in-place plan message when the
   * plan qualifies (long turns). Shared by both renderers — the plan
   * message is a separate posted message, independent of the turn's phrase
   * or stream surface.
   */
  protected updateTodoSnapshot(phases: readonly TodoPhase[]): void {
    this.#todoPhases = [...phases];
    this.#renderPlanMessage();
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
    this.#ackedReactions.clear();
    this.cancelStreamUpdate();
    this.#cancelProgressTimer();
    this.#currentStepTitle = undefined;
    this.#latestThinking = undefined;
    this.#lastProgressText = undefined;
    this.streamingTurns = false;
    this.toolStepInFlight = false;
    this.#waitingCount = 0;
    this.#nudged = undefined;
    // Issue #228: the todo snapshot and plan message die with the session —
    // the next cold start re-hydrates the plan from the transcript (the
    // SDK's getTodoPhases) and re-posts the plan message on the next
    // qualifying snapshot.
    this.#todoPhases = [];
    this.#planTs = undefined;
    this.#planPosting = false;
    this.#lastPlanText = undefined;
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
    // Turn-lifecycle INFO (issue #212 follow-up): an inbound that never
    // opens a turn is attributable — adapter drop, service entry, or here.
    console.log(`presenter: openTurn ${this.spaceId}`);
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

  /**
   * Renders one thinking-step card; the phrase renderer has no panel. The
   * plain renderer instead shows the CURRENT step as the in-place progress
   * line (issue #193); the streaming renderer overrides this with the
   * panel's task_update cards (issue #168).
   */
  protected renderToolStep(step: ToolStepEvent): void {
    // A completion clears the current step: the line falls back to the
    // latest thinking snippet or the elapsed phrase until the next step.
    // The in-flight flag (issue #219) gates the steer safe window.
    this.toolStepInFlight = step.status === "in_progress";
    this.#currentStepTitle = step.status === "in_progress" ? step.title : undefined;
    this.#renderProgressNow();
  }

  /** A thinking chunk (issue #193); the phrase renderer shows it live as the 🧠 snippet. */
  protected renderThinking(data: ThinkingEvent): void {
    const thinking = data.thinking?.trim();
    if (!thinking) return;
    this.#latestThinking = this.#tailSnippet(thinking);
    this.#renderProgressNow();
  }

  // -------------------------------------------------------------------------
  // Live progress (issue #193): the in-place phrase becomes a progress line
  // — current tool step ("⚙️ …") > latest thinking snippet ("🧠 …") >
  // elapsed "Thinking… Ns" — coalesced on the STREAM_UPDATE_INTERVAL_MS
  // cadence and replaced by the final reply exactly as before. The elapsed
  // tick keeps the line moving during a silent turn so the user never stares
  // at a frozen phrase.
  // -------------------------------------------------------------------------

  /** The current progress line: step > thinking snippet > elapsed phrase, each carrying the live todo indicator when the plan has >= 2 steps (issue #228). */
  #progressLine(): string {
    const step = this.#currentStepTitle;
    const base =
      step !== undefined
        ? `⚙️ ${this.#headSnippet(step)}`
        : this.#latestThinking !== undefined
          ? `🧠 ${this.#latestThinking}`
          : this.#elapsedPhrase();
    const todo = todoProgressLine(this.#todoPhases);
    const line = todo === undefined ? base : `${base} · ${todo}`;
    return this.#decorate(line);
  }

  /**
   * Appends the queue indicator (issue #219): every visible phrase or
   * progress line carries "+N waiting" while messages queue behind the
   * running turn, so the user knows their message was received and is
   * next. The final reply text never carries it — {@link #replaceOrPost}
   * posts/edits raw text, and the next turn's phrase re-decorates with
   * the remaining count.
   */
  #decorate(line: string): string {
    return this.#waitingCount > 0 ? `${line} — +${this.#waitingCount} waiting` : line;
  }

  /** "Thinking… Ns" — the fallback while no step or thinking has arrived. */
  #elapsedPhrase(): string {
    const base = this.#receivedAt ?? Date.now();
    const seconds = Math.max(0, Math.floor((Date.now() - base) / 1000));
    return `Thinking… ${seconds}s`;
  }

  /** Head-truncates a long value (keeps the tool name of a step title). */
  #headSnippet(text: string): string {
    if (text.length <= THINKING_SNIPPET_MAX) return text;
    return `${text.slice(0, THINKING_SNIPPET_MAX - 1)}…`;
  }

  /** Tail-truncates a long value (keeps the MOST RECENT reasoning, #193). */
  #tailSnippet(text: string): string {
    if (text.length <= THINKING_SNIPPET_MAX) return text;
    return `…${text.slice(-(THINKING_SNIPPET_MAX - 1))}`;
  }

  /**
   * Renders the current progress line in place, coalesced on the cadence.
   * Skipped while the phrase post is in flight (ts unknown): the elapsed
   * tick or the next step/thinking event renders once it lands. Yields to
   * pending real reply text (the streamed answer always wins).
   */
  #renderProgressNow(): void {
    this.#scheduleProgressUpdate(this.#progressLine());
  }

  /**
   * Arms the elapsed tick; one timer per space, no-op while armed. The
   * streaming renderer overrides this to a no-op: the panel owns the
   * stream surface, so the phrase renderer's progress tick must never
   * append elapsed lines to it (issue #193 is the plain path).
   */
  protected armProgressTimer(): void {
    if (this.#progressTimer !== null) return;
    this.#progressTimer = setTimeout(() => {
      this.#progressTimer = null;
      this.#tickProgress();
    }, STREAM_UPDATE_INTERVAL_MS);
    this.#progressTimer.unref?.();
  }

  /**
   * One cadence tick: re-render the priority line (a completed step or a
   * new elapsed second changes it; identical text and pending real reply
   * text are skipped) and re-arm — the tick lives for the whole turn and
   * stops via {@link #cancelProgressTimer} when a real text replaces the
   * phrase.
   */
  #tickProgress(): void {
    if (!this.digesting) this.#renderProgressNow();
    this.armProgressTimer();
  }

  /** Stops the elapsed tick (the phrase was replaced by a delivered text). */
  #cancelProgressTimer(): void {
    if (this.#progressTimer !== null) {
      clearTimeout(this.#progressTimer);
      this.#progressTimer = null;
    }
  }

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
    // Live progress (#193): the elapsed tick keeps the phrase live from the
    // moment the turn opens (armed once; no-op while already running).
    this.armProgressTimer();
    const pendingTs = this.pendingTs;
    if (pendingTs !== undefined) {
      // Live progress (#193) beats rotation (#251): a current tool step or
      // a live reasoning snippet is never replaced by rotating phrase text
      // (a retry's turn_start re-fires after thinking has streamed in, #60).
      // Return WITHOUT cancelStreamUpdate() so a not-yet-flushed 🧠/⚙️ line
      // still lands; the elapsed tick and step/thinking events keep it moving.
      if (this.#currentStepTitle !== undefined || this.#latestThinking !== undefined) {
        return;
      }
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
          console.log(`presenter: phrase posted ${this.spaceId} ${ts}`);
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

  /**
   * Issue #215: posts a FRESH thinking phrase for a message steered into a
   * running turn. The original turn's phrase predates the steer inbound, so
   * a final reply editing it is invisible to any poller filtering by the
   * steer's ts — the steer must own a new line. The fresh phrase threads
   * under the STEER message (lastInboundTs, set by its onInbound) and
   * supersedes the old phrase as the final-reply target (pendingTs). While
   * the post is in flight the old pending ts is CLEARED, so a streamed
   * reply racing the post falls back to the fresh-post edge (issue #120)
   * instead of editing the OLD — invisible — phrase.
   */
  #postSteerPhrase(): void {
    if (this.digesting || this.#churnActive) return;
    if (this.#phrasePosting) return; // a phrase post is in flight — it becomes the pending phrase
    this.#phrasePosting = true;
    // The steer's fresh phrase supersedes the original turn's phrase as the
    // final-reply target: drop the old pending ts now so a coalesced update
    // or streamed reply can never edit the OLD (invisible) phrase.
    this.cancelStreamUpdate();
    this.pendingTs = undefined;
    void this.openTurn(this.#nextPhrase())
      .then((ts) => {
        if (ts !== undefined) {
          this.pendingTs = ts;
          console.log(`presenter: steer phrase posted ${this.spaceId} ${ts}`);
        }
      })
      .catch((err) => {
        console.error(`[slack-turn-presenter] failed to post steer phrase to ${this.spaceId}:`, err);
      })
      .finally(() => {
        this.#phrasePosting = false;
      });
  }

  /** Rotates an already-pending phrase in place; streaming keeps its opening, so it does nothing. */
  protected rotateTurnOpening(pendingTs: string): Promise<void> {
    return this.sendTextChunk(pendingTs, this.#nextPhrase());
  }

  /**
   * The in-place "🛠 Agent's plan" message (issue #228, long turns): posted
   * under the inbound message when a qualifying plan first appears (>= 3
   * steps across >= 2 phases), then EDITED in place on every snapshot as
   * steps complete — one message per space, the same phrase+edit mechanics
   * as the thinking phrase. End-of-turn cleanup: the final state is LEFT as
   * the turn's record (boring option — no delete call, no lost record; the
   * message never shows a stale plan, only the current snapshot). A non-
   * qualifying plan (or none) posts nothing — empty-tolerant. Fail-soft:
   * a posting/editing failure is logged, never thrown into the turn path.
   */
  #renderPlanMessage(): void {
    if (!isLongPlan(this.#todoPhases)) return;
    const text = renderTodoPlan(this.#todoPhases);
    if (text === this.#lastPlanText) return;
    this.#lastPlanText = text;
    const planTs = this.#planTs;
    if (planTs !== undefined) {
      void this.adapter.updateMessage(this.spaceId, planTs, text).catch((err) => {
        console.error(`[slack-turn-presenter] failed to update plan message in ${this.spaceId}:`, err);
      });
      return;
    }
    if (this.#planPosting) return; // in flight — it becomes the plan message
    this.#planPosting = true;
    void this.adapter
      .postMessage(this.spaceId, text, this.replyOpts())
      .then((ts) => {
        if (ts !== undefined) {
          this.#planTs = ts;
          console.log(`presenter: plan message posted ${this.spaceId} ${ts}`);
        }
      })
      .catch((err) => {
        console.error(`[slack-turn-presenter] failed to post plan message to ${this.spaceId}:`, err);
      })
      .finally(() => {
        this.#planPosting = false;
      });
  }

  /** Next rotating phrase (queue-decorated, issue #219); advances the shared rotation. */
  #nextPhrase(): string {
    return this.#decorate(this.#phraseRotation.next());
  }

  /**
   * Receipt ack (issue #119): adds the 👀 reaction to the inbound message
   * and remembers its ts so the reply can remove it. Fail-soft — a missing
   * `reactions:write` scope is logged by the caller's catch, never thrown
   * into the turn path. Deduped by inbound ts (issue #183): Slack
   * redelivers the same message (same ts) and each redelivery used to
   * re-fire the ack into `already_reacted` — one ack per unique ts.
   */
  #addReceiptReaction(msg: SlackMessage): void {
    if (this.#ackedReactions.has(msg.ts)) return;
    this.#ackedReactions.add(msg.ts);
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
          ...(phraseMs !== undefined ? { phrase_ms: phraseMs } : undefined),
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
    // A delivered text (reply / error / churn) supersedes any pending
    // live-progress update AND its elapsed tick (#193): a stale progress
    // line or a late tick must never overwrite what actually landed.
    this.cancelStreamUpdate();
    this.#cancelProgressTimer();
    const pendingTs = this.pendingTs;
    if (pendingTs !== undefined) {
      this.pendingTs = undefined;
      console.log(`presenter: final reply posted/edited ${this.spaceId} ${pendingTs}`);
      void this.sendTextChunk(pendingTs, text).catch((err) => {
        console.error(`[slack-turn-presenter] failed to update reply in ${this.spaceId}:`, err);
      });
      return;
    }
    void this.adapter
      .postMessage(this.spaceId, text, this.replyOpts())
      .then((ts) => {
        if (ts !== undefined) console.log(`presenter: final reply posted/edited ${this.spaceId} ${ts}`);
      })
      .catch((err) => {
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
      // A real reply text supersedes a pending live-progress line (#193):
      // the progress line must never clobber streamed reply text.
      existing.progress = false;
      return;
    }
    const entry: PendingStreamUpdate = { ts: pendingTs, text, progress: false, final: false, retries: 0, timer: null };
    this.#streamUpdate = entry;
    this.#armStreamTimer(entry);
  }

  /**
   * Coalesces a live-progress line (issue #193) on the same cadence as
   * streamed text — but YIELDS to a pending real-text update: the reply is
   * the actual answer, the progress line is decoration. Returns when the
   * line was scheduled; identical lines are skipped.
   */
  #scheduleProgressUpdate(line: string): void {
    if (line === this.#lastProgressText) return;
    const pendingTs = this.pendingTs;
    if (pendingTs === undefined) return; // phrase post still in flight
    const existing = this.#streamUpdate;
    if (existing) {
      if (!existing.progress) return; // real streamed text pending — yield
      existing.text = line; // latest progress line wins; the armed timer stays
    } else {
      const entry: PendingStreamUpdate = { ts: pendingTs, text: line, progress: true, final: false, retries: 0, timer: null };
      this.#streamUpdate = entry;
      this.#armStreamTimer(entry);
    }
    this.#lastProgressText = line;
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
 * Fallback (fail closed): ANY stream call failure — opening, appending, or
 * closing — a workspace without the Agents feature, missing
 * recipient_team_id, a rate limit — switches this renderer to the
 * phrase+edit path PERMANENTLY (per boot) and the adapter remembers the
 * failure, so no turn ever pays the failed call twice and no reply is
 * dropped: the final text lands as a stopStream closing block when the
 * stream is healthy, or as an in-place chat.update when a stream call
 * fails (issue #181).
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
    try {
      await this.adapter.appendText(this.spaceId, ts, text);
    } catch (err) {
      // Any stream failure flips to the phrase path for the boot (issue
      // #181) — and the text still lands: edit the stream message in place.
      this.#streamMode = false;
      console.error(
        `[slack-turn-presenter] chat.appendStream failed in ${this.spaceId} — falling back to phrase+edit for the boot:`,
        err,
      );
      await super.sendTextChunk(ts, text);
    }
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
    if (await this.#stopWithRetry(ts, finalText)) return;
    // stopStream never landed and the closing block was the final reply's
    // only carrier — flip to the phrase path and edit the stream message in
    // place so the reply is NEVER dropped (issue #181).
    this.#streamMode = false;
    if (finalText !== undefined) {
      await super.sendTextChunk(ts, finalText);
    }
  }

  /** Post-turn: close the stream when one is open (error path, no final text). */
  protected async finishTurn(): Promise<void> {
    if (!this.#streamMode || this.#streamTs === undefined) return;
    const ts = this.#streamTs;
    this.#streamTs = undefined;
    this.pendingTs = undefined;
    if (!(await this.#stopWithRetry(ts, undefined))) {
      this.#streamMode = false;
    }
  }

  /** One thinking-step card per gated tool call (issue #168). */
  protected renderToolStep(step: ToolStepEvent): void {
    // The in-flight flag (issue #219) mirrors the base: a mid-tool steer
    // must never interrupt a side-effecting call.
    this.toolStepInFlight = step.status === "in_progress";
    if (!this.#streamMode || this.#streamTs === undefined) return; // no panel in fallback mode
    const ts = this.#streamTs;
    void this.adapter
      .appendTask(this.spaceId, ts, {
        id: step.taskId,
        title: step.title,
        status: step.status,
        ...(step.output !== undefined ? { output: step.output } : undefined),
      })
      .catch((err) => {
        // Any stream failure flips to the phrase path for the boot (issue #181).
        this.#streamMode = false;
        console.error(
          `[slack-turn-presenter] failed to append task step in ${this.spaceId} — falling back to phrase+edit for the boot:`,
          err,
        );
      });
  }

  /**
   * Live thinking (issue #193) is the PLAIN path's progress phrase; the
   * panel renders steps as cards and reply text as stream appends — a
   * reasoning snippet must not pollute the stream, so it renders nothing.
   */
  protected renderThinking(_data: ThinkingEvent): void {}

  /**
   * Live todo (issue #228): the panel owns the turn's live surface, so the
   * phrase renderer's "🛠 N/M" progress line must never append to it
   * (mirrors renderThinking). The in-place plan MESSAGE is a separate
   * posted message and still renders for long turns via the shared
   * snapshot update.
   */
  protected renderTodoPhases(data: TodoPhasesEvent): void {
    this.updateTodoSnapshot(data.phases ?? []);
  }

  /**
   * The panel owns the stream surface: the phrase renderer's elapsed tick
   * must never append "Thinking… Ns" chunks to it (issue #193 is the
   * plain path — DMs and stream fallbacks keep the rotating phrase).
   */
  protected armProgressTimer(): void {}

  /**
   * chat.stopStream with bounded retries (a 429 must not drop the final
   * reply). Resolves true when the stream closed; false after the retries
   * are exhausted, so the caller can fall back to the phrase path instead
   * of dropping the reply (issue #181).
   */
  async #stopWithRetry(ts: string, text: string | undefined): Promise<boolean> {
    let retries = 0;
    for (;;) {
      try {
        await this.adapter.stopStream(this.spaceId, ts, text);
        return true;
      } catch (err) {
        if (retries >= STREAM_FINAL_RETRY_LIMIT) {
          console.error(
            `[slack-turn-presenter] stopStream failed in ${this.spaceId} after ${retries} retries:`,
            err,
          );
          return false;
        }
        retries += 1;
        await new Promise((resolve) => setTimeout(resolve, STREAM_UPDATE_INTERVAL_MS));
      }
    }
  }
}
