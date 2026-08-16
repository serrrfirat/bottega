#!/usr/bin/env bash
# bottega local dev launcher (issue #24).
#
# Loads NEAR_API_KEY from the macOS Keychain when it isn't in the
# environment, then runs the server. The production path is unchanged:
# servers resolve keys via the auth-broker vault or .env.
#
# The OMP agent dir (data/omp-agent, issue #9) gets the deployment templates
# on first run — same catalog compose mounts at config/omp — so local and
# containerized runs share one source of truth. The driver (issue #80)
# installs that dir as the SDK's process-global agent dir at construction;
# no PI_CODING_AGENT_DIR is needed anywhere.
#
# Store the key once:
#   security add-generic-password -s bottega-near -a "$(whoami)" -w '<your key>'
#
# Usage:
#   bun run dev            # wrapper (this script)
#   bun run dev:watch      # wrapper with --watch
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p data/omp-agent
if [[ ! -f data/omp-agent/models.yml ]]; then
  cp config/omp/config.yml config/omp/models.yml config/omp/secrets.yml data/omp-agent/
  echo "omp agent dir: deployment templates copied from config/omp/ into data/omp-agent/"
else
  echo "omp agent dir: data/omp-agent (existing catalog kept — models.yml is generated from settings at boot when model ids are set)"
fi

if [[ -z "${NEAR_API_KEY:-}" ]] && command -v security >/dev/null 2>&1; then
  if KEY="$(security find-generic-password -s bottega-near -w 2>/dev/null)"; then
    export NEAR_API_KEY="$KEY"
    echo "NEAR_API_KEY loaded from Keychain (service: bottega-near)"
  else
    echo "NEAR_API_KEY not in env or Keychain — the server will refuse to boot:" >&2
    echo "the boot guard (issue #80) requires ≥1 available model from data/omp-agent/models.yml." >&2
    echo "Store it: security add-generic-password -s bottega-near -a \"$(whoami)\" -w '<key>'" >&2
  fi
fi

if [[ -z "${OPENCODE_API_KEY:-}" ]] && command -v security >/dev/null 2>&1; then
  if KEY="$(security find-generic-password -s bottega-opencode -w 2>/dev/null)"; then
    export OPENCODE_API_KEY="$KEY"
    echo "OPENCODE_API_KEY loaded from Keychain (service: bottega-opencode)"
  fi
fi

exec bun run ${1:+--watch} src/server/index.ts
