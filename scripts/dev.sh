#!/usr/bin/env bash
# bottega local dev launcher (issues #24, #123).
#
# Loads NEAR_API_KEY from the macOS Keychain when it isn't in the
# environment, then runs the server. The production path is unchanged:
# servers resolve keys via the auth-broker vault or .env.
#
# Issue #123 — iron-proxy default-on: local dev routes egress through the
# SAME iron-proxy (and the SAME committed config/egress.yml) as compose, and
# the extension credential boundary (secret-file write + proxy reload) is
# ALWAYS the injection path. `bun run dev` now requires Docker:
#   1. checks Docker is installed and the daemon is reachable (loud failure
#      with the exact remedy — never silent);
#   2. generates the MITM CA (certs/, gitignored) on first run;
#   3. resolves the egress judge key NEARAI_JUDGE_API_KEY (env -> .env ->
#      Keychain service bottega-near); missing -> LOUD failure, never silent
#      open egress (the judge is fail-closed deny);
#   4. starts iron-proxy detached via the compose dev override
#      (docker-compose.dev.yml: 127.0.0.1-bound 8080/9092 + ./data bind) and
#      waits for the management API to answer a reload — that proves the
#      egress config (allowlist + judge + secrets + management) parsed;
#   5. exports the proxy env the server needs: HTTP(S)_PROXY, NO_PROXY (the
#      same internal names as compose), NODE_EXTRA_CA_CERTS (Bun/Node verify
#      the proxy's MITM leaf certs against the generated CA), and
#      BOTTEGA_PROXY_CONTROL_URL/TOKEN (the boundary's reload half).
# The proxy stays up between dev runs (restart: on-failure); stop it with:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml down
#
# The OMP agent dir (data/omp-agent, issue #9) gets the deployment templates
# on first run — same catalog compose mounts at config/omp — so local and
# containerized runs share one source of truth. The driver (issue #80)
# installs that dir as the SDK's process-global agent dir at construction;
# no PI_CODING_AGENT_DIR is needed anywhere.
#
# Store the keys once:
#   security add-generic-password -s bottega-near -a "$(whoami)" -w '<key>'
#   security add-generic-password -s bottega-opencode -a "$(whoami)" -w '<key>'
# (bottega-near serves both NEAR_API_KEY and the egress judge key #123.)
#
# Usage:
#   bun run dev            # wrapper (this script)
#   bun run dev:watch      # wrapper with --watch
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p data/omp-agent
bun run scripts/seed-agent-dir.ts data/omp-agent config/omp

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

# --- iron-proxy: local dev egress gate + credential boundary (issue #123) --

# Value from the environment, else the project .env (quotes stripped), so
# dev.sh, the proxy container (compose interpolation) and the server process
# share ONE value.
env_or_dotenv() { # <var>
  local var="$1" line value
  if [[ -n "${!var:-}" ]]; then printf '%s' "${!var}"; return 0; fi
  if [[ -f .env ]] && line="$(grep -E "^${var}=" .env | tail -1 || true)" && [[ -n "$line" ]]; then
    value="${line#*=}"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    printf '%s' "$value"
    return 0
  fi
  return 1
}

COMPOSE_DEV=(docker compose -f docker-compose.yml -f docker-compose.dev.yml)

# 1. Docker gate (fail loudly — the dev topology cannot run without it).
if ! command -v docker >/dev/null 2>&1; then
  echo "bottega dev: Docker is REQUIRED for local dev (issue #123) — local runs route egress through iron-proxy and the extension credential boundary reloads it. Install Docker Desktop and re-run:" >&2
  echo "  https://www.docker.com/products/docker-desktop/" >&2
  echo "  bun run dev" >&2
  exit 1
fi
if ! docker version >/dev/null 2>&1; then
  echo "bottega dev: Docker daemon not reachable (issue #123). Start Docker Desktop, then re-run:" >&2
  echo "  bun run dev" >&2
  exit 1
fi

# 2. MITM CA (config/egress.yml -> tls): the proxy terminates HTTPS with it
#    and the dev server must trust it (NODE_EXTRA_CA_CERTS below). Gitignored.
if [[ ! -f certs/ca.crt ]]; then
  echo "iron-proxy: generating MITM CA (certs/, gitignored)..."
  mkdir -p certs
  if ! docker run --rm -v "$PWD/certs:/certs" ironsh/iron-proxy:0.49.0 generate-ca -outdir /certs >/dev/null 2>&1; then
    echo "bottega dev: iron-proxy CA generation failed (issue #123) — is the ironsh/iron-proxy:0.49.0 image pullable?" >&2
    echo "  docker pull ironsh/iron-proxy:0.49.0" >&2
    exit 1
  fi
  echo "iron-proxy: MITM CA generated at certs/ca.crt"
