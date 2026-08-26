# Plain-Language Work Review — Design Spec

- **Issue:** #359 — plain-language work review (blocked work-item review surface)
- **Status:** Design (no implementation)
- **Branch/worktree:** `design-359-review-v6` (base `c868702`)
- **Scope:** Slack notification + fast action; linked web page; any current channel member may continue; legal-friendly terms; technical details collapsed; optional guidance; no graph canvas; no new accounts.

---

## 1. Decisions & non-goals

**Decisions**

1. **Slack-only entry, optional web detail.** A blocked work item surfaces as a Slack message with a "Review work" fast action and a link to a web review page. The web page is a detail/continuation surface, not a login portal.
2. **Any current channel member may continue.** Authorization is live Slack membership in the originating channel at review time, not the original requester. This matches "any current channel member may continue" as decided.
3. **No Slack OIDC, no new accounts, no browser API bearer.** The browser must never receive `BOTTEGA_API_TOKEN`. Auth for the web page reuses the proven single-use expiring SQLite token pattern (like `upload_tokens` / `oauth_flows` with `consumeOnce`).
4. **Token binds a session, then hands off.** The single-use token is redeemed once to bind actor + session and establish an HttpOnly `SameSite=Lax` session cookie; subsequent page POSTs ride the cookie, not a raw token.
5. **Membership rechecked on every protected request.** Both the page GET (during render) and the continuation POST re-verify live membership via `conversations.members` using existing bot scopes. A user who leaves the channel between render and continue is denied at continue time.
6. **Legal-friendly, collapsed details.** Copy avoids implying agency/legal authority; technical plumbing is hidden behind a single explanation control (collapsed details).
7. **Optional guidance.** The continuation form has an optional free-text guidance field; empty is allowed and means "continue with the item's existing context."
8. **Reuse fork core.** Fast Slack continue and web continuation both go through a shared continuation service that reuses the work-item fork core (`src/work-items/fork.ts`).

**Non-goals**

- New user accounts, Slack OIDC, or embedding a Slack identity provider.
- Browser exposure of the service bearer token (browser-unsafe).
- Graph canvas visualization of the review flow.
- Changing existing approval / policy machinery for work items — policy and approval stay untouched.
- Subscribing reviewers; reviewers are whoever is a member at the time of action.

---

## 2. Terminology

| Term | Meaning |
| --- | --- |
| Work item | A tracked unit of work in the timeline (entry, claimed, turn, tool-call, delivery-pending, failed, completed, blocked). |
| Blocked item | A work item whose most recent state is `blocked`; the surface this feature targets. |
| Reviewer | The Slack user who clicks the fast action or opens the web page; must be a current member of the originating channel. |
| Review token | Single-use, expiring, hashed-at-rest credential that binds a reviewer + session to one work item and channel. |
| Continuation | Resuming/replying to a blocked work item's turn, optionally with guidance, reusing the fork core. |
| Originating channel | The Slack channel in which the blocked item's deliverable/outbox interaction happens and where the review message posts. |

---

## 3. Journeys

### 3.1 Fast Slack action (primary)

1. Work item reaches `blocked`; the outbox seam renders an out-of-band Slack card (existing pattern via `renderOutboxBlocks` in `src/server/services/outbox-post-seam.ts`).
2. Card includes "Review work" as the fast action (`RETRY_WITH_CONTEXT_ACTION_ID`-style registration) and a "View details" link to `GET /work-review/:token`.
3. Reviewer clicks the fast action inside Slack. Slack sends an interactive payload (authenticated identity: `team_id` + `user_id` + `channel_id`).
4. Server mints a review token bound to `(work_item, slack_team_id, slack_user_id, slack_channel_id)`, stores only its hash, then verifies live membership and continues via the shared continuation service.
5. The card updates in place (acknowledge; errors surfaced in the same thread). Reviewer never leaves Slack.

