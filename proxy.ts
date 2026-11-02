import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAdminCredentialStatus, isAuthorized, isPublicPath, parseBasicCredentials } from '@/lib/basic-auth'

export async function proxy(request: NextRequest) {
  if (isPublicPath(request.nextUrl.pathname)) {
    return NextResponse.next()
  }

  // API handlers enforce their own auth + permission + CSRF boundary.
  // Avoid hashing passwords twice for every API request.
  if (request.nextUrl.pathname.startsWith('/api/')) return NextResponse.next()
  const username = process.env.ADMIN_USERNAME
  const password = process.env.ADMIN_PASSWORD
  if (getAdminCredentialStatus(username, password) !== 'configured' || !username || !password) {
    return process.env.NODE_ENV === 'production'
      ? new NextResponse('Admin credentials are not securely configured.', { status: 503 })
      : NextResponse.next()
  }
  const header = request.headers.get('authorization')
  if (isAuthorized(header, username, password)) return NextResponse.next()
  const credentials = parseBasicCredentials(header)
  // Optimistic shell gate only: this statically rendered page contains no financial
  // data. Prisma must stay out of Proxy's separate runtime. Every data/API route,
  // including /api/auth/me, verifies the actual password and live role itself.
  if (credentials && credentials.username.toLowerCase() !== username.toLowerCase()
    && /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(credentials.username)
    && credentials.password.length <= 128) return NextResponse.next()
  return new NextResponse('Authentication required.', { status: 401, headers: {
    'WWW-Authenticate': 'Basic realm="OZMO Finance", charset="UTF-8"',
    'Cache-Control': 'no-store',
  } })
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
}
