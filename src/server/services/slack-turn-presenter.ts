/**
 * SlackTurnPresenter (issue #153 extraction, #168 streaming renderer).
 *
 * Turn rendering for one Slack space, extracted from SpaceService: explicit
 * turn progress, the 👀 receipt reaction, stream coalescing, reply latency
 * audit, churn guard, and threading all live here. SpaceService keeps
 * session/connect/learning/digest lifecycle and delegates every
 * channel-visible effect to the presenter.
 *
 * The base presenter renders one normalized progress snapshot as an
 * in-place text update. StreamTurnPresenter renders that same snapshot as
 * one stable `turn-progress` task card and keeps reply chunks on the stream.
 * StreamTurnPresenter uses `chat.startStream` for channel panels, adds
 * tool task cards alongside the stable progress card, appends reply chunks
 * on the existing cadence, and closes with `chat.stopStream`. DMs remain
 * on the plain one-message path. Capability and request-local failures
 * retain the existing phrase+edit fallback without dropping replies.
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
import { createTurnProgress, renderTurnProgress as renderProgressSnapshot, renderOutcomeSummary, todoStageCounts, type SourceOutcome, type TerminalOutcome, type TurnOutcomeSummary, type TurnProgressSnapshot } from "./slack-progress";
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
  isStreamRequestValidationError,
  slackApiErrorSchema,
  STOP_ACTION_ID,
  type SlackAdapter,
  type SlackApiError,
  type SlackBlockPayload,
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
 * Consecutive empty completions that trip the churn guard (issue #60).
 */
export const EMPTY_TURN_LIMIT = 3;

/**
 * Streaming update cadence (issue #120): dense stream updates and progress
 * edits coalesce to one update per 400ms while final delivery remains
 * guaranteed by the existing bounded flush/retry paths.
 */
export const STREAM_UPDATE_INTERVAL_MS = 400;

/**
 * Bounded retries for FINAL delivery (issue #120). Interim failures wait
 * for turn-end; stopStream failures fall back to phrase+edit.
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
export function emptyResponseFallback(cause: string | undefined, provider?: string): string {
  const remedy = codexMintFailureText(cause, provider);
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
export function churnMessageText(cause: string | undefined, provider?: string): string {
  const remedy = codexMintFailureText(cause, provider);
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
  /** Truthful execution outcome on a terminal step. */
  outcome?: ToolStepOutcome;
  /** Human-readable tool label derived from the tool name at the source. */
  label?: string;
  /** Presentation-safe active progress state. */
  progressState?: "working" | "waiting";
  /** Presentation-safe active progress detail; never raw args or provider errors. */
  progressDetail?: string;
  /** Presentation-safe source label (for example an extension manifest label). */
  sourceLabel?: string;
  /** Redacted args summary (the card's code block); capped by the adapter. */
  output?: string;
}

/** How a gated tool call's TERMINAL card resolved (issue #295). */
export type ToolStepOutcome = "succeeded" | "denied" | "failed";


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

