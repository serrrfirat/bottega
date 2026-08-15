# bottega

Team agents that live in your chat. Slack/Telegram spaces where people and
agents work together: issues get picked up, implemented, and delivered, with
every action policy-gated and audited.

Per-org self-hosted. Bun + TypeScript on the OMP agent core, iron-proxy as the
egress gate, SQLite for state.

## Design (approved)

Three primitives:

- **Spaces** — durable shared timelines (Slack channel/thread = a space) with
  participants, policy, and work items.
- **Work items** — the only thing agents do autonomously; each runs as a
  scoped subagent in the executor container, with its own policy, sandbox, and
  audit trail.
- **Actions & policy** — every agent action crosses one policy gate:
  `tier × space policy × roles → allow | deny | ask-human` (approvals routed
  to the channel as buttons). Unknown → deny. Fail closed.

New code is four files: `server.ts` (Slack/Telegram adapters + space
sessions), `executor.ts` (containerized work-item runner), `policy.ts` (the
extension: policy gate + audit), and one compose file (server + executor +
iron-proxy + SQLite volume).

## Secrets & credentials (issue #9)

Provider keys and channel tokens never reach agent environments:

- **Vault**: `auth-broker` (OMP) is the only writer of provider credentials;
  `auth-gateway` fronts it for OpenAI-compatible clients. Both are
  internal-network-only compose services with no published ports. The
  executor env carries no provider keys, no channel tokens, no PATs.
- **Bearer token**: generated at broker first boot by
  `config/entrypoints/broker.sh` into the data volume
  (`/data/.omp/auth-broker.token`, mode 0600). The gateway resolves it from
  the same volume; server/executor get it via `OMP_AUTH_BROKER_TOKEN` in
  `.env` (copy once: `docker compose exec auth-broker cat /data/.omp/auth-broker.token`).
- **Obfuscation**: `config/omp/config.yml` sets `secrets.enabled: true`;
  org secrets live in `config/omp/secrets.yml` (mode `obfuscate` — restored
  before tool execution, scrubbed before anything reaches a provider). The
  audit module's regex redactor (issue #7) stays on as a second layer.
- **Agent config**: `config/omp/` is mounted at `data/omp-agent`, the SDK
  `agentDir` created at server boot. Edit the templates per deployment;
  model provider wiring lives in `config/omp/models.yml` (NEAR.ai via
  `NEAR_API_KEY`).

## Status

Design approved. Not built. Build order:

1. Chat with the agent in Slack (Socket Mode)
2. Policy + approvals + audit + egress
3. Work items: issue -> PR
