#!/bin/sh
set -eu

umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: RESTORE_CONFIRM=<database> sh scripts/restore-postgres.sh path/to/backup.dump" >&2
  exit 1
fi

backup_file="$1"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
PRE_RESTORE_BACKUP_DIR="${PRE_RESTORE_BACKUP_DIR:-./deploy-data/pre-restore}"
MAINTENANCE_LOCK_DIR="${MAINTENANCE_LOCK_DIR:-./deploy-data/.maintenance.lock}"

for required_file in "$backup_file" "$ENV_FILE" "$COMPOSE_FILE"; do
  if [ ! -f "$required_file" ]; then
    echo "Missing required file: $required_file" >&2
    exit 1
  fi
done

mkdir -p "$(dirname -- "$MAINTENANCE_LOCK_DIR")"
if ! mkdir "$MAINTENANCE_LOCK_DIR" 2>/dev/null; then
  echo "Another deploy, backup, or restore holds $MAINTENANCE_LOCK_DIR." >&2
  echo "If no maintenance process is running, inspect and remove the stale lock directory." >&2
  exit 1
fi
printf '%s\n' "restore pid=$$ started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MAINTENANCE_LOCK_DIR/owner"

restore_database=""
previous_database=""
database_name=""
restore_database_created=false
cutover_started=false
database_swapped=false

drop_restore_candidate() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
    -e RESTORE_DATABASE="$restore_database" db \
    sh -c 'exec psql -X -w --set=ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres --set=restore_database="$RESTORE_DATABASE"' <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'restore_database' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'restore_database') \gexec
SQL
}

rollback_cutover() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
    -e RESTORE_DATABASE="$restore_database" \
    -e PREVIOUS_DATABASE="$previous_database" \
    -e TARGET_DATABASE="$database_name" db \
    sh -c 'exec psql -X -w --set=ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres --set=restore_database="$RESTORE_DATABASE" --set=previous_database="$PREVIOUS_DATABASE" --set=target_database="$TARGET_DATABASE"' <<'SQL'
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS false', :'target_database')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')
  AND EXISTS (SELECT 1 FROM pg_database WHERE datname = :'previous_database')
  AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'restore_database')
\gexec
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'target_database'
  AND EXISTS (SELECT 1 FROM pg_database WHERE datname = :'previous_database')
  AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'restore_database')
  AND pid <> pg_backend_pid();
SELECT format('ALTER DATABASE %I RENAME TO %I', :'target_database', :'restore_database')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')
  AND EXISTS (SELECT 1 FROM pg_database WHERE datname = :'previous_database')
  AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'restore_database')
\gexec
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'previous_database' AND pid <> pg_backend_pid();
SELECT format('ALTER DATABASE %I RENAME TO %I', :'previous_database', :'target_database')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'previous_database')
  AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')
\gexec
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS true', :'target_database')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')
\gexec
SELECT EXISTS (
  SELECT 1 FROM pg_database
  WHERE datname = :'target_database' AND datallowconn
) AS target_restored
\gset
\if :target_restored
\else
  \echo 'Original database could not be restored to its active name'
  \quit 1
\endif
SQL
}

cleanup() {
  exit_status=$?
  trap - EXIT

  retain_candidate=false
  if [ "$cutover_started" = true ] && [ "$database_swapped" = false ]; then
    echo "Restore did not complete; attempting to return the original database to service." >&2
    if rollback_cutover; then
      cutover_started=false
    else
      retain_candidate=true
      echo "CRITICAL: automatic database-name recovery failed." >&2
      echo "Do not start the web service. Inspect databases $database_name, $previous_database, and $restore_database." >&2
    fi
  fi

  if [ "$restore_database_created" = true ] && [ "$database_swapped" = false ] && [ "$retain_candidate" = false ]; then
    if ! drop_restore_candidate; then
      echo "Warning: the temporary restore database could not be removed: $restore_database" >&2
    fi
  fi

  if ! rm -f "$MAINTENANCE_LOCK_DIR/owner" || ! rmdir "$MAINTENANCE_LOCK_DIR"; then
    echo "Warning: maintenance lock cleanup failed: $MAINTENANCE_LOCK_DIR" >&2
  fi
  exit "$exit_status"
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
    echo "Refusing to restore an invalid database name." >&2
    exit 1
    ;;
  postgres|template0|template1)
    echo "POSTGRES_DB must not be a PostgreSQL maintenance or template database." >&2
    exit 1
    ;;
esac

if [ "${RESTORE_CONFIRM:-}" != "$database_name" ]; then
  echo "Restore not confirmed. Re-run with RESTORE_CONFIRM=$database_name after verifying the target." >&2
  exit 1
fi

web_container="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q web)"
if [ -n "$web_container" ] && [ "$(docker inspect -f '{{.State.Running}}' "$web_container")" = "true" ]; then
  echo "Refusing a live restore. Stop the web service first: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE stop web" >&2
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T db \
  pg_restore -w --list < "$backup_file" > /dev/null

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

MAINTENANCE_LOCK_HELD=true \
BACKUP_DIR="$PRE_RESTORE_BACKUP_DIR" \
ENV_FILE="$ENV_FILE" \
COMPOSE_FILE="$COMPOSE_FILE" \
  sh "$script_directory/backup-postgres.sh"

