import { z } from 'zod'

export type Currency = 'USD' | 'SYP'

export type ClientRecord = {
  id: string
  name: string
  phone: string
  package: string
  monthly: number
  paid: number
  due: number
  status: 'مسدد' | 'جزئي' | 'مستحق' | 'متأخر'
  active: boolean
}

export type IncomeRecord = {
  id: string
  date: string
  source: string
  type: string
  amount: number
  currency: Currency
  usd: number
  note: string
  clientId?: string
  client?: string
}

export type ExpenseRecord = {
  id: string
  date: string
  name: string
  category: string
  amount: number
  currency: Currency
  usd: number
  note: string
  clientId?: string
  client?: string
}

export type LiabilityRecord = {
  id: string
  date: string
  party: string
  kind: string
  clientId?: string
  client: string
  description: string
  total: number
  paid: number
  due: string
}

export type EmployeeRecord = {
  id: string
  name: string
  base: number
  bonus: number
  deductions: number
  loan: number
  status: 'جاهز للدفع' | 'مدفوع'
  period: string
  outstandingPeriods: number
}

export type AdvanceRecord = {
  id: string
  date: string
  name: string
  kind: string
  amount: number
  paid: number
}

export type FixedExpenseRecord = {
  id: string
  name: string
  category: string
  amount: number
  dueDay: number
  status: 'مستحق' | 'مدفوع'
}

export type ServiceRecord = {
  id: string
  name: string
  category: string
  amount: number
  cycle: string
  next: string
  status: string
}

export type FinanceData = {
  clients: ClientRecord[]
  incomes: IncomeRecord[]
  expenses: ExpenseRecord[]
  liabilities: LiabilityRecord[]
  employees: EmployeeRecord[]
  advances: AdvanceRecord[]
  fixedExpenses: FixedExpenseRecord[]
  services: ServiceRecord[]
  exchangeRate: number
}

export type MoneyString = string

export type InvoiceLineDto = {
  description: string
  quantity: MoneyString
  unitAmount: MoneyString
  total: MoneyString
}

export type ClientDto = Omit<ClientRecord, 'monthly' | 'paid' | 'due'> & {
  monthly: MoneyString
  paid: MoneyString
  due: MoneyString
  subscriptionId?: string
  currentInvoiceId?: string
  currentInvoiceNumber?: string
  currentInvoiceIssueDate?: string
  currentInvoiceDueDate?: string
  currentInvoiceSubtotal?: MoneyString
  currentInvoiceTotal?: MoneyString
  currentInvoiceOpeningBalance?: MoneyString
  currentInvoiceLines?: InvoiceLineDto[]
}

export type IncomeDto = Omit<IncomeRecord, 'amount' | 'usd'> & {
  cashEntryId: string
  amount: MoneyString
  usd: MoneyString
}

export type ExpenseDto = Omit<ExpenseRecord, 'amount' | 'usd'> & {
  cashEntryId?: string
  amount: MoneyString
  usd: MoneyString
}

export type LiabilityDto = Omit<LiabilityRecord, 'total' | 'paid'> & {
  total: MoneyString
  paid: MoneyString
}

export type EmployeeDto = Omit<EmployeeRecord, 'base' | 'bonus' | 'deductions' | 'loan'> & {
  base: MoneyString
  bonus: MoneyString
  deductions: MoneyString
  loan: MoneyString
  payBase: MoneyString
  payBonus: MoneyString
  payDeductions: MoneyString
  payLoan: MoneyString
}

export type AdvanceDto = Omit<AdvanceRecord, 'amount' | 'paid'> & {
  employeeId?: string
  amount: MoneyString
  paid: MoneyString
}

export type FixedExpenseDto = Omit<FixedExpenseRecord, 'amount'> & {
  amount: MoneyString
  payable: MoneyString
  outstanding: MoneyString
}

