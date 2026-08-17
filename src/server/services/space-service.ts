import { createHash } from "node:crypto";
import { spaceAgentToolNames, type AgentDriver, type AgentSessionDriver, type SessionModelRoleRegistry } from "../drivers/agent-driver";
import { ADMIN_ONBOARDING_NUDGE_EVENT, DIGEST_FAILED_EVENT, MESSAGE_DROPPED_EVENT, MESSAGE_RECEIVED_EVENT, MESSAGE_REPLIED_EVENT, OBJECT_ATTACHED_EVENT } from "../../store/audit-events";
import type { Store } from "../../store/db";
import type { MemoryProvider } from "../../memory/types";
import type { AuditModule } from "../../policy/audit";
import type { PolicyConfig, ResponseMode } from "../../policy/config";
import { channelFromSpaceId, isDmChannel, type SlackAdapter, type SlackMessage } from "../adapters/slack";
import { connectExtension, type ConnectExtensionDeps, type ConnectScope } from "../../extensions/connect";
import { onboardingGuideText, runWizardChecks, type WizardCheck } from "../../tools/admin";
import type { LearningService } from "./learning";
import { loadPersona } from "../personas";

/** Digests kept per space; older ones are still in the transcript (issue #42). */
export const DIGEST_CAP = 20;
/** Bound on the digest summarization turn (issue #42). */
export const DEFAULT_DIGEST_TIMEOUT_MS = 60_000;

export interface SpaceServiceDeps {
  store: Store;
  adapter: SlackAdapter;
  /** Audit sink for attachment events. */
  audit: AuditModule;
  /** Org object-size policy. */
  orgPolicy: PolicyConfig;
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
  /**
   * Connect capability (issue #61): when wired, inbound messages matching
   * the narrow connect patterns ({@link parseConnectIntent}) route directly
   * to the connect capability — no agent tool call, no session. Works
   * identically for OMP, ACP, and any future surface; humans never depend
   * on the agent having the tool. Everything else stays agent territory.
   */
  connect?: ConnectExtensionDeps;
  /**
   * Live-session registry (issue #64): each created session is registered
   * under its space id and removed on dispose, so the `use_model` tool can
   * reach the session's setModelRole hook. Absent → no registration.
   */
  modelRoles?: SessionModelRoleRegistry;
  /** Automatic-memory observer for human Slack turns. */
  learning?: LearningService;
  /**
   * Onboarding-check seam (issue #116): the shared first-run wizard checks
   * (runWizardChecks — one source of truth with the `first_run_wizard` tool
   * and the boot-time guide). Defaults to runWizardChecks(store); tests
   * inject deterministic failing sets.
   */
  onboardingChecks?: () => WizardCheck[];
  /** Persona config root override; defaults to BOTTEGA_CONFIG_DIR or process.cwd() (issue #130). */
  personaDir?: string;
}

/** A connect-intent message parsed by {@link parseConnectIntent}. */
export interface ConnectIntent {
  extension: string;
  scope: ConnectScope;
}

/**
 * Parses a Slack message into a connect intent (issue #61). Narrow, exact
 * shapes only — everything else is natural-language agent territory:
 *
 *   `connect <extension>`         → scope "personal" (the sender's account)
 *   `connect <extension> as org`  → scope "org" (privileged: policy gate +
 *                                   approval via the space's router)
 *   `connect <extension> as me`   → scope "personal"
 *
 * Matching is case-insensitive over the whole trimmed phrase; the
 * extension token is a registry-style id (`[A-Za-z0-9._-]`). Any
 * deviation — extra words, punctuation, `connect X Y`, api keys — returns
 * null and stays with the agent.
 */
