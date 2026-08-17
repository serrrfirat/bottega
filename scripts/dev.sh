#!/usr/bin/env bash
# bottega local dev launcher (issues #24, #123, #126).
#
# Loads NEAR_API_KEY from the macOS Keychain when it isn't in the
# environment, then runs the server. The production path is unchanged:
# servers resolve keys via the auth-broker vault or .env.
#
# Issue #123/#126 — iron-proxy default-on, dev-PERMISSIVE: local dev routes
# egress through the SAME iron-proxy as compose, but with the generated
# DEV config (config/egress.dev.yml: allow-all allowlist "*" + NO judge,
# secrets + management kept) instead of the strict config/egress.yml — so
# web search (SDK providers), GitHub, Slack, and model endpoints all pass
# the dev proxy (no 403s, no judge denials) while the extension credential
# boundary (secret-file write + proxy reload) stays the injection path.
# `bun run dev` now requires Docker:
#   1. checks Docker is installed and the daemon is reachable (loud failure
#      with the exact remedy — never silent);
#   2. generates the MITM CA (certs/, gitignored) on first run;
#   3. resolves the dev management token (data/proxy-mgmt-token, 0600) —
#      the boundary's reload half; no NEARAI_JUDGE_API_KEY is needed (the
#      dev config has no judge — the strict config's judge key is a
#      deployment concern, unchanged for compose);
#   4. starts iron-proxy detached via the compose dev override
#      (docker-compose.dev.yml: 127.0.0.1-bound 8080/9092 + ./data bind +
#      the dev config mount) and waits for the management API to answer a
#      reload — that proves the dev egress config (allowlist + secrets +
#      management) parsed AND that the running container's
#      IRON_MANAGEMENT_API_KEY matches data/proxy-mgmt-token (a stale
#      container with a different token 401s the probe and fails loudly);
#   5. starts the auth-broker vault (issue #143, docker-compose.dev.yml:
#      127.0.0.1-bound 8765 + ./data bind) and waits for its readiness —
#      the token file (data/.omp/auth-broker.token, 0600, bootstrapped by
#      entrypoints/broker.sh) exists AND /v1/healthz answers — then exports
#      OMP_AUTH_BROKER_URL/TOKEN so the extension runtime's broker secret
#      resolver (issue #54 wiring) can fetch vault credentials;
#   6. exports the proxy env the server needs: HTTP(S)_PROXY, NO_PROXY (the
#      same internal names as compose), NODE_EXTRA_CA_CERTS (Bun/Node verify
#      the proxy's MITM leaf certs against the generated CA), and
#      BOTTEGA_PROXY_CONTROL_URL/TOKEN (the boundary's reload half).
# The proxy + broker stay up between dev runs (restart: on-failure); stop
# them with:
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

# 2. MITM CA (config/egress.dev.yml -> tls): the proxy terminates HTTPS with
#    it and the dev server must trust it (NODE_EXTRA_CA_CERTS below).
#    Gitignored.
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

# 3. Management API token for the boundary reload (issue #123). Persisted
#    (0600, gitignored data/) so consecutive dev runs REUSE a running proxy
#    instead of recreating it with a fresh token each boot. The dev config
#    (config/egress.dev.yml) has NO judge, so NEARAI_JUDGE_API_KEY is not
#    needed here — the strict config's judge key stays a deployment (.env /
#    compose) concern.
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

# 4. Start the proxy (detached, idempotent: a running container with the
#    same config is reused) and wait for the management API — a successful
#    POST /v1/reload proves the dev egress config parsed AND that the
#    container's IRON_MANAGEMENT_API_KEY matches data/proxy-mgmt-token (the
#    compose interpolation below exports the same token to the container).
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
  echo "If the probe 401s, the running container's IRON_MANAGEMENT_API_KEY differs from" >&2
  echo "data/proxy-mgmt-token (e.g. a container started outside dev.sh) — recreate it:" >&2
  echo "  ${COMPOSE_DEV[*]} up -d --force-recreate iron-proxy" >&2
  exit 1
fi
echo "iron-proxy: ready (dev egress config loaded, management API answering)"

# 5. Auth-broker vault (issue #143): the extension credential boundary's
#    secret FETCH half (issue #54 wiring) needs a running broker AND the
#    vault token. The dev override publishes the broker on 127.0.0.1:8765
#    with the host's ./data bind, so first boot bootstraps the bearer token
#    to data/.omp/auth-broker.token (0600, entrypoints/broker.sh) — the
#    same path the compose stack uses on the shared volume. Readiness = the
#    token file exists AND the broker's unauthenticated /v1/healthz answers
#    (the compose healthcheck's probe — healthy implies the token is ready
#    for dependents). Missing image / unreadable token fail loudly below,
#    never silently: the boundary must NOT run extension calls
#    unauthenticated.
echo "auth-broker: starting (${COMPOSE_DEV[*]} up -d auth-broker)..."
"${COMPOSE_DEV[@]}" up -d auth-broker
echo "auth-broker: waiting for the vault token (data/.omp/auth-broker.token) + /v1/healthz on 127.0.0.1:8765..."
BROKER_READY=0
for _ in $(seq 1 30); do
  if [[ -f data/.omp/auth-broker.token ]] && curl -fsS -o /dev/null -m 3 http://127.0.0.1:8765/v1/healthz 2>/dev/null; then
    BROKER_READY=1
    break
  fi
  sleep 1
done
if [[ "$BROKER_READY" != 1 ]]; then
  echo "bottega dev: auth-broker did not become ready (issue #143) — extension secrets cannot resolve without the vault. Diagnose:" >&2
  echo "  ${COMPOSE_DEV[*]} logs auth-broker" >&2
  echo "  ${COMPOSE_DEV[*]} ps" >&2
  echo "The oh-my-pi/pi:dev image is required; pull it once and re-run:" >&2
  echo "  docker pull oh-my-pi/pi:dev" >&2
  echo "  bun run dev" >&2
  exit 1
fi
# The vault token (0600, broker.sh bootstrap on the ./data bind). Read it
# every boot — the broker persists the token, so consecutive runs stay
# stable. These two exports are the resolver's env contract
# (src/extensions/boundary.ts -> brokerSecretResolverFromEnv).
export OMP_AUTH_BROKER_URL="http://127.0.0.1:8765"
export OMP_AUTH_BROKER_TOKEN="$(<data/.omp/auth-broker.token)"
echo "auth-broker: ready (vault token at data/.omp/auth-broker.token, 0600)"

# 6. Server proxy env (issue #123): same topology as compose — HTTP(S)_PROXY
#    at the tunnel, NO_PROXY for internal names, the MITM CA for Bun/Node
#    TLS, and the boundary control URL/token (authorize writes the secret
#    file AND reloads the proxy). The BOTTEGA_* vars reach the server
#    process and the ACP driver's spawned MCP server via the environment.
#    The #126 temporary NO_PROXY bypass is REVERTED: the dev proxy runs the
#    permissive config (allow-all + no judge), so routing the server's core
#    traffic (Slack, model endpoints, web search) through it is harmless and
#    keeps secret injection on every proxied extension call.
export HTTP_PROXY="http://127.0.0.1:8080"
export HTTPS_PROXY="http://127.0.0.1:8080"
export NO_PROXY="localhost,127.0.0.1,data,auth-broker,auth-gateway,mem0"
export NODE_EXTRA_CA_CERTS="$PWD/certs/ca.crt"

exec bun run ${1:+--watch} src/server/index.ts
