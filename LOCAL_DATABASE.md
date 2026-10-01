# Local PostgreSQL database

PostgreSQL is required because financial data is stored in the database, not in browser `localStorage`. The recommended development workflow runs only PostgreSQL in Docker and runs the Next.js application directly with `npm run dev`.

## Local connection

- Host: `127.0.0.1`
- Port: `55433`
- Database: `ozmo_bill`
- Migration owner: `ozmo_admin` / `ozmo_dev_password`
- Application runtime: `ozmo_app` / `ozmo_app_dev_password`

These credentials are deliberately limited to local development. Do not reuse them on a server.

`MIGRATION_DATABASE_URL` is used only by Prisma migration and seed commands. `DATABASE_URL` is the restricted connection used by Next.js. The runtime role can read and change application rows but cannot create schemas, tables, or database roles.

## First-time setup

Copy the example environment file and install packages:

```powershell
Copy-Item .env.example .env
npm.cmd install
```

Start only the PostgreSQL container:

```powershell
npm.cmd run db:start
```

This command waits for PostgreSQL and then idempotently creates or updates the restricted role and its grants. That extra step also upgrades a preserved local volume created by an older version of this project.

Generate the Prisma client, apply the committed migrations, run the idempotent baseline seed, and refresh the restricted runtime grants:

```powershell
npm.cmd run db:setup
```

The migrations and seed run as the database owner. The final grant refresh removes write access to Prisma's migration history and removes row-delete privileges after first-time table creation. The seed creates the required baseline organization and application configuration without replacing existing finance records.

Run the application outside Docker:

```powershell
npm.cmd run dev
```

Open `http://localhost:3000`.

## Daily workflow

Start PostgreSQL before starting Next.js:

```powershell
npm.cmd run db:start
npm.cmd run dev
```

Run `npm.cmd run db:start` after changing either local database password so the restricted role is synchronized. Run `npm.cmd run db:setup` again after pulling new committed migrations or seed changes. It is safe for the baseline seed to run more than once.

If you prefer a native PostgreSQL installation, create a separate non-owner login with `CONNECT`, schema `USAGE`, `SELECT`, `INSERT`, and `UPDATE` privileges on the application tables, plus usage on sequences; do not grant row deletion. Then update both `MIGRATION_DATABASE_URL` and `DATABASE_URL` in `.env`. Default privileges for future tables and sequences must be granted by the migration owner. The application still runs with `npm.cmd run dev`.

## Useful commands

```powershell
npm.cmd run db:logs
npm.cmd run prisma:studio
npm.cmd run db:stop
```

Use `npm.cmd run db:migrate` only when intentionally creating a development migration after changing `prisma/schema.prisma`. Commit both the schema change and the generated migration.

Prisma CLI commands select `MIGRATION_DATABASE_URL`. Do not point that variable at the restricted `ozmo_app` role; it intentionally cannot perform DDL. Prisma Studio also uses the migration connection and should only be run on a trusted development machine.

`db:stop` stops the containers but preserves the PostgreSQL volume. If you intentionally need a completely empty local database, `docker compose down --volumes` deletes that volume. This cannot be undone and should only be used when no local data needs to be kept.

The Docker volume is convenient persistence, not a backup. Use the production backup workflow for data that must be recoverable.
