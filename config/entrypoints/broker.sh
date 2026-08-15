#!/bin/sh
# Bottega auth-broker bootstrap (issue #9).
#
# Ensures the broker bearer token exists on the shared data volume BEFORE
# the vault starts, then execs the omp CLI. The token file (mode 0600) is
# the single source of truth for the auth boundary:
#   - the gateway resolves it automatically (same PI_CONFIG_DIR on the
#     shared volume),
#   - ops copies it into .env as OMP_AUTH_BROKER_TOKEN for server/executor.
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

# Export so any child process (and the vault itself) sees the same token.
OMP_AUTH_BROKER_TOKEN="$(cat "$TOKEN_FILE")"
export OMP_AUTH_BROKER_TOKEN

exec omp "$@"
