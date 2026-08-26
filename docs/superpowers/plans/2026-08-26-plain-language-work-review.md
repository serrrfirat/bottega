# Plain-Language Work Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give non-technical Slack users a secure, plain-language web review of blocked work and a safe way to continue using completed work.

**Architecture:** Slack remains the notification and identity boundary. An interactive action verifies live channel membership, mints an actor-bound one-time token, and sends an ephemeral review link. Server-rendered routes redeem that token into a hashed cookie session, project existing timeline/graph evidence into plain language, and call one idempotent continuation service shared with Slack’s fast action.

**Tech Stack:** TypeScript, Bun, `bun:test`, Bun SQLite, Slack Bolt/Web API, existing server listener and work-item timeline/fork/graph projections.

---

## File map and dependency waves

**Wave 1 — independent foundations**

- `src/store/migrations.ts`, `src/store/schema.sql`, `src/store/migrations.test.ts`: additive migration 017.
- `src/server/adapters/slack.ts` and tests: live membership and ephemeral-post adapter primitives.
- `src/server/adapters/blocks.ts` and tests: exact user-facing buttons.

**Wave 2 — depends on Wave 1 store schema**

- `src/store/db.ts` and focused tests: hashed token/session persistence.
- `src/server/work-review/continuation.ts` and test: shared settle-once continuation.
- `src/server/work-review/project.ts` and test: plain-language projection.

**Wave 3 — depends on Waves 1–2 contracts**

- `src/server/adapters/work-review-router.ts` and test: actor-bound ephemeral link.
- `src/server/work-review/routes.ts` and caller-level test: redeem, page, CSRF, continue.
- `src/server/index.ts`, `src/server/services/outbox-post-seam.ts`: actual wiring.

**Wave 4 — complete-system evidence**

- caller-level hermetic flow, browser smoke, docs/canary, quality gate, landing.

Cross-task contracts are frozen below; agents MUST coordinate before changing a signature.

### Task 1: Add review credential schema

**Files:**
- Modify: `src/store/migrations.ts`
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.test.ts`

- [ ] **Step 1: Write the failing migration test**

Add migration ID `017_add_work_review_credentials` to the expected ledger and assert both tables/columns through SQLite metadata:

```ts
expect(ledgerIds(upgraded.getDb()).at(-1)).toBe("017_add_work_review_credentials");
expect(columnNames(upgraded.getDb(), "work_review_tokens")).toEqual([
  "token_hash", "work_item_id", "slack_team_id", "slack_user_id",
  "slack_channel_id", "expires_at", "consumed_at", "created_at",
]);
expect(columnNames(upgraded.getDb(), "work_review_sessions")).toEqual([
  "session_hash", "csrf_hash", "work_item_id", "slack_team_id",
  "slack_user_id", "slack_channel_id", "expires_at", "created_at", "last_seen_at",
]);
```

- [ ] **Step 2: Verify failure**

Run: `bun test src/store/migrations.test.ts`
Expected: FAIL because migration 017 and tables are absent.

- [ ] **Step 3: Add migration and canonical schema**

Use the exact SQL from the approved spec. Add foreign keys to `work_items(id)`, expiry indexes, and no destructive down migration. Update older-upgrade test cleanup lists to include 017.

- [ ] **Step 4: Verify pass**

Run: `bun test src/store/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add src/store/migrations.ts src/store/schema.sql src/store/migrations.test.ts && git commit -m "feat(store): added work review credential tables (#359)"`

### Task 2: Add hashed token and session store APIs

**Files:**
- Modify: `src/store/db.ts`
- Test: `src/store/work-review-credentials.test.ts`

Freeze these types/signatures:

```ts
export type WorkReviewIdentity = {
  workItemId: string; slackTeamId: string; slackUserId: string; slackChannelId: string;
};
export type WorkReviewSession = WorkReviewIdentity & { csrfHash: string; expiresAt: number };

