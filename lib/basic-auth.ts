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
  const credentials = parseBasicCredentials(header)
  if (!credentials) return false
  const usernameMatches = safeEqual(credentials.username, username)
  const passwordMatches = safeEqual(credentials.password, password)
  return usernameMatches && passwordMatches
}

export function parseBasicCredentials(header: string | null) {
  if (!header || header.length > 4096) return null
  const match = header?.match(/^Basic\s+(.+)$/i)
  if (!match) return null

  const decoded = decodeBasicAuth(match[1])

  if (!decoded) return null

  const separator = decoded.indexOf(':')

  if (separator < 1) return null
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
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