restore_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
restore_database="${database_name}_restore_${restore_timestamp}_$$"
previous_database="${database_name}_before_${restore_timestamp}_$$"

if [ "${#restore_database}" -gt 63 ] || [ "${#previous_database}" -gt 63 ]; then
  echo "Database name is too long to create safe restore databases." >&2
  exit 1
fi

echo "Restoring $backup_file into an isolated candidate database." >&2

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e RESTORE_DATABASE="$restore_database" \
  -e PREVIOUS_DATABASE="$previous_database" \
  -e TARGET_DATABASE="$database_name" db \
  sh -c 'exec psql -X -w --set=ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres --set=restore_database="$RESTORE_DATABASE" --set=previous_database="$PREVIOUS_DATABASE" --set=target_database="$TARGET_DATABASE"' <<'SQL'
SELECT
  EXISTS (
    SELECT 1 FROM pg_database WHERE datname = :'target_database'
  ) AS target_exists,
  NOT EXISTS (
    SELECT 1 FROM pg_database
    WHERE datname IN (:'restore_database', :'previous_database')
  ) AS names_available,
  NOT EXISTS (
    SELECT 1
    FROM pg_database target
    JOIN pg_database template ON template.datname = 'template0'
    WHERE target.datname = :'target_database'
      AND (
        target.encoding <> template.encoding OR
        target.datcollate <> template.datcollate OR
        target.datctype <> template.datctype OR
        target.datlocprovider <> template.datlocprovider
      )
  ) AS standard_attributes,
  NOT EXISTS (
    SELECT 1
    FROM pg_db_role_setting settings
    JOIN pg_database target ON target.oid = settings.setdatabase
    WHERE target.datname = :'target_database'
  ) AS no_custom_settings,
  NOT EXISTS (
    SELECT 1
    FROM pg_database target
    WHERE target.datname = :'target_database'
      AND shobj_description(target.oid, 'pg_database') IS NOT NULL
  ) AS no_custom_comment
\gset
\if :target_exists
\else
  \echo 'Target database does not exist'
  \quit 1
\endif
\if :names_available
\else
  \echo 'A restore candidate or pre-restore database name already exists'
  \quit 1
\endif
\if :standard_attributes
\else
  \echo 'Custom database locale or encoding requires a manual restore plan'
  \quit 1
\endif
\if :no_custom_settings
\else
  \echo 'Custom database settings require a manual restore plan'
  \quit 1
\endif
\if :no_custom_comment
\else
  \echo 'A custom database comment requires a manual restore plan'
  \quit 1
\endif
SELECT format('CREATE DATABASE %I WITH OWNER %I TEMPLATE template0', :'restore_database', current_user) \gexec
SQL
restore_database_created=true

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e RESTORE_DATABASE="$restore_database" db \
  sh -c 'exec pg_restore -w -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" --no-owner --no-privileges --single-transaction --exit-on-error' \
  < "$backup_file"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps -T \
  -e RESTORE_DATABASE="$restore_database" \
  --entrypoint node web ./scripts/migrate-restored-database.mjs

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e RESTORE_DATABASE="$restore_database" db \
  sh -c 'exec psql -X -w --set=ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$RESTORE_DATABASE"' <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "_prisma_migrations"
    WHERE migration_name = '20260930000000_init'
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Restored database is missing the required application migration';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "_prisma_migrations"
    WHERE finished_at IS NULL AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Restored database contains an unfinished migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "AppSetting"
    WHERE "organizationId" = '00000000-0000-0000-0000-000000000001'::uuid
      AND "key" = 'schemaVersion'
      AND "value" = '1'::jsonb
  ) THEN
    RAISE EXCEPTION 'Restored database is missing the OZMO schema baseline';
  END IF;
END
$$;
SQL

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e APP_ROLE_DATABASE="$restore_database" db \
  sh /docker-entrypoint-initdb.d/10-app-role.sh

cutover_started=true
printf '%s\n' \
  "restore pid=$$ cutover target=$database_name previous=$previous_database candidate=$restore_database started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$MAINTENANCE_LOCK_DIR/owner"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e RESTORE_DATABASE="$restore_database" \
  -e TARGET_DATABASE="$database_name" \
  -e PREVIOUS_DATABASE="$previous_database" db \
  sh -c 'exec psql -X -w --set=ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres --set=restore_database="$RESTORE_DATABASE" --set=target_database="$TARGET_DATABASE" --set=previous_database="$PREVIOUS_DATABASE"' <<'SQL'
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS false', :'target_database') \gexec
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'target_database' AND pid <> pg_backend_pid();
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS false', :'restore_database') \gexec
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'restore_database' AND pid <> pg_backend_pid();

-- PostgreSQL database renames are transactional. Keeping both renames and the
-- final enable in one transaction prevents a committed half-swapped catalog.
BEGIN;
SELECT format('ALTER DATABASE %I RENAME TO %I', :'target_database', :'previous_database') \gexec
SELECT format('ALTER DATABASE %I RENAME TO %I', :'restore_database', :'target_database') \gexec
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS true', :'target_database') \gexec
COMMIT;
SQL

database_swapped=true
cutover_started=false

echo "Restore completed through a migrated, validated, clean database swap." >&2
echo "The connection-disabled pre-restore database remains as $previous_database until verification is complete." >&2
echo "Start the web service, verify /api/health and financial totals, then remove that database during a maintenance window." >&2
