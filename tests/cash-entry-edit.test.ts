import { afterEach, describe, expect, it, vi } from 'vitest'
import { CashDirection, CashEntryKind, CashEntryStatus, CurrencyCode, InvoiceStatus, Prisma } from '@prisma/client'
import type { FinanceCommand } from '@/lib/finance/contracts'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ db: {} }))
import { editCashEntry } from '@/lib/finance/service'

const d = (value: string | number) => new Prisma.Decimal(value)
const id = '00000000-0000-4000-8000-000000000002'
const clientId = '00000000-0000-4000-8000-000000000003'
type EditCommand = Extract<FinanceCommand, { type: 'income.update' | 'expense.update' }>
const context = {
  timezone: 'Asia/Damascus', today: new Date('2026-10-08'), todayText: '2026-10-08',
  periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-31'),
  year: 2026, month: 10, exchangeRate: d(15000),
}

function fixture(overrides: Record<string, unknown> = {}) {
  const original = {
    id, organizationId: '00000000-0000-0000-0000-000000000001',
    direction: CashDirection.INFLOW, kind: CashEntryKind.EXTERNAL_INCOME,
    status: CashEntryStatus.POSTED, occurredOn: new Date('2026-10-08'),
    amountOriginal: d(100), currency: CurrencyCode.USD, currencyUnitsPerUsd: d(1), amountUsd: d(100),
    description: 'External work', note: '', paymentMethod: 'CASH', createdBy: 'owner',
    clientId: null, expenseCategoryId: null, client: null, expenseCategory: null,
    reversedBy: null, customerPayment: null, liabilityPayment: null,
    payrollPayment: null, recurringExpensePayment: null, servicePayment: null,
    ...overrides,
  }
  const created: Prisma.CashEntryUncheckedCreateInput[] = []
  const tx = {
    cashEntry: {
      findFirst: vi.fn().mockResolvedValue(original),
      create: vi.fn(async ({ data }: { data: Prisma.CashEntryUncheckedCreateInput }) => {
        created.push(data)
        return { ...original, ...data, id: data.kind === 'REVERSAL' ? 'reversal' : 'replacement' }
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({ id: 'audit' }) },
    expenseCategory: { upsert: vi.fn().mockResolvedValue({ id: 'category', name: 'أجار' }) },
    client: { findFirst: vi.fn().mockResolvedValue({ id: clientId }), findUnique: vi.fn().mockResolvedValue({ name: 'Client' }) },
    documentSequence: {
      findUnique: vi.fn().mockResolvedValue({ id: 'sequence', nextValue: 2 }),
      update: vi.fn().mockResolvedValue({ id: 'sequence', nextValue: 3 }),
    },
    customerPayment: { create: vi.fn().mockResolvedValue({ id: 'payment' }) },
    paymentAllocation: { create: vi.fn().mockResolvedValue({ id: 'allocation' }) },
    invoice: {
      findUnique: vi.fn().mockResolvedValue({ id: 'invoice', totalUsd: d(450), status: InvoiceStatus.ISSUED, issuedAt: new Date(), allocations: [] }),
      findMany: vi.fn().mockResolvedValue([{ id: 'invoice', totalUsd: d(450), status: InvoiceStatus.ISSUED, allocations: [] }]),
      update: vi.fn().mockResolvedValue({}),
    },
    liabilityPayment: { create: vi.fn().mockResolvedValue({}) },
    liability: {
      findUnique: vi.fn().mockResolvedValue({ id: 'liability', amountUsd: d(450), status: 'PAID', payments: [{ appliedAmountUsd: d(120) }] }),
      update: vi.fn().mockResolvedValue({}),
    },
    recurringExpensePayment: { create: vi.fn().mockResolvedValue({}) },
    recurringExpenseOccurrence: {
      findUnique: vi.fn().mockResolvedValue({ id: 'occurrence', expectedUsd: d(450), status: 'PAID', payments: [{ appliedAmountUsd: d(120) }] }),
      update: vi.fn().mockResolvedValue({}),
    },
    servicePayment: { create: vi.fn().mockResolvedValue({}) },
    serviceCharge: {
      findUnique: vi.fn().mockResolvedValue({ id: 'charge', expectedUsd: d(450), status: 'PAID', payments: [{ appliedAmountUsd: d(120) }] }),
      update: vi.fn().mockResolvedValue({}),
    },
    payrollPayment: { create: vi.fn().mockResolvedValue({}) },
    payrollItem: {
      findUnique: vi.fn().mockResolvedValue({ id: 'payroll', netPayUsd: d(450), advanceDeductionUsd: d(0), status: 'PAID', payments: [{ appliedAmountUsd: d(120) }], advanceRepayments: [] }),
      findMany: vi.fn().mockResolvedValue([{ status: 'PARTIALLY_PAID' }]),
      update: vi.fn().mockResolvedValue({}),
    },
    payrollRun: { findUniqueOrThrow: vi.fn().mockResolvedValue({ status: 'PAID' }), update: vi.fn().mockResolvedValue({}) },
  }
  const run = (command: EditCommand) => editCashEntry(tx as unknown as Prisma.TransactionClient, context, command, command.requestId)
  return { tx, original, created, run }
}

function income(payload: Record<string, unknown> = {}): EditCommand {
  return { type: 'income.update', requestId: id, payload: {
    cashEntryId: id, date: '2026-10-08', source: 'External work', type: 'دخل خارجي',
    amount: '150', currency: 'USD', note: '', clientId: null, reason: 'تصحيح المبلغ', ...payload,
  } } as EditCommand
}

function expense(payload: Record<string, unknown> = {}): EditCommand {
  return { type: 'expense.update', requestId: id, payload: {
    cashEntryId: id, date: '2026-10-08', name: 'Rent', category: 'أجار',
    amount: '120', currency: 'USD', note: '', clientId: null, reason: 'تصحيح المبلغ', ...payload,
  } } as EditCommand
}

afterEach(() => vi.unstubAllEnvs())

describe('append-only income and expense editing', () => {
  it('preserves original facts, offsets them once, and returns before/after audit facts', async () => {
    vi.stubEnv('ADMIN_USERNAME', 'OZMO owner')
    const f = fixture()
    const result = await f.run(income())
    expect(f.original.amountOriginal.toString()).toBe('100')
    expect(f.created[0]).toMatchObject({ kind: 'REVERSAL', direction: 'OUTFLOW', reversalOfId: id, createdBy: 'OZMO owner' })
    expect(f.created[1]).toMatchObject({ direction: 'INFLOW', kind: 'EXTERNAL_INCOME' })
    expect(f.tx.cashEntry.updateMany).toHaveBeenCalledWith({ where: { id, status: 'POSTED' }, data: { status: 'REVERSED' } })
    expect(result).toMatchObject({ action: 'UPDATE', entityId: 'replacement', before: { amount: '100' }, after: { amount: '150' }, metadata: { previousCashEntryId: id, reason: 'تصحيح المبلغ' } })
    expect(f.tx.auditEvent.create.mock.calls[0][0].data.actor).toBe('OZMO owner')
    const net = d(100).minus(d(f.created[0].amountOriginal.toString())).plus(d(f.created[1].amountOriginal.toString()))
    expect(net.toString()).toBe('150')
  })

  it('keeps the original SYP rate when editing the amount on the same date', async () => {
    const f = fixture({ currency: 'SYP', amountOriginal: d(1200000), currencyUnitsPerUsd: d(12000), amountUsd: d(100) })
    const result = await f.run(income({ amount: '1800000', currency: 'SYP' }))
    expect(result.after).toMatchObject({ usd: '150', exchangeRate: '12000' })
    expect(f.created[0].currencyUnitsPerUsd?.toString()).toBe('12000')
    expect(f.created[1].currencyUnitsPerUsd?.toString()).toBe('12000')
  })

  it('rejects no-op edits without producing cash or audit records', async () => {
    const f = fixture()
    await expect(f.run(income({ amount: '100' }))).rejects.toThrow('لم تغيّر')
    expect(f.tx.cashEntry.create).not.toHaveBeenCalled()
    expect(f.tx.auditEvent.create).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'REVERSED' }, { reversedBy: { id: 'other' } },
    { kind: 'REVERSAL' }, { direction: 'OUTFLOW' },
  ])('rejects stale or non-income rows: %j', async overrides => {
    const f = fixture(overrides)
    await expect(f.run(income())).rejects.toThrow()
    expect(f.tx.cashEntry.create).not.toHaveBeenCalled()
  })

  it('rejects future dates before writing any correction', async () => {
    const f = fixture()
    await expect(f.run(income({ date: '2026-10-09' }))).rejects.toThrow('مستقبلي')
    expect(f.tx.cashEntry.create).not.toHaveBeenCalled()
  })

  it('does not orphan subscription payments and requires a client', async () => {
    const f = fixture()
    await expect(f.run(income({ type: 'دفعة اشتراك' }))).rejects.toThrow('اختر العميل')
    expect(f.tx.cashEntry.create).not.toHaveBeenCalled()
  })

  it('reallocates a corrected subscription payment instead of counting both payments', async () => {
    const f = fixture({ kind: 'SUBSCRIPTION_PAYMENT', clientId, client: { name: 'Client' }, amountOriginal: d(150), amountUsd: d(150),
      customerPayment: { id: 'old-payment', allocations: [{ invoiceId: 'invoice', amountUsd: d(150) }] } })
    const result = await f.run(income({ type: 'دفعة اشتراك', clientId, amount: '100' }))
    expect(f.tx.customerPayment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ clientId, cashEntryId: 'replacement' }) }))
    expect(f.tx.paymentAllocation.create.mock.calls[0][0].data.amountUsd.toString()).toBe('100')
    expect(result.after).toMatchObject({ amount: '100', client: 'Client' })
    expect(d(450).minus(d(100)).toString()).toBe('350')
  })

  it('preserves invoice allocations for note-only edits, including an unchanged inactive client', async () => {
    const f = fixture({ kind: 'SUBSCRIPTION_PAYMENT', clientId, client: { name: 'Client' },
      customerPayment: { id: 'old-payment', allocations: [{ invoiceId: 'old-invoice', amountUsd: d(40) }, { invoiceId: 'invoice', amountUsd: d(60) }] } })
    await f.run(income({ type: 'دفعة اشتراك', clientId, amount: '100', note: 'تصحيح البيان' }))
    expect(f.tx.invoice.findMany).not.toHaveBeenCalled()
    expect(f.tx.client.findFirst).not.toHaveBeenCalled()
    expect(f.tx.paymentAllocation.create.mock.calls.map(([arg]) => [arg.data.invoiceId, arg.data.amountUsd.toString()])).toEqual([['old-invoice', '40'], ['invoice', '60']])
  })

  it('can unlink a manual expense from a client without deleting the client', async () => {
    const f = fixture({ direction: 'OUTFLOW', kind: 'MANUAL_EXPENSE', description: 'Rent',
      clientId, client: { name: 'Client' }, expenseCategoryId: 'category', expenseCategory: { name: 'أجار' } })
    const result = await f.run(expense())
    expect(result.before).toMatchObject({ client: 'Client' })
    expect(result.after).toMatchObject({ client: '', category: 'أجار' })
    expect(f.created[1].clientId).toBeUndefined()
  })

  it.each([
    ['LIABILITY_PAYMENT', 'liabilityPayment', 'liabilityId', 'liability', { liabilityId: 'liability', liability: { amountUsd: d(450), incurredOn: new Date('2026-10-01'), status: 'PAID', payments: [] } }],
    ['RECURRING_EXPENSE_PAYMENT', 'recurringExpensePayment', 'occurrenceId', 'occurrence', { occurrenceId: 'occurrence', occurrence: { expectedUsd: d(450), periodStart: new Date('2026-10-01'), status: 'PAID', payments: [] } }],
    ['SERVICE_PAYMENT', 'servicePayment', 'serviceChargeId', 'charge', { serviceChargeId: 'charge', serviceCharge: { expectedUsd: d(450), periodStart: new Date('2026-10-01'), status: 'PAID', payments: [] } }],
    ['PAYROLL_PAYMENT', 'payrollPayment', 'payrollItemId', 'payroll', { payrollItemId: 'payroll', payrollItem: { netPayUsd: d(450), payrollRunId: 'run', payrollRun: { periodStart: new Date('2026-10-01') }, status: 'PAID', payments: [] } }],
  ] as const)('keeps %s attached to the original payable/period', async (kind, relation, target, targetId, binding) => {
    const f = fixture({ direction: 'OUTFLOW', kind, description: 'Rent', expenseCategoryId: 'category', expenseCategory: { name: 'أجار' }, [relation]: binding })
    await f.run(expense())
    expect(f.tx[relation].create).toHaveBeenCalledWith({ data: expect.objectContaining({ [target]: targetId, cashEntryId: 'replacement' }) })
  })

  it('rejects changing a structured payment client or category', async () => {
    const f = fixture({ direction: 'OUTFLOW', kind: 'LIABILITY_PAYMENT', description: 'Rent', expenseCategory: { name: 'أجار' } })
    await expect(f.run(expense({ category: 'رواتب' }))).rejects.toThrow('تصنيف')
    expect(f.tx.cashEntry.create).not.toHaveBeenCalled()
  })

  it('rejects overpaying a linked payable, including other active payments', async () => {
    const f = fixture({ direction: 'OUTFLOW', kind: 'LIABILITY_PAYMENT', description: 'Rent', expenseCategory: { name: 'أجار' },
      liabilityPayment: { liabilityId: 'liability', liability: { amountUsd: d(450), status: 'PAID', incurredOn: new Date('2026-10-01'),
        payments: [{ cashEntryId: id, appliedAmountUsd: d(100) }, { cashEntryId: 'other', appliedAmountUsd: d(350) }] } } })
    await expect(f.run(expense())).rejects.toThrow('يتجاوز')
    expect(f.tx.liabilityPayment.create).not.toHaveBeenCalled()
  })
})
