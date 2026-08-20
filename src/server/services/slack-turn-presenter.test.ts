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
import type { SlackAdapter, SlackMessage, SlackStreamTask } from "../adapters/slack";
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
  SEARCH_TABLE_MAX_ROWS,
  type ToolStepEvent,
} from "./slack-turn-presenter";

// ---------------------------------------------------------------------------
// Recording doubles: no network, no real store.
// ---------------------------------------------------------------------------

interface StreamCall {
  spaceId: string;
  opts: { threadTs: string; openingText: string };
}

interface RecordedAdapter {
  adapter: SlackAdapter;
  streams: StreamCall[];
  texts: Array<{ spaceId: string; ts: string; text: string }>;
  tasks: Array<{ spaceId: string; ts: string; task: SlackStreamTask }>;
  stops: Array<{ spaceId: string; ts: string; text?: string }>;
  posts: Array<{ spaceId: string; text: string; opts?: { threadTs?: string } }>;
  updates: Array<{ spaceId: string; ts: string; text: string }>;
  reactions: Array<{ kind: "add" | "remove"; spaceId: string; ts: string }>;
}

function recordingAdapter(
  opts: { failStart?: boolean; streaming?: boolean; failAppend?: boolean; failStop?: boolean } = {},
): RecordedAdapter {
  const streams: StreamCall[] = [];
  const texts: Array<{ spaceId: string; ts: string; text: string }> = [];
  const tasks: Array<{ spaceId: string; ts: string; task: SlackStreamTask }> = [];
  const stops: Array<{ spaceId: string; ts: string; text?: string }> = [];
  const posts: Array<{ spaceId: string; text: string; opts?: { threadTs?: string } }> = [];
  const updates: Array<{ spaceId: string; ts: string; text: string }> = [];
  const reactions: Array<{ kind: "add" | "remove"; spaceId: string; ts: string }> = [];
  let tsSeq = 0;
  const adapter: SlackAdapter = {
    async postMessage(spaceId, text, replyOpts) {
      // SAFETY: the presenter passes only { threadTs } as post options (blocks are the approval router's job), so recording just that field covers every posted message.
      posts.push({ spaceId, text, opts: replyOpts as { threadTs?: string } | undefined });
      tsSeq += 1;
      return `post-${tsSeq}`;
    },
    async updateMessage(spaceId, ts, text) {
      updates.push({ spaceId, ts, text });
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
    expect(rec.updates.some((u) => u.text.startsWith("🧠"))).toBe(false);
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

    const line = rec.updates.at(-1)!.text;
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

  test("the 403-no-body family (a bare 403 in the message) maps to the same remedy", async () => {
    const rec = recordingAdapter();
    const presenter = plainPresenter(rec);
    presenter.onInbound(msg({ ts: "1.1" }));
    await flush();
    presenter.onMessage({ spaceId: "slack:C1", text: "", error: "Request failed with status code 403" });
    await flush();

    const visible = rec.updates.at(-1)!.text;
    expect(visible).toContain("codex login");
    expect(visible).toContain("restart the server");
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
    expect(rec.posts.some((p) => p.text.includes("🛠 Agent's plan"))).toBe(false);

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

    expect(rec.updates.some((u) => u.text.includes("🛠"))).toBe(false);
    expect(rec.posts.some((p) => p.text.includes("🛠 Agent's plan"))).toBe(false);
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
    expect(rec.posts.some((p) => p.text.includes("🛠 Agent's plan"))).toBe(false);
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
    expect(rec.updates.some((u) => u.text.includes("🛠"))).toBe(false);
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
    expect(rec.posts.some((p) => p.text.includes("🛠 Agent's plan"))).toBe(true);

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
    expect(rec.posts.some((p) => p.text.includes("Plan again step"))).toBe(false);
    expect(rec.updates).toContainEqual({
      spaceId: "slack:C1",
      ts: planTs,
      text: "🛠 Agent's plan:\n  ✅ 1. Plan again step one\n  ⏳ 2. Plan again step two\n  ⏳ 3. Plan again step three\n  ⏳ 4. Plan again step four",
    });
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
    const blocks = renderSearchResultBlocks(RESULTS) as { type: string; text?: { text?: string } }[];
    expect(blocks[0].type).toBe("header");
    expect(String(blocks[0].text?.text)).toContain("Search results");
    // Cap: SEARCH_TABLE_MAX_ROWS rows, then the elided tail.
    const sections = blocks.filter((b) => b.type === "section");
    expect(sections.length).toBe(SEARCH_TABLE_MAX_ROWS + 1); // rows + the "sources used" footer
    // Each row carries its source URL.
    for (const section of sections.slice(0, SEARCH_TABLE_MAX_ROWS)) {
      expect(section.text?.text).toContain("https://example.com/");
    }
    const context = blocks.find((b) => b.type === "context") as { elements?: { text?: string }[] };
    expect(context.elements?.[0]?.text).toContain("1 more result");
  });

  test("the citations used section lists every cited source URL", () => {
    const blocks = renderSearchResultBlocks(RESULTS) as { type: string; text?: { text?: string } }[];
    const footer = blocks.filter((b) => b.type === "section").pop();
    expect(footer?.text?.text).toContain("*Sources used:*");
    for (const row of RESULTS.slice(0, SEARCH_TABLE_MAX_ROWS)) {
      expect(footer?.text?.text).toContain(`<${row.url}>`);
    }
    // The elided (beyond-cap) row is NOT cited in the footer.
    expect(footer?.text?.text).not.toContain("<https://example.com/7>");
  });

  test("empty results render a no-sources surface, never throwing", () => {
    const blocks = renderSearchResultBlocks([]) as { type: string; text?: { text?: string } }[];
    const body = blocks.map((b) => b.text?.text ?? "").join("\n");
    expect(body).toContain("No search results to cite");
    expect(body).toContain("_none_");
  });

  test("a custom row cap is honored", () => {
    const blocks = renderSearchResultBlocks(RESULTS, 2) as { type: string; text?: { text?: string } }[];
    const sections = blocks.filter((b) => b.type === "section");
    expect(sections.length).toBe(3); // 2 rows + the sources-used footer
    const context = blocks.find((b) => b.type === "context") as { elements?: { text?: string }[] };
    expect(context.elements?.[0]?.text).toContain("5 more results");
  });
});
