import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CashEditHistory } from '@/app/components/cash-edit-history'
import { buildCashEditHistories, cashEditChanges } from '@/lib/finance/edit-history'
import { financeCommandSchema } from '@/lib/finance/contracts'

const event = (entityId: string, previousCashEntryId: string, amount: string) => ({
  id: `audit-${entityId}`, entityId, actor: 'المالك', occurredAt: new Date('2026-10-08T11:00:00Z'),
  before: { amount: '100', note: '' }, after: { amount, note: 'تصحيح' },
  metadata: { previousCashEntryId, reason: 'خطأ إدخال' },
})

describe('persistent edit history', () => {
  it('keeps previous edits when replacement IDs change', () => {
    const histories = buildCashEditHistories([event('third', 'second', '200'), event('second', 'first', '150')])
    expect(histories.get('third')?.map(item => item.id)).toEqual(['audit-third', 'audit-second'])
    expect(histories.get('third')?.[0]).toMatchObject({ actor: 'المالك', reason: 'خطأ إدخال', occurredAt: '2026-10-08T11:00:00.000Z' })
  })
  it('handles broken or cyclic historical metadata safely', () => {
    expect(buildCashEditHistories([event('one', 'two', '150'), event('two', 'one', '200')]).get('one')).toHaveLength(2)
    expect(buildCashEditHistories([event('one', 'missing', '150')]).get('one')).toHaveLength(1)
  })
  it('shows changed fields only, including cleared notes', () => {
    expect(cashEditChanges({ amount: '100', note: 'old', privateToken: 'x' }, { amount: '100', note: '', privateToken: 'y' })).toEqual([{ field: 'note', before: 'old', after: '' }])
  })
  it('renders who, what, when, reason, and escaped user text below a row', () => {
    const history = buildCashEditHistories([event('second', 'first', '150')]).get('second')!
    history[0].actor = '<script>alert(1)</script>'
    const html = renderToStaticMarkup(createElement(CashEditHistory, { history }))
    expect(html).toContain('تم تعديل المبلغ الأصلي، البيان من قبل')
    expect(html).toContain('2026-10-08T11:00:00.000Z')
    expect(html).toContain('سبب التعديل: خطأ إدخال')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('150')
  })
  it('requires an edit reason and refuses a browser-supplied editor identity', () => {
    const command = { type: 'income.update', requestId: '00000000-0000-4000-8000-000000000001', payload: {
      cashEntryId: '00000000-0000-4000-8000-000000000002', date: '2026-10-08',
      source: 'External', type: 'دخل خارجي', amount: '150', currency: 'USD', clientId: null, reason: 'تصحيح',
    } }
    expect(financeCommandSchema.safeParse(command).success).toBe(true)
    expect(financeCommandSchema.safeParse({ ...command, payload: { ...command.payload, reason: '' } }).success).toBe(false)
    expect(financeCommandSchema.safeParse({ ...command, payload: { ...command.payload, actor: 'Someone else' } }).success).toBe(false)
  })
})
