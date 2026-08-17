# bottega

**An AI co-worker that lives in your Slack.** Talk to it like a teammate —
it turns conversation into real, tracked work, remembers what your team
teaches it, follows the rules you set, and leaves a receipt for everything
it does.

Self-hosted, per-org: your data, your models, your infrastructure. One
`docker compose` stack, no public ports.

## What working with it looks like

> **you:** the checkout flow is flaky again, I think it's the retry logic
> **bottega:** I see three retry paths in `acme/shop`. The backoff in
> `payment-client` looks wrong — want me to take it?
> **you:** @bottega take this
> **bottega:** *[Approve / Deny]* — create work item: fix retry backoff in acme/shop
> **you:** *clicks Approve*
> **bottega:** PR ready: github.com/acme/shop/pull/482 — approve to finish.

The conversation stays in the channel where the team already works. The
work happens in an isolated workspace, gated by your policies, and comes
back as a pull request.

## What you get

- **A shared space, not a private chatbot.** The whole channel talks to the
  same agent. Anyone can steer, interrupt, or approve — the agent belongs to
  the team, not to one person's DM.
- **Work that's tracked, not vibes.** Asking for work creates a work item
  with a lifecycle: picked up, implemented in an isolated workspace,
  delivered as a PR, or blocked with evidence — never silently dropped.
- **A memory your org owns.** It learns your repos, conventions, and
  decisions — per person or org-wide — and uses them in every later
  conversation. Point it at your docs and it ingests them too.
- **Your tools, one safe pipe.** Connect GitHub, Linear, or Attio from chat
  (`connect github as me`). Credentials live in a vault and are injected at
  the network edge — they never touch the agent, the chat, or the logs.
- **Rules, not hope.** Every action crosses a policy gate you configure.
  Risky actions post an Approve/Deny button in the channel and wait for a
  human. Anything unknown or misconfigured is denied by default.
- **It shows up on its own — when invited.** Opt-in standups, daily
  reflections, a weekly org pulse, and recurring scheduled work. Quiet by
  default; spaces choose what they want.
- **A receipt for everything.** Every decision, approval, and tool call
  lands in an append-only audit trail that can't be edited or deleted.
- **Pick your model per task.** Fast model for quick things, reasoning
  model for hard ones — switched from chat, per space, no restarts.

## Why trust it

bottega is built fail-closed. The agent can only reach the internet through
an egress firewall with an explicit allowlist; everything else gets a 403.
Secrets never enter the agent's environment or the conversation. Repo work
runs in disposable, isolated workspaces. And when anything is ambiguous —
an unknown tool, a broken config, a policy error — the answer is "no" until
a human says otherwise.

## Get started

You need Docker, a Slack workspace, and about fifteen minutes:

1. Create the Slack app from the included manifest.
2. Fill in `.env` (tokens + model key).
3. `docker compose --profile executor up -d --build`

The full walkthrough — including local development, credentials, the
scheduler, and backup — is in **[setup.md](setup.md)**.

## Learn more

- **[features.md](features.md)** — every capability in detail, current
  limitations, and the roadmap.
- **[architecture.md](architecture.md)** — how it works inside: the three
  primitives, the policy gate, the egress boundary, the data model.
- **[setup.md](setup.md)** — development, deployment, and operations.

Built with Bun + TypeScript on the [OMP](https://oh-my-pi.dev) agent core;
the egress firewall is [iron-proxy](https://github.com/ironsh/iron-proxy).
Agents are pluggable by design — OMP is the first engine, not a dependency.
