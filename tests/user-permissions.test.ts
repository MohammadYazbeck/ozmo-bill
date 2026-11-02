import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), snapshot: vi.fn(), execute: vi.fn(), list: vi.fn(), manage: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ db: { appUser: { findUnique: mocks.findUnique } } }))
vi.mock('@/lib/finance/service', () => ({ getFinanceSnapshot: mocks.snapshot, executeFinanceCommand: mocks.execute, FinanceServiceError: class extends Error {} }))
vi.mock('@/lib/auth/users', () => ({ listUsers: mocks.list, manageUser: mocks.manage, UserManagementError: class extends Error {} }))
import { authenticate } from '@/lib/auth/request'
import { hashPassword, verifyPassword } from '@/lib/auth/passwords'
import { canEditFinance, canManageUsers } from '@/lib/auth/types'
import { currentActor, currentActorName, withActor } from '@/lib/auth/actor'
import { userCommandSchema } from '@/lib/auth/user-contracts'
import { GET as getFinance, POST as postFinance } from '@/app/api/finance/route'
import { GET as getUsers, POST as postUsers } from '@/app/api/users/route'
import { GET as me } from '@/app/api/auth/me/route'

const password = 'T3st-Safe-Password-2026!'
let encoded: string
let record: { id: string; username: string; name: string; role: 'VIEWER' | 'EDITOR'; active: boolean; passwordHash: string }
beforeAll(async () => { encoded = await hashPassword(password) })
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('APP_DOMAIN', 'bill.ozmo.media')
  vi.stubEnv('ADMIN_USERNAME', 'owner'); vi.stubEnv('ADMIN_PASSWORD', '7f9e1d3c5b8a2e6f4d0c9b1a8e7f6d5c')
  record = { id: '00000000-0000-4000-8000-000000000011', username: 'staff', name: 'غيث', role: 'VIEWER', active: true, passwordHash: encoded }
  mocks.findUnique.mockReset().mockImplementation(async () => record)
  mocks.snapshot.mockReset().mockResolvedValue({ clients: [] }); mocks.execute.mockReset().mockResolvedValue({ clients: [] })
  mocks.list.mockReset().mockResolvedValue([]); mocks.manage.mockReset().mockResolvedValue([])
})
afterEach(() => vi.unstubAllEnvs())
const header = (username: string, secret = password) => `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`
function request(method = 'GET', body?: unknown, auth = header('staff')) {
  return new Request('https://bill.ozmo.media/api/finance', { method, headers: { authorization: auth, origin: 'https://bill.ozmo.media', 'content-type': 'application/json', 'x-user-role': 'OWNER', 'x-user-name': 'spoofed' }, ...(body ? { body: JSON.stringify(body) } : {}) })
}
const command = { type: 'client.create', requestId: '00000000-0000-4000-8000-000000000012', payload: { name: 'Test' } }

