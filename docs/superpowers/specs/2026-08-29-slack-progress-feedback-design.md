# Slack progress feedback design

**Status:** Approved design

## Decision

Improve the existing Slack message instead of adding a new renderer, thread, heartbeat service, or control surface.

The first implementation has two parts:

1. Replace vague thinking phrases with an explicit, evidence-based progress state.
2. End each turn with an outcome-first completion summary when the result is partial, blocked, failed, stopped, or spans multiple sources.

Channels keep the existing streaming panel when Slack supports it. DMs keep the existing single message that is edited in place.

## Why this change

Bottega already acknowledges messages, edits a thinking message, tracks elapsed time, streams channel updates, renders tool steps, and can expose a Stop control. The visible experience still feels inactive during long turns because the primary status is usually a rotating variation of “Thinking.” It does not tell the person which meaningful stage is active or what completed.

The final response also makes partial work hard to understand. A person can receive useful GitHub results and a Notion failure without a consistent statement of what succeeded, what did not, and what action restores the missing source.

## Goals

- Show a truthful current stage during active work.
- Queue updates immediately when a meaningful stage changes and render them within the existing 400 ms coalescing cadence.
- Reuse the existing top-level message or streaming panel.
- Preserve useful elapsed-time feedback without inventing percentage or ETA.
- Make complete, partial, blocked, failed, and stopped outcomes distinct.
- Put successful results before failures and recovery instructions.
- Keep secret values, raw reasoning, internal tool names, IDs, stack traces, retries, and artifact URIs out of Slack.

## Non-goals

- No new channel thread or activity-feed layout.
- No new 30-second heartbeat system. The existing elapsed ticker remains.
- No new buttons or controls. The current Stop setting is unchanged.
- No percentage complete or estimated completion time.
- No raw chain-of-thought or model reasoning.
- No persistent project-management timeline.
- No change to the Slack message/threading contract.

## Show one explicit active state

A turn has one active state at a time:

| State       | Meaning                                                           | Example visible line                     |
| ----------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `accepted`  | The inbound request was accepted.                                 | `Accepted — Request received`            |
| `planning`  | The turn started but no external work has started.                | `Planning — Building the work plan`      |
| `working`   | A tool, source, or planned stage is active.                       | `Working — Searching Notion`             |
| `waiting`   | Progress requires an external event or person.                    | `Waiting — Notion needs reauthorization` |
| `finishing` | External stages are complete and response assembly is observable. | `Finishing — Preparing the response`     |

Terminal outcomes are not active states. They replace the active status when the turn settles: `complete`, `partial`, `blocked`, `failed`, or `stopped`.

### Derive state only from evidence

Use events bottega already receives:

| Event                                                       | State update                               |
| ----------------------------------------------------------- | ------------------------------------------ |
| Inbound message accepted                                    | `accepted`                                 |
| `turn_start` before tool or todo activity                   | `planning`                                 |
| Tool step starts                                            | `working` with its redacted human label    |
| Todo task becomes active                                    | `working` with the task's redacted content |
| Approval is pending                                         | `waiting` for approval                     |
| Connected provider requires reauthorization                 | `waiting` for that provider                |
| Provider is rate-limited or retrying                        | `waiting` with the known reason            |
| All known stages complete while response assembly continues | `finishing`                                |
| Final reply/error/stop settles                              | terminal outcome                           |

Do not show `finishing` unless bottega has evidence that external stages completed. A simple no-tool answer can move directly from `planning` to the final response.
When a waiting condition clears, the next verified tool, todo, or provider event returns the turn to `working`. A timer alone cannot clear `waiting`.

Unknown activity falls back to `Working`. It must not invent a provider, tool, stage, percentage, or ETA.

### Show stage counts only when a plan exists

When the todo snapshot has a real bounded plan, show:

```text
Working — Searching Notion
2 of 4 stages complete · 1m 12s elapsed
```

If there is no plan, omit the count:

```text
Working — Searching Notion
1m 12s elapsed
```

Blocked or abandoned todo items do not count as completed.

## Keep the current Slack renderer

`SlackTurnPresenter` and `StreamTurnPresenter` remain the rendering boundary.

- DMs continue to use one plain message edited in place.
- Channels continue to use the Slack streaming panel when available.
- The phrase fallback remains for Slack workspaces without streaming support.
- Rate-limit coalescing, receipt reactions, stop behavior, threading, final-delivery guarantees, and stream fallback remain unchanged.

The presenter maintains one normalized progress snapshot instead of deriving visible copy independently in each rendering branch.

A minimal internal shape is sufficient:

