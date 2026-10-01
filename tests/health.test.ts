import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const findUnique = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { appSetting: { findUnique } },
}))

import { GET } from '@/app/api/health/route'

beforeEach(() => {
  findUnique.mockReset()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('DATABASE_URL', 'postgresql://ozmo_app:secret@db:5432/ozmo_bill?schema=public')
  vi.stubEnv('ADMIN_USERNAME', 'owner')
  vi.stubEnv('ADMIN_PASSWORD', '7f9e1d3c5b8a2e6f4d0c9b1a8e7f6d5c')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('GET /api/health', () => {
  it('reports healthy only when the seeded schema version is ready', async () => {
    findUnique.mockResolvedValue({ value: 1 })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(body).toMatchObject({ status: 'ok', service: 'ozmo-bill' })
    expect(body).not.toHaveProperty('database')
    expect(body).not.toHaveProperty('auth')
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_key: {
          organizationId: '00000000-0000-0000-0000-000000000001',
          key: 'schemaVersion',
        },
      },
      select: { value: true },
    })
  })

  it('reports unavailable when the database check fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    findUnique.mockRejectedValue(new Error('database unavailable'))

    const response = await GET()

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'error', service: 'ozmo-bill' })
  })

  it('reports unavailable when the baseline seed is missing or outdated', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    findUnique.mockResolvedValue({ value: 0 })

    const response = await GET()

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'error', service: 'ozmo-bill' })
  })

  it('reports unavailable when production credentials are unsafe', async () => {
    findUnique.mockResolvedValue({ value: 1 })
    vi.stubEnv('ADMIN_PASSWORD', 'replace_with_a_strong_static_password')

    const response = await GET()

    expect(response.status).toBe(503)
  })
})
