#!/bin/sh
# Online SQLite backup of the bottega store (issue #104): a consistent,
# restorable snapshot of the store DB.
#
# Uses Bun's bun:sqlite Database.serialize(), which returns the whole DB as
# one Uint8Array in a crash-consistent way (bun 1.3.14 has no
# Database.backup(); serialize() is the supported way to copy a live DB).
# Safe to run while the server holds the DB open. Requires `bun` on PATH.
#
# Usage:  scripts/backup.sh
#   Resolves the source DB from $BOTTEGA_DB_PATH, else "data/bottega.db"
#   (relative to the repo root when run from the repo root).
#
# Env (all optional):
#   BOTTEGA_DB_PATH  source DB path (default "data/bottega.db")
#   BACKUP_DIR       where backups are written (default "<dbdir>/backups",
#                    created when missing)
#   BACKUP_KEEP      how many newest backups to keep after writing
#                    (default 7); "0" disables pruning
#
# Backup name: bottega-<YYYYmmdd-HHMMSS>.db — an ISO-ish timestamp, so name
# ordering == chronological ordering and pruning by this prefix never
# matches the source DB or unrelated files.
#
# Prints the absolute backup path on stdout. Exits non-zero on failure with
# a message on stderr.
set -eu

db="${BOTTEGA_DB_PATH:-data/bottega.db}"

if [ ! -f "$db" ]; then
  echo "backup: no such database file: $db" >&2
  exit 1
fi

root=$(CDPATH= cd -- "$(dirname -- "$db")" && pwd)
base=$(basename -- "$db")
# Snapshot filename prefix: `bottega.db` -> `bottega`. Backups are
# bottega-<YYYYmmdd-HHMMSS>.db, so this prefix is unique per source DB.
prefix=${base%.db}

backup_dir=${BACKUP_DIR:-"$root/backups"}
keep=${BACKUP_KEEP:-7}
mkdir -p "$backup_dir"
backup_dir=$(CDPATH= cd -- "$backup_dir" && pwd)

ts=$(date +%Y%m%d-%H%M%S)
out="$backup_dir/${prefix}-${ts}.db"

# Snapshot via bun:sqlite serialize() and write the raw bytes out with mode
# 0600 (the snapshot can carry sessions/transcripts, lock it down like the
# source volume). argv after `-e`: process.argv[1] = db, [2] = out.
bun -e '
  const { Database } = require("bun:sqlite");
  const fs = require("node:fs");
  const [db, out] = process.argv.slice(1);
  fs.writeFileSync(out, new Database(db).serialize(), { mode: 0o600 });
' "$db" "$out"
chmod 600 "$out"

# Prune: keep the newest $keep snapshots for THIS db (default keep=7); older
# snapshots are removed, ordered by name (== by timestamp). "0" disables
# pruning. Only names matching `$prefix-<YYYYmmdd>-<HHMMSS>.db` are
# considered, so the source DB and unrelated snapshots are never touched.
if [ "$keep" != "0" ]; then
  # Write the candidate list to a temp file so the `grep`/`sort` pipeline
  # (with a possible no-match exit) cannot trip `set -e` mid-loop.
  cand=$(mktemp) || cand=""
  if [ -z "$cand" ]; then
    echo "backup: warning: could not create temp file; skipping prune" >&2
  else
    ls -1 "$backup_dir" | grep -E "^${prefix}-[0-9]{8}-[0-9]{6}\.db$" | sort -r > "$cand" || true
    tail -n +"$((keep + 1))" "$cand" | while IFS= read -r old; do
      rm -f "$backup_dir/$old"
    done
    rm -f "$cand"
  fi
fi

echo "backup: wrote $out" >&2
echo "$out"