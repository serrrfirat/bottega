#!/bin/sh
# Restore a bottega SQLite snapshot (issue #104): copies the backup file
# produced by scripts/backup.sh back over the store DB. The copy is atomic
# (write a temp file in the target directory, then `mv` it over the target),
# so a crash mid-copy never leaves a half-written DB file.
#
# Usage:  scripts/restore.sh <snapshot> [db] [--yes]
#   snapshot  path to a bottega-<timestamp>.db backup file (from
#             scripts/backup.sh)
#   db        optional explicit target DB path (default $BOTTEGA_DB_PATH,
#             else "data/bottega.db")
#   --yes     skip the interactive confirmation (for cron / CI / tests)
#
# Safety:
#   * Refuses a missing / non-SQLite snapshot (header must be
#     "SQLite format 3").
#   * Refuses to restore onto a target that does not already exist (never
#     creates one by accident).
#   * Prompts for an explicit "yes" before overwriting the target, unless
#     --yes is given.
#
# Env:
#   BOTTEGA_DB_PATH  target DB path (default "data/bottega.db")
#
# Prints the next step (restart the server) after restoring.
#
# Example (from the repo root):
#   bash scripts/restore.sh data/backups/bottega-20260822-223000.db --yes
set -eu

snapshot=""
db="${BOTTEGA_DB_PATH:-data/bottega.db}"
force=0
db_set=

for arg in "$@"; do
  case "$arg" in
    --yes) force=1 ;;
    -h|--help)
      echo "usage: scripts/restore.sh <snapshot> [db] [--yes]" >&2
      echo "  snapshot  backup file from scripts/backup.sh" >&2
      echo "  db        optional target DB (default \$BOTTEGA_DB_PATH)" >&2
      echo "  --yes     skip the confirmation prompt" >&2
      exit 0
      ;;
    *)
      if [ -z "$snapshot" ]; then
        snapshot="$arg"
      elif [ -z "$db_set" ]; then
        db="$arg"
        db_set=1
      else
        echo "restore: unexpected extra argument: $arg" >&2
        exit 2
      fi
      ;;
  esac
done

if [ -z "$snapshot" ]; then
  echo "usage: scripts/restore.sh <snapshot> [db] [--yes]" >&2
  echo "  snapshot must be a backup file from scripts/backup.sh" >&2
  exit 2
fi
if [ ! -f "$snapshot" ]; then
  echo "restore: snapshot not found: $snapshot" >&2
  exit 1
fi
if [ ! -f "$db" ]; then
  echo "restore: target DB does not exist (refusing to create one): $db" >&2
  exit 1
fi

# The snapshot must be a real SQLite file before we overwrite the live DB.
# SQLite files always start with the 16-byte magic "SQLite format 3\0".
header=$(head -c 16 "$snapshot" 2>/dev/null || true)
if [ "$header" != "SQLite format 3$(printf '\0')" ]; then
  echo "restore: snapshot is not a SQLite database: $snapshot" >&2
  exit 1
fi

if [ "$force" != "1" ]; then
  printf 'restore: overwrite %s with %s? type "yes" to confirm: ' "$db" "$snapshot" >&2
  IFS= read -r reply || reply=""
  if [ "$reply" != "yes" ]; then
    echo "restore: aborted (confirmation must be exactly 'yes')" >&2
    exit 1
  fi
fi

# Atomic copy: write to a temp file in the target directory (same
# filesystem, so `mv` is atomic), then move it over the target.
dir=$(CDPATH= cd -- "$(dirname -- "$db")" && pwd)
tmp="$dir/.restore.$$.tmp"
cp "$snapshot" "$tmp"
chmod 600 "$tmp"
if ! mv -f "$tmp" "$db"; then
  rm -f "$tmp"
  echo "restore: failed to move snapshot over $db" >&2
  exit 1
fi

echo "restore: wrote snapshot into $db" >&2
echo "restore: restart the server to pick up the restored database (docker compose restart server)" >&2