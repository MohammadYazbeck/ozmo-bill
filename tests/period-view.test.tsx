import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PeriodSelector } from '@/app/components/period-selector'
import type { CashLedgerEntryDto, FinanceSnapshot, InvoicePeriodDto, PayrollPeriodDto } from '@/lib/finance/contracts'
import { cashPeriodBalances, inReportMonth, isReportMonth, payrollEmployee, payrollPeriodTotals, selectFinancePeriod, subscriptionPeriodRows } from '@/lib/finance/period-view'

const invoice = (id: string, period: string, amount: string): InvoicePeriodDto => ({ id, clientId: 'client', subscriptionId: 'subscription', period, number: id, issueDate: `${period}-01`, dueDate: `${period}-28`, subtotal: amount, total: amount, paid: '150', remaining: '300', subscriptionAmount: amount, openingBalance: '0', lines: [{ description: `Package ${period}`, quantity: '1', unitAmount: amount, total: amount }] })
const salary = (id: string, period: string, base: string, extra: Partial<PayrollPeriodDto> = {}): PayrollPeriodDto => ({ id, employeeId: 'employee', employeeName: 'Employee', period, base, bonus: '10', deductions: '5', loan: '20', net: String(Number(base) - 15), status: 'READY', ...extra })
const ledger = (id: string, date: string, direction: CashLedgerEntryDto['direction'], amount: string, extra: Partial<CashLedgerEntryDto> = {}): CashLedgerEntryDto => ({ id, date, direction, amount, usd: amount, description: id, kind: 'test', status: 'POSTED', currency: 'USD', reversible: false, ...extra })

function snapshot(): FinanceSnapshot {
  return {
    businessMonth: '2026-11', exchangeRate: '12000', cashbox: { usd: '90', syp: '12000', totalUsd: '91' }, revision: 'unchanged', generatedAt: '2026-11-01T00:00:00Z',
    clients: [{ id: 'client', name: 'Client', phone: '', package: 'Current package', monthly: '600', paid: '150', due: '900', status: 'جزئي', active: true, subscriptionId: 'subscription' }],
    incomes: ['2026-10-31', '2026-11-01'].map((date, index) => ({ id: `income${index}`, cashEntryId: `income${index}`, date, source: 'Source', type: 'دخل خارجي', amount: '10', usd: '10', currency: 'USD', note: '' })),
    expenses: ['2026-10-31', '2026-11-01'].map((date, index) => ({ id: `expense${index}`, date, name: 'Expense', category: 'تشغيل', amount: '2', usd: '2', currency: 'USD', note: '' })),
    advances: ['2026-10-31', '2026-11-01'].map((date, index) => ({ id: `advance${index}`, date, name: 'Owner', kind: 'مالك / شريك', amount: '100', paid: '30' })),
    liabilities: ['2026-10-31', '2026-11-01'].map((date, index) => ({ id: `liability${index}`, date, party: 'Supplier', kind: 'مورد', client: '', description: '', total: '100', paid: '40', due: '2026-12-01' })),
    employees: [{ id: 'employee', name: 'Employee', base: '600', bonus: '0', deductions: '0', loan: '0', payBase: '400', payBonus: '10', payDeductions: '5', payLoan: '20', period: '2026-10', outstandingPeriods: 2, status: 'جاهز للدفع' }],
    fixedExpenses: [{ id: 'rent', name: 'Rent', category: 'أجار', amount: '500', payable: '300', outstanding: '800', payablePeriod: '2026-09', dueDay: 31, status: 'مستحق' }],
    services: [{ id: 'service', name: 'Service', category: 'برامج', amount: '50', payable: '20', outstanding: '70', payablePeriod: '2026-09', cycle: 'شهري', next: '2026-12-01', status: 'مستحق' }],
    payrollSettlements: [{ payrollItemId: 'oct', employeeId: 'employee', employeeName: 'Employee', period: '2026-10', paidOn: '2026-11-01', cashPaid: '385', advanceApplied: '20', netPay: '385', status: 'PAID', reversible: true }],
    cashLedger: [ledger('opening', '2026-09-01', 'INFLOW', '100'), ledger('old-expense', '2026-10-31', 'OUTFLOW', '11', { status: 'REVERSED' }), ledger('reversal', '2026-11-01', 'INFLOW', '11', { reversalOfId: 'old-expense' }), ledger('nov-out', '2026-11-01', 'OUTFLOW', '10'), ledger('syp', '2026-11-01', 'INFLOW', '12000', { currency: 'SYP', usd: '1' })],
    history: {
      invoices: [invoice('oct-invoice', '2026-10', '450'), invoice('nov-invoice', '2026-11', '600')],
      payroll: [salary('oct', '2026-10', '400', { status: 'PAID' }), salary('nov', '2026-11', '600'), salary('void', '2026-10', '9999', { status: 'VOID' }), salary('archived', '2026-10', '200', { employeeId: 'archived', employeeName: 'Archived', archived: true })],
      fixedExpenses: [{ id: 'rent-oct', parentId: 'rent', name: 'Rent', category: 'أجار', dueDay: 31, period: '2026-10', dueDate: '2026-10-31', amount: '400', paid: '400' }],
      services: [{ id: 'service-oct', parentId: 'service', name: 'Service', category: 'برامج', cycle: 'شهري', period: '2026-10', dueDate: '2026-10-15', amount: '30', paid: '10', archived: true }],
    },
  }
}

