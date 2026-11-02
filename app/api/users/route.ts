import { apiError, parseJsonRequest, secureApiRequest } from '@/lib/api-security'
import { authenticate } from '@/lib/auth/request'
import { userCommandSchema } from '@/lib/auth/user-contracts'
import { listUsers, manageUser, UserManagementError } from '@/lib/auth/users'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const blocked = await secureApiRequest(request, true)
  if (blocked) return blocked
  const auth = await authenticate(request)
  if (auth.response) return auth.response
  try { return response(await listUsers(auth.user)) } catch (error) { return userError(error) }
}

export async function POST(request: Request) {
  const blocked = await secureApiRequest(request, true)
  if (blocked) return blocked
  const parsed = await parseJsonRequest(request, userCommandSchema)
  if (!parsed.ok) return parsed.response
  const auth = await authenticate(request)
  if (auth.response) return auth.response
  try { return response(await manageUser(auth.user, parsed.data)) } catch (error) { return userError(error) }
}

function response(users: Awaited<ReturnType<typeof listUsers>>) {
  return Response.json({ users }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
}
function userError(error: unknown) {
  if (error instanceof UserManagementError) return apiError(error.status, error.status === 403 ? 'PERMISSION_DENIED' : error.status === 404 ? 'NOT_FOUND' : 'CONFLICT', error.message)
  // Never log request bodies, password hashes or Prisma error details containing credentials.
  return apiError(503, 'SERVICE_UNAVAILABLE', 'تعذّر الوصول للمستخدمين. تأكد من اتصال القاعدة وتطبيق migration المستخدمين.')
}
