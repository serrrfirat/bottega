# bottega

Team agents that live in your chat. Slack spaces where people and agents
work together: work items get picked up, implemented in isolated workspaces,
and delivered as pull requests — with every action policy-gated and audited.

Per-org self-hosted: one `docker compose` stack (server, executor,
auth-broker, auth-gateway, iron-proxy) plus a shared `data/` volume for
SQLite state, sessions, and git credentials.

## Architecture

A Slack bot (Socket Mode — no public ports) receives messages in a channel
and the **server** answers them through a per-space agent session; when
someone creates a work item, the **executor** container claims it, clones the
org repo into a fresh workspace, runs an agent session scoped to that
workspace, and pushes a `bottega/<id>` branch with a pull request. The server
then announces the PR in the channel. All outbound traffic from both
containers crosses **iron-proxy** (allowlist + DNS sinkhole), model
credentials resolve through the **auth-broker** vault (never from env), and
every decision lands in the append-only SQLite audit trail.

Safety summary:

- **Deny-by-default egress** — every outbound request from the server and
  executor resolves through iron-proxy; only allowlisted endpoints pass.
- **Credentials never reach agent environments** — provider keys live in the
  auth-broker vault, Slack tokens only in the server `.env`, and the git PAT
  only in a mode-0600 file on the data volume.
- **Executor isolation** — work items run as scoped agent sessions in
  disposable workspaces; a hostile repo script cannot touch host paths
  outside its workspace (manual checklist item in `scripts/smoke.sh`).

## Prerequisites

- Docker with Compose v2 (`docker compose version`)
- A Slack workspace where you can create apps
- A GitHub org/repo the bot may push branches and open PRs to
- Bun 1.3+ only for local development (`bun check`, `bun test`)

## 1. Create the Slack app

`slack-app-manifest.yml` in this repo declares the app (Socket Mode, bot
scopes, event subscriptions).

1. Open <https://api.slack.com/apps> → **Create New App** → **From an app
   manifest** → paste the contents of `slack-app-manifest.yml` → **Create**.
2. **Install to Workspace** and copy the **Bot User OAuth Token**
   (`xoxb-...`) — that is `SLACK_BOT_TOKEN`.
3. **App-Level Tokens** → **Generate Token** with the `connections:write`
   scope and copy it (`xapp-...`) — that is `SLACK_APP_TOKEN`. Socket Mode
   needs it; no request URL is required.

## 2. Set up `.env`

Copy `.env.example` to `.env` and fill in:

| Variable | What it is | How to get it |
| --- | --- | --- |
| `SLACK_APP_TOKEN` | App-level token | Slack app dashboard (step 1.3) |
| `SLACK_BOT_TOKEN` | Bot user OAuth token | Slack app dashboard (step 1.2) |
| `NEAR_API_KEY` | Model provider key | Referenced by `config/omp/models.yml`; resolved by the SDK inside the server, never in agent env |
| `OMP_AUTH_BROKER_URL` | Broker address | Prefilled for compose |
| `OMP_AUTH_BROKER_TOKEN` | Broker bearer token | Generated at broker first boot — copy from the data volume once (step 3) |
| `GITHUB_PAT` | Git credential | Install into the volume file, see step 3; never in env |
| `BOTTEGA_IMAGE_TAG` | Image tag to run | `local` by default; pin a build sha for rollback (step 5) |

## 3. First boot

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

Install the git PAT as a file on the data volume (mode 0600, never env):

```bash
mkdir -p data/secrets
install -m 0600 /path/to/your-pat data/secrets/github-pat
```

> The executor and server share one image (`bottega:${BOTTEGA_IMAGE_TAG}`,
> built from the repo root) and differ only in entrypoint. The executor runs
> only when the `executor` profile is enabled, as above. To run without the
> executor, drop `--profile executor`.

## First-run checklist

1. `docker compose logs -f server` — no errors, bot connects via Socket Mode.
2. Invite the bot into a channel and @mention it — it should reply (the
   space agent answers in-channel).
3. Create a test work item (the `create_work_item` tool) — the executor
   claims it (`docker compose logs -f executor`), implements it in a
   workspace, opens a PR, and the server posts
   `PR ready: <url> — approve to finish` in the channel.
4. Restart persistence: `docker compose down && up` — spaces, work items,
   and the audit trail survive (they live on the `data` volume).

## Backup & rollback

- **Backup** — everything that matters lives on the `data` volume (SQLite
  store, sessions, transcripts, git credential file). Snapshot it on a
  schedule and keep a copy off-host:

  ```bash
  docker run --rm -v bottega_data:/data -v "$PWD":/backup alpine \
    tar czf /backup/bottega-data-$(date +%F).tar.gz /data
  ```

  Find the exact volume name with `docker volume ls` (usually
  `bottega_data`). Restore: stop the stack, untar over the volume, `up -d`.

- **Rollback** — tag each deploy and pin the known-good tag in `.env`:

  ```bash
  BOTTEGA_IMAGE_TAG=$(git rev-parse --short HEAD) docker compose build
  # .env: BOTTEGA_IMAGE_TAG=<sha>
  docker compose --profile executor up -d
  ```

  To roll back, set `BOTTEGA_IMAGE_TAG` to the previous tag and
  `docker compose --profile executor up -d` — the old image is still in the
  local store. Data is untouched by rollback (only the app containers
  recreate).

## Known limitations (v1)

- **No auto-pickup by default** — the space agent picks up work items only
  on an explicit tool call (`pickup.auto` policy flag is off by default).
- **Approvals** — anyone in the channel can approve; there is no role model
  yet. The delivery approval button round-trip (the human's decision
  resolving `working → review → done`) is a follow-up: today the server
  posts the PR + approval request as text, and the item stays `working`
  until that path lands.
- **Single repo per deployment** — the executor runs every item in the first
  configured repo (`config/org.yml`), in one shared executor container (no
  per-item container isolation yet).

## Development

```bash
bun install
bun check    # typecheck
bun test     # 165+ tests: store, policy, adapter, executor, deploy packaging
scripts/smoke.sh  # local checks + compose validation + manual checklist
bun run dev  # local server (needs .env)
```
