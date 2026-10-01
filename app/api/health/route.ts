import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getEnv } from '@/lib/env'
import { getAdminCredentialStatus } from '@/lib/basic-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001'
const EXPECTED_SCHEMA_VERSION = 1

export async function GET() {
  try {
    const env = getEnv()
    const schemaVersion = await db.appSetting.findUnique({
      where: {
        organizationId_key: {
          organizationId: ORGANIZATION_ID,
          key: 'schemaVersion',
        },
      },
      select: { value: true },
    })

    if (schemaVersion?.value !== EXPECTED_SCHEMA_VERSION) {
      throw new Error('Database baseline seed is missing or incompatible')
    }

    const credentialStatus = getAdminCredentialStatus(
      process.env.ADMIN_USERNAME,
      process.env.ADMIN_PASSWORD,
    )

    if (env.NODE_ENV === 'production' && credentialStatus !== 'configured') {
      return NextResponse.json(healthBody('error'), responseInit(503))
    }

    return NextResponse.json(healthBody('ok'), responseInit(200))
  } catch (error) {
    console.error('Health check failed', error)

    return NextResponse.json(healthBody('error'), responseInit(503))
  }
}

function responseInit(status: number) {
  return {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  }
}

function healthBody(status: 'ok' | 'error') {
  return {
    status,
    service: 'ozmo-bill',
    timestamp: new Date().toISOString(),
  }
}