createWorkReviewToken(identity: WorkReviewIdentity, expiresAt: number): string;
redeemWorkReviewToken(input: {
  rawToken: string; rawSession: string; csrfHash: string; sessionExpiresAt: number; now: number;
}): WorkReviewSession | null;
getAndTouchWorkReviewSession(rawSession: string, now: number): WorkReviewSession | null;
```

- [ ] **Step 1: Write failing behavior tests**

Cover: only SHA-256 token/session hashes appear in SQLite; raw values absent; redemption atomically consumes once and creates one session; expired token fails; expired session fails; `last_seen_at` advances.

```ts
const raw = store.createWorkReviewToken(identity, now + 60_000);
expect(db.query("SELECT token_hash FROM work_review_tokens").get()).not.toContain(raw);
expect(store.redeemWorkReviewToken({ rawToken: raw, rawSession: "s1", csrfHash, sessionExpiresAt, now })).not.toBeNull();
expect(store.redeemWorkReviewToken({ rawToken: raw, rawSession: "s2", csrfHash, sessionExpiresAt, now })).toBeNull();
```

- [ ] **Step 2: Verify failure**

Run: `bun test src/store/work-review-credentials.test.ts`
Expected: FAIL because methods do not exist.

- [ ] **Step 3: Implement minimally**

Use `createHash("sha256")`, cryptographic random bytes, prepared statements, and one SQLite transaction for consume-plus-session-insert. Never return hash rows publicly. Contextual errors; no catch-and-swallow.

- [ ] **Step 4: Verify pass**

Run: `bun test src/store/work-review-credentials.test.ts src/store/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add src/store/db.ts src/store/work-review-credentials.test.ts && git commit -m "feat(store): added atomic work review sessions (#359)"`

### Task 3: Add Slack membership, ephemeral post, and exact controls

**Files:**
- Modify: `src/server/adapters/slack.ts`
- Modify: `src/server/adapters/blocks.ts`
- Modify: `src/server/adapters/blocks.test.ts`
- Test: `src/server/adapters/slack-membership.test.ts`

Frozen adapter methods:

```ts
isChannelMember(spaceId: string, userId: string): Promise<boolean>;
postEphemeral(spaceId: string, userId: string, text: string): Promise<void>;
```

Constants/UI:

```ts
export const OPEN_WORK_REVIEW_ACTION_ID = "bottega_open_work_review";
openWorkReviewButton(id); // text exactly "Open review"
retryWithContextButton(id); // text exactly "Continue using work so far"
```

- [ ] **Step 1: Write failing tests**

Drive injected Slack client fakes. Assert `conversations.members` receives the channel derived from `slack:C123`, membership is not cached, pagination is handled if required by the current adapter convention, API errors reject, and `chat.postEphemeral` receives channel/user/text. Assert exact Block Kit labels/action IDs.

- [ ] **Step 2: Verify failure**

Run: `bun test src/server/adapters/blocks.test.ts src/server/adapters/slack-membership.test.ts`
Expected: FAIL on missing methods/button and old retry copy.

- [ ] **Step 3: Implement**

Extend the existing adapter interface/implementation and all test doubles. Add `open_work_review` to the verified action-ID matcher. Membership lookup errors MUST throw so callers deny.

- [ ] **Step 4: Verify pass**

Run the same command; expected PASS.

- [ ] **Step 5: Commit**

`git add src/server/adapters/slack.ts src/server/adapters/blocks.ts src/server/adapters/blocks.test.ts src/server/adapters/slack-membership.test.ts && git commit -m "feat(slack): added work review identity primitives (#359)"`

### Task 4: Build shared idempotent continuation

**Files:**
- Create: `src/server/work-review/continuation.ts`
- Test: `src/server/work-review/continuation.test.ts`
- Modify: `src/server/adapters/retry-router.ts`

Frozen API:

```ts
export async function continueWork(
  deps: { store: Store; transcriptDir: string },
  input: { sourceId: string; requester: string; spaceId: string; guidance?: string },
): Promise<{ forkId: string; existed: boolean }>;
```

- [ ] **Step 1: Write failing caller tests**

Seed a blocked source and transcript in a real temp SQLite store. Assert source remains blocked, one fork is created after the last failure, actor/guidance are in fork metadata/audit, policy/delivery fields inherit, and concurrent/repeated calls return the same fork with `existed:true`.

- [ ] **Step 2: Verify failure**

Run: `bun test src/server/work-review/continuation.test.ts`
Expected: FAIL because service is absent.

- [ ] **Step 3: Implement minimal shared service**

Reuse `forkWorkItem` and `WORK_ITEM_FORKED_EVENT`; perform settle-once lookup inside the store transaction boundary available to the existing retry path. Trim optional guidance and enforce the approved maximum in one exported schema/constant. Migrate `resolveRetryAction` to this service; no duplicate fork logic.

- [ ] **Step 4: Verify pass and caller compatibility**

Run: `bun test src/server/work-review/continuation.test.ts src/server/adapters/retry-router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add src/server/work-review/continuation.ts src/server/work-review/continuation.test.ts src/server/adapters/retry-router.ts && git commit -m "feat(work-review): shared idempotent continuation (#359)"`

### Task 5: Project evidence into plain language

**Files:**
- Create: `src/server/work-review/project.ts`
- Test: `src/server/work-review/project.test.ts`

Frozen result shape:

```ts
export type PlainWorkReview = {
  workItemId: string; title: string; state: WorkItemState;
  whatHappened: string[]; workCompleted: string[]; stillNeeded: string[];
  relatedPeople: string[]; relatedMatters: string[];
  relatedDocuments: string[]; relatedDecisions: string[];
  activity: TimelineEntry[];
};
export async function projectWorkReview(deps, id: string): Promise<PlainWorkReview | null>;
```

- [ ] **Step 1: Write failing projection tests**

Seed real timeline/audit/graph records. Assert the approved sections contain stored labels and provenance, technical IDs/raw stack traces are absent from default arrays, missing related categories are empty, and chronological activity is retained for collapsed details. Include legal fixture: vendor review completes three checks and pauses on missing retention period.

- [ ] **Step 2: Verify failure**

Run: `bun test src/server/work-review/project.test.ts`
Expected: FAIL because projection is absent.

- [ ] **Step 3: Implement deterministic projection**

Call `buildTimeline` and `projectGraph`; map stored evidence only. No model call, invented legal conclusion, secondary persistence, or new graph relation.

- [ ] **Step 4: Verify pass**

Run same command; expected PASS.

- [ ] **Step 5: Commit**

`git add src/server/work-review/project.ts src/server/work-review/project.test.ts && git commit -m "feat(work-review): projected work evidence in plain language (#359)"`

### Task 6: Wire blocked Slack card and actor-bound open action

**Files:**
- Modify: `src/server/services/outbox-post-seam.ts`
- Create: `src/server/adapters/work-review-router.ts`
- Test: `src/server/adapters/work-review-router.test.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Write failing caller-level tests**

