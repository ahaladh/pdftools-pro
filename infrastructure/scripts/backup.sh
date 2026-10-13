#!/usr/bin/env bash
# Back up the MongoDB database to a checksummed, compressed archive and prune old backups.
#
#   MONGODB_URI=mongodb://user:pass@host:27017/pdftools?authSource=admin \
#   BACKUP_DIR=/var/backups/pdftools RETENTION_DAYS=14 ./backup.sh
#
# What it protects: users, sessions, plans/settings, job metadata, usage, audit log.
# What it does NOT contain: job files in the storage volume (transient by design, deleted by retention).
# Credentials are passed to mongodump through a config file descriptor, never on the command line,
# so they do not appear in `ps`. Exit codes: 0 ok, 1 failure, 2 usage/config error, 3 another backup is running.
set -euo pipefail

: "${MONGODB_URI:?set MONGODB_URI}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/pdftools}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || { echo "RETENTION_DAYS must be a number" >&2; exit 2; }
command -v mongodump >/dev/null || { echo "mongodump not found (install mongodb-database-tools)" >&2; exit 2; }

umask 077
mkdir -p "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || { echo "another backup is already running" >&2; exit 3; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/pdftools-$stamp.archive.gz"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

mongodump --config <(printf 'uri: "%s"\n' "$MONGODB_URI") --archive="$tmp" --gzip --quiet
[[ -s "$tmp" ]] || { echo "backup is empty" >&2; exit 1; }
mv "$tmp" "$out"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" )

# Retention: delete archives (and their checksums) older than RETENTION_DAYS, but never the one just written.
find "$BACKUP_DIR" -maxdepth 1 -name 'pdftools-*.archive.gz' -mtime +"$RETENTION_DAYS" ! -name "$(basename "$out")" -print -delete \
  | while read -r f; do rm -f "$f.sha256"; echo "pruned $(basename "$f")"; done

echo "backup ok: $out ($(du -h "$out" | cut -f1))"
