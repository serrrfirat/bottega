#!/bin/sh
# Bottega auth-broker bootstrap (issue #9).
#
# Ensures the broker bearer token exists on the shared data volume BEFORE
# the vault starts, then execs the packaged omp CLI. The token file (mode
# 0600) is the single source of truth for the auth boundary; it is never
# copied into this process environment:
#   - the broker CLI reads it from PI_CONFIG_DIR,
#   - the gateway resolves it from the same shared volume,
#   - server/executor resolve it through OMP_AUTH_BROKER_TOKEN_FILE.
#
# Runs unattended: first boot generates the token, later boots reuse it.
set -eu

: "${PI_CONFIG_DIR:=/data/.omp}"
TOKEN_FILE="$PI_CONFIG_DIR/auth-broker.token"

umask 077
mkdir -p "$PI_CONFIG_DIR"

if [ ! -f "$TOKEN_FILE" ]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$TOKEN_FILE"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import secrets; print(secrets.token_hex(32))" > "$TOKEN_FILE"
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE"
  fi
fi
chmod 600 "$TOKEN_FILE"
# Load the broker's provider-registration preload into this same Bun process
# before the packaged CLI starts. Tests may point at a checked-out source
# tree; the image keeps the /app path.
BROKER_PRELOAD="${OMP_AUTH_BROKER_PRELOAD:-/app/src/server/notion-oauth-broker-preload.ts}"
if [ -n "${BUN_OPTIONS:-}" ]; then
  BUN_OPTIONS="$BUN_OPTIONS --preload=$BROKER_PRELOAD"
else
  BUN_OPTIONS="--preload=$BROKER_PRELOAD"
fi
export BUN_OPTIONS

# Run the packaged CLI from the app image. The PATH fallback keeps this
# entrypoint hermetic in local tests and older development images.
if [ -x /app/node_modules/.bin/omp ]; then
  exec /app/node_modules/.bin/omp "$@"
fi
exec omp "$@"
