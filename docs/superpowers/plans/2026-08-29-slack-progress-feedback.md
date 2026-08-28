# Slack Progress Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace vague Slack thinking copy with evidence-based turn states and add compact outcome summaries for multi-source, partial, blocked, failed, and stopped work.

**Architecture:** Keep `SlackTurnPresenter` and `StreamTurnPresenter` as the only Slack rendering boundary. Add a pure progress/outcome model next to the presenter, then feed it from existing inbound, turn, tool-step, todo, auth-failure, error, and stop events. Both renderers consume the same snapshot; no new thread, message, heartbeat service, or control surface is introduced.

**Tech Stack:** TypeScript, Bun, `bun:test`, Slack Bolt/Web API, existing presenter/driver/runtime events, existing append-only audit evidence.

**Approved design:** `docs/superpowers/specs/2026-08-29-slack-progress-feedback-design.md`

---

## File map

- Create `src/server/services/slack-progress.ts`: pure progress state, todo counts, source outcomes, and rendering helpers.
- Create `src/server/services/slack-progress.test.ts`: state/count/summary contract tests.
- Modify `src/server/services/slack-turn-presenter.ts`: one progress snapshot per active turn; renderer integration; source outcome tracking; terminal summaries.
- Modify `src/server/services/slack-turn-presenter.test.ts`: phrase, DM, stream, race, partial, and stop behavior.
- Modify `src/server/drivers/agent-driver.ts`: emit truthful working/waiting/source metadata for built-in gated tools.
- Modify `src/server/drivers/agent-driver.test.ts`: approval, success, and failure step metadata.
- Modify `src/extensions/runtime.ts`: emit source labels and terminal outcomes for extension tools.
- Modify `src/extensions/runtime.test.ts`: extension progress/source metadata.
- Modify `src/server/services/space-service.ts`: pass sanitized extension-auth failures to presenter; mark stopped turns.
- Modify `src/server/services/space-service.test.ts`: provider reauth partial outcome and stop settlement.
- Modify `README.md`: document visible progress states and terminal summary behavior.

---

### Task 1: Add the pure progress and outcome model

**Files:**

- Create: `src/server/services/slack-progress.ts`
- Create: `src/server/services/slack-progress.test.ts`

- [ ] **Step 1: Write failing progress rendering tests**

Create `src/server/services/slack-progress.test.ts` with the initial contract:

```ts
import { describe, expect, test } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent";
import {
  createTurnProgress,
  renderOutcomeSummary,
  renderTurnProgress,
  todoStageCounts,
  type TurnOutcomeSummary,
} from "./slack-progress";

describe("Slack turn progress", () => {
  test("renders an evidence-based state and elapsed time", () => {
    const progress = createTurnProgress(1_000);
    progress.state = "working";
    progress.detail = "Searching Notion";

    expect(renderTurnProgress(progress, 73_000, 0)).toBe(
      "Working — Searching Notion\n1m 12s elapsed",
    );
  });

  test("adds plan counts only when at least two stages exist", () => {
    const phases: TodoPhase[] = [
      {
        name: "Collect",
        tasks: [
          { content: "GitHub", status: "completed" },
          { content: "Notion", status: "in_progress" },
          { content: "Summarize", status: "pending" },
          { content: "Publish", status: "blocked", blocker: "approval" },
        ],
      },
    ];

    expect(todoStageCounts(phases)).toEqual({ completed: 1, total: 4 });
  });

  test("does not count blocked or abandoned stages as complete", () => {
    const phases: TodoPhase[] = [
      {
        name: "Run",
        tasks: [
          { content: "Done", status: "completed" },
          { content: "Blocked", status: "blocked", blocker: "auth" },
          { content: "Dropped", status: "abandoned" },
        ],
      },
    ];

    expect(todoStageCounts(phases)).toEqual({ completed: 1, total: 3 });
  });
});

describe("Slack turn outcome summary", () => {
  test("omits a simple one-source success", () => {
    const summary: TurnOutcomeSummary = {
      outcome: "complete",
      elapsedMs: 12_000,
      sources: [{ label: "GitHub", state: "complete" }],
    };

    expect(renderOutcomeSummary(summary)).toBeUndefined();
  });

  test("renders successful sources before reauthorization", () => {
    const summary: TurnOutcomeSummary = {
      outcome: "partial",
      elapsedMs: 102_000,
      sources: [
        {
          label: "Notion",
          state: "needs_reauthorization",
          action: "connect notion",
        },
        { label: "GitHub", state: "complete" },
      ],
    };

    expect(renderOutcomeSummary(summary)).toBe(
      [
        "Partial result in 1m 42s",
        "GitHub: complete · Notion: needs reauthorization",
        "Action: connect notion",
      ].join("\n"),
    );
  });

  test("never claims no changes without durable evidence", () => {
    const summary: TurnOutcomeSummary = {
      outcome: "stopped",
      elapsedMs: 24_000,
      sources: [],
    };

    expect(renderOutcomeSummary(summary)).toContain(
      "Completed actions may remain applied",
    );
    expect(renderOutcomeSummary(summary)).not.toContain(
      "No external changes were made",
    );
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test src/server/services/slack-progress.test.ts
```