fi

# 3. Judge key (fail closed): without NEARAI_JUDGE_API_KEY the judge LLM call
#    fails and every allowlisted request is denied — never silently open.
JUDGE_KEY="$(env_or_dotenv NEARAI_JUDGE_API_KEY || true)"
if [[ -z "$JUDGE_KEY" ]] && command -v security >/dev/null 2>&1; then
  JUDGE_KEY="$(security find-generic-password -s bottega-near -w 2>/dev/null || true)"
fi
if [[ -z "$JUDGE_KEY" ]]; then
  echo "bottega dev: NEARAI_JUDGE_API_KEY is REQUIRED (issue #123) — the egress judge gates every model request and fails closed (deny) without a key; local dev never runs with open egress." >&2
  echo "Store it in the Keychain (reuses the bottega-near entry):" >&2
  echo "  security add-generic-password -s bottega-near -a \"$(whoami)\" -w '<key>'" >&2
  echo "or set NEARAI_JUDGE_API_KEY in .env / your shell, then re-run:" >&2
  echo "  bun run dev" >&2
  exit 1
fi
export NEARAI_JUDGE_API_KEY="$JUDGE_KEY"
echo "NEARAI_JUDGE_API_KEY resolved (env/.env/Keychain bottega-near)"

# 4. Management API token for the boundary reload (issue #123). Persisted
#    (0600, gitignored data/) so consecutive dev runs REUSE a running proxy
#    instead of recreating it with a fresh token each boot.
if [[ ! -f data/proxy-mgmt-token ]]; then
  mkdir -p data
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16 | tr -d '\n' > data/proxy-mgmt-token
  else
    printf 'dev-bottega-%s' "$(date +%s)" > data/proxy-mgmt-token
  fi
  chmod 600 data/proxy-mgmt-token
  echo "iron-proxy: dev management token generated at data/proxy-mgmt-token (0600)"
fi
export IRON_MANAGEMENT_API_KEY="$(<data/proxy-mgmt-token)"
export BOTTEGA_PROXY_CONTROL_URL="http://127.0.0.1:9092"
export BOTTEGA_PROXY_CONTROL_TOKEN="$IRON_MANAGEMENT_API_KEY"

# 5. Start the proxy (detached, idempotent: a running container with the
#    same config is reused) and wait for the management API — a successful
#    POST /v1/reload proves the egress config parsed and loaded.
echo "iron-proxy: starting (${COMPOSE_DEV[*]} up -d iron-proxy)..."
"${COMPOSE_DEV[@]}" up -d iron-proxy
echo "iron-proxy: waiting for the management API (POST /v1/reload) on 127.0.0.1:9092..."
READY=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null -m 3 -X POST \
      -H "Authorization: Bearer $IRON_MANAGEMENT_API_KEY" \
      http://127.0.0.1:9092/v1/reload 2>/dev/null; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "$READY" != 1 ]]; then
  echo "bottega dev: iron-proxy did not become ready (issue #123). Diagnose:" >&2
  echo "  ${COMPOSE_DEV[*]} logs iron-proxy" >&2
  echo "  ${COMPOSE_DEV[*]} ps" >&2
  exit 1
fi
echo "iron-proxy: ready (egress config loaded, management API answering)"

# 6. Server proxy env (issue #123): same topology as compose — HTTP(S)_PROXY
#    at the tunnel, NO_PROXY for internal names, the MITM CA for Bun/Node
#    TLS, and the boundary control URL/token (authorize writes the secret
#    file AND reloads the proxy). The BOTTEGA_* vars reach the server
#    process and the ACP driver's spawned MCP server via the environment.
export HTTP_PROXY="http://127.0.0.1:8080"
export HTTPS_PROXY="http://127.0.0.1:8080"
export NO_PROXY="localhost,127.0.0.1,data,auth-broker,auth-gateway,mem0"
export NODE_EXTRA_CA_CERTS="$PWD/certs/ca.crt"

exec bun run ${1:+--watch} src/server/index.ts