Drive real `renderOutboxBlocks`: blocked card has exact two actions; non-blocked card does not. Drive `resolveOpenReviewAction` through real action wiring: member gets one ephemeral `/work-review/redeem/<raw>` link; non-member/API failure gets no link and no item details; channel/work-item mismatch denies.

- [ ] **Step 2: Verify failure**

Run: `bun test src/server/adapters/work-review-router.test.ts src/server/services/outbox-post-seam.test.ts`
Expected: FAIL on missing action/router.

- [ ] **Step 3: Implement**

`resolveOpenReviewAction` validates action ID, item, originating space, and membership before calling `createWorkReviewToken`. Build link from late-bound `uploadLinkPublicBase() ?? oauthCallback.baseUrl`; post ephemerally. Add branch in `index.ts` and both buttons in blocked render.

- [ ] **Step 4: Verify pass**

Run same command plus `bun test src/server/adapters/retry-router.test.ts`; expected PASS.

- [ ] **Step 5: Commit**

`git add src/server/services/outbox-post-seam.ts src/server/adapters/work-review-router.ts src/server/adapters/work-review-router.test.ts src/server/index.ts && git commit -m "feat(slack): linked blocked work to private review (#359)"`

### Task 7: Add authenticated server-rendered review routes

**Files:**
- Create: `src/server/work-review/routes.ts`
- Create: `src/server/work-review/render.ts`
- Test: `src/server/work-review/routes.test.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Write failing end-to-end route tests**

Mount the actual listener with real temp Store and Slack adapter fake. Cover: valid redeem atomically consumes and returns 303; cookie includes `Secure; HttpOnly; SameSite=Lax; Path=/work-review`; redirect/page contains no credential; GET rechecks membership; POST requires matching CSRF, rechecks membership, accepts optional guidance, calls continuation once, and posts Slack confirmation. Cover invalid/expired/consumed token, expired session, member removed between GET/POST, membership outage, completed source, duplicate POST, and continuation failure without detail leakage.

- [ ] **Step 2: Verify failure**

Run: `bun test src/server/work-review/routes.test.ts`
Expected: FAIL because mount/routes do not exist.

- [ ] **Step 3: Implement route mount and renderer**

Frozen routes:

```ts
GET /work-review/redeem/:token
GET /work-review
POST /work-review/continue
```

Use cookie `bottega_work_review`, random CSRF hidden field, constant-time hash comparison, form max length, server HTML escaping, semantic headings, `<details><summary>Full activity and technical details</summary>`, `aria-live`, focus target, no client bearer/fetch. Membership failure denies with generic page.

- [ ] **Step 4: Wire actual listener**

Mount beside current callback/upload/REST surfaces in `src/server/index.ts`; preserve the single listener and route ordering. Pass Store, transcript directory, adapter picks, audit, and late-bound public base. Do not mount a second `restApi`.

- [ ] **Step 5: Verify pass**

Run: `bun test src/server/work-review/routes.test.ts src/server/boot-wiring.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

