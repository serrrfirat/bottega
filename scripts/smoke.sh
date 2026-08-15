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
echo "Manual checklist (needs real infra):"
echo "  1. Create the Slack app from slack-app-manifest.yml and install it"
echo "     to your workspace; generate an app-level token (connections:write)."
echo "     Fill SLACK_APP_TOKEN / SLACK_BOT_TOKEN in .env."
echo "  2. docker compose --profile executor up -d --build"
echo "  3. Copy the broker token into .env (once):"
echo "       docker compose exec auth-broker cat /data/.omp/auth-broker.token"
echo "     then: docker compose up -d"
echo "  4. Install the git PAT (mode 0600, never in env):"
echo "       install -m 0600 <your-pat> data/secrets/github-pat"
echo "  5. Invite the bot to a channel and @mention it — expect a reply."
echo "  6. Create a test work item — expect the executor to claim it, open"
echo "     a PR, and the server to post 'PR ready: <url>' in the channel."
echo "  7. Restart persistence: docker compose down && up — spaces, work"
echo "     items, and audit history must survive (data/ volume)."
