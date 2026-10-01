#!/bin/sh
set -eu

umask 077

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-./deploy-data/backups}"
MAINTENANCE_LOCK_DIR="${MAINTENANCE_LOCK_DIR:-./deploy-data/.maintenance.lock}"
maintenance_lock_acquired=false
temporary_file=""

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing environment file: $ENV_FILE" >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Missing Compose file: $COMPOSE_FILE" >&2
  exit 1
fi

if [ "${MAINTENANCE_LOCK_HELD:-false}" != true ]; then
  mkdir -p "$(dirname -- "$MAINTENANCE_LOCK_DIR")"
  if ! mkdir "$MAINTENANCE_LOCK_DIR" 2>/dev/null; then
    echo "Another deploy, backup, or restore holds $MAINTENANCE_LOCK_DIR." >&2
    exit 1
  fi
  maintenance_lock_acquired=true
  printf '%s\n' "backup pid=$$ started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MAINTENANCE_LOCK_DIR/owner"
fi

cleanup() {
  if [ -n "$temporary_file" ]; then
    rm -f "$temporary_file"
  fi
  if [ "$maintenance_lock_acquired" = true ]; then
    rm -f "$MAINTENANCE_LOCK_DIR/owner"
    rmdir "$MAINTENANCE_LOCK_DIR" 2>/dev/null || true
  fi
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

database_name="$(
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T db \
    sh -c 'printf "%s" "${POSTGRES_DB:-ozmo_bill}"'
)"

case "$database_name" in
  ''|*[!A-Za-z0-9_.-]*)
    echo "Refusing to create a backup with an invalid database name." >&2
    exit 1
    ;;
esac

mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$BACKUP_DIR/${database_name}_$timestamp.dump"
temporary_file="${backup_file}.partial"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T db \
  sh -c 'exec pg_dump -w -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$temporary_file"

if [ ! -s "$temporary_file" ]; then
  echo "Backup failed: pg_dump produced an empty file." >&2
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T db \
  pg_restore -w --list < "$temporary_file" > /dev/null

mv "$temporary_file" "$backup_file"

printf '%s\n' "$backup_file"
