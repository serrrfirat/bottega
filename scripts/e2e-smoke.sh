#!/usr/bin/env bash
# bottega compose e2e smoke leg (issue #30, epic #27).
#
# Opt-in integration leg (issue #41): runs only with BOTTEGA_RUN_INTEGRATION=1
# so the default CI (hermetic + unit only, under the 5-minute budget) skips
# it — same gate as the src/egress/iron-proxy.test.ts leg.
#
# Boots the real compose stack (executor profile) with placeholder env and
# asserts the fail-closed boots + service wiring:
#   - server exits with the Slack-token guard message (fail closed)
#   - executor creates the SQLite schema, then exits with the git-PAT guard
#     message (fail closed)
#   - iron-proxy runs without restarts (egress config + CA loaded)
#   - data volume holds bottega.db with the store tables (queried in-container)
#   - auth-broker healthy with its bearer token bootstrapped on the data
#     volume (/data/.omp/auth-broker.token) — asserted only when the
#     oh-my-pi/pi:dev image is pullable; that image is a private Docker Hub
#     repo, so without Hub access the broker asserts skip with evidence
#     (integration-leg convention: skip when the service/image can't run).
# Then tears the stack down (down -v) and removes the temp env file.
#
# No real credentials anywhere: the leg uses a temp env file of placeholders
# (--env-file replaces the repo .env, never reads it) and an isolated compose
# project name, so nothing in the repo is modified except the gitignored
# certs/ CA. Real-credential flows stay a manual checklist (scripts/smoke.sh).
#
# Exit codes: 0 = pass, 78 = skip (gate off / docker unavailable / image or
# build failure, with the reason printed), 1 = fail. GitHub Actions only
# honors 0, so wire CI as:  scripts/e2e-smoke.sh || [ $? -eq 78 ]
set -euo pipefail
cd "$(dirname "$0")/.."

# Integration legs are opt-in (issue #41); the default CI run stays hermetic
# + unit only. Message mirrors src/egress/iron-proxy.test.ts.
if [ "${BOTTEGA_RUN_INTEGRATION:-}" != "1" ]; then
  echo "[e2e-smoke leg] SKIP: integration leg skipped: set BOTTEGA_RUN_INTEGRATION=1 to run" >&2
  exit 78
fi

PROJECT="bottega-e2e"
ENV_FILE="$(mktemp /tmp/bottega-e2e.XXXXXX)"

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }

cleanup() {
  if command -v docker >/dev/null 2>&1; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

skip() { echo "e2e-smoke: SKIP — $*" >&2; exit 78; }
fail() {
  echo "e2e-smoke: FAIL — $*" >&2
  if command -v docker >/dev/null 2>&1 && docker ps -aq --filter "name=$PROJECT" | grep -q .; then
    compose ps >&2 || true
    compose logs --tail 15 >&2 || true
  fi
  exit 1
}

# Poll a predicate command until it succeeds or the deadline passes (hard
# timeout — the leg must never hang).
wait_for() { # <description> <seconds> <predicate...>
  local desc="$1" deadline=$(( $(date +%s) + $2 )); shift 2
  while ! "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "timed out waiting for: $desc"
    sleep 2
  done
  echo "  ok: $desc"
}

# Run a command with a hard deadline (portable: macOS has no coreutils
# `timeout`). Returns 1 on any non-zero exit or deadline kill.
deadline() { # <seconds> <cmd...>
  local secs="$1"; shift
  "$@" &
  local pid=$! killer
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) &
  killer=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$killer" 2>/dev/null
  wait "$killer" 2>/dev/null
  return $(( rc == 0 ? 0 : 1 ))
}

echo "==> docker present?"
command -v docker >/dev/null 2>&1 \
  || skip "docker not found (install Docker Desktop); the leg is skip-gated so CI without Docker stays green"
# `docker version` not `docker info`: on Docker Desktop a wedged registry
# probe can hang `docker info` for minutes.
docker version >/dev/null 2>&1 || skip "docker daemon not reachable (is Docker Desktop running?)"

