# OZMO Finance V2

OZMO Finance is an Arabic RTL finance application backed by PostgreSQL. Financial records are stored on the server through Prisma; browser storage is not the system of record.

## Current scope

- Next.js 16, React 19, TypeScript, and Tailwind CSS 4
- Arabic RTL finance interface
- PostgreSQL 17 with a normalized finance data model and Prisma migrations
- separate PostgreSQL owner and restricted runtime roles; the application role has no schema, role-management, migration-history write, or row-delete privilege
- clients, subscriptions, invoices, payments, expenses, liabilities, payroll, advances, recurring expenses, and services
- permanent cash ledger with immutable compensating reversals, including payroll and advance-deduction corrections
- editable XLSX invoice export
- local database-only Docker Compose workflow
- production Docker Compose stack with PostgreSQL, Traefik TLS, and HTTP Basic authentication
- Vitest, ESLint, TypeScript, and Prisma validation commands
- guarded PostgreSQL backup and restore scripts

The npm product identifier remains `ozmo-finance-v2`; `ozmo-bill` is the isolated deployment slug used for containers, database resources, and the health service.

## Requirements

- Node.js `^20.19.0`, `^22.13.0`, or `>=24.0`
- npm
- PostgreSQL, either through Docker Desktop or a local installation
- Docker Engine with Compose on the deployment server

## Start locally

The Next.js application runs directly with `npm run dev`. Docker is used only for the provided local PostgreSQL service.

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run db:start
npm.cmd run db:setup
npm.cmd run dev
```

Open `http://localhost:3000`.

`db:start` starts PostgreSQL and idempotently provisions the restricted runtime role. `db:setup` generates the Prisma client, applies committed migrations through `MIGRATION_DATABASE_URL`, runs the baseline seed, and refreshes runtime grants after table creation. Next.js connects through the restricted `DATABASE_URL`. Run `db:setup` after creating a new local database and after pulling database changes. If PostgreSQL is already installed locally, configure both URLs in `.env` and skip `db:start` after creating equivalent roles and grants.

See [LOCAL_DATABASE.md](LOCAL_DATABASE.md) for connection details, lifecycle commands, and data-safety notes.

## Validate the project

```powershell
npm.cmd run check
npm.cmd run build
```

`check` runs TypeScript, ESLint, Vitest, and Prisma schema validation.

## Production

The Dockerized web application is intended for server deployment. The production stack serves `https://bill.ozmo.media`, protects application and finance API routes with HTTP Basic authentication, and keeps PostgreSQL on an internal network. The container applies committed migrations and the idempotent baseline seed with the database owner, removes the owner credentials from the Next.js process environment, and then runs the application as the restricted database role.

Copy `.env.production.example` to `.env.production` on the server, replace every placeholder with a strong secret, and follow [DEPLOYMENT.md](DEPLOYMENT.md). Never commit `.env` or `.env.production`.

The application build and automated checks do not replace the required first-deployment PostgreSQL acceptance drill. Complete the production acceptance gate in `DEPLOYMENT.md` before entering authoritative financial records.

## Product documentation

- [Product requirements](docs/PRODUCT_REQUIREMENTS.md)
- [Change log](CHANGELOG.md)
