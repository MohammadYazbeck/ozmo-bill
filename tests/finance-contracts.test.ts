import { describe, expect, it } from 'vitest'
import {
  financeCommandSchema,
  nonNegativeMoneyInputSchema,
  positiveExchangeRateInputSchema,
  positiveMoneyInputSchema,
} from '@/lib/finance/contracts'

const requestId = '7d19ec54-92bd-4dd9-8d7a-abfa303f4f7e'
const entityId = '866b5b74-206c-4bd9-a48a-7bc1d554bb60'

describe('finance command contract', () => {
  it('normalizes numeric and string money without a string-number round trip', () => {
    expect(positiveMoneyInputSchema.parse(12.5)).toBe('12.5')
    expect(positiveMoneyInputSchema.parse('000012.5000')).toBe('12.5')
    expect(positiveMoneyInputSchema.parse('9007199254740992.1234')).toBe('9007199254740992.1234')
    expect(positiveExchangeRateInputSchema.parse('12000.12345678')).toBe('12000.12345678')
  })

  it.each([0, -1, '0', '0.000000', '-1', '12.3456789', '12 USD', Number.POSITIVE_INFINITY])(
    'rejects unsafe or non-positive money input %s',
    amount => {
      expect(positiveMoneyInputSchema.safeParse(amount).success).toBe(false)
    },
  )

  it('allows canonical zero values only for non-negative adjustment fields', () => {
    expect(nonNegativeMoneyInputSchema.parse(0)).toBe('0')
    expect(nonNegativeMoneyInputSchema.parse('000.000')).toBe('0')
    expect(financeCommandSchema.parse({
      type: 'employee.update',
      requestId,
      payload: { employeeId: entityId, bonus: 0, deductions: '0', loan: '0.00' },
    }).payload).toMatchObject({ bonus: '0', deductions: '0', loan: '0' })
  })

  it('parses a valid command and transforms its monetary input', () => {
    const result = financeCommandSchema.parse({
      type: 'income.create',
      requestId,
      payload: {
        date: '2026-09-30',
        source: 'Retainer',
        type: 'Subscription payment',
        amount: '001250.50',
        currency: 'USD',
        clientId: entityId,
      },
    })

    expect(result.type).toBe('income.create')
    if (result.type !== 'income.create') throw new Error('Expected income.create')
    expect(result.payload.amount).toBe('1250.5')
  })

  it('rejects malformed dates, currencies, request IDs, and unknown fields', () => {
    const base = {
      type: 'expense.create',
      requestId,
      payload: {
        date: '2026-02-30',
        name: 'Hosting',
        category: 'Services',
        amount: 10,
        currency: 'EUR',
        unexpected: true,
      },
    }

    expect(financeCommandSchema.safeParse(base).success).toBe(false)
    expect(financeCommandSchema.safeParse({ ...base, requestId: 'not-a-uuid' }).success).toBe(false)
  })

  it('rejects values that exceed database column limits', () => {
    expect(financeCommandSchema.safeParse({
      type: 'client.create',
      requestId,
      payload: { name: 'Client', phone: '1'.repeat(51) },
    }).success).toBe(false)

    expect(financeCommandSchema.safeParse({
      type: 'expense.create',
      requestId,
      payload: {
        date: '2026-09-30',
        name: 'Expense',
        category: 'x'.repeat(101),
        amount: 10,
        currency: 'USD',
      },
    }).success).toBe(false)

    expect(financeCommandSchema.safeParse({
      type: 'liability.create',
      requestId,
      payload: {
        date: '2026-09-30',
        due: '2026-10-01',
        party: 'Supplier',
        kind: 'Supplier',
        description: 'x'.repeat(301),
        total: 10,
      },
    }).success).toBe(false)
  })

  it('rejects finance periods outside the database document range', () => {
    expect(financeCommandSchema.safeParse({
      type: 'income.create',
      requestId,
      payload: { date: '1999-12-31', source: 'Legacy', type: 'External', amount: 10, currency: 'USD' },
    }).success).toBe(false)

    expect(financeCommandSchema.safeParse({
      type: 'payroll.pay',
      requestId,
      payload: { employeeId: entityId, period: '1999-12', date: '2026-09-30' },
    }).success).toBe(false)
  })

  it('requires update commands to contain a real change', () => {
    expect(financeCommandSchema.safeParse({
      type: 'client.update',
      requestId,
      payload: { clientId: entityId },
    }).success).toBe(false)
  })

  it('requires a dated, reasoned reversal target', () => {
    expect(financeCommandSchema.parse({
      type: 'cashEntry.reverse',
      requestId,
      payload: {
        cashEntryId: entityId,
        date: '2026-09-30',
        reason: '  Duplicate receipt  ',
      },
    }).payload).toMatchObject({ reason: 'Duplicate receipt' })

    expect(financeCommandSchema.safeParse({
      type: 'cashEntry.reverse',
      requestId,
      payload: { cashEntryId: entityId, date: '2026-09-30', reason: '  ' },
    }).success).toBe(false)

    expect(financeCommandSchema.safeParse({
      type: 'payroll.reverse',
      requestId,
      payload: { payrollItemId: entityId, date: '2026-09-30', reason: 'x' },
    }).success).toBe(false)
  })

  it('recognizes every supported command discriminator', () => {
    const commands = [
      ['client.create', { name: 'Client' }],
      ['client.update', { clientId: entityId, name: 'Renamed' }],
      ['client.setActive', { clientId: entityId, active: false }],
      ['subscription.create', { clientId: entityId, package: 'Monthly', monthly: 100 }],
      ['subscription.update', { subscriptionId: entityId, monthly: '110' }],
      ['subscription.archive', { subscriptionId: entityId }],
      ['income.create', { date: '2026-09-30', source: 'Client', type: 'Subscription', amount: 100, currency: 'USD' }],
      ['cashEntry.reverse', { cashEntryId: entityId, date: '2026-09-30', reason: 'Duplicate posting' }],
      ['expense.create', { date: '2026-09-30', name: 'Rent', category: 'Office', amount: 100, currency: 'USD' }],
      ['liability.create', { date: '2026-09-30', party: 'Supplier', kind: 'Supplier', total: 100, due: '2026-10-01' }],
      ['liability.pay', { liabilityId: entityId, date: '2026-09-30', amount: 10, currency: 'USD' }],
      ['employee.create', { name: 'Employee', base: 500 }],
      ['employee.update', { employeeId: entityId, base: 550 }],
      ['employee.archive', { employeeId: entityId }],
      ['payroll.pay', { employeeId: entityId, period: '2026-09', date: '2026-09-30' }],
      ['payroll.reverse', { payrollItemId: entityId, date: '2026-09-30', reason: 'Incorrect payroll' }],
      ['advance.create', { date: '2026-09-30', name: 'Employee', kind: 'Employee advance', amount: 50 }],
      ['advance.repay', { advanceId: entityId, date: '2026-09-30', amount: 10 }],
      ['fixedExpense.create', { name: 'Rent', category: 'Office', amount: 500, dueDay: 1 }],
      ['fixedExpense.update', { fixedExpenseId: entityId, dueDay: 2 }],
      ['fixedExpense.archive', { fixedExpenseId: entityId }],
      ['fixedExpense.pay', { fixedExpenseId: entityId, date: '2026-09-30', amount: 500, currency: 'USD' }],
      ['service.create', { name: 'Hosting', category: 'Software', amount: 20, cycle: 'Monthly', next: '2026-10-30' }],
      ['service.update', { serviceId: entityId, amount: 25 }],
      ['service.archive', { serviceId: entityId }],
      ['service.pay', { serviceId: entityId, date: '2026-09-30', amount: 20, currency: 'USD' }],
      ['exchangeRate.update', { rate: 12_000 }],
    ] as const

    for (const [type, payload] of commands) {
      expect(financeCommandSchema.safeParse({ type, requestId, payload }).success, type).toBe(true)
    }
  })
})