Expected: FAIL because `./slack-progress` does not exist.

- [ ] **Step 3: Implement the pure model and renderers**

Create `src/server/services/slack-progress.ts`:

```ts
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent";

export type TurnProgressState =
  | "accepted"
  | "planning"
  | "working"
  | "waiting"
  | "finishing";

export type SourceOutcomeState =
  | "complete"
  | "skipped"
  | "blocked"
  | "failed"
  | "needs_reauthorization";

export type TerminalOutcome =
  | "complete"
  | "partial"
  | "blocked"
  | "failed"
  | "stopped";

export interface TurnProgressSnapshot {
  state: TurnProgressState;
  detail?: string;
  completedStages?: number;
  totalStages?: number;
  startedAt: number;
  lastMeaningfulProgressAt: number;
}

export interface SourceOutcome {
  label: string;
  state: SourceOutcomeState;
  action?: string;
}

export interface TurnOutcomeSummary {
  outcome: TerminalOutcome;
  elapsedMs: number;
  sources: SourceOutcome[];
  action?: string;
}

const LABEL_BY_STATE: Record<TurnProgressState, string> = {
  accepted: "Accepted",
  planning: "Planning",
  working: "Working",
  waiting: "Waiting",
  finishing: "Finishing",
};

const LABEL_BY_SOURCE_STATE: Record<SourceOutcomeState, string> = {
  complete: "complete",
  skipped: "skipped",
  blocked: "blocked",
  failed: "failed",
  needs_reauthorization: "needs reauthorization",
};

export function createTurnProgress(now: number): TurnProgressSnapshot {
  return {
    state: "accepted",
    detail: "Request received",
    startedAt: now,
    lastMeaningfulProgressAt: now,
  };
}

export function todoStageCounts(
  phases: readonly TodoPhase[],
): { completed: number; total: number } | undefined {
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length < 2) return undefined;
  return {
    completed: tasks.filter((task) => task.status === "completed").length,
    total: tasks.length,
  };
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${remainder}s`;
}

export function renderTurnProgress(
  progress: TurnProgressSnapshot,
  now: number,
  waitingCount: number,
): string {
  const heading = `${LABEL_BY_STATE[progress.state]}${
    progress.detail ? ` — ${progress.detail}` : ""
  }`;
  const metadata: string[] = [];
  if (
    progress.completedStages !== undefined &&
    progress.totalStages !== undefined
  ) {
    metadata.push(
      `${progress.completedStages} of ${progress.totalStages} stages complete`,
    );
  }
  metadata.push(`${duration(now - progress.startedAt)} elapsed`);
  if (waitingCount > 0) metadata.push(`+${waitingCount} waiting`);
  return `${heading}\n${metadata.join(" · ")}`;
}