describe('shared financial period projection', () => {
  it('defaults to all data without copying or changing the existing live balances', () => {
    const raw = snapshot()
    expect(selectFinancePeriod(raw, 'all')).toBe(raw)
    expect(subscriptionPeriodRows(raw, 'all')).toBe(raw.clients)
  })
  it('validates months, including year boundaries, without timezone conversion', () => {
    for (const value of ['2026-01', '2026-12', '2024-02', '1900-01']) expect(isReportMonth(value)).toBe(true)
    for (const value of ['', 'all', '2026-00', '2026-13', '26-01', '2026-1', '2026-01-01']) expect(isReportMonth(value)).toBe(false)
    expect(inReportMonth('2026-12-31', '2026-12')).toBe(true)
    expect(inReportMonth('2027-01-01', '2026-12')).toBe(false)
    expect(() => selectFinancePeriod(snapshot(), '2026-13')).toThrow('Invalid report month')
  })
  it('filters transactions by their recorded date but preserves current client balances', () => {
    const raw = snapshot(), oct = selectFinancePeriod(raw, '2026-10')
    for (const key of ['incomes', 'expenses', 'advances', 'liabilities', 'cashLedger'] as const) {
      expect(oct[key]).toHaveLength(1)
      expect(oct[key][0].date).toBe('2026-10-31')
    }
    expect(oct.clients).toBe(raw.clients)
    expect(oct.clients[0].due).toBe('900')
    expect(oct.advances[0].paid).toBe('30')
    expect(oct.liabilities[0].paid).toBe('40')
    expect(oct.cashbox).toBe(raw.cashbox)
  })
  it('shows an empty month, not an accidental fallback to current rows', () => {
    const empty = selectFinancePeriod(snapshot(), '2020-01')
    for (const key of ['incomes', 'expenses', 'advances', 'liabilities', 'employees', 'fixedExpenses', 'services', 'payrollSettlements', 'cashLedger'] as const) expect(empty[key]).toEqual([])
    expect(subscriptionPeriodRows(snapshot(), '2020-01')).toEqual([])
  })
  it('uses salary entitlement month and saved historical amounts, not payment date or current salary', () => {
    const raw = snapshot(), oct = selectFinancePeriod(raw, '2026-10')
    expect(oct.payrollSettlements).toHaveLength(1)
    expect(oct.payrollSettlements[0].paidOn).toBe('2026-11-01')
    expect(selectFinancePeriod(raw, '2026-11').payrollSettlements).toEqual([])
    expect(payrollEmployee(raw, 'employee', '2026-10')).toMatchObject({ base: '400', payBase: '400', status: 'مدفوع', period: '2026-10' })
    expect(oct.employees.find(row => row.id === 'archived')).toMatchObject({ archived: true, base: '200' })
    expect(payrollEmployee(raw, 'employee', 'all')).toBe(raw.employees[0])
  })
  it('totals all real salary periods exactly, including archived history but excluding void items', () => {
    expect(payrollPeriodTotals(snapshot(), 'all')).toEqual({ base: '1200', bonus: '30', deductions: '15', loan: '60', net: '1155', periods: 3 })
    expect(payrollPeriodTotals(snapshot(), '2026-10')).toMatchObject({ base: '600', net: '570', periods: 2 })
  })
  it('keeps paid historical schedules and original monthly amounts, not the live contract amount', () => {
    const raw = snapshot(), oct = selectFinancePeriod(raw, '2026-10')
    expect(oct.fixedExpenses[0]).toMatchObject({ amount: '400', status: 'مدفوع', outstanding: '0', payable: '0' })
    expect(oct.services[0]).toMatchObject({ amount: '30', payable: '20', outstanding: '20', archived: true, next: '2026-10-15' })
    expect(raw.fixedExpenses[0]).toMatchObject({ amount: '500', payablePeriod: '2026-09', payable: '300' })
  })
  it('exports the selected real invoice rather than the current contract or accumulated client balance', () => {
    const [oct] = subscriptionPeriodRows(snapshot(), '2026-10')
    expect(oct).toMatchObject({ monthly: '450', paid: '150', due: '300', package: 'Package 2026-10', currentInvoiceId: 'oct-invoice', currentInvoiceTotal: '450', currentInvoicePaid: '150', currentInvoiceDue: '300', currentInvoiceOpeningBalance: '0', currentInvoiceIssueDate: '2026-10-01' })
    expect(oct.currentInvoiceLines?.[0].total).toBe('450')
  })
  it('does not silently lose multiple invoices for the same client in one month', () => {
    const raw = snapshot()
    raw.history!.invoices.push(invoice('second-oct', '2026-10', '50'))
    expect(subscriptionPeriodRows(raw, '2026-10').map(row => row.currentInvoiceId)).toEqual(['oct-invoice', 'second-oct'])
  })
  it('calculates month opening plus movement equals closing, including a reversal in a later month', () => {
    const raw = snapshot()
    expect(cashPeriodBalances(raw, '2026-10')).toEqual({ opening: { usd: '100', syp: '0', totalUsd: '100' }, movement: { usd: '-11', syp: '0', totalUsd: '-11' }, closing: { usd: '89', syp: '0', totalUsd: '89' } })
    expect(cashPeriodBalances(raw, '2026-11')).toEqual({ opening: { usd: '89', syp: '0', totalUsd: '89' }, movement: { usd: '1', syp: '12000', totalUsd: '2' }, closing: { usd: '90', syp: '12000', totalUsd: '91' } })
  })
  it('retains exact decimals and negative original-currency cash balances', () => {
    const raw = snapshot()
    raw.cashLedger = [ledger('a', '2026-11-01', 'INFLOW', '0.1'), ledger('b', '2026-11-02', 'INFLOW', '0.2'), ledger('c', '2026-11-03', 'OUTFLOW', '12000', { currency: 'SYP', usd: '9' })]
    expect(cashPeriodBalances(raw, '2026-11').closing).toEqual({ usd: '0.3', syp: '-12000', totalUsd: '-0.7' })
  })
  it('does not mutate raw data, attribution, payment targets or invoice lines when switching periods', () => {
    const raw = snapshot(), before = JSON.stringify(raw)
    const freeze = (value: object) => { Object.freeze(value); for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item) }
    freeze(raw)
    for (const period of ['2026-10', '2026-11', 'all']) {
      selectFinancePeriod(raw, period); subscriptionPeriodRows(raw, period); payrollPeriodTotals(raw, period)
      if (period !== 'all') cashPeriodBalances(raw, period)
    }
    expect(JSON.stringify(raw)).toBe(before)
  })
  it('renders a shared accessible selector with explicit all-months and month mode', () => {
    const props = { businessMonth: '2026-11', note: 'Current settlement state', onChange: () => {} }
    const all = renderToStaticMarkup(createElement(PeriodSelector, { ...props, period: 'all' }))
    expect(all).toContain('value="all" selected=""')
    expect(all).not.toContain('type="month"')
    const month = renderToStaticMarkup(createElement(PeriodSelector, { ...props, period: '2026-10' }))
    expect(month).toContain('aria-label="الشهر"')
    expect(month).toContain('value="2026-10"')
    expect(month).toContain('اختيار الفترة للعرض فقط')
    expect(month).toContain('Current settlement state')
  })
})
