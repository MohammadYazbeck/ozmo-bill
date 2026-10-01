#!/bin/sh
set -eu

fail() {
  echo "Configuration error: $1" >&2
  exit 1
}

RUN_DB_MIGRATIONS="${RUN_DB_MIGRATIONS-true}"

case "$RUN_DB_MIGRATIONS" in
  true|false) ;;
  *) fail "RUN_DB_MIGRATIONS must be exactly true or false" ;;
esac

if [ "${NODE_ENV:-}" = "production" ]; then
  [ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is required"
  [ -n "${MIGRATION_DATABASE_URL:-}" ] || fail "MIGRATION_DATABASE_URL is required"
  [ -n "${POSTGRES_USER:-}" ] || fail "POSTGRES_USER is required"
  [ -n "${POSTGRES_PASSWORD:-}" ] || fail "POSTGRES_PASSWORD is required"
  [ -n "${POSTGRES_DB:-}" ] || fail "POSTGRES_DB is required"
  [ -n "${APP_DB_USER:-}" ] || fail "APP_DB_USER is required"
  [ -n "${APP_DB_PASSWORD:-}" ] || fail "APP_DB_PASSWORD is required"
  [ -n "${ADMIN_USERNAME:-}" ] || fail "ADMIN_USERNAME is required"
  [ -n "${ADMIN_PASSWORD:-}" ] || fail "ADMIN_PASSWORD is required"
  [ -n "${APP_DOMAIN:-}" ] || fail "APP_DOMAIN is required"

  [ "${#ADMIN_PASSWORD}" -ge 32 ] || fail "ADMIN_PASSWORD must contain at least 32 characters"
  node -e 'process.exit(new Set(process.env.ADMIN_PASSWORD).size >= 8 ? 0 : 1)' \
    || fail "ADMIN_PASSWORD must contain at least 8 distinct characters"
  [ "${#ADMIN_USERNAME}" -le 100 ] || fail "ADMIN_USERNAME cannot exceed 100 characters"
  case "$ADMIN_USERNAME" in
    *:*) fail "ADMIN_USERNAME cannot contain a colon" ;;
    ' '*|*' ') fail "ADMIN_USERNAME cannot start or end with whitespace" ;;
  esac
  [ "${#POSTGRES_PASSWORD}" -ge 32 ] || fail "POSTGRES_PASSWORD must contain at least 32 characters"
  [ "${#APP_DB_PASSWORD}" -ge 32 ] || fail "APP_DB_PASSWORD must contain at least 32 characters"
  [ "$APP_DB_USER" != "$POSTGRES_USER" ] || fail "APP_DB_USER must differ from POSTGRES_USER"
  [ "$APP_DB_PASSWORD" != "$POSTGRES_PASSWORD" ] || fail "APP_DB_PASSWORD must differ from POSTGRES_PASSWORD"

  for database_url in "$DATABASE_URL" "$MIGRATION_DATABASE_URL"; do
    case "$database_url" in
      *replace_with*) fail "database URLs still contain a placeholder" ;;
    esac
  done

  case "$ADMIN_PASSWORD" in
    change-me|changeme|password|replace_with_a_strong_static_password)
      fail "ADMIN_PASSWORD still contains an unsafe example value"
      ;;
  esac

  case "$APP_DOMAIN" in
    example.com|*.example.com) fail "APP_DOMAIN still contains an example domain" ;;
  esac

  [ "$APP_DOMAIN" = "bill.ozmo.media" ] || fail "APP_DOMAIN must be bill.ozmo.media"

  node -e '
    try {
      const runtimeUrl = new URL(process.env.DATABASE_URL)
      const migrationUrl = new URL(process.env.MIGRATION_DATABASE_URL)
      const expectedPath = `/${process.env.POSTGRES_DB}`
      const validConnection = (url, user, password) =>
        url.protocol === "postgresql:"
        && decodeURIComponent(url.username) === user
        && decodeURIComponent(url.password) === password
        && url.hostname === "db"
        && (url.port === "" || url.port === "5432")
        && url.pathname === expectedPath
        && url.searchParams.get("schema") === "public"

      const valid = validConnection(
        runtimeUrl,
        process.env.APP_DB_USER,
        process.env.APP_DB_PASSWORD,
      ) && validConnection(
        migrationUrl,
        process.env.POSTGRES_USER,
        process.env.POSTGRES_PASSWORD,
      )

      if (!valid) process.exit(1)
    } catch {
      process.exit(1)
    }
  ' || fail "DATABASE_URL or MIGRATION_DATABASE_URL does not match its configured PostgreSQL role"
fi

if [ "$RUN_DB_MIGRATIONS" = "true" ]; then
  [ -n "${MIGRATION_DATABASE_URL:-}" ] || fail "MIGRATION_DATABASE_URL is required when RUN_DB_MIGRATIONS=true"

  DATABASE_URL="$MIGRATION_DATABASE_URL" \
    MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" \
    ./node_modules/.bin/prisma migrate deploy
  DATABASE_URL="$MIGRATION_DATABASE_URL" \
    MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" \
    ./node_modules/.bin/prisma db seed
fi

# Next.js receives only the restricted runtime connection. The owner URL and
# the individual database credentials are not inherited by the application.
unset MIGRATION_DATABASE_URL POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB APP_DB_USER APP_DB_PASSWORD

exec "$@"