# Placeholder env only — never real credentials. Notably NO Slack tokens:
# the server must hit the fail-closed guard, not attempt a Socket Mode boot.
cat > "$ENV_FILE" <<'EOF'
# bottega e2e smoke placeholders (issue #30) — never real credentials.
BOTTEGA_IMAGE_TAG=local
# iron-proxy boots fail-closed without this (config/egress.yml judge).
NEARAI_JUDGE_API_KEY=sk-placeholder-e2e
EOF

echo "==> compose file valid (executor profile)"
compose --profile executor config -q || fail "docker compose config rejected docker-compose.yml"

echo "==> iron-proxy image present?"
docker image inspect ironsh/iron-proxy:0.49.0 >/dev/null 2>&1 \
  || deadline 60 docker pull ironsh/iron-proxy:0.49.0 >/dev/null \
  || skip "iron-proxy image unavailable (pull failed or timed out) — see output above"

# The broker image (oh-my-pi/pi:dev) is a private Docker Hub repo: probe it;
# when unavailable, the broker/gateway services and their asserts are skipped
# with evidence and the rest of the stack is still exercised.
BROKER=0
if docker image inspect oh-my-pi/pi:dev >/dev/null 2>&1 \
  || deadline 30 docker pull oh-my-pi/pi:dev >/dev/null 2>&1; then
  BROKER=1
else
  echo "  skip: auth-broker/auth-gateway not asserted — oh-my-pi/pi:dev is not pullable"
  echo "        (private Docker Hub repo, no Hub login, or registry unreachable);"
  echo "        broker token + vault wiring stays the credentialed manual path (scripts/smoke.sh)."
fi

echo "==> generating iron-proxy MITM CA (gitignored certs/)"
mkdir -p certs
if [ ! -f certs/ca.crt ]; then
  docker run --rm -v "$PWD/certs:/certs" ironsh/iron-proxy:0.49.0 generate-ca -outdir /certs >/dev/null \
    || skip "iron-proxy generate-ca failed — see output above; cannot assert a loaded egress config"
fi

echo "==> building app image (bottega:local)"
deadline 300 compose --profile executor build \
  || skip "app image build failed or timed out — see output above; CI's docker job still covers build + fail-closed boots"

echo "==> booting the stack (executor profile)"
SERVICES="iron-proxy server executor"
[ "$BROKER" = 1 ] && SERVICES="iron-proxy auth-broker auth-gateway server executor"
deadline 120 compose --profile executor up -d $SERVICES || fail "compose up failed"

echo "==> asserting fail-closed boots + service wiring"
server_guarded()   { compose logs server | grep -q "SLACK_APP_TOKEN and SLACK_BOT_TOKEN are required"; }
executor_guarded() { compose logs executor | grep -q "git token file not found"; }
proxy_ok()         { [ "$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$PROJECT-iron-proxy-1" 2>/dev/null)" = "running 0" ]; }

wait_for "server fail-closed Slack-token guard" 120 server_guarded
wait_for "executor fail-closed PAT guard" 120 executor_guarded
wait_for "iron-proxy running, zero restarts (config loaded)" 90 proxy_ok

if [ "$BROKER" = 1 ]; then
  broker_healthy() { compose ps --format json auth-broker | grep -q '"Health":"healthy"'; }
  wait_for "auth-broker healthy" 120 broker_healthy
  compose exec -T auth-broker test -f /data/.omp/auth-broker.token \
    || fail "auth-broker token file missing on the data volume"
  echo "  ok: broker bearer token bootstrapped (/data/.omp/auth-broker.token)"
fi

echo "==> asserting SQLite schema on the data volume"
deadline 120 compose run --rm --no-deps --entrypoint bun server -e '
import { Database } from "bun:sqlite";
const db = new Database("/app/data/bottega.db", { readonly: true });
const rows = db.query("select name from sqlite_master where type = \"table\" and name not like \"sqlite_%\"").all();
const names = rows.map((r) => r.name).sort();
console.log("  tables:", names.join(", "));
for (const t of ["spaces", "work_items", "audit"]) {
  if (!names.includes(t)) { console.error("  missing table: " + t); process.exit(1); }
}
' || fail "bottega.db missing the store schema on the data volume"

echo "==> PASS: compose e2e smoke (fail-closed boots, SQLite schema, egress config)"
if [ "$BROKER" = 1 ]; then
  echo "      (auth-broker token + health asserted)"
fi
exit 0
