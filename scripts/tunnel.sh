#!/usr/bin/env bash
# bottega durable public-base tunnel companion (issue #249).
#
# cloudflared quick tunnels ROTATE their public host every time the process
# restarts, and the server used to freeze BOTTEGA_OAUTH_CALLBACK_BASE_URL in
# .env at boot — so every rotation broke connects/uploads until a human
# edited .env and restarted the server. This script is the fix's other half:
# it runs cloudflared, extracts the CURRENT trycloudflare URL, and writes it
# to the durable public-base store (data/public-base-url, mode 0600) that
# uploadLinkPublicBase() re-reads on EVERY mint — a rotation heals the next
# connect/upload with no .env edit and no server restart. It keeps running
# until interrupted, restarting cloudflared (bounded backoff) if it dies, so
# the store always tracks the live tunnel.
#
# The tunnel forwards the server's ONE stable inbound listener
# (BOTTEGA_CALLBACK_PORT, default 64204) serving /upload/*, /oauth/callback,
# and /webhooks/*. Egress: local dev already routes server egress through
# the dev-permissive iron-proxy (config/egress.dev.yml: allow-list "*" + no
# judge), so the rotating *.trycloudflare.com host passes through unchanged;
# the strict config/egress.yml (deployment, default-deny) keeps its fixed
# DNS host via the BOTTEGA_OAUTH_CALLBACK_BASE_URL override — no egress
# config changes needed here.
#
# Usage:
#   scripts/tunnel.sh                          # foreground until interrupted
#   BOTTEGA_CALLBACK_PORT=7777 scripts/tunnel.sh
#   BOTTEGA_PUBLIC_BASE_URL_FILE=/tmp/base scripts/tunnel.sh   # store override
set -euo pipefail
cd "$(dirname "$0")/.."

# Issue #293: the store is SHARED across worktrees — the CANONICAL
# checkout's data/ (resolved by shared-data-dir.sh), never this script's
# own cwd: a tunnel run from any checkout must write the file the dev
# server (started from any worktree, scripts/dev.sh) reads. The env
# override still wins (tests / unusual data layouts).
. "$(dirname "$0")/shared-data-dir.sh"

PORT="${BOTTEGA_CALLBACK_PORT:-64204}"
PUBLIC_BASE_FILE="${BOTTEGA_PUBLIC_BASE_URL_FILE:-$(shared_data_dir)/public-base-url}"
TARGET="http://127.0.0.1:${PORT}"

command -v cloudflared >/dev/null 2>&1 || {
  echo "bottega tunnel: cloudflared not found (install it: brew install cloudflared)" >&2
  exit 1
}

mkdir -p "$(dirname "$PUBLIC_BASE_FILE")"

# Atomic write (tmp + mv) so a concurrent mint never reads a half-written
# file; mode 0600, like the git-token file (data/secrets/github-pat).
write_public_base() { # <url>
  local url="$1" tmp="${PUBLIC_BASE_FILE}.tmp.$$"
  umask 077
  printf '%s\n' "$url" >"$tmp"
  mv -f "$tmp" "$PUBLIC_BASE_FILE"
  echo "bottega tunnel: public base -> ${url} (${PUBLIC_BASE_FILE})"
}

# Start cloudflared and wait for its quick-tunnel URL (deadline 30s). Prints
# the URL on success; fails loudly (log tail) if the process dies first or
# never announces a URL.
start_tunnel() { # -> url
  local log pid url waited
  log="$(mktemp)"
  cloudflared tunnel --url "$TARGET" --no-autoupdate >"$log" 2>&1 &
  pid=$!
  url=""
  waited=0
  while (( waited < 30 )); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "bottega tunnel: cloudflared exited before announcing a URL:" >&2
      tail -n 15 "$log" >&2 || true
      rm -f "$log"
      return 1
    fi
    url="$(grep -om1 -E 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" 2>/dev/null || true)"
    if [[ -n "$url" ]]; then
      rm -f "$log"
      echo "$url"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "bottega tunnel: no quick-tunnel URL within 30s — cloudflared log tail:" >&2
  tail -n 15 "$log" >&2 || true
  rm -f "$log"
  kill "$pid" 2>/dev/null || true
  return 1
}

# Keep running until interrupted; re-write the store every time cloudflared
# restarts with a rotated host.
while true; do
  if ! url="$(start_tunnel)"; then
    echo "bottega tunnel: retrying in 5s..." >&2
    sleep 5
    continue
  fi
  write_public_base "$url"
  if wait; then
    echo "bottega tunnel: cloudflared exited; restarting..." >&2
  else
    echo "bottega tunnel: cloudflared failed (exit $?); restarting in 5s..." >&2
    sleep 5
  fi
done
