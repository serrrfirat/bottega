# Bottega

<p align="center">
  <img src=".github/assets/hero.png" alt="Illustration of people and AI collaborators working together in the Bottega workshop" width="100%">
</p>

**An AI co-worker that lives in your Slack and picks up real work for your
org.** Update the CRM, chase a follow-up, run the weekly ops chore, answer
the question nobody has time to dig into, ship a fix — ask in the channel,
and it turns the conversation into tracked, delivered work. It remembers what
your team teaches it, follows the rules you set, and leaves a receipt for
everything it does.

Self-hosted, per-org: your data, your models, your infrastructure. One
`docker compose` stack, no public ports.

## What working with it looks like

> **you:** we just signed Meridian — can someone get them set up?
> **bottega:** I can take it: mark the Meridian deal as Closed Won in
> Attio and create the onboarding tickets in Linear from our standard
> checklist. Want me to?
> **you:** @bottega yes, take it
> **bottega:** *[Approve / Deny]* — create work item: Meridian onboarding
> (Attio + Linear)
> **you:** *clicks Approve*
> **bottega:** Done — Attio deal moved to Closed Won, 6 onboarding tickets
> created in Linear: linear.app/acme/project/meridian-onboarding.

Next door, the platform channel asks the same co-worker to fix a flaky
retry path and gets back a pull request. Support asks it a question and
gets an answer sourced from the org's own docs and decisions. Ops has it
running the weekly chores on a schedule. Every ask, in any channel, becomes
a tracked work item — gated by your policies, delivered as whatever the
task calls for, never silently dropped.

## What you get

- **A colleague for the whole org, not a coding tool.** Work items can be
  delivered as code (a PR), as actions in your connected tools (Linear,
  Attio, GitHub), or as an answer in the channel — one queue, one lifecycle,
  one audit trail for all of it.
  For in-channel answers, the agent answers first and then completes the chat
  work item with a summary.
- **A shared teammate, not a private chatbot.** The whole channel talks to
  the same agent. Anyone can steer, interrupt, or approve — the agent
  belongs to the team, not to one person's DM.
- **Work that's tracked and accountable.** Asking for work creates a work item
  with a lifecycle: picked up, executed, delivered, or blocked with
  evidence — never silently dropped.
- **A different hat per team.** Each space can give the agent a department
  persona — the support channel's co-worker and the platform channel's
  co-worker carry different instructions and different tools.
- **A memory your org owns.** It learns your repos, conventions, and
  decisions — per person or org-wide — and uses them in every later
  conversation. Point it at your docs and it ingests them too.
- **Your tools, one safe pipe.** Connect GitHub, Linear, or Attio from chat
  (`connect github as me`). Credentials live in a vault and are injected at
  the network edge — they never touch the agent, the chat, or the logs.
- **Policies, enforced.** Every action crosses a policy gate you configure.
  Risky actions post an Approve/Deny button in the channel and wait for a
  human. Anything unknown or misconfigured is denied by default.
- **It shows up on its own — when invited.** Opt-in standups, daily
  reflections, a weekly org pulse, and recurring scheduled work — the
  repeating chores a team usually forgets. Quiet by default; spaces choose
  what they want.
- **A receipt for everything.** Every decision, approval, and tool call
  lands in an append-only audit trail that can't be edited or deleted.
- **Pick your model per task.** Fast model for quick things, reasoning
  model for hard ones — switched from chat, per space, no restarts.

## How the executor delivers approved work

The executor claims approved work items from the durable queue so each item
has an accountable worker. For repository work, it clones the allowlisted
repository into a fresh, isolated workspace, runs the work there, and delivers
the result without sharing a checkout with another item. It records the claim,
delivery result, and approval in the audit trail; failures, denied delivery,
or missing prerequisites move the item to `blocked` with evidence instead of
dropping it silently.

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
2. Provision Slack and model credentials in the auth-broker vault with
   `connect_upload_link` (ids `slack-app`, `slack-bot`, `opencode`, `near`,
   `openai`, `anthropic`, `github-webhook`). `.env` is the local fallback.
   Model credentials are synchronized into iron-proxy's secret boundary;
   SDK requests carry placeholders, not provider keys.
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
