#!/usr/bin/env bash
# bottega local dev launcher (issue #24).
#
# Loads NEAR_API_KEY from the macOS Keychain when it isn't in the
# environment, then runs the server. The production path is unchanged:
# servers resolve keys via the auth-broker vault or .env.
#
# Store the key once:
#   security add-generic-password -s bottega-near -a "$(whoami)" -w '<your key>'
#
# Usage:
#   bun run dev            # wrapper (this script)
#   bun run dev:watch      # wrapper with --watch
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${NEAR_API_KEY:-}" ]] && command -v security >/dev/null 2>&1; then
  if KEY="$(security find-generic-password -s bottega-near -w 2>/dev/null)"; then
    export NEAR_API_KEY="$KEY"
    echo "NEAR_API_KEY loaded from Keychain (service: bottega-near)"
  else
    echo "NEAR_API_KEY not in env or Keychain — the agent will have no model." >&2
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
