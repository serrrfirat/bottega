# AGENTS.md — bottega agent contract

Canonical rules for agents working in this repository. Read before changing
anything; when in doubt, the README and the GitHub issues (epic #1, sub-issues)
are the spec.

## Global conventions (curated from OMP / pi / Ironclaw / Hermes AGENTS.md)

Rules accepted across those codebases, adapted to bottega's scale. Where a
rule below conflicts with a rule above, the user's explicit instructions win
(pi's override rule: ask when they conflict).

### Code quality
- **No `any`** unless absolutely necessary. No inline/dynamic imports —
  top-level imports only.
- **No duplicate helpers.** Search existing modules and adjacent code before
  writing a utility; two implementations of the same thing is a bug even when
  both work. Extend the existing helper; don't fork it.
- **No speculative infrastructure.** Hooks, callbacks, or abstractions need a
  real consumer. Adding a hook is easy; removing one after code depends on it
  is hard.
- **Prefer off-the-shelf software over rolling your own** as much as possible. Before hand-writing protocol or infrastructure logic (e.g. OAuth/PKCE/DCR/refresh), check the official `@modelcontextprotocol/sdk` client-auth layer (`OAuthClientProvider`, `selectClientAuthMethod`, `registerClient`, `refreshAuthorization`, RFC 8414/9728 discovery) — it is already a pinned dependency — and implement its seams instead of bespoke code. No new dependency without a stated reason in the commit.
- **Prompts live in files, not code** (static `.md`, `include_str!`-style)
  when we ship model-visible copy beyond a single line.
- **`.env` is for secrets only**; behavioral settings go in config files
  (`config.yml`, `spaces.policy_json`), not new env vars.
- **Never hardcode a configurable default** (keys, timeouts, thresholds) in
  logic; put it in config with a documented default.
- **Read files in full before wide-ranging changes**; never edit a file you
  haven't inspected.
- **Ask before removing functionality** that appears intentional.
- Dependency and lockfile changes are reviewed code; pin exact versions.

### Git & workflow
- **Issue-first** (user-mandated): every change starts with a GitHub issue;
  reference it in the commit (`#N`); close with a completion comment.
- Commit style: `<type>(scope): <past-tense description>` — no emojis, no
  fluff. `fixes #N` / `closes #N` in messages when a PR flow is ever used.
- Stage explicit paths; never `git add -A` when other agents share the repo.
- **Never force push or rewrite shared history.**
- Rebase conflicts: resolve only in files you modified; abort and ask on
  foreign conflicts.

### Testing
- **Test the contract, not internals.** Every test defends one externally
  observable behavior; if you can't name the failure mode a consumer would
  see, don't add the test.
- No placeholder/tautology tests (`expect(true)`), no success-passthrough
  asserts, no **source-grep tests** (asserting on file text — assert behavior).
- Never `mock.module()` (leaks across files); use `spyOn` / injected fakes
  (we already inject fake drivers/adapters).
- Tests must be full-suite safe, not file-local safe.
- **Behavior contracts over snapshots** — assert invariants and transitions,
  not frozen literals (model lists, counts).
- **E2E over mocks at boundaries** (Hermes/Ironclaw): exercise the real path
  with real imports where resolution chains, security boundaries, or I/O are
  involved — that's what the emulate.dev tests are for.
- Test through the caller, not the helper: a policy gate is covered by driving
  the extension wiring, not only the pure decision function.
- **Definition of done: issue acceptance criteria land as caller-level
  tests** (user-mandated, 2026-08-17, issue #174). A PR that closes a
  feature issue must include the issue's acceptance criteria as tests at the
  caller surface — inbound message / tool call / scheduler fire in,
  observable effect out — in the highest hermetic tier that can express
  them. Caller surface means driving `SpaceService.handleInboundMessage`,
  the tool definition's `execute`, the scheduler tick, or the executor claim
  loop — not the new private helper. Patterns to reuse:
  `src/server/boot-wiring.test.ts` (real `main()` in a temp cwd),
  `src/server/onboarding-boot.test.ts` (same shape, #116),
  `src/executor.test.ts` (real store + real git + GitHub emulator).
  Criteria that genuinely need live infra (real Slack, real model) are never
  silently skipped: they land as a skip-gated leg (`BOTTEGA_RUN_INTEGRATION=1`)
  or a named canary journey, and the PR says which. Reviewer checklist line:
  **does a test fail if the feature's headline flow breaks?** — the #149
  question (unit tests around the delivery loop all passed while nothing
  drove a work item to `done` through the real pipeline; `review`/`done`
  shipped unreachable). Enforcement is review, not tooling.
- **Frontend changes to Slack/Teams: hermetic gate, real client after
  merge** (issue #299): UI changes to the Slack or Teams channel must ship a
  hermetic caller-level behavior test and pass applicable static checks
  before they land on `main`. An authenticated real-client or scheduled
  nightly browser validation happens after landing, not before it. Locally,
  drive the authenticated real Slack/Teams app (Computer Use or the harness
  browser); in CI, run Playwright against an authenticated dedicated test
  identity/profile. API calls, payload/log inspection, emulator/unit tests,
  and mock-HTML screenshots never count as a visual pass. If the real-client
  check fails, file or follow an issue and fix it; if real-client access is
  unavailable, that does not block pushing.
- **Chat-discovered bugs ship a hermetic regression test** (user-mandated,
  2026-08-17): a fix for a bug found in conversation must include a test that
  reproduces the exact failure (e.g. an unwired seam defaulting to a wrong
  actor) and FAILS on the old code — the regression test is part of the fix,
  not an option.

### Error handling & security
- **No silent failures**: propagate with context (`throw new Error(...)` with
  the cause in the message; never `catch` + swallow).
- **Fail closed**: unknown tool → deny; policy parse error → deny; missing
  config → deny; missing tokens → refuse to boot.
- Never weaken auth, allowlists, approval gates, redaction, or audit
  immutability to make something work.
- **LLM/agent data is never deleted** — transcripts and audit rows are
  retained; "cleanup" evicts caches, never rows.
- Untrusted until a typed boundary establishes otherwise (that's the
  adapters' job).
- Side-effecting success requires durable evidence (obligations + audit).

### Change discipline
- Keep changes scoped; verify the premise before "fixing" something —
  reproduce on current `main`, point at the exact line, fix the whole bug
  class including sibling call paths.
- When an interface changes, enumerate ALL implementations (AgentDriver has
  one: OMP SDK, plus test doubles) and their callers.
- After moves/renames, grep for old paths in code, docs, and config.
- Update the README/contracts when behavior changes; PR/commit must describe
  every layer touched and note rollback risk.

### Agent-specific (Hermes, applies to our space agent)
- Don't rebuild the space agent's system prompt or swap toolsets
  mid-conversation — it invalidates prompt caching and multiplies cost.
- Capability grows at the edges: prefer extending existing tools/config over
  new core surface.

## Workflow (user-mandated)

1. **Every piece of work starts with a GitHub issue.** Before implementing,
   create or update an issue on `serrrfirat/bottega` so humans can follow
   along. Reference the issue in the commit message (`#N`) and close it with a
   completion comment when the work ships.
2. **Issues found during chat are dispatched immediately.** When a bug or
   problem surfaces in conversation (not from a plan), create the issue AND
   start a task subagent in its own worktree to fix it right away — the main
   agent does not fix chat-discovered issues itself. The fix must include a
   hermetic regression test that reproduces the failure (see Testing).
3. **Ship to `main` directly** — no PRs (tried, user changed the workflow).
   Push with `git push origin <branch>:main` after `git pull --rebase origin
   main` (retry rebase up to 3x on rejection).
4. **Isolated worktrees** when multiple agents run: work ONLY in your assigned
   `.worktrees/<topic>`; never touch the main checkout or sibling worktrees.
5. Never rewrite shared history.
6. **Dev server stays up while work is in progress.** Start `bun run dev`
   through the harness process manager with a readiness check (`bottega boot:
   model registry ready`) before implementing, and keep it running across the
   session (restart on crash). If it refuses to boot (fail-closed guards:
   Slack tokens missing from server `.env` — boot throws; provider keys
   missing from the macOS Keychain), state the blocker explicitly and finish
   all work that does not need it live. Only ONE server per `SLACK_APP_TOKEN`
   may run — a second Socket Mode connection with the same token breaks
   message delivery (events drop, the bot goes silent). Before starting,
   check for an existing server (`pgrep -fl "src/server/index.ts"`); restart
   the existing one instead of starting a second.
7. **The main agent NEVER implements — no exceptions.** All changes — code,
   config, scripts, docs, hotfixes — are implemented by task agents given
   complete, self-contained instructions (targets, change steps, acceptance).
   The main agent handles only coordination (issues, todos, process
   management such as server restarts) and reviews agent output before it
   lands.

## Build, test, verify

```bash
bun install          # Bun 1.3+; lockfile frozen in CI
bun check            # tsc --noEmit — must exit 0
bun run test         # 1600+ tests across 107 files — must exit 0 (e2e/journey files run serial before the parallel unit group so harness stub windows hold, issue #260)
scripts/smoke.sh     # local checks + compose validation + manual checklist
docker compose --profile executor config -q   # compose validity (CI does this)
```

- **TDD-first**: write the failing test before the implementation. Tests use
  `bun:test`; hermetic by default (real SQLite OK; no live LLM, Slack, or
  GitHub).

### Test tiers (user-mandated): unit → hermetic → integration → e2e

Every feature ships the highest tier reachable *hermetically*; the ladder is
used whenever possible:

1. **Unit** — pure functions, no I/O: policy decision table, normalization
   helpers, validators, state-machine rules.
2. **Hermetic** — real code paths against local doubles: real SQLite temp
   DBs, `Bun.serve` stubs, scripted fake servers, emulate.dev emulators.
   NO external network, NO live services, NO real credentials. **This is the
   default target for every feature.**
3. **Integration** — real services in Docker (mem0 OSS server, iron-proxy):
   skip-gated with evidence when the service can't run (missing key/image);
   hard timeouts; never hang CI.
4. **E2E** — full compose stack with real flows; real-credential legs (live
   Slack/GitHub/LLM) stay a documented manual checklist, never fabricated as
   passing.

A test that passes alone but needs the network, a key, or a live service to
pass is NOT hermetic — move it to integration with a skip gate, or make the
double local.
- **Integration tests** use the emulate.dev emulators (`@emulators/github`,
  `@emulators/slack` — see `src/executor.test.ts` for the pattern) — never
  real external services.
- Real-infra verification (live Slack app, real PAT/PR round-trip, live
  provider keys) is a **manual checklist** in `setup.md` / `scripts/smoke.sh`.
  Never report it as passing without running it.

## Scheduled live-Slack canary (issue #175)

`.github/workflows/canary.yml` runs the live-Slack canary
(`tests/e2e/canary.ts`, issue #79) weekly against the dedicated QA
workspace — real Socket Mode, real model, real Slack — with repository
secrets (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_QA_USER_TOKEN`,
`NEAR_API_KEY`/`CANARY_MODEL_REF`; see features.md → "Live-Slack QA
canary" for the full list). It runs CI-strict (`--ci`): missing
credentials FAIL the job instead of skipping — a canary that silently
skips in CI is worse than none. On failure it posts the per-journey report
+ permalinks + the run URL to the QA channel.

- **Release gate, not a merge gate.** The scheduled canary is live infra
  and can flake, so it never gates merges; a red scheduled run BLOCKS the
  next deploy until a human triages it (the QA channel post + the CI
  status are the notification). Fix the regression or explicitly waive the
  run before deploying.
- **One journey per major feature, as features land.** When a shipped
  feature lands, it gets a canary journey (chat reply, memory, work-item,
  connect intent, scheduled standup, extension call, model role switch;
  delivery approval once #149 lands). A journey asserts the human-visible
  round-trip with deterministic store/audit evidence, never a fabricated
  pass. Missing tokens locally → skip-and-exit-0 stays correct; in CI →
  fail.
- Never run the live leg in ad-hoc CI without `--ci` (it stays skip-gated
  there); never report a live journey as passing without running it.

## Code discipline

- **Ponytail**: minimal code, no speculative abstractions, no unused config,
  no scaffolding for later. Fewest files possible.
- **No new dependencies** without a reason stated in the commit.
- **Commit style**: `<type>(scope): <past-tense description>` (e.g.
  `feat(store): added atomic claim`), with the issue number when one exists.
- The agent is pluggable: SpaceService and the executor depend only on
  `AgentDriver` (`src/server/drivers/agent-driver.ts`). Never hardwire agent logic to
  OMP; add drivers, don't branch on them.

## Security invariants (never weaken)

- Fail closed everywhere: unknown tool → deny; policy parse error → deny;
  missing tokens → refuse to boot.
- **Policy footgun: `always_approve` ≠ allow.** A tool must be listed under
  `tools:` (action `allow`) BEFORE it can auto-approve; `always_approve` only
  skips the ask-human prompt for tools whose action is already `allow`.
  Unlisted tools fall back to `unknownAction` (deny). When adding a tool: add
  it to `tools:` AND (if exec-tier) to `approvals.always_approve` — verify
  with the loader, not by eye:
  `bun -e 'import {loadOrgConfig,decidePolicyCall} from "./src/policy/config.ts"; const p=loadOrgConfig(); console.log(decidePolicyCall(p,"create_work_item"))'`
  (expect `{decision:"allow", reason:"auto-approved by policy (approvals.always_approve)", autoApproved:true}`).
- No credentials in code, env, image, or tests: provider keys via the
  auth-broker vault, Slack tokens only in server `.env`, the git PAT only in a
  mode-0600 file on the data volume.
- Audit is append-only (triggers reject UPDATE/DELETE); transcripts are never
  deleted.
- All outbound traffic goes through iron-proxy (default-deny allowlist + DNS
  sinkhole) — never bypass it.

## Specs and source of truth

- GitHub issues are the spec (epic #1 = architecture + decisions; sub-issues
  = scoped work). Do not silently change scope: update the issue first.
- Docs map: README = product front door; features.md = capabilities +
  limitations; architecture.md = internals; setup.md = development,
  deployment, and operations.
- `config/omp/`, `config/egress.yml`, `docker-compose.yml`, `.env.example` are
  deployment contract; keep them in sync with code.
