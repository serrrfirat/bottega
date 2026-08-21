#!/usr/bin/env bash
# Resolves the dev topology's CANONICAL checkout dir (issue #301/#293): the
# git worktree that OWNS the current one — per the repo convention that
# worktrees live in `<checkout>/.worktrees/<name>`, ascend out of any
# `.worktrees/<name>` nesting; the nearest ancestor that is NOT inside a
# `.worktrees/` dir is the canonical checkout. Its realpath is the shared
# dev identity (issue #301): every worktree of ONE repo pins the SAME
# COMPOSE_PROJECT_NAME (a stable hash of that realpath — see
# dev_compose_project) so they share ONE egress network (reuse, never a
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

# The shared dev Compose project name (issue #301): derived from the
# canonical checkout's REALPATH IDENTITY — not its bare basename — via a
# stable git-backed hash, so worktrees of ONE repo share a name while
# UNRELATED clones (same basename, different path) do NOT collide. Compose
# scopes the egress network and containers by project name; sharing this
# name is what makes the dev stack work from ANY worktree of the same repo.
# The result is a valid Compose project name (lowercase + digits + -/_,
# short, leading letter/digit, well under Docker's 63-char name limit).
dev_compose_project() {
  local checkout hash base
  checkout="$(shared_checkout_dir)"
  hash="$(printf '%s' "$checkout" | git hash-object --stdin 2>/dev/null || true)"
  base="$(basename "$checkout" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-' | cut -c1-20)"
  if [[ -n "$hash" ]]; then
    printf 'bot-%s-%s\n' "$base" "${hash:0:10}"
  else
    # No git available (should not happen inside the repo): fall back to a
    # sanitized basename — still a valid project name, still deterministic,
    # but two unrelated same-basename clones would collide (documented).
    printf 'bot-%s\n' "${base:-dev}"
  fi
}

# The canonical checkout's MITM CA dir (issue #301): the single certs/ the
# shared iron-proxy terminates with. Every worktree's dev server trusts the
# SAME ca.crt (NODE_EXTRA_CA_CERTS), so a second worktree boot NEVER
# generates/MITMs with a different CA than the shared proxy's.
shared_certs_dir() {
  printf '%s/certs\n' "$(shared_checkout_dir)"
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
