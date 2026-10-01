import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAdminCredentialStatus, isAuthorized, isPublicPath } from '@/lib/basic-auth'

const REALM = 'OZMO Finance'

export function proxy(request: NextRequest) {
  if (isPublicPath(request.nextUrl.pathname)) {
    return NextResponse.next()
  }

  const username = process.env.ADMIN_USERNAME
  const password = process.env.ADMIN_PASSWORD
  const credentialStatus = getAdminCredentialStatus(username, password)

  if (credentialStatus !== 'configured' || !username || !password) {
    if (process.env.NODE_ENV === 'production') {
      return new NextResponse('Admin credentials are not securely configured.', { status: 503 })
    }

    return NextResponse.next()
  }

  if (isAuthorized(request.headers.get('authorization'), username, password)) {
    return NextResponse.next()
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
    },
  })
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
}
