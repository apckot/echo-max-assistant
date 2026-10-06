#!/bin/sh
set -eu
umask 077
# archive_command: /opt/echo/ops/backup/archive-wal.sh "%p" "%f"
# WAL_ARCHIVE_ROOT must be a mounted SECOND storage in Russia, not the source PG volume.
: "${WAL_ARCHIVE_ROOT:?second-storage mount required}"
: "${BACKUP_KEY_FILE:?private encryption key required}"
case "$WAL_ARCHIVE_ROOT" in /*) ;; *) exit 64;; esac
[ -d "$WAL_ARCHIVE_ROOT" ] && [ ! -L "$WAL_ARCHIVE_ROOT" ] || exit 64
[ "$#" -eq 2 ] || exit 64
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$script_dir/crypto.mjs" wal-name "$2" || exit 64
# Never silently replace an already archived WAL segment. On retry verify decrypted equality.
if [ -e "$WAL_ARCHIVE_ROOT/$2.enc" ]; then
 work=$(mktemp -d "$WAL_ARCHIVE_ROOT/.verify.XXXXXXXX")
 trap 'rm -rf -- "$work"' EXIT HUP INT TERM
 node "$script_dir/crypto.mjs" decrypt "$WAL_ARCHIVE_ROOT/$2.enc" "$work/wal" "$BACKUP_KEY_FILE"
 cmp -s "$1" "$work/wal"
 node "$script_dir/crypto.mjs" sync "$WAL_ARCHIVE_ROOT/$2.enc" "$WAL_ARCHIVE_ROOT"
else
 node "$script_dir/crypto.mjs" encrypt "$1" "$WAL_ARCHIVE_ROOT/$2.enc" "$BACKUP_KEY_FILE"
 [ -s "$WAL_ARCHIVE_ROOT/$2.enc" ] || exit 1
fi
