#!/usr/bin/env bash
# Resolves the dev topology's CANONICAL data dir (issue #293): the git
# worktree that OWNS the current one — per the repo convention that
# worktrees live in `<checkout>/.worktrees/<name>`, ascend out of any
# `.worktrees/<name>` nesting; the nearest ancestor that is NOT inside a
# `.worktrees/` dir is the canonical checkout. That checkout's data/ is the
# SHARED runtime store (tunnel public base, proxy token, vault token) every
# worktree-started process reads/writes.
#
# Sourced by scripts/dev.sh (exports BOTTEGA_PUBLIC_BASE_URL_FILE to the
# server) and scripts/tunnel.sh (defaults the store it writes) so a dev
# server restarted from ANY worktree and a tunnel run from ANY checkout
# agree on ONE store — the bug this fixes: a server restarted from a
# feature worktree (whose local data/ has no public-base-url) fell back to
# loopback URLs for upload links and OAuth callbacks while the canonical
# checkout's store held the live tunnel URL.
shared_data_dir() {
  local dir
  dir="$(pwd)"
  while [[ "$(basename "$(dirname "$dir")")" == ".worktrees" ]]; do
    dir="$(dirname "$(dirname "$dir")")"
  done
  printf '%s/data\n' "$dir"
}
