# Production deployment

The production stack follows the neighboring `budget-next` deployment pattern:

- Next.js application container
- PostgreSQL 17 with a persistent Docker volume
- a PostgreSQL owner role for migrations and a separate restricted role for Next.js
- automatic committed Prisma migrations and idempotent baseline seed on application startup
- database-aware `/api/health`
- HTTP Basic authentication for the first owner-only release
- Traefik TLS routing through an existing external `web` network
- PostgreSQL backup and restore scripts

PostgreSQL is the source of truth for financial records. Browser storage is not a substitute for database backups.

## Prerequisites

- Docker Engine and the Docker Compose plugin
- an existing external Docker network named `web`
- Traefik entrypoints named `web` and `websecure`, plus a certificate resolver named `lets`
- DNS for the chosen `APP_DOMAIN`
- inbound TCP ports 80 and 443 allowed by the server firewall and hosting provider
- a deployment folder and a separate, access-controlled backup folder
- enough free space in the PostgreSQL volume for the live database, a full restore candidate, retained pre-restore database, and restore WAL; plus host space for the pre-restore dump

## First deployment

Create the environment file and replace every placeholder:

```sh
cp .env.production.example .env.production
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Use the three generated values for the PostgreSQL owner, restricted application role, and admin passwords. Every value must be different. Hex output avoids shell, Compose, and URL-encoding ambiguity.

Important values:

```env
POSTGRES_PASSWORD=replace_with_a_long_random_password
APP_DB_USER=ozmo_app
APP_DB_PASSWORD=replace_with_a_different_long_random_password
MIGRATION_DATABASE_URL=postgresql://ozmo_admin:replace_with_a_long_random_password@db:5432/ozmo_bill?schema=public
DATABASE_URL=postgresql://ozmo_app:replace_with_a_different_long_random_password@db:5432/ozmo_bill?schema=public
APP_DOMAIN=bill.ozmo.media
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace_with_a_strong_static_password
```

Use the hex-only secrets generated above. This avoids the separate quoting and escaping rules used by Compose environment files and PostgreSQL URLs. The credentials in `MIGRATION_DATABASE_URL` must match `POSTGRES_USER` and `POSTGRES_PASSWORD`; those in `DATABASE_URL` must match `APP_DB_USER` and `APP_DB_PASSWORD`. The role names and passwords must differ.

The container refuses to start while an example domain, placeholder URL, weak/example password, mismatched role, or invalid `RUN_DB_MIGRATIONS` value remains. The admin password must be at least 32 characters with reasonable character diversity; the documented 64-character hex generator satisfies this rule. `RUN_DB_MIGRATIONS` accepts exactly `true` or `false`; leave it `true` for normal deployments.

Protect the environment file after editing it:

```sh
chmod 600 .env.production
```

For a server created from an earlier version, update its existing private `.env.production` before deploying: add `APP_DB_USER`, a new `APP_DB_PASSWORD`, and `MIGRATION_DATABASE_URL` containing the existing owner credentials; then change `DATABASE_URL` to use the new application role. Do not delete the database volume. The deployment script upgrades the preserved volume by creating the role and applying current/default grants.

Create the external network once if the server does not already provide it:

```sh
docker network create web
```

Create a private backup directory owned by the deployment user and start the stack:

```sh
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 700 /srv/ozmo-bill/backups
sh scripts/deploy-production.sh
```

The deployment script validates the Compose configuration and external `web` network, takes a shared maintenance lock, starts PostgreSQL, always creates a pre-deploy backup and checks its archive structure (including when a preserved volume is attached to a newly recreated container), and idempotently applies the restricted-role grants. It then builds the image, starts the stack, waits for its health checks, and refreshes grants after migrations. Before Next.js starts, the web container applies committed migrations and runs the create-only baseline seed through `MIGRATION_DATABASE_URL`. The owner credentials are removed from the process environment before Next.js starts with the restricted `DATABASE_URL`. Pre-deploy backups default to `./deploy-data/pre-deploy`; set `BACKUP_DIR` to store them elsewhere.

Check the deployment:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml ps
curl https://bill.ozmo.media/api/health
```

The health endpoint is intentionally public for Docker and uptime checks but returns only a status, service name, and timestamp. A healthy response proves the restricted runtime connection can read the expected seeded `schemaVersion`; a reachable but unseeded or incompatible database returns `503`. Application pages and finance API routes require the configured HTTP Basic credentials in production; framework assets and metadata files remain public. Use HTTPS only when entering those credentials.

