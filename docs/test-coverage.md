# Test coverage audit (issue #28)

Ground truth for the hermetic-testing epic (#27): every module in `src/`
mapped to the tier it reaches today (unit → hermetic → integration → e2e,
definitions in `AGENTS.md` → "Test tiers"), the test files that provide the
evidence, the gaps, and the next tier action. Audit only — backfill work is
tracked in the follow-up issue (#29).

Current verification on 2026-08-17 (`epic #122` co-worker integration):

- `bun check` — clean.
- `bun test` — 861 passed, 4 skipped, 0 failed across 67 files.
- Skip-gated legs: the mem0 Docker integration and real iron-proxy
  integration skipped because `BOTTEGA_RUN_INTEGRATION=1` was not set.
  The real-`omp` ACP permission probe also logged its documented
  environment skip because the local ACP turn failed; its hermetic fake-ACP
  coverage passed.

## Module table

| Module | Tier today | Test file(s) | Gaps | Recommended next action |
|---|---|---|---|---|
| `server/adapters/slack.ts` | unit + hermetic | `slack.test.ts`, `slack-emulator.test.ts` | Pure helpers fully unit-tested (space-id mapping, bot predicate, normalize, postMessage args). Outbound Web API proven against the `@emulators/slack` HTTP emulator (postMessage text/thread_ts, auth.test). **Inbound Socket Mode is untested**: `start()` and the `app.event("message")` → `onMessage` wiring are never exercised — the emulator cannot emulate Socket Mode, so inbound coverage stops at the `normalizeMessage` pure function. Bolt `App` construction is only shape-tested. | Hermetic inbound: scripted Socket-Mode WSS server (local `Bun.serve` WebSocket) driving the real Bolt socket client, asserting bot-message drop + `onMessage` delivery; real-workspace delivery stays manual checklist (already documented in the test header). |
| `server/personas.ts`, `server/services/space-service.ts` | hermetic | `personas.test.ts`, `services/persona-space-service.test.ts`, `services/space-service.test.ts` | Session lifecycle remains fully covered against injected fakes. Persona tests cover default and selected prompt/tool-floor loading, malformed/unknown/incomplete fallback, additive Slack directives, and real-store `spaces.policy_json` selection. The persona tool floor is visibility-only; policy-gate behavior has separate coverage. | Live model behavior under each persona remains manual; loading and session wiring are at tier. |
| `server/drivers/agent-driver.ts` | unit (partial) | `space-service.test.ts` (only `sessionFilePath`), `smoke.test.ts` (shape only) | **No test file.** `createOmpSdkDriver` / `OmpSessionDriver` — the default production driver for BOTH the server and the executor — have zero direct tests: no real-SDK session create/prompt/dispose, no transcript cold-restore, no `SPACE_AGENT_TOOLS` assertion. All coverage is via FakeDriver implementations elsewhere. Highest-risk untested module. | Hermetic test with the real SDK + temp agent dir (no network, no prompt — mirror the real-`omp` ACP pattern): createSession → session file set → dispose, plus allowlist constant test. |
| `server/drivers/acp-driver.ts` | hermetic + integration (skip-gated) | `drivers/acp-driver.test.ts`, `drivers/fixtures/fake-acp-server.ts` | Strongest driver coverage: scripted fake ACP server (real child process, real stdio JSON-RPC) for happy stream, cancel, crash, noisy tolerance, dispose, handshake timeout, spawn failure, SpaceService end-to-end. Permission seam (issue #26): allow/deny/ask-human mapping, unknown → deny, MCP xdev tool naming, space overlay, no-context method-not-found, all with audit assertions. Skip-gated real-`omp` legs run the handshake **and** one bash permission round-trip (audit proves the decision; skips when omp auto-approves). | Real-`omp` permission leg depends on the model actually calling a permissioned tool; a deterministic trigger (e.g. a permissioned-only agent config) would remove the skip branch. |
| `server/services/delivery-poller.ts` | hermetic | `delivery-poller.test.ts` | Announce-once dedupe via audit trail, multi-item, malformed-marker skip, failed-post retry, immediate first pass, `stop()`, failure resilience, 5s interval contract — all covered. Uses FakeStore/FakeAdapter although real hermetic doubles exist (temp SQLite store, emulator-backed adapter). | Re-run the dedupe/restart tests against the real store (append-only rows) — the highest-value fake removal. |
| `server/index.ts` | unit (wiring) + integration (CI) | `smoke.test.ts`, `secrets/agent-dir.test.ts`, CI `docker` job | `main()` wiring + stop shape-tested with fake tokens; boot creates `data/omp-agent`; fail-closed boot without tokens is proven only in the CI Docker job (real image, non-zero exit + message). Full `start()` (adapter + poller) is never awaited in a test. | A hermetic boot test that actually starts the server with fake tokens and asserts no crash (adapter start would fail without a socket — needs the Socket-Mode stub from the slack gap). |
| `policy/config.ts` | unit + hermetic | `policy.test.ts` | Decision table exhaustively matrixed (tier × action × known), unknown-tools-always-deny, tier resolution per tool, org YAML parse (valid / malformed-entry / structural fail-closed / empty default / fallback), `loadOrgConfig` against temp dirs, overlay tighten-only / invalid / unparseable deny-all / empty / pickup.auto, `memory.injection` parse + defaults + cap + overlay-immutable (#42). | No action — at tier. |
| `policy/extension.ts` | hermetic | `policy.test.ts` | Gate wiring against **real** SQLite store + `createAudit`: allow/deny/unknown/structural-deny, approval via router (approved, DenyRouter, timeout, router failure), preApproved session semantics, per-space overlay, missing-session-file fallback. Approval `request` path only ever sees DenyRouter — the Slack-backed router is a later issue. | No action beyond the future Slack router (#6 follow-up) which will need its own hermetic test. |
| `policy/approval-router.ts` | unit | `policy.test.ts` | `DenyRouter` covered through extension wiring (headless exec-tier blocks). Trivial seam otherwise. | No action. |
| `policy/audit.ts` | hermetic | `audit.test.ts` | Redaction cases (Slack tokens, `sk-`, AKIA, github_pat, Bearer, key:value), append round-trip + filters, string payloads, redaction-on-write, payload cap truncate/whole, **append-only enforced via raw UPDATE/DELETE → ABORT** on real SQLite. | Minor: exact cap boundary and multi-byte truncation edge are not asserted (cap loop slices UTF-16 code units). |
| `store/db.ts` | hermetic | `db.test.ts` | Best-covered module: spaces, delivery-neutral work-item lifecycles, **concurrent claim race across two connections**, executable-before-chat claim ordering, complete legal/illegal transition matrix, delivery-specific done obligations (`pr_url`/`url`/`summary`), extension direct completion, stale recovery, per-transition auditing, append-only audit triggers, and delivery-column migration backfill/idempotency. | No action — at tier. |
| `scheduler/{types,cron,store,runner,actions,scheduler-tools}.ts` | unit + hermetic | `scheduler/cron.test.ts`, `scheduler/store.test.ts`, `scheduler/runner.test.ts` | Five-field UTC cron parsing, durable SQLite round-trips, action registry, policy tiers, tool create/delete audits, first-tick missed-run handling, success/error/timeout firing, non-overlapping loop, and start/stop are covered. | No action — at tier for the deterministic scheduler core. |
| `scheduler/{proactive-config,standup,reflection,observer,recurring-work}.ts` | hermetic | `scheduler/proactive-config.test.ts`, `scheduler/standup.test.ts`, `scheduler/reflection.test.ts`, `scheduler/observer.test.ts`, `scheduler/recurring-work.test.ts` | Real temp SQLite stores plus fake posting/memory seams cover opt-in fail-closed behavior, response-mode suppression, UTC windows, digest/reflection writes and audits, observer reads, and failure containment. Recurring work proves one extension item per fire, queue-owned creation audit, validation, and creation-failure audit. | Keep real scheduled Slack posts and live extension delivery manual and credential-gated. |
| `kb/{config,ingest}.ts`, `tools/kb-tools.ts` | hermetic | `kb/config.test.ts`, `kb/ingest.test.ts`, `tools/kb-tools.test.ts` | Strict source config, deterministic HTML/text chunking, byte/time limits, local `Bun.serve` fetches, append-only org-memory writes, write audits, all/source selection, and policy tier are covered without live network access. | Live source reachability through iron-proxy stays in the skip-gated proxy leg and deployment checklist. |
| `extensions/credentials.ts` | unit + hermetic | `credentials.test.ts` | Resolution ladder (issue #51) exhaustively branch-tested: org (resolve, missing → "connect <ext> as an organization", never falls back to personal), me (resolve, missing → "connect your <ext> account", owner isolation — someone else's personal row never returned, never falls back to org), auto (org-wins-when-policy-allows, fallback to personal when not allowed / org missing, ask with policy-aware reason when nothing available — never guesses), broker account-pool mapping seam (`accountPoolFor`), audit wrapper against the **real** store (`extension.credential_resolved` rows carry actor + credential id + broker credential id). | No action — at tier. Runtime broker-pool wiring (writing the pool file for the resolved account) is tracked as #53's job. |
| `tools/work-items.ts` | hermetic | `work-items.test.ts` | Registration, delivery schema (`git`/`extension`/`chat`), default and explicit delivery persistence, git-only repo derivation, cross-delivery issue evidence, create validation, and cancel authorization/terminal-state behavior — all against the **real** store. | No action. |
| `tools/memory-context.ts` | hermetic | `memory-context.test.ts` | Injection extension (#42): prepended developer message, org + user (session principal) scoping, latest-user-text query, entry + byte budget caps, dedupe by content, no re-injection per turn (agent_start reset + in-conversation marker), disabled no-op, blank/no-hit skips, `renderInjection` edges. | No action — at tier. The real-model leg is manual/opt-in by design (hermetic contract is the fake-provider handler). |
| `tools/memory.ts` | hermetic | `memory.test.ts` | Registration + tiers, save (org, user principal, default fallback, missing-principal error, empty content, provider failure), search (passthrough, org w/o principal, query/limit validation), hash-only audit rows (content never stored). Provider is a FakeProvider while the real SQLite provider is a hermetic double. | Swap the fake for `createSqliteMemoryProvider` in at least one save/search test. |
| `memory/types.ts` | unit (indirect) | `conformance.test.ts`, `sqlite.test.ts`, `mem0.test.ts` | Validators (`validateSaveInput`/`validateSearchQuery`) exercised through every provider suite (scope, principal, empty content, limit 1..20). No dedicated test file. | No action — indirect coverage is complete; a direct validator file is optional. |
| `memory/sqlite.ts` | hermetic | `sqlite.test.ts`, `conformance.test.ts` | Full conformance suite + specifics: LIKE escaping, metadata exact multi-key filter, created_at ordering, two providers on one file, migration idempotency, store-handle integration, empty-query-with-metadata marker lookup, `pruneDigestMemories` cap (#42). | No action. |
| `memory/mem0.ts` | hermetic + integration (skip-gated) | `mem0.test.ts`, `conformance.test.ts` | `Bun.serve` stub covering wire contract: scope→agent_id/user_id mapping, default org agent id, search top_k + filters, identity-key stripping, X-API-Key presence/absence, non-2xx, **real AbortController timeout**, empty results, createdAt fallback, missing baseUrl; conformance against the stub. Skip-gated Docker leg runs the real OSS server — observed SKIP with evidence (no LLM key; documented manual checklist). | The real-server leg is the only proof of wire compatibility; needs an LLM/embedder key to pass (by design). Keep the gate; optionally add a response-shape mutation matrix. |
| `memory/conformance.test.ts` | test infra | run by `sqlite.test.ts` + `mem0.test.ts` | Shared suite: org round-trip, org sharing, principal isolation, principal requirement, limit cap, metadata exact filter, no delete/update surface. | No action — the pattern (external backends run it against wire stubs) is correct. |
| `executor.ts` | hermetic | `executor.test.ts`, `smoke.test.ts`, CI `docker` job | Real SQLite + real local git + GitHub emulator cover git delivery through PR completion. Fake-driver extension tests cover worker tool exposure, valid `{url,summary}` completion/audit, malformed output, timeout/abort, session errors, denied and unknown extension calls, blocked evidence, and chat handoff without starvation. Credential hygiene, stale recovery, approval denial, and fail-closed boot remain covered. | Live connected-extension delivery and the real model session remain manual; the real `createOmpSdkDriver` behavior has its separate driver suite. |
| `egress/yaml-subset.ts` | unit (indirect) | all structural tests consuming it (`deploy.test.ts`, `egress/*`, `secrets/*`) | Test-only YAML-subset parser; exercised only through the fixtures it parses, no dedicated tests of its own edge cases (rejections, literal blocks, sequences). | Low priority (test infra): a small direct test file for the parser's rejection/acceptance rules. |
| `egress/` config (compose topology + `config/egress.yml`) | unit (structural) + integration (skip-gated) | `egress/compose.test.ts`, `egress/egress-config.test.ts`, `egress/proxy-env.test.ts`, `egress/iron-proxy.test.ts` | Compose topology (services, pinned iron-proxy 0.49.0 image, static IP, no public ports, DNS via proxy, HTTP_PROXY/NO_PROXY wiring, subnet, data volume) and iron-proxy config (sections, default-deny DNS, TLS CA mount, allowlist incl. cloud-api.near.ai (live gateway, #36), judge deny-unless gate, timeout/circuit-breaker, prompt) are statically asserted. `proxy-env.test.ts` hermetically proves Bun honors HTTP_PROXY/HTTPS_PROXY/NO_PROXY (fresh child processes, local servers). Skip-gated Docker legs (`iron-proxy.test.ts`, `BOTTEGA_RUN_INTEGRATION=1`) boot the real pinned image and prove against the binary: default-deny allowlist (allowlisted host passes, non-allowlisted → 403), DNS sinkhole, dev allow-all + injection (#126), and the #53 secrets chain — mode-0600 secret file written by the real boundary, `POST /v1/reload` with the management token, injected `Authorization` header on allowlisted-only (#177). The image tag is read from docker-compose.yml (version-bump tripwire). | Closed: real-binary enforcement proven by the skip-gated legs; the CI integration lane treats any leg SKIP as a failure. Judge LLM round-trip stays a documented manual checklist (needs `NEARAI_JUDGE_API_KEY`). |
| `secrets/` (compose credential boundary, config/omp templates, `.env.example`, agent-dir wiring) | unit (structural) + hermetic | `secrets/compose.test.ts`, `secrets/config-templates.test.ts`, `secrets/agent-dir.test.ts` | Credential boundary (no public ports, broker vault bootstrap + healthcheck gating, gateway ordering, env placeholders, no keys/tokens/PATs in env, template mounts, broker bootstrap behavioral (fake omp: 0600 token, idempotent, exec semantics)), OMP templates (obfuscation enabled, no approvalMode, secrets.yml placeholders, models.yml NEAR.ai), `.env.example` covers every env var referenced by code with no real-looking credentials. `agent-dir.test.ts` proves boot creates `data/omp-agent` — but includes a **source-grep assertion** (`indexSrc.toContain("agentDir: OMP_AGENT_DIR")`), which `AGENTS.md` prohibits. | Replace the source-grep assertion with a behavioral check (driver option seam) or document the deviation. Optionally a skip-gated leg booting the real auth-broker image to exchange a token. |
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
2. **Egress enforcement against the real binary (closed by #29 + #177).** Config and
   topology are statically asserted and Bun's proxy-env behavior is proven,
   and the skip-gated Docker legs (`src/egress/iron-proxy.test.ts`) now boot
   the pinned `ironsh/iron-proxy:0.49.0` image to prove default-deny
   allowlist + DNS sinkhole + dev allow-all + the #53 secrets/reload
   injection chain against the actual binary. The judge LLM round-trip
   remains a documented manual checklist (needs `NEARAI_JUDGE_API_KEY`).
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
