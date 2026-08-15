# AGENTS.md — bottega agent contract

Canonical rules for agents working in this repository. Read before changing
anything; when in doubt, the README and the GitHub issues (epic #1, sub-issues)
are the spec.

## Workflow (user-mandated)

1. **Every piece of work starts with a GitHub issue.** Before implementing,
   create or update an issue on `serrrfirat/bottega` so humans can follow
   along. Reference the issue in the commit message (`#N`) and close it with a
   completion comment when the work ships.
2. **Ship to `main` directly** — no PRs (tried, user changed the workflow).
   Push with `git push origin <branch>:main` after `git pull --rebase origin
   main` (retry rebase up to 3x on rejection).
3. **Isolated worktrees** when multiple agents run: work ONLY in your assigned
   `.worktrees/<topic>`; never touch the main checkout or sibling worktrees.
4. Never rewrite shared history.

## Build, test, verify

```bash
bun install          # Bun 1.3+; lockfile frozen in CI
bun check            # tsc --noEmit — must exit 0
bun test             # 165+ tests — must exit 0
scripts/smoke.sh     # local checks + compose validation + manual checklist
docker compose --profile executor config -q   # compose validity (CI does this)
```

- **TDD-first**: write the failing test before the implementation. Tests use
  `bun:test`; hermetic by default (real SQLite OK; no live LLM, Slack, or
  GitHub).
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
  `AgentDriver` (`src/server/agent-driver.ts`). Never hardwire agent logic to
  OMP; add drivers, don't branch on them.

## Security invariants (never weaken)

- Fail closed everywhere: unknown tool → deny; policy parse error → deny;
  missing tokens → refuse to boot.
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