describe('server-authoritative users and permissions', () => {
  it('returns only public identity, never the password hash', async () => {
    const response = await me(request())
    expect(await response.json()).toEqual({ user: { id: record.id, username: 'staff', name: 'غيث', role: 'VIEWER' } })
    expect(response.headers.get('cache-control')).toContain('no-store')
  })
  it('allows viewer reads but forbids financial writes before executing any command', async () => {
    expect((await getFinance(request())).status).toBe(200)
    const response = await postFinance(request('POST', command))
    expect(response.status).toBe(403)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('forbids viewer user-list access and privilege escalation', async () => {
    expect((await getUsers(request())).status).toBe(403)
    expect((await postUsers(request('POST', { type: 'create', username: 'intruder', name: 'Intruder', role: 'EDITOR', password }))).status).toBe(403)
    expect(mocks.manage).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled()
  })
  it('gives editor the same management permissions as owner', async () => {
    record.role = 'EDITOR'
    expect((await postFinance(request('POST', command))).status).toBe(200)
    expect((await getUsers(request())).status).toBe(200)
    expect((await postUsers(request('POST', { type: 'create', username: 'newuser', name: 'New', role: 'VIEWER', password }))).status).toBe(200)
    expect(mocks.manage).toHaveBeenCalledWith(expect.objectContaining({ username: 'staff', name: 'غيث', role: 'EDITOR' }), expect.objectContaining({ type: 'create' }))
    expect(canEditFinance({ ...record, role: 'EDITOR' })).toBe(true)
    expect(canManageUsers({ ...record, role: 'EDITOR' })).toBe(true)
  })
  it('still enforces CSRF for editors', async () => {
    record.role = 'EDITOR'; const req = request('POST', command); req.headers.set('origin', 'https://evil.example')
    expect((await postFinance(req)).status).toBe(403); expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('checks active status and role again on the very next request', async () => {
    record.role = 'EDITOR'; expect((await authenticate(request())).user?.role).toBe('EDITOR')
    record.role = 'VIEWER'; expect((await postFinance(request('POST', command))).status).toBe(403)
    record.active = false; expect((await authenticate(request())).response?.status).toBe(401)
  })
  it('rejects old passwords after a password reset', async () => {
    record.passwordHash = await hashPassword('Another-Safe-Password-42!')
    expect((await authenticate(request())).response?.status).toBe(401)
    expect((await authenticate(request('GET', undefined, header('staff', 'Another-Safe-Password-42!')))).user?.id).toBe(record.id)
  })
  it('preserves the existing configured owner without depending on the user table', async () => {
    mocks.findUnique.mockRejectedValue(new Error('db down'))
    expect((await authenticate(request('GET', undefined, header('owner', process.env.ADMIN_PASSWORD)))).user?.role).toBe('OWNER')
    expect(mocks.findUnique).not.toHaveBeenCalled()
  })
  it('fails closed if the user store is unavailable', async () => {
    mocks.findUnique.mockRejectedValue(new Error('db down'))
    expect((await authenticate(request())).response?.status).toBe(503)
  })
  it('throttles repeated invalid passwords without performing unbounded scrypt work', async () => {
    mocks.findUnique.mockResolvedValue(null)
    for (let i = 0; i < 5; i++) expect((await authenticate(request('GET', undefined, header('unknown-rate-test', 'Wrong-Password-2026!')))).response?.status).toBe(401)
    const response = (await authenticate(request('GET', undefined, header('unknown-rate-test', 'Wrong-Password-2026!')))).response
    expect(response?.status).toBe(429); expect(response?.headers.get('retry-after')).toBe('60')
    expect(mocks.findUnique).toHaveBeenCalledTimes(5)
  })
  it('never interprets an invalid development login as local owner', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('ADMIN_USERNAME', ''); vi.stubEnv('ADMIN_PASSWORD', '')
    record.active = false
    expect((await authenticate(request())).response?.status).toBe(401)
  })
  it('isolates authenticated audit identity between concurrent async operations', async () => {
    const users = [{ id: 'one', username: 'ghaith', name: 'غيث', role: 'EDITOR' as const }, { id: 'two', username: 'other', name: 'آخر', role: 'EDITOR' as const }]
    const names = await Promise.all(users.map(user => withActor(user, async () => { await Promise.resolve(); return [currentActor(), currentActorName()] })))
    expect(names).toEqual([['ghaith', 'غيث'], ['other', 'آخر']]); expect(currentActor()).toBeUndefined()
  })
  it('hashes with unique salts and verifies without storing plaintext', async () => {
    const second = await hashPassword(password)
    expect(second).not.toBe(encoded); expect(encoded).not.toContain(password)
    expect(await verifyPassword(password, encoded)).toBe(true); expect(await verifyPassword('wrong', encoded)).toBe(false)
    expect(await verifyPassword(password, 'invalid')).toBe(false)
  })
  it('rejects weak passwords, owner role assignment and spoofed actor fields', async () => {
    await expect(hashPassword('weak')).rejects.toThrow()
    const base = { type: 'create', username: 'newuser', name: 'New', password, role: 'VIEWER' }
    expect(userCommandSchema.safeParse(base).success).toBe(true)
    expect(userCommandSchema.safeParse({ ...base, role: 'OWNER' }).success).toBe(false)
    expect(userCommandSchema.safeParse({ ...base, actor: 'fake' }).success).toBe(false)
    expect(userCommandSchema.safeParse({ ...base, password: 'a'.repeat(20) }).success).toBe(false)
  })
})