export function renderOutcomeSummary(
  summary: TurnOutcomeSummary,
): string | undefined {
  if (
    summary.outcome === "complete" &&
    summary.sources.length <= 1 &&
    summary.action === undefined
  ) {
    return undefined;
  }

  const heading: Record<TerminalOutcome, string> = {
    complete: "Completed",
    partial: "Partial result",
    blocked: "Blocked",
    failed: "Failed",
    stopped: "Stopped",
  };
  const lines = [`${heading[summary.outcome]} in ${duration(summary.elapsedMs)}`];
  if (summary.sources.length > 0) {
    const ordered = [...summary.sources].sort(
      (left, right) =>
        Number(right.state === "complete") - Number(left.state === "complete"),
    );
    const visible = ordered.slice(0, 3);
    const remainder =
      ordered.length > visible.length
        ? ` · +${ordered.length - visible.length} more`
        : "";
    lines.push(
      `${visible
        .map(
          (source) =>
            `${source.label}: ${LABEL_BY_SOURCE_STATE[source.state]}`,
        )
        .join(" · ")}${remainder}`,
    );
  }
  const action =
    summary.action ?? summary.sources.find((source) => source.action)?.action;
  if (action) lines.push(`Action: ${action}`);
  if (summary.outcome === "stopped") {
    lines.push("Completed actions may remain applied");
  }
  return lines.slice(0, 4).join("\n");
}
```

- [ ] **Step 4: Run the pure tests and verify GREEN**

Run:

```bash
bun test src/server/services/slack-progress.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit the pure model**

```bash
git add src/server/services/slack-progress.ts src/server/services/slack-progress.test.ts
git commit -m "feat(slack): added turn progress model (#383)"
```

---

### Task 2: Render explicit states in the existing presenter

**Files:**

- Modify: `src/server/services/slack-turn-presenter.ts`
- Modify: `src/server/services/slack-turn-presenter.test.ts`
- Test: `src/server/services/slack-progress.test.ts`

- [ ] **Step 1: Add failing phrase-renderer state tests**

Add tests to `src/server/services/slack-turn-presenter.test.ts`:

```ts
test("receipt, turn start, tool work, and todo counts render explicit states", async () => {
  const rec = recordingAdapter();
  const { store } = recordingStore();
  const presenter = new SlackTurnPresenter({
    spaceId: "slack:D1",
    adapter: rec.adapter,
    store,
    onboardingChecks: () => [],
  });

  presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
  await flush();
  expect(rec.posts.at(-1)?.text).toStartWith("Accepted — Request received");

  presenter.onTurnStart();
  await flush();
  expect(rec.updates.at(-1)?.text).toStartWith(
    "Planning — Building the work plan",
  );

  presenter.onToolStep({
    spaceId: "slack:D1",
    taskId: "step-1",
    title: "github.search_issues — allowed (read)",
    label: "Search issues",
    status: "in_progress",
  });
  await flush();
  expect(rec.updates.at(-1)?.text).toStartWith(
    "Working — Search issues",
  );
  expect(rec.updates.at(-1)?.text).not.toContain("github.search_issues");

  presenter.onTodoPhases({
    spaceId: "slack:D1",
    phases: [
      {
        name: "Collect",
        tasks: [
          { content: "GitHub", status: "completed" },
          { content: "Notion", status: "in_progress" },
        ],
      },
    ],
  });
  await flush();
  expect(rec.updates.at(-1)?.text).toContain("1 of 2 stages complete");
});
```

Add a test proving reasoning does not become progress copy:

```ts
test("thinking chunks never expose raw reasoning in progress text", async () => {
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
  presenter.onThinking({ thinking: "private chain of thought" });
  await flush();
  expect(JSON.stringify(rec.updates)).not.toContain("private chain of thought");
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
bun test src/server/services/slack-turn-presenter.test.ts \
  --test-name-pattern "explicit states|raw reasoning"
```

Expected: FAIL because the presenter still renders rotating thinking/tool-title copy.

- [ ] **Step 3: Add one snapshot to `SlackTurnPresenter`**

Import the pure helpers:

```ts
import {
  createTurnProgress,
  renderTurnProgress,
  todoStageCounts,
  type TurnProgressSnapshot,
} from "./slack-progress";
```

Add the fields and the evidence check:

```ts
#progress: TurnProgressSnapshot = createTurnProgress(Date.now());
#sawExternalWork = false;

#knownExternalWorkIsComplete(): boolean {
  if (
    !this.#sawExternalWork ||
    this.toolStepInFlight ||
    this.#progress.state === "waiting"
  ) {
    return false;
  }
  return this.#todoPhases
    .flatMap((phase) => phase.tasks)
    .every(
      (task) =>
        task.status === "completed" || task.status === "abandoned",
    );
}
```

Add one internal state setter:

```ts
#setProgress(
  state: TurnProgressSnapshot["state"],
  detail?: string,
): void {
  const now = Date.now();
  this.#progress = {
    ...this.#progress,
    state,
    ...(detail ? { detail } : { detail: undefined }),
    lastMeaningfulProgressAt: now,
  };
  this.#renderProgressNow();
}
```

