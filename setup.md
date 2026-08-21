# Setup & operations

Everything technical: local development, configuring the proactive layer and
work items, deployment, credentials, backup, and rollback. For what the
product does, see [README.md](README.md) and [features.md](features.md); for
how it works inside, see [architecture.md](architecture.md).

## Development

```bash
bun install
bun check    # typecheck
bun test     # 865 tests across 67 files (861 passed, 4 skip-gated in the current environment)
scripts/smoke.sh  # local checks + compose validation + manual checklist
scripts/e2e-smoke.sh  # compose e2e smoke: fail-closed boots + broker token + SQLite schema (skip-gated, needs Docker)
bun run setup  # read-only prerequisite/state plan; performs no writes or service starts
bun run setup -- --apply  # explicitly apply the displayed, guarded setup plan
bun run dev  # start the server only after setup is complete (Docker required)
```

Local development uses a preview-first bootstrap (issue #311). `bun run
setup` and `bun run setup -- --check` inspect the declared files and
readiness endpoints. They do not write files or start services. The
deterministic plan names every path, mode, and action. `bun run setup --
--apply` rechecks prerequisites, refuses foreign owners, loose secret modes,
symlinks, and partial CA state, then applies only that plan. A rerun keeps
existing operator configuration and performs no setup actions.

The guarded apply generates the shared gitignored MITM CA, creates the
mode-0600 proxy management token, seeds only missing OMP defaults, and starts
the proxy and auth-broker. Proxy readiness uses an authenticated reload
probe. One 401 triggers one forced container recreation for stale token
state. Broker readiness requires both its health response and an owned,
mode-0600 token file. If the private broker image is unavailable, setup uses
the existing local `omp auth-broker serve` fallback with a HOME-relative
config path and a mode-0600 log. Every deadline is bounded.

Credential values are not setup defaults. The setup command never accepts,
prints, or copies them into config. Provision Slack and model credentials
through the existing `connect_upload_link` browser-to-vault path. Run the
existing `first_run_wizard` checks for the shared Slack, model, broker, Git
PAT, egress, and memory checklist. This keeps the auth-broker vault as the
secret boundary.

The proxy still uses the **dev-permissive generated config
`config/egress.dev.yml`** (allow-all allowlist `"*"` + no judge, while secret
injection and management remain enabled). The strict `config/egress.yml`
remains the deployment contract. `bun run dev` never performs hidden setup:
it reports every missing or failed prerequisite and exits before starting
the server. When setup is ready, it exports the proxy and broker environment
without printing token values. `bun run dev:watch` uses the same path and
changes only the final Bun `--watch` argument.

The proxy and broker stay up between runs. Stop them from any worktree (not
only the canonical checkout) by resolving the same adopted or persisted
project name:

```bash
source scripts/shared-data-dir.sh
COMPOSE_PROJECT_NAME="$(dev_compose_project)" \
  docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

This resolves `camp-flavor` (the adopted legacy stack) or the persisted id
for this repo, so the shared proxy/broker and egress network stop cleanly
from any worktree.

Integration tests use the [emulate.dev](https://emulate.dev) GitHub emulator
for the PR-creation path (no live GitHub needed); everything else is hermetic
unit tests over real SQLite — nothing hits a live LLM, Slack, or GitHub. The
live-Slack QA canary (issue #79) boots the real stack against a real
workspace — see [features.md](features.md#live-slack-qa-canary-issue-79).

## Proactive layer (scheduler, digests, reflections, KB)

The durable scheduler runs registered actions on five-field UTC cron
schedules. Create a weekday standup at 09:00 UTC with the
`create_scheduler_job` tool:

```json
{
  "action": "standup_digest",
  "cron": "0 9 * * 1-5",
  "params": {"space": "slack:C123"}
}
```

Standups and reflections are per-space opt-ins. Set the space's
`spaces.policy_json` value to include:

```json
{"proactive":{"standup":true,"reflection":true}}
```

Both flags default to `false`. A proactive action posts only when the
space's effective `response_mode` is `always`; mention and request-only
spaces never receive unsolicited posts. On restart, the scheduler skips
overdue occurrences instead of catching up, advances each job to its next
future occurrence, and records `scheduler.missed` in the audit trail.

The `org_pulse` action is a weekly, read-only summary of recent digest and
reflection memories. Create it with no job-level space and set
`params` to `{"pulse_space":"slack:C123"}` so the summary posts to that
Slack space.

Knowledge-base sources live in `config/kb.yml`. After adding a source, run
the `kb_ingest` tool with `{"source":"source-id"}`, or omit `source` to
ingest all configured sources. Each source host must also be in
`src/egress/generate.ts`'s static allowlist, and requests must still pass
the compose egress judge.

These tools fail closed until the deployment-local, gitignored
`config.yml` allows them. Use this exact policy block:

```yaml
tools:
  create_scheduler_job: allow
  list_scheduler_jobs: allow
  delete_scheduler_job: allow
  kb_ingest: allow
approvals:
  always_approve:
    - create_scheduler_job
    - delete_scheduler_job
```

`create_scheduler_job` and `delete_scheduler_job` are exec-tier tools:
`action: allow` still asks a human unless they appear in
`approvals.always_approve`. Remove the `approvals` block when every
scheduler mutation should require an Approve button. Listing is read-only,
and KB ingestion is write-tier, so neither needs `always_approve`.

## Work items

`create_work_item` stores delivery-neutral work in one durable queue. Set
`delivery` to one of:

- `git` (default) — repository work. The executor uses an isolated workspace,
  pushes a branch, opens a pull request, and waits for delivery approval.
- `extension` — connected-service work, such as creating a Linear issue or
  updating an Attio record. The executor starts a headless worker session with
  the space's connected extension tools and records `{"url","summary"}` as
  the result. Approval to pick up the item authorizes this worker run. Tool
  policy, credential scope, and egress rules still apply. Any worker, tool,
  policy, timeout, or result-validation failure moves the item to `blocked`
  with evidence.
- `chat` — work intended for an in-channel answer. The executor leaves these
  items for the space agent instead of treating them as git or extension work.

Department personas add role guidance and a minimum visible toolset when a
space session starts. Persona files live at `config/personas/<id>.md` and
`config/personas/<id>.tools.yml`. Select one in `spaces.policy_json`:

```json
{"persona":"ops"}
```

An absent, invalid, unknown, or incomplete persona falls back to `default`.
The persona tool list only controls visibility. The normal space and org policy
still gates each call and can deny it.

Recurring non-code work uses the same queue. Create a `recurring_work`
scheduler job with `params.space` and `params.description`; each fire creates
one `delivery=extension` item instead of bypassing claim, audit, policy, or
failure handling. For example, run a weekly operations report at 09:00 UTC on
Mondays:

```json
{
  "action": "recurring_work",
  "cron": "0 9 * * 1",
  "params": {
    "space": "slack:C123",
    "description": "Prepare the weekly operations report"
  }
}
```

Extension hosts must remain on the iron-proxy egress allowlist in every
deployment. The shipped Attio, Linear, and GitHub extension hosts are already
allowlisted. Add a host to the static allowlist when adding an extension;
connected credentials never bypass the proxy or its judge.

## Skills (per-space authored procedures, issues #234/#235)

Skills are durable, space-specific procedures the space agent can learn and
reference mid-session with `skill://<name>`. The agent claims skills by
name; the store is two-tier:

- **Built-ins** ship with the repo at `skills/` (override with
  `BOTTEGA_BUILTIN_SKILLS_DIR`) and load once per boot. The shipped
  `pr_review` built-in is injected into every git work-item session.
- **Per-space skills** are authored at runtime into
  `data/skills/<spaceId>/<name>/SKILL.md` (override the root with
  `BOTTEGA_SKILLS_DIR`). A space skill with the same name as a built-in
  shadows it for that space.

Writing a skill is a privileged mutation (`write_space_skill`, exec tier):
it injects procedures into the space agent's *future* sessions, so an
unconfigured or unauthorized write denies fail-closed. To auto-approve
skill writes without the ask-human prompt, list the tool under `tools:`
with action `allow` **and** under `approvals.always_approve`:

```yaml
tools:
  write_space_skill: allow
approvals:
  always_approve:
    - write_space_skill
```

`always_approve` only skips the prompt for tools whose action is already
`allow` — an unlisted tool (or a `deny`) still fails closed, and an unknown
name in `always_approve` fails the policy closed. The dev floor in
`config.yml` (`tools: unknown: allow`) already gives the tool action
`allow`, so adding the `approvals` entry is all that is needed to
auto-approve locally. Verify with the loader, not by eye:

```bash
bun -e 'import {loadOrgConfig,decidePolicyCall} from "./src/policy/config.ts"; const p=loadOrgConfig(); console.log(decidePolicyCall(p,"write_space_skill"))'
```

With the dev floor but no `approvals` entry this prints
`{decision:"ask-human",reason:"exec-tier tool requires human approval",autoApproved:false}`;
after adding `write_space_skill` to `approvals.always_approve` it prints
`{decision:"allow",reason:"auto-approved by policy (approvals.always_approve)",autoApproved:true}`.
A deployment that removes `config.yml` (back to deny-all) prints
`{decision:"deny",reason:"policy denies the tool",autoApproved:false}`.

## Deployment

### Prerequisites

- Docker with Compose v2 (`docker compose version`) — required for the stack AND for local dev (`bun run dev` brings up iron-proxy, issue #123)
- A Slack workspace where you can create apps
- A GitHub org/repo the bot may push branches and open PRs to
- Bun 1.3+ only for local development (`bun check`, `bun test`)

### 1. Create the Slack app

`slack-app-manifest.yml` in this repo declares the app (Socket Mode, bot scopes, event subscriptions).

1. Open <https://api.slack.com/apps> → **Create New App** → **From an app manifest** → paste the contents of `slack-app-manifest.yml` → **Create**.
2. **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-...`) — that is `SLACK_BOT_TOKEN`.
3. **App-Level Tokens** → **Generate Token** with the `connections:write` scope and copy it (`xapp-...`) — that is `SLACK_APP_TOKEN`. Socket Mode needs it; no request URL is required.

### 2. Set up `.env`

Copy `.env.example` to `.env` and fill in:

| Variable | What it is | How to get it |
| --- | --- | --- |
| `SLACK_APP_TOKEN` | App-level token | Slack app dashboard (step 1.3). Vault-backed (#201): the boot seeds it from the auth-broker vault (row provider `slack-app`; provision with `connect_upload_link slack-app`) — .env is the fallback |
| `SLACK_BOT_TOKEN` | Bot user OAuth token | Slack app dashboard (step 1.2). Vault-backed (#201): row provider `slack-bot` (`connect_upload_link slack-bot`) — .env is the fallback |
| `OPENCODE_API_KEY` | Primary model key (#37) | Seeded into iron-proxy's mode-0600 `opencode.secret` boundary file (#208), then removed from the app environment. Vault row `opencode` is preferred; `.env` or macOS Keychain service `bottega-opencode` is the local fallback |
| `NEAR_API_KEY` | Fallback model provider key | Seeded into iron-proxy's `near.secret`, then removed from the app environment. Vault row `near` is preferred; `.env` or Keychain service `bottega-near` is the local fallback |
| `OPENAI_API_KEY` | OpenAI model key + mem0 embedder/extractor key (#43) | The agent provider uses iron-proxy's `openai.secret`; mem0 still needs its own service credential when enabled. Vault row `openai` is preferred; `.env` is the fallback |
| `ANTHROPIC_API_KEY` | Anthropic model key | Seeded into iron-proxy's `anthropic.secret`, then removed from the app environment. Vault row `anthropic` is preferred; `.env` is the fallback |
| `OMP_AUTH_BROKER_URL` | Broker address | Prefilled for compose. Local dev: `bun run setup -- --apply` starts the loopback broker; `bun run dev` exports `http://127.0.0.1:8765` |
| `OMP_AUTH_BROKER_TOKEN` | Broker bearer token | Generated at broker first boot — copy from the data volume once for deployment (step 3). Local dev reads the owned mode-0600 shared token only into the server environment and never prints it (#143/#311) |
| `OP_CONNECT_TOKEN` | 1Password Connect access token (optional, #190) | Only when the org settings blob selects `secrets_backend: {type: 1password-connect, ...}` — the extension credential boundary then resolves static credentials (API keys/PATs) from the org's Connect server. The Connect server URL + the `"provider:identityKey" → {vault, item, field}` mapping are settings-tool knobs; only this token is env. Omit for the default omp-broker backend |
| `NEARAI_JUDGE_API_KEY` | iron-proxy egress judge key (deployment only) | Referenced by the STRICT `config/egress.yml` (`judge.provider.api_key_env`); fail-closed without it — model traffic is denied in deployment. NOT needed for local dev: the dev config (`config/egress.dev.yml`) has no judge transform (issue #126) |
| `IRON_MANAGEMENT_API_KEY` | iron-proxy management API token (#123) | The extension credential boundary's `POST /v1/reload` bearer token (`config/egress.yml` → `management.api_key_env`); set a strong deployment value. Local dev: explicit setup creates the shared mode-0600 `data/proxy-mgmt-token`; dev reads it only into the proxy/server environment |
| `GITHUB_PAT` | Git credential | Install into the volume file, see step 3; never in env |
| `BOTTEGA_IMAGE_TAG` | Image tag to run | `local` by default; pin a build sha for rollback (step 5) |

**Boot credentials are split by boundary (#201, #208).** Slack tokens and the
GitHub webhook secret remain app boot secrets. Model provider keys resolve with
precedence **vault → env → Keychain (local dev, opt-in) → fail closed**, are
written atomically to iron-proxy's mode-0600 secret files, and are removed from
the app environment. `models.yml` contains only
`bottega-proxy-placeholder`; iron-proxy replaces it on matching gateway hosts.
Missing files are `require: true`, so the placeholder cannot reach an upstream
gateway. Active OAuth extension snapshots use iron-proxy's native
`oauth_token` transform for refresh, caching, and single-flight deduplication.

Provision a boot secret into the vault with the same one-time upload link
as extensions (never a secret through chat): ask the agent for
`connect_upload_link <provider-id>` and paste the value into the browser
form; the endpoint stores it as the provider's `api_key` row in the vault.
The provider ids are the table's vault rows: `slack-app`, `slack-bot`,
`opencode`, `near`, `openai`, `anthropic`, `github-webhook`. The value
applies at the next
boot (rotation = re-upload the row and restart). The Keychain leg is an
opt-in local fallback: set `BOTTEGA_KEYCHAIN_SEED=1` and store
`security add-generic-password -s bottega-<provider> -a "$(whoami)" -w '<key>'`.
Fail closed stays: a secret missing from the vault, env, and enabled Keychain
fallback refuses to boot with the existing guard messages.

`.env` carries secrets + deployment identity only (issue #67). Runtime knobs
(approval timeouts, response mode, memory injection, extensions policy, repo
allowlist, model defaults, workspaces dir, git/api base URLs, memory backend
URL, and — issue #190 — the secret-vault backend `secrets_backend`:
`omp-broker` default, or a 1Password Connect server via `type`,
`connect_url`, and a `"provider:identityKey" → {vault, item, field}`
mapping) live in the org settings blob in the DB, editable via the
`settings` tool (see [features.md](features.md#settings-issue-67)), not in
`.env`. The Connect token stays in `.env` (`OP_CONNECT_TOKEN`); the
omp-broker backend keeps resolving from the OMP auth-broker vault, and the
OAuth lifecycle (token refresh) remains with it — 1Password serves static
credentials (API keys / PATs).

Memory backend (issues #43, #67): unset `memory_backend.base_url` (the
default) runs the SQLite memory fallback. To use the self-hosted mem0
service, set the knob (e.g. `http://mem0:8000` inside compose) via the
settings tool and give mem0 an LLM key (`OPENAI_API_KEY`, above); the switch
applies on the next server start. `MEM0_API_KEY` stays an optional env
secret for mem0 auth.

**Permission-aware memory scopes (issue #137).** Every memory belongs to one
logical scope derived from the authenticated conversation, never from a
prompt/tool argument: `org` (company floor), `person:<principal>` (one human,
DM only), `channel:<spaceId>` (the current channel), or `team:<teamId>`
(channels sharing the same explicit policy value). A DM recall reads its
person's facts + org; a channel recall reads its channel facts + its
configured team + org — a channel can never read a person's private facts.
Existing `scope='user'` rows (the pre-#137 format) remain readable as the
matching `person:` key with no migration.

To share memory across channels, set the optional space policy field
`memory.team` to a stable identifier (letters/digits/`-`/`_`, ≤64 chars);
malformed values fail closed (no team scope is granted). Example overlay:
`{"memory":{"team":"eng"}}`. `extensions.org_credentials` is unrelated and
never affects memory visibility. Every successful recall appends an
append-only `memory.recalled` audit row with the requester/space and per-scope
counts — never the query or memory content.

Facts the agent auto-learns from a shared channel are now stored channel-local
(`channel:<spaceId>`): they are recalled only in that channel unless the space
also configures a `memory.team`, which extends recall to the team's shared
pool. Existing org-scope facts remain org-readable everywhere; nothing about
existing org or per-person rows changes.

### Public ingress for browser legs (issues #196, #198, #249)

The connect flows have two browser legs served by in-process listeners on
127.0.0.1 (never exposed directly): the OAuth callback (`/oauth/callback`)
and the one-time upload-link form (`/upload/<token>`). In deployment both
ride the SAME public base, resolved in this order (issue #249):

1. The durable store `data/public-base-url` — the LIVE public URL, written
   by `scripts/tunnel.sh` on every rotation. Re-read on every mint, so a
   rotated cloudflared quick-tunnel host heals connects/uploads without an
   `.env` edit or a server restart.
2. `BOTTEGA_OAUTH_CALLBACK_BASE_URL` (e.g. `https://bottega.example.com`) —
   a deployment-only override for a FIXED reverse-proxy / DNS host that
   never rotates.

When a base resolves, the connect mints return `<base>/upload/<token>` and
`<base>/oauth/callback` URLs, so a browser on a remote host reaches them
through the ingress instead of 404ing on a loopback URL. With neither set →
local-dev posture: the mints return the loopback URL
(`http://127.0.0.1:<port>`), which only works when the browser runs on the
server's own host.

Quick tunnels: run `scripts/tunnel.sh` in the foreground (or under your
process supervisor) — it keeps cloudflared up, extracts the current
trycloudflare URL, and atomically writes it to `data/public-base-url`
(mode 0600). Restarting cloudflared (rotation) needs no config change: the
script simply writes the new URL and the next mint uses it.

Static tunnels need a stable local target: pin `BOTTEGA_CALLBACK_PORT`
(default 0 = ephemeral) so the tunnel's forwarding survives restarts. ONE
listener serves every browser leg — `/upload/*`, `/oauth/callback`, and
the webhook route — so the tunnel forwards to that single port and both
connect flows work through it. Local dev with `bun run dev` needs nothing
set: the launcher propagates the canonical checkout's store path to the
server (issue #293), so a dev server restarted from ANY repository
worktree — including `.worktrees/<name>` feature worktrees — reads the same
`data/public-base-url` the tunnel writes (a worktree's own `data/` stays
per-checkout state; the public-base store is shared). The ENTIRE local dev
stack shares the same way (issue #301): `bun run dev` pins the Compose
project to a stable dev identity — reusing the existing legacy
canonical-basename stack (`camp-flavor`, so a pre-#301 running stack
converges onto its existing network instead of stranding the subnet) when
one is running, else a stable hash of the canonical checkout's realpath — and
it exports the canonical data dir, certs dir, and credential-boundary secret
dir to the Compose override and the server env. So every worktree reuses
ONE iron-proxy egress network, ONE proxy/broker container set, ONE MITM CA,
and ONE secret store — instead of each worktree creating its own
`<worktree>_egress` network on the fixed `172.30.0.0/24` subnet and failing
the SECOND boot with `invalid pool request: Pool overlaps with other one on
this address space`, or trusting a worktree-local CA/secret the shared
proxy is not using.

### Static OAuth clients for no-DCR servers (issue #288, Gmail)

Some hosted OAuth MCPs (Gmail — `gmail-googleapis-com`) advertise OAuth
metadata but NO dynamic client registration endpoint, so the MCP SDK
cannot register a client at connect time. These need a deployment-level
PRE-REGISTERED OAuth client, provisioned once through the one-time upload
browser path:

1. Create a "web application" OAuth client for the Gmail MCP in the
   Google Cloud console, with the callback URI set to Bottega's PUBLIC
   `/oauth/callback` URI (the same public base the OAuth callback leg
   uses — see above; e.g. `https://bottega.example.com/oauth/callback`).
2. Ask the agent for `connect_upload_link extension=gmail-googleapis-com
   scope=org` — org scope is REQUIRED for static-client provisioning.
3. Open the single-use link in a browser and enter the pre-registered
   client ID and client secret (two separate fields). They go straight
   from the browser into the auth-broker vault — an opaque api-key row
   under the synthetic provider key `static-oauth-client:gmail-googleapis-com`
   — never through chat, a transcript, or the audit trail.
4. Connect normally: run personal `connect_extension` (`connect
   gmail-googleapis-com as me`, or `as org` for the shared account). The
   connect detects the missing registration endpoint, loads the static
   client, and returns the authorization URL; the code exchange and
   refresh reuse the same pre-registered client.

A connect for a no-DCR extension WITHOUT a provisioned static client
fails closed with the `connect_upload_link extension=<id> scope=org`
instruction. DCR-capable providers (Notion, Linear, ...) are unaffected —
they register dynamically exactly as before and never consult a static
client.

### 3. First boot

```bash
docker compose --profile executor up -d --build
```

First boot generates the broker's bearer token into the data volume. Copy
it into `.env` once and restart:

```bash
docker compose exec auth-broker cat /data/.omp/auth-broker.token
# -> paste into OMP_AUTH_BROKER_TOKEN in .env
docker compose up -d
```

> Local dev does NOT need this: `bun run dev` (scripts/dev.sh, issue #143)
> starts its own auth-broker against the host's `./data` and reads the
> token from `data/.omp/auth-broker.token` itself — the broker-related env
> is exported automatically, nothing to copy.

Install the git PAT as a file on the data volume (mode 0600, never env):

```bash
mkdir -p data/secrets
install -m 0600 /path/to/your-pat data/secrets/github-pat
```

> The executor and server share one image (`bottega:${BOTTEGA_IMAGE_TAG}`,
> built from the repo root) and differ only in entrypoint; the executor runs
> only with the `executor` profile enabled, as above. Drop `--profile
> executor` to run without it.

### Hybrid canary (issue #298): nightly live-API + browser, hermetic on every commit

The hybrid canary's **hermetic** layer (role/multiplayer journeys + the
built-in-tool coverage gate) runs on every commit as part of the suite.
The **live-API** and **browser** layers run **nightly in parallel**
(`.github/workflows/canary.yml`, cron `0 4 * * *`), issue #79/#175/#298:

- The **live-API leg** (real Socket Mode, real model, real workspace,
  CI-strict `--ci`) now needs the **four fixed QA identities** in
  addition to the single QA user. Configure these **GitHub Actions
  repository secrets** (see features.md → "Live-Slack QA canary" for the
  QA-user + token setup):
  - `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_QA_USER_TOKEN` — required.
  - `SLACK_QA_REQUESTER_TOKEN`, `SLACK_QA_APPROVER_TOKEN`,
    `SLACK_QA_MEMBER_TOKEN`, `SLACK_QA_SECOND_MEMBER_TOKEN` — required for
    the role/multiplayer matrix.
  - `SLACK_QA_USER_ID`, `SLACK_QA_CHANNEL` — optional (defaults: users.list
    lookup, `bottega-qa`).
  - `NEAR_API_KEY` (preferred) or `CANARY_MODEL_REF` — the model key/ref.
- The **browser leg** runs on a **dedicated self-hosted runner** with two
  persistent Chrome user-data directories (requester + approver profiles,
  runner-local paths supplied as repository **variables**, never secrets).
  Configure the runner label (`[self-hosted, linux, x64, canary]`) and the
  variables `BROWSER_PROFILE_REQUESTER`, `BROWSER_PROFILE_APPROVER`,
  `SLACK_WORKSPACE_URL`. It preflights both authenticated profiles and
  uploads screenshot + trace evidence.

A failure posts the per-journey report + permalinks + the run URL to the
QA channel. **One isolated rerun** classifies a flake but the ORIGINAL
failure stays release-blocking; a machine-readable status artifact
(`canary-status.json`) lets release automation verify green + <24h fresh.
**The scheduled canary is a release gate, not a merge gate**: a red
scheduled run blocks the next deploy until triaged (AGENTS.md → "Hybrid
canary (issue #298)").

### GitHub credentials: the two token paths

There are exactly two credential paths, and they never overlap. The server
**never sets `GITHUB_TOKEN`** and no token ever enters the environment,
image, or chat.

1. **Executor git PAT (file, mode 0600)** — `data/secrets/github-pat` on the
   shared data volume. This is the *git credential*: the executor reads it
   through a generated `GIT_ASKPASS` helper for `git push` / PR work, and the
   same file authorizes the GitHub API calls the executor makes. A mode other
   than 0600 fails boot closed. It is never in env, never in the image, and
   the server never touches it.

2. **Extension credential (auth-broker vault)** — the GitHub extension's MCP
   tools (`github.search_issues`, `github.create_issue`, …) resolve their
   credential from the auth-broker vault via the #51 ladder. The extension
   binds to GitHub's **hosted MCP server** (streamable-http at
   `https://api.githubcopilot.com/mcp/`, issue #145) — no `github-mcp-server`
   binary is installed anywhere; the egress allowlist + secrets transform
   cover that host and the proxy injects the credential there. Connect it
   with the `connect` capability and choose the scope:

   - `connect github as me` — **personal**: the credential binds to *your*
     Slack identity and resolves only for your calls (the ladder filters
     personal rows by owner). This is the default scope and the right choice
     for humans: *your own GitHub calls use your own connected credential*.
   - `connect github as org` — **org**: ONE credential shared org-wide,
     intended for service accounts and unattended flows. Sharing a personal
     token org-wide is discouraged — prefer per-person connects. Org usage of
     extension credentials can be denied per space (`extensions.org_credentials`,
     #56).

   Either scope requires an extension policy entry (`extensions.allow`) for
   the space; the tool then runs through the normal policy gate.

   At call time the runtime fetches the credential's secret payload from the
   broker vault (`OMP_AUTH_BROKER_URL`/`OMP_AUTH_BROKER_TOKEN` — the boundary's
   broker secret resolver, issue #54 wiring; set by `scripts/dev.sh` locally,
   by compose in deployment) and hands it to the egress boundary, which writes
   the extension's secret file (0600) and reloads iron-proxy; the proxy then
   injects the `Authorization` header for the extension's allowlisted domains,
   so the credential never enters the agent env, transcripts, or audit.

**Never paste tokens into chat.** Transcripts are durable and never deleted,
so a token pasted into Slack is a permanent leak (and may end up in org
memory). `memory.save` refuses credential-shaped content (GitHub PATs, Slack
`xox*` tokens, OpenAI `sk-` keys, AWS `AKIA…`, …) with a clear error — if you
ever need to hand the bot a credential, use `connect <extension> as me|org`
or the PAT file above, never a chat message.

### Which repo does the executor work in?

The repo is a property of the task, not of the deployment (issue #47): the
agent derives it from the conversation — a mentioned repo, or org memory —
and passes it to `create_work_item` ("fix the flaky checkout in bottega" →
`repo: "acme/bottega"`). Org memory is how the agent knows the repo names;
seed an org-scope entry via the `memory.save` tool in any space, e.g.
`memory.save {scope: "org", content: "our repos are acme/sandbox, acme/tooling"}`.

The executor treats the org settings `repos` allowlist (issue #67; the
`config/org.yml` `repos` list is the default until settings are set) as an
**allowlist**: it refuses any repo not listed. A work item with no repo is
blocked with "repo not specified — ask the requester" — no
first-configured-repo fallback; an empty allowlist means no pushes until a
repo is configured. Set the allowlist, git base, or API base via the
`settings` tool.

### Retained failed workspaces

Git workspaces that block stay on disk for investigation. Each clone carries
an executor ownership marker in `.git/bottega-workspace.json`. Retry and
successful cleanup first require an exact work-item ID and repository match,
a canonical direct child of the configured workspace root, and no symlink.
An unmarked or uncertain path is left untouched and the item blocks with the
workspace path and reason. The marker, evidence, logs, and audit contain no
credentials.

Removal is explicit. There is no age-based workspace cleanup. To purge one
retained workspace, name the blocked work item and the operator identity:

```bash
BOTTEGA_DB_PATH=data/bottega.db \
  bun run workspace:purge -- wi_<uuid> --actor operator:<identity>
```

The command checks the database item is `blocked`, validates the same marker
authority, removes only that one workspace, and writes `workspace.purge`
request/result audit rows. Missing, active, mismatched, unmarked, symlinked,
or escaped targets are refused and remain untouched.

### First-run checklist

1. `docker compose logs -f server` — no errors, bot connects via Socket Mode.
2. Invite the bot into a channel and @mention it — it should reply (the space agent answers in-channel).
3. Create a test work item (the `create_work_item` tool, passing a `repo` that is on the allowlist — see "Which repo does the executor work in?" above) — the executor claims it, implements it in a workspace, opens a PR, and the server posts `PR ready: <url> — approve to finish` in the channel.
4. Restart persistence: `docker compose down && up` — spaces, work items, and the audit trail survive (they live on the `data` volume).
5. Scheduled live-fire (requires `.env` and Slack): create a job due in the next minute, confirm one channel post, then confirm `list_scheduler_jobs` advanced `nextFireAt` and the audit trail contains `scheduler.fire`.

### Backup & rollback

- **Backup** — everything that matters lives on the `data` volume (SQLite store, sessions, transcripts, git credential file). Snapshot it on a schedule and keep a copy off-host:

  ```bash
  docker run --rm -v bottega_data:/data -v "$PWD":/backup alpine \
    tar czf /backup/bottega-data-$(date +%F).tar.gz /data
  ```

  Find the exact volume name with `docker volume ls` (usually `bottega_data`). Restore: stop the stack, untar over the volume, `up -d`.

- **Rollback** — tag each deploy and pin the known-good tag in `.env`:

  ```bash
  BOTTEGA_IMAGE_TAG=$(git rev-parse --short HEAD) docker compose build
  # .env: BOTTEGA_IMAGE_TAG=<sha>
  docker compose --profile executor up -d
  ```

  To roll back, set `BOTTEGA_IMAGE_TAG` to the previous tag and `docker compose --profile executor up -d` — the old image is still in the local store. Data is untouched by rollback (only the app containers recreate).
