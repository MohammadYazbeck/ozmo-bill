import { Prisma } from '@prisma/client'
import {
  apiError,
  parseSecureJsonRequest,
  secureApiRequest,
  type ApiErrorCode,
} from '@/lib/api-security'
import { financeCommandSchema } from '@/lib/finance/contracts'
import {
  executeFinanceCommand,
  FinanceServiceError,
  getFinanceSnapshot,
} from '@/lib/finance/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const securityFailure = secureApiRequest(request)
  if (securityFailure) return securityFailure

  try {
    return financeResponse(await getFinanceSnapshot())
  } catch (error) {
    return financeError(error)
  }
}

export async function POST(request: Request) {
  const parsed = await parseSecureJsonRequest(request, financeCommandSchema)
  if (!parsed.ok) return parsed.response

  try {
    return financeResponse(await executeFinanceCommand(parsed.data))
  } catch (error) {
    return financeError(error)
  }
}

function financeResponse(data: Awaited<ReturnType<typeof getFinanceSnapshot>>) {
  return Response.json(
    { data },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}

function financeError(error: unknown) {
  const reference = crypto.randomUUID()

  if (error instanceof FinanceServiceError) {
    console.warn('Finance request rejected', { reference, code: error.code })
    return apiError(error.status, error.code as ApiErrorCode, error.message)
  }

  if (
    error instanceof Prisma.PrismaClientInitializationError
    || error instanceof Prisma.PrismaClientRustPanicError
    || (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008'].includes(error.code))
  ) {
    console.error('Finance database unavailable', { reference, error })
    return apiError(503, 'DATABASE_UNAVAILABLE', `Database is unavailable. Reference: ${reference}`)
  }

  console.error('Finance request failed', { reference, error })
  return apiError(500, 'INTERNAL_ERROR', `The request could not be completed. Reference: ${reference}`)
}
