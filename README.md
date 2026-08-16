# bottega

Team agents that live in your chat. Slack spaces where people and agents
work together: work items get picked up, implemented in isolated workspaces,
and delivered as pull requests — with every action policy-gated and audited.

Per-org self-hosted: one `docker compose` stack (server, executor,
auth-broker, auth-gateway, iron-proxy, mem0) plus a shared `data/` volume
for SQLite state, sessions, and git credentials. Built with Bun + TypeScript on
the [OMP](https://oh-my-pi.dev) agent core; the egress firewall is
[iron-proxy](https://github.com/ironsh/iron-proxy) (Go, used unmodified).

---

## Architecture

### The model: three primitives

1. **Spaces** — a space is a durable shared timeline (messages + work items +
   participants) with its own policy. A Slack channel is a space
   (`slack:<channel_id>`; threads share the channel space in v1). The space,
   not the agent, owns the conversation: anyone can talk, steer, interrupt,
   or approve at any time, and the timeline just keeps appending.
2. **Work items** — the only thing an agent does autonomously. Each runs as
   a scoped agent session with its own workspace, tool allowlist, policy
   context, and audit trail, so parallel work is safe by construction; only
   the conversation serializes in the space.
3. **Actions & policy** — every agent action crosses one policy gate:
   `tier × space policy × roles → allow | deny | ask-human`. Unknown action →
   deny. Policy error → deny. Fail closed is the default.

### Components

```
 Slack (Socket Mode — no public ports)
        │  adapter validates & normalizes (the ONLY ingress)
        ▼
┌─────────────────────────── server (Bun) ───────────────────────────┐
│  slack.ts          Bolt adapter: message → space, replies, buttons  │
│  space-service.ts  one AgentSessionDriver per ACTIVE space          │
│  agent-driver.ts   AgentDriver abstraction (agents are pluggable)   │
│  acp-driver.ts     ACP driver: spawns any ACP agent (e.g. omp acp)  │
│  policy/*          action gate + approval router + audit writer     │
│  delivery-poller.ts  posts "PR ready" announcements to the channel  │
│  index.ts          wiring: store + adapter + driver + extensions    │
└───────────────────────────────────┬──────────────────────────────────┘
                                    │ SQLite (data/bottega.db, WAL)
┌─────────────────────────── executor (Bun, container) ──────────────┐
│  polls work_items (atomic claim) → workspace per item → agent       │
│  session (AgentDriver, pre-approved policy scope) → branch → PR     │
└───────────────────────────────────┬──────────────────────────────────┘
                                    │ all outbound traffic
                        ┌───────────▼───────────┐
                        │  iron-proxy sidecar   │  default-deny allowlist,
                        │  auth-broker/gateway  │  LLM-judge, DNS sinkhole,
                        └───────────────────────┘  secrets at the boundary
```

### Agent driver abstraction (agents are pluggable)

The agent is **not** hardwired to OMP. Everything that talks to an agent —
the space service, the executor — depends only on the `AgentDriver` /
`AgentSessionDriver` interfaces in `src/server/drivers/agent-driver.ts`:

```ts
interface AgentSessionDriver {
  prompt(text, opts?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  abort(): Promise<void>;
  isStreaming(): boolean;
  on(event: "message" | "turn_start" | "turn_end" | "error", cb): () => void;
  dispose(): Promise<void>;
}
interface AgentDriver {
  createSession({ spaceId, transcriptDir, onOutput, cwd?, allowTools? }): Promise<AgentSessionDriver>;
}
```

- **`createOmpSdkDriver`** (default) wraps the OMP SDK. It owns all
  OMP-specific wiring: the space-agent tool allowlist (conversation/read-only
  tools + `task` + `create_work_item`/`work_item_cancel`; **no** bash/write
  on the space agent), file-backed transcripts
  (`data/sessions/<space-id>.jsonl`), a private agent registry per session,
  and the policy + audit extensions.
- **`createAcpDriver`** spawns any ACP-speaking agent (default `omp acp`)
  over stdio JSON-RPC 2.0 (newline-delimited, per the ACP v1 spec). This is
  how a non-OMP agent plugs in later without touching bottega code. OMP is
  the first engine, not a dependency. The org config selects the space-agent
  driver with `agent.driver: acp | omp-sdk` (default `omp-sdk`; the ACP flip
  is opt-in via config until proven — issue #26).
- ACP sessions enforce policy over `session/request_permission`: every
  inbound permission request runs through the same policy table the OMP
  extensions use (tier × org config + space overlay → allow | deny |
  ask-human), with audit on every decision. Unknown tools deny (fail
  closed); ask-human routes through the same Slack button `ApprovalRouter`
  as the OMP driver (issue #44), or `DenyRouter` in headless contexts.
  With `agent.driver:
  acp`, the bottega MCP server attaches to each session so bottega's own
  tools stay reachable. The MCP surface is the **universal agent seam**
  (issues #25/#61): memory (memory.save/search), the connect capability
  (connect_extension), and every registered extension's manifest tools —
  executed server-side through the same policy gate → credential ladder →
  egress boundary → audit spine as in-session OMP tool calls, so any agent
  (OMP, ACP, or future) gets identical enforcement. The tradeoff vs the OMP
  driver is interception depth: ACP gives allow/deny only, no arg rewriting
  or output redaction.

### Policy & approvals

`src/policy/` implements the gate:

1. **Tier** comes from the tool declaration (read / write / exec); unknown
   tools are treated as exec, and unknown *names* always deny.
2. **Policy** = org floor (`config.yml`, fail-closed when absent: everything
   denies) + space overlay (`spaces.policy_json`, can only tighten). Strict
   YAML-subset parsing; any structural error fails the policy closed.
3. **Decision precedence** (issue #45): explicit tool `deny`/`prompt` wins →
   `approvals.always_approve` contains the tool → allow → tier logic
   (`prompt` and `exec` tier → `ask-human`; read/write + allow → allow).
   Exec never fails open.
4. **ask-human** posts an interactive Approve/Deny prompt to the space
   channel (Slack block actions `bottega_approve` / `bottega_deny`, issue
   #44) and resolves when a human clicks; the message is rewritten with the
   outcome. Headless contexts (the executor) use `DenyRouter` — every
   ask-human request there denies. Timeout (`approvals.timeout_minutes`,
   default 5 min) → deny, prompt rewritten to expired.
5. **`approvals.always_approve`** (org floor only; default off) lists
   exec-tier tools that skip the ask-human prompt when their policy action
   is `allow` — the space overlay can only *remove* entries, never add.
   Auto-approvals audit `approval.resolved` with `approver: "policy"`.
6. **Every decision** is audited (`policy.decision` with tool/tier/decision/
   reason; args redacted), and every ask-human round-trip additionally
   writes `approval.requested` / `approval.resolved` (approver = the Slack
   user who clicked).

**Response mode** (`response_mode: always | mention | request-only`, default
`always`) controls when the space agent acts at all (issue #55). `always` is
today's behavior: every non-bot message is a turn. `mention` spaces only
forward messages that @mention the bot (DMs always pass), so unmentioned
channel chatter never reaches the agent. `request-only` spaces forward
everything (context stays coherent) but append a system-prompt directive
telling the agent to act only on explicit requests. The org floor sets it in
`config.yml`; the space overlay (`spaces.policy_json`) may change it but can
only tighten (`always` → `mention` → `request-only`) — a looser overlay value
is clamped to the org floor, mirroring the tools rule.

**Extension policy** (`extensions:`, issue #56) gates which extensions a space
may use at all, and whether org-scoped credentials may be used there:

```yaml
extensions:
  allow: [linear, github]   # non-empty = only these ids are usable
  deny: [attio]             # never usable; deny wins over allow
  org_credentials: deny     # allow (default) | deny — org usage in auto scope
```

- `allow`/`deny` take registered extension ids; empty lists mean no
  restriction (the registry is the base allowlist). Unknown ids in either
  list are a structural error — the policy fails closed.
- The space overlay can only tighten: `extensions.allow` lists ids to
  *remove* from the org floor, `extensions.deny` lists ids to *add*, and
  `org_credentials` clamps like response mode (`allow` → `deny`, never back).
- Extension tool calls resolve against the allowlist **before** tier and
  approval logic — a denied extension is denied outright (with reason +
  audit) and never reaches credential resolution. `org_credentials: deny`
  makes the credential ladder's `auto` scope skip org credentials.

Executor sessions run with `preApproved: true` policy scope: the work item's
pickup approval (the human-approved `create_work_item` call in the channel)
**is** the authorization. Allowlisted exec tools are then permitted inside
the workspace, while unknown tools still deny and explicit deny/prompt
policies are never bypassed.

### Extension registry (typed integrations)

`src/extensions/` implements the registry (issue #50): an extension is a
typed, declarative integration — **manifest + pinned spec snapshot + vault
binding + policy**:

1. **Manifest** (`manifest.ts`) — `{ id, label, vendor, kind: "mcp" | "cli",
   mcp?: {serverUrl | command, transport}, cli?: {command, args, env?},
   credentialSchema: {type: oauth | api_key, scopes?}, tools: [{name, tier,
   description, params}], domains: [egress allowlist entries] }`. `kind`
   decides the integration: **mcp** = the provider's OFFICIAL MCP server
   (bottega never implements provider API clients), **cli** = a preinstalled
   CLI in the tools image that bottega shells out to. Validation fails
   closed: duplicate ids, malformed schemas, unresolvable bindings, tool
   names shadowing runtime built-ins — anything invalid is rejected, never
   partially registered.
2. **Pinned spec snapshot** (`registry.ts`) — registration resolves the
   provider's spec from the integrations.sh catalog and snapshots it locally
   PINNED: per-org deployments resolve from `config/extensions/<id>.json`
   files, never from the catalog at runtime. Snapshot format:
   `{ schema: "bottega.extension-snapshot.v1", extensionId, pinnedAt,
   source: { catalog, specId, vendorOfficial, reviewed }, manifest }`.
   Community entries (`vendorOfficial: false`) require explicit
   `reviewed: true` before they register. The catalog fetch itself
   (integrations.sh) is a later issue; it only writes these files.
3. **Vault binding & policy** — `credentialSchema` declares what the vault
   must hold (oauth scopes / api_key); the broker/vault wiring and the three
   provider extensions are their own issues. Tool `tier` declarations feed
   both the SDK approval tier and the policy gate.
4. **Wiring** — registry tools become SDK definitions (`tools.ts`) that ride
   the custom-tools path into the space agent's restricted toolset; mcp
   tools call the provider's official MCP server (streamable-http or stdio),
   cli tools spawn the preinstalled command with `--name value` flags.
   Extension `domains` merge into the iron-proxy allowlist via
   `src/egress/generate.ts` (run `bun run src/egress/generate.ts` after
   adding snapshots; `config/egress.yml` is the generated artifact).
5. **Runtime** (`runtime.ts`, issue #53) — every extension tool call crosses
   the safety spine: **policy gate first** (the extension allowlist +
   manifest tier, shared with the in-process policy extension) → **credential
   ladder** (`credentials.ts`, org/me/auto scopes over the store's registry
   rows) → **egress boundary** (`boundary.ts`: the resolved credential is
   written to the extension's secret file on the shared data volume, mode
   0600, and iron-proxy's `secrets` transform **injects** it as the
   `Authorization` header for the extension's allowlisted domains — the
   call itself carries no credential, so nothing reaches agent env,
   transcripts, or audit) → provider call → audit. Every call writes
   `extension.call` `{extension, tool, actor, credential_id, decision}`;
   denied calls never resolve a credential. The broker secret fetch that
   feeds the boundary is the real-provider issue's wiring; until then calls
   fail closed at the boundary.
6. **Agent-agnostic surface** (`src/mcp/server.ts`, issue #61) — the bottega
   MCP server (attached to every ACP session via `mcpServers`, #26)
   advertises `connect_extension` + each registered extension's manifest
   tools and executes them **server-side** through the same #53 runtime /
   #52 connect capability. The gate, ladder, boundary, and audit apply
   identically to every agent — no per-agent adapters. Headless MCP
   contexts have no approval channel: ask-human fails closed (DenyRouter).
7. **Connect intent seam** (`src/server/services/space-service.ts`, issue
   #61) — inbound Slack messages matching the narrow patterns
   `connect <extension>`, `connect <extension> as org`, `connect
   <extension> as me` route directly to the connect capability: no agent
   tool call, no session. Exact shapes only (case-insensitive; anything
   with extra words, punctuation, or keys stays natural-language agent
   territory). Bare / `as me` connects the sender's personal account
   (unprivileged); `as org` crosses the policy gate with the space's
   Slack approval router. api_key-type extensions still need the agent
   tool (or CLI) to supply the key.

The test-only fixture extension (`fixture.ts`) proves the shape end to end:
registered → resolves → its tool appears in the space agent's toolset → its
domain lands in the merged egress allowlist. No extension implementations
ship in this issue — the three providers are their own issues.

#### CLI surface (thick tools image + spawn path)

`kind: "cli"` extensions run curated, preinstalled CLIs — zero client code,
no SDK. Two pieces (issues #58, #62):

1. **Tools image** (`Dockerfile.tools`) — oven/bun:1 plus the curated CLI
   set v1: `gh`, `jq`, `git`, `curl` (Debian distro packages, installed
   non-interactively). NO credentials are baked in, ever. The app image
   (`Dockerfile`) builds **FROM** the tools image (issue #62), so the
   single `bottega:${BOTTEGA_IMAGE_TAG}` image — used by BOTH the server
   and the executor entrypoints — carries the CLIs live on PATH in the
   executor container; build the tools image first
   (`docker build -f Dockerfile.tools -t bottega-tools:ci .`). The tools
   image is built in the CI **docker** job (not the fast check/test job)
   so the default CI stays under 5 minutes, and locally for extension
   development. Push/pull of a cached build from a registry is a deploy
   concern, not this job's.
2. **Spawn path** (`src/extensions/tools.ts`) — a cli tool executes the
   manifest's binary with the manifest's fixed `args` first, then the
   call's params as `--name value` flags (`--name` alone for boolean
   true). The child env is the parent env minus credential-named variables
   (`CREDENTIAL_ENV_RE` in `manifest.ts`), plus the manifest's
   credential-free `env` delta — a manifest that declares a credential in
   `cli.env` is rejected (fail closed).

**Credentials never travel via env.** Auth for CLI tools happens at the
iron-proxy boundary: the executor points `HTTPS_PROXY` at iron-proxy, the
egress allowlist (`src/egress`) gates which domains are reachable, and the
proxy injects the credential for the allowlisted domain at request time.
Per-request credential selection (caller/scope → credential id) is the
runtime's concern (issue #53); this surface delivers the spawn path and
the no-credential-in-env guarantee. gRPC-heavy CLIs (gcloud, kubectl) do
not fit the HTTP-proxy boundary and get partial support (documented
limitation): they can run for non-authenticated operations, but
credentialed gRPC calls are not supported.

### Data flow: "issue shared in Slack gets implemented"

```mermaid
sequenceDiagram
    participant H as Human in #team
    participant A as Slack adapter
    participant S as Space service
    participant P as Policy gate
    participant E as Executor
    H->>A: "Can we fix the flaky checkout?"
    A->>S: validated {space, principal, text}
    S->>S: agent session (driver): steer or prompt
    S->>A: reply streams to the channel
    H->>A: "@agent take this" (pickup is explicit)
    A->>S: create_work_item (exec tier)
    S->>P: ask-human → H approves (v1: anyone in channel)
    P->>S: approved → work item open
    E->>E: claims row (atomic) → working, workspace, clone, branch
    E->>E: agent session (pre-approved scope) implements
    E->>E: push branch → PR via GitHub API (PAT from 0600 file)
    E->>S: delivery_pending marker + evidence
    S->>A: "PR ready: <url> — approve to finish" (delivery poller)
    S->>S: approval recorded → review → done (requires pr_url)
```

### Safety model

| Threat surface | Control |
|---|---|
| Untrusted ingress | Adapters validate every event; only adapters mint messages |
| Credential exposure | Provider keys in auth-broker vault; Slack tokens only in server `.env`; git PAT only in a mode-0600 file on the data volume; OMP secret obfuscation (`secrets.enabled`) |
| Malicious repo content | Work items run in the executor container in disposable workspaces; server never mounts repo paths |
| Exfiltration / rogue egress | All outbound traffic through iron-proxy: default-deny allowlist (model endpoints: cloud-api.near.ai, *.completions.near.ai), LLM-judge on allowlisted traffic, DNS sinkhole (containers resolve only through the proxy) |
| Unauthorized side effects | Policy gate on every tool call; exec prompts to humans; unknown → deny |
| Data loss / tampering | Append-only audit (SQLite triggers reject UPDATE/DELETE), transcripts retained, never deleted |
| Failure | Fail closed: parse errors, policy errors, model outages, missing tokens → deny or block with evidence |

### Persistence & audit

One SQLite file (`bun:sqlite`, WAL, busy_timeout for the server+executor
two-process share), migrated idempotently at boot:

- `spaces` — space registry + per-space policy overlay.
- `work_items` — the queue and the state machine: `open → claimed → working
  → review → done | blocked | aborted`, with a legal-move map enforced in the
  store (single choke point) and obligations: `done` requires a `pr_url`,
  `blocked` requires evidence, `review` requires a recorded approval. Stale
  rows (`claimed`/`working` past a TTL) are recovered to `blocked` with
  evidence on boot.
- `audit` — append-only; UPDATE/DELETE rejected by triggers. Every policy
  decision, approval, tool call (redacted), and work-item transition is a
  row. Payloads are redacted (secret-shaped values → `[REDACTED]`) and capped
  at 4 KB before write.

The space timeline itself is the OMP session file (`.jsonl` under
`data/sessions/`) — durable by construction, never deleted.

### Multiplayer & concurrency

- Many humans + one space agent: prompts during a stream **steer** (or queue
  as follow-ups); anyone can interrupt (`abort`).
- Idle spaces dispose their session (default 30 min) and cold-start on the
  next message — disposal is cache eviction, never data loss.
- Work items are independent sessions: parallel work is isolated by design.
- One process, many sessions: each session gets a private agent registry
  (OMP SDK requirement for concurrent top-level sessions).

---

## Repository layout

```
src/
  server/           index.ts (composition root)
  server/adapters/  slack.ts
  server/drivers/   agent-driver.ts (AgentDriver + OMP SDK), acp-driver.ts
  server/services/  space-service.ts, delivery-poller.ts
  policy/           config.ts, extension.ts, approval-router.ts, audit.ts
  extensions/       registry (manifest + pinned snapshots + tool bridge)
  store/            db.ts, schema.sql
  tools/            work-items.ts, memory.ts, helpers.ts
  memory/           sqlite.ts, mem0.ts, types.ts (providers behind one interface)
  mcp/              server.ts (bottega-hosted MCP surface: memory + connect + extension tools, #25/#61)
  executor.ts       containerized work-item runner (claim → PR)
  yaml-subset.ts    shared strict YAML-subset parser (configs + tests)
  egress/           generate.ts (allowlist from extension domains) + tests: compose topology, egress.yml, iron-proxy leg
  secrets/          broker/gateway wiring + tests: credential boundary, omp templates, agent-dir
config/
  extensions/       pinned extension snapshots (one JSON per extension)
  egress.yml        generated iron-proxy allowlist + judge policy
  omp/              config.yml (secrets.enabled), secrets.yml, models.yml
  org.yml           executor repos + git base
  entrypoints/      broker.sh (auth-broker token bootstrap)
Dockerfile          single image (server + executor entrypoints), bun user
docker-compose.yml  server, executor (profile), auth-broker, auth-gateway, iron-proxy, mem0
slack-app-manifest.yml
scripts/smoke.sh    local checks + manual checklist
scripts/e2e-smoke.sh  compose e2e smoke leg: fail-closed boots + wiring (skip-gated)
```

## Deployment

### Prerequisites

- Docker with Compose v2 (`docker compose version`)
- A Slack workspace where you can create apps
- A GitHub org/repo the bot may push branches and open PRs to
- Bun 1.3+ only for local development (`bun check`, `bun test`)

### 1. Create the Slack app

`slack-app-manifest.yml` in this repo declares the app (Socket Mode, bot
scopes, event subscriptions).

1. Open <https://api.slack.com/apps> → **Create New App** → **From an app
   manifest** → paste the contents of `slack-app-manifest.yml` → **Create**.
2. **Install to Workspace** and copy the **Bot User OAuth Token**
   (`xoxb-...`) — that is `SLACK_BOT_TOKEN`.
3. **App-Level Tokens** → **Generate Token** with the `connections:write`
   scope and copy it (`xapp-...`) — that is `SLACK_APP_TOKEN`. Socket Mode
   needs it; no request URL is required.

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
| `OPENAI_API_KEY` | mem0 memory backend key (#43) | The stack runs a self-hosted mem0 server by default; it refuses to boot without an LLM key (fail-closed). Not needed when memory runs on the SQLite fallback |
| `GITHUB_PAT` | Git credential | Install into the volume file, see step 3; never in env |
| `BOTTEGA_IMAGE_TAG` | Image tag to run | `local` by default; pin a build sha for rollback (step 5) |

Memory backend (issue #43): `MEM0_BASE_URL` is prefilled in `.env.example`
(internal compose URL), so memory starts on the self-hosted mem0 service out
of the box — give it an LLM key (`OPENAI_API_KEY`, above). To run the SQLite
memory fallback instead, set `MEM0_BASE_URL=` (empty) in `.env`; the server
then treats it as unset and ignores the mem0 service.

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
> built from the repo root) and differ only in entrypoint. The executor runs
> only when the `executor` profile is enabled, as above. To run without the
> executor, drop `--profile executor`.

### Which repo does the executor work in?

The repo is a property of the task, not of the deployment (issue #47): the
agent derives it from the conversation — a mentioned repo, or org memory —
and passes it to `create_work_item` ("fix the flaky checkout in bottega"
→ `repo: "acme/bottega"`). Org memory is how the agent knows the repo
names; seed an org-scope entry so it can answer "which repo?" without
asking:

```bash
# via the memory.save tool in any space:
memory.save {scope: "org", content: "our repos are acme/sandbox, acme/tooling"}
```

The executor treats `config/org.yml` `repos` (or `EXECUTOR_REPOS`) as an
**allowlist**: it refuses any repo not listed, whatever the conversation
said. A work item with no repo at all is blocked with
"repo not specified — ask the requester" — there is no first-configured-repo
fallback. An empty allowlist means no pushes until a repo is configured.

### First-run checklist

1. `docker compose logs -f server` — no errors, bot connects via Socket Mode.
2. Invite the bot into a channel and @mention it — it should reply (the
   space agent answers in-channel).
3. Create a test work item (the `create_work_item` tool, passing a `repo`
   that is on the allowlist — see "Which repo does the executor work in?"
   below) — the executor claims it (`docker compose logs -f executor`),
   implements it in a workspace, opens a PR, and the server posts
   `PR ready: <url> — approve to finish` in the channel.
4. Restart persistence: `docker compose down && up` — spaces, work items,
   and the audit trail survive (they live on the `data` volume).

### Backup & rollback

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
  anything outside the `config/org.yml`/`EXECUTOR_REPOS` allowlist; a work
  item without a repo is blocked for the requester to specify. One shared
  executor container (no per-item container isolation yet).
- **Slack only** — Telegram, Teams, Meet, and the org observer are roadmap
  (issue #13 is the Telegram adapter).

## Roadmap

- Delivery approval buttons (resolving `working → review → done`
  in-channel) — completes the delivery loop; in-session approvals already
  resolve via buttons (issue #44).
- Telegram adapter (grammY, long polling) — #13.
- Per-work-item container isolation (deployment-only change).
- Roles (explicit approvers) and SSO.
- Non-OMP agents via the ACP driver — already wired, needs a second engine.

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
for the PR-creation path (no live GitHub needed). Everything else is hermetic
unit tests over real SQLite; nothing hits a live LLM, Slack, or GitHub.