export type ServiceDto = Omit<ServiceRecord, 'amount'> & {
  amount: MoneyString
  payable: MoneyString
  outstanding: MoneyString
}

export type CashboxSnapshot = {
  usd: MoneyString
  syp: MoneyString
  totalUsd: MoneyString
}

export type CashLedgerEntryDto = {
  id: string
  date: string
  description: string
  direction: 'INFLOW' | 'OUTFLOW'
  kind: string
  status: 'POSTED' | 'REVERSED'
  amount: MoneyString
  currency: Currency
  usd: MoneyString
  reversalOfId?: string
  reversedById?: string
  reversible: boolean
  reversalCommand?: 'cashEntry.reverse' | 'payroll.reverse'
  reversalTargetId?: string
}

export type PayrollSettlementDto = {
  payrollItemId: string
  employeeId: string
  employeeName: string
  period: string
  paidOn?: string
  cashPaid: MoneyString
  advanceApplied: MoneyString
  netPay: MoneyString
  status: 'READY' | 'PARTIALLY_PAID' | 'PAID' | 'VOID'
  reversible: boolean
}

/** Database bootstrap payload; money remains decimal text across the JSON boundary. */
export type FinanceSnapshot = {
  clients: ClientDto[]
  incomes: IncomeDto[]
  expenses: ExpenseDto[]
  liabilities: LiabilityDto[]
  employees: EmployeeDto[]
  advances: AdvanceDto[]
  fixedExpenses: FixedExpenseDto[]
  services: ServiceDto[]
  cashLedger: CashLedgerEntryDto[]
  payrollSettlements: PayrollSettlementDto[]
  exchangeRate: MoneyString
  cashbox: CashboxSnapshot
  revision: string
  generatedAt: string
}

const MAX_MONEY = Number.MAX_SAFE_INTEGER
const MONEY_PATTERN = /^\d{1,16}(?:\.\d{1,4})?$/
const EXCHANGE_RATE_PATTERN = /^\d{1,12}(?:\.\d{1,8})?$/

/**
 * Monetary command inputs become canonical decimal strings. String inputs are
 * never round-tripped through a JavaScript number, so their decimal precision
 * is preserved for Prisma Decimal/PostgreSQL NUMERIC.
 */
const moneyInputSchema = z.union([
  z.number().finite().nonnegative().max(MAX_MONEY).refine(
    value => MONEY_PATTERN.test(value.toString()),
    'Expected a decimal amount with no more than 4 fractional digits',
  ),
  z.string().trim().regex(MONEY_PATTERN, 'Expected a decimal amount with up to 16 integer and 4 fractional digits'),
])

export const nonNegativeMoneyInputSchema = moneyInputSchema.transform(value => (
  normalizeDecimal(typeof value === 'number' ? value.toString() : value)
))

export const positiveMoneyInputSchema = nonNegativeMoneyInputSchema.refine(
  hasNonZeroDigit,
  'Amount must be greater than zero',
)

export const positiveExchangeRateInputSchema = z.union([
  z.number().finite().positive().max(999_999_999_999).refine(
    value => EXCHANGE_RATE_PATTERN.test(value.toString()),
    'Expected an exchange rate with no more than 8 fractional digits',
  ),
  z.string().trim().regex(EXCHANGE_RATE_PATTERN, 'Expected an exchange rate with up to 12 integer and 8 fractional digits'),
]).transform(value => normalizeDecimal(typeof value === 'number' ? value.toString() : value)).refine(
  hasNonZeroDigit,
  'Exchange rate must be greater than zero',
)

export const currencySchema = z.enum(['USD', 'SYP'])
export const financeDateSchema = z.iso.date().refine(
  value => value >= '2000-01-01' && value <= '9999-12-31',
  'Date must be between 2000-01-01 and 9999-12-31',
)