Reset both fields in `activateInbound` and `onQueueDrain`:

```ts
this.#progress = createTurnProgress(Date.now());
this.#sawExternalWork = false;
```

Update event methods:

```ts
onTurnStart(): void {
  this.#mountStopControl();
  this.#postThinkingPhrase();
  if (this.#progress.state === "accepted") {
    this.#setProgress("planning", "Building the work plan");
  }
}

protected renderToolStep(step: ToolStepEvent): void {
  this.toolStepInFlight = step.status === "in_progress";
  if (step.status === "in_progress") {
    this.#sawExternalWork = true;
    this.#setProgress(
      step.progressState ?? "working",
      step.progressDetail ?? step.label ?? "External work",
    );
    return;
  }
  this.#setProgress("working", "Continuing");
}

protected renderThinking(_data: ThinkingEvent): void {
  // Raw model reasoning is never a Slack progress source.
}

```

Track whether external work has started. When a non-empty message arrives,
move to `finishing` only if at least one tool/todo stage ran, no tool is in
flight, every known todo is `completed` or `abandoned`, and the current state
is not `waiting`:

```ts
if (text.trim() && this.#knownExternalWorkIsComplete()) {
  this.#setProgress("finishing", "Preparing the response");
}
```

A simple no-tool answer moves directly from `planning` to its final response.
A blocked or pending todo never produces `finishing`.

```ts
protected renderTodoPhases(data: TodoPhasesEvent): void {
  if (data.phases?.some((phase) => phase.tasks.length > 0)) {
    this.#sawExternalWork = true;
  }
  this.updateTodoSnapshot(data.phases ?? []);
  const counts = todoStageCounts(this.#todoPhases);
  this.#progress = {
    ...this.#progress,
    ...(counts
      ? { completedStages: counts.completed, totalStages: counts.total }
      : { completedStages: undefined, totalStages: undefined }),
  };
  const active = this.#todoPhases
    .flatMap((phase) => phase.tasks)
    .find((task) => task.status === "in_progress");
  const blocked = this.#todoPhases
    .flatMap((phase) => phase.tasks)
    .find((task) => task.status === "blocked");
  if (active) this.#setProgress("working", active.content);
  else if (blocked) this.#setProgress("waiting", blocked.blocker ?? blocked.content);
  else this.#renderProgressNow();
}
```

Replace `#progressLine` with the pure renderer:

```ts
#progressLine(): string {
  return renderTurnProgress(
    this.#progress,
    Date.now(),
    this.#waitingCount,
  );
}
```

Remove `#latestThinking`, `#currentStepTitle`, `#elapsedPhrase`, and the old reasoning/step priority logic after all references are migrated.

Change `#nextPhrase` to return `#progressLine()` instead of a rotating phrase.
Before removing the phrase rotation API, use LSP references for
`createPhraseRotation`, `THINKING_PHRASES`, and `phraseRotation`; migrate every
source and test callsite, then remove the obsolete exports, dependency field,
`SpaceService.#phraseRotation`, and rotation-only tests. Keep
`EMPTY_RESPONSE_FALLBACK` and churn messages unchanged.

- [ ] **Step 4: Render the same state in `StreamTurnPresenter`**

Use one stable task card id for state updates:

```ts
const TURN_PROGRESS_TASK_ID = "turn-progress";
```

Add protected render seams in the base presenter:

```ts
protected currentProgressText(): string {
  return this.#progressLine();
}

protected renderProgressSnapshot(text: string): void {
  this.#scheduleProgressUpdate(text);
}
```

Have `#renderProgressNow` call `renderProgressSnapshot`. Override it in
`StreamTurnPresenter`:

```ts
protected renderProgressSnapshot(text: string): void {
  if (!this.#streamMode) {
    super.renderProgressSnapshot(text);
    return;
  }
  if (this.#streamTs === undefined) return;
  const [title, output] = text.split("\n", 2);
  void this.adapter
    .appendTask(this.spaceId, this.#streamTs, {
      id: TURN_PROGRESS_TASK_ID,
      title: title!,
      status: "in_progress",
      ...(output ? { output } : {}),
    })
    .catch((err) => {
      this.#streamMode = false;
      console.error(
        `[slack-turn-presenter] progress task failed in ${this.spaceId}; using phrase fallback:`,
        err,
      );
    });
}
```

