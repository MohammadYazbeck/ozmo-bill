#!/bin/sh
set -eu

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
MAINTENANCE_LOCK_DIR="${MAINTENANCE_LOCK_DIR:-./deploy-data/.maintenance.lock}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing environment file: $ENV_FILE" >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Missing Compose file: $COMPOSE_FILE" >&2
  exit 1
fi

mkdir -p "$(dirname -- "$MAINTENANCE_LOCK_DIR")"
if ! mkdir "$MAINTENANCE_LOCK_DIR" 2>/dev/null; then
  echo "Another deploy, backup, or restore holds $MAINTENANCE_LOCK_DIR." >&2
  exit 1
fi
printf '%s\n' "deploy pid=$$ started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MAINTENANCE_LOCK_DIR/owner"

cleanup() {
  rm -f "$MAINTENANCE_LOCK_DIR/owner"
  rmdir "$MAINTENANCE_LOCK_DIR" 2>/dev/null || true
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

docker network inspect web > /dev/null 2>&1 || {
  echo "Missing external Docker network: web" >&2
  exit 1
}

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --wait db

echo "Creating a pre-deploy backup and checking its archive structure." >&2
script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-./deploy-data/pre-deploy}" \
MAINTENANCE_LOCK_HELD=true \
ENV_FILE="$ENV_FILE" \
COMPOSE_FILE="$COMPOSE_FILE" \
  sh "$script_directory/backup-postgres.sh"

echo "Applying the restricted application-role grants." >&2
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T db \
  sh /docker-entrypoint-initdb.d/10-app-role.sh

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build --wait

echo "Refreshing runtime grants after migrations." >&2
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T db \
  sh /docker-entrypoint-initdb.d/10-app-role.sh

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
