import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '@/proxy'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('production proxy authentication', () => {
  it('keeps the health endpoint public', () => {
    vi.stubEnv('NODE_ENV', 'production')

    const response = proxy(new NextRequest('https://finance.example.com/api/health'))

    expect(response.status).toBe(200)
  })

  it('fails closed when credentials are missing or unsafe', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ADMIN_USERNAME', 'admin')
    vi.stubEnv('ADMIN_PASSWORD', 'replace_with_a_strong_static_password')

    const response = proxy(new NextRequest('https://finance.example.com/'))

    expect(response.status).toBe(503)
  })

  it('challenges invalid credentials and accepts valid credentials', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ADMIN_USERNAME', 'owner')
    vi.stubEnv('ADMIN_PASSWORD', '7f9e1d3c5b8a2e6f4d0c9b1a8e7f6d5c')

    const rejected = proxy(new NextRequest('https://finance.example.com/'))
    const accepted = proxy(new NextRequest('https://finance.example.com/', {
      headers: { authorization: authorization('owner', '7f9e1d3c5b8a2e6f4d0c9b1a8e7f6d5c') },
    }))

    expect(rejected.status).toBe(401)
    expect(rejected.headers.get('www-authenticate')).toContain('Basic')
    expect(accepted.status).toBe(200)
  })
})

function authorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}