const searchResultPayloadSchema = z.object({
  results: z.array(z.unknown()),
});
const searchResultRowSchema = z
  .object({
    title: z.string().optional(),
    url: z.string(),
    snippet: z.string().optional(),
  })
  .passthrough();

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
): SlackBlockPayload[] {
  const blocks: SlackBlockPayload[] = [
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

/**
 * Fail-closed parse of the search_web tool's JSON result text into the
 * rows a turn actually used (issue #278). The tool emits
 * `{query, count, results:[{title,url,snippet}]}`; this extracts only
 * well-formed rows (a url must be present and string). Malformed or
 * non-search text → `[]` — a turn never posts a half-parsed table or
 * throws into the turn path.
 */
export function parseSearchResultRows(text: string): SearchResultRow[] {
  if (!text) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return [];
  }
  const payload = searchResultPayloadSchema.safeParse(decoded);
  if (!payload.success) return [];
  const rows: SearchResultRow[] = [];
  for (const raw of payload.data.results) {
    const parsed = searchResultRowSchema.safeParse(raw);
    if (!parsed.success || parsed.data.url.trim() === "") continue;
    rows.push({
      title: parsed.data.title ?? parsed.data.url,
      url: parsed.data.url,
      snippet: parsed.data.snippet ?? "",
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Top-level DM lifecycle (issues #295/#296, owner veto #296-reopened, #336): a
// top-level Slack DM (slack:D*) shows EXACTLY ONE PLAIN-TEXT message that
// spans the whole agent request — preamble, tool rounds, retries, and final
// answer all own one message timestamp, updated in place as plain Slack
// text (no attachment wrapper, no color bar, no collapsible content-block
// card). During the request the message carries only TRUSTED status (the
// rotating thinking phrase / live progress line — never raw model
// reasoning, intermediate assistant preambles, or tool internals); at
// request settlement the same timestamp is replaced with the bare final
// answer — no `N actions completed` context line ever, even after succeeded
// tool steps (issue #336).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Presenter
// ---------------------------------------------------------------------------

/**
 * The active-turn Stop control (issue #315): a Block Kit section carrying a
 * danger "Stop" button whose `value` is the space id. Rendered on the
 * turn's card/progress surface while a turn is in flight; clicking it files
 * a `bottega_stop` block action that SpaceService resolves via a per-turn
 * abort. Pure so the surface is unit-testable without Slack.
 */
export function stopControlBlock(spaceId: string): SlackBlockPayload {
  return {
    type: "section",
    text: { type: "mrkdwn", text: "*Running — do you want to stop this turn?*" },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "Stop" },
      action_id: STOP_ACTION_ID,
      value: spaceId,
      style: "danger",
    },
  };
}

export interface TurnPresenterDeps {
  spaceId: string;
  adapter: SlackAdapter;
  /** Audit sink for receipt/reply latency rows + nudge audit rows. */
  store: Store;
  /** Onboarding-check seam. */
  onboardingChecks: () => WizardCheck[];
  /** Mount the active-turn Stop control. */
  stopControl?: boolean;
  /** Active model provider for provider-aware error recovery. */
  provider?: string;
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
   * Principal (Slack user id) of the latest inbound message — the channel
   * stream's recipient_user_id (issue #287). Set alongside
   * {@link lastInboundTs}; undefined until the first inbound (or after
   * dispose), in which case the turn cannot open a channel stream.
   */
  protected lastInboundPrincipal: string | undefined;
  /**
   * The ROOT conversation thread the CURRENT turn's replies must target
   * (issue #289). Set from the inbound message's own `threadTs` when the
   * request is itself a Slack thread reply; undefined for top-level
   * messages (the reply then threads under {@link lastInboundTs} as
   * before). A threaded turn is reaction-only: no thinking placeholder and
   * no stream open — the final/error reply posts as a NEW message under
   * this root, so two requests in one thread never reuse or edit a shared
   * placeholder. Reset on every inbound / queue drain and on dispose.
   */
  protected turnThreadTs: string | undefined;
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
  protected alwaysStream = false;
  /** Pending coalesced streaming update (issue #120). */
  #streamUpdate: PendingStreamUpdate | undefined;
  /** In-flight progress flush (#365): the settle edit queues behind it —
   *  Slack applies same-message updates in arrival order, so a stale
   *  progress line already on the wire would overwrite the reply. */
  #streamInflight: Promise<void> | null = null;
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
  /** Current normalized progress state for this real turn. */
  #progress: TurnProgressSnapshot = createTurnProgress(Date.now());
  /** Whether any external tool work was observed during the turn. */
  #sawExternalWork = false;
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
  /** The session's live todo plan (issue #228): latest driver snapshot. */
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
  /** Whether the active-turn Stop control is enabled for this space. */
  #stopControlEnabled: boolean;
  /** ts of the mounted Stop-control message, cleared on turn end. */
  #stopControlTs: string | undefined;
  /** Onboarding-nudge dedupe snapshot. */
  #nudged: string | undefined;
  /** Requests in flight for a top-level DM. */
  #requestActive = false;
  /** Latest buffered final-assistant message text during a pending DM request. */
  #bufferedDMReply: string | undefined;
  /** Latest buffered session error/fallback during a pending DM request. */
  #bufferedDMError: string | undefined;
  /** Source outcomes observed during this turn, keyed by friendly label. */
  readonly #sourceOutcomes = new Map<string, SourceOutcome>();
  /** Terminal outcome state, retained until the next accepted turn. */
  #terminalOutcome: TerminalOutcome | undefined;
  /** A terminal presenter error remains a problem until a non-empty reply recovers it. */
  #sawError = false;
  /** A user stop wins over every later event for this turn. */
  #stopped = false;
  /** Current source waiting for reauthorization; elapsed ticks must not clear it. */
  #sourceWaitingLabel: string | undefined;
  /** Latest raw streamed answer, retained after interim updates flush. */
  #streamedAnswer: string | undefined;
  /** Latest visible empty-response fallback retained for turn-end delivery. */
  #emptyResponseText: string | undefined;
  /** Active model provider for provider-aware error recovery. */
  readonly #provider: string | undefined;

  constructor(deps: TurnPresenterDeps) {
    this.spaceId = deps.spaceId;
    this.adapter = deps.adapter;
    this.#store = deps.store;
    this.#onboardingChecks = deps.onboardingChecks;
    this.#stopControlEnabled = deps.stopControl ?? false;
    this.#provider = deps.provider;
  }

  /**
   * Receipt (issue #119): ack the inbound with the 👀 reaction and audit
   * the message.in row — the queue-time receipt for EVERY inbound, whether
   * the message starts a turn now, steers, or queues behind a running
   * turn. Identity activation is deliberately NOT part of the receipt: a
   * queued message must never retarget the running turn's reply target or
   * open a placeholder for a turn that has not started (issue #289). Each
   * call is fire-and-forget: the turn path never blocks on Slack latency
   * or a missing reactions:write scope.
   */
  receipt(msg: SlackMessage): void {
    this.#addReceiptReaction(msg);
    this.#auditReceipt(msg);
  }

  /**
   * Receipt + identity activation in one call — the shape an inbound that
   * STARTS a turn takes (turn-start simulation, tests). SpaceService uses
   * {@link receipt} at queue time and {@link activateInbound} only when
   * the message actually starts a fresh or steered turn.
   */
  onInbound(msg: SlackMessage): void {
    this.receipt(msg);
    this.activateInbound(msg);
  }

  /**
   * Activates the inbound identity as the current turn's surface.
   */
  activateInbound(msg: SlackMessage): void {
    this.lastInboundTs = msg.ts;
    this.lastInboundPrincipal = msg.principal;
    this.turnThreadTs = msg.threadTs;
    this.#resetTurnProgress();
    this.#resetTurnOutcome();
    this.#requestActive = this.#dmTopLevel;
    this.#bufferedDMReply = undefined;
    this.#bufferedDMError = undefined;
    if (this.turnThreadTs === undefined) {
      this.#postThinkingPhrase();
    } else {
      this.#turnDelivered = false;
      this.pendingTs = undefined;
    }
  }

  /** Records a verified terminal outcome for one friendly source label. */
  onSourceOutcome(source: SourceOutcome): void {
    const label = source.label.trim();
    if (label === "") return;
    if (!this.#canRecordSource(label, source.state)) return;
    this.#sourceOutcomes.set(label, { ...source, label });
    if (this.#sourceWaitingLabel === label && source.state !== "needs_reauthorization") {
      this.#sourceWaitingLabel = undefined;
      if (this.#progress.state === "waiting" && this.#progress.detail === `${label} needs reauthorization`) {
        this.#setProgress("finishing", "Preparing the response");
      } else {
        this.#normalizeProgressFromEvidence();
      }
    }
  }

  /** Records current sanitized reauthorization evidence and pins waiting progress. */
  onSourceWaiting(label: string, action?: string): void {
    const friendly = label.trim();
    if (friendly === "") return;
    if (!this.#canRecordSource(friendly, "needs_reauthorization")) return;
    const outcome: SourceOutcome = {
      label: friendly,
      state: "needs_reauthorization",
    };
    if (action !== undefined) outcome.action = action;
    this.#sourceOutcomes.set(friendly, outcome);
    this.#sourceWaitingLabel = friendly;
    this.#setProgress("waiting", `${friendly} needs reauthorization`);
  }

  /** Marks this turn stopped before aborting the driver session. */
  onStopped(): void {
    this.#stopped = true;
    this.#terminalOutcome = "stopped";
  }

  /** Clears a provisional stop when the driver abort fails before settlement. */
  clearStopped(): void {
    this.#stopped = false;
    this.#terminalOutcome = undefined;
  }

  /** The latest inbound message ts (digest marker base, #42). */
  latestInboundTs(): string | undefined {
    return this.lastInboundTs;
  }

  /** turn_start advances an accepted turn to planning; evidence states win. */
  onTurnStart(): void {
    this.#mountStopControl();
    if (this.#progress.state === "accepted") this.#setProgress("planning", "Building the work plan");
    this.#postThinkingPhrase();
  }

  /** A message event: stream/coalesce or replace the phrase with the reply text. */
  onMessage(data: MessageEvent): void {
    if (this.digesting) return;
    const text = data.text;
    if (text === undefined) return;
    this.#turnDelivered = true;
    // A non-empty answer recovers a prior error, but never a user stop.
    if (text.trim()) {
      this.#sawError = false;
      if (!this.#stopped) this.#terminalOutcome = "complete";
    }
    // Issue #296: a top-level DM REQUEST is pending — the opening prompt
    // has not settled. Intermediate assistant message events (the
    // speculative preamble) and the final answer are BUFFERED, never
    // posted: the one status message stays up until settlement.
    if (this.#dmTopLevel && this.#requestActive) {
      this.cancelStreamUpdate();
      this.#cancelProgressTimer();
      if (!text.trim()) {
        const cause = data.error?.trim() || undefined;
        this.#emptyTurnCount = this.#emptyTurnCount + 1;
        this.#bufferedDMError =
          this.#emptyTurnCount > EMPTY_TURN_LIMIT ? churnMessageText(cause, this.#provider) : emptyResponseFallback(cause, this.#provider);
        if (this.#emptyTurnCount > EMPTY_TURN_LIMIT) this.#churnActive = true;
        return;
      }
      this.#emptyTurnCount = 0;
      this.#churnActive = false;
      this.#bufferedDMReply = text;
      this.#bufferedDMError = undefined;
      return;
    }
    if (!text.trim()) {
      // Empty completion (#60): surface a visible fallback so the retry
      // loop is never silent, and count it for the churn guard.
      const cause = data.error?.trim() || undefined;
      const fallback = emptyResponseFallback(cause, this.#provider);
      this.#emptyResponseText = fallback;
      this.#countEmptyTurn(cause);
      if (!this.#churnActive) {
        this.cancelStreamUpdate();
        this.#cancelProgressTimer();
        const pendingTs = this.pendingTs;
        if (pendingTs !== undefined) {
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
      this.#streamedAnswer = text;
      this.#scheduleStreamUpdate(text);
      return;
    }
    // The reply landed: the receipt reaction comes off and the reply
    // latency is audited (issue #119).
    this.#replaceOrPost(this.#withOutcomeSummary(text));
    this.#clearReactions();
    this.#auditReply();
  }

  /** Session error: surface it by replacing the phrase in place (or appending + closing the stream). */
  onError(data: ErrorEvent): void {
    console.error(`[slack-turn-presenter] session error (${this.spaceId}):`, data);
    if (this.digesting) return;
    this.#turnDelivered = true;
    if (!this.#stopped) this.#terminalOutcome = "failed";
    this.#sawError = !this.#stopped;
    // Issue #296: a pending top-level DM request buffers the error too.
    if (this.#dmTopLevel && this.#requestActive) {
      this.cancelStreamUpdate();
      this.#cancelProgressTimer();
      const base = codexMintFailureText(data.message, this.#provider) ?? data.message ?? "Something went wrong while thinking.";
      this.#bufferedDMError = base;
      return;
    }
    this.cancelStreamUpdate();
    this.streamingTurns = false;
    this.#emptyTurnCount = 0;
    this.#churnActive = false;
    const base = codexMintFailureText(data.message, this.#provider) ?? data.message ?? "Something went wrong while thinking.";
    console.log(`presenter: turn error ${this.spaceId} ${base.replaceAll("\n", " ")}`);
    this.#replaceOrPost(this.#withOutcomeSummary(this.#nudgeText(base)));
    this.#clearReactions();
    this.#auditReply();
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
    // A top-level DM's per-round turn_end is not terminal.
    if (this.#dmTopLevel && this.#requestActive) {
      return;
    }
    if (!this.#turnDelivered) {
      this.#countEmptyTurn(data.error?.trim() || undefined);
    }
    if (data.error?.trim() && !this.#stopped) {
      this.#sawError = true;
      this.#terminalOutcome = "failed";
    }
    const rawFinalText =
      this.#streamedAnswer ??
      this.#emptyResponseText ??
      (!this.#turnDelivered && data.error?.trim() ? emptyResponseFallback(data.error.trim(), this.#provider) : this.#latestStreamedText());
    const finalText = this.#withOutcomeSummary(rawFinalText);
    const streaming = this.streamingTurns || this.alwaysStream;
    if (!streaming && this.#stopped && !this.#turnDelivered && finalText !== undefined) {
      this.#replaceOrPost(finalText);
    }
    const finalized = this.finalizeTurn(finalText);
    if (streaming) {
      this.#clearReactions();
      this.#auditReply();
    }
    this.streamingTurns = false;
    this.#clearStopControl();
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
    // Issue #296: a steered top-level DM keeps its ONE card — the steer
    // continues the same pending request, so no fresh steer phrase posts
    // (the opening card already spans the whole request); it only marks
    // the turn streaming so live progress coalesces.
    if (streaming && !this.alwaysStream && !this.isDmRequestPending()) {
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
   * Whether a top-level DM REQUEST is currently pending (issue #296):
   * true from a top-level DM turn's open until its opening
   * `session.prompt` promise settles. SpaceService uses this to gate the
   * per-round {@link onTurnEnd} queue drain — a DM queue must not start a
   * second request while the first is still mid-loop (the SDK emits
   * turn_end after every tool round). Channels/threads always report
   * false; their turn_end stays the request boundary.
   */
  isDmRequestPending(): boolean {
    return this.#requestActive && this.#dmTopLevel;
  }

  /**
   * The true end of a top-level DM request (issue #296): called by
   * SpaceService AFTER the opening `session.prompt(...)` promise settles —
   * the SDK agent loop's per-round `turn_end` events are NOT the request
   * end. Replaces the one plain-text status card (that same timestamp) with
   * the bare FINAL answer (no `N actions completed` context line ever,
   * issue #336), or with the buffered error/fallback when the request ended
   * without a real reply. Clears the pending-request state and resolves the
   * receipt reaction + latency audit. Idempotent: only the FIRST call
   * settles (a steered request's prompt and the original prompt both
   * resolve on the single underlying run, so both paths call this; the
   * second is a no-op that reports false so the queue drains exactly once).
   */
  onRequestSettled(): boolean {
    if (!this.#dmTopLevel || !this.#requestActive) return false;
    this.#requestActive = false;
    this.cancelStreamUpdate();
    this.#cancelProgressTimer();
    const pendingTs = this.pendingTs;
    this.pendingTs = undefined;
    // The final answer wins over a buffered error (an SDK recovery after an
    // error); the reply (or error) lands as plain text (issue #295/#336).
    const reply = this.#bufferedDMReply;
    const error = this.#bufferedDMError;
    this.#bufferedDMReply = undefined;
    this.#bufferedDMError = undefined;
    // Plain-text final: exactly the answer (or error). No count line, no
    // attachment, no color bar, no Block Kit — top-level DMs render as a
    // normal Slack text message (owner veto #296-reopened, #336).
    const text = this.#withOutcomeSummary(reply ?? error ?? "Done.");
    if (pendingTs !== undefined) {
      // Settle the SAME timestamp: one message per accepted top-level DM
      // request, updated in place across every internal round.
      console.log(`presenter: final reply posted/edited ${this.spaceId} ${pendingTs}`);
      // Issue #365: a progress flush already on the wire must LAND before
      // the final edit — same-message updates apply in arrival order.
      const inflight = this.#streamInflight ?? Promise.resolve();
      void inflight
        .then(() => this.adapter.updateMessage(this.spaceId, pendingTs, text))
        .catch((err) => {
          console.error(`[slack-turn-presenter] failed to update DM reply in ${this.spaceId}:`, err);
        });
    } else {
      void this.adapter
        .postMessage(this.spaceId, text, this.replyOpts())
        .then((ts) => {
          if (ts !== undefined) console.log(`presenter: final reply posted/edited ${this.spaceId} ${ts}`);
        })
        .catch((err) => {
          console.error(`[slack-turn-presenter] failed to post DM reply to ${this.spaceId}:`, err);
        });
    }
    // The final answer/error landed: the receipt reaction comes off and
    // the reply latency is audited (issue #119).
    this.#clearReactions();
    this.#auditReply();
    return true;
  }

  /**
   * Queue length decorates the active progress state.
   */
  setQueueLength(count: number): void {
    this.#waitingCount = Math.max(0, count);
    if (!this.digesting && !this.#turnDelivered) this.#renderProgressNow();
  }

  /** A queued message starts a fresh normalized turn. */
  onQueueDrain(msgTs: string, principal: string, rootThreadTs?: string): void {
    this.lastInboundTs = msgTs;
    this.lastInboundPrincipal = principal;
    this.turnThreadTs = rootThreadTs;
    this.#resetTurnProgress();
    this.#resetTurnOutcome();
    this.#requestActive = this.#dmTopLevel;
    this.#bufferedDMReply = undefined;
    this.#bufferedDMError = undefined;
    if (this.turnThreadTs === undefined) {
      this.#postThinkingPhrase();
    } else {
      this.#turnDelivered = false;
      this.pendingTs = undefined;
    }
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
    if (step.status === "complete" && step.sourceLabel !== undefined && step.outcome !== undefined) {
      const state = step.outcome === "succeeded" ? "complete" : step.outcome === "denied" ? "blocked" : "failed";
      this.onSourceOutcome({ label: step.sourceLabel, state });
    }
    this.renderToolStep(step);
  }

  /**
   * Cited search results a turn actually used (issue #278): posts exactly
   * ONE cited table (header + rows + a "Sources used" section) to the
   * turn's thread — the acceptance that the citations reach the human,
   * not just JSON to the model. Fail closed at the call site: this method
   * renders whatever rows it is handed; the dispatch only ever hands it
   * {@link parseSearchResultRows} output (already well-formed URLs). Digest
   * turns skip it (their output is memory, #42). Never throws into the
   * turn path — a Slack post failure is logged and dropped.
   */
  presentSearchResults(results: readonly SearchResultRow[]): void {
    if (this.digesting) return;
    const blocks = renderSearchResultBlocks(results);
    void this.adapter
      .postMessage(this.spaceId, "Search results (cited)", { ...this.replyOpts(), blocks })
      .catch((err) => console.error("[search-results] cited table post failed:", err));
  }

  /** Thinking is intentionally a surface no-op: raw reasoning never renders. */
  onThinking(_data: ThinkingEvent): void {}

  /** Todo snapshots normalize progress and update the plan surface. */
  onTodoPhases(data: TodoPhasesEvent): void {
    if (this.digesting) return;
    if ((data.phases?.length ?? 0) > 0 && this.#sourceWaitingLabel !== undefined) {
      this.#sourceWaitingLabel = undefined;
    }
    this.renderTodoPhases(data);
  }

  /** Render seam shared by phrase and stream presenters. */
  protected renderTodoPhases(data: TodoPhasesEvent): void {
    this.updateTodoSnapshot(data.phases ?? []);
  }

  /** Stores todos and derives the visible state from their evidence. */
  protected updateTodoSnapshot(phases: readonly TodoPhase[]): void {
    this.#todoPhases = [...phases];
    this.#normalizeProgressFromEvidence();
    this.#renderPlanMessage();
  }


  /**
   * True for a TOP-LEVEL (non-threaded) Slack DM — the single-status-card
   * surface (issue #295): exactly one evolving card per turn, no separate
   * plan message, no raw model reasoning, and the completed-action footer.
   * Channels (C/G) and threaded turns (any space) keep their existing
   * surfaces untouched.
   */
  get #dmTopLevel(): boolean {
    return this.turnThreadTs === undefined && isDmChannel(channelFromSpaceId(this.spaceId));
  }

  /**
   * DMs read naturally as a plain message — no thread. Team channels (C/G)
   * keep replies threaded: under the conversation ROOT when the request
   * was itself a thread reply (issue #289), otherwise under the inbound
   * message (issue #40).
   */
  replyOpts(): { threadTs?: string } | undefined {
    if (isDmChannel(channelFromSpaceId(this.spaceId))) return undefined;
    const threadTs = this.turnThreadTs ?? this.lastInboundTs;
    return threadTs === undefined ? undefined : { threadTs };
  }

  /**
   * Posts ONE Slack-native data-visualization (type: chart) block into the
   * turn's thread (issue #276). Exactly one blocks-bearing message per call —
   * the render_chart tool posts once per result, never per streamed chunk.
   * Reuses the adapter's postMessage blocks path and the SAME threading rule
   * as replyOpts(), so the chart lands beside the reply (DMs post plainly).
   * Fire-and-forget: a Slack failure logs and never throws into the turn.
   */
  postChartBlock(block: SlackBlockPayload): void {
    void this.adapter
      .postMessage(this.spaceId, "", { ...this.replyOpts(), blocks: [block] })
      .catch((err) => {
        console.error(`[slack-turn-presenter] failed to post chart in ${this.spaceId}:`, err);
      });
  }

  dispose(): void {
    this.lastInboundTs = undefined;
    this.lastInboundPrincipal = undefined;
    this.turnThreadTs = undefined;
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
    this.streamingTurns = false;
    this.toolStepInFlight = false;
    this.#waitingCount = 0;
    this.#nudged = undefined;
    this.#resetTurnProgress();
    this.#resetTurnOutcome();
    this.#todoPhases = [];
    this.#planTs = undefined;
    this.#planPosting = false;
    this.#lastPlanText = undefined;
    this.#requestActive = false;
    this.#bufferedDMReply = undefined;
    this.#bufferedDMError = undefined;
    this.#clearStopControl();
  }

  /**
   * Mounts the active-turn Stop control.
   */
  #mountStopControl(): void {
    if (!this.#stopControlEnabled) return;
    if (this.#stopControlTs !== undefined) return; // already mounted (auto-retry)
    void this.adapter
      .postMessage(this.spaceId, "", {
        ...this.replyOpts(),
        blocks: [stopControlBlock(this.spaceId)],
      })
      .then((ts) => {
        if (ts !== undefined) this.#stopControlTs = ts;
      })
      .catch((err) => {
        console.error(`[slack-turn-presenter] stop control mount failed in ${this.spaceId}:`, err);
      });
  }

  /**
   * Clears the mounted Stop control (issue #315): the turn settled (normal
   * end, error, or user Stop), so the button must not linger clickable.
   * Best-effort edit to an empty block list; on failure the button stays
   * but is a harmless no-op (stopTurn rejects non-streaming turns). Also
   * forgets the control ts so the next turn mounts a fresh one.
   */
  #clearStopControl(): void {
    const ts = this.#stopControlTs;
    this.#stopControlTs = undefined;
    if (ts === undefined) return;
    void this.adapter
      .updateMessage(this.spaceId, ts, "", { blocks: [] })
      .catch((err) => {
        console.error(`[slack-turn-presenter] stop control clear failed in ${this.spaceId}:`, err);
      });
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
    const opts = this.replyOpts();
    // Plain text everywhere: a top-level DM's opening line and a channel's
    // thinking phrase are the SAME surface — one normal Slack text message
    // (no attachment wrapper, no color bar; owner veto #296-reopened). The
    // final answer replaces this same timestamp.
    return this.adapter.postMessage(this.spaceId, openingText, opts);
  }

  /**
   * One text chunk to the turn's message. Phrase: chat.update in place.
   * Streaming: chat.appendStream markdown_text. Always plain text — the DM
   * status surface is a normal message body (no attachment container;
   * owner veto #296-reopened). Not async in the base for the same
   * microtask-timing reason as {@link openTurn}.
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
  protected async finalizeTurn(finalText: string | undefined): Promise<void> {
    // A stream request can fall back to the phrase renderer for this turn.
    // In that mode the final carrier is the pending phrase edit, so the
    // already-rendered answer and outcome summary must replace any buffered
    // interim update together.
    if (finalText !== undefined && this.pendingTs !== undefined) {
      this.#cancelProgressTimer();
      const pending = this.#streamUpdate;
      if (pending !== undefined) {
        pending.text = finalText;
        pending.progress = false;
        pending.final = true;
        pending.retries = 0;
        if (pending.timer !== null) {
          clearTimeout(pending.timer);
          pending.timer = null;
        }
        return this.#flushStreamUpdate();
      }
      await this.sendTextChunk(this.pendingTs, finalText);
      return;
    }
    return this.#finalizeStreamUpdate();
  }

  /** Post-turn cleanup; streaming closes the stream here. */
  protected async finishTurn(): Promise<void> {}
  #resetTurnProgress(): void {
    this.#progress = createTurnProgress(Date.now());
    this.#sawExternalWork = false;
    this.#todoPhases = [];
    this.#lastProgressText = undefined;
    this.toolStepInFlight = false;
  }
  #resetTurnOutcome(): void {
    this.#sourceOutcomes.clear();
    this.#terminalOutcome = undefined;
    this.#sawError = false;
    this.#stopped = false;
    this.#sourceWaitingLabel = undefined;
    this.#streamedAnswer = undefined;
    this.#emptyResponseText = undefined;
  }
  #canRecordSource(label: string, state: SourceOutcome["state"]): boolean {
    return !(this.#sourceOutcomes.get(label)?.state === "complete" && state === "needs_reauthorization");
  }

  #deriveTerminalOutcome(): TerminalOutcome {
    if (this.#stopped || this.#terminalOutcome === "stopped") return "stopped";
    const sources = [...this.#sourceOutcomes.values()];
    const hasSuccess = sources.some((source) => source.state === "complete");
    const hasFailed = sources.some((source) => source.state === "failed");
    const hasBlocked = sources.some(
      (source) => source.state === "blocked" || source.state === "needs_reauthorization" || source.state === "skipped",
    );
    if (hasSuccess && (hasFailed || hasBlocked || this.#sawError)) return "partial";
    if (hasFailed || this.#sawError) return "failed";
    if (hasBlocked) return "blocked";
    return "complete";
  }

  #withOutcomeSummary(text: string): string;
  #withOutcomeSummary(text: string | undefined): string | undefined;
  #withOutcomeSummary(text: string | undefined): string | undefined {
    const outcome = this.#deriveTerminalOutcome();
    this.#terminalOutcome = outcome;
    const summary: TurnOutcomeSummary = {
      outcome,
      elapsedMs: Date.now() - this.#progress.startedAt,
      sources: [...this.#sourceOutcomes.values()],
    };
    const rendered = renderOutcomeSummary(summary);
    if (rendered === undefined) return text;
    return text === undefined || text === "" ? rendered : `${text}\n\n${rendered}`;
  }

  /** Normalizes tool evidence and renders explicit progress. */
  protected renderToolStep(step: ToolStepEvent): void {
    this.toolStepInFlight = step.status === "in_progress";
    if (step.status === "in_progress") {
      const waitingForApproval =
        step.progressState === "waiting" || (step.progressState === undefined && step.title.toLowerCase().includes("waiting for approval"));
      if (!waitingForApproval) this.#sawExternalWork = true;
      this.#setProgress(
        step.progressState ?? (waitingForApproval ? "waiting" : "working"),
        step.progressDetail ?? (waitingForApproval ? "Waiting for approval" : step.label ?? "External work"),
      );
      return;
    }
    this.#normalizeProgressFromEvidence();
  }

  /** Formats normalized progress with the current queue count. */
  protected progressText(progress: TurnProgressSnapshot): string {
    return renderProgressSnapshot(progress, Date.now(), this.#waitingCount);
  }

  /** Render current state through the surface-specific seam. */
  protected renderTurnProgress(progress: TurnProgressSnapshot): void {
    this.#scheduleProgressUpdate(this.progressText(progress));
  }

  /** Replays progress after an opening surface receives its timestamp. */
  protected replayTurnProgress(): void {
    this.#lastProgressText = undefined;
    this.#renderProgressNow();
  }

  /** Updates normalized state while preserving turn start and evidence. */
  #setProgress(state: TurnProgressSnapshot["state"], detail?: string): void {
    const counts = todoStageCounts(this.#todoPhases);
    this.#progress = {
      ...this.#progress,
      state,
      ...(detail === undefined ? { detail: undefined } : { detail }),
      ...(counts === undefined
        ? { completedStages: undefined, totalStages: undefined }
        : { completedStages: counts.completed, totalStages: counts.total }),
      lastMeaningfulProgressAt: Date.now(),
    };
    this.#renderProgressNow();
  }

  /** Derives waiting/working/finishing state from tool and todo evidence. */
  #normalizeProgressFromEvidence(): void {
    const tasks = this.#todoPhases.flatMap((phase) => phase.tasks);
    const active = tasks.find((task) => task.status === "in_progress") ?? tasks.find((task) => task.status === "pending");
    const blocked = tasks.find((task) => task.status === "blocked");
    if (this.toolStepInFlight) {
      this.#setProgress("working", this.#progress.detail);
    } else if (blocked !== undefined) {
      this.#setProgress("waiting", blocked.blocker ?? blocked.content);
    } else if (
      this.#sawExternalWork &&
      tasks.every((task) => task.status === "completed" || task.status === "abandoned")
    ) {
      this.#setProgress("finishing", "Preparing the response");
    } else if (this.#sawExternalWork || tasks.length > 0) {
      this.#setProgress("working", active?.content ?? "Completing the request");
    } else {
      this.#renderProgressNow();
    }
  }

  #renderProgressNow(): void {
    const text = renderProgressSnapshot(this.#progress, Date.now(), this.#waitingCount);
    if (text === this.#lastProgressText) return;
    this.#lastProgressText = text;
    this.renderTurnProgress(this.#progress);
  }

  protected armProgressTimer(): void {
    if (this.#progressTimer !== null) return;
    this.#progressTimer = setTimeout(() => {
      this.#progressTimer = null;
      this.#tickProgress();
    }, STREAM_UPDATE_INTERVAL_MS);
    this.#progressTimer.unref?.();
  }

  #tickProgress(): void {
    if (!this.digesting) this.#renderProgressNow();
    this.armProgressTimer();
  }

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
    // Issue #289: threaded turns are reaction-only — no placeholder
    // message, no stream open. The final reply posts as a NEW message
    // under the conversation root; a placeholder would become a stale
    // edit target that a later request in the same thread must not reuse.
    if (this.turnThreadTs !== undefined) return;
    this.#turnDelivered = false;
    if (this.#churnActive) return;
    const pendingTs = this.pendingTs;
    if (pendingTs !== undefined) {
      this.cancelStreamUpdate();
      this.replayTurnProgress();
      return;
    }
    if (this.#phrasePosting) return; // in flight — it becomes the phrase
    this.#phrasePosting = true;
    void this.openTurn(renderProgressSnapshot(this.#progress, Date.now(), this.#waitingCount))
      .then((ts) => {
        if (ts !== undefined && !this.#turnDelivered) {
          this.pendingTs = ts;
          this.armProgressTimer();
          this.replayTurnProgress();
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
    // Issue #289: a steered message inside a thread is reaction-only like
    // any other threaded request — no placeholder; the combined turn's
    // reply posts fresh under the root.
    if (this.turnThreadTs !== undefined) return;
    if (this.#phrasePosting) return; // a phrase post is in flight — it becomes the pending phrase
    this.#phrasePosting = true;
    // The steer's fresh phrase supersedes the original turn's phrase as the
    // final-reply target: drop the old pending ts now so a coalesced update
    // or streamed reply can never edit the OLD (invisible) phrase.
    this.cancelStreamUpdate();
    this.pendingTs = undefined;
    void this.openTurn(renderProgressSnapshot(this.#progress, Date.now(), this.#waitingCount))
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
    // #295: a top-level DM is ONE status card — the long-plan message would
    // be a second surface. The todo progress folds into the single card's
    // line (the 🛠 N/M indicator) instead; no separate plan message posts.
    if (this.#dmTopLevel) return;
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
    const flight = (async () => {
      try {
        // Plain text everywhere: a top-level DM's live progress and a
        // channel's streamed text are the SAME in-place plain-text edit (no
        // attachment card; owner veto #296-reopened).
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
    })();
    this.#streamInflight = flight;
    try {
      await flight;
    } finally {
      if (this.#streamInflight === flight) this.#streamInflight = null;
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

  /** The latest raw streamed answer, whether or not its coalesced update flushed. */
  #latestStreamedText(): string | undefined {
    return this.#streamUpdate?.text ?? this.#streamedAnswer;
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
    this.#replaceOrPost(this.#nudgeText(churnMessageText(cause, this.#provider)));
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
 * Fallback (fail closed): a scope/token-level stream call failure —
 * opening, appending, or closing — a workspace without the Agents
 * feature, a rate limit — switches this renderer to the phrase+edit path
 * PERMANENTLY (per boot) and the adapter remembers the failure, so no
 * turn ever pays the failed call twice and no reply is dropped: the final
 * text lands as a stopStream closing block when the stream is healthy, or
 * as an in-place chat.update when a stream call fails (issue #181).
 * Channel turns without an initiating user, and REQUEST-local rejections
 * (missing/invalid recipient or thread args, issue #287), fall back for
 * THAT TURN only — streaming stays enabled, so the next turn with a valid
 * recipient opens a fresh panel.
 */
export class StreamTurnPresenter extends SlackTurnPresenter {
  /** ts of the OPEN stream; undefined between turns / after a fallback. */
  #streamTs: string | undefined;
  /**
   * False once a scope/token-level stream call failed: the phrase renderer
   * takes over for the boot. Request-local rejections never flip it
   * (issue #287) — the per-turn fallback is keyed off `#streamTs`.
   */
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
   * top-level posts). Channel streams require the initiating user as the
   * recipient (issue #287): with no identity the turn bypasses streaming —
   * phrase+edit posts without ever attempting chat.startStream. A failed
   * open falls back to the phrase post — the reply path never depends on
   * streaming. A REQUEST-local rejection (missing/invalid recipient or
   * thread args) falls back for THIS turn only; streaming stays enabled
   * for later turns, while a scope/token-level failure flips the renderer
   * to the phrase path for the boot.
   */
  protected async openTurn(openingText: string): Promise<string | undefined> {
    if (!this.#streamMode || !this.adapter.streamingSupported()) return super.openTurn(openingText);
    // Issue #289: a threaded request's stream (when one opens at all —
    // threaded turns are reaction-only, so this is the steer/top-level
    // path) targets the conversation ROOT, never the latest inbound reply.
    const threadTs = this.turnThreadTs ?? this.lastInboundTs;
    if (threadTs === undefined) return super.openTurn(openingText);
    // Channel streams NEED the initiating user as recipient_user_id (issue
    // #287): without it the request is invalid, so streaming is bypassed
    // for this turn — the phrase+edit path posts, never a startStream call.
    const recipientUserId = this.lastInboundPrincipal;
    if (recipientUserId === undefined) return super.openTurn(openingText);
    try {
      const ts = await this.adapter.startStream(this.spaceId, { threadTs, openingText, recipientUserId });
      if (ts !== undefined) {
        this.#streamTs = ts;
        this.replayTurnProgress();
      }
      return ts;
    } catch (err) {
      const parsedError = slackApiErrorSchema.safeParse(err);
      const apiError: SlackApiError = parsedError.success
        ? parsedError.data
        : err instanceof Error
          ? err
          : undefined;
      if (isStreamRequestValidationError(apiError)) {
        // The REQUEST was rejected for this message (missing/invalid
        // recipient or thread args) — not a workspace capability failure:
        // fall back to phrase+edit for THIS turn and keep streaming
        // enabled so a later valid request can still open a panel (issue
        // #287).
        console.error(
          `[slack-turn-presenter] chat.startStream rejected this request in ${this.spaceId} — ` +
            "phrase+edit for this turn; streaming stays enabled:",
          err,
        );
        return super.openTurn(openingText);
      }
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
    // #streamTs guards the per-turn surface: a turn whose stream never
    // opened (missing recipient, request rejection, or a boot fallback)
    // edits the phrase in place — appendStream can never target a plain
    // post, and a per-turn fallback must not flip streaming off for the
    // boot (issue #287).
    if (!this.#streamMode || this.#streamTs === undefined) return super.sendTextChunk(ts, text);
    try {
      await this.adapter.appendText(this.spaceId, ts, text);
    } catch (err) {
      this.#streamMode = false;
      this.pendingTs = ts;
      console.error(
        `[slack-turn-presenter] chat.appendStream failed in ${this.spaceId} — falling back to phrase+edit for the boot:`,
        err,
      );
      await super.sendTextChunk(ts, text);
    }
  }

  protected async finalizeTurn(finalText: string | undefined): Promise<void> {
    if (!(this.#streamMode && this.#streamTs !== undefined)) {
      // Boot-fallback mode (#streamMode false) keeps the pending ts so the
      // phrase rotates in place across turns (one-message rule). A per-turn
      // fallback keeps streaming enabled, so its phrase must NOT become the
      // next turn's rotating opening — clear it and let the next turn open
      // a fresh stream (issue #287).
      await super.finalizeTurn(finalText);
      if (this.#streamMode) this.pendingTs = undefined;
      return;
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
    this.pendingTs = ts;
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

  /** Render all normalized states through one stable stream task card. */
  protected renderTurnProgress(progress: TurnProgressSnapshot): void {
    if (!this.#streamMode || this.#streamTs === undefined) {
      super.renderTurnProgress(progress);
      return;
    }
    const title = this.progressText(progress);
    void this.adapter
      .appendTask(this.spaceId, this.#streamTs, { id: "turn-progress", title, status: "in_progress" })
      .catch((err) => {
        this.#streamMode = false;
        this.pendingTs = this.#streamTs;
        console.error(`[slack-turn-presenter] failed to append progress in ${this.spaceId}:`, err);
      });
  }

  /** Normalize shared state before adding a stream-specific tool card. */
  protected renderToolStep(step: ToolStepEvent): void {
    super.renderToolStep(step);
    if (!this.#streamMode || this.#streamTs === undefined) return;
    const ts = this.#streamTs;
    void this.adapter
      .appendTask(this.spaceId, ts, {
        id: step.taskId,
        title: step.label ?? "External action",
        status: step.status,
        ...(step.output !== undefined ? { output: step.output } : undefined),
      })
      .catch((err) => {
        this.#streamMode = false;
        console.error(
          `[slack-turn-presenter] failed to append task step in ${this.spaceId} — falling back to phrase+edit for the boot:`,
          err,
        );
      });
  }

  /** Todo normalization is shared; stream rendering uses the progress seam. */
  protected renderTodoPhases(data: TodoPhasesEvent): void {
    super.renderTodoPhases(data);
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