After `startStream` returns a timestamp, replay
`renderProgressSnapshot(currentProgressText())`. This prevents a slow stream
open from losing the `Planning` update that arrived while `#streamTs` was
undefined.

Make both stream overrides normalize through the base state machine before
they render stream-specific cards:

```ts
protected renderToolStep(step: ToolStepEvent): void {
  super.renderToolStep(step);
  // Existing stream task rendering follows.
}

protected renderTodoPhases(data: TodoPhasesEvent): void {
  super.renderTodoPhases(data);
}
```

Add a stream test that starts and completes one tool, then sends an answer
chunk and observes `Finishing — Preparing the response` on
`TURN_PROGRESS_TASK_ID`. Add a no-tool test that proves the state is not
rendered.

Keep existing per-tool task cards. The stable progress card is the state summary; tool cards remain detailed evidence.

- [ ] **Step 5: Update affected old phrase assertions**

Update focused assertions in:

- `src/server/services/slack-turn-presenter.test.ts`
- `src/server/services/space-service.test.ts`

Replace expectations such as `Thinking…` and `On it — thinking…` only where the active turn surface now renders explicit states. Keep churn/error copy and fallback behavior unchanged.

- [ ] **Step 6: Run presenter and SpaceService tests**

```bash
bun test \
  src/server/services/slack-progress.test.ts \
  src/server/services/slack-turn-presenter.test.ts \
  src/server/services/space-service.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit presenter state rendering**

```bash
git add \
  src/server/services/slack-turn-presenter.ts \
  src/server/services/slack-turn-presenter.test.ts \
  src/server/services/space-service.ts \
  src/server/services/space-service.test.ts
git commit -m "feat(slack): rendered explicit turn states (#383)"
```

---

### Task 3: Emit truthful working and waiting metadata

**Files:**

- Modify: `src/server/services/slack-turn-presenter.ts`
- Modify: `src/server/drivers/agent-driver.ts`
- Modify: `src/server/drivers/agent-driver.test.ts`
- Modify: `src/extensions/runtime.ts`
- Modify: `src/extensions/runtime.test.ts`
- Modify: `src/server/adapters/approval-router.ts`
- Test: `src/server/services/slack-turn-presenter.test.ts`

- [ ] **Step 1: Add failing event metadata tests**

In `src/server/drivers/agent-driver.test.ts`, assert:

```ts
expect(steps).toContainEqual(
  expect.objectContaining({
    label: "Create work item",
    progressState: "waiting",
    progressDetail: "Waiting for approval",
    status: "in_progress",
  }),
);
expect(steps.at(-1)).toMatchObject({
  progressState: "working",
  outcome: "succeeded",
  status: "complete",
});
```

In `src/extensions/runtime.test.ts`, assert an extension tool emits:

```ts
expect(steps[0]).toMatchObject({
  sourceLabel: "GitHub",
  progressState: "working",
  progressDetail: "Search issues",
});
expect(steps.at(-1)).toMatchObject({
  sourceLabel: "GitHub",
  outcome: "succeeded",
});
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
bun test \
  src/server/drivers/agent-driver.test.ts \
  src/extensions/runtime.test.ts
```

Expected: FAIL because the new progress/source fields do not exist.

- [ ] **Step 3: Extend `ToolStepEvent` with presentation-safe metadata**

In `src/server/services/slack-turn-presenter.ts`:

```ts
export interface ToolStepEvent {
  spaceId?: string;
  taskId: string;
  title: string;
  status: "in_progress" | "complete";
  outcome?: ToolStepOutcome;
  label?: string;
  output?: string;
  progressState?: "working" | "waiting";
  progressDetail?: string;
  sourceLabel?: string;
}
```

All new values must be friendly metadata; no args, credential data, internal IDs, or raw provider payloads.

- [ ] **Step 4: Emit waiting then working around approvals**

In `withPolicyGate` (`src/server/drivers/agent-driver.ts`):

```ts
onAskHuman: sink
  ? () => {
      emitToolStep(sink, {
        spaceId,
        taskId,
        label,
        title: toolStepTitle(def.name, "waiting for approval"),
        status: "in_progress",
        progressState: "waiting",
        progressDetail: "Waiting for approval",
        output: stepArgs,
      });
    }
  : undefined,
