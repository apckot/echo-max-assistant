#!/bin/sh
set -eu
umask 077
# PGSERVICE/PGPASSFILE supplies credentials. Never place a connection URL in argv.
: "${BACKUP_ROOT:?absolute private backup directory required}"
: "${BACKUP_KEY_FILE:?private 32-byte key file required}"
case "$BACKUP_ROOT" in /*) ;; *) exit 64;; esac
case "$BACKUP_KEY_FILE" in /*) ;; *) exit 64;; esac
[ -d "$BACKUP_ROOT" ] && [ ! -L "$BACKUP_ROOT" ] || exit 64
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d "$BACKUP_ROOT/.in-progress.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
# Plain format allows PostgreSQL to verify both data checksums and required WAL.
pg_basebackup --no-password --format=plain --wal-method=stream --checkpoint=fast --manifest-checksums=SHA256 --pgdata="$work/data" > "$work/pg.log" 2>&1 || { echo 'pg_basebackup failed' >&2; exit 1; }
pg_verifybackup "$work/data" > "$work/verify.log" 2>&1 || { echo 'pg_verifybackup failed' >&2; exit 1; }
# Do not embed restored replication credentials or source connection settings.
[ -f "$work/data/postgresql.auto.conf" ] && ! awk '/^[[:space:]]*($|#)/ {next} {found=1} END {exit !found}' "$work/data/postgresql.auto.conf" || { echo 'Backup contains source auto configuration; review offline' >&2; exit 1; }
node -e 'require("node:fs").writeFileSync(process.argv[1],new Date().toISOString())' "$work/data/echo_snapshot_at"
tar -C "$work/data" -cf "$work/base.tar" .
node "$script_dir/crypto.mjs" encrypt "$work/base.tar" "$work/base.enc" "$BACKUP_KEY_FILE"
node "$script_dir/crypto.mjs" manifest "$work/base.enc" "$work/data/backup_manifest" "$work/manifest.json" "$work/data/echo_snapshot_at"
[ -s "$work/base.enc" ] && [ -s "$work/manifest.json" ] || { echo 'Encrypted artifacts missing; refusing publication' >&2; exit 1; }
node "$script_dir/crypto.mjs" verify "$work/base.enc" "$work/manifest.json"
rm -rf -- "$work/data" "$work/base.tar" "$work/pg.log" "$work/verify.log"
backup_id=$(basename "$work" | sed 's/^\.in-progress\./backup-/')
mv -- "$work" "$BACKUP_ROOT/$backup_id"
node "$script_dir/crypto.mjs" sync "$BACKUP_ROOT/$backup_id" "$BACKUP_ROOT"
echo "$BACKUP_ROOT/$backup_id"
