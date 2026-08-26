/**
 * SlackTurnPresenter / StreamTurnPresenter (issues #153/#168) — hermetic
 * turn-rendering tests. The Slack surface is a recording adapter (no
 * network); the audit sink is an in-memory array. Covers the issue #168
 * Acceptance:
 *
 *   - one collapsed thinking panel per streamed turn, N steps advancing
 *     in_progress → complete in real time, final reply streaming below it;
 *   - a denied call renders a deny step; an ask-human call shows
 *     "waiting for approval" until it resolves;
 *   - secret-shaped args never appear in any step (redaction);
 *   - stream appends respect the STREAM_UPDATE_INTERVAL_MS throttle;
 *   - a failing stream falls back to the phrase + edit path with no
 *     dropped reply;
 *   - the 👀 receipt reaction, the message.reply latency audit, and the
 *     phrase rotation are unchanged by streaming mode.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { Store } from "../../store/db";
import type { OrgSettings } from "../../store/org-settings";
import { MESSAGE_RECEIVED_EVENT, MESSAGE_REPLIED_EVENT } from "../../store/audit-events";
import { redact } from "../../policy/audit";
import { humanizeToolName } from "../adapters/approval-router";
import {
  SlackStreamRequestError,
  type SlackAdapter,
  type SlackBlockPayload,
  type SlackMessage,
  type SlackStreamTask,
} from "../adapters/slack";
import {
  STREAM_FINAL_RETRY_LIMIT,
  STREAM_UPDATE_INTERVAL_MS,
  StreamTurnPresenter,
  SlackTurnPresenter,
  THINKING_PHRASES,
  THINKING_SNIPPET_MAX,
  createPhraseRotation,
  emitToolStep,
  nextToolStepId,
  toolStepTitle,
  renderSearchResultBlocks,
  parseSearchResultRows,
  SEARCH_TABLE_MAX_ROWS,
  emptyResponseFallback,
  type ToolStepEvent,
} from "./slack-turn-presenter";

// ---------------------------------------------------------------------------
// Recording doubles: no network, no real store.
// ---------------------------------------------------------------------------

interface StreamCall {
  spaceId: string;
  opts: { threadTs: string; openingText: string; recipientUserId?: string };
}

interface RecordedAdapter {
  adapter: SlackAdapter;
  streams: StreamCall[];
  texts: Array<{ spaceId: string; ts: string; text: string }>;
  tasks: Array<{ spaceId: string; ts: string; task: SlackStreamTask }>;
  stops: Array<{ spaceId: string; ts: string; text?: string }>;
  posts: Array<{ spaceId: string; text?: string; opts?: { threadTs?: string; blocks?: SlackBlockPayload[] } }>;
  updates: Array<{ spaceId: string; ts: string; text?: string; opts?: { blocks?: SlackBlockPayload[] } }>;
  reactions: Array<{ kind: "add" | "remove"; spaceId: string; ts: string }>;
}

function recordingAdapter(
  opts: {
    failStart?: boolean;
    failStartRequest?: boolean;
    streaming?: boolean;
    failAppend?: boolean;
    failStop?: boolean;
  } = {},
): RecordedAdapter {
  const streams: StreamCall[] = [];
  const texts: Array<{ spaceId: string; ts: string; text: string }> = [];
  const tasks: Array<{ spaceId: string; ts: string; task: SlackStreamTask }> = [];
  const stops: Array<{ spaceId: string; ts: string; text?: string }> = [];
  const posts: Array<{ spaceId: string; text?: string; opts?: { threadTs?: string; blocks?: SlackBlockPayload[] } }> = [];
  const updates: Array<{ spaceId: string; ts: string; text?: string; opts?: { blocks?: SlackBlockPayload[] } }> = [];
  const reactions: Array<{ kind: "add" | "remove"; spaceId: string; ts: string }> = [];
  let tsSeq = 0;
  let startStreamRequests = 0;
  const adapter: SlackAdapter = {
    async postMessage(spaceId, text, replyOpts) {
      posts.push({ spaceId, text, opts: replyOpts });
      tsSeq += 1;
      return `post-${tsSeq}`;
    },
    async updateMessage(spaceId, ts, text, opts) {
      const blocks = opts?.blocks;
      updates.push(blocks !== undefined ? { spaceId, ts, text, opts: { blocks } } : { spaceId, ts, text });
    },
    async downloadFile() {
      throw new Error("not used");
    },
    async uploadFile() {
      return undefined;
    },
    async addReaction(spaceId, ts) {
      reactions.push({ kind: "add", spaceId, ts });
    },
    async removeReaction(spaceId, ts) {
      reactions.push({ kind: "remove", spaceId, ts });
    },
    async startStream(spaceId, streamOpts) {
      if (opts.failStart) throw new Error("invalid_stream_arguments: Agents feature not enabled");
      if (opts.failStartRequest) {
        startStreamRequests += 1;
        if (startStreamRequests === 1) throw new SlackStreamRequestError("missing_recipient_user_id");
      }
      streams.push({ spaceId, opts: streamOpts });
      return `stream-${streams.length}`;
    },
    async appendText(spaceId, ts, text) {
      if (opts.failAppend) throw new Error("invalid_stream_arguments: Agents feature not enabled");
      texts.push({ spaceId, ts, text });
    },
    async appendTask(spaceId, ts, task) {
      if (opts.failAppend) throw new Error("invalid_stream_arguments: Agents feature not enabled");
      tasks.push({ spaceId, ts, task });
    },
    async stopStream(spaceId, ts, text) {
      stops.push({ spaceId, ts, text });
      if (opts.failStop) throw new Error("invalid_stream_arguments: Agents feature not enabled");
    },
    streamingSupported: () => opts.streaming ?? true,
    async isChannelMember() {
      return true;
    },
    async postEphemeral() {},
    async start() {},
    async stop() {},
  };
  return { adapter, streams, texts, tasks, stops, posts, updates, reactions };
}

function recordingStore() {
  const audit: Array<{ space_id: string | null; actor: string; event_type: string; payload: string }> = [];
  // SAFETY: the presenter only calls appendAudit (and the tests getOrgSettings); a double exposing those two members satisfies the executed surface.
  const store = {
    appendAudit: async (entry: { space_id: string | null; actor: string; event_type: string; payload: string }) => {
      audit.push(entry);
      return audit.length;
    },
    getOrgSettings: (): OrgSettings | null => null,
  } as Store;
  return { store, audit };
}

function msg(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return { spaceId: "slack:C1", principal: "U1", text: "hello", ts: "1.1", ...overrides };
}

/** Flushes the fire-and-forget promise chains (phrase post, reaction, audits). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let fakeTimers = false;

afterEach(() => {
  if (fakeTimers) {
    vi.useRealTimers();
    fakeTimers = false;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// StreamTurnPresenter: the Slack-native thinking panel (issue #168).
// ---------------------------------------------------------------------------

describe("StreamTurnPresenter: thinking panel (issue #168)", () => {
  test("a turn with N gated tool calls renders N steps advancing in real time, and the final reply streams below", async () => {
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });

    // Receipt: the stream opens with the thinking phrase as its opening.
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    expect(rec.streams).toHaveLength(1);
    expect(rec.streams[0]).toMatchObject({ spaceId: "slack:C1", opts: { threadTs: "1.1", openingText: THINKING_PHRASES[0] } });
    const streamTs = `stream-${rec.streams.length}`;

    // N gated tool calls: each opens a card in_progress and checks it off.
    const steps: ToolStepEvent[] = [
      { spaceId: "slack:C1", taskId: nextToolStepId(), title: toolStepTitle("github.search_issues", "allowed (read)"), status: "in_progress", output: '{"query":"bugs"}' },
      { spaceId: "slack:C1", taskId: nextToolStepId(), title: toolStepTitle("create_work_item", "allowed (write)"), status: "in_progress", output: '{"title":"fix bug"}' },
    ];
    for (const step of steps) presenter.onToolStep(step);
    await flush();
    presenter.onToolStep({ ...steps[0]!, status: "complete" });
    presenter.onToolStep({ ...steps[1]!, status: "complete" });
    await flush();

    expect(rec.tasks).toHaveLength(4); // two opens + two completions
    expect(rec.tasks.map((c) => c.task.id)).toEqual([steps[0]!.taskId, steps[1]!.taskId, steps[0]!.taskId, steps[1]!.taskId]);
    expect(rec.tasks[0]!.task.status).toBe("in_progress");
    expect(rec.tasks[2]!.task.status).toBe("complete");
    expect(rec.tasks.map((c) => c.task.title)).toEqual([
      "github.search_issues — allowed (read)",
      "create_work_item — allowed (write)",
      "github.search_issues — allowed (read)",
      "create_work_item — allowed (write)",
    ]);
    expect(rec.tasks[0]!.task.output).toBe('{"query":"bugs"}');

    // Interim reply text streams below the panel...
    presenter.onMessage({ spaceId: "slack:C1", text: "Working on it" });
    presenter.onMessage({ spaceId: "slack:C1", text: "Done — here is the answer" });
    // ...and turn_end closes the stream with the final reply as the block.
    presenter.onTurnEnd({ spaceId: "slack:C1" });
    await flush();

    expect(rec.stops).toHaveLength(1);
    expect(rec.stops[0]).toMatchObject({ spaceId: "slack:C1", ts: streamTs, text: "Done — here is the answer" });
    // The coalesced interim append never landed: the final block superseded it.
    expect(rec.texts).toHaveLength(0);
  });

  test("a denied call renders one step stating the deny", async () => {
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
    presenter.onInbound(msg());
    await flush();

    const taskId = nextToolStepId();
    presenter.onToolStep({ spaceId: "slack:C1", taskId, title: toolStepTitle("bash", "denied (exec)"), status: "complete", output: '{"command":"rm -rf /"}' });
    await flush();

    expect(rec.tasks).toHaveLength(1);
    expect(rec.tasks[0]!.task).toMatchObject({ id: taskId, title: "bash — denied (exec)", status: "complete" });
  });

  test("an ask-human call shows waiting for approval until it resolves, sharing one card id", async () => {
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
    presenter.onInbound(msg());
    await flush();

    const taskId = nextToolStepId();
    // While the approval router waits: in_progress "waiting for approval".
    presenter.onToolStep({ spaceId: "slack:C1", taskId, title: toolStepTitle("create_work_item", "waiting for approval"), status: "in_progress", output: '{"title":"x"}' });
    await flush();
    // Approved: the SAME card checks off as complete.
    presenter.onToolStep({ spaceId: "slack:C1", taskId, title: toolStepTitle("create_work_item", "approved (write)"), status: "complete", output: '{"title":"x"}' });
    await flush();

    expect(rec.tasks).toHaveLength(2);
    expect(rec.tasks[0]!.task).toMatchObject({ id: taskId, status: "in_progress", title: "create_work_item — waiting for approval" });
    expect(rec.tasks[1]!.task).toMatchObject({ id: taskId, status: "complete", title: "create_work_item — approved (write)" });
  });

  test("secret-shaped args never reach a step: redacted at the source, rendered as [REDACTED]", () => {
    // The source composes + redacts (the audit's pass). Secret-shaped values
    // in the args summary render [REDACTED]; the panel never sees raw args.
    const stepArgs = redact(JSON.stringify({ api_key: "sk-ant-api03-0123456789abcdef", token: "xoxb-1234567890-abcdef" }));
    expect(stepArgs).not.toContain("sk-ant-api03-0123456789abcdef");
    expect(stepArgs).not.toContain("xoxb-1234567890-abcdef");
    expect(stepArgs).toContain("[REDACTED]");
    expect(stepArgs).toContain("sk-[REDACTED]");
  });

  test("secret-shaped tool names are redacted in step titles too", () => {
    expect(toolStepTitle("github_pat_0123456789abcdefghij", "allowed (read)")).not.toContain("github_pat_0123456789abcdefghij");
    expect(toolStepTitle("github_pat_0123456789abcdefghij", "allowed (read)")).toContain("[REDACTED]");
  });

  test("live thinking chunks render nothing on the panel — #193 is the plain path (issue #193)", async () => {
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    expect(rec.streams).toHaveLength(1);

    // Thinking must not append a progress line to the stream...
    presenter.onThinking({ spaceId: "slack:C1", thinking: "deep reasoning in progress" });
    await flush();
    expect(rec.texts).toHaveLength(0);

    // ...and the reply still closes the stream as usual.
    presenter.onMessage({ spaceId: "slack:C1", text: "answer" });
    presenter.onTurnEnd({ spaceId: "slack:C1" });
    await flush();
    expect(rec.texts).toHaveLength(0);
    expect(rec.stops).toEqual([{ spaceId: "slack:C1", ts: "stream-1", text: "answer" }]);
  });
});

// ---------------------------------------------------------------------------
// Streaming coalescing + fallback (issues #120/#168).
// ---------------------------------------------------------------------------

describe("StreamTurnPresenter: throttle and fallback", () => {
  test("interim markdown_text appends respect the STREAM_UPDATE_INTERVAL_MS throttle", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
    presenter.onInbound(msg());
    await flush();

    // Burst of reply text inside one turn: coalesced, nothing appended yet.
    for (const chunk of ["The", "The quick", "The quick brown"]) {
      presenter.onMessage({ spaceId: "slack:C1", text: chunk });
    }
    await flush();
    expect(rec.texts).toHaveLength(0); // batched: no per-chunk spam

    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS);
    await flush();
    expect(rec.texts).toHaveLength(1); // at most one append per tick
    expect(rec.texts[0]!.text).toBe("The quick brown"); // latest text only

    // turn_end closes the stream with the final text; a pending append is superseded.
    presenter.onMessage({ spaceId: "slack:C1", text: "The quick brown fox" });
    presenter.onTurnEnd({ spaceId: "slack:C1" });
    await flush();
    expect(rec.stops).toHaveLength(1);
    expect(rec.stops[0]!.text).toBe("The quick brown fox");
    expect(rec.texts).toHaveLength(1); // the interim append; the final rode stopStream
  });

  test("a failing startStream falls back to the phrase + edit path with no dropped reply", async () => {
    const rec = recordingAdapter({ failStart: true });
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });

    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    // The stream failed: the phrase landed as a plain post, no stream opened.
    expect(rec.streams).toHaveLength(0);
    expect(rec.posts).toHaveLength(1);
    expect(rec.posts[0]).toMatchObject({ spaceId: "slack:C1", text: THINKING_PHRASES[0] });

    // The reply edits the phrase in place — never dropped.
    presenter.onMessage({ spaceId: "slack:C1", text: "Here is the final answer" });
    presenter.onTurnEnd({ spaceId: "slack:C1" });
    await flush();
    expect(rec.updates).toEqual([{ spaceId: "slack:C1", ts: "post-1", text: "Here is the final answer" }]);
    expect(rec.stops).toHaveLength(0);
  });

  test("a channel stream open carries the initiating user as recipientUserId (issue #287)", async () => {
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });

    presenter.onInbound(msg({ ts: "1.1", principal: "U456" }));
    await flush();
    expect(rec.streams).toHaveLength(1);
    expect(rec.streams[0]).toMatchObject({
      spaceId: "slack:C1",
      opts: { threadTs: "1.1", openingText: THINKING_PHRASES[0], recipientUserId: "U456" },
    });
  });

  test("a channel turn with no initiating identity bypasses streaming: phrase+edit posts, zero startStream calls (issue #287)", async () => {
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });

    // SlackMessage.principal is zod-required on the wire, but the presenter
    // must not depend on it. Delete it after creating a valid normalized
    // message to simulate identity loss inside the process.
    const missingPrincipal = msg({ ts: "1.1" });
    Reflect.deleteProperty(missingPrincipal, "principal");
    presenter.onInbound(missingPrincipal);
    await flush();
    expect(rec.streams).toHaveLength(0); // zero startStream calls
    expect(rec.posts).toEqual([{ spaceId: "slack:C1", text: THINKING_PHRASES[0], opts: { threadTs: "1.1" } }]);

    // The reply still lands phrase+edit — never dropped.
    presenter.onMessage({ spaceId: "slack:C1", text: "final answer" });
    presenter.onTurnEnd({ spaceId: "slack:C1" });
    await flush();
    expect(rec.updates).toEqual([{ spaceId: "slack:C1", ts: "post-1", text: "final answer" }]);
    expect(rec.stops).toHaveLength(0);
  });

  test("a request-rejected stream stays local: this turn falls back, the NEXT turn still opens a stream (issue #287)", async () => {
    const rec = recordingAdapter({ failStartRequest: true });
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });

    // Turn one: chat.startStream rejects THIS request (missing recipient)
    // — the phrase lands via postMessage and streaming stays enabled.
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    expect(rec.streams).toHaveLength(0);
    expect(rec.posts).toEqual([{ spaceId: "slack:C1", text: THINKING_PHRASES[0], opts: { threadTs: "1.1" } }]);
    presenter.onMessage({ spaceId: "slack:C1", text: "first answer" });
    presenter.onTurnEnd({ spaceId: "slack:C1" });
    await flush();
    expect(rec.updates).toContainEqual({ spaceId: "slack:C1", ts: "post-1", text: "first answer" });

    // Turn two: the identity is available again — the stream OPENS, so the
    // request rejection never poisoned streaming for the boot. The extra
    // flush drains turn one's async finalize (the pending phrase is only
    // cleared once its in-place delivery settles).
    await flush();
    presenter.onInbound(msg({ ts: "2.2", principal: "U456" }));
    await flush();
    expect(rec.streams).toHaveLength(1);
    expect(rec.streams[0]).toMatchObject({
      spaceId: "slack:C1",
      opts: { threadTs: "2.2", recipientUserId: "U456" },
    });
  });

  test("a mid-boot appendStream failure flips to the phrase+edit path without dropping the reply", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter({ failAppend: true });
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });

    // The stream opens (the workspace looked capable at the turn start).
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    expect(rec.streams).toHaveLength(1);
    const streamTs = "stream-1";

    // Interim reply text: the append FAILS — the presenter flips to the
    // phrase path and the text lands as an in-place edit of the stream
    // message (never dropped, never re-attempted on a dead stream).
    presenter.onMessage({ spaceId: "slack:C1", text: "Working on it" });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS);
    await flush();
    expect(rec.texts).toHaveLength(0); // the append never landed
    expect(rec.updates).toEqual([{ spaceId: "slack:C1", ts: streamTs, text: "Working on it" }]);

    // The final reply still lands (in place), and the stream is never
    // re-opened: the fallback holds for the boot.
    presenter.onMessage({ spaceId: "slack:C1", text: "Here is the final answer" });
    presenter.onTurnEnd({ spaceId: "slack:C1" });
    await flush();
    expect(rec.updates).toContainEqual({ spaceId: "slack:C1", ts: streamTs, text: "Here is the final answer" });
    expect(rec.stops).toHaveLength(0);
    expect(rec.streams).toHaveLength(1);

    // Turn two keeps the one-message rule (#120): the phrase ROTATES the
    // stream message in place (no fresh post, no stream re-open) — the
    // fallback is permanent.
    presenter.onInbound(msg({ ts: "2.2" }));
    await flush();
    expect(rec.streams).toHaveLength(1);
    expect(rec.posts).toHaveLength(0);
    expect(rec.updates).toContainEqual({ spaceId: "slack:C1", ts: streamTs, text: THINKING_PHRASES[1] });
  });

  test("a stopStream failure never drops the final reply — it lands as an in-place edit", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter({ failStop: true });
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });

    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    expect(rec.streams).toHaveLength(1);
    const streamTs = "stream-1";

    presenter.onMessage({ spaceId: "slack:C1", text: "The final answer" });
    presenter.onTurnEnd({ spaceId: "slack:C1" });
    await flush();
    // The bounded stopStream retries all fail...
    for (let attempt = 0; attempt <= STREAM_FINAL_RETRY_LIMIT; attempt += 1) {
      vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS);
      await flush();
    }
    // ...and the final reply lands as an in-place edit of the stream message.
    expect(rec.stops.length).toBe(STREAM_FINAL_RETRY_LIMIT + 1); // initial + bounded retries
    expect(rec.updates).toContainEqual({ spaceId: "slack:C1", ts: streamTs, text: "The final answer" });

    // The fallback holds: the next turn opens a plain phrase post.
    presenter.onInbound(msg({ ts: "2.2" }));
    await flush();
    expect(rec.streams).toHaveLength(1);
    expect(rec.posts).toEqual([{ spaceId: "slack:C1", text: THINKING_PHRASES[1], opts: { threadTs: "2.2" } }]);
  });

  test("receipt reaction, message.reply latency audit, and phrase rotation are unchanged by streaming mode", async () => {
    const rec = recordingAdapter();
    const { store, audit } = recordingStore();
    const rotation = createPhraseRotation();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
      phraseRotation: rotation,
    });

    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    // Receipt reaction lands; receipt audit row written (ts only, never text).
    expect(rec.reactions.filter((r) => r.kind === "add")).toEqual([{ kind: "add", spaceId: "slack:C1", ts: "1.1" }]);
    const received = audit.find((row) => row.event_type === MESSAGE_RECEIVED_EVENT);
    expect(received).toMatchObject({ space_id: "slack:C1", actor: "U1" });
    expect(JSON.parse(received!.payload)).toEqual({ ts: "1.1" });

    // Reply lands → reaction removed, latency audited, stream closed.
    presenter.onMessage({ spaceId: "slack:C1", text: "answer" });
    presenter.onTurnEnd({ spaceId: "slack:C1" });
    await flush();
    expect(rec.reactions.filter((r) => r.kind === "remove")).toEqual([{ kind: "remove", spaceId: "slack:C1", ts: "1.1" }]);
    const replied = audit.find((row) => row.event_type === MESSAGE_REPLIED_EVENT);
    expect(replied).toMatchObject({ space_id: "slack:C1" });
    const latency = JSON.parse(replied!.payload);
    expect(latency.latency_ms).toEqual(expect.any(Number));
    expect(latency.latency_ms).toBeGreaterThanOrEqual(0);

    // Turn two: the stream re-opens under the new inbound ts, rotating the
    // phrase through the SHARED rotation (one sequence across turns).
    presenter.onInbound(msg({ ts: "2.2" }));
    await flush();
    expect(rec.streams).toHaveLength(2);
    expect(rec.streams[1]).toMatchObject({ spaceId: "slack:C1", opts: { threadTs: "2.2", openingText: THINKING_PHRASES[1] } });
  });

  test("the receipt reaction acks once per unique inbound ts — redeliveries never re-fire (issue #183)", async () => {
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });

    // Slack redelivers the same inbound message (same ts): the #119 ack
    // used to re-fire addReaction and hit `already_reacted`. One ack per
    // unique ts, and a NEW ts still acks normally.
    presenter.onInbound(msg({ ts: "1.1" }));
    presenter.onInbound(msg({ ts: "1.1" })); // redelivery — must NOT re-ack
    presenter.onInbound(msg({ ts: "2.2" }));
    await flush();
    expect(rec.reactions.filter((r) => r.kind === "add")).toEqual([
      { kind: "add", spaceId: "slack:C1", ts: "1.1" },
      { kind: "add", spaceId: "slack:C1", ts: "2.2" },
    ]);

    // The reply clears each pending reaction exactly once; a redelivery of
    // an ALREADY-ACKED ts after the reply never re-acks (the message was
    // answered — no stale 👀 resurrection).
    presenter.onMessage({ spaceId: "slack:C1", text: "answer" });
    presenter.onTurnEnd({ spaceId: "slack:C1" });
    await flush();
    expect(rec.reactions.filter((r) => r.kind === "remove")).toEqual([
      { kind: "remove", spaceId: "slack:C1", ts: "1.1" },
      { kind: "remove", spaceId: "slack:C1", ts: "2.2" },
    ]);
    presenter.onInbound(msg({ ts: "1.1" })); // post-reply redelivery
    await flush();
    expect(rec.reactions.filter((r) => r.kind === "add")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// SlackTurnPresenter (the phrase renderer): no panel, but the rest is shared.
// ---------------------------------------------------------------------------

describe("SlackTurnPresenter (phrase renderer): live progress, no panel", () => {
  test("a gated tool step becomes the in-place progress line (throttled); the phrase+edit path still delivers the reply", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    expect(rec.posts).toHaveLength(1);
    expect(rec.streams).toHaveLength(0);
    const phraseTs = "post-1";

    // A gated tool call in the phrase renderer (issue #193): the step
    // becomes the in-place progress line — never a panel card, and
    // coalesced on the cadence (nothing flushes before the throttle).
    emitToolStep(
      (step) => presenter.onToolStep(step),
      { spaceId: "slack:C1", taskId: nextToolStepId(), title: toolStepTitle("bash", "allowed (exec)"), status: "in_progress" },
    );
    await flush();
    expect(rec.tasks).toHaveLength(0);
    expect(rec.updates).toHaveLength(0);

    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates).toContainEqual({ spaceId: "slack:C1", ts: phraseTs, text: "⚙️ bash — allowed (exec)" });

    // The final reply replaces the progress line in place — and no stale
    // progress update (or elapsed tick) overwrites it afterwards.
    presenter.onMessage({ spaceId: "slack:C1", text: "Here is the final answer" });
    await flush();
    expect(rec.updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: phraseTs, text: "Here is the final answer" });
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 3);
    await flush();
    expect(rec.updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: phraseTs, text: "Here is the final answer" });
  });

  test("a confirmed-write failure step is a visible ⚙️ line in the DM/phrase path and resolves (issue #277)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    expect(rec.streams).toHaveLength(0); // DM → phrase path, no panel
    const phraseTs = "post-1";

    // A confirmed write that FAILED (issue #277): the router opens the step
    // as in_progress (the failing tool is the CURRENT step)…
    const taskId = nextToolStepId();
    presenter.onToolStep({
      spaceId: "slack:C1",
      taskId,
      title: toolStepTitle("create_work_item", "confirmed write failed"),
      status: "in_progress",
      output: "disk full",
    });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    // …and the phrase renderer makes the failure VISIBLE as the progress line.
    expect(rec.updates).toContainEqual({
      spaceId: "slack:C1",
      ts: phraseTs,
      text: "⚙️ create_work_item — confirmed write failed",
    });

    // …then completes it with the same taskId: valid lifecycle, no orphaned
    // complete, and the line still resolves onward.
    presenter.onToolStep({
      spaceId: "slack:C1",
      taskId,
      title: toolStepTitle("create_work_item", "confirmed write failed"),
      status: "complete",
      output: "disk full",
    });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates.at(-1)?.text).not.toContain("confirmed write failed");

    // The final reply replaces the progress line in place.
    presenter.onMessage({ spaceId: "slack:C1", text: "Here is the answer" });
    await flush();
    expect(rec.updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: phraseTs, text: "Here is the answer" });
  });

  test("a turn with tool steps + thinking blocks renders progress updates in place, throttled (issue #193)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    expect(rec.posts).toEqual([{ spaceId: "slack:C1", text: THINKING_PHRASES[0], opts: { threadTs: "1.1" } }]);
    const phraseTs = "post-1";

    // A burst of steps + thinking inside one turn: coalesced — no
    // per-event spam before the throttle.
    const stepId = nextToolStepId();
    presenter.onToolStep({ spaceId: "slack:C1", taskId: stepId, title: toolStepTitle("github.search_issues", "allowed (read)"), status: "in_progress" });
    presenter.onThinking({ spaceId: "slack:C1", thinking: "Let me check the repo first" });
    await flush();
    expect(rec.updates).toHaveLength(0);

    // Priority: the CURRENT STEP beats the thinking snippet.
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: phraseTs, text: "⚙️ github.search_issues — allowed (read)" });

    // The step completes: the line falls back to the thinking snippet.
    presenter.onToolStep({ spaceId: "slack:C1", taskId: stepId, title: toolStepTitle("github.search_issues", "allowed (read)"), status: "complete" });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: phraseTs, text: "🧠 Let me check the repo first" });

    // The final reply replaces the progress line in place, exactly once.
    presenter.onMessage({ spaceId: "slack:C1", text: "Done — here is the answer" });
    await flush();
    expect(rec.updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: phraseTs, text: "Done — here is the answer" });
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 3);
    await flush();
    expect(rec.updates.filter((u) => u.ts === phraseTs).at(-1)!.text).toBe("Done — here is the answer");
  });

  test("without thinking, the progress line shows the step or the elapsed phrase only (issue #193)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    const phraseTs = "post-1";

    // No step, no thinking: the elapsed tick keeps the phrase live.
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates.at(-1)?.text).toMatch(/^Thinking… \d+s$/);

    // A step supersedes the elapsed line...
    presenter.onToolStep({ spaceId: "slack:C1", taskId: nextToolStepId(), title: toolStepTitle("bash", "allowed (exec)"), status: "in_progress" });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: phraseTs, text: "⚙️ bash — allowed (exec)" });
    // ...and a 🧠 line NEVER appears (no thinking ever arrived).
    expect(rec.updates.some((u) => u.text?.startsWith("🧠") ?? false)).toBe(false);
  });

  test("long reasoning truncates to a ~200-char tail snippet (issue #193)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();

    const head = "The user wants to know why the build failed";
    const tail = "so I should check the CI logs before answering";
    const long = `${head} ${"reasoning ".repeat(40)} ${tail}`;
    expect(long.length).toBeGreaterThan(THINKING_SNIPPET_MAX);
    presenter.onThinking({ spaceId: "slack:C1", thinking: long });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();

    const line = rec.updates.at(-1)!.text!;
    expect(line.startsWith("🧠 …")).toBe(true);
    // The snippet is capped at THINKING_SNIPPET_MAX characters...
    expect(line.length).toBe("🧠 ".length + THINKING_SNIPPET_MAX);
    // ...and it is the TAIL of the reasoning (the part still moving), not
    // the frozen head.
    expect(line).toContain(tail);
    expect(line).not.toContain(head);
  });

  test("a retry turn_start keeps a live 🧠 reasoning line — no rotating phrase over it (issue #251)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const rotation = { next: vi.fn(() => THINKING_PHRASES[0]) };
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
      phraseRotation: rotation,
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    const phraseTs = "post-1"; // the first postMessage resolves to post-1

    // Reasoning streams in (#193) and flushes to the in-place 🧠 line.
    presenter.onThinking({ spaceId: "slack:C1", thinking: "Let me trace the failure path" });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: phraseTs, text: "🧠 Let me trace the failure path" });

    // OMP auto-retry (issue #60) re-fires turn_start after thinking has
    // streamed in. It must NOT rotate the phrase over the live reasoning
    // (#251): the 🧠 line stays and no new phrase is requested.
    presenter.onTurnStart();
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: phraseTs, text: "🧠 Let me trace the failure path" });
    expect(rotation.next).toHaveBeenCalledTimes(1); // the initial post only — no retry phrase
  });

  test("a retry turn_start keeps a live ⚙️ tool step line — no rotating phrase over it (issue #251)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const rotation = { next: vi.fn(() => THINKING_PHRASES[0]) };
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
      phraseRotation: rotation,
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    const phraseTs = "post-1"; // the first postMessage resolves to post-1

    // A gated tool call is IN FLIGHT (#193): the step becomes the ⚙️ line.
    emitToolStep(
      (step) => presenter.onToolStep(step),
      { spaceId: "slack:C1", taskId: nextToolStepId(), title: toolStepTitle("bash", "allowed (exec)"), status: "in_progress" },
    );
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: phraseTs, text: "⚙️ bash — allowed (exec)" });

    // A retry's turn_start must not clobber the in-flight step (#251).
    presenter.onTurnStart();
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: phraseTs, text: "⚙️ bash — allowed (exec)" });
    expect(rotation.next).toHaveBeenCalledTimes(1); // the initial post only — no retry phrase
  });

  test("a turn_start with NO live progress still rotates the phrase (issue #251 keeps rotation)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const rotation = createPhraseRotation();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
      phraseRotation: rotation,
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    const phraseTs = "post-1"; // no step, no thinking yet — only the elapsed line

    // Only the elapsed tick has rendered so far — no real progress content.
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates.at(-1)?.text).toMatch(/^Thinking… \d+s$/);

    // With nothing live to protect, turn_start rotates exactly as before.
    presenter.onTurnStart();
    await flush();
    expect(rec.updates.at(-1)).toEqual({ spaceId: "slack:C1", ts: phraseTs, text: THINKING_PHRASES[1] });
  });
});

describe("Codex mint-failure surface (issue #218)", () => {
  /** The proxy's actual 502 body (verified from iron-proxy v0.49.0), as the SDK surfaces it. */
  const MINT_502 = '{"error":"oauth_token failed to mint an access token","grant":"refresh_token"}';

  function plainPresenter(rec: RecordedAdapter): SlackTurnPresenter {
    const { store } = recordingStore();
    return new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
  }

  test("an empty completion whose cause is the proxy's mint failure surfaces the remedy, not the generic fallback", async () => {
    const rec = recordingAdapter();
    const presenter = plainPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    presenter.onMessage({ spaceId: "slack:C1", text: "", error: MINT_502 });
    await flush();

    const visible = rec.updates.at(-1)!.text;
    expect(visible).toContain("codex login");
    expect(visible).toContain("restart the server");
    expect(visible).not.toContain("Hmm — I got an empty response");
  });

  test("a session error carrying the proxy's mint failure maps to the remedy", async () => {
    const rec = recordingAdapter();
    const presenter = plainPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    presenter.onError({ spaceId: "slack:C1", message: MINT_502 });
    await flush();

    const visible = rec.updates.at(-1)!.text;
    expect(visible).toContain("codex login");
    expect(visible).toContain("restart the server");
  });

  test("the 403-no-body family (a bare 403 in the message) maps to the codex remedy when codex IS the active provider", async () => {
    const rec = recordingAdapter();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store: recordingStore().store,
      onboardingChecks: () => [],
      provider: "openai-codex",
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    presenter.onMessage({ spaceId: "slack:C1", text: "", error: "Request failed with status code 403" });
    await flush();

    const visible = rec.updates.at(-1)!.text;
    expect(visible).toContain("codex login");
    expect(visible).toContain("restart the server");
  });

  test("a bare 403 for a NON-codex provider maps to the provider-aware remedy, not codex login (issue #342)", async () => {
    const rec = recordingAdapter();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store: recordingStore().store,
      onboardingChecks: () => [],
      provider: "near",
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    presenter.onMessage({ spaceId: "slack:C1", text: "", error: "Request failed with status code 403" });
    await flush();

    const visible = rec.updates.at(-1)!.text;
    expect(visible).toContain("near");
    expect(visible).toContain("NEAR_API_KEY");
    expect(visible).toContain("restart the server");
    expect(visible).not.toContain("codex login");
  });

  test("a bare 403 with NO provider context keeps its original text (fail-closed, never a false codex login)", async () => {
    const rec = recordingAdapter();
    const presenter = plainPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    presenter.onError({ spaceId: "slack:C1", message: "Request failed with status code 403" });
    await flush();

    expect(rec.updates.at(-1)!.text).toBe("Request failed with status code 403");
    expect(rec.updates.at(-1)!.text).not.toContain("codex login");
  });

  test("a non-mint error keeps its exact text (no false mapping)", async () => {
    const rec = recordingAdapter();
    const presenter = plainPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    presenter.onError({ spaceId: "slack:C1", message: "model exploded" });
    await flush();

    expect(rec.updates.at(-1)!.text).toBe("model exploded");
  });
});