### 3.2 Web review page (detail + continuation)

1. Reviewer clicks "View details" → `GET /work-review/:token`.
2. Server looks up the token by hash; if valid, unexpired, unconsumed, verifies live membership, then redeems the token once: binds actor + session, issues HttpOnly `SameSite=Lax` cookie (session-scoped), redirects to `GET /work-review/<session>` (cookie-authenticated page).
3. Page renders the blocked item in plain language plus a collapsed "technical details" disclosure; offers an optional guidance textarea and a "Continue" button.
4. Reviewer submits `POST /work-review/:token/continue` over the cookie session; membership rechecked; optional guidance recorded; fork-core continuation runs; page shows result or error.

> The slug `:token` in the cookie phase is opaque and stable for the session; the one-time token that started the session is discarded after redemption.

---

## 4. Reused seams (verified)

| Seam | Location | Reuse |
| --- | --- | --- |
| Blocked outbox rendering | `src/server/services/outbox-post-seam.ts` (`renderOutboxBlocks`) | Render the review card + actions for blocked items. |
| Existing retry action/router | `RETRY_WITH_CONTEXT_ACTION_ID`; `src/server/adapters/retry-router.ts` | Fast Slack "Review work" action registration and routing convention. |
| Action registration | `src/server/index.ts` | Register the new `open_work_review` action alongside existing ones. |
| Timeline events | `src/work-items/timeline.ts` (entry, claimed, turn, tool-call, delivery-pending, failed, completed, blocked) | Record review-specific audit events. |
| Fork core | `src/work-items/fork.ts` | Shared continuation service reuses fork core for fast + web continue. |
| Existing REST routes | `src/server/api.ts` | Pattern for routes; but these use browser-unsafe `BOTTEGA_API_TOKEN` and MUST NOT be called directly by the browser. |
| Single-use expiring token | `upload_tokens` / `oauth_flows` with `consumeOnce` | Reuse the proven SQLite token pattern; hashed at rest. |
| Graph relations | `src/graph/view.ts` (nodes: work-item/memory/person/space/repo/job/pr; relations: created/assigned/approved-by/delivered/targets/scheduled-in/decided-in/mentions/depends-on/forked-from) | Optionally record a `reviewed-in`/`continued-by` edge; not required. |

---

## 5. New components / routes / actions

### 5.1 Slack action

- **Name:** `open_work_review`
- Registered in `src/server/index.ts`; routed through the shared Slack action router (retry-router convention).
- Payload carries authenticated identity; server mints a review token and calls the shared continuation service for the fast path.

### 5.2 Routes

- `GET /work-review/:token`
  - Token redemption + session-cookie establishment, then `303 See Other` → `GET /work-review/<session>`.
- `GET /work-review/<session>` (cookie-authenticated)
  - Renders the plain-language page (see §8 states/data mapping). No token in this URL alone.
- `POST /work-review/:token/continue` (cookie-authenticated)
  - Optional guidance + continuation; membership recheck; returns page state (result or error).
  - The `:token` here is the opaque session slug used by the page (may be the same identifier as the cookie session id).

### 5.3 Shared continuation service

- New service (e.g. `src/server/services/work-review-service.ts`) that both the fast Slack path and the web POST path call.
- Reuses fork core from `src/work-items/fork.ts`; records review-specific audit events; preserves existing policy/approval.

---

## 6. Review token schema & lifecycle

**Schema** (SQLite, mirrors the `upload_tokens` / `oauth_flows` pattern):

```sql
CREATE TABLE work_review_tokens (
  token_hash        TEXT PRIMARY KEY,           -- SHA-256 of the random token; raw token never stored
  work_item_id      TEXT NOT NULL,              -- FK into timeline work items
  slack_team_id     TEXT NOT NULL,
  slack_user_id     TEXT NOT NULL,              -- actor minted for (fast path) or requested-at (web)
  slack_channel_id  TEXT NOT NULL,
  expires_at        INTEGER NOT NULL,           -- epoch ms; TTL (e.g. 30 min)
  consumed_at       INTEGER,                    -- NULL until single-use redemption
  created_at        INTEGER NOT NULL            -- epoch ms
);
```

