import type { z } from 'zod'
import { authenticate } from '@/lib/auth/request'
import { canEditFinance, canManageUsers } from '@/lib/auth/types'

const JSON_MEDIA_TYPE = 'application/json'
const MAX_JSON_BYTES = 100 * 1024
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export type ApiErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'ORIGIN_FORBIDDEN'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_JSON'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DATABASE_UNAVAILABLE'
  | 'INTERNAL_ERROR'

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode
    message: string
  }
}

export type ParsedJson<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response }

/**
 * Route handlers must call this even when Proxy already challenged the request.
 * Proxy is a convenience boundary; this function is the handler's auth boundary.
 */
export async function requireApiAuth(request: Request): Promise<Response | null> {
  return (await authenticate(request)).response ?? null
}

/** Rejects cross-origin state changes in production. Safe methods are unaffected. */
export function requireSameOrigin(request: Request): Response | null {
  if (process.env.NODE_ENV !== 'production' || !unsafeMethods.has(request.method.toUpperCase())) {
    return null
  }

  const expectedOrigin = productionOrigin(process.env.APP_DOMAIN)

  if (!expectedOrigin) {
    return apiError(503, 'SERVICE_UNAVAILABLE', 'Service is not securely configured.')
  }

  if (request.headers.get('origin') !== expectedOrigin) {
    return apiError(403, 'ORIGIN_FORBIDDEN', 'Request origin is not allowed.')
  }

  return null
}

/** Authenticates every request and applies CSRF protection to unsafe methods. */
export async function secureApiRequest(request: Request, ownerOnly = false): Promise<Response | null> {
  const auth = await authenticate(request)
  if (auth.response) return auth.response
  if ((ownerOnly && !canManageUsers(auth.user)) || (unsafeMethods.has(request.method.toUpperCase()) && !canEditFinance(auth.user))) {
    return apiError(403, 'PERMISSION_DENIED', ownerOnly ? 'إدارة المستخدمين تحتاج إلى صلاحية تعديل.' : 'حسابك للمشاهدة فقط؛ لا يمكنك تعديل البيانات.')
  }
  return requireSameOrigin(request)
}

/**
 * Reads a JSON body once, enforces a 100 KiB UTF-8 limit, and validates it
 * without returning raw input or internal validation details to the client.
 */
export async function parseJsonRequest<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<ParsedJson<z.output<Schema>>> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()

  if (mediaType !== JSON_MEDIA_TYPE) {
    return {
      ok: false,
      response: apiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.'),
    }
  }

  const declaredLength = request.headers.get('content-length')

  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      return { ok: false, response: apiError(400, 'INVALID_JSON', 'Request body is invalid.') }
    }

    if (Number(declaredLength) > MAX_JSON_BYTES) {
      return { ok: false, response: payloadTooLarge() }
    }
  }

  let rawBody: string

  try {
    rawBody = await request.text()
  } catch {
    return { ok: false, response: apiError(400, 'INVALID_JSON', 'Request body is invalid.') }
  }

  if (new TextEncoder().encode(rawBody).byteLength > MAX_JSON_BYTES) {
    return { ok: false, response: payloadTooLarge() }
  }

  let body: unknown

  try {
    body = JSON.parse(rawBody) as unknown
  } catch {
    return { ok: false, response: apiError(400, 'INVALID_JSON', 'Request body is invalid JSON.') }
  }

  const result = await schema.safeParseAsync(body)

  if (!result.success) {
    return {
      ok: false,
      response: apiError(422, 'VALIDATION_FAILED', 'Request validation failed.'),
    }
  }

  return { ok: true, data: result.data }
}

/** One-call guard for JSON mutation route handlers. */
export async function parseSecureJsonRequest<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<ParsedJson<z.output<Schema>>> {
  const securityFailure = await secureApiRequest(request)

  if (securityFailure) {
    return { ok: false, response: securityFailure }
  }

  return parseJsonRequest(request, schema)
}

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  headers?: HeadersInit,
) {
  return Response.json(
    { error: { code, message } } satisfies ApiErrorBody,
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        ...headers,
      },
    },
  )
}

function payloadTooLarge() {
  return apiError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the 100 KB limit.')
}

function productionOrigin(domain: string | undefined) {
  if (!domain || domain !== domain.trim() || /[\s/@?#]/.test(domain)) return null

  try {
    const url = new URL(`https://${domain}`)

    if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password) {
      return null
    }

    return url.origin
  } catch {
    return null
  }
}
