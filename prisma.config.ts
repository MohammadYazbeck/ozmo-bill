import 'dotenv/config'
import { defineConfig } from 'prisma/config'

const localMigrationDatabaseUrl = 'postgresql://ozmo_admin:ozmo_dev_password@127.0.0.1:55433/ozmo_bill?schema=public'
const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL
  ?? (process.env.NODE_ENV === 'production' ? undefined : process.env.DATABASE_URL ?? localMigrationDatabaseUrl)

if (!migrationDatabaseUrl) {
  throw new Error('MIGRATION_DATABASE_URL is required when running Prisma in production')
}

// Prisma 6 still resolves env() references in schema.prisma for commands such
// as `prisma validate`, even when datasource.url is supplied below.
process.env.DATABASE_URL = migrationDatabaseUrl

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  engine: 'classic',
  datasource: {
    // Generation and static validation do not need a live database. Commands
    // that connect will still fail clearly if the local database is not up.
    url: migrationDatabaseUrl,
  },
})
