import { afterEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { financeCommandSchema, type FinanceCommand } from '@/lib/finance/contracts'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ db: {} }))
import { updateSubscription } from '@/lib/finance/service'

const d = (value: string | number) => new Prisma.Decimal(value)
const subscriptionId = '00000000-0000-4000-8000-000000000001'
const invoiceId = '00000000-0000-4000-8000-000000000002'
const clientId = '00000000-0000-4000-8000-000000000003'
const requestId = '00000000-0000-4000-8000-000000000004'
type Payload = Extract<FinanceCommand, { type: 'subscription.update' }>['payload']
const context = {
  timezone: 'Asia/Damascus', today: new Date('2026-10-27'), todayText: '2026-10-27',
  periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-31'),
  year: 2026, month: 10, exchangeRate: d(12000),
}
function payload(overrides: Record<string, unknown> = {}): Payload {
  return financeCommandSchema.parse({ type: 'subscription.update', requestId, payload: {
    subscriptionId, monthly: '450', package: 'Social Media', invoiceScope: 'currentMonth',
    invoiceId, expectedInvoiceTotal: '600', reason: 'تصحيح اشتراك الشهر', ...overrides,
  } }).payload as Payload
}
function fixture(invoiceOverrides: Record<string, unknown> = {}, rateAmount = '600') {
  const line = { id: 'line', type: 'SUBSCRIPTION', description: 'Social Media', quantity: d(1), unitAmountUsd: d(600), lineTotalUsd: d(600) }
  const invoice = {
    id: invoiceId, number: 'INV-2026-000001', periodStart: context.periodStart,
    subtotalUsd: d(600), totalUsd: d(600), status: 'ISSUED', issuedAt: new Date(),
    lines: [line], allocations: [] as { amountUsd: Prisma.Decimal }[], ...invoiceOverrides,
  }
  const tx = {
    subscription: {
      findFirst: vi.fn().mockResolvedValue({ id: subscriptionId, clientId, rates: [{ id: 'rate', packageName: 'Social Media', monthlyAmountUsd: d(rateAmount), effectiveFrom: new Date('2026-10-01'), effectiveTo: null }] }),
      update: vi.fn().mockResolvedValue({}),
    },
    subscriptionRate: { update: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) },
    invoice: { findFirst: vi.fn().mockResolvedValue(invoice), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    invoiceLine: { update: vi.fn().mockResolvedValue({}) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    customerPayment: { findMany: vi.fn().mockResolvedValue([]) },
    paymentAllocation: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    cashEntry: { create: vi.fn(), updateMany: vi.fn() },
  }
  return { tx, line, run: (input: Payload = payload()) => updateSubscription(tx as unknown as Prisma.TransactionClient, context, input, requestId) }
}
afterEach(() => vi.unstubAllEnvs())

describe('current-month subscription invoice repricing', () => {
  it('changes a 600 unpaid invoice to 450 without cash, payment changes, or new invoices', async () => {
    vi.stubEnv('ADMIN_USERNAME', 'owner')
    const f = fixture()
    await f.run()
    expect(f.tx.invoiceLine.update).toHaveBeenCalledWith({ where: { id: 'line' }, data: { description: 'Social Media', unitAmountUsd: d(450), lineTotalUsd: d(450) } })
    expect(f.tx.invoice.update).toHaveBeenCalledWith({ where: { id: invoiceId }, data: { subtotalUsd: d(450), totalUsd: d(450), status: 'ISSUED' } })
    expect(f.tx.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      actor: 'owner', requestId, entityType: 'Invoice', entityId: invoiceId,
      before: expect.objectContaining({ total: '600', remaining: '600' }),
      after: expect.objectContaining({ total: '450', paid: '0', remaining: '450' }),
      metadata: expect.objectContaining({ reason: 'تصحيح اشتراك الشهر' }),
    }) })
    expect(f.tx.cashEntry.create).not.toHaveBeenCalled()
    expect(f.tx.cashEntry.updateMany).not.toHaveBeenCalled()
    expect(f.tx.paymentAllocation.create).not.toHaveBeenCalled()
    expect(f.tx.paymentAllocation.delete).not.toHaveBeenCalled()
  })

  it('can reconcile an already changed 450 subscription whose invoice is still 600', async () => {
    const f = fixture({}, '450')
    await f.run()
    expect(f.tx.invoice.update).toHaveBeenCalled()
    expect(f.tx.subscriptionRate.create).not.toHaveBeenCalled()
    expect(f.tx.subscriptionRate.update).not.toHaveBeenCalled()
  })

  it('preserves a partial payment of 150 and reports a remaining balance of 300', async () => {
    const f = fixture({ allocations: [{ amountUsd: d(150) }] })
    await f.run()
    expect(f.tx.invoice.update.mock.calls[0][0].data.status).toBe('PARTIALLY_PAID')
    expect(f.tx.auditEvent.create.mock.calls[0][0].data.after).toMatchObject({ paid: '150', remaining: '300' })
    expect(f.tx.paymentAllocation.update).not.toHaveBeenCalled()
  })

  it('marks the invoice paid when the new total equals existing payments', async () => {
    const f = fixture({ allocations: [{ amountUsd: d(450) }] })
    await f.run()
    expect(f.tx.invoice.update.mock.calls[0][0].data.status).toBe('PAID')
  })

  it('rejects reducing the total below paid money before any subscription or invoice changes', async () => {
    const f = fixture({ allocations: [{ amountUsd: d(500) }] })
    await expect(f.run()).rejects.toThrow('أقل من الدفعات')
    expect(f.tx.invoice.update).not.toHaveBeenCalled()
    expect(f.tx.subscription.update).not.toHaveBeenCalled()
    expect(f.tx.auditEvent.create).not.toHaveBeenCalled()
  })

  it('limits the selected invoice to the current month, subscription, client, and organization', async () => {
    const f = fixture()
    f.tx.invoice.findFirst.mockResolvedValueOnce(null)
    await expect(f.run()).rejects.toThrow('الأشهر السابقة')
    expect(f.tx.invoice.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: invoiceId, organizationId: '00000000-0000-0000-0000-000000000001', subscriptionId, clientId,
      periodStart: context.periodStart, periodEnd: context.periodEnd, voidedAt: null, status: { not: 'VOID' },
    } }))
    expect(f.tx.invoice.update).not.toHaveBeenCalled()
  })

  it('rejects stale totals without overwriting another invoice edit', async () => {
    const f = fixture()
    await expect(f.run(payload({ expectedInvoiceTotal: '650' }))).rejects.toThrow('تغيّرت قيمة الفاتورة')
    expect(f.tx.invoiceLine.update).not.toHaveBeenCalled()
    expect(f.tx.subscription.update).not.toHaveBeenCalled()
  })

  it('keeps other adjustment lines intact rather than replacing the entire invoice', async () => {
    const f = fixture({ subtotalUsd: d(650), totalUsd: d(650) })
    f.tx.invoice.findFirst.mockResolvedValueOnce({
      id: invoiceId, number: 'invoice', periodStart: context.periodStart,
      subtotalUsd: d(650), totalUsd: d(650), issuedAt: new Date(), status: 'ISSUED', allocations: [],
      lines: [f.line, { id: 'extra', type: 'ADJUSTMENT', description: 'Extra work', quantity: d(1), unitAmountUsd: d(50), lineTotalUsd: d(50) }],
    })
    await f.run(payload({ expectedInvoiceTotal: '650' }))
    expect(f.tx.invoice.update.mock.calls[0][0].data.totalUsd.toString()).toBe('500')
    expect(f.tx.invoiceLine.update).toHaveBeenCalledTimes(1)
    expect(f.tx.invoiceLine.update.mock.calls[0][0].where.id).toBe('line')
  })

  it.each(['quantity', 'multiple', 'subtotal', 'total'])('rejects an unsupported custom invoice: %s', async kind => {
    const f = fixture()
    const lines = [{ ...f.line, quantity: kind === 'quantity' ? d(2) : d(1) }]
    if (kind === 'multiple') lines.push({ ...f.line, id: 'second' })
    f.tx.invoice.findFirst.mockResolvedValueOnce({
      id: invoiceId, number: 'invoice', periodStart: context.periodStart,
      subtotalUsd: kind === 'subtotal' ? d(590) : d(600),
      totalUsd: kind === 'total' ? d(650) : d(600), lines, allocations: [], issuedAt: new Date(), status: 'ISSUED',
    })
    await expect(f.run(payload({ expectedInvoiceTotal: kind === 'total' ? '650' : '600' }))).rejects.toThrow('تركيبًا مخصصًا')
    expect(f.tx.invoiceLine.update).not.toHaveBeenCalled()
  })

  it('can increase an invoice and consult unused client credit without creating cash', async () => {
    const f = fixture({ status: 'PAID', allocations: [{ amountUsd: d(600) }] })
    await f.run(payload({ monthly: '700' }))
    expect(f.tx.invoice.update.mock.calls[0][0].data.status).toBe('PARTIALLY_PAID')
    expect(f.tx.customerPayment.findMany).toHaveBeenCalled()
    expect(f.tx.cashEntry.create).not.toHaveBeenCalled()
  })

  it('extends an existing payment allocation using only its unused credit, without a duplicate pair', async () => {
    const f = fixture({ status: 'PAID', allocations: [{ amountUsd: d(600) }] })
    f.tx.customerPayment.findMany.mockResolvedValueOnce([{ id: 'payment', cashEntry: { amountUsd: d(650), status: 'POSTED' }, allocations: [{ amountUsd: d(600) }] }])
    f.tx.invoice.findMany.mockResolvedValueOnce([{ id: invoiceId, totalUsd: d(700), status: 'PARTIALLY_PAID', allocations: [{ id: 'allocation', paymentId: 'payment', amountUsd: d(600) }] }])
    await f.run(payload({ monthly: '700' }))
    expect(f.tx.paymentAllocation.create).not.toHaveBeenCalled()
    expect(f.tx.paymentAllocation.update).toHaveBeenCalledWith({ where: { id: 'allocation' }, data: { amountUsd: d(650) } })
    expect(f.tx.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ entityType: 'PaymentAllocation', action: 'UPDATE', before: { amountUsd: '600' }, after: { amountUsd: '650' }, metadata: expect.objectContaining({ addedCreditUsd: '50' }) }) })
    expect(f.tx.cashEntry.create).not.toHaveBeenCalled()
  })

  it('keeps existing invoices unchanged for the explicit future-only option', async () => {
    const f = fixture()
    await f.run(payload({ invoiceScope: 'futureInvoices' }))
    expect(f.tx.invoice.findFirst).not.toHaveBeenCalled()
    expect(f.tx.invoiceLine.update).not.toHaveBeenCalled()
    expect(f.tx.subscriptionRate.create).toHaveBeenCalled()
  })

  it('does not generate duplicate invoice audits when the invoice already matches', async () => {
    const f = fixture()
    f.tx.invoice.findFirst.mockResolvedValueOnce({
      id: invoiceId, number: 'invoice', periodStart: context.periodStart,
      subtotalUsd: d(450), totalUsd: d(450), lines: [{ ...f.line, unitAmountUsd: d(450), lineTotalUsd: d(450) }],
      allocations: [], status: 'ISSUED', issuedAt: new Date(),
    })
    await f.run(payload({ expectedInvoiceTotal: '450' }))
    expect(f.tx.invoiceLine.update).not.toHaveBeenCalled()
    expect(f.tx.auditEvent.create).not.toHaveBeenCalled()
  })

  it('requires current-invoice identity, expected total, and reason while preserving legacy future-only requests', () => {
    const command = { type: 'subscription.update', requestId, payload: { subscriptionId, monthly: '450' } }
    expect((financeCommandSchema.parse(command).payload as Payload).invoiceScope).toBe('futureInvoices')
    const current = payload()
    for (const key of ['invoiceId', 'expectedInvoiceTotal', 'reason']) {
      expect(financeCommandSchema.safeParse({ ...command, payload: { ...current, [key]: undefined } }).success).toBe(false)
    }
    expect(financeCommandSchema.safeParse({ ...command, payload: { ...current, actor: 'forged' } }).success).toBe(false)
  })
})
