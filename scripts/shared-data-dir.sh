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

# Probe the legacy compose project named `$1` (the canonical basename) and
# echo its adoption-relevant state as two lines:
#   net=<0|1>  whether `${proj}_egress` EXISTS (the fixed subnet is occupied)
#   wd=<dir>   the working_dir of a SURVIVING project container (any service,
#              live or stopped) with com.docker.compose.project == `$proj`,
#              or empty when none survives.
# Checking the network matters for #301: a dead/removed foreign container can
# leave `${proj}_egress` on the fixed 172.30.0.0/24 subnet with NO surviving
# container — the subnet is still occupied, so a fresh hashed network would
# collide; the caller must fail closed instead of silently falling to a hash.
legacy_state() { # <project-name>
  local proj="$1" net=0 wd="" cid
  if command -v docker >/dev/null 2>&1; then
    docker network inspect "${proj}_egress" >/dev/null 2>&1 && net=1
    # Any surviving project container (not just iron-proxy-1) — live OR
    # stopped — proves the project (and its labels) are still inspectable.
    cid="$(docker ps -aq --filter "label=com.docker.compose.project=$proj" 2>/dev/null | head -1)"
    if [[ -n "$cid" ]]; then
      wd="$(docker inspect "$cid" \
        --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
        2>/dev/null)"
    fi
  fi
  printf 'net=%d\nwd=%s\n' "$net" "$wd"
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
#     gated on PROVING OWNERSHIP: the fixed subnet is owned by `$base_egress`;
#     whichever `$base` project created it must show a SURVIVING container
#     (any service) whose `com.docker.compose.project.working_dir` label
#     resolves under THIS canonical checkout. If a `$base_egress` network OR
#     container exists but same-repo ownership cannot be proven (orphaned
#     network with no surviving container, or a surviving container belonging
#     to an unrelated same-basename clone), the stack FAILS CLOSED — we will
#     not attach to a stranger's/unknown network NOR create a parallel network
#     on the occupied fixed subnet (that was the original "invalid pool
#     request" recurrence), and we will not stop/delete an unrelated repo's
#     stack.
#  3. Deterministic hashed identity: `bot-<base>-<10hex>` of the canonical
#     realpath via `git hash-object --stdin` — worktrees of ONE repo share
#     it while unrelated same-basename clones diverge; valid/bounded Compose
#     charset/length. (Covers a fresh checkout with NO `$base_egress` network
#     and no surviving `$base` container — i.e. the subnet is free.)
#
# The result is always a valid Compose project name. In the ambiguous case
# (2) we print a loud remedy and `exit 1` — `set -e` in scripts/dev.sh
# propagates it, so the boot never guesses.
#
# TEST SEAM: scripts/dev.sh never sets BOTTEGA_DEV_COMPOSE_ADOPT; caller-level
# tests set it to a project name (simulate an adoptable legacy stack with a
# surviving owned container), to `__none__` (simulate NO legacy network/container
# — fresh subtree, hashed name), to `__foreign__` (simulate a legacy `$base`
# project with a SURVIVING container NOT owned by this checkout -> fail closed),
# or to `__orphan__` (simulate a `$base_egress` network with NO surviving
# container -> fail closed) so every branch is exercised hermetically without
# Docker.
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
  if [[ -n "${BOTTEGA_DEV_COMPOSE_ADOPT:-}" && "${BOTTEGA_DEV_COMPOSE_ADOPT:-}" != "__none__" && "${BOTTEGA_DEV_COMPOSE_ADOPT:-}" != "__foreign__" && "${BOTTEGA_DEV_COMPOSE_ADOPT:-}" != "__orphan__" ]]; then
    # Seam: an adoptable legacy stack owned by this checkout (surviving
    # container's working_dir under $checkout) — adopt its name.
    adopted="${BOTTEGA_DEV_COMPOSE_ADOPT}"
  else
    # Real runtime (seam unset) OR a seam's "legacy present" case: is the
    # `$base` subnet occupied and, if so, is it provably OUR repo's?
    local net wd
    net=0; wd=""
    case "${BOTTEGA_DEV_COMPOSE_ADOPT:-}" in
      __foreign__) net=1; wd="/unrelated/clone/${base}/.worktrees/other" ;; # surviving container NOT ours
      __orphan__)  net=1; wd="" ;;                                          # network present, no container
      "")          # real runtime: probe docker
        local state_line
        while IFS= read -r state_line; do
          case "$state_line" in
            net=*) net="${state_line#net=}" ;;
            wd=*)  wd="${state_line#wd=}" ;;
          esac
        done < <(legacy_state "$base")
        ;;
    esac
    # The fixed subnet is owned by `${base}_egress`. If it exists OR any
    # `$base` container survives (either way the subnet may be occupied),
    # we must ADOPT a provably-owned repo stack or FAIL CLOSED — never fall
    # to a hashed network that would collide with the occupied subnet (the
    # original "invalid pool request" recurrence).
    local owned=0
    if [[ -n "$wd" && "$wd" != "-" ]]; then
      is_within_checkout "$wd" "$checkout" && owned=1
    fi
    if [[ "$net" == "1" || -n "$wd" ]]; then
      if [[ "$owned" == "1" ]]; then
        # This repo's own surviving project container — adopt + persist.
        adopted="$base"
      else
        # Subnet occupied / `$base` container present, but same-repo ownership
        # cannot be proven (orphaned network with no surviving container, or a
        # surviving container whose working_dir is another clone's). Fail
        # closed with a precise remedy — never adopt a stranger's/unknown
        # state and never mint a parallel network on the occupied subnet.
        {
          echo "bottega dev: the shared dev subnet is already owned by a legacy" >&2
          echo "'$base' project that cannot be proven to be THIS checkout's." >&2
          if [[ -n "$wd" && "$wd" != "-" ]]; then
            echo "  a surviving '$base' container's working_dir ($wd) is NOT under" >&2
            echo "  this checkout ($checkout) — it belongs to a DIFFERENT clone." >&2
            echo "  Do NOT adopt or disturb it (issue #301)." >&2
          else
            echo "  '${base}_egress' exists on 172.30.0.0/24 but has no surviving" >&2
            echo "  '$base' project container (an orphaned/foreign leftover)." >&2
            echo "  Do NOT create a parallel network on the occupied subnet." >&2
          fi
          echo "  Resolve it by hand, then re-run: " >&2
          echo "    docker network ls --filter name='${base}_egress'   # inspect" >&2
          echo "    docker ps -a --filter label=com.docker.compose.project='$base'" >&2
          echo "    # If it is a leftover and CERTAINLY unused:" >&2
          echo "    docker network rm '${base}_egress'   # or: docker compose -p '$base' down" >&2
          echo "  then: bun run dev" >&2
        } >&2
        exit 1
      fi
    fi
    # else: no `$base_egress` network and no `$base` container — subnet free,
    # safe to use the deterministic hashed identity below.
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