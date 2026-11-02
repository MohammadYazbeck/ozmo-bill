import { decimalToUnits, unitsToDecimal, usdEquivalent } from './accounting'
import type { CashboxSnapshot, ClientDto, EmployeeDto, FinanceSnapshot, PayablePeriodDto, PayrollPeriodDto } from './contracts'

export type ReportPeriod = 'all' | string
export const isReportMonth = (month: string) => /^(?:19|[2-9]\d)\d{2}-(?:0[1-9]|1[0-2])$/.test(month)
export const inReportMonth = (date: string, period: ReportPeriod) => period === 'all' || date.slice(0, 7) === period
const sum = (values: string[]) => unitsToDecimal(values.reduce((total, amount) => total + decimalToUnits(amount), 0n))
const remaining = (total: string, paid: string) => { const value = decimalToUnits(total) - decimalToUnits(paid); return unitsToDecimal(value > 0n ? value : 0n) }
const signed = (value: bigint) => value < 0n ? `-${unitsToDecimal(-value)}` : unitsToDecimal(value)

export function payrollEmployee(raw: FinanceSnapshot, employeeId: string, period: ReportPeriod): EmployeeDto | undefined {
  const current = raw.employees.find(employee => employee.id === employeeId)
  if (period === 'all') return current
  const item = raw.history?.payroll.find(row => row.employeeId === employeeId && row.period === period && row.status !== 'VOID')
  if (!item) return !raw.history && current?.period === period ? current : undefined
  return {
    id: employeeId, name: item.employeeName, archived: item.archived,
    base: item.base, bonus: item.bonus, deductions: item.deductions, loan: item.loan,
    payBase: item.base, payBonus: item.bonus, payDeductions: item.deductions, payLoan: item.loan,
    period, outstandingPeriods: item.status === 'PAID' ? 0 : 1,
    status: item.status === 'PAID' ? 'مدفوع' : 'جاهز للدفع',
  }
}

function payableGroups(rows: PayablePeriodDto[], period: string) {
  const groups = new Map<string, PayablePeriodDto[]>()
  for (const row of rows.filter(item => item.period === period)) groups.set(row.parentId, [...(groups.get(row.parentId) ?? []), row])
  return [...groups.values()].map(items => ({
    parent: items[0], amount: sum(items.map(item => item.amount)),
    due: sum(items.map(item => remaining(item.amount, item.paid))),
  }))
}

/** Project only displayed data. Keep the unfiltered snapshot for entry/edit/payment dialogs. */
export function selectFinancePeriod(raw: FinanceSnapshot, period: ReportPeriod): FinanceSnapshot {
  if (period === 'all') return raw
  if (!isReportMonth(period)) throw new Error('Invalid report month')
  const employees = raw.history
    ? [...new Set(raw.history.payroll.filter(row => row.period === period && row.status !== 'VOID').map(row => row.employeeId))]
      .map(id => payrollEmployee(raw, id, period)!).filter(Boolean)
    : raw.employees.filter(row => row.period === period)
  return {
    ...raw,
    incomes: raw.incomes.filter(row => inReportMonth(row.date, period)),
    expenses: raw.expenses.filter(row => inReportMonth(row.date, period)),
    liabilities: raw.liabilities.filter(row => inReportMonth(row.date, period)),
    advances: raw.advances.filter(row => inReportMonth(row.date, period)),
    cashLedger: raw.cashLedger.filter(row => inReportMonth(row.date, period)),
    payrollSettlements: raw.payrollSettlements.filter(row => row.period === period),
    employees,
    // Paid and archived schedules remain readable in their own month.
    fixedExpenses: payableGroups(raw.history?.fixedExpenses ?? [], period).map(({ parent, amount, due }) => ({
      id: parent.parentId, name: parent.name, category: parent.category, archived: parent.archived,
      amount, payable: due, outstanding: due, payablePeriod: period, dueDay: parent.dueDay ?? Number(parent.dueDate.slice(8, 10)),
      status: due === '0' ? 'مدفوع' : 'مستحق',
    })),
    services: payableGroups(raw.history?.services ?? [], period).map(({ parent, amount, due }) => ({
      id: parent.parentId, name: parent.name, category: parent.category, archived: parent.archived,
      amount, payable: due, outstanding: due, payablePeriod: period, cycle: parent.cycle ?? '', next: parent.dueDate,
      status: due === '0' ? 'مدفوع' : 'مستحق',
    })),
    // Receivables and the live cashbox are intentionally not silently redefined.
    // Monthly cash balances are exposed explicitly by cashPeriodBalances().
  }
}

