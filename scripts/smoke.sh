#!/usr/bin/env bash
# bottega smoke check (issue #12).
#
# Local verification legs (no external services touched): typecheck, test
# suite, and compose file validation. Then prints the manual checklist for
# the parts that need real infra (Slack workspace, GitHub repo, live
# containers).
#
# Usage: scripts/smoke.sh   (from anywhere in the repo)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> bun check"
bun check

echo "==> bun test"
bun test

if command -v docker >/dev/null 2>&1; then
  echo "==> docker compose config --profile executor"
  docker compose --profile executor config -q
  echo "compose file is valid (executor profile)."
else
  echo "==> docker not found — skipping compose validation (install Docker Desktop)."
fi

echo
echo "Automated e2e leg (no real credentials, needs Docker): scripts/e2e-smoke.sh"
echo "  boots the compose stack with placeholder env, asserts fail-closed"
echo "  guards + broker token + SQLite schema, then tears down."
echo
echo "Manual checklist (needs real infra):"
echo "  1. Create the Slack app from slack-app-manifest.yml and install it"
echo "     to your workspace; generate an app-level token (connections:write)."
echo "     Fill SLACK_APP_TOKEN / SLACK_BOT_TOKEN in .env."
echo "  2. Fill .env from .env.example (Slack tokens, provider keys,"
echo "     NEARAI_JUDGE_API_KEY for the egress judge). The app image"
echo "     inherits the tools image (issue #62), so build it first, then:"
echo "     docker build -f Dockerfile.tools -t bottega-tools:ci ."
echo "     docker compose --profile executor up -d --build"
echo "  3. The broker creates data/.omp/auth-broker.token (mode 0600) on"
echo "     first boot; compose services read it from the shared volume, so"
echo "     do not copy the bearer into .env."
echo "  4. Install the git PAT (mode 0600, never in env):"
echo "       install -m 0600 <your-pat> data/secrets/github-pat"
echo "  5. Invite the bot to a channel and @mention it — expect a reply."
echo "  6. Create a test work item — expect the executor to claim it, open"
echo "     a PR, and the server to post 'PR ready: <url>' in the channel."
echo "  7. Restart persistence: docker compose down && up — spaces, work"
echo "     items, and audit history must survive (data/ volume)."
echo "  8. Internal web search (issue #388): no search account or API key is"
echo "     required. With the stack running, check SearXNG health:"
echo "       docker compose exec -T searxng wget --spider --timeout=2 http://127.0.0.1:8080/"
echo "     Then ask the bot a current external question with search_web and"
echo "     expect structured cited results (title + URL + snippet per result)."
echo "     DuckDuckGo and Brave are best-effort; public engines may throttle"
echo "     the droplet IP."
