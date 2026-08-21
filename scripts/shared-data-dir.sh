#!/usr/bin/env bash
# Resolves the dev topology's CANONICAL checkout dir (issue #301/#293): the
# git worktree that OWNS the current one — per the repo convention that
# worktrees live in `<checkout>/.worktrees/<name>`, ascend out of any
# `.worktrees/<name>` nesting; the nearest ancestor that is NOT inside a
# `.worktrees/` dir is the canonical checkout. Its realpath is the shared
# dev identity (issue #301): every worktree of ONE repo pins the SAME
# COMPOSE_PROJECT_NAME (see dev_compose_project — a persistent project id,
# an adopted legacy basename stack, or a realpath hash) so they share ONE
# egress network (reuse, never a fresh <worktree>_egress on the same
# 172.30.0.0/24 subnet) and ONE proxy/broker container set — instead of each
# worktree colliding on the fixed subnet with "invalid pool request: Pool
# overlaps with other one on this address space".
shared_checkout_dir() {
  local dir
  dir="$(pwd)"
  while [[ "$(basename "$(dirname "$dir")")" == ".worktrees" ]]; do
    dir="$(dirname "$(dirname "$dir")")"
  done
  printf '%s\n' "$dir"
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

# The persistent canonical dev Compose project-id file, stored in the SHARED
# data dir (issue #301): once a canonical checkout commits to a Compose
# project name — e.g. by adopting a legacy basename stack, see
# dev_compose_project — every worktree of that repo reads the SAME id here,
# while an UNRELATED same-basename clone (its OWN data dir) never sees it
# and resolves its own identity. This is what lets us keep an existing
# `camp-flavor` stack for this repo even after the naming scheme changed to
# a realpath hash for fresh clones.
legacy_project_id_file() {
  printf '%s/.dev-compose-project\n' "$(shared_data_dir)"
}

# Canonical basename form of a checkout path: take the basename, then
# lowercase it and keep only [a-z0-9-], ≤20 chars — the shared dev Compose
# project name "base" used by legacy adoption and the hashed identity below
# (both stay valid Compose project names: lowercase + digits + -/_, short,
# leading letter/digit).
dev_base_name() { # <abs-path>
  local name
  name="$(basename "$1")"
  printf '%s\n' "$name" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-' | cut -c1-20
}

# Probe whether a compose project named `$1` has a live/stopped iron-proxy
# container, returning its `com.docker.compose.project.working_dir` label (or
# empty when absent / docker unavailable). Env test seam:
# BOTTEGA_DEV_COMPOSE_ADOPT overrides the whole legacy decision in
# dev_compose_project (see there); this probe is the REAL runtime detection.
legacy_working_dir() { # <project-name>
  local proj="$1"
  command -v docker >/dev/null 2>&1 || return 0
  if ! docker container inspect "${proj}-iron-proxy-1" \
      --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
      2>/dev/null | grep -q .; then
    return 0
  fi
  docker container inspect "${proj}-iron-proxy-1" \
    --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
    2>/dev/null
}

# True when `$1` (an absolute path) is the canonical checkout itself or any
# worktree under it (path-prefix ownership test, both realpath-normalized).
is_within_checkout() { # <child-abs-path> <checkout-abs-path>
  local child="$1" root="$2"
  [[ "$child" == "$root" || "${child#${root}/}" != "$child" ]]
}

# The shared dev Compose project name (issue #301). Resolution, in priority
# order:
#
#  1. Persistent project-id file (canonical data/.dev-compose-project): if
#     this canonical checkout already committed to a project id (a legacy
#     basename stack was adopted below), reuse it forever. Because the file
#     lives in the SHARED data dir, every worktree of the repo agrees AND an
#     unrelated same-basename clone (its own data dir) never reads it.
#  2. Legacy adoption: an existing compose project named after the canonical
#     checkout's basename (e.g. `camp-flavor` — created by the pre-#301
#     naming, whose `camp-flavor_egress` network already owns the fixed
#     172.30.0.0/24 subnet) is ADOPTED and its name persisted, so this repo
#     converges onto the running stack (compose recreates the proxy with the
#     canonical data/certs mounts) instead of needing a manual
#     `docker compose down` and leaving the subnet stranded. Adoption is
#     gated on PROVING OWNERSHIP: the existing `iron-proxy` container's
#     `com.docker.compose.project.working_dir` label must resolve under THIS
#     canonical checkout. If a legacy `$base` project exists but its
#     ownership cannot be proven (unrelated same-basename clone, or label
#     missing) the stack FAILS CLOSED — we will not silently attach to a
#     stranger's network NOR create a parallel network on the fixed subnet,
#     and we will not stop/delete an unrelated repo's stack.
#  3. Deterministic hashed identity: `bot-<base>-<10hex>` of the canonical
#     realpath via `git hash-object --stdin` — worktrees of ONE repo share
#     it while unrelated same-basename clones diverge; valid/bounded Compose
#     charset/length. (Covers a fresh checkout with no legacy stack.)
#
# The result is always a valid Compose project name. In the ambiguous case
# (2) we print a loud remedy and `exit 1` — `set -e` in scripts/dev.sh
# propagates it, so the boot never guesses.
#
# TEST SEAM: scripts/dev.sh never sets BOTTEGA_DEV_COMPOSE_ADOPT; caller-level
# tests set it to a project name (simulate an adoptable legacy stack owned by
# this checkout), to `__none__` (simulate no adoptable legacy), or to
# `__foreign__` (simulate a legacy `$base` project that is NOT owned by this
# checkout -> the fail-closed branch) so the legacy branch is exercised
# hermetically without Docker.
dev_compose_project() {
  local checkout base hash hashed pid_file persisted adopted
  checkout="$(shared_checkout_dir)"
  base="$(dev_base_name "$checkout")"
  hash="$(printf '%s' "$checkout" | git hash-object --stdin 2>/dev/null || true)"
  hashed="bot-${base:-dev}-${hash:0:10}"
  pid_file="$(legacy_project_id_file)"

  # 1. Persistent project-id (already committed to a name).
  if [[ -f "$pid_file" ]]; then
    persisted="$(<"$pid_file")"
    if [[ -n "$persisted" ]]; then
      printf '%s\n' "$persisted"
      return 0
    fi
  fi

  # 2. Legacy adoption (real detection, or the test seam).
  adopted=""
  if [[ -n "${BOTTEGA_DEV_COMPOSE_ADOPT:-}" && "${BOTTEGA_DEV_COMPOSE_ADOPT:-}" != "__none__" && "${BOTTEGA_DEV_COMPOSE_ADOPT:-}" != "__foreign__" ]]; then
    adopted="${BOTTEGA_DEV_COMPOSE_ADOPT}"
  elif [[ -z "${BOTTEGA_DEV_COMPOSE_ADOPT:-}" || "${BOTTEGA_DEV_COMPOSE_ADOPT:-}" == "__foreign__" ]]; then
    # Real runtime (seam unset) OR the seam's "foreign legacy" case: is there
    # a legacy `$base` compose project, and is it OURS?
    local wd
    wd=""
    if [[ "${BOTTEGA_DEV_COMPOSE_ADOPT:-}" == "__foreign__" ]]; then
      # Test seam: simulate a legacy `$base` project whose iron-proxy working_dir
      # is NOT under this checkout (an unrelated same-basename clone's stack).
      wd="/unrelated/clone/${base}/.worktrees/other" # deliberately not under $checkout
    else
      wd="$(legacy_working_dir "$base")"
    fi
    if [[ -n "$wd" ]]; then
      if is_within_checkout "$wd" "$checkout"; then
        # This repo's own legacy stack — adopt + persist.
        adopted="$base"
      else
        # A legacy `$base` project exists but is NOT ours (unrelated
        # same-basename clone) — cannot attach, cannot parallel-create the
        # fixed subnet. Fail closed.
        {
          echo "bottega dev: a Compose project named '$base' already exists but its" >&2
          echo "iron-proxy working_dir ($wd) is NOT under this checkout ($checkout)," >&2
          echo "so it belongs to a DIFFERENT clone — refusing to adopt or disturb it" >&2
          echo "(issue #301). Resolve it by hand, then re-run:" >&2
          echo "  docker compose -p '$base' ls   # inspect; if it is a leftover legacy stack" >&2
          echo "  docker compose -p '$base' down # only if you are sure it is not in use" >&2
        } >&2
        exit 1
      fi
    fi
  fi

  if [[ -n "$adopted" ]]; then
    mkdir -p "$(dirname "$pid_file")"
    printf '%s\n' "$adopted" > "$pid_file"
    printf '%s\n' "$adopted"
    return 0
  fi

  # 3. Fresh repo — deterministic realpath-hashed identity (or basename
  #    fallback when git is absent).
  if [[ -n "$hash" ]]; then
    printf '%s\n' "$hashed"
  else
    printf 'bot-%s\n' "${base:-dev}"
  fi
}