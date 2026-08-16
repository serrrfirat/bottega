# Features

User-facing capabilities of bottega: what people and agents can do in a
space. For how it works under the hood, see [architecture.md](architecture.md);
for setup and development, see [README.md](README.md).

## Model settings & model roles

The space agent's model is configurable from chat (issue #64) — no config
files, no restarts:

- **`model_settings`** reads/writes the space's model settings, persisted
  per space in the `spaces.settings` column (SQLite) and audited
  (`model.settings_changed`). Slots: `model` (the space's default),
  `reasoning_effort` (`off|low|medium|high`), `fast_model`,
  `reasoning_model`. All slots are optional; unset slots fall back to
  `model` at role-resolution time.
- **`use_model`** switches the agent's model **role for the next turn**:
  `default` (the space `model` at the space's default effort), `fast` (the
  `fast_model` — or `model` — at low effort; simple tasks), `reasoning`
  (the `reasoning_model` — or `model` — at `reasoning_effort`, default
  high; hard tasks). Natural language like "use the fast model for this"
  maps to `use_model {role: "fast"}`. Every switch is audited
  (`model.switched`).

Both are write-tier, so they prompt for approval in non-yolo policy modes,
and they sit on the space-agent allowlist like the memory tools. The OMP
driver implements the switch through the SDK's per-session model hooks
(`setModel` + `setThinkingLevel`, session-only — the space's settings
column is the persistence home, never the agent dir). The ACP driver does
not support mid-session switches: ACP v1 has no model-switch message and
the spawned agent's own config governs there — `use_model` reports this
back as a clear error instead of pretending. Auto-routing by task
complexity is explicitly v2: v1 is the agent *deciding* per task via
`use_model`.

## Settings (issue #67)

Runtime configuration lives in the DB, not in agent-editable YAML: the
`settings` tool (write-tier, audited `settings.changed`) reads and changes
the org blob and per-space overlays from any space session. Org knobs:
approval timeouts, `response_mode`, memory injection, extensions
allow/deny + org_credentials, repo allowlist, model defaults
(default/fast/reasoning + effort), workspaces dir, git/api base URLs, and
the memory backend URL. Space scope covers the policy overlay knobs
(`response_mode`, extensions tighten-only); per-space model knobs live in
the `model_settings` tool (issue #64). Config files (`config.yml`,
`config/org.yml`) remain the defaults — the DB wins when set.

`models.yml` is a boot-time output (issue #67): at startup the server
regenerates the agent-dir catalog from the settings blob's model ids; when
settings carry none, the committed `config/omp/models.yml` template stays
the default. The DB is the single source of truth — no agent-editable
model YAML.

## Memory

Agents persist and recall facts with the `memory.save` / `memory.search`
tools (available in any space). Scope is per-user or org:
`memory.save {scope: "org", content: "our repos are acme/sandbox, acme/tooling"}`
is how the agent learns the repo names so it can answer "which repo?"
without asking. Org memory feeds work-item handoff (the agent derives the
repo for `create_work_item` from a mentioned repo or org memory) and the
connect intent seam.

Backend (issues #43, #67): unset `memory_backend.base_url` (the default)
runs the SQLite memory fallback. To use the self-hosted mem0 service, set
the knob (e.g. `http://mem0:8000` inside compose) via the `settings` tool
and give mem0 an LLM key (`OPENAI_API_KEY`, see README); the switch applies
on the next server start. `MEM0_API_KEY` stays an optional env secret for
mem0 auth.

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

Extensions are typed, declarative integrations (issue #50): manifest +
pinned spec snapshot + vault binding + policy. `kind` decides the
integration — **mcp** = the provider's official MCP server (bottega never
implements provider API clients), **cli** = a preinstalled CLI in the tools
image that bottega shells out to. What users can do:

- **Connect from chat** — messages matching `connect <extension>`,
  `connect <extension> as org`, or `connect <extension> as me` route
  directly to the connect capability (issue #61): no agent tool call, no
  session. Exact shapes only (case-insensitive; anything with extra words,
  punctuation, or keys stays natural-language agent territory). Bare /
  `as me` connects the sender's personal account (unprivileged);
  `as org` crosses the policy gate with the space's Slack approval router.
  api_key-type extensions still need the agent tool (or CLI) to supply
  the key.
- **Agent-agnostic tools** — the bottega MCP server advertises
  `connect_extension` + every registered extension's manifest tools to any
  agent (OMP, ACP, or future) and executes them server-side through the
  same policy gate, credential ladder, egress boundary, and audit as
  in-session tool calls (issue #61).
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

Registry internals (snapshots, wiring, the runtime safety spine, the CLI
spawn path) are in
[architecture.md](architecture.md#extension-registry-typed-integrations).

The test-only fixture extension proves the shape end to end: registered →
resolves → its tool appears in the space agent's toolset → its domain lands
in the merged egress allowlist. No extension implementations ship in this
issue — the three providers are their own issues.

## Live-Slack QA canary (issue #79)

The product-surface smoke test: it boots the REAL stack (production Socket
Mode adapter + the real model via the deployment catalog,
`config/omp/models.yml`) against a real Slack workspace and drives journeys
AS a QA user — real messages in, real bot replies out, with per-journey
pass/fail and Slack permalinks.

```bash
bun run canary --live-slack     # or LIVE_SLACK=1
```

Journeys: chat reply (DM + the `bottega-qa` channel, created when
missing), memory save/search (a fact is stored and searched back), work
item creation (always-approve policy path), and the connect intent seam.
Skip-gated: without `--live-slack`/`LIVE_SLACK=1`, in CI, or with missing
tokens it prints a clear skip message and exits 0. Generous per-journey
timeouts (120s) — it waits for a real model and a real workspace.

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

- **No auto-pickup** — the space agent creates work items only on an
  explicit tool call; there is no auto-pickup policy flag.
- **Approvals** — anyone in the channel can approve; there is no role model
  yet. In-session exec approvals (e.g. `create_work_item`) resolve via the
  Approve/Deny buttons (issue #44). The *delivery* approval button
  round-trip (the human's decision resolving `working → review → done`) is
  still a follow-up: today the server posts the PR + approval request as
  text, and the item stays `working` until that path lands.
- **Allowlisted repos only** — the executor works in the repo the
  conversation names (via `create_work_item`'s `repo` param) and refuses
  anything outside the settings `repos` allowlist (`config/org.yml` by
  default); a work item without a repo is blocked for the requester to
  specify. One shared executor container (no per-item container isolation
  yet).
- **Slack only** — Telegram, Teams, Meet, and the org observer are roadmap
  (issue #13 is the Telegram adapter).
- **No mid-session model switches on ACP** — `use_model` (issue #64) works
  on the OMP driver; ACP sessions cannot switch models mid-session (the
  agent's own config governs) and the tool reports it as an error.
- **No auto model routing** — the agent picks the model role per task via
  `use_model`; complexity-based auto-routing is v2.

## Roadmap

- Delivery approval buttons (resolving `working → review → done`
  in-channel) — completes the delivery loop; in-session approvals already
  resolve via buttons (issue #44).
- Telegram adapter (grammY, long polling) — #13.
- Per-work-item container isolation (deployment-only change).
- Roles (explicit approvers) and SSO.
- Non-OMP agents via the ACP driver — already wired, needs a second engine.