```

After approval and before execution, emit the same task as working:

```ts
if (outcome.decision === "ask-human") {
  emitToolStep(sink, {
    spaceId,
    taskId,
    label,
    title: toolStepTitle(def.name, "approved"),
    status: "in_progress",
    progressState: "working",
    progressDetail: label,
    output: stepArgs,
  });
}
```

Emit terminal `succeeded` or `failed` for approved calls too. Remove the current `outcome.decision !== "ask-human"` guards around terminal step emission. Remove the intermediate terminal `"approved"` outcome from both emitters, then use LSP references to remove `"approved"` from `ToolStepOutcome` and update its presenter test.

- [ ] **Step 5: Emit provider labels from extension runtime**

For every `emitToolStep` call in `src/extensions/runtime.ts`, add:

```ts
sourceLabel: manifest.label,
progressState: "working",
progressDetail: label,
```

For approval waits, set `progressState: "waiting"` and `progressDetail: "Waiting for approval"`.

On terminal errors, set `outcome: "failed"` and keep the raw error out of the event.

- [ ] **Step 6: Keep approval-router failure events truthful**

In `src/server/adapters/approval-router.ts`, add waiting metadata to the
in-progress event and a failed outcome to the terminal event:

```ts
emitToolStep(this.onToolStep, {
  spaceId: space,
  taskId,
  title,
  label,
  status: "in_progress",
  progressState: "waiting",
  progressDetail: "Write failed; review required",
  output,
});
emitToolStep(this.onToolStep, {
  spaceId: space,
  taskId,
  title,
  label,
  status: "complete",
  outcome: "failed",
  output,
});
```

In `StreamTurnPresenter.renderToolStep`, render `step.label ??
"External action"` as the task title. Do not put the internal tool identifier
from `step.title` into Slack.

Do not include the raw write arguments or provider response.

- [ ] **Step 7: Run emitter and presenter tests**

```bash
bun test \
  src/server/drivers/agent-driver.test.ts \
  src/extensions/runtime.test.ts \
  src/server/services/slack-turn-presenter.test.ts \
  src/server/adapters/approval-router.test.ts
```

Expected: all tests pass; approval sequence is waiting → working → succeeded/failed.

- [ ] **Step 8: Commit event metadata**

```bash
git add \
  src/server/services/slack-turn-presenter.ts \
  src/server/drivers/agent-driver.ts \
  src/server/drivers/agent-driver.test.ts \
  src/extensions/runtime.ts \
  src/extensions/runtime.test.ts \
  src/server/adapters/approval-router.ts \
  src/server/adapters/approval-router.test.ts
