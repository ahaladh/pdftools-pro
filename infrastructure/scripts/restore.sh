#!/usr/bin/env bash
# Restore a backup made by backup.sh.
#
#   MONGODB_URI=... ./restore.sh /var/backups/pdftools/pdftools-20260101T020000Z.archive.gz [--drop]
#   MONGODB_URI=... ./restore.sh <archive> --scratch pdftools_drill     # restore into a throwaway database
#
# Safety: verifies the checksum first; refuses to restore into a database that already has data unless --drop is
# given (which replaces it); --scratch restores under another database name so a backup can be verified without
# touching production. Stop the API and workers before a real restore. Exit codes: 0 ok, 1 failure, 2 usage.
set -euo pipefail

archive="${1:-}"; shift || true
[[ -n "$archive" && -f "$archive" ]] || { echo "usage: restore.sh <archive.gz> [--drop | --scratch <dbname>]" >&2; exit 2; }
: "${MONGODB_URI:?set MONGODB_URI}"
command -v mongorestore >/dev/null || { echo "mongorestore not found (install mongodb-database-tools)" >&2; exit 2; }

drop=0; scratch=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --drop) drop=1 ;;
    --scratch) scratch="${2:?--scratch needs a database name}"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -z "$scratch" || "$scratch" =~ ^[A-Za-z0-9_]+$ ]] || { echo "invalid scratch database name" >&2; exit 2; }

if [[ -f "$archive.sha256" ]]; then
  ( cd "$(dirname "$archive")" && sha256sum --check --status "$(basename "$archive").sha256" ) || { echo "CHECKSUM MISMATCH: refusing to restore a corrupt backup" >&2; exit 1; }
  echo "checksum ok"
else
  echo "warning: no .sha256 next to the archive; integrity not verified" >&2
fi

# database name = last path segment of the URI (before any query string)
dbname="$(printf '%s' "$MONGODB_URI" | sed -E 's#^[a-z+]+://[^/]*/##; s#\?.*$##')"
[[ -n "$dbname" ]] || { echo "MONGODB_URI must include a database name" >&2; exit 2; }
cfg() { printf 'uri: "%s"\n' "$MONGODB_URI"; }

if [[ -z "$scratch" ]]; then
  # Refuse to overlay an existing, populated database (checked via the users collection) unless --drop was requested.
  if command -v mongoexport >/dev/null && [[ $drop -eq 0 ]]; then
    n="$(mongoexport --config <(cfg) --collection users --quiet 2>/dev/null | wc -l || true)"
    if [[ "${n:-0}" -gt 0 ]]; then echo "database '$dbname' already contains data ($n users). Re-run with --drop to replace it." >&2; exit 1; fi
  fi
  args=(--nsInclude "$dbname.*")
  [[ $drop -eq 1 ]] && args+=(--drop)
else
  args=(--nsInclude "$dbname.*" --nsFrom "$dbname.*" --nsTo "$scratch.*" --drop)
  echo "restoring into scratch database '$scratch' (production data is not touched)"
fi

mongorestore --config <(cfg) --archive="$archive" --gzip --quiet "${args[@]}"
echo "restore ok${scratch:+ (into $scratch)}"
