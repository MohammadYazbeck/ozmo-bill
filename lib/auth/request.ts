import { getAdminCredentialStatus, isAuthorized, parseBasicCredentials } from '@/lib/basic-auth'
import { dummyPasswordHash, verifyPassword } from './passwords'
import type { Principal } from './types'

export type Authentication = { user: Principal; response?: never } | { user?: never; response: Response }
const requests = new WeakMap<Request, Promise<Authentication>>()
const failures = new Map<string, { count: number; expires: number }>()
let verifying = 0
export const ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001'

export function authenticate(request: Request): Promise<Authentication> {
  let result = requests.get(request)
  if (!result) { result = resolveAuthentication(request); requests.set(request, result) }
  return result
}

function failure(status: number, code: string, message: string): Authentication {
  return { response: Response.json({ error: { code, message } }, { status, headers: {
    'Cache-Control': 'no-store',
    ...(status === 401 ? { 'WWW-Authenticate': 'Basic realm="OZMO Finance", charset="UTF-8"' } : {}),
    ...(status === 429 ? { 'Retry-After': '60' } : {}),
  } }) }
}

async function resolveAuthentication(request: Request): Promise<Authentication> {
  const owner = process.env.ADMIN_USERNAME
  const secret = process.env.ADMIN_PASSWORD
  const header = request.headers.get('authorization')
  if (getAdminCredentialStatus(owner, secret) !== 'configured' || !owner || !secret) {
    if (process.env.NODE_ENV === 'production') return failure(503, 'SERVICE_UNAVAILABLE', 'Service is not securely configured.')
    // Preserve the existing local-only development experience, never accept an invalid login.
    if (!header) return { user: { id: 'local-owner', username: 'local-development', name: 'المالك المحلي', role: 'OWNER' } }
  }
  const credentials = parseBasicCredentials(header)
  if (!credentials) return failure(401, 'AUTHENTICATION_REQUIRED', 'Authentication required.')
  const key = credentials.username.toLowerCase()
  const now = Date.now()
  const attempts = failures.get(key)
  if (attempts && attempts.expires > now && attempts.count >= 5) return failure(429, 'RATE_LIMITED', 'محاولات دخول كثيرة. حاول بعد دقيقة.')
  if (owner && secret && isAuthorized(header, owner, secret)) {
    failures.delete(key)
    return { user: { id: 'configured-owner', username: owner, name: 'المالك', role: 'OWNER' } }
  }
  let user: Principal | undefined
  if (key !== owner?.toLowerCase() && /^[a-z0-9][a-z0-9._-]{2,63}$/.test(key) && credentials.password.length <= 128) {
    if (verifying >= 8) return failure(429, 'RATE_LIMITED', 'الخادم مشغول بمحاولات الدخول. حاول بعد دقيقة.')
    verifying++
    try {
      const { db } = await import('@/lib/db')
      const record = await db.appUser.findUnique({ where: { organizationId_username: { organizationId: ORGANIZATION_ID, username: key } } })
      const matches = await verifyPassword(credentials.password, record?.active ? record.passwordHash : dummyPasswordHash)
      if (matches && record?.active) user = { id: record.id, username: record.username, name: record.name, role: record.role }
    } catch {
      return failure(503, 'SERVICE_UNAVAILABLE', 'تعذّر التحقق من حساب المستخدم. تأكد من اتصال القاعدة وتطبيق تحديث المستخدمين.')
    } finally { verifying-- }
  }
  if (user) { failures.delete(key); return { user } }
  // Bounded, process-local throttling. Deployment-level throttling remains recommended.
  if (failures.size >= 1000) failures.delete(failures.keys().next().value!)
  failures.set(key, { count: attempts && attempts.expires > now ? attempts.count + 1 : 1, expires: attempts && attempts.expires > now ? attempts.expires : now + 60_000 })
  return failure(401, 'AUTHENTICATION_REQUIRED', 'Authentication required.')
}
