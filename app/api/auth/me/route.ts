import { authenticate } from '@/lib/auth/request'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await authenticate(request)
  if (auth.response) return auth.response
  return Response.json({ user: auth.user }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
}
