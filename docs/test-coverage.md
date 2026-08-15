# Test coverage audit (issue #28)

Ground truth for the hermetic-testing epic (#27): every module in `src/`
mapped to the tier it reaches today (unit → hermetic → integration → e2e,
definitions in `AGENTS.md` → "Test tiers"), the test files that provide the
evidence, the gaps, and the next tier action. Audit only — backfill work is
tracked in the follow-up issue (#29).

Baseline verified on 2026-08-16 (`feat/28-audit`, before any changes):

- `bun check` — clean.
- `bun test` — 214 tests across 22 files, 0 failures.
- Skip-gated legs observed: the mem0 Docker leg **skipped with evidence**
  (container boots, then crashes: `openai.OpenAIError: The api_key client
  option must be set…` — needs an LLM/embedder key, exactly the documented
  gate); the real-`omp acp` handshake leg **ran and passed** (local `omp`
  binary present).

## Module table

| Module | Tier today | Test file(s) | Gaps | Recommended next action |
|---|---|---|---|---|
| `server/adapters/slack.ts` | unit + hermetic | `slack.test.ts`, `slack-emulator.test.ts` | Pure helpers fully unit-tested (space-id mapping, bot predicate, normalize, postMessage args). Outbound Web API proven against the `@emulators/slack` HTTP emulator (postMessage text/thread_ts, auth.test). **Inbound Socket Mode is untested**: `start()` and the `app.event("message")` → `onMessage` wiring are never exercised — the emulator cannot emulate Socket Mode, so inbound coverage stops at the `normalizeMessage` pure function. Bolt `App` construction is only shape-tested. | Hermetic inbound: scripted Socket-Mode WSS server (local `Bun.serve` WebSocket) driving the real Bolt socket client, asserting bot-message drop + `onMessage` delivery; real-workspace delivery stays manual checklist (already documented in the test header). |
| `server/services/space-service.ts` | hermetic | `space-service.test.ts` | Session lifecycle fully covered against injected fakes: lazy cold start, per-space sessions, steering vs prompt, idle-timeout dispose, transcript file per space, mid-dispose drop + audit, stop disposes all, failure containment, output threading, abort routing. Store/adapter are fakes (fine — both have their own suites); driver is the right seam. `abortTurn` only tested direct, `modelConfig` reserved-unused. | No action — at tier for its contract. Optionally drive one lifecycle test through the real SQLite store to kill the last fake. |
| `server/drivers/agent-driver.ts` | unit (partial) | `space-service.test.ts` (only `sessionFilePath`), `smoke.test.ts` (shape only) | **No test file.** `createOmpSdkDriver` / `OmpSessionDriver` — the default production driver for BOTH the server and the executor — have zero direct tests: no real-SDK session create/prompt/dispose, no transcript cold-restore, no `SPACE_AGENT_TOOLS` assertion. All coverage is via FakeDriver implementations elsewhere. Highest-risk untested module. | Hermetic test with the real SDK + temp agent dir (no network, no prompt — mirror the real-`omp` ACP pattern): createSession → session file set → dispose, plus allowlist constant test. |
| `server/drivers/acp-driver.ts` | hermetic + integration (skip-gated) | `drivers/acp-driver.test.ts`, `drivers/fixtures/fake-acp-server.ts` | Strongest driver coverage: scripted fake ACP server (real child process, real stdio JSON-RPC) for happy stream, cancel, crash, noisy tolerance, dispose, handshake timeout, spawn failure, SpaceService end-to-end. Skip-gated real-`omp` leg runs the actual handshake (passed locally; **never sends a prompt** by design). | Optionally extend the real-`omp` leg to one `session/prompt` round-trip against a no-model config — currently only the handshake is proven against the real binary. |
| `server/services/delivery-poller.ts` | hermetic | `delivery-poller.test.ts` | Announce-once dedupe via audit trail, multi-item, malformed-marker skip, failed-post retry, immediate first pass, `stop()`, failure resilience, 5s interval contract — all covered. Uses FakeStore/FakeAdapter although real hermetic doubles exist (temp SQLite store, emulator-backed adapter). | Re-run the dedupe/restart tests against the real store (append-only rows) — the highest-value fake removal. |
| `server/index.ts` | unit (wiring) + integration (CI) | `smoke.test.ts`, `secrets/agent-dir.test.ts`, CI `docker` job | `main()` wiring + stop shape-tested with fake tokens; boot creates `data/omp-agent`; fail-closed boot without tokens is proven only in the CI Docker job (real image, non-zero exit + message). Full `start()` (adapter + poller) is never awaited in a test. | A hermetic boot test that actually starts the server with fake tokens and asserts no crash (adapter start would fail without a socket — needs the Socket-Mode stub from the slack gap). |
| `policy/config.ts` | unit + hermetic | `policy.test.ts` | Decision table exhaustively matrixed (tier × action × known), unknown-tools-always-deny, tier resolution per tool, org YAML parse (valid / malformed-entry / structural fail-closed / empty default / fallback), `loadOrgConfig` against temp dirs, overlay tighten-only / invalid / unparseable deny-all / empty / pickup.auto. | No action — at tier. |
| `policy/extension.ts` | hermetic | `policy.test.ts` | Gate wiring against **real** SQLite store + `createAudit`: allow/deny/unknown/structural-deny, approval via router (approved, DenyRouter, timeout, router failure), preApproved session semantics, per-space overlay, missing-session-file fallback. Approval `request` path only ever sees DenyRouter — the Slack-backed router is a later issue. | No action beyond the future Slack router (#6 follow-up) which will need its own hermetic test. |
| `policy/approval-router.ts` | unit | `policy.test.ts` | `DenyRouter` covered through extension wiring (headless exec-tier blocks). Trivial seam otherwise. | No action. |
| `policy/audit.ts` | hermetic | `audit.test.ts` | Redaction cases (Slack tokens, `sk-`, AKIA, github_pat, Bearer, key:value), append round-trip + filters, string payloads, redaction-on-write, payload cap truncate/whole, **append-only enforced via raw UPDATE/DELETE → ABORT** on real SQLite. | Minor: exact cap boundary and multi-byte truncation edge are not asserted (cap loop slices UTF-16 code units). |
| `store/db.ts` | hermetic | `db.test.ts` | Best-covered module: spaces, work-item full lifecycle, **concurrent claim race across two connections**, complete legal/illegal transition matrix, obligations (done→pr_url, blocked→evidence, review→approval), stale recovery + its audit rows, per-transition auditing, audit immutability triggers, migration idempotency across connections. | No action — at tier. |
| `tools/work-items.ts` | hermetic | `work-items.test.ts` | Registration, create (requester default/override, no-space fail, empty description), cancel (requester, non-requester denied, policy approvers allowed, unknown id / terminal states) — all against the **real** store. | No action. |
| `tools/memory.ts` | hermetic | `memory.test.ts` | Registration + tiers, save (org, user principal, default fallback, missing-principal error, empty content, provider failure), search (passthrough, org w/o principal, query/limit validation), hash-only audit rows (content never stored). Provider is a FakeProvider while the real SQLite provider is a hermetic double. | Swap the fake for `createSqliteMemoryProvider` in at least one save/search test. |
| `memory/types.ts` | unit (indirect) | `conformance.test.ts`, `sqlite.test.ts`, `mem0.test.ts` | Validators (`validateSaveInput`/`validateSearchQuery`) exercised through every provider suite (scope, principal, empty content, limit 1..20). No dedicated test file. | No action — indirect coverage is complete; a direct validator file is optional. |
| `memory/sqlite.ts` | hermetic | `sqlite.test.ts`, `conformance.test.ts` | Full conformance suite + specifics: LIKE escaping, metadata exact multi-key filter, created_at ordering, two providers on one file, migration idempotency, store-handle integration. | No action. |
| `memory/mem0.ts` | hermetic + integration (skip-gated) | `mem0.test.ts`, `conformance.test.ts` | `Bun.serve` stub covering wire contract: scope→agent_id/user_id mapping, default org agent id, search top_k + filters, identity-key stripping, X-API-Key presence/absence, non-2xx, **real AbortController timeout**, empty results, createdAt fallback, missing baseUrl; conformance against the stub. Skip-gated Docker leg runs the real OSS server — observed SKIP with evidence (no LLM key; documented manual checklist). | The real-server leg is the only proof of wire compatibility; needs an LLM/embedder key to pass (by design). Keep the gate; optionally add a response-shape mutation matrix. |
| `memory/conformance.test.ts` | test infra | run by `sqlite.test.ts` + `mem0.test.ts` | Shared suite: org round-trip, org sharing, principal isolation, principal requirement, limit cap, metadata exact filter, no delete/update surface. | No action — the pattern (external backends run it against wire stubs) is correct. |
| `executor.ts` | hermetic | `executor.test.ts`, `smoke.test.ts`, CI `docker` job | Excellent hermetic coverage with **real** SQLite + **real git** against a local bare repo + GitHub emulator: full claim loop to `done` with pr_url, session failure → blocked + workspace kept, denied approval → blocked, boot stale recovery, credential hygiene (PAT in 0600 file only, askpass, env never carries the key). Fail-closed boot without PAT proven in CI Docker job. Agent engine is FakeDriver (right call). | Same root gap as agent-driver: real `createOmpSdkDriver` path inside `runExecutor` never exercised — covers once the agent-driver hermetic test exists. Real github.com round-trip stays manual checklist. |
| `egress/yaml-subset.ts` | unit (indirect) | all structural tests consuming it (`deploy.test.ts`, `egress/*`, `secrets/*`) | Test-only YAML-subset parser; exercised only through the fixtures it parses, no dedicated tests of its own edge cases (rejections, literal blocks, sequences). | Low priority (test infra): a small direct test file for the parser's rejection/acceptance rules. |
| `egress/` config (compose topology + `config/egress.yml`) | unit (structural) | `egress/compose.test.ts`, `egress/egress-config.test.ts`, `egress/proxy-env.test.ts` | Compose topology (services, pinned iron-proxy 0.49.0 image, static IP, no public ports, DNS via proxy, HTTP_PROXY/NO_PROXY wiring, subnet, data volume) and iron-proxy config (sections, default-deny DNS, TLS CA mount, allowlist incl. NEAR.ai, judge deny-unless gate, timeout/circuit-breaker, prompt) are statically asserted. `proxy-env.test.ts` hermetically proves Bun honors HTTP_PROXY/HTTPS_PROXY/NO_PROXY (fresh child processes, local servers). **No integration leg runs the real iron-proxy container** — default-deny enforcement is never proven against the actual binary. | Highest-value integration gap: skip-gated Docker leg that boots `ironsh/iron-proxy:0.49.0` (already pinned), asserts a non-allowlisted request is sunkholed/403 and an allowlisted one passes. |
| `secrets/` (compose credential boundary, config/omp templates, `.env.example`, agent-dir wiring) | unit (structural) + hermetic | `secrets/compose.test.ts`, `secrets/config-templates.test.ts`, `secrets/agent-dir.test.ts` | Credential boundary (no public ports, broker vault bootstrap + healthcheck gating, gateway ordering, env placeholders, no keys/tokens/PATs in env, template mounts, broker script execs omp), OMP templates (obfuscation enabled, no approvalMode, secrets.yml placeholders, models.yml NEAR.ai), `.env.example` covers every env var referenced by code with no real-looking credentials. `agent-dir.test.ts` proves boot creates `data/omp-agent` — but includes a **source-grep assertion** (`indexSrc.toContain("agentDir: OMP_AGENT_DIR")`), which `AGENTS.md` prohibits. | Replace the source-grep assertion with a behavioral check (driver option seam) or document the deviation. Optionally a skip-gated leg booting the real auth-broker image to exchange a token. |
| deploy packaging (`docker-compose.yml`, `slack-app-manifest.yml`, `Dockerfile`, `.dockerignore`) | unit (structural) + integration (CI) | `deploy.test.ts`, CI `docker` job | Compose build wiring + pinned tag, restart policies, PAT volume path, manifest (Socket Mode, scopes, event subscriptions), Dockerfile/.dockerignore, smoke.sh structure. CI builds the real image and proves fail-closed boots (server without tokens, executor without PAT). | No action; compose `config -q` validation runs in CI + smoke script. |
| `scripts/dev.sh` | none | — | Keychain loader (`security find-generic-password`) never exercised by a test. Dev-only, low risk. | Optional: shell-level test for the env/Keychain branches. |
| `scripts/smoke.sh` | unit (structural) + manual | `deploy.test.ts` | Structure asserted (typecheck, test, compose validity, manual checklist presence). The manual checklist itself (live Slack, real GitHub PR, compose up/down persistence) is documented, not automated. | No action — real-credential legs are manual by design (AGENTS.md). |
| Automated e2e (full compose stack) | **absent** | — | No test spins the whole compose stack. Every cross-service flow beyond the executor test harness (real Slack inbound, real LLM session, approval button round-trip) is manual-checklist only. | By design today (AGENTS.md: real-credential legs stay a documented manual checklist). Revisit when the approval-router button path lands. |

## Ranked gap list (by risk)

1. **`server/drivers/agent-driver.ts` — the default production driver is untested.** Both
   entrypoints construct `createOmpSdkDriver`; every test substitutes a fake.
   Session lifecycle, transcript restore after restart, and the tool allowlist
   have no direct coverage. Hermetic test with the real SDK and a temp agent
   dir is feasible today (no network needed) — this is #29's first item.
2. **Egress enforcement is never tested against real iron-proxy.** Config and
   topology are statically asserted and Bun's proxy-env behavior is proven,
   but nothing proves the default-deny allowlist + DNS sinkhole actually
   enforce in the pinned `ironsh/iron-proxy:0.49.0` image. Skip-gated Docker
   leg (this is the issue's own example of a missing integration leg).
3. **Slack inbound (Socket Mode) has zero hermetic coverage.** The emulator
   covers outbound only; `start()` and event routing are untested. Requires a
   local scripted Socket-Mode WSS server or a real-workspace e2e.
4. **mem0 real-server leg depends on an LLM key** — observed skipping with
   evidence (container crash without `OPENAI_API_KEY`). Acceptable and
   documented, but it is the only path proving wire compatibility with the
   real server.
5. **Fakes where real hermetic doubles exist:** delivery-poller
   (FakeStore/FakeAdapter vs real SQLite + emulator), tools/memory
   (FakeProvider vs real SQLite provider). Cheap to upgrade.
6. **`secrets/agent-dir.test.ts` contains a source-grep assertion**, violating
   the AGENTS.md no-source-grep rule; replace with a behavioral seam.
7. **`memory/audit` payload-cap edges** (exact boundary, multi-byte
   truncation) untested — minor.
8. **`scripts/dev.sh` untested** (Keychain loader) — dev-only, low risk.
9. **No automated e2e** — full-compose flows are a documented manual checklist
   by design; revisit when the approval button round-trip lands.

## Not verified / honestly flagged

- Whether the mem0 Docker leg passes with an LLM key configured — skipped in
  this environment (evidence captured in the run output).
- Real Slack workspace delivery, real GitHub PR round-trip, real LLM
  sessions, and compose up/down persistence — manual checklist only
  (`scripts/smoke.sh` steps 1–7); never reported as passing.
- Exact branch-level coverage percentages were not computed (no coverage
  tooling configured); tiers are inferred from test files read in full.

## Backfill status (issue #29)

Every ranked gap above resolved or explicitly deferred, verified on
2026-08-16 after the backfill commits (214 baseline → 257 tests, 0 failures
across two consecutive full-suite runs; the count includes the sibling MCP
surface work that landed on main during backfill):

| # | Gap | Resolution | Evidence |
|---|---|---|---|
| 1 | `agent-driver.ts` untested | New `src/server/drivers/agent-driver.test.ts`: real-SDK session create → transcript file materialized at the exact session-file path → dispose; restart resumes the same file (no reset); `agentDir` honored (sessions materialize `agent.db` in the passed dir — the seam that keeps boots reading `config/omp` templates instead of `~/.omp/agent`); `allowTools` override accepted; `SPACE_AGENT_TOOLS` exported and asserted (read-only + task + queue/memory tools, never `write`/`bash`/`edit`). | 5 tests, hermetic (temp dirs, no network, no prompt, no credentials). |
| 2 | iron-proxy never run | New `src/egress/iron-proxy.test.ts`: skip-gated Docker leg boots `ironsh/iron-proxy:0.49.0` with a config whose allowlist domains are read from `config/egress.yml` (judge transform omitted — needs `NEARAI_JUDGE_API_KEY`, documented manual checklist). Asserts allowlisted host reachable through the proxy (local `Bun.serve` target via `--add-host`), non-allowlisted host → 403, and DNS sinkhole answers every name with `proxy_ip` (queried from an `alpine:3.19` helper container — host-side UDP into containers is unreliable on Docker Desktop). Hard timeout (240s), skips with evidence when Docker/image unavailable. Ran and passed locally against the real image. | 1 test, 4 assertions; skip messages name the manual checklist. |
| 3 | Slack inbound untested | Bolt's `App.processEvent` routes events without a socket; the message wiring is now the exported `registerMessageHandler` (production code, installed by `createSlackAdapter`). New tests drive the real Bolt router hermetically: user message delivered normalized, thread reply shares the channel space, bot-authored and unparseable events dropped and logged. Custom `authorize` stub avoids Bolt's network auth.test. | 4 tests in `src/server/adapters/slack.test.ts`. |
| 4 | mem0 real-server leg | Kept as-is with its gate: it is the only wire-compatibility proof and by design needs an LLM/embedder key (observed skip with evidence in the audit baseline; `OPENAI_API_KEY` manual checklist documented in the skip message). | skip-gated leg in `src/memory/mem0.test.ts`. |
| 5 | Fakes where real doubles exist | delivery-poller: new real-store leg (temp SQLite `createStore`, marker written via `store.appendAudit`, dedupe proven across a reopened connection — restart never double-posts against real append-only rows). tools/memory: new real-provider leg (`createSqliteMemoryProvider`): save+search round-trip persists, audit rows carry only the content hash, principal isolation holds through SQLite. | 1 new test each in `delivery-poller.test.ts`, `memory.test.ts`. |
| 6 | Source-grep in `secrets/agent-dir.test.ts` | Removed `readFileSync`/`toContain` on `index.ts`. The contract is now behavioral across two seams: `main()` creates `data/omp-agent` at boot, and the driver test proves sessions honor the passed `agentDir`. | `agent-dir.test.ts` + `agent-driver.test.ts`. |
| 7 | Audit payload-cap edges | New tests: payload exactly at `MAX_PAYLOAD_BYTES` stored whole; one byte over truncates to exactly cap with the marker; multi-byte (emoji) payloads truncate on a character boundary — no lone surrogates or replacement chars survive, final size ≤ cap. | 2 tests in `policy/audit.test.ts`. |
| 8 | `scripts/dev.sh` untested | Deferred (documented, not blocked): dev-only Keychain loader, audit-marked optional/low-risk; no shell test infra exists in the repo. The Keychain path stays a manual dev workflow. | — |
| 9 | No automated e2e | By design (AGENTS.md: real-credential legs stay a documented manual checklist). Compose-based smoke legs are tracked separately in issue #30. | — |

Additional table items closed: `yaml-subset` now has direct
rejection/acceptance tests in the shared `src/yaml-subset.test.ts` (extended
to 11 tests during backfill; the parser itself was promoted out of
`src/egress/` by the #33 consolidation that landed mid-flight).

Not backfilled (documented, by design or optional per the table): full
`start()` await in `server/index.ts` (needs a Socket-Mode receiver stub; the
inbound path it would exercise is now covered via `processEvent`, and boot
wiring via `smoke.test.ts` + `agent-dir.test.ts`); real-`omp` ACP prompt
round-trip (existing leg intentionally never prompts); direct
`memory/types.ts` validator file (indirect coverage complete);
SpaceService-via-real-store lifecycle (optional per the table).
