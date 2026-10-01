#!/bin/sh
set -eu

fail() {
  echo "Database role configuration error: $1" >&2
  exit 1
}

[ -n "${POSTGRES_USER:-}" ] || fail "POSTGRES_USER is required"
[ -n "${POSTGRES_DB:-}" ] || fail "POSTGRES_DB is required"
[ -n "${APP_DB_USER:-}" ] || fail "APP_DB_USER is required"
[ -n "${APP_DB_PASSWORD:-}" ] || fail "APP_DB_PASSWORD is required"

app_role_database="${APP_ROLE_DATABASE:-$POSTGRES_DB}"

case "$app_role_database" in
  ''|*[!A-Za-z0-9_.-]*) fail "APP_ROLE_DATABASE contains invalid characters" ;;
esac
[ "${#app_role_database}" -le 63 ] || fail "APP_ROLE_DATABASE cannot exceed 63 characters"

case "$APP_DB_USER" in
  *[!A-Za-z0-9_]* ) fail "APP_DB_USER may contain only letters, numbers, and underscores" ;;
esac

[ "${#APP_DB_USER}" -le 63 ] || fail "APP_DB_USER cannot exceed 63 characters"
[ "$APP_DB_USER" != "$POSTGRES_USER" ] || fail "APP_DB_USER must differ from POSTGRES_USER"
[ "${#APP_DB_PASSWORD}" -ge 16 ] || fail "APP_DB_PASSWORD must contain at least 16 characters"

# This script is run automatically by the official PostgreSQL image for a new
# data directory. The deployment and local-start workflows also run it
# explicitly, which makes the grants idempotent for volumes created before the
# restricted application role was introduced.
psql -X -w --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$app_role_database" <<'SQL'
\getenv app_db_user APP_DB_USER
\getenv app_db_password APP_DB_PASSWORD

BEGIN;

SELECT format(
  'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
  :'app_db_user',
  :'app_db_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_db_user')
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
  :'app_db_user',
  :'app_db_password'
)
\gexec

SELECT format('REVOKE %I FROM %I', parent.rolname, member.rolname)
FROM pg_auth_members membership
JOIN pg_roles parent ON parent.oid = membership.roleid
JOIN pg_roles member ON member.oid = membership.member
WHERE member.rolname = :'app_db_user'
\gexec

SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database())
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_db_user')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_db_user')
\gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', :'app_db_user')
\gexec

SELECT format(
  'REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM %I',
  :'app_db_user'
)
\gexec
SELECT format(
  'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO %I',
  :'app_db_user'
)
\gexec
SELECT format(
  'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I',
  :'app_db_user'
)
\gexec

SELECT format(
  'REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM %I',
  :'app_db_user'
)
WHERE to_regclass('public._prisma_migrations') IS NOT NULL
\gexec
SELECT format(
  'GRANT SELECT ON TABLE public._prisma_migrations TO %I',
  :'app_db_user'
)
WHERE to_regclass('public._prisma_migrations') IS NOT NULL
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE DELETE ON TABLES FROM %I',
  current_user,
  :'app_db_user'
)
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO %I',
  current_user,
  :'app_db_user'
)
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
  current_user,
  :'app_db_user'
)
\gexec

COMMIT;
SQL
