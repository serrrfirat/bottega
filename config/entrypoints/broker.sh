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
# Run OMP's source CLI in the same Bun module graph as the provider preload.
# The packaged dist CLI bundles a separate OAuth registry, so BUN_OPTIONS
# cannot register providers into that instance.
BROKER_PRELOAD="${OMP_AUTH_BROKER_PRELOAD:-/app/src/server/notion-oauth-broker-preload.ts}"
BROKER_CLI="${OMP_AUTH_BROKER_CLI:-/app/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts}"
if [ ! -f "$BROKER_PRELOAD" ] || [ ! -f "$BROKER_CLI" ]; then
  echo "auth-broker preload or source CLI is missing" >&2
  exit 1
fi
exec bun --preload "$BROKER_PRELOAD" "$BROKER_CLI" "$@"