```ts
type TurnProgressSnapshot = {
  state: "accepted" | "planning" | "working" | "waiting" | "finishing";
  detail?: string;
  completedStages?: number;
  totalStages?: number;
  startedAt: number;
  lastMeaningfulProgressAt: number;
};
```

`detail` is human-readable and redacted at its source. The presenter must never put tool arguments or model reasoning into it.

## End with an outcome-first summary

The final answer replaces the progress message. The answer content stays first. A compact summary follows only when it adds useful information.

### Complete

For successful multi-source or multi-stage work:

```text
Completed in 1m 42s
GitHub: complete · Notion: complete
```

Omit the summary for a simple one-source success when it adds no information.

### Partial

```text
Partial result in 1m 42s
GitHub: complete · Notion: needs reauthorization
Action: connect notion
```

Keep available results. Do not hide successful GitHub output because Notion failed.

### Blocked

```text
Blocked after 38s
Waiting for GitHub approval
```

The blocker must name one real external dependency and one valid next action when known.

### Failed or stopped

```text
Stopped after 24s
No external changes were made
```

Only claim that no changes were made when audit evidence proves it. Otherwise use a factual statement such as `Stopped; completed actions remain applied`.

### Summary rules

- Maximum four short lines after the answer.
- State successes before failures.
- Use friendly source names, not internal tool identifiers.
- Distinguish `skipped`, `blocked`, `failed`, and `needs reauthorization`.
- Give one exact recovery action.
- Never include internal IDs, retry counts, stack traces, artifact URIs, or raw provider payloads.

## Normalize progress in the presenter

The existing presenter already owns receipt, progress text, tool steps, todo phases, elapsed time, final reply, errors, and stop settlement. Keep state normalization there to avoid a second lifecycle implementation.

Expected internal flow:

1. `onInbound` creates the `accepted` snapshot and posts the existing receipt message.
2. `onTurnStart` moves to `planning` unless meaningful work is already active.
3. `renderToolStep` and todo updates move to `working` or `waiting`.
4. Existing timer updates elapsed text but does not create a new progress state.
5. `onMessage`, `onError`, `onTurnEnd`, or `onRequestSettled` derives the terminal outcome and completion summary.
6. The existing final-write queue guarantees no stale progress update overwrites the final result.

Both presenter implementations render from the same snapshot. Slack streaming remains a rendering capability, not a second state machine.

## Build completion summaries from evidence

The presenter can use existing redacted events and audit facts:

- Completed/failed tool-step events identify external sources that ran.
- Todo snapshots identify completed, blocked, and abandoned planned stages.
- Sanitized extension auth failures identify `needs reauthorization`.
- Policy approval state identifies `waiting for approval`.
- Audit obligations determine whether side effects occurred.
- Stop and error events determine `stopped` or `failed`.

Do not infer successful source completion from the model's prose alone.

## Handle errors without losing useful results

- A provider failure does not erase results already collected from another provider.
- A reauthorization failure uses the existing sanitized provider recovery action.
- A Slack update failure keeps the existing fail-soft fallback and final-delivery guarantee.
- An unknown internal error produces `Failed` with a generic recovery action; detailed errors stay in server logs.
- A stale progress write can never replace a settled outcome.

## Test the user-visible contract

Add behavior tests at the presenter and SpaceService boundaries.

### Progress-state tests

- inbound → accepted
- turn start → planning
- tool/todo activity → working
- approval/reauthorization/rate limit → waiting
- valid finishing evidence → finishing
- unknown activity → generic working
- no plan → no stage count
- blocked/abandoned tasks do not increment completed count

### Renderer tests

- DM edits one message in place
- channel stream renders the same state/detail
- phrase fallback renders the same state/detail
- existing coalescing and rate-limit behavior remain
- final result cannot be overwritten by a stale progress update

### Completion tests

- complete multi-source summary
- simple success omits summary
- partial keeps successful output and names failed source
- blocked includes exact dependency/action
- stopped uses audit evidence before claiming no changes
- no internal IDs, secrets, raw reasoning, stack traces, or artifact URIs
- summary never exceeds four lines

### Live Slack check

Exercise one multi-source request that runs longer than one minute. Verify:

- receipt appears within two seconds
- every meaningful stage transition appears within one 400 ms rendering cadence
- one top-level message is used
- elapsed time remains visible
- final answer replaces progress
- partial provider failure remains actionable

## Success criteria

- People can identify the current meaningful stage without opening logs.
- No turn shows only a rotating thinking phrase after meaningful work starts.
- Planned stage counts are always evidence-based.
- Partial results clearly separate successful and unavailable sources.
- Existing Slack message volume does not increase.
- Existing streaming, fallback, threading, receipt, stop, and final-delivery tests remain green.
