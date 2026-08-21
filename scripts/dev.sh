#!/usr/bin/env bash
# Thin local-development launcher. Bootstrap decisions and side effects live in
# scripts/dev-bootstrap.ts, where command/filesystem/clock/readiness seams make
# the same setup and dev flows hermetic under test.
set -euo pipefail
cd "$(dirname "$0")/.."

. "$(dirname "$0")/shared-data-dir.sh"
export BOTTEGA_PUBLIC_BASE_URL_FILE="$(shared_data_dir)/public-base-url"
export BOTTEGA_DEV_DATA_DIR="$(shared_data_dir)"
export BOTTEGA_PROXY_SECRETS_DIR="$(shared_data_dir)/proxy-secrets"
export BOTTEGA_PROXY_CONFIG_PATH="$(shared_data_dir)/egress.yml"
# The shared MITM CA dir (issue #301): the single certs/ the shared proxy
# terminates with. Every worktree's dev server trusts the SAME ca.crt
# (NODE_EXTRA_CA_CERTS via scripts/canary-egress.ts), so a second worktree
# boot NEVER generates/MITMs with a different CA than the shared proxy's.
export BOTTEGA_DEV_CERTS_DIR="$(shared_certs_dir)"

if [[ "${1:-}" == "--setup" ]]; then
  shift
  if [[ "${1:-}" == "--" ]]; then
    shift
  fi
  if [[ "${1:-}" == "--apply" ]]; then
    export COMPOSE_PROJECT_NAME="$(dev_compose_project)"
  fi
  exec bun run scripts/dev-bootstrap.ts setup "$@"
fi
export COMPOSE_PROJECT_NAME="$(dev_compose_project)"

exec bun run scripts/dev-bootstrap.ts dev "$@"
