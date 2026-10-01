import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  parseJsonRequest,
  parseSecureJsonRequest,
  requireApiAuth,
  requireSameOrigin,
} from '@/lib/api-security'

const credentials = {
  username: 'owner',
  password: '7f9e1d3c5b8a2e6f4d0c9b1a8e7f6d5c',
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('API request security', () => {
  it('allows missing credentials in development but fails closed in production', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(requireApiAuth(request())).toBeNull()

    vi.stubEnv('NODE_ENV', 'production')
    const response = requireApiAuth(request())

    expect(response?.status).toBe(503)
    await expect(response?.json()).resolves.toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service is not securely configured.',
      },
    })
  })

  it('challenges invalid production credentials and accepts valid credentials', () => {
    configureProduction()

    const rejected = requireApiAuth(request())
    const accepted = requireApiAuth(request({ authorization: authorization() }))

    expect(rejected?.status).toBe(401)
    expect(rejected?.headers.get('www-authenticate')).toContain('Basic')
    expect(accepted).toBeNull()
  })

  it('requires the configured HTTPS origin for production mutations', () => {
    configureProduction()

    expect(requireSameOrigin(request({ origin: 'https://bill.ozmo.media' }))).toBeNull()
    expect(requireSameOrigin(request({ origin: 'https://evil.example' }))?.status).toBe(403)
    expect(requireSameOrigin(request())?.status).toBe(403)
    expect(requireSameOrigin(request({}, 'GET'))).toBeNull()
  })

  it('fails closed when APP_DOMAIN is missing for a production mutation', () => {
    configureProduction()
    vi.stubEnv('APP_DOMAIN', '')

    expect(requireSameOrigin(request({ origin: 'https://bill.ozmo.media' }))?.status).toBe(503)
  })

  it('requires JSON and rejects declared or actual bodies above 100 KiB', async () => {
    const schema = z.object({ value: z.string() })
    const wrongType = await parseJsonRequest(request({}, 'POST', '{}', 'text/plain'), schema)
    const declaredLarge = await parseJsonRequest(request({ 'content-length': '102401' }, 'POST', '{}'), schema)
    const actualLarge = await parseJsonRequest(request({}, 'POST', JSON.stringify({ value: 'x'.repeat(102_401) })), schema)

    expect(errorStatus(wrongType)).toBe(415)
    expect(errorStatus(declaredLarge)).toBe(413)
    expect(errorStatus(actualLarge)).toBe(413)
  })

  it('returns safe, standardized malformed JSON and validation errors', async () => {
    const schema = z.strictObject({ value: z.string().min(1) })
    const malformed = await parseJsonRequest(request({}, 'POST', '{'), schema)
    const invalid = await parseJsonRequest(request({}, 'POST', JSON.stringify({ value: '', secret: 'do-not-echo' })), schema)

    expect(errorStatus(malformed)).toBe(400)
    expect(errorStatus(invalid)).toBe(422)

    if (!invalid.ok) {
      expect(await invalid.response.json()).toEqual({
        error: { code: 'VALIDATION_FAILED', message: 'Request validation failed.' },
      })
    }
  })

  it('authenticates, checks origin, and returns validated data in one call', async () => {
    configureProduction()
    const result = await parseSecureJsonRequest(
      request(
        { authorization: authorization(), origin: 'https://bill.ozmo.media' },
        'POST',
        JSON.stringify({ amount: '12.5' }),
      ),
      z.strictObject({ amount: z.coerce.number().positive() }),
    )

    expect(result).toEqual({ ok: true, data: { amount: 12.5 } })
  })
})

function configureProduction() {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('APP_DOMAIN', 'bill.ozmo.media')
  vi.stubEnv('ADMIN_USERNAME', credentials.username)
  vi.stubEnv('ADMIN_PASSWORD', credentials.password)
}

function authorization() {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`
}

function request(
  headers: Record<string, string> = {},
  method = 'POST',
  body = '{}',
  contentType = 'application/json; charset=utf-8',
) {
  return new Request('https://bill.ozmo.media/api/finance', {
    method,
    headers: { 'content-type': contentType, ...headers },
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  })
}

function errorStatus<T>(result: { ok: true; data: T } | { ok: false; response: Response }) {
  return result.ok ? null : result.response.status
}