**Lifecycle**

1. **Mint:** On Slack card render (web link) or on fast action, generate a high-entropy random token, store `token_hash`, set `expires_at = now + TTL`, `consumed_at = NULL`.
2. **Redeem (web GET):** Look up by hash; require exists, not expired, `consumed_at IS NULL`; verify live membership; then atomically set `consumed_at = now` (single-use) and issue the HttpOnly session cookie bound to `(work_item_id, slack_team_id, slack_user_id, slack_channel_id)`.
3. **Session phase:** Page interactions use the cookie, not the token; the token is dead after redemption. Fast-path tokens may be consumed inline at continue time.
4. **Expiry/cleanup:** Expired or legitimate single-use tokens are inert; a janitor/`expires_at` check rejects stale redemptions. No standing credential remains in the browser.

---

## 7. Slack live-membership authorization

- On **every** protected request (render and continue), the server calls `conversations.members` for `slack_channel_id` using existing bot scopes, and confirms `slack_user_id` ∈ members.
- Slack interactive payload `user_id` is the authenticated identity for the fast path; the review-token `slack_user_id` constrains the web path.
- If the user has left the channel (or was never a member) at check time, the request is denied (`403`) regardless of token validity. Tokens minted to a user who later leaves do not authorize continuation.
- This is the single source of truth for "who may continue": live membership, not token possession alone.

---

## 8. Server-rendered page states / data mapping

Page states for `GET /work-review/<session>` and the POST result render:

| State | Condition | Rendered |
| --- | --- | --- |
| `loading/valid` | Cookie session valid; membership current | Plain-language blocked summary, collapsed "technical details", guidance textarea, Continue button. |
| `expired` | Session TTL passed | Expired notice; re-request a fresh review card link. |
| `not-member` | Membership check fails | "You are not a member of the originating channel" — no item details. |
| `rejected` | Token never valid / already consumed w/o valid session | Generic "link invalid" page (no detail leakage). |
| `continued` | POST succeeded | Success confirmation, plain-language outcome, audit note. |
| `error` | Continuation failed | Error + retry affordance; membership rechecked on retry. |

Data mapping to graph/timeline: pull latest timeline entry for `work_item_id`; surface `blocked` state and last known turn summary in plain language; reveal raw event/status only under the collapsed technical disclosure.

---

## 9. Continuation with optional guidance / idempotency

- **Optional guidance:** form field `guidance` (free text, optional). Empty ⇒ continue with existing context. Max length enforced server-side; stored/echoed in audit.
- **Idempotency:** continuation is settle-once semantics like the existing `work_item.forked` audit dedupe. Each continuation records a review-specific audit event; a repeated identical POST for an already-continued item returns the prior result (no double work).
- Reusing fork core keeps state transitions consistent with the timeline; policy/approval unchanged.

---

## 10. Audit / security / errors / accessibility

**Security**

- `work_review_tokens.token_hash` only; raw token never persisted. Single-use redemption; expire + consume checks on every use.
- HttpOnly + `SameSite=Lax` session cookie; no `BOTTEGA_API_TOKEN` in browser (existing browser-unsafe routes remain server/back-office only).
- CSRF: `SameSite=Lax` cookie + server-side origin/referer check on POST; action payloads are Slack-authenticated.
- Rate-limit token minting and continuation POSTs per actor/channel.

**Error handling**

- All failures return a user-reachable plain-language message, never raw internals.
- Membership denial returns the `not-member` state without revealing item content.
- Invalid/expired tokens return the generic `rejected` state (no detail leakage).

**Accessibility**

