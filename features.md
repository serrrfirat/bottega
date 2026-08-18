# Features

bottega is a coding agent that lives in your Slack workspace. You talk to it
in a channel like you would talk to a teammate; it turns that conversation
into real, tracked work — from a shared issue to a finished pull request —
and it remembers what it learns, follows your team's rules, and leaves an
audit trail for everything it does.

This document is the product view: what you, your team, and your agents can
do, and why it matters. For how it works under the hood, see
[architecture.md](architecture.md); for setup and development, see
[setup.md](setup.md).

## At a glance

| Capability | What you get |
| --- | --- |
| **Model settings** | See the provider catalog, pin a model and thinking effort per space or work item, and apply changes without a restart. |
| **Slack delivery** | Get an immediate receipt, live progress, tool steps, and a final reply on a path that degrades safely when Slack streaming is unavailable. |
| **Org settings** | Runtime configuration in the database, with approver-gated org writes and tighten-only space overlays. |
| **Memory** | The agent remembers facts per user or per org and uses them across conversations. |
| **Policy & approvals** | Every action is gated by rules you control; risky actions ask a human first. |
| **Extensions** | Discover, review, pin, and connect provider-official tools from chat; every agent uses them through one safe pipe. |
| **Proactive scheduler** | Standups, reflections, weekly pulse, knowledge ingestion, and recurring connected-service work on a schedule. |
| **Work items** | One queue delivers repository, connected-extension, or in-channel work, with optional model pins and semantic pickup. |
| **Department personas** | Give each space role guidance and a minimum visible toolset without weakening policy. |
| **Audit trail** | Every decision, approval, and tool call is recorded, append-only, and never deleted. |

## Model settings, catalog, and task pins (issues #64, #185, #189, #192, #194)

Every space can have its own model configuration, changed from chat — no
config files or server restart:

- **`model_settings`** reads or changes the space's model slots, persisted
  per space and audited. Its read result includes `available_models`,
  grouped by provider (#192), so the agent can answer provider-aware
  requests before changing anything. Slots are `model`,
  `reasoning_effort` (`off|low|medium|high`), `fast_model`, and
  `reasoning_model`; unset role slots fall back to `model`.
- **`use_model`** switches the live agent's role for the next turn:
  `default`, `fast` (low effort), or `reasoning` (the space's configured
  effort, default high). Natural language such as "use the fast model for
  this" maps to `use_model {role: "fast"}`. Every switch is audited.
- **Per-work-item pins** let `create_work_item` carry a model and/or
  `reasoning_effort` for that item only (#185). `fast` and `reasoning`
  select role slots; an exact id or friendly name resolves against the
  available deployment catalog. Unknown or ambiguous names fail before the
  item is created.
- **The NEAR catalog is live**: catalog construction probes the configured
  NEAR gateway's `/v1/models`, with a five-second bound, and merges those
  models with the declared catalog (#194). Explicit `provider/id` wins;
  for an unqualified best-match tie, the unique NEAR match wins.
- **Settings hot-swap at turn start** re-applies the current default role
  before each fresh turn (#189). A settings change therefore reaches an
  already-live space session; an explicit `use_model` override still wins
  for the turn it targets.

Both model tools are write-tier, so they prompt for approval in non-yolo
policy modes. Live switching and work-item pins use the OMP driver's
per-session hooks. ACP v1 has no model-switch message: it rejects unsupported
settings or narrowing instead of pretending to apply them (#173).

## Settings (issues #67, #150, #151, #190)

Runtime configuration lives in the database, not in agent-editable YAML.
The audited `settings` tool reads and changes the org blob and per-space
overlays from any space session.

- **Org knobs** include approval timeouts, `response_mode`, memory
  injection, extensions allow/deny + org credentials, repository allowlist,
  model defaults, workspaces dir, git/API base URLs, memory backend URL, and
  `secrets_backend`.
- **Org writes cross an approver gate** (#151). The synthetic exec-tier
  `settings_org_write` action uses the same Approve/Deny route as other
  privileged changes; without an approval channel it fails closed.
- **Space scope is bounded** (#150/#151). It can opt into
  `proactive.standup` / `proactive.reflection`; `response_mode` and
  extension restrictions can only tighten the org floor, and the overlay
  cannot add `always_approve` entries. Per-space model knobs remain in
  `model_settings`.
- **Secret resolution is pluggable** (#190). `omp-broker` is the default
  and owns OAuth refresh. An org can instead select
  `1password-connect` for static API keys/PATs, with a Connect URL and
  `"provider:identityKey" → {vault, item, field}` mappings in settings;
  only `OP_CONNECT_TOKEN` stays in the server environment.

Config files (`config.yml`, `config/org.yml`) remain the defaults, and the
database wins when a value is set. `models.yml` is a boot-time catalog
input/output, not an agent-editable settings store.

## Memory

Agents persist and recall facts with the `memory.save` / `memory.search`
tools (available in any space). Scope is per-user or org:
`memory.save {scope: "org", content: "our repos are acme/sandbox, acme/tooling"}`
is how the agent learns the repo names so it can answer "which repo?"
without asking. Org memory feeds work-item handoff (the agent derives the
repo for `create_work_item` from a mentioned repo or org memory) and the
connect intent seam.

Backend (issues #43, #67): the default (unset `memory_backend.base_url`)
runs the SQLite memory fallback. To use the self-hosted mem0 service, set
the knob (e.g. `http://mem0:8000` inside compose) via the `settings` tool
and give mem0 an LLM key (`OPENAI_API_KEY`, see [setup.md](setup.md)); the switch applies
on the next server start. `MEM0_API_KEY` stays an optional env secret for
mem0 auth.

## Durable objects (issue #124)

Slack file shares attach to the space as durable, content-addressed objects,
including PDF, XLS/XLSX, CSV, and image files. Agents list them with
`object.list` and read supported content with `object.get`. Agents can also
create derived text objects with `object.create`.

Text extraction supports `text/plain`, `text/csv`, `application/json`, and
`text/markdown`. PDF and XLS/XLSX objects are stored and attached, but
`object.get` returns an explicit unsupported-format error: binary content
extraction is executor-harness work (the tools image runs python3, sqlite3,
and CLIs over the shared data volume), not a server-side extractor.

## Slack replies stay visible and settle (issues #119, #120, #179, #180, #181, #184, #193)

An agent-bound message gets visible receipt work before attachment ingestion
or a cold session start: a rotating phrase, a 👀 reaction, and a redacted
`message.in` audit row (#119). The first reply or error removes pending
reactions and records reply and phrase latency.

- **DMs use the plain path** (#180): no thread and no streaming panel. The
  phrase is edited in place with the current tool step, latest thinking
  snippet, or elapsed `Thinking… Ns`, then replaced by the final reply
  (#193).
- **Channels use Slack streaming when the workspace supports it**: the
  opening phrase becomes a stream, gated tool calls become task steps, and
  the final answer closes the stream. The removed `agent_view` manifest
  feature no longer swallows DM messages (#184).
- **Streaming degrades once, then stays plain for the boot** (#181). A
  bounded startup probe and no-retry stream client prevent Slack SDK retry
  storms. Any stream failure switches to phrase + in-place edit; the e2e
  harness can declare streaming unsupported to exercise that exact path
  (#179).
- **Updates coalesce every 400 ms** and the latest text wins (#120). Turn
  end flushes immediately, with bounded final retries, so interim update
  failures do not drop the final answer.

## Policy & approvals (user-facing)

Every agent action is policy-gated; here is what that looks like from the
channel. The decision internals live in
[architecture.md](architecture.md#policy--approvals-internals).

- **Approve/Deny buttons** — when a policy says `ask-human`, the bot posts
  an interactive Approve/Deny prompt in the space channel (Slack block
  actions `bottega_approve` / `bottega_deny`, issue #44). Anyone in the
  channel can click in v1; the message is rewritten with the outcome.
  Timeout (`approvals.timeout_minutes`, default 5 min) denies and rewrites
  the prompt as expired.
- **Approvals that never prompt** — `approvals.always_approve` (org floor
  only, default off) lists exec-tier tools that skip the prompt when their
  policy action is `allow`; the space overlay can only remove entries,
  never add. Auto-approvals audit as `approver: "policy"`.
- **Org settings writes** use the same human route (#151). An org-scoped
  mutation cannot rely on the tool's ordinary write tier; it crosses the
  exec-tier `settings_org_write` gate and fails closed in headless contexts.
- **Headless contexts** (the executor) deny every ask-human request — no
  approval channel, fail closed.
- **Response mode** (`response_mode: always | mention | request-only`,
  default `always`, issue #55) controls when the space agent acts at all:
  `always` — every non-bot message is a turn; `mention` — only messages
  that @mention the bot (DMs always pass), so unmentioned channel chatter
  never reaches the agent; `request-only` — everything is forwarded
  (context stays coherent) but a system-prompt directive tells the agent
  to act only on explicit requests. The org floor sets it in `config.yml`;
  the space overlay may change it but can only tighten (`always` →
  `mention` → `request-only`).
- **Extension policy** (`extensions:`, issue #56) gates which extensions a
  space may use and whether org-scoped credentials may be used there:

  ```yaml
  extensions:
    allow: [linear, github]   # non-empty = only these ids are usable
    deny: [attio]             # never usable; deny wins over allow
    org_credentials: deny     # allow (default) | deny — org usage in auto scope
  ```

  `allow`/`deny` take registered extension ids; empty lists mean no
  restriction (the registry is the base allowlist). Unknown ids in either
  list are a structural error — the policy fails closed. The space overlay
  can only tighten: `allow` lists ids to *remove* from the org floor,
  `deny` lists ids to *add*, and `org_credentials` clamps like response
  mode (`allow` → `deny`, never back). Extension tool calls resolve
  against the allowlist **before** tier and approval logic — a denied
  extension is denied outright and never reaches credential resolution;
  `org_credentials: deny` makes the credential ladder's `auto` scope skip
  org credentials.

## Extensions & the registry

Extensions are typed, declarative integrations (issue #50): pinned
provenance + manifest/binding + credential schema + policy. `kind: "mcp"`
calls the provider's official MCP server; `kind: "cli"` shells out to a
preinstalled CLI in the tools image. bottega does not add provider API
clients.

- **GitHub uses its hosted MCP** (#145):
  `https://api.githubcopilot.com/mcp/`, streamable HTTP. The current
  reviewed snapshot declares an `api_key`/PAT credential; iron-proxy injects
  it as a bearer value. There is no local `github-mcp-server` binary.
- **Connect from chat** — exact `connect <extension>`,
  `connect <extension> as org`, or `connect <extension> as me` messages
  route directly to the connect capability (issue #61). Bare / `as me`
  connects the sender's personal account; `as org` crosses the Slack
  approval route. Other wording remains an ordinary agent turn.
- **API keys get a browser upload path** (#196).
  `connect_upload_link` is exec-tier and mints a 15-minute, single-use URL
  for an `api_key` extension. The browser form stores the value through the
  same connect path — org approval when needed → broker vault → credential
  metadata → audit — without returning it to Slack or the agent. Tokens are
  persisted in SQLite for cross-process use, capped per actor, consumed
  atomically, and POST attempts are rate-limited per client IP. OAuth
  extensions use their normal broker login and cannot mint an upload link.
- **Draft and pin from chat** — `catalog_browser` writes an unreviewed
  draft outside the registry, tells the agent to use `web_search` for the
  vendor's official binding (#146), and refuses to pin until a human
  confirms the completed summary in-channel (#195). Confirmation marks the
  snapshot reviewed, writes `config/extensions/<id>.json`, regenerates both
  egress configs, and audits the pin. Hosted streamable-HTTP + OAuth is
  preferred; stdio/CLI requires an explicit `no_hosted_variant: true`.
- **Tools can be pinned or discovered** — manifest `tools` is optional
  (#158). Present tools are the reviewed surface; absent MCP tools come from
  the provider's paginated `tools/list`. Generation namespaces model-facing
  names, preserves the provider's wire name, and assigns conservative tiers:
  confident reads → read, destructive operations → exec, everything else →
  write (#157).
- **Discovery is lazy and fail-closed** (#166/#167). A provider outage does
  not kill boot; that provider is skipped with evidence, then retried for a
  new session or call. Failed discoveries are never cached, unavailable
  surfaces never become an empty or partial allowlist, and successful
  surfaces are cached per binding.
- **Wire names stay separate from policy names** (#148). The agent, policy,
  and audit use the namespaced manifest name; the MCP call uses
  `providerName`, such as `search_issues`.
- **One call means one execution** (#178). The bridge resolves one effective
  tool, carries the principal bound to that turn (#152), and dispatches the
  provider wire call once through the runtime. Provider `isError` results
  stay errors instead of inviting a blind retry.
- **Agent-agnostic tools** — the bottega MCP server advertises
  `connect_extension` plus the effective extension surface to OMP, ACP, or
  future agents. Calls execute server-side through the same policy gate,
  credential ladder, egress boundary, and audit (#61/#172).
- **Curated CLI set** (issues #58, #62, #63) — `kind: "cli"` extensions run
  curated, preinstalled CLIs from the tools image (zero client code, no
  SDK): GitHub/ops `gh`, `jq`, `curl`, `git`, `glab`, `yq` (v4),
  `ripgrep`; Node toolchain `nodejs`, `npm`, `pnpm`, `yarn` (the base
  image ships only a bun `node` shim with no npm, so the real toolchain is
  installed); Python `python3`, `pip`, `uv`; build `build-essential`
  (gcc/make) and `golang`; DB clients `sqlite3`, `postgresql-client`;
  cloud `aws` (v2). Distro packages come from Debian trixie, installed
  non-interactively; aws and yq are pinned downloads from their official
  releases (Debian's yq is stuck at 2019-era v3). NO credentials are baked
  in, ever.
- **Heavy/optional layer (NOT default)** — `Dockerfile.tools-heavy` stacks
  the Rust toolchain (rustup, minimal profile), `kubectl`, `helm`, and
  `gcloud` (+ GKE auth plugin) on the curated image. Nothing builds it by
  default; build it explicitly where an org needs it:

  ```bash
  docker build -f Dockerfile.tools -t bottega-tools:latest .
  docker build -f Dockerfile.tools-heavy -t bottega-tools-heavy:latest .
  ```

  gRPC-heavy CLIs (gcloud, kubectl) run for non-authenticated operations
  only — credentialed gRPC calls are not supported (documented limitation).
- **Per-org CLI extensions** — an org that needs a CLI outside the curated
  set extends the image itself, never the default: append to
  `Dockerfile.tools` in the org's fork (keeping the curated baseline
  intact), or mount a local layer at deploy time (a one-line
  `FROM bottega-tools:latest` image with the org's packages, or a volume
  with static binaries). The curated set stays the baseline by design.

Registry internals (snapshots, discovery, runtime wiring, credentials, and
the CLI spawn path) are in
[architecture.md](architecture.md#extension-runtime-the-safety-spine).

Production snapshots currently describe Attio, GitHub, and Linear. The
test-only fixture proves registration, tool surfacing, execution, and merged
egress domains end to end.

## Co-worker work delivery (epic #122)

The work queue now supports coding and non-code operations through one
audited lifecycle:

- **Delivery-neutral work items (#128)** — `create_work_item` accepts `git`,
  `extension`, or `chat` delivery. Git remains the default. Executable items
  are claimed before chat items, and each delivery kind has a typed result
  contract.
- **Extension-delivered work (#129)** — the executor runs extension items in
  a headless worker session with memory and the space's connected tools.
  Pickup approval authorizes the run; extension policy, credentials, and
  egress still fail closed. A valid external URL and summary complete the
  item. Failures move it to `blocked` with evidence.
- **Delivery approval completes the git loop** (#149). After opening a PR,
  the executor writes a durable `work_item.delivery_pending` marker and
  waits. The server posts an interactive prompt; the first human decision
  is recorded through the audit trail. Approval moves `working → review →
  done`; denial blocks the item with evidence. Restarts neither lose nor
  double-post the decision.
- **Semantic pickup is opt-in and confirmable** (#89).
  `work_items.auto_pickup` adds guidance for actionable messages, with a
  `high|medium|low` confidence threshold. High-confidence requests draft a
  work item; lower-confidence requests ask first. Nothing silently creates
  work, and the default is off.
- **Model + effort pins travel with the item** (#185). The resolved model
  and effort are persisted, applied when the worker session starts, and
  audited; they override space settings only for that execution.
- **Spaces persist on first contact** (#188). The Slack session path
  idempotently creates the space row without overwriting existing policy or
  settings, so first-message model/settings writes have a durable target.
- **Department personas (#130)** — each space can select a persona through
  `spaces.policy_json`. Prompt fragments and tool floors come from
  `config/personas/<id>.md` and `<id>.tools.yml`. Unknown or incomplete
  personas fall back to `default`; the policy gate can still deny every
  surfaced tool.
- **Recurring non-code jobs (#131)** — the scheduler's `recurring_work`
  action creates one extension-delivery item per fire. Scheduled work uses
  the same queue, audits, policy gates, stale recovery, and blocked failure
  state as manually requested work.

Why it matters: a team can ask one co-worker to ship code, update a connected
system, answer in channel, or repeat operational work without adding a second
execution path.

## Containerized execution direction (epic #170)

The direction is explicit: the server remains the conversation and
orchestration process; risky or credentialed work belongs in workers.

| Status | Boundary |
| --- | --- |
| **Shipped** | The executor is a separate container/process; git and extension deliveries run as headless worker sessions. Pickup approval, the complete delivery seam (#149), shared runtime wiring (#172), proxy injection, and audit-backed state transitions are in place. |
| **Planned** | Move every remaining risky/credentialed job kind behind the worker boundary and give jobs container-level isolation. The durable outbox needed for reliable cross-process dispatch is tracked in #187. |

This is architecture direction, not a claim that every job already has its
own container. The current executor is shared, and `chat` delivery still has
no worker.

## Proactive scheduler, learning, and knowledge base (epic #111)

The agent doesn't only react — it can work on a schedule, on its own, when
a space opts in.

- **Durable UTC scheduler (#86)** — three policy-gated tools create, list,
  and delete recurring five-field cron jobs. Jobs survive restarts, never
  overlap scheduler passes, and record created, deleted, fired, missed, and
  failed events in the audit trail. The boot policy skips missed runs
  instead of replaying a backlog.
- **Standup digest (#92)** — an opted-in space can post a weekday summary
  of work finished yesterday, work still open, and blocked items. Each
  digest includes item details and pull-request links, saves an org-memory
  digest, and keeps the existing per-space digest cap.
- **Daily reflection (#93)** — an opted-in space derives deterministic
  facts from that day's work items and audit events. It saves append-only
  org memories for finished work, blockers, errors, and activity. It does
  not call a model.
- **Settings-backed proactive opt-in (#150)** — standup and reflection read
  `spaces.policy_json` as JSON and enable only exact boolean `true` values.
  Malformed or missing values stay disabled. The space-scoped `settings`
  surface writes the same `proactive` shape, so chat configuration and the
  scheduler read one representation.
- **Org pulse observer (#90)** — a weekly, read-only action summarizes the
  last seven days of digest and reflection memories into a configured Slack
  pulse space. The post cites memory ids and dates, and every observer read
  is audited.
- **Knowledge-base ingestion (#91)** — `config/kb.yml` declares document
  sources, and the `kb_ingest` tool fetches, chunks, and saves them as
  append-only org memories. Ingestion is deterministic and model-free.
  Source hosts remain subject to both the static egress allowlist and the
  egress judge.

Why it matters: your team gets a daily digest and a learning loop without
anyone running reports — and the facts the agent learns stay in org memory
for the whole workspace.

## Data protection & egress

What happens when the agent talks to the outside world, and how your data
is protected on the way out:

- **Default-deny egress** — all outbound traffic from the stack goes
  through iron-proxy, a sidecar that is the *only* path out of the
  container network. Only allowlisted domains are reachable at all, every
  allowlisted request is judged by a policy LLM ("deny unless clearly
  required by the task and safe"), and DNS is sinkholed so nothing leaks
  around the proxy.
- **Credentials attach only at the egress boundary** — model providers send
  `bottega-proxy-placeholder`; iron-proxy replaces it from provider-specific
  mode-0600 files and refuses missing files. API-key extensions use the same
  boundary. Active OAuth extension snapshots use iron-proxy's native token
  transform, which refreshes, caches, single-flight deduplicates, and injects
  short-lived access tokens. The vault remains the source of truth; provider
  env fallbacks are cleared after boot synchronization. Agent env,
  transcripts, and audit receive identifiers or placeholders, never the
  retained live value.
- **Obvious pasted credentials are refused at typed write boundaries**
  (#121/#196). `connect_extension` rejects recognized credential shapes
  before policy, broker, registry, or audit work and directs the agent to
  OAuth, the configured vault, or `connect_upload_link`. `memory.save`
  applies the same narrow family of checks before durable storage.
- **Local dev is the same topology, dev-permissive (issues #123, #126)** —
  `bun run dev` brings up iron-proxy and reloads the egress config before
  the server boots. The dev proxy runs the generated DEV config
  (`config/egress.dev.yml`: allow-all allowlist `"*"` + no judge), so
  testing passes for web search, GitHub, Slack, and model endpoints alike;
  the strict `config/egress.yml` retains default-deny + the LLM judge.
  Static-secret and OAuth-token transforms are identical in both configs.

**Dev vs deployment (issue #126):** the strict config's judge rules denied
the server's own model calls (a context-free LLM denies bare model/API
requests) and Slack domains weren't allowlisted at all, which broke the bot
under the dev proxy. Instead of loosening the deployment contract, local dev
now loads the permissive dev config: allow-all + no judge, with the secrets
transform (extension credential injection) and the management block kept.
The #125/#126 temporary `NO_PROXY` bypass in `scripts/dev.sh` is reverted —
the dev proxy passes everything, so routing platform + model traffic through
it is harmless and injection stays on every proxied extension call. The full
compose topology still routes everything through the strict proxy; this
permissiveness is dev-only (`config/egress.dev.yml` is mounted only by
docker-compose.dev.yml).

## Live-Slack QA canary (issues #79 + #175)

The product-surface smoke test: it boots the REAL stack (production Socket
Mode adapter + the real model via the deployment catalog,
`config/omp/models.yml`) against a real Slack workspace and drives journeys
AS a QA user — real messages in, real bot replies out, with per-journey
pass/fail and Slack permalinks.

```bash
bun run canary --live-slack            # local/QA run (or LIVE_SLACK=1)
bun run canary --live-slack --ci       # CI-strict (the scheduled workflow)
```

Journeys: chat reply (DM + the `bottega-qa` channel, created when missing),
memory save/search, work-item creation, the connect intent seam, scheduled
standup, extension call through the real runtime spine, model role switch,
and the delivery approval round-trip (#149). Each journey starts at the
human-visible surface and asserts durable store/audit evidence rather than
only a helper result.

Skip-gated locally (issue #79): without `--live-slack`/`LIVE_SLACK=1`, in
ad-hoc CI, or with missing tokens it prints a clear skip message and exits
0. CI-strict (`--ci`/`CANARY_CI=1`, the scheduled workflow): missing
tokens or model key FAIL the job — a canary that silently skips in CI is
worse than none. Generous per-journey timeouts (120s+; the standup waits
for the minute boundary) — it waits for a real model and a real workspace.

### Scheduled in CI + the release gate (issue #175)

`.github/workflows/canary.yml` runs the canary weekly (Monday 06:00 UTC;
`workflow_dispatch` for manual runs) against the dedicated QA workspace
with repository secrets:

| Secret | Required | Notes |
| --- | --- | --- |
| `SLACK_APP_TOKEN` | yes | Socket Mode app token (xapp) |
| `SLACK_BOT_TOKEN` | yes | bot user token (xoxb) |
| `SLACK_QA_USER_TOKEN` | yes | QA user token (xoxp) |
| `SLACK_QA_USER_ID` | no | skips the users.list name lookup |
| `SLACK_QA_CHANNEL` | no | defaults to `bottega-qa` |
| `NEAR_API_KEY` | one of | the model key (preferred — the NEAR gateway accepts the agent's dotted tool names, issue #71) |
| `CANARY_MODEL_REF` | one of | overrides the model ref entirely |

On failure the workflow posts the per-journey report + permalinks + the
Actions run URL to the QA channel itself, and the CI status fails.

**The scheduled canary is a release gate, not a merge gate** (live infra
can flake): a red scheduled run blocks the next deploy until a human
triages it. **One journey per major feature, added as features land** —
when a feature ships, it gets a canary journey in the priority order above.
Both policies live in AGENTS.md → "Scheduled live-Slack canary (issue
#175)".

### QA user + tokens

1. **Create the test user** — in your workspace admin, add a member named
   `bottega-qa` (any name works; the canary looks it up by
   `SLACK_QA_USER_NAME`, default `bottega-qa`, or take `SLACK_QA_USER_ID`
   to skip the lookup). This is the "human at the product surface": the
   canary posts as them, so their messages are indistinguishable from a
   real user's.
2. **Install the app** (`slack-app-manifest.yml` already declares the bot
  scopes + the QA user scopes below) and install it to the workspace, so
   the bot and the test user share it.
3. **User-scoped token for the QA user** — create the app's user token
   with the user's OAuth grant:
   <https://api.slack.com/apps> → your app → **OAuth & Permissions** →
   the user scopes must include `chat:write`, `im:history`, `im:write`,
   `channels:history`, `channels:read`, `users:read` (the manifest
   declares them) → **Install App** with the QA user's workspace session,
   or **Add to Slack** while signed in as the QA user → copy the
   **User OAuth Token** (`xoxp-...`). It is `SLACK_QA_USER_TOKEN`.
4. **Bot + app tokens** — already needed for the server:
   `SLACK_BOT_TOKEN` (`xoxb-...`) and `SLACK_APP_TOKEN` (`xapp-...`).
   The canary additionally uses the bot's `channels:manage` +
   `channels:read` + `users:read` scopes to create/locate `bottega-qa`
   and look up the QA user (declared in the manifest).
5. **Keychain install** (macOS; env vars win when set):

   ```bash
   security add-generic-password -s bottega-slack-app -a "$(whoami)" -w '<xapp-...>'
   security add-generic-password -s bottega-slack-bot -a "$(whoami)" -w '<xoxb-...>'
   security add-generic-password -s bottega-slack-qa  -a "$(whoami)" -w '<xoxp-...>'
   ```

The canary reads env first (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`,
`SLACK_QA_USER_TOKEN`, optional `SLACK_QA_USER_ID` / `SLACK_QA_USER_NAME` /
`SLACK_QA_CHANNEL`), then the Keychain services `bottega-slack-app`,
`bottega-slack-bot`, `bottega-slack-qa`.

The live leg also needs the real model to answer: `bun run canary` (the
issue #71 dispatcher) loads `NEAR_API_KEY` / `OPENCODE_API_KEY` from env or
the Keychain (`bottega-near` / `bottega-opencode`, the `scripts/dev.sh`
pattern) and the harness installs the deployment model catalog
(`config/omp/models.yml`). **Prefer the NEAR key** — the NEAR gateway
accepts the space agent's dotted tool names (`memory.save`,
`memory.search`); the opencode-go gateway rejects them and journeys fail
loudly on it (live finding, issue #71). `CANARY_MODEL_REF` overrides the
model ref entirely. The QA user must have opened a DM with the bot once (or
the canary opens it via `conversations.open`).

## Known limitations (v1)

- **Approver identity is not role-based yet** — anyone in the channel can
  approve a policy or delivery prompt. The first durable decision wins;
  explicit approver roles and SSO remain roadmap.
- **Allowlisted repos only** — the executor works in the repository named
  by the conversation and refuses anything outside the settings allowlist.
  One executor container serves multiple items; per-item container
  isolation is part of epic #170, not shipped.
- **Chat delivery has no worker yet** — executable `git` and `extension`
  items are claimed first; `chat` items remain open instead of entering a
  fake execution path.
- **The upload endpoint is loopback-only today** — the #196 in-process
  browser form binds `127.0.0.1` and returns that local URL. A remote Slack
  participant needs deployment routing to that endpoint; no public ingress
  is shipped. Tokens are consumed before the vault write, so a failed broker
  upload burns the link and the user must mint another. The paste guard
  covers credential-shaped values passed to `connect_extension` (and
  `memory.save`), not arbitrary text already sent as a Slack message.
- **Slack only** — the org pulse observer ships on Slack. Telegram, Teams,
  and Meet remain roadmap (issue #13 tracks Telegram).
- **No Slack `agent_view`** — it is deliberately absent from
  `slack-app-manifest.yml` because it swallowed DM visibility (#184).
  DMs always use a normal top-level bot message. Supported channel
  workspaces may still use `chat.startStream`; unsupported or failed
  streams use the normal phrase + edit path (#180/#181).
- **No mid-session model switches on ACP** — OMP supports `use_model`; ACP
  v1 reports model settings/switching it cannot honor, and rejects
  `allowTools` narrowing (#173).
- **No automatic model router** — semantic pickup can derive an explicitly
  requested model/effort pin, but there is no model-based complexity
  classifier. The agent or human chooses a role/model.
- **No PDF/XLSX binary extraction in `object.get`** — these objects store
  and attach normally; binary extraction belongs in the executor harness,
  not a server-side parser.

## Roadmap

- Containerized execution for all risky/credentialed job kinds, plus the
  durable outbox (#187) and per-job isolation — epic #170.
- Telegram adapter (grammY, long polling) — #13.
- Roles (explicit approvers) and SSO.
- A second non-OMP engine through the already-wired ACP driver.