// ---------------------------------------------------------------------------
// Threaded inbound turns (issue #289): a user request that is itself a
// Slack thread reply (inbound carries thread_ts) gets a reaction-only
// receipt — NO thinking placeholder, NO stream open, NO progress line —
// and the final/error reply posts as a NEW message under the conversation
// ROOT thread, never an edit of a placeholder and never a nested thread
// under the latest inbound reply. Top-level channel turns and DMs keep
// their existing placeholder+edit / plain-message behavior.
// ---------------------------------------------------------------------------

describe("SlackTurnPresenter: threaded inbound turns (issue #289)", () => {
  function threadedPresenter(rec: RecordedAdapter): SlackTurnPresenter {
    const { store } = recordingStore();
    return new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
  }

  test("a thread reply gets a reaction-only receipt; the final reply posts NEW under the root, never an edit", async () => {
    const rec = recordingAdapter();
    const { store, audit } = recordingStore();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });

    // Receipt: the inbound is a reply inside root thread ts=1.0.
    presenter.onInbound(msg({ ts: "1.1", threadTs: "1.0" }));
    await flush();
    expect(rec.posts).toHaveLength(0); // no thinking placeholder
    expect(rec.streams).toHaveLength(0); // no stream open
    expect(rec.reactions).toEqual([{ kind: "add", spaceId: "slack:C1", ts: "1.1" }]);

    // turn_start must not re-arm a placeholder on the threaded turn.
    presenter.onTurnStart();
    await flush();
    expect(rec.posts).toHaveLength(0);

    // The final reply is a NEW message under the ROOT — never chat.update.
    presenter.onMessage({ spaceId: "slack:C1", text: "the answer" });
    await flush();
    expect(rec.posts).toEqual([{ spaceId: "slack:C1", text: "the answer", opts: { threadTs: "1.0" } }]);
    expect(rec.updates).toHaveLength(0);

    // The receipt reaction comes off and the audits remain (issue #119).
    expect(rec.reactions).toEqual([
      { kind: "add", spaceId: "slack:C1", ts: "1.1" },
      { kind: "remove", spaceId: "slack:C1", ts: "1.1" },
    ]);
    const types = audit.map((a) => a.event_type);
    expect(types).toContain(MESSAGE_RECEIVED_EVENT);
    expect(types).toContain(MESSAGE_REPLIED_EVENT);
  });

  test("an error on a threaded turn posts a fresh terminal reply under the root", async () => {
    const rec = recordingAdapter();
    const presenter = threadedPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1", threadTs: "1.0" }));
    await flush();
    expect(rec.posts).toHaveLength(0);

    presenter.onError({ spaceId: "slack:C1", message: "provider exploded" });
    await flush();

    expect(rec.posts).toHaveLength(1);
    expect(rec.posts[0]).toMatchObject({ spaceId: "slack:C1", opts: { threadTs: "1.0" } });
    expect(rec.posts[0]!.text).toContain("provider exploded");
    expect(rec.updates).toHaveLength(0); // fresh post, never an edit
  });

  test("a drained thread message answers under the root with no placeholder", async () => {
    const rec = recordingAdapter();
    const presenter = threadedPresenter(rec);
    // The drained message is itself a thread reply (ts=2.1 inside root 1.0).
    presenter.onQueueDrain("2.1", "U1", "1.0");
    await flush();
    expect(rec.posts).toHaveLength(0); // reaction-only drain, no placeholder

    presenter.onTurnStart();
    await flush();
    expect(rec.posts).toHaveLength(0);

    presenter.onMessage({ spaceId: "slack:C1", text: "queued answer" });
    await flush();
    expect(rec.posts).toEqual([{ spaceId: "slack:C1", text: "queued answer", opts: { threadTs: "1.0" } }]);
    expect(rec.updates).toHaveLength(0);
  });

  test("top-level channel turns keep the placeholder + in-place-edit path (issue #289 must not regress them)", async () => {
    const rec = recordingAdapter();
    const presenter = threadedPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    expect(rec.posts).toEqual([{ spaceId: "slack:C1", text: THINKING_PHRASES[0], opts: { threadTs: "1.1" } }]);

    presenter.onMessage({ spaceId: "slack:C1", text: "plain answer" });
    await flush();
    expect(rec.updates).toEqual([{ spaceId: "slack:C1", ts: "post-1", text: "plain answer" }]);
    expect(rec.posts).toHaveLength(1); // the placeholder was edited, never stacked
  });

  test("a DM thread reply still posts plainly (DMs never thread; issue #180 unchanged)", async () => {
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:D1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1", threadTs: "1.0" }));
    await flush();
    expect(rec.posts).toHaveLength(0); // reaction-only receipt

    presenter.onMessage({ spaceId: "slack:D1", text: "dm answer" });
    await flush();
    expect(rec.posts).toEqual([{ spaceId: "slack:D1", text: "dm answer", opts: undefined }]);
    expect(rec.updates).toHaveLength(0);
  });

  test("the STREAMING renderer is reaction-only for threaded turns too: no stream opens, the final reply posts under the root", async () => {
    const rec = recordingAdapter({ streaming: true });
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });

    presenter.onInbound(msg({ ts: "1.1", threadTs: "1.0" }));
    await flush();
    presenter.onTurnStart();
    await flush();
    expect(rec.streams).toHaveLength(0); // zero startStream calls
    expect(rec.posts).toHaveLength(0); // zero placeholder posts

    // Completion: the final reply posts as a NEW message under the root —
    // no stream to append to, no phrase to edit.
    presenter.onMessage({ spaceId: "slack:C1", text: "the answer" });
    presenter.onTurnEnd({ spaceId: "slack:C1" });
    await flush();
    expect(rec.streams).toHaveLength(0);
    expect(rec.posts).toEqual([{ spaceId: "slack:C1", text: "the answer", opts: { threadTs: "1.0" } }]);
    expect(rec.updates).toHaveLength(0);
    expect(rec.reactions).toEqual([
      { kind: "add", spaceId: "slack:C1", ts: "1.1" },
      { kind: "remove", spaceId: "slack:C1", ts: "1.1" },
    ]);
  });

  test("receipt() alone (queue time) never activates the turn surface; activateInbound() opens it when the turn starts", async () => {
    const rec = recordingAdapter();
    const { store, audit } = recordingStore();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });

    // Queue-time receipt of a top-level message that will QUEUE behind the
    // running turn: reaction + message.in audit only. The turn identity
    // (threading base, placeholder) must stay untouched — a queued message
    // must never retarget the running turn (issue #289 review).
    const m = msg({ ts: "5.0" });
    presenter.receipt(m);
    await flush();
    expect(rec.posts).toHaveLength(0); // no placeholder at queue time
    expect(rec.reactions).toEqual([{ kind: "add", spaceId: "slack:C1", ts: "5.0" }]);
    expect(audit.map((a) => a.event_type)).toContain(MESSAGE_RECEIVED_EVENT);
    expect(presenter.latestInboundTs()).toBeUndefined(); // identity untouched

    // The message's turn actually starts: identity activation opens the
    // phrase under the message.
    presenter.activateInbound(m);
    await flush();
    expect(rec.posts).toEqual([{ spaceId: "slack:C1", text: THINKING_PHRASES[0], opts: { threadTs: "5.0" } }]);
    expect(presenter.latestInboundTs()).toBe("5.0");
  });

  test("a threaded drain re-arms the steer safe-window: the delivered flag resets even though no placeholder opens (issue #289 review)", async () => {
    const rec = recordingAdapter();
    const presenter = threadedPresenter(rec);

    // A delivered top-level turn closes the steer safe-window (#219).
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    presenter.onMessage({ spaceId: "slack:C1", text: "answered" });
    await flush();
    expect(presenter.canSteer()).toBe(false);

    // A threaded drain opens a FRESH turn: reaction-only (no placeholder —
    // the post count must not grow), but the fresh-turn bookkeeping must
    // reset so the drained turn can steer, re-render progress, and count
    // empty completions like any other fresh turn.
    const postsBeforeDrain = rec.posts.length; // turn 1's own phrase
    presenter.onQueueDrain("2.1", "U1", "1.0");
    await flush();
    expect(rec.posts).toHaveLength(postsBeforeDrain); // no drain placeholder
    expect(presenter.canSteer()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live todo tiers (issue #228): the phrase line's "🛠 N/M — current step"
// indicator for multi-step turns, and the in-place "🛠 Agent's plan"
// message for long turns (>= 3 steps across >= 2 phases), edited as steps
// complete and LEFT as the turn's record at turn end (boring option).
// ---------------------------------------------------------------------------

describe("SlackTurnPresenter: live todo tiers (issue #228)", () => {
  function plainPresenter(rec: RecordedAdapter): SlackTurnPresenter {
    const { store } = recordingStore();
    return new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
  }

  /** A long plan: 3 steps across 2 phases, step 1 completed, step 2 in progress. */
  const LONG_PLAN = [
    {
      name: "Research",
      tasks: [
        { content: "Read the repo", status: "completed" as const },
        { content: "Draft the section", status: "in_progress" as const },
      ],
    },
    { name: "Land", tasks: [{ content: "Push + PR", status: "pending" as const }] },
  ];

  test("a multi-step plan adds the 🛠 N/M progress indicator to the phrase line (issue #228)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const presenter = plainPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    expect(rec.posts).toHaveLength(1);

    // A 3-step plan in ONE phase: the phrase line gains the indicator, but
    // no plan message posts (not multi-stage — the indicator tier only).
    const singlePhase = [
      {
        name: "All",
        tasks: [
          { content: "Read the repo", status: "completed" as const },
          { content: "Draft the section", status: "in_progress" as const },
          { content: "Push + PR", status: "pending" as const },
        ],
      },
    ];
    presenter.onTodoPhases({ spaceId: "slack:C1", phases: singlePhase });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates.at(-1)?.text).toMatch(/^Thinking… \d+s · 🛠 2\/3 — Draft the section$/);
    expect(rec.posts.some((p) => p.text?.includes("🛠 Agent's plan") ?? false)).toBe(false);

    // Step 2 completes, step 3 runs: the indicator advances in place.
    const advanced = [
      {
        name: "All",
        tasks: [
          { content: "Read the repo", status: "completed" as const },
          { content: "Draft the section", status: "completed" as const },
          { content: "Push + PR", status: "in_progress" as const },
        ],
      },
    ];
    presenter.onTodoPhases({ spaceId: "slack:C1", phases: advanced });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.updates.at(-1)?.text).toMatch(/🛠 3\/3 — Push \+ PR$/);

    // One phrase message only — the indicator edited it in place.
    expect(rec.posts).toHaveLength(1);
  });

  test("a short plan (<= 1 step) shows nothing extra on the phrase line (issue #228)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const presenter = plainPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();

    presenter.onTodoPhases({
      spaceId: "slack:C1",
      phases: [{ name: "One", tasks: [{ content: "Just one step", status: "in_progress" }] }],
    });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();

    expect(rec.updates.some((u) => u.text?.includes("🛠") ?? false)).toBe(false);
    expect(rec.posts.some((p) => p.text?.includes("🛠 Agent's plan") ?? false)).toBe(false);
  });

  test("a long turn posts the in-place plan message and edits it as steps complete (issue #228)", async () => {
    const rec = recordingAdapter();
    const presenter = plainPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    expect(rec.posts).toHaveLength(1); // the thinking phrase

    // First qualifying snapshot: the plan message posts under the inbound.
    presenter.onTodoPhases({ spaceId: "slack:C1", phases: LONG_PLAN });
    await flush();
    expect(rec.posts).toHaveLength(2);
    expect(rec.posts[1]!.text).toBe(
      "🛠 Agent's plan:\n  ✅ 1. Read the repo\n  ⏳ 2. Draft the section\n  ⏳ 3. Push + PR",
    );
    expect(rec.posts[1]!.opts).toEqual({ threadTs: "1.1" });
    const planTs = "post-2";

    // A later snapshot EDITS the same message in place — never a second post.
    const advanced = [
      {
        name: "Research",
        tasks: [
          { content: "Read the repo", status: "completed" as const },
          { content: "Draft the section", status: "completed" as const },
        ],
      },
      { name: "Land", tasks: [{ content: "Push + PR", status: "in_progress" as const }] },
    ];
    presenter.onTodoPhases({ spaceId: "slack:C1", phases: advanced });
    await flush();
    expect(rec.posts).toHaveLength(2);
    expect(rec.updates).toContainEqual({
      spaceId: "slack:C1",
      ts: planTs,
      text: "🛠 Agent's plan:\n  ✅ 1. Read the repo\n  ✅ 2. Draft the section\n  ⏳ 3. Push + PR",
    });
  });

  test("a non-long plan (3 steps in ONE phase) posts no plan message (issue #228)", async () => {
    const rec = recordingAdapter();
    const presenter = plainPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();

    presenter.onTodoPhases({
      spaceId: "slack:C1",
      phases: [
        {
          name: "All",
          tasks: [
            { content: "One", status: "completed" },
            { content: "Two", status: "in_progress" },
            { content: "Three", status: "pending" },
          ],
        },
      ],
    });
    await flush();

    expect(rec.posts).toHaveLength(1); // phrase only — no plan message
    expect(rec.posts.some((p) => p.text?.includes("🛠 Agent's plan") ?? false)).toBe(false);
  });

  test("empty phases are normal: no indicator, no plan message, never an error (issue #228)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const presenter = plainPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();

    presenter.onTodoPhases({ spaceId: "slack:C1", phases: [] });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();

    expect(rec.posts).toHaveLength(1);
    expect(rec.updates.some((u) => u.text?.includes("🛠") ?? false)).toBe(false);
  });

  test("turn end leaves the plan message as the turn's record; the next long turn reuses it in place (issue #228)", async () => {
    const rec = recordingAdapter();
    const presenter = plainPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    presenter.onTodoPhases({ spaceId: "slack:C1", phases: LONG_PLAN });
    await flush();
    expect(rec.posts).toHaveLength(2);
    const planTs = "post-2";

    // The turn ends: the plan message is LEFT — its final state is the
    // turn's record (the chosen end-of-turn cleanup; no delete call).
    presenter.onMessage({ spaceId: "slack:C1", text: "Here is the answer" });
    presenter.onTurnEnd({ spaceId: "slack:C1" });
    await flush();
    expect(rec.posts).toHaveLength(2); // phrase edited to the reply; plan untouched
    expect(rec.posts.some((p) => p.text?.includes("🛠 Agent's plan") ?? false)).toBe(true);

    // A SECOND turn that plans again REUSES the same message (phrase+edit
    // mechanics): no stacked plan messages in the thread.
    presenter.onInbound(msg({ ts: "2.2" }));
    await flush();
    const secondPlan = [
      {
        name: "A",
        tasks: [
          { content: "Plan again step one", status: "completed" as const },
          { content: "Plan again step two", status: "in_progress" as const },
          { content: "Plan again step three", status: "pending" as const },
        ],
      },
      { name: "B", tasks: [{ content: "Plan again step four", status: "pending" as const }] },
    ];
    presenter.onTodoPhases({ spaceId: "slack:C1", phases: secondPlan });
    await flush();

    // Posts: turn 1's phrase, the plan message, turn 2's fresh phrase —
    // the plan was NOT posted again; the second plan edited the existing
    // message in place (phrase+edit mechanics).
    expect(rec.posts).toHaveLength(3);
    expect(rec.posts.some((p) => p.text?.includes("Plan again step") ?? false)).toBe(false);
    expect(rec.updates).toContainEqual({
      spaceId: "slack:C1",
      ts: planTs,
      text: "🛠 Agent's plan:\n  ✅ 1. Plan again step one\n  ⏳ 2. Plan again step two\n  ⏳ 3. Plan again step three\n  ⏳ 4. Plan again step four",
    });
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Top-level DM lifecycle (issues #295/#296, owner veto #296-reopened, #336): a
// top-level Slack DM turn (slack:D*) shows EXACTLY ONE PLAIN-TEXT message —
// one post, edited in place as ordinary Slack text (no attachment wrapper,
// no color bar, no collapsible content-block card) — with the todo plan
// folded into that same line (NO separate "🛠 Agent's plan" message), raw
// model reasoning (`ThinkingEvent.thinking`) NEVER reaching Slack (only the
// elapsed/step status), and the request settling on the SAME timestamp with
// the bare final answer — NO `N actions completed` context line ever (issue
// #336 removes it entirely, even after succeeded tool steps). Errors / empty
// completions replace the same surface without the count line or any stale
// status. Channel (slack:C*) and threaded turns are untouched.
// ---------------------------------------------------------------------------
describe("SlackTurnPresenter: top-level DM plain-text lifecycle (issue #296)", () => {
  function dmPresenter(rec: RecordedAdapter): SlackTurnPresenter {
    const { store } = recordingStore();
    return new SlackTurnPresenter({
      spaceId: "slack:D1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
  }

  /** A long plan (>= 3 steps across >= 2 phases) that channels would show as a separate plan message (#228). */
  const DM_LONG_PLAN = [
    {
      name: "Research",
      tasks: [
        { content: "Read the repo", status: "completed" as const },
        { content: "Draft the section", status: "completed" as const },
      ],
    },
    { name: "Land", tasks: [{ content: "Push + PR", status: "in_progress" as const }] },
  ];

  test("exactly ONE plain-text message: a long plan folds into the status line, no separate plan (issue #296)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();
    // THE regression: a single plain-text post — no attachment, no blocks,
    // no color bar. The body rides the `text` key (owner veto #296-reopened).
    expect(rec.posts).toHaveLength(1);
    expect(rec.posts[0]).toEqual({ spaceId: "slack:D1", text: THINKING_PHRASES[0], opts: undefined });
    expect(rec.posts[0]!.opts).not.toHaveProperty("attachments");
    expect(rec.posts[0]!.opts).not.toHaveProperty("blocks");

    // A long plan that would qualify for the separate #228 message in a
    // channel must NOT post one here: the todo progress folds into the one
    // message's line instead.
    presenter.onTodoPhases({ spaceId: "slack:D1", phases: DM_LONG_PLAN });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    expect(rec.posts).toHaveLength(1); // still one message — no plan message post
    // The todo progress still surfaces on the single status line (folded in), as plain text.
    const lastStatus = rec.updates.at(-1)!;
    expect(lastStatus.opts).toBeUndefined(); // plain-text edit — no attachment/blocks
    expect(lastStatus.text).toMatch(/🛠 3\/3 — Push \+ PR$/);

    // The request completes by settling the SAME message, never a second post.
    presenter.onMessage({ spaceId: "slack:D1", text: "Done" });
    presenter.onRequestSettled();
    await flush();
    expect(rec.posts).toHaveLength(1);
    expect(rec.updates.at(-1)!.ts).toBe("post-1");
    expect(rec.updates.at(-1)!.text).toBe("Done");
  });

  test("the opening message is PLAIN TEXT — no attachment container, no color bar (owner veto #296-reopened regression)", async () => {
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();

    // THE regression: the old DM status card was a colored Slack attachment
    // ("show more / show less", bordered container). Now it is ordinary text.
    const post = rec.posts[0]!;
    expect(post).toEqual({ spaceId: "slack:D1", text: THINKING_PHRASES[0], opts: undefined });
    expect(post.opts).toBeUndefined(); // no thread, no blocks, no attachments

    // The final answer lands on the SAME message (chat.update) as plain text
    // with NO count line.
    const id = nextToolStepId();
    presenter.onToolStep({ spaceId: "slack:D1", taskId: id, title: toolStepTitle("create_work_item", "allowed (write)"), label: humanizeToolName("create_work_item"), status: "in_progress" });
    presenter.onToolStep({ spaceId: "slack:D1", taskId: id, title: toolStepTitle("create_work_item", "allowed (write)"), label: humanizeToolName("create_work_item"), status: "complete", outcome: "succeeded" });
    await flush();
    presenter.onMessage({ spaceId: "slack:D1", text: "Here is the answer" });
    presenter.onRequestSettled();
    await flush();
    expect(rec.posts).toHaveLength(1);
    const update = rec.updates.at(-1)!;
    expect(update.ts).toBe("post-1");
    expect(update.opts).toBeUndefined();
    expect(update.text).toBe("Here is the answer");
  });

  test("raw model reasoning NEVER surfaces: thinking renders no 🧠 line, only the elapsed/step status (issue #296)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();

    // Reasoning streams in — it must never reach the message.
    presenter.onThinking({ spaceId: "slack:D1", thinking: "the raw chain-of-thought the human must never see" });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();

    // Every send is a plain-text edit with NO attachments; the reasoning
    // must never appear in any update text either.
    for (const u of rec.updates) {
      expect(u.opts).toBeUndefined();
      expect(u.text?.includes("🧠")).toBe(false);
      expect(u.text?.includes("raw chain-of-thought")).toBe(false);
    }
    // The message stays alive with a non-content status instead — the
    // elapsed phrase is plain text.
    expect(rec.updates.at(-1)!.text).toMatch(/^Thinking\u2026 \d+s$/);
  });

  test("THE regression (issue #296): preamble + two grep rounds + final answer own ONE post; all updates target its ts; no preamble/thinking before settlement", async () => {
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();
    expect(rec.posts).toHaveLength(1);

    // Round 1: a speculative assistant preamble arrives — it is BUFFERED,
    // never posted. Then two gated grep tool rounds succeed; each emits
    // turn_start/turn_end boundaries that are NOT the request end. The one
    // message (post-1) shows only trusted status — no preamble, no thinking.
    presenter.onMessage({ spaceId: "slack:D1", text: "Let me search for that… wait" }); // speculative preamble
    presenter.onToolStep({ spaceId: "slack:D1", taskId: nextToolStepId(), title: toolStepTitle("grep", "allowed (exec)"), label: humanizeToolName("grep"), status: "in_progress" });
    presenter.onToolStep({ spaceId: "slack:D1", taskId: nextToolStepId(), title: toolStepTitle("grep", "allowed (exec)"), label: humanizeToolName("grep"), status: "complete", outcome: "succeeded" });
    presenter.onTurnEnd({ spaceId: "slack:D1" }); // SDK round boundary — NOT the request end
    await flush();
    // Still exactly one post; the preamble never reached Slack.
    expect(rec.posts).toHaveLength(1);
    expect(rec.posts[0]!.text).toBe(THINKING_PHRASES[0]); // plain-text opening unchanged
    expect(rec.updates.some((u) => u.text?.includes("Let me search"))).toBe(false);

    // Round 2: another grep tool round, then the FINAL answer — still no
    // second post, still no preamble leak.
    presenter.onToolStep({ spaceId: "slack:D1", taskId: nextToolStepId(), title: toolStepTitle("search", "allowed (exec)"), label: humanizeToolName("search"), status: "in_progress" });
    presenter.onToolStep({ spaceId: "slack:D1", taskId: nextToolStepId(), title: toolStepTitle("search", "allowed (exec)"), label: humanizeToolName("search"), status: "complete", outcome: "succeeded" });
    presenter.onMessage({ spaceId: "slack:D1", text: "Here is the answer" }); // final answer
    presenter.onTurnEnd({ spaceId: "slack:D1" }); // round boundary
    await flush();

    // The request settles (opening prompt resolution): replace the ONE
    // message with the bare final answer (no action-count line, issue #336).
    expect(presenter.onRequestSettled()).toBe(true);
    await flush();

    expect(rec.posts).toHaveLength(1); // exactly one post the whole request
    const final = rec.updates.at(-1)!;
    expect(final).toMatchObject({ spaceId: "slack:D1", ts: "post-1" });
    // THE regression: the final reply is PLAIN TEXT — the body rides the
    // `text` key (no attachment, no color bar, no blocks).
    expect(final.opts).toBeUndefined();
    expect(final.text).toBe("Here is the answer");
    // No tool names ever surface.
    expect(final.text).not.toContain("grep");
    expect(final.text).not.toContain("search");
    expect(final.text).not.toContain("Let me search");
  });

  test("a second user request owns a NEW message and cannot mutate the prior request (issue #296)", async () => {
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);

    // Request 1 runs, then its final answer edits request 1's message.
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();
    const firstTs = "post-1";
    presenter.onMessage({ spaceId: "slack:D1", text: "first answer" });
    presenter.onRequestSettled();
    await flush();

    // Request 2 (a NEW inbound) opens a SECOND message; its final answer
    // edits request 2's message — never request 1's ts.
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "2.2" }));
    await flush();
    presenter.onMessage({ spaceId: "slack:D1", text: "second answer" });
    presenter.onRequestSettled();
    await flush();

    expect(rec.posts).toHaveLength(2); // two distinct messages
    expect(rec.posts.every((p) => p.opts === undefined)).toBe(true); // all plain text
    // The second request's final edit targets the SECOND message (post-2), not the first (post-1).
    expect(rec.updates.at(-1)!.ts).toBe("post-2");
    expect(rec.updates.at(-1)!.ts).not.toBe(firstTs);
  });

  test("succeeded tool actions never surface a count line: the final is just the bare answer (issue #336)", async () => {
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();

    // Three genuinely-succeeded tool actions across the request.
    for (const name of ["github.search_issues", "create_work_item", "slack_post_message"]) {
      const id = nextToolStepId();
      presenter.onToolStep({ spaceId: "slack:D1", taskId: id, title: toolStepTitle(name, "allowed (exec)"), label: humanizeToolName(name), status: "in_progress" });
      presenter.onToolStep({ spaceId: "slack:D1", taskId: id, title: toolStepTitle(name, "allowed (exec)"), label: humanizeToolName(name), status: "complete", outcome: "succeeded" });
    }
    await flush();

    presenter.onMessage({ spaceId: "slack:D1", text: "Answer" });
    presenter.onRequestSettled();
    await flush();

    const final = rec.updates.at(-1)!;
    expect(final.opts).toBeUndefined(); // plain-text reply — no attachment/blocks
    // No count line ever — the final is exactly the bare answer (issue #336).
    expect(final.text).toBe("Answer");
    expect(final.text).not.toContain("actions completed");
    expect(final.text).not.toContain("✅");
    expect(final.text).not.toContain("Search issues");
    expect(final.text).not.toContain("create_work_item");
    expect(final.text).not.toContain("slack_post_message");
  });

  test("denied / execution-failed / approval-only events NEVER count; only genuine success does (issue #296)", async () => {
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();

    const denied = nextToolStepId();
    presenter.onToolStep({ spaceId: "slack:D1", taskId: denied, title: toolStepTitle("bash", "denied (exec)"), label: humanizeToolName("bash"), status: "complete", outcome: "denied" });
    const failed = nextToolStepId();
    presenter.onToolStep({ spaceId: "slack:D1", taskId: failed, title: toolStepTitle("create_work_item", "allowed (write)"), label: humanizeToolName("create_work_item"), status: "complete", outcome: "failed" });
    const approved = nextToolStepId();
    presenter.onToolStep({ spaceId: "slack:D1", taskId: approved, title: toolStepTitle("create_work_item", "approved (write)"), label: humanizeToolName("create_work_item"), status: "complete", outcome: "approved" });
    await flush();

    presenter.onMessage({ spaceId: "slack:D1", text: "Done" });
    presenter.onRequestSettled();
    await flush();

    const final = rec.updates.at(-1)!;
    expect(final.opts).toBeUndefined(); // plain-text reply
    expect(final.text).toBe("Done"); // zero actions completed — nothing counted
    expect(final.text).not.toContain("✅");
    expect(final.text).not.toContain("actions completed");
  });

  test("a replayed succeeded terminal for the SAME taskId never surfaces any count (issue #296)", async () => {
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();

    const id = nextToolStepId();
    const step = { spaceId: "slack:D1", taskId: id, title: toolStepTitle("create_work_item", "allowed (write)"), label: humanizeToolName("create_work_item"), status: "complete" as const, outcome: "succeeded" as const };
    presenter.onToolStep(step);
    presenter.onToolStep(step); // redelivery replay
    await flush();

    presenter.onMessage({ spaceId: "slack:D1", text: "Done" });
    presenter.onRequestSettled();
    await flush();

    expect(rec.updates.at(-1)!.opts).toBeUndefined(); // plain text
    expect(rec.updates.at(-1)!.text).toBe("Done");
    expect(rec.updates.at(-1)!.text).not.toContain("actions completed");
  });

  test("no completed action means no count line: the reply is just the answer (issue #296)", async () => {
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();
    const cardTs = "post-1";

    presenter.onMessage({ spaceId: "slack:D1", text: "Plain answer" });
    presenter.onRequestSettled();
    await flush();

    expect(rec.updates.at(-1)).toMatchObject({ spaceId: "slack:D1", ts: cardTs });
    expect(rec.updates.at(-1)!.opts).toBeUndefined();
    expect(rec.updates.at(-1)!.text).toBe("Plain answer");
  });

  test("an error replaces the SAME message in place with the error text — no count line, no stale status (issue #296)", async () => {
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();
    const cardTs = "post-1";

    // A step ran (and even succeeded — proof the error still wins clean),
    // then the session errored: the error buffers and lands at settlement.
    const id = nextToolStepId();
    presenter.onToolStep({ spaceId: "slack:D1", taskId: id, title: toolStepTitle("bash", "allowed (exec)"), label: humanizeToolName("bash"), status: "in_progress" });
    presenter.onToolStep({ spaceId: "slack:D1", taskId: id, title: toolStepTitle("bash", "allowed (exec)"), label: humanizeToolName("bash"), status: "complete", outcome: "succeeded" });
    await flush();

    presenter.onError({ spaceId: "slack:D1", message: "provider exploded" });
    presenter.onRequestSettled();
    await flush();

    // The SAME message now holds the error — no second post, no count line.
    expect(rec.posts).toHaveLength(1);
    expect(rec.updates.at(-1)).toMatchObject({ spaceId: "slack:D1", ts: cardTs });
    expect(rec.updates.at(-1)!.opts).toBeUndefined();
    expect(rec.updates.at(-1)!.text).toBe("provider exploded");
    expect(rec.updates.at(-1)!.text).not.toContain("actions completed");
  });

  test("an empty completion buffers, then lands as the visible fallback at settlement (issue #296)", async () => {
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();
    const cardTs = "post-1";

    presenter.onMessage({ spaceId: "slack:D1", text: "", error: "provider exploded" });
    await flush();
    // Buffered — nothing posted mid-request.
    expect(rec.updates).toHaveLength(0);

    presenter.onRequestSettled();
    await flush();

    expect(rec.posts).toHaveLength(1);
    expect(rec.updates.at(-1)).toMatchObject({ spaceId: "slack:D1", ts: cardTs });
    expect(rec.updates.at(-1)!.opts).toBeUndefined();
    expect(rec.updates.at(-1)!.text).toBe(emptyResponseFallback("provider exploded"));
    expect(rec.updates.at(-1)!.text).not.toContain("actions completed");
  });

  test("a threaded DM keeps the reaction-only flow — no status message, no buffering, no count line (issue #296 preserves #289)", async () => {
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1", threadTs: "1.0" }));
    await flush();
    expect(rec.posts).toHaveLength(0); // reaction-only receipt, no message

    const id = nextToolStepId();
    presenter.onToolStep({ spaceId: "slack:D1", taskId: id, title: toolStepTitle("bash", "allowed (exec)"), status: "complete" });
    await flush();
    presenter.onMessage({ spaceId: "slack:D1", text: "dm answer" });
    await flush();

    expect(rec.posts).toEqual([{ spaceId: "slack:D1", text: "dm answer", opts: undefined }]);
    expect(rec.updates).toHaveLength(0);
  });

  test("multi-round final reply lands as ONE plain-text message — the body rides the text key (owner veto #296-reopened regression)", async () => {
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();

    // Two gated tool rounds succeed before the final answer — the exact
    // scenario from the owner screenshot (a real multi-round reply).
    for (const name of ["github.search_issues", "github.search_issues"]) {
      const id = nextToolStepId();
      presenter.onToolStep({ spaceId: "slack:D1", taskId: id, title: toolStepTitle(name, "allowed (read)"), label: humanizeToolName(name), status: "in_progress" });
      presenter.onToolStep({ spaceId: "slack:D1", taskId: id, title: toolStepTitle(name, "allowed (read)"), label: humanizeToolName(name), status: "complete", outcome: "succeeded" });
    }
    await flush();

    // A long, realistic final answer.
    const answer =
      "I found the issue: the old DM surface rendered as a collapsible blue-bordered Slack attachment. The fix makes " +
      "a top-level DM turn a single plain-text message, updated in place, with the full answer and no count line.";
    presenter.onMessage({ spaceId: "slack:D1", text: answer });
    presenter.onRequestSettled();
    await flush();

    expect(rec.posts).toHaveLength(1);
    const final = rec.updates.at(-1)!;
    expect(final.ts).toBe("post-1");
    // THE regression: plain text, no attachment, no color bar.
    expect(final.opts).toBeUndefined();
    expect(final.text).toBe(answer);
    expect(final.text).not.toContain("actions completed");
  });

  test("a SHORT final reply after tool rounds is still ONE plain-text message (owner veto #296-reopened regression)", async () => {
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();

    for (const name of ["github.search_issues", "github.search_issues"]) {
      const id = nextToolStepId();
      presenter.onToolStep({ spaceId: "slack:D1", taskId: id, title: toolStepTitle(name, "allowed (read)"), label: humanizeToolName(name), status: "in_progress" });
      presenter.onToolStep({ spaceId: "slack:D1", taskId: id, title: toolStepTitle(name, "allowed (read)"), label: humanizeToolName(name), status: "complete", outcome: "succeeded" });
    }
    await flush();

    const answer = "Yeah, I'm good. Ready when you are.";
    presenter.onMessage({ spaceId: "slack:D1", text: answer });
    presenter.onRequestSettled();
    await flush();

    // Exactly one post the whole request; the final lands as an in-place
    // edit of that single plain-text message.
    expect(rec.posts).toHaveLength(1);
    const final = rec.updates.at(-1)!;
    expect(final.ts).toBe("post-1");
    expect(final.opts).toBeUndefined(); // plain text — the body rides the text key
    expect(final.text).toBe(answer);
    expect(final.text).not.toContain("actions completed");
    expect(rec.posts[0]!.text).toBe(THINKING_PHRASES[0]); // opening is plain text too
  });

  test("opening + rotating status are PLAIN TEXT on the single message (owner veto #296-reopened)", async () => {
    vi.useFakeTimers();
    fakeTimers = true;
    const rec = recordingAdapter();
    const presenter = dmPresenter(rec);
    presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
    await flush();

    // Opening post: plain text body, no attachments/blocks.
    const post = rec.posts[0]!;
    expect(post).toEqual({ spaceId: "slack:D1", text: THINKING_PHRASES[0], opts: undefined });
    expect(post.opts).toBeUndefined();

    // A long inline progress line updates the SAME message in place as
    // plain text — nothing duplicated in an attachment.
    presenter.onTodoPhases({
      spaceId: "slack:D1",
      phases: [
        { name: "Work", tasks: Array.from({ length: 5 }, (_, i) => ({ content: `in-progress item ${i}`, status: "in_progress" as const })) },
      ],
    });
    await flush();
    vi.advanceTimersByTime(STREAM_UPDATE_INTERVAL_MS * 2);
    await flush();
    const update = rec.updates.at(-1)!;
    expect(update.opts).toBeUndefined(); // plain-text edit
    expect(update.text).toMatch(/🛠 1\/5 \u2014 in-progress item 0/);

    vi.useRealTimers();
    fakeTimers = false;
  });
});


