# Plain-Language Work Review — Design Specification

- **Issue:** #359
- **Status:** Approved design; implementation pending
- **Scope:** Slack notification and fast action, linked server-rendered review page, live Slack channel authorization, plain-language continuation of blocked work.

## Product decisions

Slack remains the notification and action surface. A blocked item shows exactly two actions: **Open review** and **Continue using work so far**. Slack does not render a graph, detailed event trail, or checkpoint picker.

The linked page explains the work in non-technical language. It shows **What happened**, **Work completed**, **Still needed**, and related people, matters, documents, and decisions. **Full activity and technical details** is collapsed by default.

Any current member of the originating Slack channel may open or continue the work. The server checks live channel membership on every protected request. Existing policy and delivery-approval gates remain unchanged.

Internal concepts stay internal: work item/run becomes “work” or “review”; blocked becomes “needs attention”; timeline becomes “activity”; fork becomes “continue using work so far”; graph becomes “related people, matters, documents, and decisions”; transcript/tool call becomes “details” or “source checked.” Work-item IDs appear only in collapsed technical details and support logs.

Non-goals: interactive graph canvas; separate Bottega accounts; Slack OpenID Connect; browser access to `BOTTEGA_API_TOKEN`; changing policy or approval semantics; deleting audit or session history.

## User journeys

### Blocked notification

`renderOutboxBlocks` in `src/server/services/outbox-post-seam.ts` extends the existing blocked card with:

1. **Open review** — interactive Slack button, `action_id: open_work_review`, with the work-item ID only in its signed Slack action value. It is not a URL button.
2. **Continue using work so far** — the existing `RETRY_WITH_CONTEXT_ACTION_ID` fast path. It immediately continues from the last failure without optional guidance.

The card summarizes the matter, completed work, and unresolved need. It does not expose event kinds, graph relations, transcript spans, or raw errors.

### Open review

Slack authenticates the click through its verified interactive payload. The `open_work_review` handler obtains the Slack team, user, and channel from that payload; confirms the channel is the work item’s originating space; and calls `conversations.members` to verify current membership.

Only after that check, the server creates an actor-bound, single-use review token and sends the user an ephemeral Slack message containing a private link. The extra click is intentional: a static channel message cannot contain an actor-bound link, and forwarding the ephemeral link alone must not grant another Slack identity authority.

The private link is `GET /work-review/redeem/:token`. Redemption atomically consumes the token, rechecks live membership, creates a server-side review session, sets a random session cookie, and responds `303 See Other` to `GET /work-review`. The canonical page and form contain no raw review token or API bearer.

### Review and continue

`GET /work-review` loads the server-side session by the hashed cookie value, rechecks membership, builds the existing #358 timeline, and projects it to plain language. Related context uses the existing #357 graph projection. The page is server-rendered and requires no privileged browser API.

The primary action is **Continue using this work**. **Add guidance first** reveals an optional textarea, for example “Use the retention schedule attached by Procurement.” `POST /work-review/continue` verifies the session, CSRF token, live membership, input limit, and source state, then invokes the shared continuation service. Success renders the new work state and posts a confirmation to the originating Slack channel.

## Existing seams reused

- Blocked card: `renderOutboxBlocks`, `src/server/services/outbox-post-seam.ts`.
- Slack actions: registration in `src/server/index.ts`; existing adapter verification and retry routing conventions.
- Fast continuation: `RETRY_WITH_CONTEXT_ACTION_ID` and `src/server/adapters/retry-router.ts`.
- Timeline: `src/work-items/timeline.ts`; entry kinds include created, claimed, turn, tool-call, delivery-pending, failed, completed, and blocked.
- Continuation: `src/work-items/fork.ts`; source remains immutable and `work_item.forked` records lineage.
- Graph context: `src/graph/view.ts`; project existing people, spaces, repositories, jobs, decisions/memories, work items, and `forked-from` lineage into plain-language related sections.
- Single-use persistence: follow the additive SQLite and atomic-consume conventions used by `upload_tokens` and `oauth_flows`.
- Browser-facing routes mount on the existing server listener, but MUST NOT call the bearer-protected routes in `src/server/api.ts` from browser code.

## New components and interfaces

1. `open_work_review` Slack action handler: authorize click, mint token, send ephemeral private link.
2. Shared work-review service: assemble plain-language review data and continue work through the existing fork core. Both Slack fast continue and web continue call the same continuation operation.
3. Server-rendered routes:
   - `GET /work-review/redeem/:token`
   - `GET /work-review`
   - `POST /work-review/continue`
4. Additive persistence for one-time tokens and browser sessions.

No new dependency is required.

## Token and session persistence

Migration adds two tables; no existing table changes and no backfill:

```sql
CREATE TABLE work_review_tokens (
  token_hash TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  slack_team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE work_review_sessions (
  session_hash TEXT PRIMARY KEY,
  csrf_hash TEXT NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  slack_team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
```