`git add src/server/work-review/routes.ts src/server/work-review/render.ts src/server/work-review/routes.test.ts src/server/index.ts && git commit -m "feat(web): added authenticated plain-language work review (#359)"`

### Task 8: Caller-level acceptance, docs, canary, and landing

**Files:**
- Create or modify the highest existing hermetic caller test near `src/server/boot-wiring.test.ts`
- Modify: `features.md`
- Modify: `architecture.md`
- Modify: `tests/e2e/canary-registry.ts` and scheduled journey only if the current canary pattern supports the new surface

- [ ] **Step 1: Add headline caller test**

Drive blocked item → real Slack card/action → member ephemeral link → redeem → plain review → add guidance → continue → exactly one fork → Slack confirmation. Assert source preserved, actor/guidance audit, lineage, policy/approval inheritance, and duplicate Slack/web actions return existing fork.

- [ ] **Step 2: Run targeted acceptance suite**

Run the exact new caller test plus all files from Tasks 1–7. Expected: PASS, hermetic, no network/credentials.

- [ ] **Step 3: Update product docs and live canary contract**

Document user language and explicit limitations; add one live journey only under the existing credential gate. Never fabricate a live pass.

- [ ] **Step 4: Run static quality gates**

Run: `bun check && bun run lint`
Expected: both exit 0.

- [ ] **Step 5: Browser smoke actual surface**

Start the dev server through the process manager without creating a second Socket Mode connection. Use browser automation to redeem a hermetic token, verify plain-language sections/collapsed details/keyboard focus, submit guidance, observe continuation, and inspect requests for absence of `BOTTEGA_API_TOKEN`. If local credentials prevent boot, run the same server mount through its hermetic harness and report that exact scope.

- [ ] **Step 6: Full regression gate**

Run: `bun run test`
Expected: all suites exit 0. Also run `docker compose --profile executor config -q` when compose files are touched (otherwise record not applicable).

- [ ] **Step 7: Review clean cutover**

Search references for old retry copy and ensure all adapter doubles implement new methods; ensure no duplicate helper/router/session convention; verify no raw credentials in DB/logs/HTML; ensure audit/transcript retention unchanged.

- [ ] **Step 8: Land and close**

Commit remaining test/docs paths with `feat(work-review): completed plain-language continuation journey (#359)`. Then `git pull --rebase origin main` and `git push origin HEAD:main`. Watch main CI. Comment issue #359 with commits, targeted/full test evidence, browser evidence, canary scope, rollback, and close only after green.

## Self-review and acceptance mapping

- Slack exact actions and plain copy: Tasks 3 and 6.
- Authenticated actor-bound link and live membership: Tasks 2, 3, 6, 7.
- Plain review with collapsed technical activity and related context: Tasks 5 and 7.
- Continue with optional guidance, preserved source, policy/approval inheritance, Slack confirmation: Tasks 4, 7, 8.
- Duplicate first-wins behavior: Tasks 4, 7, 8.
- No browser bearer token; hashed credentials; CSRF; generic denial: Tasks 2 and 7.
- Caller-level hermetic evidence and actual surface smoke: Task 8.
- Migration/rollback/audit retention: Tasks 1, 2, 8.
- No placeholder, dependency, or signature gaps remain. Wave 1 tasks may run in parallel; Wave 2 tasks may run after their stated Wave 1 dependency; Waves 3–4 are ordered.
