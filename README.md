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

## Status

Design approved. Not built. Build order:

1. Chat with the agent in Slack (Socket Mode)
2. Policy + approvals + audit + egress
3. Work items: issue -> PR
