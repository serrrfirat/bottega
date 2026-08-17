import { createHash } from "node:crypto";
import { spaceAgentToolNames, type AgentDriver, type AgentSessionDriver, type SessionModelRoleRegistry } from "../drivers/agent-driver";
import { DIGEST_FAILED_EVENT, MESSAGE_DROPPED_EVENT, OBJECT_ATTACHED_EVENT } from "../../store/audit-events";
import type { Store } from "../../store/db";
import { z } from "zod";
import type { MemoryProvider } from "../../memory/types";
import type { AuditModule } from "../../policy/audit";
import type { PolicyConfig, ResponseMode } from "../../policy/config";
import { channelFromSpaceId, isDmChannel, type SlackAdapter, type SlackMessage } from "../adapters/slack";
import { connectExtension, type ConnectExtensionDeps, type ConnectScope } from "../../extensions/connect";
import { runWizardChecks, type WizardCheck } from "../../tools/admin";
import type { LearningService } from "./learning";
import { loadPersona } from "../personas";
import { buildAutoPickupDirective } from "../../tools/work-item-pickup";
import {
  createPhraseRotation,
  SlackTurnPresenter,
  StreamTurnPresenter,
  type ToolStepEvent,
  type TurnPresenterDeps,
} from "./slack-turn-presenter";

// Turn-rendering constants and helpers moved to the SlackTurnPresenter
// (issue #153/#168); re-exported here so existing callers (tests, e2e
// canary) keep importing them from space-service.
export {
  THINKING_PHRASES,
  EMPTY_TURN_LIMIT,
  STREAM_UPDATE_INTERVAL_MS,
  EMPTY_RESPONSE_FALLBACK,
  CHURN_MESSAGE,
  emptyResponseFallback,
  churnMessageText,
} from "./slack-turn-presenter";
export type { ToolStepEvent, ToolStepSink } from "./slack-turn-presenter";

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

/** A session message event's text field, validated at the digest capture boundary. */
const digestMessageSchema = z.object({ text: z.string() });

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