- Fast Slack action requires no browser (keyboard/assistive-tech friendly).
- Web page: semantic HTML, keyboard-operable form, labelled guidance textarea, collapsed details exposes content via disclosure semantics (`<details>/<summary>`), AA contrast, focus management after submit.

**Audit**

- New review-specific audit events alongside existing settle-once `work_item.forked`; log mint, redeem, membership check result, continue (with or without guidance), and failure.

---

## 11. Migration

- **Schema:** additive `CREATE TABLE work_review_tokens` — no change to existing tables, no backfill. New table created by the existing migration mechanism (same path as `upload_tokens`/`oauth_flows`).
- **Routes/actions:** additive registration in `src/server/index.ts`; existing retry action and routes untouched.
- **Outbox seam:** extend `renderOutboxBlocks` to add the review card/action for blocked items only; other outbox behavior unchanged.
- **Rollback-safe:** all additions are additive; dropping the feature removes the card/actions/routes/table without affecting existing flows.

---

## 12. Caller-level hermetic tests + browser smoke

**Hermetic tests (additive, no project-wide suite run per contract)**

1. Token mint → store hash-only; raw token not returned by any lookup.
2. Single-use: second redemption of the same token is rejected.
3. Expiry: expired token rejected even if unconsumed.
4. Membership: `not-member` denial on render and on continue (mocked `conversations.members`).
5. Cookie handoff: valid token establishes HttpOnly `SameSite=Lax` cookie; session POST works without the raw token.
6. Guidance: empty guidance ⇒ continue with context; populated guidance recorded; max length enforced.
7. Idempotency: repeated continuation POST returns prior result, no double work.
8. Route sanity: `GET /work-review/:token` 303s to session; `POST .../continue` renders `continued` or `error`; `BOTTEGA_API_TOKEN` never appears in browser-facing response.

**Browser smoke**

- Launch server; mint a review token (test helper), drive the browser: GET token URL → 303 → page renders valid state → POST continue → `continued` state. Verify no bearer token in any network request on the page.
- Visual confirmation of collapsed technical details disclosure and keyboard operation.

---

## 13. Rollout / rollback

**Rollout**

1. Merge additive schema + routes + action registration behind the outbox card.
2. Canary: enable the review card for a single channel/team; observe membership checks and continuation success.
3. Widen to all channels. No feature flag persisted state beyond the additive table.

**Rollback**

- Remove the outbox card/action and route registration; stop serving the web page. Existing sessions simply expire; token table can be dropped. No data migration reverse needed because nothing existing was modified.

---

## 14. Acceptance matrix

| # | Acceptance criterion | Verified seam / test |
| --- | --- | --- |
| A1 | Blocked work item renders a "Review work" Slack action + "View details" link | `renderOutboxBlocks` extension; test 8 |
| A2 | Fast Slack action continues the item without leaving Slack, reusing the fork core | shared continuation service + retry router; test 4/5 |
| A3 | Web page authenticates without exposing `BOTTEGA_API_TOKEN` to the browser | token + cookie; test 8 |
| A4 | Token is single-use, expiring, hashed at rest | schema + tests 1–3 |
| A5 | Any current channel member may continue; members who leave are denied | `conversations.members` on every protected request; test 4 |
| A6 | Page uses plain language; technical details collapsed | §8 states; browser smoke |
| A7 | Guidance is optional; empty continues with existing context | §9; test 6 |
| A8 | Continuation is idempotent (settle-once) and audits review events | fork-core reuse + audit; test 7 |
| A9 | Existing policy/approval machinery is unchanged | no touched seams beyond additive; §4 |
| A10 | Rollback is additive-safe | §11, §13 |

---

## 15. Out of scope / next

- Subscriber-triggered review assignment (who reviews today = whoever acts).
- Graph canvas + account/federation for review.
- Browser-safe general API bearer (`BOTTEGA_API_TOKEN` remains server-only).
- Any change to work-item policy or approval logic.