import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => {
  class FinanceServiceError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code: 'NOT_FOUND' | 'CONFLICT' | 'DATABASE_UNAVAILABLE' | 'INTERNAL_ERROR',
    ) {
      super(message)
      this.name = 'FinanceServiceError'
    }
  }

  return {
    FinanceServiceError,
    getFinanceSnapshot: vi.fn(),
    executeFinanceCommand: vi.fn(),
  }
})

vi.mock('@/lib/finance/service', () => service)

import { GET, POST } from '@/app/api/finance/route'

const snapshot = {
  clients: [],
  incomes: [],
  expenses: [],
  liabilities: [],
  employees: [],
  advances: [],
  fixedExpenses: [],
  services: [],
  cashLedger: [],
  payrollSettlements: [],
  exchangeRate: '12000',
  cashbox: { usd: '0', syp: '0', totalUsd: '0' },
  revision: '2026-09-30T00:00:00.000Z',
  generatedAt: '2026-09-30T00:00:00.000Z',
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development')
  service.getFinanceSnapshot.mockReset().mockResolvedValue(snapshot)
  service.executeFinanceCommand.mockReset().mockResolvedValue(snapshot)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('/api/finance', () => {
  it('returns an authenticated, non-cacheable database snapshot', async () => {
    const response = await GET(new Request('http://localhost:3000/api/finance'))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toEqual({ data: snapshot })
  })

  it('validates and executes a strict idempotent command envelope', async () => {
    const command = {
      type: 'client.create',
      requestId: '00000000-0000-4000-8000-000000000001',
      payload: { name: 'Acme' },
    }
    const response = await POST(jsonRequest(command))

    expect(response.status).toBe(200)
    expect(service.executeFinanceCommand).toHaveBeenCalledWith(command)
    expect(await response.json()).toEqual({ data: snapshot })
  })

  it('rejects unrecognized request fields without calling the database service', async () => {
    const response = await POST(jsonRequest({
      type: 'client.create',
      requestId: '00000000-0000-4000-8000-000000000001',
      payload: { name: 'Acme', isAdmin: true },
    }))

    expect(response.status).toBe(422)
    expect(service.executeFinanceCommand).not.toHaveBeenCalled()
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
  })

  it('maps domain conflicts to a safe response', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    service.executeFinanceCommand.mockRejectedValue(
      new service.FinanceServiceError('This request conflicts with existing data.', 409, 'CONFLICT'),
    )

    const response = await POST(jsonRequest({
      type: 'client.create',
      requestId: '00000000-0000-4000-8000-000000000002',
      payload: { name: 'Acme' },
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: { code: 'CONFLICT', message: 'This request conflicts with existing data.' },
    })
  })
})

function jsonRequest(body: unknown) {
  return new Request('http://localhost:3000/api/finance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
