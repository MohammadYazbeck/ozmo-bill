import { describe, expect, it } from 'vitest'
import { getAdminCredentialStatus, isAuthorized, isPublicPath } from '@/lib/basic-auth'

function authorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

describe('HTTP Basic authentication', () => {
  it('leaves only the health endpoint public', () => {
    expect(isPublicPath('/api/health')).toBe(true)
    expect(isPublicPath('/')).toBe(false)
    expect(isPublicPath('/api/private')).toBe(false)
  })

  it('accepts valid credentials', () => {
    expect(isAuthorized(authorization('admin', 'strong-password'), 'admin', 'strong-password')).toBe(true)
    expect(isAuthorized(authorization('admin', 'strong-password').replace('Basic', 'basic'), 'admin', 'strong-password')).toBe(true)
  })

  it('rejects missing or incorrect credentials', () => {
    expect(isAuthorized(null, 'admin', 'strong-password')).toBe(false)
    expect(isAuthorized(authorization('admin', 'wrong'), 'admin', 'strong-password')).toBe(false)
  })

  it('rejects missing, weak, and example production credentials', () => {
    expect(getAdminCredentialStatus(undefined, undefined)).toBe('missing')
    expect(getAdminCredentialStatus('admin', 'short')).toBe('unsafe')
    expect(getAdminCredentialStatus('admin', 'replace_with_a_strong_static_password')).toBe('unsafe')
    expect(getAdminCredentialStatus('admin', '7f9e1d3c5b8a2e6f4d0c9b1a8e7f6d5c')).toBe('configured')
  })

  it('rejects usernames that are ambiguous or cannot fit the audit actor field', () => {
    const password = '7f9e1d3c5b8a2e6f4d0c9b1a8e7f6d5c'
    expect(getAdminCredentialStatus(' admin', password)).toBe('unsafe')
    expect(getAdminCredentialStatus('admin:other', password)).toBe('unsafe')
    expect(getAdminCredentialStatus('a'.repeat(101), password)).toBe('unsafe')
    expect(getAdminCredentialStatus('admin', 'a'.repeat(64))).toBe('unsafe')
  })
})
