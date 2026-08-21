#!/usr/bin/env bash
# Resolves the dev topology's CANONICAL checkout dir (issue #301/#293): the
# git worktree that OWNS the current one — per the repo convention that
# worktrees live in `<checkout>/.worktrees/<name>`, ascend out of any
# `.worktrees/<name>` nesting; the nearest ancestor that is NOT inside a
# `.worktrees/` dir is the canonical checkout. ITS basename is the shared
# dev Compose project name (issue #301): every worktree pins the SAME
# COMPOSE_PROJECT_NAME so they share ONE egress network (reuse, never a
# fresh <worktree>_egress on the same 172.30.0.0/24 subnet) and ONE proxy/
# broker container set — instead of each worktree colliding on the fixed
# subnet with "invalid pool request: Pool overlaps with other one on this
# address space".
shared_checkout_dir() {
  local dir
  dir="$(pwd)"
  while [[ "$(basename "$(dirname "$dir")")" == ".worktrees" ]]; do
    dir="$(dirname "$(dirname "$dir")")"
  done
  printf '%s\n' "$dir"
}

# The shared dev Compose project name: the canonical checkout's basename.
# Compose scopes the egress network and containers by project name, so
# sharing this name is what makes the dev stack work from ANY worktree.
dev_compose_project() {
  printf '%s\n' "$(basename "$(shared_checkout_dir)")"
}

# Resolves the dev topology's CANONICAL data dir (issue #293): the SHARED
# runtime store (tunnel public base, proxy token, vault token) every
# worktree-started process reads/writes. Sourced by scripts/dev.sh and
# scripts/tunnel.sh so a dev server restarted from ANY worktree and a
# tunnel run from ANY checkout agree on ONE store — the bug this fixes: a
# server restarted from a feature worktree (whose local data/ has no
# public-base-url) fell back to loopback URLs for upload links and OAuth
# callbacks while the canonical checkout's store held the live tunnel URL.
shared_data_dir() {
  printf '%s/data\n' "$(shared_checkout_dir)"
}
