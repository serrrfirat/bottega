# bottega

Team agents that live in your chat. Slack spaces where people and agents
work together: work items get picked up, implemented in isolated workspaces,
and delivered as pull requests — with every action policy-gated and audited.

Per-org self-hosted: one `docker compose` stack (server, executor,
auth-broker, auth-gateway, iron-proxy, mem0) plus a shared `data/` volume
for SQLite state, sessions, and git credentials. Built with Bun + TypeScript on
the [OMP](https://oh-my-pi.dev) agent core; the egress firewall is
[iron-proxy](https://github.com/ironsh/iron-proxy) (Go, used unmodified).

- [features.md](features.md) — user-facing capabilities: model settings, settings tool, memory, policy & approvals, extensions, live QA canary, limitations, roadmap.
- [architecture.md](architecture.md) — the three primitives, components, agent driver abstraction, policy internals, extension registry design, data flow, safety, persistence, multiplayer, repository layout.

## Development

```bash
bun install
bun check    # typecheck
bun test     # 490+ tests across 36 files (store, policy, adapters, drivers, memory, extensions, deploy)
scripts/smoke.sh  # local checks + compose validation + manual checklist
scripts/e2e-smoke.sh  # compose e2e smoke: fail-closed boots + broker token + SQLite schema (skip-gated, needs Docker)
bun run dev  # local server (needs .env; or keys in Keychain: security add-generic-password -s bottega-opencode -a $(whoami) -w '<key>' and -s bottega-near ...)
```

Integration tests use the [emulate.dev](https://emulate.dev) GitHub emulator
for the PR-creation path (no live GitHub needed); everything else is hermetic
unit tests over real SQLite — nothing hits a live LLM, Slack, or GitHub. The
live-Slack QA canary (issue #79) boots the real stack against a real
workspace — see [features.md](features.md#live-slack-qa-canary-issue-79).

## Deployment

### Prerequisites

- Docker with Compose v2 (`docker compose version`)
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
| `SLACK_APP_TOKEN` | App-level token | Slack app dashboard (step 1.3) |
| `SLACK_BOT_TOKEN` | Bot user OAuth token | Slack app dashboard (step 1.2) |
| `OPENCODE_API_KEY` | Primary model key (#37) | Referenced by `config/omp/models.yml` (`providers.opencode-go.apiKey`); resolved by the SDK inside the server, never in agent env. Local dev: Keychain service `bottega-opencode` |
| `NEAR_API_KEY` | Fallback model provider key | Referenced by `config/omp/models.yml`; resolved by the SDK inside the server, never in agent env |
| `OMP_AUTH_BROKER_URL` | Broker address | Prefilled for compose |
| `OMP_AUTH_BROKER_TOKEN` | Broker bearer token | Generated at broker first boot — copy from the data volume once (step 3) |
| `NEARAI_JUDGE_API_KEY` | iron-proxy egress judge key | Referenced by `config/egress.yml` (`judge.provider.api_key_env`); fail-closed without it — model traffic is denied |
| `OPENAI_API_KEY` | mem0 memory backend key (#43) | The stack ships a self-hosted mem0 service; it refuses to boot without an LLM key (fail-closed). Not needed when memory runs on the SQLite fallback |
| `GITHUB_PAT` | Git credential | Install into the volume file, see step 3; never in env |
| `BOTTEGA_IMAGE_TAG` | Image tag to run | `local` by default; pin a build sha for rollback (step 5) |

`.env` carries secrets + deployment identity only (issue #67). Runtime knobs
(approval timeouts, response mode, memory injection, extensions policy, repo
allowlist, model defaults, workspaces dir, git/api base URLs, memory backend
URL) live in the org settings blob in the DB, editable via the `settings`
tool (see [features.md](features.md#settings-issue-67)), not in `.env`.

Memory backend (issues #43, #67): unset `memory_backend.base_url` (the
default) runs the SQLite memory fallback. To use the self-hosted mem0
service, set the knob (e.g. `http://mem0:8000` inside compose) via the
settings tool and give mem0 an LLM key (`OPENAI_API_KEY`, above); the switch
applies on the next server start. `MEM0_API_KEY` stays an optional env
secret for mem0 auth.

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

Install the git PAT as a file on the data volume (mode 0600, never env):

```bash
mkdir -p data/secrets
install -m 0600 /path/to/your-pat data/secrets/github-pat
```

> The executor and server share one image (`bottega:${BOTTEGA_IMAGE_TAG}`,
> built from the repo root) and differ only in entrypoint; the executor runs
> only with the `executor` profile enabled, as above. Drop `--profile
> executor` to run without it.

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

### First-run checklist

1. `docker compose logs -f server` — no errors, bot connects via Socket Mode.
2. Invite the bot into a channel and @mention it — it should reply (the space agent answers in-channel).
3. Create a test work item (the `create_work_item` tool, passing a `repo` that is on the allowlist — see "Which repo does the executor work in?" above) — the executor claims it, implements it in a workspace, opens a PR, and the server posts `PR ready: <url> — approve to finish` in the channel.
4. Restart persistence: `docker compose down && up` — spaces, work items, and the audit trail survive (they live on the `data` volume).

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