git commit -m "feat(slack): added truthful progress event metadata (#383)"
```

---

### Task 4: Track source outcomes and append terminal summaries

**Files:**

- Modify: `src/server/services/slack-turn-presenter.ts`
- Modify: `src/server/services/slack-turn-presenter.test.ts`
- Modify: `src/server/services/space-service.ts`
- Modify: `src/server/services/space-service.test.ts`
- Test: `src/server/services/slack-progress.test.ts`

- [ ] **Step 1: Add failing completion-summary integration tests**

Add to `src/server/services/slack-turn-presenter.test.ts`:

```ts
test("partial multi-source reply keeps the answer and appends one actionable summary", async () => {
  const rec = recordingAdapter();
  const { store } = recordingStore();
  const presenter = new SlackTurnPresenter({
    spaceId: "slack:D1",
    adapter: rec.adapter,
    store,
    onboardingChecks: () => [],
  });

  presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
  await flush();
  presenter.onSourceOutcome({ label: "GitHub", state: "complete" });
  presenter.onSourceOutcome({
    label: "Notion",
    state: "needs_reauthorization",
    action: "connect notion",
  });
  presenter.onMessage({ text: "Six PRs found." });
  presenter.onRequestSettled();
  await flush();

  const text = rec.updates.at(-1)?.text ?? "";
  expect(text).toStartWith("Six PRs found.");
  expect(text).toContain("Partial result");
  expect(text).toContain(
    "GitHub: complete · Notion: needs reauthorization",
  );
  expect(text).toContain("Action: connect notion");
  const summary = text.split("\n\n").at(-1) ?? "";
  expect(summary.split("\n").length).toBeLessThanOrEqual(4);
});
```

Add a stopped-evidence test through the recording Slack adapter:

```ts
test("stopped summary does not claim no changes without durable evidence", async () => {
  const rec = recordingAdapter();
  const { store } = recordingStore();
  const presenter = new SlackTurnPresenter({
    spaceId: "slack:D1",
    adapter: rec.adapter,
    store,
    onboardingChecks: () => [],
  });

  presenter.onInbound(msg({ spaceId: "slack:D1", ts: "1.1" }));
  await flush();
  presenter.onStopped();
  presenter.onMessage({ text: "Stopped." });
  presenter.onRequestSettled();
  await flush();

  const text = rec.updates.at(-1)?.text ?? "";
  expect(text).toContain("Completed actions may remain applied");
  expect(text).not.toContain("No external changes were made");
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
bun test src/server/services/slack-turn-presenter.test.ts \
  --test-name-pattern "partial multi-source|stopped summary"
```

Expected: FAIL because source outcomes and terminal summaries are not tracked.

- [ ] **Step 3: Track one outcome per friendly source label**

In `SlackTurnPresenter`, add:

```ts
#sourceOutcomes = new Map<string, SourceOutcome>();
#terminalOutcome: TerminalOutcome = "complete";

onSourceOutcome(outcome: SourceOutcome): void {
  this.#sourceOutcomes.set(outcome.label, outcome);
}

onSourceWaiting(outcome: SourceOutcome): void {
  this.onSourceOutcome(outcome);
  this.#setProgress("waiting", `${outcome.label} needs reauthorization`);
}
```

Reset both in `activateInbound`, `onQueueDrain`, and `dispose`.

In `renderToolStep`, record only terminal events with a source label:

```ts
if (step.status === "complete" && step.sourceLabel) {
  const state =
    step.outcome === "succeeded"
      ? "complete"
      : step.outcome === "denied"
        ? "blocked"
        : "failed";
  this.onSourceOutcome({
    label: step.sourceLabel,
    state,
  });
}
```

- [ ] **Step 4: Derive terminal outcome and append summary once**

Add:

```ts
#finalText(text: string, requested = this.#terminalOutcome): string {
  const sources = [...this.#sourceOutcomes.values()];
  const hasSuccess = sources.some((source) => source.state === "complete");
  const hasFailure = sources.some((source) => source.state === "failed");
  const hasBlock = sources.some(
    (source) =>
      source.state === "blocked" ||
      source.state === "needs_reauthorization" ||
      source.state === "skipped",
  );
  const outcome =
    requested === "stopped"
      ? "stopped"
      : hasSuccess && (hasFailure || hasBlock)
        ? "partial"
        : hasFailure
          ? "failed"
          : hasBlock
            ? "blocked"
            : requested;
  const summary = renderOutcomeSummary({
    outcome,
    elapsedMs: Date.now() - this.#progress.startedAt,
    sources,
  });
  return summary ? `${text}\n\n${summary}` : text;
}
```

Call `#finalText` only at the terminal carrier for each renderer:

- direct non-streaming `onMessage`
- buffered DM `onRequestSettled`
- `onError`
- stream `onTurnEnd`, before `finalizeTurn`/`stopStream`

Set `#terminalOutcome` to `failed` on error unless it is already `stopped`.
If a later non-empty message recovers from a buffered error, reset `failed` to
`complete` before final rendering. Never reset `stopped` this way.
Keep all interim stream appends as raw answer text. This makes summary
application single-shot without a boolean guard and preserves the existing
#365 final-write ordering.

- [ ] **Step 5: Feed sanitized auth failures from SpaceService**

Extract the current provider-name filtering into one private
`#relevantAuthFailures(text: string)` helper in `SpaceService`. Reuse it at
turn activation and final reply handling.

When an accepted inbound names a currently unavailable provider, call:

```ts
for (const { providerId, label } of this.#relevantAuthFailures(msg.text)) {
  presenter.onSourceWaiting({
    label,
    state: "needs_reauthorization",
    action: `connect ${providerId}`,
  });
}
```

When final reply handling finds the same sanitized failures, call
`onSourceOutcome` before `presenter.onMessage` so the terminal summary contains
the provider and recovery action. The next verified tool or todo event can move
the active state back to `working`; the elapsed timer cannot.

Add a `SpaceService` test where an accepted request names Notion while the
sanitized failure callback reports Notion. Assert the active message says
`Waiting — Notion needs reauthorization` before the model request settles and
the final reply says `Action: connect notion`.

Do not pass broker causes or token data.

- [ ] **Step 6: Mark stopped turns before abort settlement**

Add to the presenter:

```ts
onStopped(): void {
  this.#terminalOutcome = "stopped";
}

clearStopped(): void {
  if (this.#terminalOutcome === "stopped") {
    this.#terminalOutcome = "complete";
  }
}
```

In `SpaceService.stopTurn`, call `presenter.onStopped()` immediately before
`session.abort()`, so abort settlement cannot race ahead of the status. The
current synchronous stop path has no durable successful-write audit query, so
use `unknown` and never claim that no changes occurred. If abort throws, call
`presenter.clearStopped()` before propagating the error so a later natural
completion is not labeled stopped.

- [ ] **Step 7: Run summary, race, and stop tests**

```bash
bun test \
  src/server/services/slack-progress.test.ts \
  src/server/services/slack-turn-presenter.test.ts \
  src/server/services/space-service.test.ts
```

Expected: all tests pass, including the existing #365 final-write race and #315 Stop tests.

- [ ] **Step 8: Commit completion summaries**

```bash
git add \
  src/server/services/slack-turn-presenter.ts \
  src/server/services/slack-turn-presenter.test.ts \
  src/server/services/space-service.ts \
  src/server/services/space-service.test.ts
git commit -m "feat(slack): added outcome-first turn summaries (#383)"
```

---

### Task 5: Update operator documentation and run the quality gate

**Files:**

- Modify: `README.md`
- Verify: all files changed in Tasks 1–4

- [ ] **Step 1: Document the visible Slack contract**

Add a short section near the existing Slack/space behavior documentation in `README.md`:

```markdown
### Progress feedback in Slack

Bottega keeps one active Slack surface per turn. It reports an evidence-based
state (`Accepted`, `Planning`, `Working`, `Waiting`, or `Finishing`), elapsed
time, and plan counts when a real todo plan exists. Its progress detail never
contains percentage, ETA, raw reasoning, or tool arguments.

The final answer replaces progress. Multi-source, partial, blocked, failed, and
stopped turns add a short outcome summary that names successful sources first
and gives one exact recovery action when one is available.
```

- [ ] **Step 2: Run type checking**

```bash
bun check
```

Expected: exit 0.

- [ ] **Step 3: Run the focused Slack suites**

```bash
bun test \
  src/server/services/slack-progress.test.ts \
  src/server/services/slack-turn-presenter.test.ts \
  src/server/services/space-service.test.ts \
  src/server/drivers/agent-driver.test.ts \
  src/extensions/runtime.test.ts \
  src/server/adapters/approval-router.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Run the full hermetic suite**

```bash
bun test
```

Expected: exit 0. If known cross-file flakes reproduce, rerun the named failing files alone and record both outputs; do not hide or relabel a real failure.

- [ ] **Step 5: Validate deployment configuration**

```bash
docker compose -f docker-compose.yml config -q
```

Expected: exit 0.

- [ ] **Step 6: Run the actual Slack smoke scenario**

Use the configured QA Slack user and ask for a multi-source request that lasts more than one minute, for example:

```text
Give me this week through GitHub and Notion. Show current progress while you work.
```

Verify:

- receipt appears within two seconds
- active copy moves through evidence-based states
- plan count appears only when a real plan exists
- no new top-level progress message is created; the existing long-plan message is allowed
- no raw reasoning, internal tool names, or secrets appear
- final response replaces progress
- if a QA provider is already expired, its partial summary puts successful GitHub output first; otherwise rely on the hermetic reauthorization test and do not mutate production credentials
- final summary has at most four lines

- [ ] **Step 7: Commit docs and final verification state**

```bash
git add README.md
git commit -m "docs(slack): documented progress feedback contract (#383)"
```

- [ ] **Step 8: Rebase and push using repository workflow**

```bash
git pull --rebase origin main
git push origin HEAD:main
```

Expected: fast-forward push to `main`; never force-push.

- [ ] **Step 9: Close the tracking issue after the push succeeds**

```bash
gh issue close 383 \
  --repo serrrfirat/bottega \
  --comment "Shipped explicit Slack progress states and outcome-first completion summaries to main."
```

Expected: issue #383 is closed only after the implementation is on `main`.