interface LiveSession {
  spaceId: string;
  session: AgentSessionDriver;
  idleTimer: ReturnType<typeof setTimeout>;
  detachLearning: () => void;
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
  /**
   * One turn presenter per space (issue #153/#168): owns the thinking
   * phrase, the receipt reactions, the stream coalescing, the latency
   * audit, the churn guard, and the threading rule — everything visible
   * that this class used to hold in ~15 per-space maps. Created lazily on
   * the first inbound message (or tool step), disposed with the session.
   * The streaming renderer is selected when the adapter reports streaming
   * support; it degrades to the phrase renderer on the first failure.
   * DMs (slack:D*) ALWAYS get the phrase renderer (issue #180): the
   * stream panel opens a threaded reply, which DMs must never see.
   */
  readonly #presenters = new Map<string, SlackTurnPresenter>();

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
   * The space's turn presenter, created lazily. The streaming renderer is
   * the default for CHANNELS when the adapter supports chat streaming
   * (issue #168); otherwise (or after the first stream failure flips the
   * adapter's per-boot cache) the phrase renderer carries the space. DMs
   * (slack:D*) always use the phrase renderer (issue #180): a DM reads as
   * one plain message — no thread, no thinking panel. All presenters
   * share ONE phrase rotation (the pre-#153 single-class counter).
   */
  readonly #phraseRotation = createPhraseRotation();

  #presenterFor(spaceId: string): SlackTurnPresenter {
    const existing = this.#presenters.get(spaceId);
    if (existing) return existing;
    const deps: TurnPresenterDeps = {
      spaceId,
      adapter: this.#adapter,
      store: this.#store,
      onboardingChecks: this.#onboardingChecks,
      phraseRotation: this.#phraseRotation,
    };
    // DMs must read as one plain message (issue #180): the stream panel
    // opens a threaded reply (chat.startStream carries thread_ts), which
    // is exactly what DM replies must never be. Channels keep the
    // thinking panel when streaming is supported; the fallback path
    // (no streaming support, or a failed stream) is unchanged.
    const isDm = isDmChannel(channelFromSpaceId(spaceId));
    const presenter = !isDm && this.#adapter.streamingSupported()
      ? new StreamTurnPresenter(deps)
      : new SlackTurnPresenter(deps);
    this.#presenters.set(spaceId, presenter);
    return presenter;
  }

  /**
   * Step-source bridge (issue #168/#193): the driver's withPolicyGate
   * wrapper and the extension runtime emit gated tool-call steps through
   * this; the space's presenter renders them — step cards on the panel,
   * the live "⚙️ current tool" progress line on the plain phrase path.
   * Unknown spaces and headless calls are dropped — a step can only
   * follow an inbound message, so a presenter exists by then.
   */
  routeToolStep(step: ToolStepEvent): void {
    if (step.spaceId === undefined) return;
    this.#presenters.get(step.spaceId)?.onToolStep(step);
  }

  /**
   * Principal of the space's CURRENT turn (issue #152): captured when a
   * fresh turn starts and bound until that turn ends (the driver binds it
   * atomically with the fresh-turn decision, so a steer — another user's
   * message mid-turn — never re-identifies the running turn). The
   * extension-tool bridge resolves the caller of every extension tool call
   * from this, so `connect github as me` personal credentials match the
   * Slack human whose message STARTED the turn instead of the bridge's
   * "agent" fallback (which never matches a personal credential row and
   * forced the ask-PAT-in-chat path). Undefined between turns and for
   * turns nobody started (digest) — callers then fall back to "agent"
   * (fail closed). Replaces the space-level "latest inbound" source
   * (#121), which let user B's mid-turn message re-identify user A's
   * in-flight extension calls as B.
   */
  getTurnPrincipal(spaceId: string): string | undefined {
    return this.#sessions.get(spaceId)?.session.getTurnPrincipal?.();
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
      // Receipt responsiveness (issue #119/#168): the thinking phrase (or
      // the stream opening), the reaction ack, and the receipt audit all
      // happen NOW — before the session cold-start below — so a slow
      // createSession is never silent. Each is fire-and-forget: the turn
      // path never blocks on Slack latency or a missing reactions:write
      // scope. The space's turn presenter owns all of it.
      this.#presenterFor(msg.spaceId).onInbound(msg);
      const turnText = await this.#ingestAttachments(msg);
      const live = await this.#sessionFor(msg.spaceId);
      if (!live) return; // unreachable: the mid-dispose pre-check handled it
      this.#learning?.recordInput(msg);
      const presenter = this.#presenterFor(msg.spaceId);
      if (live.session.isStreaming()) {
        // Streaming turn (issue #120): phrase updates coalesce on the cadence.
        // The steer inherits the RUNNING turn's principal (issue #152) — the
        // driver only binds on a fresh turn — so user B steering into user
        // A's turn never re-identifies A's in-flight extension calls.
        presenter.setSteered(true);
        await live.session.prompt(turnText, { streamingBehavior: "steer", principal: msg.principal });
      } else {
        // Non-streaming turn: replies update in place immediately, unbatched.
        // The principal travels WITH this turn: the driver binds it when the
        // fresh turn starts and drops it at turn_end (issue #152).
        presenter.setSteered(false);
        // Issue #189: hot-swap the default model BEFORE the fresh turn opens
        // — re-resolve the "default" role against the CURRENT settings and
        // apply it when the session's active model differs (no churn when
        // unchanged). The seam flips the driver's in-flight view
        // synchronously, so a concurrent message steers into this opening
        // turn instead of opening a second one. Best-effort: never blocks
        // the turn on a model misconfiguration.
        await live.session.reapplyDefaultModelRole?.();
        await live.session.prompt(turnText, { principal: msg.principal });
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
    this.#presenterFor(msg.spaceId).onConnectIntent(msg);
    const outcome = await connectExtension(
      { extension: intent.extension, scope: intent.scope, actor: msg.principal, spaceId: msg.spaceId },
      deps,
    );
    await this.#adapter.postMessage(msg.spaceId, outcome.message, this.#presenterFor(msg.spaceId).replyOpts());
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
    // SAFETY: the cold-start path only touches store members that exist on
    // every protocol-only test double, guarded with `?.`/presence checks
    // below; Partial<Store> widens the production Store to that subset.
    const store = this.#store as Partial<Store>;
    // Upsert the space row on first contact (issue #188): the session flow
    // previously only GET'd the space, so real spaces were never persisted
    // and per-space settings/policy (model_settings, overlays) failed with
    // "space not found". Idempotent — the store helper never overwrites
    // existing settings/policy; re-contacts only bump updated_at. Guarded
    // for protocol-only test doubles that lack the store helper.
    await store.getOrCreateSpace?.({
      platform: "slack",
      channel_id: channelFromSpaceId(spaceId),
    });
    const modePromise = this.#responseModeFor(spaceId);
    // Store is required in production. The runtime branch keeps older
    // protocol-only test doubles on the original single-await cold-start path.
    const getSpace = store.getSpace;
    const [mode, space] = getSpace
      ? await Promise.all([modePromise, getSpace.call(this.#store, spaceId)])
      : [await modePromise, undefined];
    const persona = space ? loadPersona(space.policy_json, this.#personaDir) : undefined;
    // Persona guidance is additive (#130): Slack formatting and response-mode
    // directives remain part of every cold-start prompt.
    const directives = [persona?.prompt ?? "", SLACK_FORMAT_DIRECTIVE];
    if (mode === "request-only") directives.push(REQUEST_ONLY_DIRECTIVE);
    // Semantic auto-pickup (issue #89): opt-in org-floor flag; the pickup
    // directive is evaluated at session creation like the response mode, so
    // a config change applies on the next cold start. Off (the default) →
    // no directive, so the agent never auto-drafts.
    if (this.#orgPolicy.autoPickup) {
      directives.push(buildAutoPickupDirective(this.#orgPolicy.pickupConfidence));
    }
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
      // Memory-context injection seam (#42): re-read the CURRENT TURN's
      // principal on every LLM call so user-scope search stays fresh — and
      // a mid-turn steer from another user never switches the scope
      // (issue #152).
      getPrincipal: () => this.getTurnPrincipal(spaceId),
    });
    session.on("turn_start", () => this.#presenterFor(spaceId).onTurnStart());
    session.on("message", (data) => this.#presenterFor(spaceId).onMessage(data));
    session.on("error", (data) => this.#presenterFor(spaceId).onError(data));
    session.on("turn_end", (data) => this.#presenterFor(spaceId).onTurnEnd(data));
    // Issue #193: live reasoning chunks render as the in-place progress
    // phrase on the plain path (the panel path ignores them).
    session.on("thinking", (data) => this.#presenterFor(spaceId).onThinking(data));
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
      // re-creates the presenter. The presenter owns all turn-rendering
      // state (phrase, reactions, latency, churn, stream) — dispose resets
      // it wholesale.
      this.#presenters.get(spaceId)?.dispose();
      this.#presenters.delete(spaceId);
      this.#sessions.delete(spaceId);
      this.#modelRoles?.delete(spaceId);
    }
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
      const lastTs = this.#presenterFor(spaceId).latestInboundTs();
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
    const presenter = this.#presenterFor(spaceId);
    presenter.beginDigest();
    let captured = "";
    const offMessage = live.session.on("message", (data) => {
      const parsed = digestMessageSchema.safeParse(data);
      const text = parsed.success ? parsed.data.text : undefined;
      if (text !== undefined && text.trim()) captured = text;
    });
    try {
      const instruction = marker
        ? `Summarize the messages in this conversation since ${marker} as a compact bulleted digest. Reply with only the digest text, no preamble.`
        : "Summarize this conversation so far as a compact bulleted digest. Reply with only the digest text, no preamble.";
      await withTimeout(live.session.prompt(instruction, { silent: true }), this.#digestTimeoutMs);
    } finally {
      offMessage();
      presenter.endDigest();
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