/** One row per actual invoice; receipts allocated later still reflect today's settlement state. */
export function subscriptionPeriodRows(raw: FinanceSnapshot, period: ReportPeriod): ClientDto[] {
  if (period === 'all') return raw.clients
  if (!isReportMonth(period)) throw new Error('Invalid report month')
  return (raw.history?.invoices ?? []).filter(invoice => invoice.period === period).flatMap(invoice => {
    const client = raw.clients.find(row => row.id === invoice.clientId)
    if (!client) return []
    return [{ ...client, subscriptionId: invoice.subscriptionId, monthly: invoice.subscriptionAmount,
      package: invoice.lines[0]?.description ?? client.package, paid: invoice.paid, due: invoice.remaining,
      status: invoice.remaining === '0' ? 'مسدد' as const : decimalToUnits(invoice.paid) > 0n ? 'جزئي' as const : 'مستحق' as const,
      currentInvoiceId: invoice.id, currentInvoiceNumber: invoice.number,
      currentInvoiceIssueDate: invoice.issueDate, currentInvoiceDueDate: invoice.dueDate,
      currentInvoiceSubtotal: invoice.subtotal, currentInvoiceTotal: invoice.total, currentInvoicePaid: invoice.paid,
      currentInvoiceDue: invoice.remaining, currentInvoiceOpeningBalance: invoice.openingBalance, currentInvoiceLines: invoice.lines,
    }]
  })
}

export function payrollPeriodTotals(raw: FinanceSnapshot, period: ReportPeriod) {
  const rows: Pick<PayrollPeriodDto, 'base' | 'bonus' | 'deductions' | 'loan' | 'net'>[] = raw.history
    ? raw.history.payroll.filter(row => row.status !== 'VOID' && inReportMonth(row.period, period))
    : raw.employees.filter(row => inReportMonth(row.period, period)).map(row => ({ ...row, net: unitsToDecimal([
      decimalToUnits(row.base) + decimalToUnits(row.bonus) - decimalToUnits(row.deductions) - decimalToUnits(row.loan), 0n,
    ].reduce((a, b) => a > b ? a : b)) }))
  return { base: sum(rows.map(row => row.base)), bonus: sum(rows.map(row => row.bonus)),
    deductions: sum(rows.map(row => row.deductions)), loan: sum(rows.map(row => row.loan)),
    net: sum(rows.map(row => row.net)), periods: rows.length }
}

export function cashPeriodBalances(raw: FinanceSnapshot, month: string) {
  if (!isReportMonth(month)) throw new Error('Invalid report month')
  const units = (dateTest: (date: string) => boolean) => raw.cashLedger.filter(row => dateTest(row.date)).reduce((value, row) => {
    const amount = decimalToUnits(row.amount) * (row.direction === 'INFLOW' ? 1n : -1n)
    value[row.currency] += amount
    return value
  }, { USD: 0n, SYP: 0n })
  const opening = units(date => date < `${month}-01`)
  const movement = units(date => date.slice(0, 7) === month)
  const closing = { USD: opening.USD + movement.USD, SYP: opening.SYP + movement.SYP }
  const toSnapshot = (value: typeof closing): CashboxSnapshot => {
    const converted = decimalToUnits(usdEquivalent(unitsToDecimal(value.SYP < 0n ? -value.SYP : value.SYP), 'SYP', raw.exchangeRate))
    return { usd: signed(value.USD), syp: signed(value.SYP), totalUsd: signed(value.USD + (value.SYP < 0n ? -converted : converted)) }
  }
  return { opening: toSnapshot(opening), movement: toSnapshot(movement), closing: toSnapshot(closing) }
}