export function parseConnectIntent(text: string): ConnectIntent | null {
  const match = /^connect\s+([A-Za-z0-9._-]+)(?:\s+as\s+(org|me))?$/i.exec(text.trim());
  if (!match) return null;
  return { extension: match[1]!, scope: match[2]?.toLowerCase() === "org" ? "org" : "personal" };
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
 * Always-on output-format directive (issue #84): the model emits Markdown by
 * reflex, but Slack renders mrkdwn, not Markdown. Appended to every space
 * session so replies arrive in Slack-correct form; `renderSlackText` in the
 * adapter is the deterministic backstop for whatever still slips through.
 */
export const SLACK_FORMAT_DIRECTIVE =
  "Format replies for Slack, not Markdown: *bold*, _italic_, ~strike~, `inline code`, • bullets, <url|label> links; never **, # headings, md tables, or [label](url); keep @mentions and :emoji: as-is.";

/**
 * Rotating status phrases posted on message receipt (issue #119) and updated
 * in place by the real reply (or error text) when the turn completes (issue
 * #40). Since #60, every posting path is retry-safe: while a phrase is
 * pending for the space, the next rotating phrase UPDATES it in place
 * instead of posting a second message, so an OMP auto-retry loop never
 * stacks phrases. A turn that ends with neither message nor error leaves the
 * phrase as-is.
 */
/** Rotating status phrases posted on turn_start; exported so tests (e2e #66) can assert the in-place replacement. */
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
 * Streaming phrase-update cadence (issue #120): Slack rate-limits
 * `chat.update` (~50/min tier), so a dense streamed turn coalesces its
 * in-place phrase updates to at most one per 400ms — smooth enough to read
 * as streaming, while a 429 (fail-soft below) merely skips an interim
 * update instead of stalling the turn. The turn's FINAL reply text is
 * always delivered — flushed on turn_end with bounded retries on a 429 —
 * while interim updates may be skipped. Batching applies ONLY to the
 * streaming (steer) path; non-streaming replies update exactly as before.
 * Hardcoded default (no org setting).
 */
export const STREAM_UPDATE_INTERVAL_MS = 400;

/**
 * Bounded retries for the FINAL streaming update (issue #120): after this
 * many consecutive final-flush failures (e.g. a hard 429), the update is
 * dropped with a log rather than hammering Slack forever. Interim updates
 * never retry on their own — they wait for the turn-end flush.
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

interface LiveSession {
  spaceId: string;
  session: AgentSessionDriver;
  idleTimer: ReturnType<typeof setTimeout>;
  detachLearning: () => void;
  disposing: boolean;
}

/** State of one coalesced streaming phrase update (issue #120). */
interface PendingStreamUpdate {
  /** The pending thinking-phrase ts the update rewrites in place. */
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
 * One long-lived agent session per active space. Sessions are created lazily
 * on the first message, disposed after an idle timeout (cache eviction only —
 * transcripts are file-backed and never deleted), and cold-started from the
 * space's transcript file on the next message.
 */
export class SpaceService {
  readonly #store: Store;
  readonly #adapter: SlackAdapter;
  readonly #driver: AgentDriver;
  readonly #audit: AuditModule;
  readonly #orgPolicy: PolicyConfig;
  readonly #idleTimeoutMs: number;
  readonly #transcriptDir: string;
  readonly #memoryProvider: MemoryProvider | undefined;
  readonly #digestPrune: ((spaceId: string, keep: number) => Promise<void> | void) | undefined;
  readonly #digestTimeoutMs: number;
  readonly #responseModeFor: (spaceId: string) => ResponseMode | Promise<ResponseMode>;
  readonly #connect: ConnectExtensionDeps | undefined;
  readonly #modelRoles: SessionModelRoleRegistry | undefined;
  readonly #learning: LearningService | undefined;
  readonly #onboardingChecks: () => WizardCheck[];
  readonly #personaDir: string | undefined;
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
  /**
   * Spaces whose current turn is a streaming (steer) turn (issue #120): their
   * in-place phrase updates coalesce on {@link STREAM_UPDATE_INTERVAL_MS} and
   * the turn's final text always lands. Set when handleInboundMessage steers;
   * cleared on turn_end/error/dispose and when a non-streaming turn starts.
   */
  readonly #streamingTurns = new Set<string>();
  /**
   * Pending coalesced streaming update per space (issue #120): the latest
   * streamed text for the pending phrase ts, pushed on the cadence timer and
   * always pushed (final) when the turn ends. Retained on a 429 so the next
   * attempt retries; never thrown into the turn path.
   */
  readonly #streamUpdate = new Map<string, PendingStreamUpdate>();
  /** Spaces mid-digest turn: their output must not reach the channel (#42). */
  readonly #digesting = new Set<string>();
  /**
   * Date.now() of the latest inbound message per space — the receipt→reply
   * latency base (issue #119). Set on the inbound path, consumed (and
   * deleted) when the reply or an error lands.
   */
  readonly #receivedAt = new Map<string, number>();
  /**
   * Phrase-posting latency ms per space (receipt → phrase postMessage
   * resolved), carried on the reply audit row (issue #119). Absent when no
   * phrase was posted (churn-active space).
   */
  readonly #phrasePostedMs = new Map<string, number>();
  /**
   * Inbound message tss per space that still carry the receipt reaction
   * (issue #119). Added at receipt; cleared (and the reactions removed)
   * when a visible outcome — reply text or error — lands. A set because a
   * steered message acks its own reaction while an earlier one is pending.
   */
  readonly #pendingReactions = new Map<string, Set<string>>();
  /**
   * Per-space onboarding-nudge dedupe (issue #116): space id → the
   * failing-check snapshot the space was last nudged for. A broken setup
   * nudges once until the missing set CHANGES; the record clears when the
   * checks pass, so a later regression nudges fresh. Never per message.
   */
  readonly #nudged = new Map<string, string>();
  /** Rotates THINKING_PHRASES one step per turn. */
  #phraseIndex = 0;

  constructor(deps: SpaceServiceDeps) {
    this.#store = deps.store;
    this.#adapter = deps.adapter;
    this.#driver = deps.driver;
    this.#audit = deps.audit;
    this.#orgPolicy = deps.orgPolicy;
    this.#idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#transcriptDir = deps.transcriptDir ?? DEFAULT_TRANSCRIPT_DIR;
    this.#memoryProvider = deps.memoryProvider;
    this.#digestPrune = deps.digestPrune;
    this.#digestTimeoutMs = deps.digestTimeoutMs ?? DEFAULT_DIGEST_TIMEOUT_MS;
    this.#responseModeFor = deps.responseModeFor ?? (() => "always");
    this.#connect = deps.connect;
    this.#modelRoles = deps.modelRoles;
    this.#learning = deps.learning;
    this.#onboardingChecks = deps.onboardingChecks ?? (() => runWizardChecks(this.#store));
    this.#personaDir = deps.personaDir;
  }

  /**
   * Principal of the latest inbound message for a space (issue #121): the
   * extension-tool bridge resolves the caller of every extension tool call
   * from this map, so `connect github as me` personal credentials match the
   * real Slack user instead of the bridge's "agent" fallback (which never
   * matches a personal credential row and forced the ask-PAT-in-chat path).
   * Undefined when the space has no inbound message yet (the bridge then
   * falls back to "agent").
   */
  getLastPrincipal(spaceId: string): string | undefined {
    return this.#lastPrincipal.get(spaceId);
  }

  async handleInboundMessage(msg: SlackMessage): Promise<void> {
    try {
      // Connect intent seam (issue #61): exact `connect X` / `connect X as
      // org|me` shapes route straight to the connect capability — no agent
      // tool call, no session cold-start. Non-matching messages (anything
      // with extra words, punctuation, or keys) stay agent territory. The
      // connect path answers immediately (no cold start), so it gets no
      // phrase, no receipt reaction, and no message.in row (issue #119).
      const connect = this.#connect;
      if (connect) {
        const intent = parseConnectIntent(msg.text);
        if (intent) {
          await this.#handleConnectIntent(msg, intent, connect);
          return;
        }
      }
      // Session mid-dispose: drop BEFORE any receipt activity. The message
      // will never be answered, so it gets no phrase and no reaction — a
      // receipt claim ("working on it") must not outlive a message that is
      // discarded (issue #119).
      const existing = this.#sessions.get(msg.spaceId);
      if (existing?.disposing) {
        await this.#store.appendAudit({
          space_id: msg.spaceId,
          actor: msg.principal,
          event_type: MESSAGE_DROPPED_EVENT,
          payload: JSON.stringify({ reason: "session_disposing", ts: msg.ts }),
        });
        return;
      }
      // Receipt responsiveness (issue #119): the thinking phrase, the
      // reaction ack, and the receipt audit all happen NOW — before the
      // session cold-start below — so a slow createSession is never silent.
      // Each is fire-and-forget: the turn path never blocks on Slack
      // latency or a missing reactions:write scope.
      this.#lastInboundTs.set(msg.spaceId, msg.ts);
      this.#lastPrincipal.set(msg.spaceId, msg.principal);
      this.#postThinkingPhrase(msg.spaceId);
      this.#addReceiptReaction(msg);
      this.#auditReceipt(msg);
      const turnText = await this.#ingestAttachments(msg);
      const live = await this.#sessionFor(msg.spaceId);
      if (!live) return; // unreachable: the mid-dispose pre-check handled it
      this.#learning?.recordInput(msg);
      if (live.session.isStreaming()) {
        // Streaming turn (issue #120): phrase updates coalesce on the cadence.
        this.#streamingTurns.add(msg.spaceId);
        await live.session.prompt(turnText, { streamingBehavior: "steer" });
      } else {
        // Non-streaming turn: replies update in place immediately, unbatched.
        this.#streamingTurns.delete(msg.spaceId);
        await live.session.prompt(turnText);
      }
    } catch (err) {
      console.error(`[space-service] failed to handle message in ${msg.spaceId}:`, err);
    }
  }

  async #ingestAttachments(msg: SlackMessage): Promise<string> {
    if (!msg.files?.length) return msg.text;
    let turnText = msg.text;
    const appendNote = (note: string): void => {
      turnText = turnText ? `${turnText}\n${note}` : note;
    };
    for (const file of msg.files) {
      const limit = this.#orgPolicy.objects.maxSizeBytes;
      if (file.size > limit) {
        appendNote(`[attachment skipped: ${file.name} exceeds ${limit}B limit]`);
        continue;
      }
      try {
        await this.#store.getOrCreateSpace({
          platform: "slack",
          channel_id: channelFromSpaceId(msg.spaceId),
        });
        const download = await this.#adapter.downloadFile(file.id);
        const sha256 = createHash("sha256").update(download.bytes).digest("hex");
        const object = await this.#store.createObject({
          space_id: msg.spaceId,
          name: file.name,
          mime: file.mimeType,
          size: file.size,
          sha256,
          uploaded_by: msg.principal,
          bytes: download.bytes,
        });
        await this.#audit.appendAudit({
          space_id: msg.spaceId,
          actor: msg.principal,
          event_type: OBJECT_ATTACHED_EVENT,
          payload: {
            id: object.id,
            name: object.name,
            mime: object.mime,
            size: object.size,
            sha256: object.sha256,
            by: msg.principal,
          },
        });
        appendNote(
          `[attachment: ${object.name} (${object.mime}, ${object.size} B) — object ${object.id}]`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendNote(`[attachment failed: ${file.name}: ${message}]`);
      }
    }
    return turnText;
  }

  async stop(): Promise<void> {
    const live = [...this.#sessions.values()];
    await Promise.all(live.map((entry) => this.#disposeSession(entry.spaceId)));
    await this.#learning?.drain();
    this.#learning?.close();
  }

  /**
   * Runs a parsed connect intent against the connect capability and posts
   * the outcome to the space (threaded under the intent message, like a
   * normal reply). Personal connects run for the sender with no gate; org
   * connects cross the capability's policy gate (Slack approval router).
   * Failures inside connectExtension are outcomes — posted, never thrown.
   */
  async #handleConnectIntent(msg: SlackMessage, intent: ConnectIntent, deps: ConnectExtensionDeps): Promise<void> {
    this.#lastInboundTs.set(msg.spaceId, msg.ts);
    this.#lastPrincipal.set(msg.spaceId, msg.principal);
    const outcome = await connectExtension(
      { extension: intent.extension, scope: intent.scope, actor: msg.principal, spaceId: msg.spaceId },
      deps,
    );
    await this.#adapter.postMessage(msg.spaceId, outcome.message, this.#replyOpts(msg.spaceId));
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
    const modePromise = this.#responseModeFor(spaceId);
    // Store is required in production. The runtime branch keeps older
    // protocol-only test doubles on the original single-await cold-start path.
    const getSpace = (this.#store as Partial<Store>).getSpace;
    const [mode, space] = getSpace
      ? await Promise.all([modePromise, getSpace.call(this.#store, spaceId)])
      : [await modePromise, undefined];
    const persona = space ? loadPersona(space.policy_json, this.#personaDir) : undefined;
    // Persona guidance is additive (#130): Slack formatting and response-mode
    // directives remain part of every cold-start prompt.
    const directives = [persona?.prompt ?? "", SLACK_FORMAT_DIRECTIVE];
    if (mode === "request-only") directives.push(REQUEST_ONLY_DIRECTIVE);
    const appendSystemPrompt = directives.filter(Boolean).join("\n\n");
    const session = await this.#driver.createSession({
      spaceId,
      transcriptDir: this.#transcriptDir,
      appendSystemPrompt,
      // A persona floor widens only the visible session toolset (#130).
      // The existing per-space policy gate still decides whether each call
      // is allowed, so a restrictive space overlay always wins.
      allowTools: spaceAgentToolNames([], undefined, persona?.toolFloor),
      // Output arrives on the session's event channel below. onOutput is the
      // same signal (both drivers emit both), so it must stay unconsumed or
      // every reply would be posted twice.
      onOutput: () => {},
      // Memory-context injection seam (#42): re-read the space's current
      // principal on every LLM call so user-scope search stays fresh.
      getPrincipal: () => this.#lastPrincipal.get(spaceId),
    });
    session.on("turn_start", () => this.#postThinkingPhrase(spaceId));
    session.on("message", (data) => this.#onSessionMessage(spaceId, data));
    session.on("error", (data) => this.#onSessionError(spaceId, data));
    session.on("turn_end", (data) => this.#onTurnEnd(spaceId, data));
    const detachLearning = this.#learning?.attachSession(spaceId, session) ?? (() => {});
    const live: LiveSession = {
      spaceId,
      session,
      detachLearning,
      disposing: false,
      idleTimer: setTimeout(() => void this.#disposeSession(spaceId), this.#idleTimeoutMs),
    };
    // Unref so a long-lived idle timer never keeps the process (or test run) alive.
    live.idleTimer.unref?.();
    this.#sessions.set(spaceId, live);
    // use_model reachability (issue #64): the live session is the switch
    // target until dispose removes it.
    this.#modelRoles?.set(spaceId, session);
    return live;
  }

  async #disposeSession(spaceId: string): Promise<void> {
    const live = this.#sessions.get(spaceId);
    if (!live || live.disposing) return;
    live.disposing = true;
    clearTimeout(live.idleTimer);
    live.detachLearning();
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
      this.#receivedAt.delete(spaceId);
      this.#phrasePostedMs.delete(spaceId);
      this.#pendingReactions.delete(spaceId);
      this.#cancelStreamUpdate(spaceId);
      this.#streamingTurns.delete(spaceId);
      this.#sessions.delete(spaceId);
      this.#modelRoles?.delete(spaceId);
    }
  }

  /**
   * Posts (or rotates) the space's one thinking phrase (issues #40/#60/#119).
   * Called on message receipt — BEFORE the session cold-start, so a slow
   * createSession is never silent — and on turn_start, which updates the
   * receipt phrase in place. Retry-safe (#60): OMP auto-retries empty
   * completions and each attempt fires turn_start, so a pending phrase is
   * UPDATED with the next rotating phrase instead of stacking a second
   * message — one message max per space at any time. A call while a phrase
   * post is still in flight (ts unknown yet) skips posting entirely. Digest
   * turns are invisible to the channel (their output is memory, #42). After
   * the churn guard has fired (#60), phrases stay off until a turn produces
   * text or an error — no new posts, not just no updates. Captures the
   * phrase-posting latency (receipt → post resolved) for the reply audit
   * row (issue #119).
   */
  #postThinkingPhrase(spaceId: string): void {
    if (this.#digesting.has(spaceId)) return;
    this.#turnDelivered.delete(spaceId);
    if (this.#churnActive.has(spaceId)) return;
    const pendingTs = this.#pendingThinkingTs.get(spaceId);
    if (pendingTs !== undefined) {
      // A retry (or second turn) while the phrase is up: replace in place.
      // A stale coalesced streaming text must not overwrite the rotation (#120).
      this.#cancelStreamUpdate(spaceId);
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
        if (ts !== undefined) {
          this.#pendingThinkingTs.set(spaceId, ts);
          const receivedAt = this.#receivedAt.get(spaceId);
          if (receivedAt !== undefined) this.#phrasePostedMs.set(spaceId, Date.now() - receivedAt);
        }
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

  /**
   * Receipt ack (issue #119): adds the 👀 reaction to the inbound message
   * and remembers its ts so the reply can remove it. Fail-soft — a missing
   * `reactions:write` scope is logged by the caller's catch, never thrown
   * into the turn path.
   */
  #addReceiptReaction(msg: SlackMessage): void {
    let pending = this.#pendingReactions.get(msg.spaceId);
    if (!pending) {
      pending = new Set();
      this.#pendingReactions.set(msg.spaceId, pending);
    }
    pending.add(msg.ts);
    void this.#adapter.addReaction(msg.spaceId, msg.ts).catch((err) => {
      console.error(`[space-service] failed to add receipt reaction in ${msg.spaceId}:`, err);
    });
  }

  /**
   * Removes every pending receipt reaction for the space once a visible
   * outcome — reply text or error — lands (issue #119). Idempotent: the
   * pending set is cleared first, so a second call (e.g. turn_end after the
   * message handler) is a no-op.
   */
  #clearReactions(spaceId: string): void {
    const pending = this.#pendingReactions.get(spaceId);
    if (!pending) return;
    this.#pendingReactions.delete(spaceId);
    for (const ts of pending) {
      void this.#adapter.removeReaction(spaceId, ts).catch((err) => {
        console.error(`[space-service] failed to remove receipt reaction in ${spaceId}:`, err);
      });
    }
  }

  /**
   * Records the message.in audit row at receipt and starts the reply-latency
   * clock (issue #119). Payload carries only the Slack ts — never message
   * text, which can hold secrets. Fire-and-forget.
   */
  #auditReceipt(msg: SlackMessage): void {
    this.#receivedAt.set(msg.spaceId, Date.now());
    void this.#store
      .appendAudit({
        space_id: msg.spaceId,
        actor: msg.principal,
        event_type: MESSAGE_RECEIVED_EVENT,
        payload: JSON.stringify({ ts: msg.ts }),
      })
      .catch((err) => {
        console.error(`[space-service] message.in audit write failed for ${msg.spaceId}:`, err);
      });
  }

  /**
   * Records the message.reply audit row with receipt→reply latency (issue
   * #119). Called when a real reply or an error lands; empty completions and
   * churn messages are retry bookkeeping and write no row. Idempotent: the
   * latency base is consumed on the first call. Fire-and-forget.
   */
  #auditReply(spaceId: string): void {
    const receivedAt = this.#receivedAt.get(spaceId);
    if (receivedAt === undefined) return; // no receipt recorded for this space
    const phraseMs = this.#phrasePostedMs.get(spaceId);
    this.#receivedAt.delete(spaceId);
    this.#phrasePostedMs.delete(spaceId);
    void this.#store
      .appendAudit({
        space_id: spaceId,
        actor: "system",
        event_type: MESSAGE_REPLIED_EVENT,
        payload: JSON.stringify({
          latency_ms: Date.now() - receivedAt,
          ...(phraseMs !== undefined ? { phrase_ms: phraseMs } : {}),
        }),
      })
      .catch((err) => {
        console.error(`[space-service] message.reply audit write failed for ${spaceId}:`, err);
      });
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
      // A swallowed provider error (issue #78) rides the event payload: the
      // fallback carries the cause instead of the generic phrase.
      const cause = (data as { error?: unknown } | null)?.error;
      this.#countEmptyTurn(spaceId, typeof cause === "string" && cause.trim() ? cause.trim() : undefined);
      if (!this.#churnActive.has(spaceId)) {
        // A coalesced streaming text must not overwrite the fallback (#120).
        this.#cancelStreamUpdate(spaceId);
        const pendingTs = this.#pendingThinkingTs.get(spaceId);
        if (pendingTs !== undefined) {
          const fallback = emptyResponseFallback(
            typeof cause === "string" && cause.trim() ? cause.trim() : undefined,
          );
          void this.#adapter.updateMessage(spaceId, pendingTs, fallback).catch((err) => {
            console.error(`[space-service] failed to update empty-response phrase in ${spaceId}:`, err);
          });
        }
      }
      return;
    }
    // Real text: the empty streak is over, phrases re-arm.
    this.#emptyTurnCount.delete(spaceId);
    this.#churnActive.delete(spaceId);
    if (this.#streamingTurns.has(spaceId)) {
      // Streaming turn (#120): coalesce in-place updates on the cadence; the
      // turn's final text is flushed by turn_end (final-delivery guarantee).
      this.#scheduleStreamUpdate(spaceId, text);
      return;
    }
    this.#replaceOrPost(spaceId, text);
    // The reply landed: the receipt reaction comes off and the reply
    // latency is audited (issue #119).
    this.#clearReactions(spaceId);
    this.#auditReply(spaceId);
  }

  /** Session error: surface it by replacing the thinking phrase in place. */
  #onSessionError(spaceId: string, data: unknown): void {
    console.error(`[space-service] session error (${spaceId}):`, data);
    if (this.#digesting.has(spaceId)) return;
    this.#turnDelivered.add(spaceId);
    // An error supersedes any coalesced streaming text (#120): cancel the
    // pending update so its timer can never overwrite the error surface.
    this.#cancelStreamUpdate(spaceId);
    this.#streamingTurns.delete(spaceId);
    // An error is a visible outcome: it breaks the empty streak and re-arms phrases.
    this.#emptyTurnCount.delete(spaceId);
    this.#churnActive.delete(spaceId);
    const message = (data as { message?: unknown }).message;
    const base = typeof message === "string" ? message : "Something went wrong while thinking.";
    // A setup-blocked failure (provider/session) appends the one-line
    // onboarding pointer (issue #116) — bounded by the per-space dedupe.
    this.#replaceOrPost(spaceId, this.#nudgeText(spaceId, base));
    // An error is a visible outcome: the receipt reaction comes off and
    // the reply latency is audited (issue #119).
    this.#clearReactions(spaceId);
    this.#auditReply(spaceId);
  }

  /**
   * Turn ended without a delivered message or error (#60): an empty
   * completion. Both drivers filter empty text before the "message" event
   * (`if (text) deliver`), so the retry loop arrives here as silent
   * turn_start/turn_end pairs — this is what must trip the churn guard.
   * A swallowed provider error (issue #78) rides the turn_end payload; the
   * churn message then carries the cause.
   */
  #onTurnEnd(spaceId: string, data: unknown): void {
    if (this.#digesting.has(spaceId)) return;
    // Streaming turns (#120): the turn's FINAL reply text always lands —
    // flush any coalesced pending update immediately (bounded retries on
    // 429); interim updates may have been skipped by the cadence.
    this.#finalizeStreamUpdate(spaceId);
    // A streaming turn's final text landed (or is flushing): the receipt
    // reaction comes off and the reply latency is audited (issue #119).
    if (this.#streamingTurns.has(spaceId)) {
      this.#clearReactions(spaceId);
      this.#auditReply(spaceId);
    }
    this.#streamingTurns.delete(spaceId);
    if (this.#turnDelivered.has(spaceId)) return;
    const cause = (data as { error?: unknown } | null)?.error;
    this.#countEmptyTurn(spaceId, typeof cause === "string" && cause.trim() ? cause.trim() : undefined);
  }

  /**
   * Counts one empty completion for the space; beyond {@link EMPTY_TURN_LIMIT}
   * consecutive empties, surfaces the churn message exactly once (in place
   * of the pending phrase, or fresh) and silences phrases until a non-empty
   * turn — fail visible, not silent (#60). The message carries the real
   * provider/session cause when one exists (issue #78); unknown cause keeps
   * the legacy phrase. The churn boundary is the missing-model-key path of
   * the onboarding nudge (issue #116): when the shared checks fail, the
   * one-line pointer is appended here.
   */
  #countEmptyTurn(spaceId: string, cause?: string): void {
    const count = (this.#emptyTurnCount.get(spaceId) ?? 0) + 1;
    this.#emptyTurnCount.set(spaceId, count);
    if (count <= EMPTY_TURN_LIMIT || this.#churnActive.has(spaceId)) return;
    this.#churnActive.add(spaceId);
    this.#replaceOrPost(spaceId, this.#nudgeText(spaceId, churnMessageText(cause)));
  }

  /**
   * Appends the one-line onboarding pointer (issue #116) when setup is
   * incomplete: names the failing checks and points at `first_run_wizard`.
   * Deduped per space on the failing-check snapshot — a broken setup nudges
   * once until the missing set changes, and the record clears once the
   * checks pass. Fail closed: a check failure (e.g. malformed settings)
   * suppresses the nudge, never the turn output.
   */
  #nudgeText(spaceId: string, baseText: string): string {
    let failing: WizardCheck[];
    try {
      failing = this.#onboardingChecks().filter((c) => !c.ok);
    } catch (err) {
      console.error(`[space-service] onboarding checks failed for ${spaceId}:`, err);
      return baseText;
    }
    if (failing.length === 0) {
      this.#nudged.delete(spaceId);
      return baseText;
    }
    const snapshot = failing
      .map((c) => c.name)
      .sort()
      .join(",");
    if (this.#nudged.get(spaceId) === snapshot) return baseText;
    this.#nudged.set(spaceId, snapshot);
    void this.#store
      .appendAudit({
        space_id: spaceId,
        actor: "system",
        event_type: ADMIN_ONBOARDING_NUDGE_EVENT,
        payload: JSON.stringify({ checks: failing.map((c) => ({ name: c.name, ok: c.ok })) }),
      })
      .catch((err) => {
        console.error(`[space-service] onboarding nudge audit write failed for ${spaceId}:`, err);
      });
    return `${baseText}\n${onboardingGuideText(failing)}`;
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
   * Streaming path (issue #120): coalesce an in-place phrase update — the
   * latest streamed text replaces any pending one, and a cadence timer pushes
   * it to Slack at most once per {@link STREAM_UPDATE_INTERVAL_MS}. No pending
   * phrase ts (edge: the reply raced the phrase post) falls back to the direct
   * path so the text is never lost.
   */
  #scheduleStreamUpdate(spaceId: string, text: string): void {
    const pendingTs = this.#pendingThinkingTs.get(spaceId);
    if (pendingTs === undefined) {
      this.#replaceOrPost(spaceId, text);
      return;
    }
    const existing = this.#streamUpdate.get(spaceId);
    if (existing) {
      existing.text = text; // latest text wins; the armed timer stays
      return;
    }
    const entry: PendingStreamUpdate = { ts: pendingTs, text, final: false, retries: 0, timer: null };
    this.#streamUpdate.set(spaceId, entry);
    this.#armStreamTimer(spaceId, entry);
  }

  /** Arms the cadence timer for a pending stream update if none is running. */
  #armStreamTimer(spaceId: string, entry: PendingStreamUpdate): void {
    if (entry.timer !== null) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.#flushStreamUpdate(spaceId);
    }, STREAM_UPDATE_INTERVAL_MS);
    entry.timer.unref?.();
  }

  /**
   * Sends the pending coalesced text now. Fail-soft (issue #120): a 429 (or
   * any error) is logged and the update is KEPT for the next attempt — never
   * thrown into the turn path. Interim failures wait for the turn-end flush;
   * final failures re-arm the timer, bounded by {@link STREAM_FINAL_RETRY_LIMIT}.
   */
  async #flushStreamUpdate(spaceId: string): Promise<void> {
    const entry = this.#streamUpdate.get(spaceId);
    if (!entry) return;
    this.#streamUpdate.delete(spaceId);
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    try {
      await this.#adapter.updateMessage(spaceId, entry.ts, entry.text);
    } catch (err) {
      console.error(
        `[space-service] streaming phrase update failed in ${spaceId} (${err instanceof Error ? err.message : String(err)}); keeping for the next attempt`,
      );
      if (entry.final && entry.retries >= STREAM_FINAL_RETRY_LIMIT) return; // logged; give up
      const kept: PendingStreamUpdate = { ...entry, retries: entry.retries + 1, timer: null };
      this.#streamUpdate.set(spaceId, kept);
      if (entry.final) this.#armStreamTimer(spaceId, kept); // retry the final until it lands
    }
  }

  /**
   * Turn ended: any pending coalesced update carries the FINAL reply text —
   * flush it immediately so it always lands, with bounded retries on a 429.
   */
  #finalizeStreamUpdate(spaceId: string): void {
    const entry = this.#streamUpdate.get(spaceId);
    if (!entry) return;
    entry.final = true;
    entry.retries = 0;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    void this.#flushStreamUpdate(spaceId);
  }

  /** Cancels any pending coalesced update (superseded text must not overwrite). */
  #cancelStreamUpdate(spaceId: string): void {
    const entry = this.#streamUpdate.get(spaceId);
    if (!entry) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.#streamUpdate.delete(spaceId);
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
