import { createHash, timingSafeEqual } from 'node:crypto'

export type AdminCredentialStatus = 'configured' | 'missing' | 'unsafe'

const rejectedPasswords = new Set([
  'change-me',
  'changeme',
  'password',
  'replace_with_a_strong_static_password',
])

export function isPublicPath(pathname: string) {
  return pathname === '/api/health'
}

export function getAdminCredentialStatus(
  username: string | undefined,
  password: string | undefined,
): AdminCredentialStatus {
  if (!username || !password) return 'missing'

  if (
    username !== username.trim()
    || username.length > 100
    || /[:\u0000-\u001f\u007f]/.test(username)
    || password.length < 32
    || new Set(password).size < 8
    || rejectedPasswords.has(password.toLowerCase())
  ) {
    return 'unsafe'
  }

  return 'configured'
}

export function isAuthorized(header: string | null, username: string, password: string) {
  const match = header?.match(/^Basic\s+(.+)$/i)

  if (!match) return false

  const decoded = decodeBasicAuth(match[1])

  if (!decoded) return false

  const separator = decoded.indexOf(':')

  if (separator < 0) return false

  const usernameMatches = safeEqual(decoded.slice(0, separator), username)
  const passwordMatches = safeEqual(decoded.slice(separator + 1), password)

  return usernameMatches && passwordMatches
}

function decodeBasicAuth(value: string) {
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))

    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function safeEqual(left: string, right: string) {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest()
  const rightDigest = createHash('sha256').update(right, 'utf8').digest()

  return timingSafeEqual(leftDigest, rightDigest)
}