const requestIdSchema = z.uuid()
const entityIdSchema = z.uuid()
const shortTextSchema = z.string().trim().min(1).max(200)
const categoryTextSchema = z.string().trim().min(1).max(100)
const phoneSchema = z.string().trim().max(50)
const liabilityDescriptionSchema = z.string().trim().max(300).optional()
const noteSchema = z.string().trim().max(4_000).optional()
const reversalReasonSchema = z.string().trim().min(3).max(1_000)
const monthSchema = z.string()
  .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, 'Expected YYYY-MM')
  .refine(value => Number(value.slice(0, 4)) >= 2000, 'Year must be 2000 or later')
const dueDaySchema = z.number().int().min(1).max(31)

const clientCreatePayload = z.strictObject({
  name: shortTextSchema,
  phone: phoneSchema.optional(),
})

const clientUpdatePayload = requireChange(z.strictObject({
  clientId: entityIdSchema,
  name: shortTextSchema.optional(),
  phone: phoneSchema.optional(),
}), ['name', 'phone'])

const subscriptionCreatePayload = z.strictObject({
  clientId: entityIdSchema,
  package: shortTextSchema,
  monthly: positiveMoneyInputSchema,
})

const subscriptionUpdatePayload = requireChange(z.strictObject({
  subscriptionId: entityIdSchema,
  package: shortTextSchema.optional(),
  monthly: positiveMoneyInputSchema.optional(),
}), ['package', 'monthly'])

const employeeUpdatePayload = requireChange(z.strictObject({
  employeeId: entityIdSchema,
  name: shortTextSchema.optional(),
  base: positiveMoneyInputSchema.optional(),
  bonus: nonNegativeMoneyInputSchema.optional(),
  deductions: nonNegativeMoneyInputSchema.optional(),
  loan: nonNegativeMoneyInputSchema.optional(),
}), ['name', 'base', 'bonus', 'deductions', 'loan'])

const fixedExpenseUpdatePayload = requireChange(z.strictObject({
  fixedExpenseId: entityIdSchema,
  name: shortTextSchema.optional(),
  category: categoryTextSchema.optional(),
  amount: positiveMoneyInputSchema.optional(),
  dueDay: dueDaySchema.optional(),
}), ['name', 'category', 'amount', 'dueDay'])

const serviceUpdatePayload = requireChange(z.strictObject({
  serviceId: entityIdSchema,
  name: shortTextSchema.optional(),
  category: categoryTextSchema.optional(),
  amount: positiveMoneyInputSchema.optional(),
  cycle: shortTextSchema.optional(),
  next: financeDateSchema.optional(),
}), ['name', 'category', 'amount', 'cycle', 'next'])

const command = <const Type extends string, Schema extends z.ZodType>(
  type: Type,
  payload: Schema,
) => z.strictObject({
  type: z.literal(type),
  requestId: requestIdSchema,
  payload,
})

