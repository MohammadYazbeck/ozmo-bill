import 'server-only'

import { PrismaClient } from '@prisma/client'
import { resolveDatabaseUrl } from '@/lib/env'

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
}
const databaseUrl = resolveDatabaseUrl()

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
}
