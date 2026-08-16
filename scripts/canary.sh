#!/usr/bin/env bash
# bottega canary journeys (issue #71): the e2e user journeys with the REAL
# model — chat reply, memory row, open work item (and, with CANARY_FULL=1,
# the executor end-to-end leg). The harness installs the deployment model
# catalog (config/omp/models.yml) and the driver resolves the real gateway.
#
# Loads NEAR_API_KEY + OPENCODE_API_KEY from the macOS Keychain when not in
# the environment (the dev.sh pattern, issue #24), skips with a clear
# message when neither is available. NEVER part of CI: real model calls cost
# money and are non-deterministic — this is an opt-in local quality gate.
#
# Store the keys once:
#   security add-generic-password -s bottega-near -a "$(whoami)" -w '<your key>'
#   security add-generic-password -s bottega-opencode -a "$(whoami)" -w '<your key>'
#
# Usage:
#   bun run canary            # chat + memory + work-item journeys
#   CANARY_FULL=1 bun run canary   # + executor end-to-end (slow)
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${NEAR_API_KEY:-}" ]] && command -v security >/dev/null 2>&1; then
  if KEY="$(security find-generic-password -s bottega-near -w 2>/dev/null)"; then
    export NEAR_API_KEY="$KEY"
    echo "NEAR_API_KEY loaded from Keychain (service: bottega-near)"
  fi
fi

if [[ -z "${OPENCODE_API_KEY:-}" ]] && command -v security >/dev/null 2>&1; then
  if KEY="$(security find-generic-password -s bottega-opencode -w 2>/dev/null)"; then
    export OPENCODE_API_KEY="$KEY"
    echo "OPENCODE_API_KEY loaded from Keychain (service: bottega-opencode)"
  fi
fi

if [[ -z "${NEAR_API_KEY:-}" && -z "${OPENCODE_API_KEY:-}" ]]; then
  echo "canary: no model key available — SKIPPED (nothing ran)." >&2
  echo "Set NEAR_API_KEY/OPENCODE_API_KEY or store them in the Keychain:" >&2
  echo "  security add-generic-password -s bottega-near -a \"$(whoami)\" -w '<key>'" >&2
  echo "  security add-generic-password -s bottega-opencode -a \"$(whoami)\" -w '<key>'" >&2
  exit 0
fi

if [[ -n "${CANARY_MODEL_REF:-}" ]]; then
  echo "canary: model ${CANARY_MODEL_REF} (CANARY_MODEL_REF override)"
elif [[ -n "${NEAR_API_KEY:-}" ]]; then
  echo "canary: model near/zai-org/GLM-5.1-FP8 (NEAR — accepts the space agent's tool names)"
elif [[ -n "${OPENCODE_API_KEY:-}" ]]; then
  echo "canary: model opencode-go/deepseek-v4-flash (opencode; its gateway rejects dotted tool names — expect loud failures)"
fi
if [[ "${CANARY_FULL:-}" == "1" ]]; then
  echo "canary: CANARY_FULL=1 — the executor end-to-end leg runs (slow)"
fi

exec bun test ./tests/canary/canary.run.ts