export const financeCommandSchema = z.discriminatedUnion('type', [
  command('client.create', clientCreatePayload),
  command('client.update', clientUpdatePayload),
  command('client.setActive', z.strictObject({
    clientId: entityIdSchema,
    active: z.boolean(),
  })),
  command('subscription.create', subscriptionCreatePayload),
  command('subscription.update', subscriptionUpdatePayload),
  command('subscription.archive', z.strictObject({
    subscriptionId: entityIdSchema,
  })),
  command('income.create', z.strictObject({
    date: financeDateSchema,
    source: shortTextSchema,
    type: shortTextSchema,
    amount: positiveMoneyInputSchema,
    currency: currencySchema,
    note: noteSchema,
    clientId: entityIdSchema.optional(),
  })),
  command('cashEntry.reverse', z.strictObject({
    cashEntryId: entityIdSchema,
    date: financeDateSchema,
    reason: reversalReasonSchema,
  })),
  command('expense.create', z.strictObject({
    date: financeDateSchema,
    name: shortTextSchema,
    category: categoryTextSchema,
    amount: positiveMoneyInputSchema,
    currency: currencySchema,
    note: noteSchema,
    clientId: entityIdSchema.optional(),
  })),
  command('liability.create', z.strictObject({
    date: financeDateSchema,
    party: shortTextSchema,
    kind: shortTextSchema,
    clientId: entityIdSchema.optional(),
    description: liabilityDescriptionSchema,
    total: positiveMoneyInputSchema,
    due: financeDateSchema,
  })),
  command('liability.pay', z.strictObject({
    liabilityId: entityIdSchema,
    date: financeDateSchema,
    amount: positiveMoneyInputSchema,
    currency: currencySchema,
    note: noteSchema,
  })),
  command('employee.create', z.strictObject({
    name: shortTextSchema,
    base: positiveMoneyInputSchema,
  })),
  command('employee.update', employeeUpdatePayload),
  command('employee.archive', z.strictObject({
    employeeId: entityIdSchema,
  })),
  command('payroll.pay', z.strictObject({
    employeeId: entityIdSchema,
    period: monthSchema,
    date: financeDateSchema,
    note: noteSchema,
  })),
  command('payroll.reverse', z.strictObject({
    payrollItemId: entityIdSchema,
    date: financeDateSchema,
    reason: reversalReasonSchema,
  })),
  command('advance.create', z.strictObject({
    date: financeDateSchema,
    name: shortTextSchema,
    kind: shortTextSchema,
    amount: positiveMoneyInputSchema,
    employeeId: entityIdSchema.optional(),
  })),
  command('advance.repay', z.strictObject({
    advanceId: entityIdSchema,
    date: financeDateSchema,
    amount: positiveMoneyInputSchema,
    note: noteSchema,
  })),
  command('fixedExpense.create', z.strictObject({
    name: shortTextSchema,
    category: categoryTextSchema,
    amount: positiveMoneyInputSchema,
    dueDay: dueDaySchema,
  })),
  command('fixedExpense.update', fixedExpenseUpdatePayload),
  command('fixedExpense.archive', z.strictObject({
    fixedExpenseId: entityIdSchema,
  })),
  command('fixedExpense.pay', z.strictObject({
    fixedExpenseId: entityIdSchema,
    date: financeDateSchema,
    amount: positiveMoneyInputSchema,
    currency: currencySchema,
    note: noteSchema,
  })),
  command('service.create', z.strictObject({
    name: shortTextSchema,
    category: categoryTextSchema,
    amount: positiveMoneyInputSchema,
    cycle: shortTextSchema,
    next: financeDateSchema,
  })),
  command('service.update', serviceUpdatePayload),
  command('service.archive', z.strictObject({
    serviceId: entityIdSchema,
  })),
  command('service.pay', z.strictObject({
    serviceId: entityIdSchema,
    date: financeDateSchema,
    amount: positiveMoneyInputSchema,
    currency: currencySchema,
    note: noteSchema,
  })),
  command('exchangeRate.update', z.strictObject({
    rate: positiveExchangeRateInputSchema,
    date: financeDateSchema.optional(),
  })),
])

export type FinanceCommand = z.infer<typeof financeCommandSchema>
export type FinanceCommandInput = z.input<typeof financeCommandSchema>
export type CommandInput = FinanceCommandInput

function hasNonZeroDigit(value: string) {
  return /[1-9]/.test(value)
}

function normalizeDecimal(value: string) {
  const [integerPart, fractionPart] = value.split('.')
  const integer = integerPart.replace(/^0+(?=\d)/, '')
  const fraction = fractionPart?.replace(/0+$/, '')

  return fraction ? `${integer}.${fraction}` : integer
}

function requireChange<Schema extends z.ZodObject<z.ZodRawShape>>(
  schema: Schema,
  fields: readonly string[],
) {
  return schema.refine(
    value => fields.some(field => value[field] !== undefined),
    { message: 'At least one field must be changed' },
  )
}
