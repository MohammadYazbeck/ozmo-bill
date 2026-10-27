import { describe, expect, it } from 'vitest'
import type { ExpenseDto, IncomeDto } from '@/lib/finance/contracts'
import { financeCommandSchema } from '@/lib/finance/contracts'
import { expenseDuplicateDraft, incomeDuplicateDraft, incomeFormType } from '@/lib/finance/duplicate-draft'

const clientId = '00000000-0000-4000-8000-000000000001'
const sourceId = '00000000-0000-4000-8000-000000000002'
const newRequestId = '00000000-0000-4000-8000-000000000003'
const income: IncomeDto = {
  id: sourceId, cashEntryId: sourceId, date: '2026-10-10', source: 'اسم العميل المعروض',
  description: 'دفعة تصوير مخصصة', type: 'دخل إضافي من عميل', amount: '123.4567', currency: 'USD',
  usd: '123.4567', note: 'ملاحظات أصلية', clientId, client: 'العميل',
  editHistory: [{ id: 'audit', actor: 'owner', occurredAt: '2026-10-10T12:00:00Z', reason: 'Old edit', changes: [] }],
}
const expense: ExpenseDto = {
  id: sourceId, cashEntryId: sourceId, date: '2026-10-11', name: 'تصوير عميل', category: 'مصور',
  amount: '1200000.1234', currency: 'SYP', usd: '100', note: 'أربع فيديوهات', clientId, client: 'العميل', manual: false,
  editHistory: income.editHistory,
}

describe('new cash-entry drafts copied from existing transactions', () => {
  it('copies every editable income field including raw description, client, date and decimal amount', () => {
    expect(incomeDuplicateDraft(income)).toEqual({
      date: '2026-10-10', source: 'دفعة تصوير مخصصة', type: 'دخل عميل إضافي',
      amount: '123.4567', currency: 'USD', note: 'ملاحظات أصلية', clientId, client: 'العميل',
    })
  })

  it.each([
    ['دخل إضافي من عميل', 'دخل عميل إضافي'], ['دخل إعلاني', 'دخل تشغيل إعلانات'],
    ['دفعة اشتراك', 'دفعة اشتراك'], ['دخل خارجي', 'دخل خارجي'],
  ])('normalizes the saved label %s to the creation form label %s', (saved, expected) => {
    expect(incomeFormType(saved)).toBe(expected)
    expect(incomeDuplicateDraft({ ...income, type: saved })?.type).toBe(expected)
  })

  it('uses the source when older snapshots do not include a raw description', () => {
    expect(incomeDuplicateDraft({ ...income, description: undefined, source: 'عمل خارجي', type: 'دخل خارجي', clientId: undefined, client: undefined }))
      .toEqual({ date: income.date, amount: income.amount, currency: income.currency, note: income.note, type: 'دخل خارجي', source: 'عمل خارجي' })
  })

  it('copies custom expense categories, original SYP amount, client, notes and original date', () => {
    expect(expenseDuplicateDraft(expense)).toEqual({
      date: expense.date, name: expense.name, category: 'مصور', amount: '1200000.1234', currency: 'SYP', note: expense.note, clientId, client: 'العميل',
    })
  })

  it('does not copy identities, USD/rate snapshots, audit events or structured-payment bindings', () => {
    const source = { ...expense, liabilityId: 'old-liability', payrollItemId: 'old-payroll', serviceChargeId: 'old-service', occurrenceId: 'old-period', currencyUnitsPerUsd: '12000' }
    const draft = expenseDuplicateDraft(source)!
    expect(Object.keys(draft).sort()).toEqual(['amount', 'category', 'client', 'clientId', 'currency', 'date', 'name', 'note'].sort())
    expect(Object.keys(incomeDuplicateDraft(income)!)).not.toEqual(expect.arrayContaining(['cashEntryId']))
    for (const key of ['id', 'cashEntryId', 'usd', 'currencyUnitsPerUsd', 'manual', 'editHistory', 'liabilityId', 'payrollItemId', 'serviceChargeId', 'occurrenceId']) {
      expect(draft).not.toHaveProperty(key)
    }
  })

  it('editing the new draft cannot change the source, and each copy starts with source values again', () => {
    const source = Object.freeze({ ...expense })
    const draft = expenseDuplicateDraft(source)!
    draft.note = 'تعديل النسخة فقط'
    draft.amount = '100'
    expect(source.note).toBe('أربع فيديوهات')
    expect(source.amount).toBe('1200000.1234')
    expect(expenseDuplicateDraft(source)?.note).toBe(source.note)
    expect(incomeDuplicateDraft(income)).not.toBe(incomeDuplicateDraft(income))
  })

  it('does not turn synthetic noncash payroll deductions or unsupported incomes into cash copies', () => {
    expect(expenseDuplicateDraft({ ...expense, cashEntryId: undefined })).toBeNull()
    expect(incomeDuplicateDraft({ ...income, type: 'نوع غير مدعوم' })).toBeNull()
    expect(incomeDuplicateDraft({ ...income, cashEntryId: '' })).toBeNull()
  })

  it('allows manual expense creation from a structured payment without carrying its old ID', () => {
    const draft = expenseDuplicateDraft(expense)!
    const { client: displayName, ...payload } = draft
    expect(displayName).toBe('العميل')
    const parsed = financeCommandSchema.parse({ type: 'expense.create', requestId: newRequestId, payload })
    expect(parsed.type).toBe('expense.create')
    expect(parsed.payload).not.toHaveProperty('cashEntryId')
    expect(parsed.requestId).not.toBe(sourceId)
  })

  it('allows a new subscription payment draft without reusing allocations or receipt numbers', () => {
    const draft = incomeDuplicateDraft({ ...income, type: 'دفعة اشتراك' })!
    const { client: displayName, ...payload } = draft
    expect(displayName).toBe('العميل')
    const parsed = financeCommandSchema.parse({ type: 'income.create', requestId: newRequestId, payload })
    expect(parsed.type).toBe('income.create')
    expect(parsed.payload).toMatchObject({ clientId, type: 'دفعة اشتراك', amount: '123.4567' })
    expect(parsed.payload).not.toHaveProperty('receiptNumber')
    expect(parsed.payload).not.toHaveProperty('cashEntryId')
  })
})
