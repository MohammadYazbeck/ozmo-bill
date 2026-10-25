import { describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { financeCommandSchema, type FinanceCommand } from '@/lib/finance/contracts'
import { clientDirectCosts } from '@/lib/finance/client-costs'
import { buildLiabilityClientHistories } from '@/lib/finance/edit-history'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ db: {} }))
import { setLiabilityClient } from '@/lib/finance/service'

const liabilityId = '00000000-0000-4000-8000-000000000001'
const clientId = '00000000-0000-4000-8000-000000000002'
const otherClientId = '00000000-0000-4000-8000-000000000003'
type LinkPayload = Extract<FinanceCommand, { type: 'liability.setClient' }>['payload']
const payload: LinkPayload = { liabilityId, clientId, expectedClientId: null, reason: 'تكلفة تصوير للعميل' }

function fixture(overrides: Record<string, unknown> = {}) {
  const liability = { id: liabilityId, clientId: null, client: null, _count: { payments: 0 }, ...overrides }
  const tx = {
    liability: { findFirst: vi.fn().mockResolvedValue(liability), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    client: { findFirst: vi.fn().mockResolvedValue({ id: clientId }), findUnique: vi.fn().mockResolvedValue({ name: 'OZMO Client' }) },
    cashEntry: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    liabilityPayment: { create: vi.fn(), update: vi.fn() },
  }
  return { tx, run: (input: LinkPayload = payload) => setLiabilityClient(tx as unknown as Prisma.TransactionClient, input) }
}

describe('linking liabilities to client direct costs', () => {
  it('changes only the unpaid obligation client and returns trusted audit facts', async () => {
    const f = fixture()
    const result = await f.run()
    expect(f.tx.liability.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: '00000000-0000-0000-0000-000000000001', voidedAt: null }) }))
    expect(f.tx.liability.updateMany).toHaveBeenCalledWith({
      where: { id: liabilityId, organizationId: '00000000-0000-0000-0000-000000000001', voidedAt: null, clientId: null, payments: { none: {} } },
      data: { clientId },
    })
    expect(result).toMatchObject({ entityType: 'Liability', action: 'UPDATE', before: { clientId: null, client: 'ذمة عامة' }, after: { clientId, client: 'OZMO Client' }, metadata: { source: 'liability-client-link', reason: payload.reason } })
    expect(f.tx.cashEntry.create).not.toHaveBeenCalled()
    expect(f.tx.cashEntry.updateMany).not.toHaveBeenCalled()
    expect(f.tx.liabilityPayment.create).not.toHaveBeenCalled()
  })

  it('can move or remove a client link before any payment', async () => {
    const f = fixture({ clientId: otherClientId, client: { name: 'Previous client' } })
    expect(await f.run({ ...payload, expectedClientId: otherClientId })).toMatchObject({ before: { client: 'Previous client' }, after: { clientId } })
    expect(await f.run({ ...payload, clientId: null, expectedClientId: otherClientId })).toMatchObject({ after: { clientId: null, client: 'ذمة عامة' } })
  })

  it('rejects posted payment history, including previously reversed payments', async () => {
    const f = fixture({ _count: { payments: 1 } })
    await expect(f.run()).rejects.toThrow('دفعات سابقة')
    expect(f.tx.liability.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a stale browser and no-op links', async () => {
    const f = fixture({ clientId: otherClientId })
    await expect(f.run()).rejects.toThrow('تغيّر ربط')
    await expect(f.run({ ...payload, clientId: otherClientId, expectedClientId: otherClientId })).rejects.toThrow('لم تغيّر')
    expect(f.tx.liability.updateMany).not.toHaveBeenCalled()
  })

  it('rejects missing or void liabilities and clients outside the allowed scope', async () => {
    const f = fixture()
    f.tx.liability.findFirst.mockResolvedValueOnce(null)
    await expect(f.run()).rejects.toThrow('Liability')
    f.tx.client.findFirst.mockResolvedValueOnce(null)
    await expect(f.run()).rejects.toThrow('Client')
    expect(f.tx.liability.updateMany).not.toHaveBeenCalled()
  })

  it('refuses a concurrent payment or client change before updating', async () => {
    const f = fixture()
    f.tx.liability.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(f.run()).rejects.toThrow('تغيّرت الذمة')
  })

  it('requires a reason and expected client, and rejects browser identities or amount changes', () => {
    const command = { type: 'liability.setClient', requestId: liabilityId, payload }
    expect(financeCommandSchema.safeParse(command).success).toBe(true)
    expect(financeCommandSchema.safeParse({ ...command, payload: { ...payload, clientId: null } }).success).toBe(true)
    for (const input of [{ ...payload, reason: '' }, { ...payload, expectedClientId: undefined }, { ...payload, actor: 'forged' }, { ...payload, total: '100' }]) {
      expect(financeCommandSchema.safeParse({ ...command, payload: input }).success).toBe(false)
    }
  })

  it('retains every client link edit on the same liability ID', () => {
    const audits = [
      { id: 'latest', entityId: liabilityId, actor: 'owner', occurredAt: new Date('2026-10-25T10:00:00Z'), before: { client: 'A' }, after: { client: 'B' }, metadata: { reason: 'تصحيح الربط' } },
      { id: 'first', entityId: liabilityId, actor: 'owner', occurredAt: new Date('2026-10-25T09:00:00Z'), before: { client: 'ذمة عامة' }, after: { client: 'A' }, metadata: { reason: 'تكلفة مباشرة' } },
    ]
    const history = buildLiabilityClientHistories(audits).get(liabilityId)!
    expect(history.map(row => row.id)).toEqual(['latest', 'first'])
    expect(history[0]).toMatchObject({ actor: 'owner', occurredAt: '2026-10-25T10:00:00.000Z', changes: [{ field: 'client', before: 'A', after: 'B' }] })
  })

  it.each(['0', '150', '500'])('counts the total cost only once when %s of a 500 liability is paid', paid => {
    const costs = clientDirectCosts(clientId, [{ clientId, usd: paid }], [{ clientId, total: '500', paid }])
    expect(costs.total).toBe('500')
  })

  it('ignores general/other client costs and preserves four-decimal precision', () => {
    expect(clientDirectCosts(clientId, [{ clientId, usd: '0.0001' }, { usd: '100' }, { clientId: otherClientId, usd: '200' }], [{ clientId, total: '0.0003', paid: '0.0001' }, { total: '300', paid: '0' }])).toEqual({ paidExpenses: '0.0001', openLiabilities: '0.0002', total: '0.0003' })
  })

  it('does not turn historical overpaid balances into negative direct costs', () => {
    expect(clientDirectCosts(clientId, [], [{ clientId, total: '10', paid: '11' }]).openLiabilities).toBe('0')
  })
})