describe("humanizeToolName (issue #295 label seam)", () => {
  test("dotted/snake tool names become spaced human-readable labels, no internal identifiers", () => {
    expect(humanizeToolName("github.search_issues")).toBe("Search issues");
    expect(humanizeToolName("create_work_item")).toBe("Create work item");
    expect(humanizeToolName("slack_post_message")).toBe("Slack post message");
    expect(humanizeToolName("github.create_draft_pr")).toBe("Create draft pr");
  });

  test("a plain (undotted) tool name is humanized as-is", () => {
    expect(humanizeToolName("bash")).toBe("Bash");
    expect(humanizeToolName("getOrgSettings")).toBe("Get org settings");
  });
});

describe("StreamTurnPresenter: live todo (issue #228)", () => {
  test("a long turn posts the plan message while the panel stays clean — no progress-line appends (issue #228)", async () => {
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new StreamTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    expect(rec.streams).toHaveLength(1);

    presenter.onTodoPhases({
      spaceId: "slack:C1",
      phases: [
        {
          name: "Research",
          tasks: [
            { content: "Read the repo", status: "completed" },
            { content: "Draft the section", status: "in_progress" },
          ],
        },
        { name: "Land", tasks: [{ content: "Push + PR", status: "pending" }] },
      ],
    });
    await flush();

    // The plan message posts (a separate surface); nothing appends to the stream.
    expect(rec.posts).toEqual([
      { spaceId: "slack:C1", text: "🛠 Agent's plan:\n  ✅ 1. Read the repo\n  ⏳ 2. Draft the section\n  ⏳ 3. Push + PR", opts: { threadTs: "1.1" } },
    ]);
    expect(rec.texts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Search-citation table rendering (issue #278): pure presenter seam — a turn
// that used search results posts a table block + the citations actually used.
// ---------------------------------------------------------------------------

describe("renderSearchResultBlocks (issue #278)", () => {
  const RESULTS = [
    { title: "Bottega", url: "https://example.com/bottega", snippet: "The harness." },
    { title: "Proxy seam", url: "https://example.com/proxy", snippet: "Keys ride the seam." },
    { title: "Third", url: "https://example.com/third", snippet: "A third claim." },
    { title: "Fourth", url: "https://example.com/4", snippet: "Four." },
    { title: "Fifth", url: "https://example.com/5", snippet: "Five." },
    { title: "Sixth", url: "https://example.com/6", snippet: "Six." },
    { title: "Seventh", url: "https://example.com/7", snippet: "Seven." },
  ];

  test("renders a header + one section per cited result (capped) with an elided tail count", () => {
    const blocks = renderSearchResultBlocks(RESULTS);
    expect(blocks[0].type).toBe("header");
    expect(String(blocks[0].text?.text)).toContain("Search results");
    // Cap: SEARCH_TABLE_MAX_ROWS rows, then the elided tail.
    const sections = blocks.filter((b) => b.type === "section");
    expect(sections.length).toBe(SEARCH_TABLE_MAX_ROWS + 1); // rows + the "sources used" footer
    // Each row carries its source URL.
    for (const section of sections.slice(0, SEARCH_TABLE_MAX_ROWS)) {
      expect(section.text?.text).toContain("https://example.com/");
    }
    const context = blocks.find((b) => b.type === "context");
    expect(context?.elements?.[0]?.text).toContain("1 more result");
  });

  test("the citations used section lists every cited source URL", () => {
    const blocks = renderSearchResultBlocks(RESULTS);
    const footer = blocks.filter((b) => b.type === "section").pop();
    expect(footer?.text?.text).toContain("*Sources used:*");
    for (const row of RESULTS.slice(0, SEARCH_TABLE_MAX_ROWS)) {
      expect(footer?.text?.text).toContain(`<${row.url}>`);
    }
    // The elided (beyond-cap) row is NOT cited in the footer.
    expect(footer?.text?.text).not.toContain("<https://example.com/7>");
  });

  test("empty results render a no-sources surface, never throwing", () => {
    const blocks = renderSearchResultBlocks([]);
    const body = blocks.map((b) => b.text?.text ?? "").join("\n");
    expect(body).toContain("No search results to cite");
    expect(body).toContain("_none_");
  });

  test("a custom row cap is honored", () => {
    const blocks = renderSearchResultBlocks(RESULTS, 2);
    const sections = blocks.filter((b) => b.type === "section");
    expect(sections.length).toBe(3); // 2 rows + the sources-used footer
    const context = blocks.find((b) => b.type === "context");
    expect(context?.elements?.[0]?.text).toContain("5 more results");
  });
});

describe("presentSearchResults cited-table dispatch (issue #278)", () => {
  test("a speaker posts exactly ONE cited table to the turn thread, as blocks", async () => {
    const rec = recordingAdapter();
    const { store } = recordingStore();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store,
      onboardingChecks: () => [],
    });
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    // The search post is the ONLY cited table the presenter emits — the
    // receipt phrase is a separate post, so expect exactly one more post
    // carrying the "Search results (cited)" text.
    presenter.presentSearchResults([
      { title: "Bottega", url: "https://example.com/bottega", snippet: "The harness." },
      { title: "Proxy seam", url: "https://example.com/proxy", snippet: "Keys ride a seam." },
    ]);
    await flush();
    const searchPosts = rec.posts.filter((p) => p.text === "Search results (cited)");
    expect(searchPosts).toHaveLength(1);
    const post = searchPosts[0]!;
    expect(post.text).toBe("Search results (cited)");
    // Threaded under the inbound turn message.
    expect(post.opts?.threadTs).toBe("1.1");
    // The cited table travels as blocks inside the post opts — the
    // acceptance that citations reach the human, not just JSON to the model.
    expect(Array.isArray(post.opts?.blocks)).toBe(true);
    const blocks = post.opts?.blocks ?? [];
    expect(blocks[0]!.type).toBe("header");
    expect(String(blocks[0]!.text?.text)).toContain("Search results");
    const sections = blocks.filter((b) => b.type === "section");
    expect(sections).toHaveLength(3); // 2 rows + the sources-used footer
    expect(sections[1]!.text?.text).toContain("https://example.com/proxy");
    const footer = sections.pop();
    expect(footer?.text?.text).toContain("*Sources used:*");
    expect(footer?.text?.text).toContain("<https://example.com/bottega>");
  });

  test("parseSearchResultRows fail-closed: malformed or missing results never dispatch rows", async () => {
    expect(parseSearchResultRows("not json")).toEqual([]);
    expect(parseSearchResultRows('{"count":2,"results":[]}')).toEqual([]);
    expect(parseSearchResultRows('{"results":[{"url":"","title":"x"}]}')).toEqual([]);
    expect(
      parseSearchResultRows('{"results":[{"title":"B","url":"https://b", "snippet":"s"},{"title":"NoUrl"}]}'),
    ).toEqual([{ title: "B", url: "https://b", snippet: "s" }]);
  });
});
