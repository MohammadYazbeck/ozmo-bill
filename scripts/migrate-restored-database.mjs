import { spawnSync } from 'node:child_process'

const databaseName = process.env.RESTORE_DATABASE ?? ''
const migrationUrlText = process.env.MIGRATION_DATABASE_URL ?? ''

if (!/^[A-Za-z0-9_.-]{1,63}$/.test(databaseName)) {
  console.error('Restore migration error: RESTORE_DATABASE is invalid.')
  process.exit(1)
}

let migrationUrl
try {
  migrationUrl = new URL(migrationUrlText)
} catch {
  console.error('Restore migration error: MIGRATION_DATABASE_URL is invalid.')
  process.exit(1)
}

if (migrationUrl.protocol !== 'postgresql:' || migrationUrl.hostname !== 'db') {
  console.error('Restore migration error: the owner connection must target the Compose database service.')
  process.exit(1)
}

migrationUrl.pathname = `/${databaseName}`
const candidateUrl = migrationUrl.toString()
const commandEnvironment = {
  ...process.env,
  DATABASE_URL: candidateUrl,
  MIGRATION_DATABASE_URL: candidateUrl,
  RUN_DB_MIGRATIONS: 'false',
}
const prismaCli = './node_modules/prisma/build/index.js'

function runPrisma(args) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: process.cwd(),
    env: commandEnvironment,
    stdio: 'inherit',
  })

  if (result.error || result.status !== 0) {
    console.error(`Restore migration error: prisma ${args.join(' ')} failed.`)
    process.exit(result.status || 1)
  }
}

runPrisma(['migrate', 'deploy'])
runPrisma(['db', 'seed'])
