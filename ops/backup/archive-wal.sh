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
case "$2" in *[!0-9A-F]*|'') exit 64;; esac
[ "${#2}" -eq 24 ] || exit 64
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Never silently replace an already archived WAL segment. On retry verify decrypted equality.
if [ -e "$WAL_ARCHIVE_ROOT/$2.enc" ]; then
 work=$(mktemp -d "$WAL_ARCHIVE_ROOT/.verify.XXXXXXXX")
 trap 'rm -rf -- "$work"' EXIT HUP INT TERM
 node "$script_dir/crypto.mjs" decrypt "$WAL_ARCHIVE_ROOT/$2.enc" "$work/wal" "$BACKUP_KEY_FILE"
 cmp -s "$1" "$work/wal"
else
 node "$script_dir/crypto.mjs" encrypt "$1" "$WAL_ARCHIVE_ROOT/$2.enc" "$BACKUP_KEY_FILE"
fi
