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
  two: OMP SDK + ACP) and test doubles.
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
   agent does not fix chat-discovered issues itself.
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
   all work that does not need it live.
7. **Implementation is delegated to task agents.** Any code change ships via
   a task subagent given complete, self-contained instructions (targets,
   change steps, acceptance); the main agent handles tracking (issues, todos)
   and reviews the agent's output before it lands. The main agent does not
   implement directly.

## Build, test, verify

```bash
bun install          # Bun 1.3+; lockfile frozen in CI
bun check            # tsc --noEmit — must exit 0
bun test             # 490+ tests across 36 files — must exit 0
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
   DBs, `Bun.serve` stubs, scripted fake ACP servers, emulate.dev emulators.
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
  provider keys) is a **manual checklist** in the README / `scripts/smoke.sh`.
  Never report it as passing without running it.

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
- README = architecture + deployment + known limitations.
- `config/omp/`, `config/egress.yml`, `docker-compose.yml`, `.env.example` are
  deployment contract; keep them in sync with code.