If startup or a migration fails, inspect both services:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 web db
```

## Production acceptance gate

Do not enter authoritative financial records until this checklist has passed against a fresh PostgreSQL staging deployment built from the exact release being deployed. A TypeScript build cannot exercise PostgreSQL constraints, transaction locking, role grants, or restore cutover behavior.

- Deploy onto a fresh volume and confirm both containers are healthy.
- Confirm HTTP redirects to HTTPS, the certificate is trusted for `bill.ozmo.media`, unauthenticated application/API requests receive `401`, valid Basic credentials work, and `/api/health` exposes no financial or credential data.
- Connect as the restricted application role and confirm it can use application tables but cannot delete rows, create schema objects, change roles, or write Prisma migration history.
- Exercise each cash workflow, partial payment, reversal, and re-payment. Include a payroll run with both cash and advance deduction, plus a zero-cash payroll correction. Confirm the permanent ledger nets every reversal without deleting its original entry.
- Send concurrent duplicate/payment attempts and confirm idempotency and obligation caps prevent double posting or overpayment. Review both visible balances and audit events.
- Create a production-format backup, restore it fully into a scratch database, run the migration/seed validation, and reconcile cash, receivables, liabilities, advances, and payroll totals.
- Copy a verified backup to encrypted off-host storage and record the restore procedure and responsible operator.

PostgreSQL and Docker were not available on the development workstation used for the static release checks, so this live acceptance gate is mandatory for the first deployment.

## Updating

After pulling or copying new code:

```sh
sh scripts/deploy-production.sh
```

The deployment reapplies current grants for existing objects, and the owner default privileges grant the runtime role data access to objects created by future migrations. The web entrypoint runs `prisma migrate deploy` followed by the idempotent Prisma seed as the owner before Next.js starts. Review migrations and take a verified backup before deploying database changes. Do not edit an already-deployed migration; add a new one.

If you intentionally set `RUN_DB_MIGRATIONS=false`, the database must already contain all committed migrations, the baseline seed, and current runtime grants. The health check stays unavailable until the expected seed marker exists.

## Backups

Create a compressed PostgreSQL dump. The script reads database settings inside the running container; it never executes `.env.production` as shell code. It takes the same maintenance lock used by deploy and restore, writes a private temporary file, checks the archive header and table of contents, and only then renames it to `.dump`:

```sh
BACKUP_DIR=/srv/ozmo-bill/backups sh scripts/backup-postgres.sh
```

Schedule that command with the server's scheduler. For example, a daily cron entry for a checkout at `/srv/ozmo-bill/app` is:

```sh
15 2 * * * cd /srv/ozmo-bill/app && BACKUP_DIR=/srv/ozmo-bill/backups sh scripts/backup-postgres.sh
```

The structural check cannot read and validate every compressed data block. Define a retention policy appropriate for the business, copy backups to encrypted off-host storage, and schedule full scratch restores on a non-production database. A backup on the same disk does not protect against disk failure.

## Restoring a backup

A restore deletes or replaces matching database objects. Restore only access-controlled dumps generated by this deployment: PostgreSQL dumps can contain SQL that executes with the restore role's privileges, and `--no-owner` does not sanitize untrusted SQL. Verify the file and target, confirm the PostgreSQL volume has ample free space, stop application writes, and provide the exact database name as an explicit confirmation:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml stop web
RESTORE_CONFIRM=ozmo_bill PRE_RESTORE_BACKUP_DIR=/srv/ozmo-bill/backups/pre-restore \
  sh scripts/restore-postgres.sh /srv/ozmo-bill/backups/ozmo_bill_YYYYMMDDTHHMMSSZ.dump
docker compose --env-file .env.production -f docker-compose.prod.yml start web
curl https://bill.ozmo.media/api/health
```

The restore script takes the shared maintenance lock, checks the dump structure, refuses to run while the web container is active, and creates a fresh pre-restore backup. It restores into a new isolated database, applies the current Prisma migrations and create-only seed there, validates the OZMO schema marker, reapplies restricted-role grants, and only then performs the cutover. Both database renames and the final connection enable are committed in one PostgreSQL transaction. The old database is connection-disabled and retained under the name printed by the script. If cutover fails, the script attempts to put the original database back under the production name and preserves the candidate if automatic recovery cannot be proven.

After starting the web service, verify `/api/health`, the cash balances, receivables, liabilities, and payroll totals. Keep the printed pre-restore database until that verification and an additional backup are complete; then remove it during a maintenance window. Do not remove a retained database whose restore reported a recovery failure.

Backup, deploy, and restore use `./deploy-data/.maintenance.lock` by default. During restore cutover, its `owner` file records the target, previous, and candidate database names. If a process is killed without cleanup, verify that no maintenance command is running and inspect that state before removing a stale lock directory or starting the web service.

## Credential rotation

Do not rotate database passwords by editing `.env.production` while the web service is running. The PostgreSQL image reads `POSTGRES_PASSWORD` only when it initializes a new volume, so changing the file does not change the owner role in an existing cluster.

Use a planned maintenance window: take an off-host backup, stop `web`, change the corresponding PostgreSQL role password inside the running database, update the matching password and URL in `.env.production`, then run the normal deployment and health/totals checks. Rotate the restricted application role and owner role separately. A change to only `ADMIN_PASSWORD` does not touch PostgreSQL, but still recreate the web container through the normal deployment so the new credential is loaded consistently.

## Rollback

For an application regression, redeploy the last known-good commit or image and inspect the web logs. Database migrations are forward-only by default; do not assume rolling back application code reverses a migration. Restore a verified database backup only when the migration itself changed data incompatibly and after following the guarded restore procedure above.

## Traefik differences

`docker-compose.prod.yml` assumes the same Traefik conventions as `budget-next`: the `websecure` entrypoint and `lets` certificate resolver. Change those labels if the target server uses different names.