Raw token, session, and CSRF values are high-entropy random bytes and are never stored. Hashes use SHA-256 with constant-time comparison where applicable. The session value appears only in a `Secure; HttpOnly; SameSite=Lax; Path=/work-review` cookie. The CSRF value is rendered as a hidden form field and checked against `csrf_hash` with constant-time comparison. Origin/Referer checks are defense in depth, not the CSRF control.

Tokens are short-lived and single-use. Redemption uses one atomic transaction: validate unexpired/unconsumed token, mark consumed, create session. Sessions are short-lived and rotate or update `last_seen_at` within a fixed maximum lifetime. Expired rows remain inert; cleanup may evict credentials but does not delete audit or transcript rows.

## Authorization and failure behavior

Every protected GET and POST calls `conversations.members` and requires the session’s Slack user to remain a member of the session’s Slack channel. Membership API failure denies access; it does not use cached membership. The originating channel must match the work item’s space.

- Invalid, consumed, or expired redemption: generic “This review link is no longer valid.” No work details.
- Missing/expired session: “Open the review again from Slack.”
- Non-member or membership lookup failure: deny with no work details.
- Source no longer continuable: explain that the work already continued or completed and link to the existing result when authorized.
- Continuation failure: keep the original untouched, record failure with context, show a plain-language retry state.
- Duplicate click/POST: return the previously created continuation. Do not create a second item.

Idempotency reuses the existing settle-once `work_item.forked` evidence, keyed by source work item and continuation intent. Optional guidance is trimmed, length-limited, stored in fork metadata/audit, and never changes the original. The first continuation wins; later attempts resolve to it.

## Review projection

The service converts existing evidence; it does not create a second timeline store.

- **What happened:** goal plus the last meaningful failed/blocked event, rewritten without raw stack traces.
- **Work completed:** completed turns and deliverable milestones before the failure.
- **Still needed:** unresolved failure/blocked reason and requested human input.
- **Related people:** creator, assignee, approvers.
- **Related matters:** connected work items and fork lineage.
- **Related documents and decisions:** repositories, pull requests, decision/memory records, and cited source labels available from the graph projection.
- **Full activity and technical details:** chronological #358 timeline, collapsed by default.

Do not let the model invent legal conclusions for this projection. Use stored labels, states, event summaries, and provenance. Missing context is omitted rather than fabricated.

## Audit, policy, and retention

Add review-specific append-only events for link mint, successful redemption, denied membership check, review read, continuation requested, continuation resolved to existing, and continuation failed. Never store raw credential values or optional guidance in logs beyond the durable authorized audit/fork metadata required for provenance.

Continuation still creates a new work item through the #358 fork core. The original remains unchanged. Space policy, tool allowlists, delivery approval, and audit immutability are inherited exactly as today. UI authorization grants access to request continuation; it does not bypass execution or delivery approval.

Rollback removes the Slack controls and route registration, then lets issued sessions expire. The additive credential tables and append-only audit rows remain retained; rollback does not drop or delete them.

## Accessibility and UX states

Use semantic server-rendered HTML, a real heading hierarchy, labelled form controls, keyboard-visible focus, AA contrast, an `aria-live` result region, and `<details>/<summary>` for technical disclosure. After submit, focus the success/error heading. Guidance is optional and labelled as such.

Page states: active review, continued, already continued, expired session, unauthorized, source completed, and recoverable failure. Unauthorized states reveal no matter name or contents.

## Verification

Caller-level hermetic tests must fail if the headline flow breaks:

1. Drive the real blocked outbox rendering and assert exact plain-language summary plus `Open review` and `Continue using work so far` actions.
2. Drive the real Slack action wiring with a verified actor. A current member receives an ephemeral actor-bound link; a non-member receives no link and no matter details.
3. Redeem through the actual server listener: valid token is consumed once, cookie is Secure/HttpOnly/SameSite=Lax, redirect target contains no credential, repeated redemption fails.
4. Membership is rechecked on page GET and continue POST. Removing the actor between render and submit fails closed.
5. CSRF mismatch fails; browser requests never contain `BOTTEGA_API_TOKEN`.
6. Review page shows the approved plain-language sections from real timeline/graph projections and keeps technical activity collapsed.
7. Web continuation with and without guidance creates one fork, preserves the source, records actor/guidance/lineage, inherits policy/approval, and posts Slack confirmation.
8. Slack fast continuation uses the same service and creates exactly one attempt; duplicate Slack/web actions return that attempt.
9. Invalid, expired, unauthorized, membership-outage, already-completed, and continuation-failure states reveal no raw internals.

Smoke the actual page with the browser: open from a hermetic Slack action fixture, redeem, inspect rendered plain-language sections and collapsed details, add guidance, continue, observe confirmation and Slack post, and inspect network requests for absence of bearer tokens. Then run targeted tests, `bun check`, `bun run lint`, and the full suite before landing.

## Rollout

Land additively and enable for one QA channel first. Verify link redemption, membership denial, continuation dedupe, policy/approval inheritance, and Slack confirmation. Then enable for all spaces. The scheduled live-Slack canary gains one journey covering blocked notification → open review → continue → observable new attempt and audit lineage. Missing live credentials remain skip-gated locally and fail in CI-strict canary mode.
