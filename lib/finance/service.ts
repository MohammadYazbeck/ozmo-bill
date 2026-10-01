import 'server-only'

import { createHash } from 'node:crypto'
import {
  AdvanceRecipientType,
  AdvanceStatus,
  AuditAction,
  BillingCycle,
  CashDirection,
  CashEntryKind,
  CashEntryStatus,
  ClientStatus,
  CurrencyCode,
  DocumentType,
  EmployeeStatus,
  IdempotencyStatus,
  InvoiceLineType,
  InvoiceStatus,
  LiabilityPartyType,
  LiabilityStatus,
  PayableStatus,
  PaymentMethod,
  PayrollItemStatus,
  PayrollRunStatus,
  Prisma,
  ServiceSubscriptionStatus,
  SubscriptionStatus,
} from '@prisma/client'
import { db } from '@/lib/db'
import type {
  AdvanceDto,
  CashLedgerEntryDto,
  ClientDto,
  EmployeeDto,
  ExpenseDto,
  FinanceCommand,
  FinanceSnapshot,
  FixedExpenseDto,
  IncomeDto,
  LiabilityDto,
  PayrollSettlementDto,
  ServiceDto,
} from '@/lib/finance/contracts'

const ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001'
const IDEMPOTENCY_SCOPE = 'finance-command'
const ZERO = new Prisma.Decimal(0)
const ONE = new Prisma.Decimal(1)
const MAX_PERIOD_CATCH_UP = 240

const ACTIVE_PAYMENT_ALLOCATION_WHERE = {
  payment: { cashEntry: { status: CashEntryStatus.POSTED } },
} satisfies Prisma.PaymentAllocationWhereInput

const ACTIVE_ADVANCE_REPAYMENT_WHERE = {
  reversedAt: null,
  OR: [
    { cashEntryId: null },
    { cashEntry: { status: CashEntryStatus.POSTED } },
  ],
} satisfies Prisma.AdvanceRepaymentWhereInput

type Tx = Prisma.TransactionClient

type ServiceErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DATABASE_UNAVAILABLE'
  | 'INTERNAL_ERROR'

type PeriodContext = {
  timezone: string
  today: Date
  todayText: string
  periodStart: Date
  periodEnd: Date
  year: number
  month: number
  exchangeRate: Prisma.Decimal
}

type MutationResult = {
  entityType: string
  entityId: string
  action: AuditAction
  before?: Prisma.InputJsonValue
  after?: Prisma.InputJsonValue
  metadata?: Record<string, Prisma.InputJsonValue>
}

export class FinanceServiceError extends Error {
  readonly status: number
  readonly code: ServiceErrorCode

  constructor(code: ServiceErrorCode, status: number, message: string) {
    super(message)
    this.name = 'FinanceServiceError'
    this.code = code
    this.status = status
  }
}

export async function getFinanceSnapshot(): Promise<FinanceSnapshot> {
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await db.$transaction(async tx => {
          const context = await getPeriodContext(tx)
          await ensureCurrentRecords(tx, context)
          return buildSnapshot(tx, context)
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 30_000,
        })
      } catch (error) {
        if (attempt < 2 && isRetryableTransactionError(error)) continue
        throw error
      }
    }

    throw new Error('Unreachable snapshot retry state')
  } catch (error) {
    throw mapDatabaseError(error)
  }
}

export async function executeFinanceCommand(command: FinanceCommand): Promise<FinanceSnapshot> {
  const requestHash = commandFingerprint(command)

  try {
    let commandCompleted = false

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await db.$transaction(async tx => {
        const prior = await tx.idempotencyRecord.findUnique({
          where: {
            organizationId_scope_key: {
              organizationId: ORGANIZATION_ID,
              scope: IDEMPOTENCY_SCOPE,
              key: command.requestId,
            },
          },
        })

        if (prior) {
          if (prior.requestHash !== requestHash) {
            throw conflict('This request ID was already used for different data.')
          }
          if (prior.status === IdempotencyStatus.COMPLETED) return
          throw conflict('This request is already being processed.')
        }

        await tx.idempotencyRecord.create({
          data: {
            organizationId: ORGANIZATION_ID,
            scope: IDEMPOTENCY_SCOPE,
            key: command.requestId,
            requestHash,
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          },
        })

        const context = await getPeriodContext(tx)
        await ensureCurrentRecords(tx, context)
        const result = await applyCommand(tx, context, command)

        await tx.auditEvent.create({
          data: {
            organizationId: ORGANIZATION_ID,
            actor: requestActor(),
            action: result.action,
            entityType: result.entityType,
            entityId: result.entityId,
            requestId: command.requestId,
            before: result.before,
            after: result.after,
            metadata: { commandType: command.type, ...(result.metadata ?? {}) },
          },
        })

        await tx.idempotencyRecord.update({
          where: {
            organizationId_scope_key: {
              organizationId: ORGANIZATION_ID,
              scope: IDEMPOTENCY_SCOPE,
              key: command.requestId,
            },
          },
          data: {
            status: IdempotencyStatus.COMPLETED,
            responseStatus: 200,
            responseBody: { ok: true },
            resourceType: result.entityType,
            resourceId: isUuid(result.entityId) ? result.entityId : undefined,
          },
        })
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 30_000,
        })
      } catch (error) {
        if (attempt < 2 && isRetryableTransactionError(error)) continue

        if (isUniqueConstraintError(error)) {
          const prior = await db.idempotencyRecord.findUnique({
            where: {
              organizationId_scope_key: {
                organizationId: ORGANIZATION_ID,
                scope: IDEMPOTENCY_SCOPE,
                key: command.requestId,
              },
            },
          })

          if (prior) {
            if (prior.requestHash !== requestHash) {
              throw conflict('This request ID was already used for different data.')
            }
            if (prior.status !== IdempotencyStatus.COMPLETED) {
              throw conflict('This request is already being processed.')
            }
          } else {
            throw error
          }
        } else {
          throw error
        }
      }

      commandCompleted = true
      break
    }

    if (!commandCompleted) throw new Error('Unreachable command retry state')

    return await getFinanceSnapshot()
  } catch (error) {
    throw mapDatabaseError(error)
  }
}

async function applyCommand(
  tx: Tx,
  context: PeriodContext,
  command: FinanceCommand,
): Promise<MutationResult> {
  switch (command.type) {
    case 'client.create':
      return createClient(tx, command.payload)
    case 'client.update':
      return updateClient(tx, command.payload)
    case 'client.setActive':
      return setClientActive(tx, command.payload)
    case 'subscription.create':
      return createSubscription(tx, context, command.payload)
    case 'subscription.update':
      return updateSubscription(tx, context, command.payload)
    case 'subscription.archive':
      return archiveSubscription(tx, context, command.payload.subscriptionId)
    case 'income.create':
      return createIncome(tx, context, command.payload)
    case 'cashEntry.reverse':
      return reverseCashEntry(tx, context, command.payload, command.requestId)
    case 'expense.create':
      return createExpense(tx, context, command.payload)
    case 'liability.create':
      return createLiability(tx, context, command.payload)
    case 'liability.pay':
      return payLiability(tx, context, command.payload)
    case 'employee.create':
      return createEmployee(tx, context, command.payload)
    case 'employee.update':
      return updateEmployee(tx, context, command.payload)
    case 'employee.archive':
      return archiveEmployee(tx, context, command.payload.employeeId)
    case 'payroll.pay':
      return payPayroll(tx, context, command.payload)
    case 'payroll.reverse':
      return reversePayroll(tx, context, command.payload, command.requestId)
    case 'advance.create':
      return createAdvance(tx, context, command.payload)
    case 'advance.repay':
      return repayAdvance(tx, context, command.payload)
    case 'fixedExpense.create':
      return createFixedExpense(tx, context, command.payload)
    case 'fixedExpense.update':
      return updateFixedExpense(tx, context, command.payload)
    case 'fixedExpense.archive':
      return archiveFixedExpense(tx, context, command.payload.fixedExpenseId)
    case 'fixedExpense.pay':
      return payFixedExpense(tx, context, command.payload)
    case 'service.create':
      return createService(tx, context, command.payload)
    case 'service.update':
      return updateService(tx, context, command.payload)
    case 'service.archive':
      return archiveService(tx, context, command.payload.serviceId)
    case 'service.pay':
      return payService(tx, context, command.payload)
    case 'exchangeRate.update':
      return updateExchangeRate(tx, context, command.payload)
  }
}

async function getPeriodContext(tx: Tx, now = new Date()): Promise<PeriodContext> {
  const organization = await tx.organization.findUnique({
    where: { id: ORGANIZATION_ID },
    select: { timezone: true },
  })
  if (!organization) {
    throw new FinanceServiceError(
      'DATABASE_UNAVAILABLE',
      503,
      'The finance database has not been initialized.',
    )
  }

  const timezone = process.env.APP_TIME_ZONE?.trim() || organization.timezone
  const local = localDateParts(now, timezone)
  const todayText = `${local.year}-${pad(local.month)}-${pad(local.day)}`
  const today = parseDate(todayText)
  const exchangeRate = await currentExchangeRate(tx, today)

  return {
    timezone,
    today,
    todayText,
    periodStart: parseDate(`${local.year}-${pad(local.month)}-01`),
    periodEnd: endOfMonth(local.year, local.month),
    year: local.year,
    month: local.month,
    exchangeRate,
  }
}

async function currentExchangeRate(tx: Tx, today: Date) {
  const rate = await tx.exchangeRate.findFirst({
    where: {
      organizationId: ORGANIZATION_ID,
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.SYP,
      effectiveAt: { lte: today },
    },
    orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }],
    select: { rate: true },
  })
  if (!rate || rate.rate.lte(ZERO)) {
    throw new FinanceServiceError(
      'DATABASE_UNAVAILABLE',
      503,
      'The exchange rate has not been configured.',
    )
  }
  return rate.rate
}

async function exchangeRateForDate(tx: Tx, date: Date) {
  const rate = await tx.exchangeRate.findFirst({
    where: {
      organizationId: ORGANIZATION_ID,
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.SYP,
      effectiveAt: { lte: date },
    },
    orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }],
    select: { rate: true },
  })

  if (!rate || rate.rate.lte(ZERO)) {
    throw conflict(`No exchange rate is configured for ${dateText(date)}.`)
  }

  return rate.rate
}

async function ensureCurrentRecords(tx: Tx, context: PeriodContext) {
  await ensureInvoicesForPeriod(tx, context)
  await ensureRecurringExpensesForPeriod(tx, context.periodStart, context.periodEnd)
  await ensurePayrollThrough(tx, context.periodStart)
  await ensureServiceChargesThrough(tx, context.periodEnd)
}

async function createClient(
  tx: Tx,
  payload: Extract<FinanceCommand, { type: 'client.create' }>['payload'],
): Promise<MutationResult> {
  if ((payload.phone?.length ?? 0) > 50) throw conflict('Phone number cannot exceed 50 characters.')
  const client = await tx.client.create({
    data: {
      organizationId: ORGANIZATION_ID,
      name: payload.name,
      phone: payload.phone || null,
    },
  })
  return mutation('Client', client.id, AuditAction.CREATE)
}

async function updateClient(
  tx: Tx,
  payload: Extract<FinanceCommand, { type: 'client.update' }>['payload'],
): Promise<MutationResult> {
  if ((payload.phone?.length ?? 0) > 50) throw conflict('Phone number cannot exceed 50 characters.')
  await requireClient(tx, payload.clientId)
  const client = await tx.client.update({
    where: { id: payload.clientId },
    data: {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.phone !== undefined ? { phone: payload.phone || null } : {}),
    },
  })
  return mutation('Client', client.id, AuditAction.UPDATE)
}

async function setClientActive(
  tx: Tx,
  payload: Extract<FinanceCommand, { type: 'client.setActive' }>['payload'],
): Promise<MutationResult> {
  await requireClient(tx, payload.clientId)
  const client = await tx.client.update({
    where: { id: payload.clientId },
    data: { status: payload.active ? ClientStatus.ACTIVE : ClientStatus.INACTIVE },
  })
  return mutation('Client', client.id, AuditAction.UPDATE)
}

async function createSubscription(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'subscription.create' }>['payload'],
): Promise<MutationResult> {
  await requireClient(tx, payload.clientId)
  const existing = await tx.subscription.findFirst({
    where: {
      organizationId: ORGANIZATION_ID,
      clientId: payload.clientId,
      status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAUSED] },
      archivedAt: null,
    },
    select: { id: true },
  })
  if (existing) throw conflict('This client already has a current subscription.')

  const subscription = await tx.subscription.create({
    data: {
      organizationId: ORGANIZATION_ID,
      clientId: payload.clientId,
      name: payload.package,
      status: SubscriptionStatus.ACTIVE,
      startDate: context.today,
      dueDay: Math.min(context.today.getUTCDate(), 28),
      nextInvoiceDate: context.periodStart,
      rates: {
        create: {
          packageName: payload.package,
          monthlyAmountUsd: decimal(payload.monthly),
          effectiveFrom: context.today,
        },
      },
    },
  })

  return mutation('Subscription', subscription.id, AuditAction.CREATE)
}

async function updateSubscription(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'subscription.update' }>['payload'],
): Promise<MutationResult> {
  const subscription = await tx.subscription.findFirst({
    where: { id: payload.subscriptionId, organizationId: ORGANIZATION_ID, archivedAt: null },
    include: { rates: { orderBy: { effectiveFrom: 'desc' }, take: 1 } },
  })
  if (!subscription) throw notFound('Subscription')
  const currentRate = subscription.rates[0]
  if (!currentRate) throw new FinanceServiceError('INTERNAL_ERROR', 500, 'Subscription pricing is missing.')

  const packageName = payload.package ?? currentRate.packageName
  const monthlyAmountUsd = payload.monthly !== undefined
    ? decimal(payload.monthly)
    : currentRate.monthlyAmountUsd

  await tx.subscription.update({
    where: { id: subscription.id },
    data: { ...(payload.package !== undefined ? { name: payload.package } : {}) },
  })

  if (sameDate(currentRate.effectiveFrom, context.today)) {
    await tx.subscriptionRate.update({
      where: { id: currentRate.id },
      data: { packageName, monthlyAmountUsd },
    })
  } else {
    if (!currentRate.effectiveTo || currentRate.effectiveTo.getTime() >= context.today.getTime()) {
      await tx.subscriptionRate.update({
        where: { id: currentRate.id },
        data: { effectiveTo: addDays(context.today, -1) },
      })
    }
    await tx.subscriptionRate.create({
      data: {
        subscriptionId: subscription.id,
        packageName,
        monthlyAmountUsd,
        effectiveFrom: context.today,
      },
    })
  }

  return mutation('Subscription', subscription.id, AuditAction.UPDATE)
}

async function archiveSubscription(
  tx: Tx,
  context: PeriodContext,
  subscriptionId: string,
): Promise<MutationResult> {
  const subscription = await tx.subscription.findFirst({
    where: { id: subscriptionId, organizationId: ORGANIZATION_ID, archivedAt: null },
    select: { id: true },
  })
  if (!subscription) throw notFound('Subscription')
  await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      status: SubscriptionStatus.CANCELED,
      endDate: context.today,
      nextInvoiceDate: null,
      archivedAt: new Date(),
    },
  })
  return mutation('Subscription', subscription.id, AuditAction.ARCHIVE)
}

async function createIncome(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'income.create' }>['payload'],
): Promise<MutationResult> {
  const isSubscriptionPayment = payload.type === 'دفعة اشتراك'
  if (isSubscriptionPayment && !payload.clientId) {
    throw conflict('A subscription payment must be linked to a client.')
  }
  if (payload.clientId) await requireClient(tx, payload.clientId)
  const kind = isSubscriptionPayment
    ? CashEntryKind.SUBSCRIPTION_PAYMENT
    : payload.clientId
      ? CashEntryKind.CLIENT_EXTRA_INCOME
      : incomeKind(payload.type)
  const cash = await createCashEntry(tx, context, {
    direction: CashDirection.INFLOW,
    kind,
    occurredOn: parseDate(payload.date),
    amount: decimal(payload.amount),
    currency: payload.currency as CurrencyCode,
    description: payload.source,
    note: payload.note,
    clientId: payload.clientId,
  })

  if (isSubscriptionPayment && payload.clientId) {
    const receiptNumber = await nextDocumentNumber(tx, DocumentType.RECEIPT, yearOf(payload.date))
    const payment = await tx.customerPayment.create({
      data: {
        organizationId: ORGANIZATION_ID,
        clientId: payload.clientId,
        cashEntryId: cash.id,
        receiptNumber,
        receivedOn: parseDate(payload.date),
        note: payload.note,
      },
    })
    await allocatePaymentFifo(tx, payment.id, payload.clientId, cash.amountUsd)
  }

  return mutation('CashEntry', cash.id, AuditAction.POST)
}

async function createExpense(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'expense.create' }>['payload'],
): Promise<MutationResult> {
  if (payload.clientId) await requireClient(tx, payload.clientId)
  const category = await resolveExpenseCategory(tx, payload.category)
  const cash = await createCashEntry(tx, context, {
    direction: CashDirection.OUTFLOW,
    kind: CashEntryKind.MANUAL_EXPENSE,
    occurredOn: parseDate(payload.date),
    amount: decimal(payload.amount),
    currency: payload.currency as CurrencyCode,
    description: payload.name,
    note: payload.note,
    clientId: payload.clientId,
    expenseCategoryId: category.id,
  })
  return mutation('CashEntry', cash.id, AuditAction.POST)
}

async function reverseCashEntry(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'cashEntry.reverse' }>['payload'],
  requestId: string,
): Promise<MutationResult> {
  const original = await tx.cashEntry.findFirst({
    where: { id: payload.cashEntryId, organizationId: ORGANIZATION_ID },
    include: {
      reversedBy: { select: { id: true } },
      customerPayment: { include: { allocations: { select: { invoiceId: true } } } },
      liabilityPayment: { select: { liabilityId: true } },
      payrollPayment: { select: { payrollItemId: true } },
      advanceDisbursement: {
        include: {
          repayments: {
            where: ACTIVE_ADVANCE_REPAYMENT_WHERE,
            select: { id: true },
          },
        },
      },
      advanceRepayment: { select: { advanceId: true } },
      recurringExpensePayment: {
        select: {
          occurrenceId: true,
          occurrence: { select: { template: { select: { archivedAt: true } } } },
        },
      },
      servicePayment: {
        select: {
          serviceChargeId: true,
          serviceCharge: { select: { serviceSubscription: { select: { archivedAt: true } } } },
        },
      },
    },
  })
  if (!original) throw notFound('Cash entry')
  if (original.kind === CashEntryKind.REVERSAL) {
    throw conflict('A reversal entry cannot itself be reversed.')
  }
  if (original.status === CashEntryStatus.REVERSED || original.reversedBy) {
    throw conflict('This cash entry has already been reversed.')
  }
  if (original.kind === CashEntryKind.PAYROLL_PAYMENT) {
    throw conflict('Payroll payments must be reversed from the payroll settlement.')
  }

  const reversedOn = parseDate(payload.date)
  validateReversalDate(context, original.occurredOn, reversedOn)

  if (original.kind === CashEntryKind.SUBSCRIPTION_PAYMENT && !original.customerPayment) {
    throw invariant('Subscription payment application is missing.')
  }
  if (original.kind === CashEntryKind.LIABILITY_PAYMENT && !original.liabilityPayment) {
    throw invariant('Liability payment application is missing.')
  }
  if (original.kind === CashEntryKind.ADVANCE_DISBURSEMENT) {
    if (!original.advanceDisbursement) throw invariant('Advance disbursement application is missing.')
    if (original.advanceDisbursement.repayments.length > 0) {
      throw conflict('Reverse all active advance repayments before reversing the disbursement.')
    }
  }
  if (original.kind === CashEntryKind.ADVANCE_REPAYMENT && !original.advanceRepayment) {
    throw invariant('Advance repayment application is missing.')
  }
  if (original.kind === CashEntryKind.RECURRING_EXPENSE_PAYMENT) {
    if (!original.recurringExpensePayment) throw invariant('Fixed-expense payment application is missing.')
    if (original.recurringExpensePayment.occurrence.template.archivedAt) {
      throw conflict('Restore the fixed-expense template before reversing this payment.')
    }
  }
  if (original.kind === CashEntryKind.SERVICE_PAYMENT) {
    if (!original.servicePayment) throw invariant('Service payment application is missing.')
    if (original.servicePayment.serviceCharge.serviceSubscription.archivedAt) {
      throw conflict('Restore the service subscription before reversing this payment.')
    }
  }

  const reversal = await createCompensatingCashEntry(tx, original, reversedOn, payload.reason)
  await createCorrectionAudit(tx, {
    requestId,
    action: AuditAction.POST,
    entityType: 'CashEntry',
    entityId: reversal.id,
    after: { status: CashEntryStatus.POSTED, reversalOfId: original.id },
    metadata: { source: 'cash-entry-reversal', reason: payload.reason },
  })

  if (original.customerPayment) {
    const invoiceIds = [...new Set(original.customerPayment.allocations.map(item => item.invoiceId))]
    for (const invoiceId of invoiceIds) await refreshInvoiceStatus(tx, invoiceId, requestId)
  }
  if (original.liabilityPayment) {
    await refreshLiabilityStatus(tx, original.liabilityPayment.liabilityId, requestId)
  }
  if (original.advanceDisbursement) {
    const before = original.advanceDisbursement.status
    await tx.advance.update({
      where: { id: original.advanceDisbursement.id },
      data: { status: AdvanceStatus.VOID, voidedAt: new Date() },
    })
    await createCorrectionAudit(tx, {
      requestId,
      action: AuditAction.VOID,
      entityType: 'Advance',
      entityId: original.advanceDisbursement.id,
      before: { status: before },
      after: { status: AdvanceStatus.VOID },
      metadata: { source: 'cash-entry-reversal', cashEntryId: original.id },
    })
  }
  if (original.advanceRepayment) {
    await refreshAdvanceStatus(tx, original.advanceRepayment.advanceId, requestId)
  }
  if (original.recurringExpensePayment) {
    await refreshRecurringOccurrenceStatus(tx, original.recurringExpensePayment.occurrenceId, requestId)
  }
  if (original.servicePayment) {
    await refreshServiceChargeStatus(tx, original.servicePayment.serviceChargeId, requestId)
  }

  return {
    entityType: 'CashEntry',
    entityId: original.id,
    action: AuditAction.REVERSE,
    before: { status: CashEntryStatus.POSTED },
    after: { status: CashEntryStatus.REVERSED, reversalCashEntryId: reversal.id },
    metadata: {
      reason: payload.reason,
      reversedOn: payload.date,
      reversalCashEntryId: reversal.id,
    },
  }
}

async function reversePayroll(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'payroll.reverse' }>['payload'],
  requestId: string,
): Promise<MutationResult> {
  const item = await tx.payrollItem.findFirst({
    where: {
      id: payload.payrollItemId,
      payrollRun: { organizationId: ORGANIZATION_ID },
    },
    include: {
      employee: { select: { archivedAt: true } },
      payrollRun: { select: { id: true, periodStart: true } },
      payments: {
        include: { cashEntry: { include: { reversedBy: { select: { id: true } } } } },
      },
      advanceRepayments: {
        where: { reversedAt: null },
        select: { id: true, advanceId: true, repaidOn: true, amountUsd: true },
      },
    },
  })
  if (!item) throw notFound('Payroll item')
  if (item.employee.archivedAt) {
    throw conflict('Restore the employee before reversing this payroll settlement.')
  }
  if (item.status === PayrollItemStatus.VOID) throw conflict('A void payroll item cannot be reversed.')

  const activePayments = item.payments.filter(payment => (
    payment.cashEntry.status === CashEntryStatus.POSTED
    && payment.cashEntry.kind !== CashEntryKind.REVERSAL
    && !payment.cashEntry.reversedBy
  ))
  const hasRecordedSettlement = item.status === PayrollItemStatus.PAID
    || item.status === PayrollItemStatus.PARTIALLY_PAID
    || activePayments.length > 0
    || item.advanceRepayments.length > 0
  if (!hasRecordedSettlement) throw conflict('This payroll settlement is not posted or has already been reversed.')

  const reversedOn = parseDate(payload.date)
  validateReversalDate(context, item.payrollRun.periodStart, reversedOn)
  for (const payment of activePayments) {
    validateReversalDate(context, payment.cashEntry.occurredOn, reversedOn)
  }
  for (const repayment of item.advanceRepayments) {
    validateReversalDate(context, repayment.repaidOn, reversedOn)
  }

  const reversalCashEntryIds: string[] = []
  for (const payment of activePayments) {
    const reversal = await createCompensatingCashEntry(tx, payment.cashEntry, reversedOn, payload.reason)
    reversalCashEntryIds.push(reversal.id)
    await createCorrectionAudit(tx, {
      requestId,
      action: AuditAction.REVERSE,
      entityType: 'CashEntry',
      entityId: payment.cashEntry.id,
      before: { status: CashEntryStatus.POSTED },
      after: { status: CashEntryStatus.REVERSED, reversalCashEntryId: reversal.id },
      metadata: { source: 'payroll-reversal', reason: payload.reason },
    })
    await createCorrectionAudit(tx, {
      requestId,
      action: AuditAction.POST,
      entityType: 'CashEntry',
      entityId: reversal.id,
      after: { status: CashEntryStatus.POSTED, reversalOfId: payment.cashEntry.id },
      metadata: { source: 'payroll-reversal', reason: payload.reason },
    })
  }

  const reversedAt = new Date()
  const affectedAdvanceIds = [...new Set(item.advanceRepayments.map(repayment => repayment.advanceId))]
  for (const repayment of item.advanceRepayments) {
    await tx.advanceRepayment.update({
      where: { id: repayment.id },
      data: { reversedAt },
    })
    await createCorrectionAudit(tx, {
      requestId,
      action: AuditAction.REVERSE,
      entityType: 'AdvanceRepayment',
      entityId: repayment.id,
      before: { reversedAt: null, amountUsd: repayment.amountUsd.toString() },
      after: { reversedAt: reversedAt.toISOString() },
      metadata: { source: 'payroll-reversal', payrollItemId: item.id, reason: payload.reason },
    })
  }
  for (const advanceId of affectedAdvanceIds) await refreshAdvanceStatus(tx, advanceId, requestId)

  const priorStatus = item.status
  const status = await refreshPayrollItemStatus(tx, item.id, requestId)
  await refreshPayrollRunStatus(tx, item.payrollRun.id, requestId)

  return {
    entityType: 'PayrollItem',
    entityId: item.id,
    action: AuditAction.REVERSE,
    before: { status: priorStatus },
    after: { status },
    metadata: {
      reason: payload.reason,
      reversedOn: payload.date,
      reversalCashEntryIds,
    },
  }
}

async function createLiability(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'liability.create' }>['payload'],
): Promise<MutationResult> {
  const incurredOn = parseDate(payload.date)
  const dueDate = parseDate(payload.due)
  if (incurredOn.getTime() > context.today.getTime()) {
    throw conflict('Liabilities cannot be posted with a future incurred date.')
  }
  if (dueDate.getTime() < incurredOn.getTime()) {
    throw conflict('Liability due date cannot be before its incurred date.')
  }
  if ((payload.description?.length ?? 0) > 300) {
    throw conflict('Liability description cannot exceed 300 characters.')
  }
  if (payload.clientId) await requireClient(tx, payload.clientId)
  const category = await resolveExpenseCategory(tx, payload.kind)
  const liability = await tx.liability.create({
    data: {
      organizationId: ORGANIZATION_ID,
      clientId: payload.clientId,
      expenseCategoryId: category.id,
      payeeName: payload.party,
      partyType: liabilityPartyType(payload.kind),
      incurredOn,
      dueDate,
      description: payload.description || payload.kind,
      amountOriginal: decimal(payload.total),
      currency: CurrencyCode.USD,
      currencyUnitsPerUsd: ONE,
      amountUsd: decimal(payload.total),
    },
  })
  return mutation('Liability', liability.id, AuditAction.CREATE)
}

async function payLiability(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'liability.pay' }>['payload'],
): Promise<MutationResult> {
  const liability = await tx.liability.findFirst({
    where: { id: payload.liabilityId, organizationId: ORGANIZATION_ID, voidedAt: null },
    include: {
      payments: {
        where: { cashEntry: { status: CashEntryStatus.POSTED } },
        select: { appliedAmountUsd: true },
      },
    },
  })
  if (!liability) throw notFound('Liability')
  const paidOn = parseDate(payload.date)
  if (paidOn.getTime() < liability.incurredOn.getTime()) {
    throw conflict('A liability payment cannot predate the liability.')
  }
  const applied = sumDecimal(liability.payments.map(payment => payment.appliedAmountUsd))
  const remaining = liability.amountUsd.minus(applied)
  if (remaining.lte(ZERO)) throw conflict('This liability has already been paid.')

  const categoryId = liability.expenseCategoryId ?? (await resolveExpenseCategory(tx, 'التزامات')).id
  const cash = await createCashEntry(tx, context, {
    direction: CashDirection.OUTFLOW,
    kind: CashEntryKind.LIABILITY_PAYMENT,
    occurredOn: paidOn,
    amount: decimal(payload.amount),
    currency: payload.currency as CurrencyCode,
    description: `دفع مستحق: ${liability.payeeName}`,
    note: payload.note,
    clientId: liability.clientId ?? undefined,
    expenseCategoryId: categoryId,
  })
  if (cash.amountUsd.gt(remaining)) throw conflict('Payment exceeds the outstanding liability balance.')

  const payment = await tx.liabilityPayment.create({
    data: {
      liabilityId: liability.id,
      cashEntryId: cash.id,
      appliedAmountUsd: cash.amountUsd,
      paidOn,
    },
  })
  await tx.liability.update({
    where: { id: liability.id },
    data: {
      status: cash.amountUsd.eq(remaining)
        ? LiabilityStatus.PAID
        : LiabilityStatus.PARTIALLY_PAID,
    },
  })
  return mutation('LiabilityPayment', payment.id, AuditAction.POST)
}

async function createEmployee(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'employee.create' }>['payload'],
): Promise<MutationResult> {
  const employee = await tx.employee.create({
    data: {
      organizationId: ORGANIZATION_ID,
      name: payload.name,
      status: EmployeeStatus.ACTIVE,
      hireDate: context.today,
      compensationHistory: {
        create: {
          effectiveFrom: context.today,
          baseSalaryUsd: decimal(payload.base),
        },
      },
    },
  })
  await ensurePayrollForPeriod(tx, context.periodStart, context.periodEnd)
  return mutation('Employee', employee.id, AuditAction.CREATE)
}

async function updateEmployee(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'employee.update' }>['payload'],
): Promise<MutationResult> {
  const employee = await tx.employee.findFirst({
    where: { id: payload.employeeId, organizationId: ORGANIZATION_ID, archivedAt: null },
    include: { compensationHistory: { orderBy: { effectiveFrom: 'desc' }, take: 1 } },
  })
  if (!employee) throw notFound('Employee')
  const compensation = employee.compensationHistory[0]
  if (!compensation) throw new FinanceServiceError('INTERNAL_ERROR', 500, 'Employee compensation is missing.')

  await ensurePayrollForPeriod(tx, context.periodStart, context.periodEnd)
  const payrollItem = await tx.payrollItem.findFirst({
    where: {
      employeeId: employee.id,
      payrollRun: { organizationId: ORGANIZATION_ID, periodStart: context.periodStart },
    },
    include: {
      payments: {
        where: { cashEntry: { status: CashEntryStatus.POSTED } },
        select: { appliedAmountUsd: true },
      },
    },
  })
  if (!payrollItem) throw new FinanceServiceError('INTERNAL_ERROR', 500, 'The current payroll item is missing.')

  if (payrollItem.status !== PayrollItemStatus.READY && (
    payload.base !== undefined ||
    payload.bonus !== undefined ||
    payload.deductions !== undefined ||
    payload.loan !== undefined
  )) {
    throw conflict('Paid payroll items cannot be edited.')
  }

  if (payload.base !== undefined) {
    const newBase = decimal(payload.base)
    if (sameDate(compensation.effectiveFrom, context.today)) {
      await tx.employeeCompensation.update({
        where: { id: compensation.id },
        data: { baseSalaryUsd: newBase },
      })
    } else {
      await tx.employeeCompensation.update({
        where: { id: compensation.id },
        data: { effectiveTo: addDays(context.today, -1) },
      })
      await tx.employeeCompensation.create({
        data: {
          employeeId: employee.id,
          effectiveFrom: context.today,
          baseSalaryUsd: newBase,
        },
      })
    }
  }

  const base = payload.base !== undefined ? decimal(payload.base) : payrollItem.baseSalaryUsd
  const bonus = payload.bonus !== undefined ? decimal(payload.bonus) : payrollItem.bonusUsd
  const deductions = payload.deductions !== undefined
    ? decimal(payload.deductions)
    : payrollItem.deductionUsd
  const loan = payload.loan !== undefined ? decimal(payload.loan) : payrollItem.advanceDeductionUsd
  const outstandingAdvances = await employeeAdvanceBalance(tx, employee.id)
  if (loan.gt(outstandingAdvances)) {
    throw conflict('Advance deduction exceeds the employee advance balance.')
  }
  const gross = base.plus(bonus).plus(payrollItem.otherEarningsUsd)
  const deductionTotal = deductions.plus(loan)
  const net = gross.minus(deductionTotal)
  if (net.lt(ZERO)) throw conflict('Payroll deductions cannot exceed gross earnings.')

  await tx.employee.update({
    where: { id: employee.id },
    data: { ...(payload.name !== undefined ? { name: payload.name } : {}) },
  })
  await tx.payrollItem.update({
    where: { id: payrollItem.id },
    data: {
      baseSalaryUsd: base,
      bonusUsd: bonus,
      deductionUsd: deductions,
      advanceDeductionUsd: loan,
      grossEarningsUsd: gross,
      deductionTotalUsd: deductionTotal,
      netPayUsd: net,
    },
  })
  return mutation('Employee', employee.id, AuditAction.UPDATE)
}

async function archiveEmployee(
  tx: Tx,
  context: PeriodContext,
  employeeId: string,
): Promise<MutationResult> {
  const employee = await tx.employee.findFirst({
    where: { id: employeeId, organizationId: ORGANIZATION_ID, archivedAt: null },
    select: { id: true },
  })
  if (!employee) throw notFound('Employee')
  const unpaidPayrollItems = await tx.payrollItem.count({
    where: {
      employeeId: employee.id,
      status: { in: [PayrollItemStatus.READY, PayrollItemStatus.PARTIALLY_PAID] },
    },
  })
  if (unpaidPayrollItems > 0) {
    throw conflict('Pay or void all outstanding payroll items before archiving this employee.')
  }
  await tx.employee.update({
    where: { id: employee.id },
    data: {
      status: EmployeeStatus.INACTIVE,
      endDate: context.today,
      archivedAt: new Date(),
    },
  })
  return mutation('Employee', employee.id, AuditAction.ARCHIVE)
}

async function payPayroll(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'payroll.pay' }>['payload'],
): Promise<MutationResult> {
  const employee = await requireEmployee(tx, payload.employeeId)
  const periodStart = parseDate(`${payload.period}-01`)
  const paidOn = parseDate(payload.date)
  if (paidOn.getTime() < periodStart.getTime()) {
    throw conflict('A payroll payment cannot predate its payroll period.')
  }
  if (paidOn.getTime() > context.today.getTime()) {
    throw conflict('Payroll payments cannot be posted with a future date.')
  }
  if (employee.hireDate && paidOn.getTime() < employee.hireDate.getTime()) {
    throw conflict('A payroll payment cannot predate the employee hire date.')
  }
  const [year, month] = payload.period.split('-').map(Number)
  await ensurePayrollForPeriod(tx, periodStart, endOfMonth(year, month))
  const item = await tx.payrollItem.findFirst({
    where: {
      employeeId: payload.employeeId,
      payrollRun: { organizationId: ORGANIZATION_ID, periodStart },
    },
    include: {
      employee: { select: { name: true } },
      payments: {
        where: { cashEntry: { status: CashEntryStatus.POSTED } },
        select: { appliedAmountUsd: true },
      },
    },
  })
  if (!item) throw notFound('Payroll item')
  const alreadyPaid = sumDecimal(item.payments.map(payment => payment.appliedAmountUsd))
  const remaining = item.netPayUsd.minus(alreadyPaid)
  if (item.status === PayrollItemStatus.PAID || remaining.lt(ZERO) || (alreadyPaid.gt(ZERO) && remaining.lte(ZERO))) {
    throw conflict('This payroll item has already been paid.')
  }

  let result = mutation('PayrollItem', item.id, AuditAction.UPDATE)
  if (remaining.gt(ZERO)) {
    const payrollCategory = await resolveExpenseCategory(tx, 'رواتب')
    const cash = await createCashEntry(tx, context, {
      direction: CashDirection.OUTFLOW,
      kind: CashEntryKind.PAYROLL_PAYMENT,
      occurredOn: paidOn,
      amount: remaining,
      currency: CurrencyCode.USD,
      description: `راتب ${item.employee.name} - ${payload.period}`,
      note: payload.note,
      expenseCategoryId: payrollCategory.id,
    })
    const payment = await tx.payrollPayment.create({
      data: {
        payrollItemId: item.id,
        cashEntryId: cash.id,
        appliedAmountUsd: remaining,
        paidOn,
      },
    })
    result = mutation('PayrollPayment', payment.id, AuditAction.POST)
  }

  await applyPayrollAdvanceDeductions(tx, item.id, payload.employeeId, item.advanceDeductionUsd, paidOn)
  await tx.payrollItem.update({ where: { id: item.id }, data: { status: PayrollItemStatus.PAID } })
  await refreshPayrollRunStatus(tx, item.payrollRunId)
  return result
}

async function createAdvance(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'advance.create' }>['payload'],
): Promise<MutationResult> {
  if (!payload.employeeId && (
    payload.kind.includes('موظف') || payload.kind.toLocaleLowerCase('en').includes('employee')
  )) {
    throw conflict('An employee advance must be linked to an employee.')
  }
  const disbursedOn = parseDate(payload.date)
  if (payload.employeeId) {
    const employee = await requireEmployee(tx, payload.employeeId)
    if (employee.hireDate && disbursedOn.getTime() < employee.hireDate.getTime()) {
      throw conflict('An employee advance cannot predate the employee hire date.')
    }
  }
  const amount = decimal(payload.amount)
  const cash = await createCashEntry(tx, context, {
    direction: CashDirection.OUTFLOW,
    kind: CashEntryKind.ADVANCE_DISBURSEMENT,
    occurredOn: disbursedOn,
    amount,
    currency: CurrencyCode.USD,
    description: `سلفة: ${payload.name}`,
  })
  const advance = await tx.advance.create({
    data: {
      organizationId: ORGANIZATION_ID,
      employeeId: payload.employeeId,
      cashEntryId: cash.id,
      recipientType: payload.employeeId || payload.kind.includes('موظف')
        ? AdvanceRecipientType.EMPLOYEE
        : AdvanceRecipientType.OWNER_PARTNER,
      recipientName: payload.name,
      disbursedOn,
      principalOriginal: amount,
      currency: CurrencyCode.USD,
      currencyUnitsPerUsd: ONE,
      principalUsd: amount,
      note: payload.kind,
    },
  })
  return mutation('Advance', advance.id, AuditAction.CREATE)
}

async function repayAdvance(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'advance.repay' }>['payload'],
): Promise<MutationResult> {
  const advance = await tx.advance.findFirst({
    where: { id: payload.advanceId, organizationId: ORGANIZATION_ID, voidedAt: null },
    include: {
      repayments: {
        where: ACTIVE_ADVANCE_REPAYMENT_WHERE,
        select: { amountUsd: true },
      },
    },
  })
  if (!advance) throw notFound('Advance')
  const repaidOn = parseDate(payload.date)
  if (repaidOn.getTime() < advance.disbursedOn.getTime()) {
    throw conflict('An advance repayment cannot predate its disbursement.')
  }
  const repaid = sumDecimal(advance.repayments.map(repayment => repayment.amountUsd))
  const remaining = advance.principalUsd.minus(repaid)
  const amount = decimal(payload.amount)
  if (remaining.lte(ZERO)) throw conflict('This advance has already been settled.')
  if (amount.gt(remaining)) throw conflict('Repayment exceeds the outstanding advance balance.')

  const cash = await createCashEntry(tx, context, {
    direction: CashDirection.INFLOW,
    kind: CashEntryKind.ADVANCE_REPAYMENT,
    occurredOn: repaidOn,
    amount,
    currency: CurrencyCode.USD,
    description: `سداد سلفة: ${advance.recipientName}`,
    note: payload.note,
  })
  const repayment = await tx.advanceRepayment.create({
    data: {
      advanceId: advance.id,
      cashEntryId: cash.id,
      amountUsd: amount,
      repaidOn,
    },
  })
  await tx.advance.update({
    where: { id: advance.id },
    data: { status: amount.eq(remaining) ? AdvanceStatus.SETTLED : AdvanceStatus.PARTIALLY_REPAID },
  })
  return mutation('AdvanceRepayment', repayment.id, AuditAction.POST)
}

async function createFixedExpense(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'fixedExpense.create' }>['payload'],
): Promise<MutationResult> {
  const category = await resolveExpenseCategory(tx, payload.category)
  const template = await tx.recurringExpenseTemplate.create({
    data: {
      organizationId: ORGANIZATION_ID,
      expenseCategoryId: category.id,
      name: payload.name,
      amountOriginal: decimal(payload.amount),
      currency: CurrencyCode.USD,
      dueDay: payload.dueDay,
      startDate: context.today,
    },
  })
  await ensureRecurringExpensesForPeriod(tx, context.periodStart, context.periodEnd)
  return mutation('RecurringExpenseTemplate', template.id, AuditAction.CREATE)
}

async function updateFixedExpense(
  tx: Tx,
  _context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'fixedExpense.update' }>['payload'],
): Promise<MutationResult> {
  const template = await tx.recurringExpenseTemplate.findFirst({
    where: { id: payload.fixedExpenseId, organizationId: ORGANIZATION_ID, archivedAt: null },
  })
  if (!template) throw notFound('Fixed expense')
  const category = payload.category !== undefined
    ? await resolveExpenseCategory(tx, payload.category)
    : null
  const amount = payload.amount !== undefined ? decimal(payload.amount) : template.amountOriginal
  const dueDay = payload.dueDay ?? template.dueDay

  await tx.recurringExpenseTemplate.update({
    where: { id: template.id },
    data: {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(category ? { expenseCategoryId: category.id } : {}),
      ...(payload.amount !== undefined ? { amountOriginal: amount } : {}),
      ...(payload.dueDay !== undefined ? { dueDay } : {}),
    },
  })

  return mutation('RecurringExpenseTemplate', template.id, AuditAction.UPDATE)
}

async function archiveFixedExpense(
  tx: Tx,
  context: PeriodContext,
  fixedExpenseId: string,
): Promise<MutationResult> {
  const template = await tx.recurringExpenseTemplate.findFirst({
    where: { id: fixedExpenseId, organizationId: ORGANIZATION_ID, archivedAt: null },
    select: { id: true },
  })
  if (!template) throw notFound('Fixed expense')
  const unpaidOccurrences = await tx.recurringExpenseOccurrence.count({
    where: {
      templateId: template.id,
      status: { in: [PayableStatus.DUE, PayableStatus.PARTIALLY_PAID] },
    },
  })
  if (unpaidOccurrences > 0) {
    throw conflict('Pay all outstanding occurrences before archiving this fixed expense.')
  }
  await tx.recurringExpenseTemplate.update({
    where: { id: template.id },
    data: { isActive: false, endDate: context.today, archivedAt: new Date() },
  })
  return mutation('RecurringExpenseTemplate', template.id, AuditAction.ARCHIVE)
}

async function payFixedExpense(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'fixedExpense.pay' }>['payload'],
): Promise<MutationResult> {
  const template = await tx.recurringExpenseTemplate.findFirst({
    where: { id: payload.fixedExpenseId, organizationId: ORGANIZATION_ID, archivedAt: null },
  })
  if (!template) throw notFound('Fixed expense')
  const paidOn = parseDate(payload.date)
  if (paidOn.getTime() < template.startDate.getTime()) {
    throw conflict('A fixed-expense payment cannot predate the template.')
  }
  const occurrence = await tx.recurringExpenseOccurrence.findFirst({
    where: {
      templateId: template.id,
      periodStart: { lte: monthStartForDate(paidOn) },
      status: { in: [PayableStatus.DUE, PayableStatus.PARTIALLY_PAID] },
    },
    include: {
      payments: {
        where: { cashEntry: { status: CashEntryStatus.POSTED } },
        select: { appliedAmountUsd: true },
      },
    },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
  })
  if (!occurrence) throw conflict('There is no payable occurrence for this period.')
  const paid = sumDecimal(occurrence.payments.map(payment => payment.appliedAmountUsd))
  const remaining = occurrence.expectedUsd.minus(paid)
  if (remaining.lte(ZERO)) throw conflict('This fixed expense has already been paid for the period.')

  const cash = await createCashEntry(tx, context, {
    direction: CashDirection.OUTFLOW,
    kind: CashEntryKind.RECURRING_EXPENSE_PAYMENT,
    occurredOn: paidOn,
    amount: decimal(payload.amount),
    currency: payload.currency as CurrencyCode,
    description: occurrence.description,
    note: payload.note,
    expenseCategoryId: occurrence.expenseCategoryId,
  })
  if (cash.amountUsd.gt(remaining)) throw conflict('Payment exceeds the outstanding fixed expense.')
  const payment = await tx.recurringExpensePayment.create({
    data: {
      occurrenceId: occurrence.id,
      cashEntryId: cash.id,
      appliedAmountUsd: cash.amountUsd,
      paidOn,
    },
  })
  await tx.recurringExpenseOccurrence.update({
    where: { id: occurrence.id },
    data: { status: cash.amountUsd.eq(remaining) ? PayableStatus.PAID : PayableStatus.PARTIALLY_PAID },
  })
  return mutation('RecurringExpensePayment', payment.id, AuditAction.POST)
}

async function createService(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'service.create' }>['payload'],
): Promise<MutationResult> {
  const nextRenewalDate = parseDate(payload.next)
  if (nextRenewalDate.getTime() < context.today.getTime()) {
    throw conflict('The first service renewal cannot predate the service start date.')
  }
  const category = await resolveExpenseCategory(tx, payload.category)
  const service = await tx.serviceSubscription.create({
    data: {
      organizationId: ORGANIZATION_ID,
      expenseCategoryId: category.id,
      name: payload.name,
      amountOriginal: decimal(payload.amount),
      currency: CurrencyCode.USD,
      billingCycle: billingCycle(payload.cycle),
      billingAnchorDay: nextRenewalDate.getUTCDate(),
      nextRenewalDate,
      status: ServiceSubscriptionStatus.ACTIVE,
      startDate: context.today,
    },
  })
  await ensureServiceChargesThrough(tx, context.periodEnd)
  return mutation('ServiceSubscription', service.id, AuditAction.CREATE)
}

async function updateService(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'service.update' }>['payload'],
): Promise<MutationResult> {
  const service = await tx.serviceSubscription.findFirst({
    where: { id: payload.serviceId, organizationId: ORGANIZATION_ID, archivedAt: null },
    include: {
      charges: {
        orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
        take: 1,
        select: { dueDate: true, periodEnd: true },
      },
    },
  })
  if (!service) throw notFound('Service')
  const category = payload.category !== undefined
    ? await resolveExpenseCategory(tx, payload.category)
    : null
  const amount = payload.amount !== undefined ? decimal(payload.amount) : service.amountOriginal
  const cycle = payload.cycle !== undefined ? billingCycle(payload.cycle) : service.billingCycle
  const nextRenewalDate = payload.next !== undefined ? parseDate(payload.next) : service.nextRenewalDate
  const latestCharge = service.charges[0]
  const repeatsCompletedOneTimeDate = Boolean(
    latestCharge &&
    service.nextRenewalDate === null &&
    nextRenewalDate &&
    sameDate(nextRenewalDate, latestCharge.dueDate) &&
    cycle === service.billingCycle,
  )
  const shouldUpdateNext = payload.next !== undefined && !repeatsCompletedOneTimeDate
  if (nextRenewalDate && nextRenewalDate.getTime() < service.startDate.getTime()) {
    throw conflict('The next service renewal cannot predate the service start date.')
  }
  if (latestCharge && cycle !== service.billingCycle) {
    throw conflict('The billing cycle cannot change after service charges have been generated.')
  }
  const latestCoveredThrough = latestCharge?.periodEnd ?? latestCharge?.dueDate
  if (
    shouldUpdateNext &&
    nextRenewalDate &&
    latestCoveredThrough &&
    nextRenewalDate.getTime() <= latestCoveredThrough.getTime()
  ) {
    throw conflict('The next service renewal must be after the latest generated charge period.')
  }

  await tx.serviceSubscription.update({
    where: { id: service.id },
    data: {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(category ? { expenseCategoryId: category.id } : {}),
      ...(payload.amount !== undefined ? { amountOriginal: amount } : {}),
      ...(payload.cycle !== undefined ? { billingCycle: cycle } : {}),
      ...(shouldUpdateNext ? {
        nextRenewalDate,
        billingAnchorDay: nextRenewalDate?.getUTCDate(),
      } : {}),
    },
  })

  await ensureServiceChargesThrough(tx, context.periodEnd)
  return mutation('ServiceSubscription', service.id, AuditAction.UPDATE)
}

async function archiveService(
  tx: Tx,
  context: PeriodContext,
  serviceId: string,
): Promise<MutationResult> {
  const service = await tx.serviceSubscription.findFirst({
    where: { id: serviceId, organizationId: ORGANIZATION_ID, archivedAt: null },
    select: { id: true },
  })
  if (!service) throw notFound('Service')
  const unpaidCharges = await tx.serviceCharge.count({
    where: {
      serviceSubscriptionId: service.id,
      status: { in: [PayableStatus.DUE, PayableStatus.PARTIALLY_PAID] },
    },
  })
  if (unpaidCharges > 0) {
    throw conflict('Pay all outstanding charges before archiving this service.')
  }
  await tx.serviceSubscription.update({
    where: { id: service.id },
    data: {
      status: ServiceSubscriptionStatus.CANCELED,
      endDate: context.today,
      nextRenewalDate: null,
      archivedAt: new Date(),
    },
  })
  return mutation('ServiceSubscription', service.id, AuditAction.ARCHIVE)
}

async function payService(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'service.pay' }>['payload'],
): Promise<MutationResult> {
  const service = await tx.serviceSubscription.findFirst({
    where: { id: payload.serviceId, organizationId: ORGANIZATION_ID, archivedAt: null },
  })
  if (!service) throw notFound('Service')
  const paidOn = parseDate(payload.date)
  if (paidOn.getTime() < service.startDate.getTime()) {
    throw conflict('A service payment cannot predate the service subscription.')
  }
  await ensureServiceChargesThrough(tx, paidOn)
  const charge = await tx.serviceCharge.findFirst({
    where: {
      serviceSubscriptionId: service.id,
      periodStart: { lte: paidOn },
      status: { in: [PayableStatus.DUE, PayableStatus.PARTIALLY_PAID] },
    },
    include: {
      payments: {
        where: { cashEntry: { status: CashEntryStatus.POSTED } },
        select: { appliedAmountUsd: true },
      },
    },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
  })
  if (!charge) throw conflict('There is no unpaid service charge.')
  const paid = sumDecimal(charge.payments.map(payment => payment.appliedAmountUsd))
  const remaining = charge.expectedUsd.minus(paid)
  if (remaining.lte(ZERO)) throw conflict('This service charge has already been paid.')

  const cash = await createCashEntry(tx, context, {
    direction: CashDirection.OUTFLOW,
    kind: CashEntryKind.SERVICE_PAYMENT,
    occurredOn: paidOn,
    amount: decimal(payload.amount),
    currency: payload.currency as CurrencyCode,
    description: charge.description,
    note: payload.note,
    expenseCategoryId: charge.expenseCategoryId,
  })
  if (cash.amountUsd.gt(remaining)) throw conflict('Payment exceeds the outstanding service charge.')
  const payment = await tx.servicePayment.create({
    data: {
      serviceChargeId: charge.id,
      cashEntryId: cash.id,
      appliedAmountUsd: cash.amountUsd,
      paidOn,
    },
  })
  await tx.serviceCharge.update({
    where: { id: charge.id },
    data: { status: cash.amountUsd.eq(remaining) ? PayableStatus.PAID : PayableStatus.PARTIALLY_PAID },
  })
  return mutation('ServicePayment', payment.id, AuditAction.POST)
}

async function updateExchangeRate(
  tx: Tx,
  context: PeriodContext,
  payload: Extract<FinanceCommand, { type: 'exchangeRate.update' }>['payload'],
): Promise<MutationResult> {
  const effectiveAt = payload.date ? parseDate(payload.date) : context.today
  if (effectiveAt.getTime() > context.today.getTime()) {
    throw conflict('Exchange rates cannot become effective on a future date.')
  }
  const rateValue = decimal(payload.rate)
  const rate = await tx.exchangeRate.upsert({
    where: {
      organizationId_baseCurrency_quoteCurrency_effectiveAt: {
        organizationId: ORGANIZATION_ID,
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.SYP,
        effectiveAt,
      },
    },
    update: {
      rate: rateValue,
      source: 'manual',
      createdBy: requestActor(),
    },
    create: {
      organizationId: ORGANIZATION_ID,
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.SYP,
      rate: rateValue,
      effectiveAt,
      source: 'manual',
      createdBy: requestActor(),
    },
  })
  return mutation('ExchangeRate', rate.id, AuditAction.UPDATE)
}

async function ensureInvoicesForPeriod(tx: Tx, context: PeriodContext) {
  const subscriptions = await tx.subscription.findMany({
    where: {
      organizationId: ORGANIZATION_ID,
      status: SubscriptionStatus.ACTIVE,
      archivedAt: null,
      startDate: { lte: context.periodEnd },
      OR: [{ endDate: null }, { endDate: { gte: context.periodStart } }],
    },
    include: { rates: { orderBy: { effectiveFrom: 'desc' } } },
  })
  for (const subscription of subscriptions) {
    let periodStart = subscription.nextInvoiceDate
      ? monthStartForDate(subscription.nextInvoiceDate)
      : monthStartForDate(subscription.startDate)
    let generated = 0

    while (periodStart.getTime() <= context.periodStart.getTime() && generated < MAX_PERIOD_CATCH_UP) {
      const periodEnd = endOfMonth(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1)
      if (subscription.endDate && periodStart.getTime() > subscription.endDate.getTime()) break
      const existing = await tx.invoice.findUnique({
        where: {
          subscriptionId_periodStart: {
            subscriptionId: subscription.id,
            periodStart,
          },
        },
        select: { id: true },
      })

      if (!existing) {
        const rate = subscription.rates.find(candidate => (
          candidate.effectiveFrom.getTime() <= periodEnd.getTime() &&
          (!candidate.effectiveTo || candidate.effectiveTo.getTime() >= periodStart.getTime())
        ))
        if (rate) {
          const year = periodStart.getUTCFullYear()
          const month = periodStart.getUTCMonth() + 1
          const number = await nextDocumentNumber(tx, DocumentType.INVOICE, year)
          const issueDate = subscription.startDate.getTime() > periodStart.getTime()
            ? subscription.startDate
            : periodStart
          const scheduledDueDate = dateWithClampedDay(year, month, subscription.dueDay)
          const dueDate = scheduledDueDate.getTime() < issueDate.getTime()
            ? issueDate
            : scheduledDueDate
          const openingBalance = await clientOutstandingBeforePeriod(
            tx,
            subscription.clientId,
            periodStart,
          )
          const invoice = await tx.invoice.create({
            data: {
              organizationId: ORGANIZATION_ID,
              clientId: subscription.clientId,
              subscriptionId: subscription.id,
              number,
              periodStart,
              periodEnd,
              issueDate,
              dueDate,
              status: InvoiceStatus.ISSUED,
              subtotalUsd: rate.monthlyAmountUsd,
              totalUsd: rate.monthlyAmountUsd,
              openingBalanceSnapshotUsd: openingBalance,
              issuedAt: new Date(),
              lines: {
                create: {
                  position: 1,
                  type: InvoiceLineType.SUBSCRIPTION,
                  description: rate.packageName,
                  quantity: ONE,
                  unitAmountUsd: rate.monthlyAmountUsd,
                  lineTotalUsd: rate.monthlyAmountUsd,
                },
              },
            },
          })
          await createSystemAudit(tx, 'Invoice', invoice.id)
          await allocateClientCredits(tx, subscription.clientId)
        }
      }
      periodStart = addMonths(periodStart, 1)
      generated += 1
    }

    if (generated >= MAX_PERIOD_CATCH_UP && periodStart.getTime() <= context.periodStart.getTime()) {
      throw conflict('A subscription has too many missing invoice periods to generate safely.')
    }
    if (!subscription.nextInvoiceDate || !sameDate(subscription.nextInvoiceDate, periodStart)) {
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { nextInvoiceDate: periodStart },
      })
      await createSystemAudit(
        tx,
        'Subscription',
        subscription.id,
        AuditAction.UPDATE,
        'automatic-invoice-cursor',
      )
    }
  }

}

async function ensureRecurringExpensesForPeriod(
  tx: Tx,
  periodStart: Date,
  periodEnd: Date,
) {
  const templates = await tx.recurringExpenseTemplate.findMany({
    where: {
      organizationId: ORGANIZATION_ID,
      isActive: true,
      archivedAt: null,
      startDate: { lte: periodEnd },
    },
    include: { occurrences: { select: { periodStart: true } } },
  })

  for (const template of templates) {
    const existingPeriods = new Set(template.occurrences.map(occurrence => dateText(occurrence.periodStart)))
    const latestOccurrence = template.occurrences.reduce<Date | null>((latest, occurrence) => (
      !latest || occurrence.periodStart.getTime() > latest.getTime() ? occurrence.periodStart : latest
    ), null)
    let cursor = latestOccurrence
      ? addMonths(monthStartForDate(latestOccurrence), 1)
      : monthStartForDate(template.startDate)
    let generated = 0

    while (cursor.getTime() <= periodStart.getTime() && generated < MAX_PERIOD_CATCH_UP) {
      if (template.endDate && cursor.getTime() > template.endDate.getTime()) break

      if (!existingPeriods.has(dateText(cursor))) {
        const year = cursor.getUTCFullYear()
        const month = cursor.getUTCMonth() + 1
        const scheduledDueDate = dateWithClampedDay(year, month, template.dueDay)
        const dueDate = scheduledDueDate.getTime() < template.startDate.getTime()
          ? template.startDate
          : scheduledDueDate
        const rate = template.currency === CurrencyCode.USD
          ? ONE
          : await exchangeRateForDate(tx, dueDate)

        const occurrence = await tx.recurringExpenseOccurrence.create({
          data: {
            templateId: template.id,
            expenseCategoryId: template.expenseCategoryId,
            description: template.name,
            periodStart: cursor,
            dueDate,
            expectedOriginal: template.amountOriginal,
            currency: template.currency,
            currencyUnitsPerUsd: rate,
            expectedUsd: toUsd(template.amountOriginal, template.currency, rate),
          },
        })
        await createSystemAudit(tx, 'RecurringExpenseOccurrence', occurrence.id)
        generated += 1
      }

      cursor = addMonths(cursor, 1)
    }

    if (generated >= MAX_PERIOD_CATCH_UP && cursor.getTime() <= periodStart.getTime()) {
      throw conflict('A fixed expense has too many missing billing periods to generate safely.')
    }
  }
}

async function ensurePayrollForPeriod(tx: Tx, periodStart: Date, periodEnd: Date) {
  let run = await tx.payrollRun.findUnique({
    where: { organizationId_periodStart: { organizationId: ORGANIZATION_ID, periodStart } },
  })
  if (!run) {
    run = await tx.payrollRun.create({
      data: {
        organizationId: ORGANIZATION_ID,
        periodStart,
        status: PayrollRunStatus.APPROVED,
        approvedAt: new Date(),
      },
    })
    await createSystemAudit(tx, 'PayrollRun', run.id)
  }

  const employees = await tx.employee.findMany({
    where: {
      organizationId: ORGANIZATION_ID,
      status: EmployeeStatus.ACTIVE,
      archivedAt: null,
      OR: [{ hireDate: null }, { hireDate: { lte: periodEnd } }],
      AND: [{ OR: [{ endDate: null }, { endDate: { gte: periodStart } }] }],
    },
    include: { compensationHistory: { orderBy: { effectiveFrom: 'desc' } } },
  })

  for (const employee of employees) {
    const existing = await tx.payrollItem.findUnique({
      where: { payrollRunId_employeeId: { payrollRunId: run.id, employeeId: employee.id } },
      select: { id: true },
    })
    if (existing) continue
    const compensation = employee.compensationHistory.find(candidate => (
      candidate.effectiveFrom.getTime() <= periodEnd.getTime() &&
      (!candidate.effectiveTo || candidate.effectiveTo.getTime() >= periodStart.getTime())
    ))
    if (!compensation) continue
    const payrollItem = await tx.payrollItem.create({
      data: {
        payrollRunId: run.id,
        employeeId: employee.id,
        baseSalaryUsd: compensation.baseSalaryUsd,
        grossEarningsUsd: compensation.baseSalaryUsd,
        deductionTotalUsd: ZERO,
        netPayUsd: compensation.baseSalaryUsd,
      },
    })
    await createSystemAudit(tx, 'PayrollItem', payrollItem.id)
  }
  await refreshPayrollRunStatus(tx, run.id)
}

async function ensurePayrollThrough(tx: Tx, throughPeriodStart: Date) {
  const earliestEmployee = await tx.employee.findFirst({
    where: {
      organizationId: ORGANIZATION_ID,
      status: EmployeeStatus.ACTIVE,
      archivedAt: null,
    },
    orderBy: [{ hireDate: 'asc' }, { createdAt: 'asc' }],
    select: { hireDate: true, createdAt: true },
  })
  if (!earliestEmployee) return

  let cursor = monthStartForDate(earliestEmployee.hireDate ?? earliestEmployee.createdAt)
  let generatedPeriods = 0
  while (cursor.getTime() <= throughPeriodStart.getTime() && generatedPeriods < MAX_PERIOD_CATCH_UP) {
    await ensurePayrollForPeriod(
      tx,
      cursor,
      endOfMonth(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1),
    )
    cursor = addMonths(cursor, 1)
    generatedPeriods += 1
  }

  if (cursor.getTime() <= throughPeriodStart.getTime()) {
    throw conflict('Payroll has too many missing periods to generate safely.')
  }
}

async function ensureServiceChargesThrough(
  tx: Tx,
  throughDate: Date,
) {
  const services = await tx.serviceSubscription.findMany({
    where: {
      organizationId: ORGANIZATION_ID,
      status: ServiceSubscriptionStatus.ACTIVE,
      archivedAt: null,
      nextRenewalDate: { not: null, lte: throughDate },
    },
  })

  for (const service of services) {
    let dueDate = service.nextRenewalDate
    let generated = 0
    while (dueDate && dueDate.getTime() <= throughDate.getTime() && generated < MAX_PERIOD_CATCH_UP) {
      const existing = await tx.serviceCharge.findUnique({
        where: {
          serviceSubscriptionId_dueDate: {
            serviceSubscriptionId: service.id,
            dueDate,
          },
        },
        select: { id: true },
      })
      const rate = service.currency === CurrencyCode.USD
        ? ONE
        : await exchangeRateForDate(tx, dueDate)
      if (!existing) {
        const chargePeriod = serviceChargePeriod(dueDate, service.billingCycle)
        const charge = await tx.serviceCharge.create({
          data: {
            serviceSubscriptionId: service.id,
            expenseCategoryId: service.expenseCategoryId,
            description: service.name,
            periodStart: chargePeriod.start,
            periodEnd: chargePeriod.end,
            dueDate,
            expectedOriginal: service.amountOriginal,
            currency: service.currency,
            currencyUnitsPerUsd: rate,
            expectedUsd: toUsd(service.amountOriginal, service.currency, rate),
          },
        })
        await createSystemAudit(tx, 'ServiceCharge', charge.id)
      }

      dueDate = nextServiceRenewal(dueDate, service.billingCycle, service.billingAnchorDay)
      generated += 1
    }
    if (generated >= MAX_PERIOD_CATCH_UP && dueDate && dueDate.getTime() <= throughDate.getTime()) {
      throw conflict('A service has too many missing billing periods to generate safely.')
    }
    if (generated > 0) {
      await tx.serviceSubscription.update({
        where: { id: service.id },
        data: { nextRenewalDate: dueDate },
      })
      await createSystemAudit(
        tx,
        'ServiceSubscription',
        service.id,
        AuditAction.UPDATE,
        'automatic-service-cursor',
      )
    }
  }
}

async function createSystemAudit(
  tx: Tx,
  entityType: string,
  entityId: string,
  action: AuditAction = AuditAction.CREATE,
  source = 'automatic-period-generation',
  requestId?: string,
) {
  await tx.auditEvent.create({
    data: {
      organizationId: ORGANIZATION_ID,
      actor: 'system',
      action,
      entityType,
      entityId,
      requestId,
      metadata: { source },
    },
  })
}

type CorrectionAuditInput = {
  requestId: string
  action: AuditAction
  entityType: string
  entityId: string
  before?: Prisma.InputJsonValue
  after?: Prisma.InputJsonValue
  metadata?: Record<string, Prisma.InputJsonValue>
}

async function createCorrectionAudit(tx: Tx, input: CorrectionAuditInput) {
  await tx.auditEvent.create({
    data: {
      organizationId: ORGANIZATION_ID,
      actor: requestActor(),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      requestId: input.requestId,
      before: input.before,
      after: input.after,
      metadata: input.metadata,
    },
  })
}

function requestActor() {
  return process.env.ADMIN_USERNAME?.trim() || 'local-development'
}

async function allocatePaymentFifo(
  tx: Tx,
  paymentId: string,
  clientId: string,
  availableUsd: Prisma.Decimal,
) {
  let remaining = availableUsd
  const invoices = await tx.invoice.findMany({
    where: {
      organizationId: ORGANIZATION_ID,
      clientId,
      status: { notIn: [InvoiceStatus.PAID, InvoiceStatus.VOID] },
    },
    include: {
      allocations: {
        where: ACTIVE_PAYMENT_ALLOCATION_WHERE,
        select: { amountUsd: true },
      },
    },
    orderBy: [{ dueDate: 'asc' }, { issueDate: 'asc' }, { createdAt: 'asc' }],
  })

  for (const invoice of invoices) {
    if (remaining.lte(ZERO)) break
    const paid = sumDecimal(invoice.allocations.map(allocation => allocation.amountUsd))
    const due = invoice.totalUsd.minus(paid)
    if (due.lte(ZERO)) {
      if (invoice.status !== InvoiceStatus.PAID) {
        await tx.invoice.update({ where: { id: invoice.id }, data: { status: InvoiceStatus.PAID } })
        await createSystemAudit(
          tx,
          'Invoice',
          invoice.id,
          AuditAction.UPDATE,
          'automatic-payment-allocation',
        )
      }
      continue
    }
    const applied = Prisma.Decimal.min(remaining, due)
    const allocation = await tx.paymentAllocation.create({
      data: { paymentId, invoiceId: invoice.id, amountUsd: applied },
    })
    await createSystemAudit(
      tx,
      'PaymentAllocation',
      allocation.id,
      AuditAction.CREATE,
      'automatic-payment-allocation',
    )
    remaining = remaining.minus(applied)
    const nextStatus = applied.eq(due) ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID
    if (invoice.status !== nextStatus) {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: nextStatus },
      })
      await createSystemAudit(
        tx,
        'Invoice',
        invoice.id,
        AuditAction.UPDATE,
        'automatic-payment-allocation',
      )
    }
  }
}

async function clientOutstandingBeforePeriod(tx: Tx, clientId: string, periodStart: Date) {
  const invoices = await tx.invoice.findMany({
    where: {
      organizationId: ORGANIZATION_ID,
      clientId,
      periodStart: { lt: periodStart },
      status: { not: InvoiceStatus.VOID },
    },
    include: {
      allocations: {
        where: ACTIVE_PAYMENT_ALLOCATION_WHERE,
        select: { amountUsd: true },
      },
    },
  })

  return sumDecimal(invoices.map(invoice => Prisma.Decimal.max(
    invoice.totalUsd.minus(sumDecimal(invoice.allocations.map(allocation => allocation.amountUsd))),
    ZERO,
  )))
}

async function allocateClientCredits(tx: Tx, clientId: string) {
  const payments = await tx.customerPayment.findMany({
    where: { organizationId: ORGANIZATION_ID, clientId },
    include: {
      cashEntry: { select: { amountUsd: true, status: true } },
      allocations: { select: { amountUsd: true } },
    },
    orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }],
  })
  for (const payment of payments) {
    if (payment.cashEntry.status !== CashEntryStatus.POSTED) continue
    const allocated = sumDecimal(payment.allocations.map(allocation => allocation.amountUsd))
    const available = payment.cashEntry.amountUsd.minus(allocated)
    if (available.gt(ZERO)) await allocatePaymentFifo(tx, payment.id, clientId, available)
  }
}

async function buildSnapshot(tx: Tx, context: PeriodContext): Promise<FinanceSnapshot> {
  const [
    clients,
    cashEntries,
    liabilities,
    employees,
    advances,
    fixedExpenses,
    services,
    payrollAdvanceRepayments,
    latestAudit,
  ] = await Promise.all([
    tx.client.findMany({
      where: { organizationId: ORGANIZATION_ID, archivedAt: null },
      include: {
        subscriptions: {
          orderBy: { createdAt: 'desc' },
          include: { rates: { orderBy: { effectiveFrom: 'desc' } } },
        },
        invoices: {
          where: { status: { not: InvoiceStatus.VOID } },
          include: {
            allocations: {
              where: ACTIVE_PAYMENT_ALLOCATION_WHERE,
              select: { amountUsd: true },
            },
            lines: { orderBy: { position: 'asc' } },
          },
          orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
        },
      },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    }),
    tx.cashEntry.findMany({
      where: { organizationId: ORGANIZATION_ID },
      include: {
        client: { select: { name: true } },
        expenseCategory: { select: { name: true } },
        reversedBy: { select: { id: true } },
        payrollPayment: {
          select: {
            payrollItemId: true,
            payrollItem: { select: { employee: { select: { archivedAt: true } } } },
          },
        },
        advanceDisbursement: {
          select: {
            repayments: {
              where: ACTIVE_ADVANCE_REPAYMENT_WHERE,
              select: { id: true },
            },
          },
        },
        recurringExpensePayment: {
          select: { occurrence: { select: { template: { select: { archivedAt: true } } } } },
        },
        servicePayment: {
          select: {
            serviceCharge: { select: { serviceSubscription: { select: { archivedAt: true } } } },
          },
        },
      },
      orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
    }),
    tx.liability.findMany({
      where: { organizationId: ORGANIZATION_ID, voidedAt: null },
      include: {
        client: { select: { name: true } },
        payments: {
          where: { cashEntry: { status: CashEntryStatus.POSTED } },
          select: { appliedAmountUsd: true },
        },
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    }),
    tx.employee.findMany({
      where: { organizationId: ORGANIZATION_ID, archivedAt: null },
      include: {
        compensationHistory: { orderBy: { effectiveFrom: 'desc' } },
        payrollItems: {
          include: {
            payrollRun: { select: { periodStart: true } },
            payments: {
              where: { cashEntry: { status: CashEntryStatus.POSTED } },
              select: { appliedAmountUsd: true, paidOn: true },
            },
            advanceRepayments: {
              where: { reversedAt: null },
              select: { amountUsd: true, repaidOn: true },
            },
          },
          orderBy: { payrollRun: { periodStart: 'asc' } },
        },
      },
      orderBy: { name: 'asc' },
    }),
    tx.advance.findMany({
      where: { organizationId: ORGANIZATION_ID, voidedAt: null },
      include: {
        repayments: {
          where: ACTIVE_ADVANCE_REPAYMENT_WHERE,
          select: { amountUsd: true },
        },
      },
      orderBy: [{ disbursedOn: 'desc' }, { createdAt: 'desc' }],
    }),
    tx.recurringExpenseTemplate.findMany({
      where: { organizationId: ORGANIZATION_ID, archivedAt: null },
      include: {
        expenseCategory: { select: { name: true } },
        occurrences: {
          where: { status: { in: [PayableStatus.DUE, PayableStatus.PARTIALLY_PAID] } },
          include: {
            payments: {
              where: { cashEntry: { status: CashEntryStatus.POSTED } },
              select: { appliedAmountUsd: true },
            },
          },
          orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
        },
      },
      orderBy: { name: 'asc' },
    }),
    tx.serviceSubscription.findMany({
      where: { organizationId: ORGANIZATION_ID, archivedAt: null },
      include: {
        expenseCategory: { select: { name: true } },
        charges: {
          include: {
            payments: {
              where: { cashEntry: { status: CashEntryStatus.POSTED } },
              select: { appliedAmountUsd: true },
            },
          },
          orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
        },
      },
      orderBy: { name: 'asc' },
    }),
    tx.advanceRepayment.findMany({
      where: {
        payrollItemId: { not: null },
        advance: { organizationId: ORGANIZATION_ID },
        ...ACTIVE_ADVANCE_REPAYMENT_WHERE,
      },
      include: {
        payrollItem: {
          include: { employee: { select: { name: true } } },
        },
      },
      orderBy: [{ repaidOn: 'desc' }, { createdAt: 'desc' }],
    }),
    tx.auditEvent.findFirst({
      where: { organizationId: ORGANIZATION_ID },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: { id: true, occurredAt: true },
    }),
  ])

  const activeCashEntries = cashEntries.filter(entry => (
    entry.status === CashEntryStatus.POSTED && entry.kind !== CashEntryKind.REVERSAL
  ))

  const clientDtos: ClientDto[] = clients.map(client => {
    const subscription = client.subscriptions.find(item => (
      item.status === SubscriptionStatus.ACTIVE && !item.archivedAt
    ))
    const rate = subscription?.rates.find(item => (
      item.effectiveFrom.getTime() <= context.periodEnd.getTime() &&
      (!item.effectiveTo || item.effectiveTo.getTime() >= context.periodStart.getTime())
    )) ?? subscription?.rates[0]
    const total = sumDecimal(client.invoices.map(invoice => invoice.totalUsd))
    const paid = sumDecimal(client.invoices.flatMap(invoice => (
      invoice.allocations.map(allocation => allocation.amountUsd)
    )))
    const due = Prisma.Decimal.max(total.minus(paid), ZERO)
    const hasOverdueInvoice = client.invoices.some(invoice => {
      const invoicePaid = sumDecimal(invoice.allocations.map(allocation => allocation.amountUsd))
      return invoice.dueDate.getTime() < context.today.getTime() && invoicePaid.lt(invoice.totalUsd)
    })
    const hasPartiallyPaidInvoice = client.invoices.some(invoice => {
      const invoicePaid = sumDecimal(invoice.allocations.map(allocation => allocation.amountUsd))
      return invoicePaid.gt(ZERO) && invoicePaid.lt(invoice.totalUsd)
    })
    const currentInvoice = subscription
      ? client.invoices.find(invoice => (
          invoice.subscriptionId === subscription.id && sameDate(invoice.periodStart, context.periodStart)
        ))
      : undefined

    return {
      id: client.id,
      name: client.name,
      phone: client.phone ?? '',
      package: rate?.packageName ?? subscription?.name ?? '',
      monthly: money(rate?.monthlyAmountUsd ?? ZERO),
      paid: money(paid),
      due: money(due),
      status: receivableStatus(total, paid, hasOverdueInvoice, hasPartiallyPaidInvoice),
      active: client.status === ClientStatus.ACTIVE,
      ...(subscription ? { subscriptionId: subscription.id } : {}),
      ...(currentInvoice ? {
        currentInvoiceId: currentInvoice.id,
        currentInvoiceNumber: currentInvoice.number,
        currentInvoiceIssueDate: dateText(currentInvoice.issueDate),
        currentInvoiceDueDate: dateText(currentInvoice.dueDate),
        currentInvoiceSubtotal: money(currentInvoice.subtotalUsd),
        currentInvoiceTotal: money(currentInvoice.totalUsd),
        currentInvoiceOpeningBalance: money(currentInvoice.openingBalanceSnapshotUsd),
        currentInvoiceLines: currentInvoice.lines.map(line => ({
          description: line.description,
          quantity: money(line.quantity),
          unitAmount: money(line.unitAmountUsd),
          total: money(line.lineTotalUsd),
        })),
      } : {}),
    }
  })

  const incomeDtos: IncomeDto[] = activeCashEntries
    .filter(entry => (
      entry.direction === CashDirection.INFLOW &&
      entry.kind !== CashEntryKind.ADVANCE_REPAYMENT &&
      entry.kind !== CashEntryKind.OPENING_BALANCE &&
      entry.kind !== CashEntryKind.REVERSAL
    ))
    .map(entry => ({
      id: entry.id,
      cashEntryId: entry.id,
      date: dateText(entry.occurredOn),
      source: entry.client?.name ?? entry.description,
      type: cashKindLabel(entry.kind),
      amount: money(entry.amountOriginal),
      currency: entry.currency,
      usd: money(entry.amountUsd),
      note: entry.note ?? '',
      ...(entry.clientId ? { clientId: entry.clientId } : {}),
      ...(entry.client?.name ? { client: entry.client.name } : {}),
    }))

  const cashExpenseDtos: ExpenseDto[] = activeCashEntries
    .filter(entry => (
      entry.direction === CashDirection.OUTFLOW &&
      entry.kind !== CashEntryKind.ADVANCE_DISBURSEMENT &&
      entry.kind !== CashEntryKind.OPENING_BALANCE &&
      entry.kind !== CashEntryKind.REVERSAL
    ))
    .map(entry => ({
      id: entry.id,
      cashEntryId: entry.id,
      date: dateText(entry.occurredOn),
      name: entry.description,
      category: entry.expenseCategory?.name ?? cashKindLabel(entry.kind),
      amount: money(entry.amountOriginal),
      currency: entry.currency,
      usd: money(entry.amountUsd),
      note: entry.note ?? '',
      ...(entry.clientId ? { clientId: entry.clientId } : {}),
      ...(entry.client?.name ? { client: entry.client.name } : {}),
    }))

  const payrollAdvanceExpenseDtos: ExpenseDto[] = payrollAdvanceRepayments.flatMap(repayment => {
    if (!repayment.payrollItem) return []
    return [{
      id: repayment.id,
      date: dateText(repayment.repaidOn),
      name: `حسم سلفة من راتب ${repayment.payrollItem.employee.name}`,
      category: 'رواتب',
      amount: money(repayment.amountUsd),
      currency: CurrencyCode.USD,
      usd: money(repayment.amountUsd),
      note: 'مصروف راتب غير نقدي تمت تسويته مقابل رصيد السلفة.',
    }]
  })

  const expenseDtos = [...cashExpenseDtos, ...payrollAdvanceExpenseDtos]
    .sort((left, right) => right.date.localeCompare(left.date))

  const liabilityDtos: LiabilityDto[] = liabilities.map(liability => ({
    id: liability.id,
    date: dateText(liability.incurredOn),
    party: liability.payeeName,
    kind: liabilityPartyLabel(liability.partyType),
    ...(liability.clientId ? { clientId: liability.clientId } : {}),
    client: liability.client?.name ?? '',
    description: liability.description,
    total: money(liability.amountUsd),
    paid: money(sumDecimal(liability.payments.map(payment => payment.appliedAmountUsd))),
    due: dateText(liability.dueDate),
  }))

  const employeeDtos: EmployeeDto[] = employees.map(employee => {
    const unpaidItems = employee.payrollItems.filter(item => (
      item.status === PayrollItemStatus.READY || item.status === PayrollItemStatus.PARTIALLY_PAID
    ))
    const currentItem = employee.payrollItems.find(item => sameDate(
      item.payrollRun.periodStart,
      context.periodStart,
    ))
    const payItem = unpaidItems[0] ?? currentItem ?? employee.payrollItems.at(-1)
    const compensation = employee.compensationHistory.find(candidate => (
      candidate.effectiveFrom.getTime() <= context.periodEnd.getTime() &&
      (!candidate.effectiveTo || candidate.effectiveTo.getTime() >= context.periodStart.getTime())
    )) ?? employee.compensationHistory[0]
    return {
      id: employee.id,
      name: employee.name,
      base: money(currentItem?.baseSalaryUsd ?? compensation?.baseSalaryUsd ?? ZERO),
      bonus: money(currentItem?.bonusUsd ?? ZERO),
      deductions: money(currentItem?.deductionUsd ?? ZERO),
      loan: money(currentItem?.advanceDeductionUsd ?? ZERO),
      payBase: money(payItem?.baseSalaryUsd ?? ZERO),
      payBonus: money(payItem?.bonusUsd ?? ZERO),
      payDeductions: money(payItem?.deductionUsd ?? ZERO),
      payLoan: money(payItem?.advanceDeductionUsd ?? ZERO),
      status: unpaidItems.length === 0 && currentItem?.status === PayrollItemStatus.PAID
        ? 'مدفوع'
        : 'جاهز للدفع',
      period: payItem ? dateText(payItem.payrollRun.periodStart).slice(0, 7) : context.todayText.slice(0, 7),
      outstandingPeriods: unpaidItems.length,
    }
  })

  const advanceDtos: AdvanceDto[] = advances.map(advance => ({
    id: advance.id,
    date: dateText(advance.disbursedOn),
    name: advance.recipientName,
    kind: advance.recipientType === AdvanceRecipientType.EMPLOYEE ? 'موظف' : 'مالك / شريك',
    amount: money(advance.principalUsd),
    paid: money(sumDecimal(advance.repayments.map(repayment => repayment.amountUsd))),
    ...(advance.employeeId ? { employeeId: advance.employeeId } : {}),
  }))

  const fixedExpenseDtos: FixedExpenseDto[] = fixedExpenses.map(template => {
    const expected = toUsd(
      template.amountOriginal,
      template.currency,
      template.currency === CurrencyCode.USD ? ONE : context.exchangeRate,
    )
    const balances = template.occurrences.map(item => Prisma.Decimal.max(
      item.expectedUsd.minus(sumDecimal(item.payments.map(payment => payment.appliedAmountUsd))),
      ZERO,
    ))
    const outstanding = sumDecimal(balances)
    return {
      id: template.id,
      name: template.name,
      category: template.expenseCategory.name,
      amount: money(expected),
      payable: money(balances[0] ?? ZERO),
      outstanding: money(outstanding),
      dueDay: template.dueDay,
      status: outstanding.gt(ZERO) ? 'مستحق' : 'مدفوع',
    }
  })

  const serviceDtos: ServiceDto[] = services.map(service => {
    const expected = toUsd(
      service.amountOriginal,
      service.currency,
      service.currency === CurrencyCode.USD ? ONE : context.exchangeRate,
    )
    const openCharges = service.charges.flatMap(item => {
      const balance = Prisma.Decimal.max(
        item.expectedUsd.minus(sumDecimal(item.payments.map(payment => payment.appliedAmountUsd))),
        ZERO,
      )
      return balance.gt(ZERO) ? [balance] : []
    })
    const outstanding = sumDecimal(openCharges)
    const lastCharge = service.charges.at(-1)
    return {
      id: service.id,
      name: service.name,
      category: service.expenseCategory.name,
      amount: money(expected),
      payable: money(openCharges[0] ?? ZERO),
      outstanding: money(outstanding),
      cycle: billingCycleLabel(service.billingCycle),
      next: service.nextRenewalDate
        ? dateText(service.nextRenewalDate)
        : lastCharge
          ? dateText(lastCharge.dueDate)
          : '',
      status: outstanding.gt(ZERO) ? 'مستحق' : 'مدفوع',
    }
  })

  const cashLedger: CashLedgerEntryDto[] = cashEntries.map(entry => {
    const payrollTarget = entry.kind === CashEntryKind.PAYROLL_PAYMENT
      ? entry.payrollPayment
      : null
    const isOriginalPostedEntry = entry.status === CashEntryStatus.POSTED
      && entry.kind !== CashEntryKind.REVERSAL
      && !entry.reversedBy
    const hasArchivedParent = Boolean(
      payrollTarget?.payrollItem.employee.archivedAt
      || entry.recurringExpensePayment?.occurrence.template.archivedAt
      || entry.servicePayment?.serviceCharge.serviceSubscription.archivedAt,
    )
    const hasActiveAdvanceRepayments = (entry.advanceDisbursement?.repayments.length ?? 0) > 0
    const hasMissingPayrollTarget = entry.kind === CashEntryKind.PAYROLL_PAYMENT && !payrollTarget
    const reversible = isOriginalPostedEntry
      && !hasArchivedParent
      && !hasActiveAdvanceRepayments
      && !hasMissingPayrollTarget
    const reversalCommand = payrollTarget ? 'payroll.reverse' as const : 'cashEntry.reverse' as const
    const reversalTargetId = payrollTarget?.payrollItemId ?? entry.id

    return {
      id: entry.id,
      date: dateText(entry.occurredOn),
      description: entry.description,
      direction: entry.direction,
      kind: cashKindLabel(entry.kind),
      status: entry.status,
      amount: money(entry.amountOriginal),
      currency: entry.currency,
      usd: money(entry.amountUsd),
      ...(entry.reversalOfId ? { reversalOfId: entry.reversalOfId } : {}),
      ...(entry.reversedBy ? { reversedById: entry.reversedBy.id } : {}),
      reversible,
      ...(reversible ? { reversalCommand, reversalTargetId } : {}),
    }
  })

  const payrollSettlements: PayrollSettlementDto[] = employees.flatMap(employee => (
    employee.payrollItems.map(item => {
      const cashPaid = sumDecimal(item.payments.map(payment => payment.appliedAmountUsd))
      const advanceApplied = sumDecimal(item.advanceRepayments.map(repayment => repayment.amountUsd))
      const paidDates = [
        ...item.payments.map(payment => payment.paidOn),
        ...item.advanceRepayments.map(repayment => repayment.repaidOn),
      ].sort((left, right) => right.getTime() - left.getTime())
      const reversible = item.status === PayrollItemStatus.PAID
        || item.status === PayrollItemStatus.PARTIALLY_PAID

      return {
        payrollItemId: item.id,
        employeeId: employee.id,
        employeeName: employee.name,
        period: dateText(item.payrollRun.periodStart).slice(0, 7),
        ...(paidDates[0] ? { paidOn: dateText(paidDates[0]) } : {}),
        cashPaid: money(cashPaid),
        advanceApplied: money(advanceApplied),
        netPay: money(item.netPayUsd),
        status: item.status,
        reversible,
      }
    })
  )).sort((left, right) => (
    right.period.localeCompare(left.period) || left.employeeName.localeCompare(right.employeeName, 'ar')
  ))

  let cashUsd = ZERO
  let cashSyp = ZERO
  for (const entry of cashEntries) {
    const sign = entry.direction === CashDirection.INFLOW ? ONE : new Prisma.Decimal(-1)
    if (entry.currency === CurrencyCode.USD) cashUsd = cashUsd.plus(entry.amountOriginal.mul(sign))
    if (entry.currency === CurrencyCode.SYP) cashSyp = cashSyp.plus(entry.amountOriginal.mul(sign))
  }
  const totalUsd = cashUsd.plus(cashSyp.div(context.exchangeRate))

  const generatedAt = new Date().toISOString()
  return {
    clients: clientDtos,
    incomes: incomeDtos,
    expenses: expenseDtos,
    liabilities: liabilityDtos,
    employees: employeeDtos,
    advances: advanceDtos,
    fixedExpenses: fixedExpenseDtos,
    services: serviceDtos,
    cashLedger,
    payrollSettlements,
    exchangeRate: moneyRate(context.exchangeRate),
    cashbox: { usd: money(cashUsd), syp: money(cashSyp), totalUsd: money(totalUsd) },
    revision: latestAudit ? `${latestAudit.occurredAt.toISOString()}:${latestAudit.id}` : generatedAt,
    generatedAt,
  }
}

type CashEntryInput = {
  direction: CashDirection
  kind: CashEntryKind
  occurredOn: Date
  amount: Prisma.Decimal
  currency: CurrencyCode
  description: string
  note?: string
  clientId?: string
  expenseCategoryId?: string
}

type ReversibleCashEntry = {
  id: string
  organizationId: string
  clientId: string | null
  expenseCategoryId: string | null
  direction: CashDirection
  kind: CashEntryKind
  status: CashEntryStatus
  occurredOn: Date
  amountOriginal: Prisma.Decimal
  currency: CurrencyCode
  currencyUnitsPerUsd: Prisma.Decimal
  amountUsd: Prisma.Decimal
  paymentMethod: PaymentMethod
  description: string
  createdBy: string | null
}

async function createCashEntry(tx: Tx, context: PeriodContext, input: CashEntryInput) {
  if (input.occurredOn.getTime() > context.today.getTime()) {
    throw conflict('Cash transactions cannot be posted with a future date.')
  }
  const rate = input.currency === CurrencyCode.USD
    ? ONE
    : sameDate(input.occurredOn, context.today)
      ? context.exchangeRate
      : await exchangeRateForDate(tx, input.occurredOn)
  const amountUsd = toUsd(input.amount, input.currency, rate)
  if (amountUsd.lte(ZERO)) {
    throw conflict('The amount is too small at the current exchange rate.')
  }
  return tx.cashEntry.create({
    data: {
      organizationId: ORGANIZATION_ID,
      clientId: input.clientId,
      expenseCategoryId: input.expenseCategoryId,
      direction: input.direction,
      kind: input.kind,
      occurredOn: input.occurredOn,
      amountOriginal: input.amount,
      currency: input.currency,
      currencyUnitsPerUsd: rate,
      amountUsd,
      description: input.description,
      note: input.note,
      createdBy: requestActor(),
    },
  })
}

async function createCompensatingCashEntry(
  tx: Tx,
  original: ReversibleCashEntry,
  reversedOn: Date,
  reason: string,
) {
  if (original.organizationId !== ORGANIZATION_ID) throw notFound('Cash entry')
  if (original.kind === CashEntryKind.REVERSAL || original.status !== CashEntryStatus.POSTED) {
    throw conflict('This cash entry cannot be reversed.')
  }

  const reversal = await tx.cashEntry.create({
    data: {
      organizationId: original.organizationId,
      clientId: original.clientId,
      expenseCategoryId: original.expenseCategoryId,
      direction: original.direction === CashDirection.INFLOW
        ? CashDirection.OUTFLOW
        : CashDirection.INFLOW,
      kind: CashEntryKind.REVERSAL,
      occurredOn: reversedOn,
      amountOriginal: original.amountOriginal,
      currency: original.currency,
      currencyUnitsPerUsd: original.currencyUnitsPerUsd,
      amountUsd: original.amountUsd,
      paymentMethod: original.paymentMethod,
      description: `Reversal: ${original.description}`.slice(0, 250),
      note: reason,
      reversalOfId: original.id,
      createdBy: requestActor(),
    },
  })
  const updated = await tx.cashEntry.updateMany({
    where: { id: original.id, status: CashEntryStatus.POSTED },
    data: { status: CashEntryStatus.REVERSED },
  })
  if (updated.count !== 1) throw conflict('This cash entry was reversed concurrently.')
  return reversal
}

function validateReversalDate(context: PeriodContext, originalDate: Date, reversedOn: Date) {
  if (reversedOn.getTime() > context.today.getTime()) {
    throw conflict('A reversal cannot be posted with a future date.')
  }
  if (reversedOn.getTime() < originalDate.getTime()) {
    throw conflict('A reversal cannot predate the original posting.')
  }
}

async function resolveExpenseCategory(tx: Tx, name: string) {
  const normalizedName = name.trim() || 'أخرى'
  if (normalizedName.length > 100) throw conflict('Expense category cannot exceed 100 characters.')
  const slug = slugify(normalizedName)
  return tx.expenseCategory.upsert({
    where: { organizationId_slug: { organizationId: ORGANIZATION_ID, slug } },
    create: {
      organizationId: ORGANIZATION_ID,
      name: normalizedName,
      slug,
    },
    update: { name: normalizedName, isActive: true, archivedAt: null },
  })
}

async function nextDocumentNumber(tx: Tx, type: DocumentType, year: number) {
  const existing = await tx.documentSequence.findUnique({
    where: { organizationId_type_year: { organizationId: ORGANIZATION_ID, type, year } },
  })
  let value: number
  if (existing) {
    const updated = await tx.documentSequence.update({
      where: { id: existing.id },
      data: { nextValue: { increment: 1 } },
    })
    value = updated.nextValue - 1
  } else {
    await tx.documentSequence.create({
      data: { organizationId: ORGANIZATION_ID, type, year, nextValue: 2 },
    })
    value = 1
  }
  const prefix = type === DocumentType.INVOICE ? 'INV' : 'REC'
  return `${prefix}-${year}-${String(value).padStart(6, '0')}`
}

async function requireClient(tx: Tx, clientId: string) {
  const client = await tx.client.findFirst({
    where: { id: clientId, organizationId: ORGANIZATION_ID, archivedAt: null },
    select: { id: true },
  })
  if (!client) throw notFound('Client')
  return client
}

async function requireEmployee(tx: Tx, employeeId: string) {
  const employee = await tx.employee.findFirst({
    where: { id: employeeId, organizationId: ORGANIZATION_ID, archivedAt: null },
    select: { id: true, hireDate: true },
  })
  if (!employee) throw notFound('Employee')
  return employee
}

async function employeeAdvanceBalance(tx: Tx, employeeId: string) {
  const advances = await tx.advance.findMany({
    where: {
      organizationId: ORGANIZATION_ID,
      employeeId,
      voidedAt: null,
      status: { not: AdvanceStatus.SETTLED },
    },
    include: {
      repayments: {
        where: ACTIVE_ADVANCE_REPAYMENT_WHERE,
        select: { amountUsd: true },
      },
    },
  })
  return advances.reduce((total, advance) => {
    const repaid = sumDecimal(advance.repayments.map(repayment => repayment.amountUsd))
    return total.plus(Prisma.Decimal.max(advance.principalUsd.minus(repaid), ZERO))
  }, ZERO)
}

async function applyPayrollAdvanceDeductions(
  tx: Tx,
  payrollItemId: string,
  employeeId: string,
  requestedAmount: Prisma.Decimal,
  repaidOn: Date,
) {
  let remaining = requestedAmount
  if (remaining.lte(ZERO)) return
  const advances = await tx.advance.findMany({
    where: {
      organizationId: ORGANIZATION_ID,
      employeeId,
      disbursedOn: { lte: repaidOn },
      voidedAt: null,
      status: { not: AdvanceStatus.SETTLED },
    },
    include: {
      repayments: {
        where: ACTIVE_ADVANCE_REPAYMENT_WHERE,
        select: { amountUsd: true },
      },
    },
    orderBy: [{ disbursedOn: 'asc' }, { createdAt: 'asc' }],
  })

  for (const advance of advances) {
    if (remaining.lte(ZERO)) break
    const repaid = sumDecimal(advance.repayments.map(repayment => repayment.amountUsd))
    const outstanding = advance.principalUsd.minus(repaid)
    if (outstanding.lte(ZERO)) continue
    const applied = Prisma.Decimal.min(remaining, outstanding)
    const repayment = await tx.advanceRepayment.create({
      data: { advanceId: advance.id, payrollItemId, amountUsd: applied, repaidOn },
    })
    await createSystemAudit(
      tx,
      'AdvanceRepayment',
      repayment.id,
      AuditAction.POST,
      'payroll-advance-deduction',
    )
    remaining = remaining.minus(applied)
    await tx.advance.update({
      where: { id: advance.id },
      data: {
        status: applied.eq(outstanding) ? AdvanceStatus.SETTLED : AdvanceStatus.PARTIALLY_REPAID,
      },
    })
    await createSystemAudit(
      tx,
      'Advance',
      advance.id,
      AuditAction.UPDATE,
      'payroll-advance-deduction',
    )
  }
  if (remaining.gt(ZERO)) throw conflict('Advance deduction exceeds the outstanding advance balance.')
}

async function refreshInvoiceStatus(tx: Tx, invoiceId: string, requestId: string) {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      allocations: {
        where: ACTIVE_PAYMENT_ALLOCATION_WHERE,
        select: { amountUsd: true },
      },
    },
  })
  if (!invoice) throw invariant('Allocated invoice is missing.')
  if (invoice.status === InvoiceStatus.VOID) return invoice.status
  const paid = sumDecimal(invoice.allocations.map(allocation => allocation.amountUsd))
  const status = paid.gte(invoice.totalUsd)
    ? InvoiceStatus.PAID
    : paid.gt(ZERO)
      ? InvoiceStatus.PARTIALLY_PAID
      : invoice.issuedAt
        ? InvoiceStatus.ISSUED
        : InvoiceStatus.DRAFT
  if (status !== invoice.status) {
    await tx.invoice.update({ where: { id: invoice.id }, data: { status } })
    await auditDerivedStatus(tx, requestId, 'Invoice', invoice.id, invoice.status, status)
  }
  return status
}

async function refreshLiabilityStatus(tx: Tx, liabilityId: string, requestId: string) {
  const liability = await tx.liability.findUnique({
    where: { id: liabilityId },
    include: {
      payments: {
        where: { cashEntry: { status: CashEntryStatus.POSTED } },
        select: { appliedAmountUsd: true },
      },
    },
  })
  if (!liability) throw invariant('Paid liability is missing.')
  if (liability.status === LiabilityStatus.VOID) return liability.status
  const paid = sumDecimal(liability.payments.map(payment => payment.appliedAmountUsd))
  const status = paid.gte(liability.amountUsd)
    ? LiabilityStatus.PAID
    : paid.gt(ZERO)
      ? LiabilityStatus.PARTIALLY_PAID
      : LiabilityStatus.OPEN
  if (status !== liability.status) {
    await tx.liability.update({ where: { id: liability.id }, data: { status } })
    await auditDerivedStatus(tx, requestId, 'Liability', liability.id, liability.status, status)
  }
  return status
}

async function refreshAdvanceStatus(tx: Tx, advanceId: string, requestId: string) {
  const advance = await tx.advance.findUnique({
    where: { id: advanceId },
    include: {
      repayments: {
        where: ACTIVE_ADVANCE_REPAYMENT_WHERE,
        select: { amountUsd: true },
      },
    },
  })
  if (!advance) throw invariant('Repaid advance is missing.')
  if (advance.status === AdvanceStatus.VOID) return advance.status
  const repaid = sumDecimal(advance.repayments.map(repayment => repayment.amountUsd))
  const status = repaid.gte(advance.principalUsd)
    ? AdvanceStatus.SETTLED
    : repaid.gt(ZERO)
      ? AdvanceStatus.PARTIALLY_REPAID
      : AdvanceStatus.OPEN
  if (status !== advance.status) {
    await tx.advance.update({ where: { id: advance.id }, data: { status } })
    await auditDerivedStatus(tx, requestId, 'Advance', advance.id, advance.status, status)
  }
  return status
}

async function refreshRecurringOccurrenceStatus(tx: Tx, occurrenceId: string, requestId: string) {
  const occurrence = await tx.recurringExpenseOccurrence.findUnique({
    where: { id: occurrenceId },
    include: {
      payments: {
        where: { cashEntry: { status: CashEntryStatus.POSTED } },
        select: { appliedAmountUsd: true },
      },
    },
  })
  if (!occurrence) throw invariant('Paid fixed-expense occurrence is missing.')
  if (occurrence.status === PayableStatus.WAIVED) return occurrence.status
  const paid = sumDecimal(occurrence.payments.map(payment => payment.appliedAmountUsd))
  const status = paid.gte(occurrence.expectedUsd)
    ? PayableStatus.PAID
    : paid.gt(ZERO)
      ? PayableStatus.PARTIALLY_PAID
      : PayableStatus.DUE
  if (status !== occurrence.status) {
    await tx.recurringExpenseOccurrence.update({ where: { id: occurrence.id }, data: { status } })
    await auditDerivedStatus(tx, requestId, 'RecurringExpenseOccurrence', occurrence.id, occurrence.status, status)
  }
  return status
}

async function refreshServiceChargeStatus(tx: Tx, serviceChargeId: string, requestId: string) {
  const charge = await tx.serviceCharge.findUnique({
    where: { id: serviceChargeId },
    include: {
      payments: {
        where: { cashEntry: { status: CashEntryStatus.POSTED } },
        select: { appliedAmountUsd: true },
      },
    },
  })
  if (!charge) throw invariant('Paid service charge is missing.')
  if (charge.status === PayableStatus.WAIVED) return charge.status
  const paid = sumDecimal(charge.payments.map(payment => payment.appliedAmountUsd))
  const status = paid.gte(charge.expectedUsd)
    ? PayableStatus.PAID
    : paid.gt(ZERO)
      ? PayableStatus.PARTIALLY_PAID
      : PayableStatus.DUE
  if (status !== charge.status) {
    await tx.serviceCharge.update({ where: { id: charge.id }, data: { status } })
    await auditDerivedStatus(tx, requestId, 'ServiceCharge', charge.id, charge.status, status)
  }
  return status
}

async function refreshPayrollItemStatus(tx: Tx, payrollItemId: string, requestId: string) {
  const item = await tx.payrollItem.findUnique({
    where: { id: payrollItemId },
    include: {
      payments: {
        where: { cashEntry: { status: CashEntryStatus.POSTED } },
        select: { appliedAmountUsd: true },
      },
      advanceRepayments: {
        where: { reversedAt: null },
        select: { amountUsd: true },
      },
    },
  })
  if (!item) throw invariant('Payroll item is missing.')
  if (item.status === PayrollItemStatus.VOID) return item.status
  const cashPaid = sumDecimal(item.payments.map(payment => payment.appliedAmountUsd))
  const advanceApplied = sumDecimal(item.advanceRepayments.map(repayment => repayment.amountUsd))
  const cashSatisfied = item.netPayUsd.lte(ZERO) || cashPaid.gte(item.netPayUsd)
  const advanceSatisfied = item.advanceDeductionUsd.lte(ZERO)
    || advanceApplied.gte(item.advanceDeductionUsd)
  const hasActiveSettlement = cashPaid.gt(ZERO) || advanceApplied.gt(ZERO)
  const hasFinancialSettlementRequirement = item.netPayUsd.gt(ZERO)
    || item.advanceDeductionUsd.gt(ZERO)
  const status = !hasFinancialSettlementRequirement && !hasActiveSettlement
    ? PayrollItemStatus.READY
    : cashSatisfied && advanceSatisfied
      ? PayrollItemStatus.PAID
      : hasActiveSettlement
        ? PayrollItemStatus.PARTIALLY_PAID
        : PayrollItemStatus.READY
  if (status !== item.status) {
    await tx.payrollItem.update({ where: { id: item.id }, data: { status } })
    await auditDerivedStatus(tx, requestId, 'PayrollItem', item.id, item.status, status)
  }
  return status
}

async function auditDerivedStatus(
  tx: Tx,
  requestId: string,
  entityType: string,
  entityId: string,
  before: string,
  after: string,
) {
  await createCorrectionAudit(tx, {
    requestId,
    action: AuditAction.UPDATE,
    entityType,
    entityId,
    before: { status: before },
    after: { status: after },
    metadata: { source: 'cash-entry-reversal' },
  })
}

async function refreshPayrollRunStatus(tx: Tx, payrollRunId: string, requestId?: string) {
  const [run, items] = await Promise.all([
    tx.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId }, select: { status: true } }),
    tx.payrollItem.findMany({
      where: { payrollRunId, status: { not: PayrollItemStatus.VOID } },
      select: { status: true },
    }),
  ])
  const status = items.length > 0 && items.every(item => item.status === PayrollItemStatus.PAID)
    ? PayrollRunStatus.PAID
    : items.some(item => item.status === PayrollItemStatus.PAID || item.status === PayrollItemStatus.PARTIALLY_PAID)
      ? PayrollRunStatus.PARTIALLY_PAID
      : PayrollRunStatus.APPROVED
  if (run.status !== status) {
    await tx.payrollRun.update({ where: { id: payrollRunId }, data: { status } })
    if (requestId) {
      await createCorrectionAudit(tx, {
        requestId,
        action: AuditAction.UPDATE,
        entityType: 'PayrollRun',
        entityId: payrollRunId,
        before: { status: run.status },
        after: { status },
        metadata: { source: 'payroll-reversal' },
      })
    } else {
      await createSystemAudit(
        tx,
        'PayrollRun',
        payrollRunId,
        AuditAction.UPDATE,
        'automatic-payroll-status',
      )
    }
  }
}

function serviceChargePeriod(dueDate: Date, cycle: BillingCycle) {
  if (cycle === BillingCycle.MONTHLY) {
    const start = parseDate(`${dueDate.getUTCFullYear()}-${pad(dueDate.getUTCMonth() + 1)}-01`)
    return { start, end: endOfMonth(start.getUTCFullYear(), start.getUTCMonth() + 1) }
  }
  if (cycle === BillingCycle.YEARLY) {
    return { start: dueDate, end: addDays(addYears(dueDate, 1), -1) }
  }
  return { start: dueDate, end: dueDate }
}

function nextServiceRenewal(date: Date, cycle: BillingCycle, anchorDay: number) {
  if (cycle === BillingCycle.MONTHLY) {
    const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
    return dateWithClampedDay(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, anchorDay)
  }
  if (cycle === BillingCycle.YEARLY) {
    return dateWithClampedDay(date.getUTCFullYear() + 1, date.getUTCMonth() + 1, anchorDay)
  }
  return null
}

function monthStartForDate(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function billingCycle(value: string): BillingCycle {
  const normalized = value.trim().toLocaleLowerCase('ar')
  if (normalized.includes('سن') || normalized.includes('year')) return BillingCycle.YEARLY
  if (normalized.includes('مرة') || normalized.includes('one')) return BillingCycle.ONE_TIME
  return BillingCycle.MONTHLY
}

function billingCycleLabel(value: BillingCycle) {
  if (value === BillingCycle.YEARLY) return 'سنوي'
  if (value === BillingCycle.ONE_TIME) return 'مرة واحدة'
  return 'شهري'
}

function liabilityPartyType(value: string): LiabilityPartyType {
  const normalized = value.trim().toLocaleLowerCase('ar')
  if (normalized.includes('مصور') || normalized.includes('photo')) return LiabilityPartyType.PHOTOGRAPHER
  if (normalized.includes('موديل') || normalized.includes('model')) return LiabilityPartyType.MODEL
  if (normalized.includes('مورد') || normalized.includes('supplier')) return LiabilityPartyType.SUPPLIER
  if (normalized.includes('مستقل') || normalized.includes('freelance')) return LiabilityPartyType.FREELANCER
  return LiabilityPartyType.OTHER
}

function liabilityPartyLabel(value: LiabilityPartyType) {
  switch (value) {
    case LiabilityPartyType.PHOTOGRAPHER: return 'مصور'
    case LiabilityPartyType.MODEL: return 'موديل'
    case LiabilityPartyType.SUPPLIER: return 'مورد'
    case LiabilityPartyType.FREELANCER: return 'مستقل'
    case LiabilityPartyType.OTHER: return 'أخرى'
  }
}

function incomeKind(value: string): CashEntryKind {
  const normalized = value.trim().toLocaleLowerCase('ar')
  if (normalized.includes('إعلان') || normalized.includes('اعلان') || normalized.includes('advert')) {
    return CashEntryKind.ADVERTISING_INCOME
  }
  return CashEntryKind.EXTERNAL_INCOME
}

function cashKindLabel(kind: CashEntryKind) {
  switch (kind) {
    case CashEntryKind.SUBSCRIPTION_PAYMENT: return 'دفعة اشتراك'
    case CashEntryKind.CLIENT_EXTRA_INCOME: return 'دخل إضافي من عميل'
    case CashEntryKind.ADVERTISING_INCOME: return 'دخل إعلاني'
    case CashEntryKind.EXTERNAL_INCOME: return 'دخل خارجي'
    case CashEntryKind.MANUAL_EXPENSE: return 'مصروف'
    case CashEntryKind.LIABILITY_PAYMENT: return 'دفع مستحق'
    case CashEntryKind.RECURRING_EXPENSE_PAYMENT: return 'مصروف ثابت'
    case CashEntryKind.SERVICE_PAYMENT: return 'اشتراك خدمة'
    case CashEntryKind.PAYROLL_PAYMENT: return 'راتب'
    case CashEntryKind.ADVANCE_DISBURSEMENT: return 'صرف سلفة'
    case CashEntryKind.ADVANCE_REPAYMENT: return 'سداد سلفة'
    case CashEntryKind.OPENING_BALANCE: return 'رصيد افتتاحي'
    case CashEntryKind.REVERSAL: return 'عكس قيد'
  }
}

function receivableStatus(
  total: Prisma.Decimal,
  paid: Prisma.Decimal,
  hasOverdueInvoice: boolean,
  hasPartiallyPaidInvoice: boolean,
): ClientDto['status'] {
  if (paid.gte(total)) return 'مسدد'
  if (hasOverdueInvoice) return 'متأخر'
  if (hasPartiallyPaidInvoice) return 'جزئي'
  return 'مستحق'
}

function toUsd(amount: Prisma.Decimal, currency: CurrencyCode, rate: Prisma.Decimal) {
  if (currency === CurrencyCode.USD) return amount.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
  if (rate.lte(ZERO)) throw new FinanceServiceError('INTERNAL_ERROR', 500, 'Invalid exchange rate.')
  return amount.div(rate).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
}

function sumDecimal(values: Prisma.Decimal[]) {
  return values.reduce((total, value) => total.plus(value), ZERO)
}

function decimal(value: string) {
  return new Prisma.Decimal(value)
}

function money(value: Prisma.Decimal) {
  const rounded = value.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
  const text = rounded.toFixed(4).replace(/(?:\.0+|(?:(\.\d*?[1-9])0+))$/, '$1')
  return text === '-0' ? '0' : text
}

function moneyRate(value: Prisma.Decimal) {
  const text = value.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP)
    .toFixed(8)
    .replace(/(?:\.0+|(?:(\.\d*?[1-9])0+))$/, '$1')
  return text === '-0' ? '0' : text
}

function mutation(entityType: string, entityId: string, action: AuditAction): MutationResult {
  return { entityType, entityId, action }
}

function notFound(label: string) {
  return new FinanceServiceError('NOT_FOUND', 404, `${label} was not found.`)
}

function conflict(message: string) {
  return new FinanceServiceError('CONFLICT', 409, message)
}

function invariant(message: string) {
  return new FinanceServiceError('INTERNAL_ERROR', 500, message)
}

function commandFingerprint(command: FinanceCommand) {
  return createHash('sha256')
    .update(stableStringify({ type: command.type, payload: command.payload }))
    .digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => (
    `${JSON.stringify(key)}:${stableStringify(object[key])}`
  )).join(',')}}`
}

function slugify(value: string) {
  const slug = value.normalize('NFKC')
    .toLocaleLowerCase('ar')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  return slug || 'other'
}

function localDateParts(value: Date, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value)
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value)
    return { year: part('year'), month: part('month'), day: part('day') }
  } catch {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
    }
  }
}

function parseDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`)
}

function dateText(value: Date) {
  return value.toISOString().slice(0, 10)
}

function dateWithClampedDay(year: number, month: number, day: number) {
  const lastDay = endOfMonth(year, month).getUTCDate()
  return parseDate(`${year}-${pad(month)}-${pad(Math.min(day, lastDay))}`)
}

function endOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0))
}

function addDays(value: Date, days: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days))
}

function addMonths(value: Date, months: number) {
  const targetMonth = value.getUTCMonth() + months
  const targetYear = value.getUTCFullYear() + Math.floor(targetMonth / 12)
  const normalizedMonth = ((targetMonth % 12) + 12) % 12
  const day = Math.min(value.getUTCDate(), new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate())
  return new Date(Date.UTC(targetYear, normalizedMonth, day))
}

function addYears(value: Date, years: number) {
  const year = value.getUTCFullYear() + years
  const month = value.getUTCMonth()
  const day = Math.min(value.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
  return new Date(Date.UTC(year, month, day))
}

function sameDate(left: Date, right: Date) {
  return dateText(left) === dateText(right)
}

function yearOf(date: string) {
  return Number(date.slice(0, 4))
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function isRetryableTransactionError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && (
    error.code === 'P2002' || error.code === 'P2034'
  )
}

function mapDatabaseError(error: unknown): FinanceServiceError {
  if (error instanceof FinanceServiceError) return error
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return new FinanceServiceError('DATABASE_UNAVAILABLE', 503, 'The finance database is unavailable.')
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2025') return notFound('Record')
    if (error.code === 'P2002' || error.code === 'P2034') {
      return conflict('The data changed concurrently. Please retry the request.')
    }
    if (/^P10\d\d$/.test(error.code)) {
      return new FinanceServiceError('DATABASE_UNAVAILABLE', 503, 'The finance database is unavailable.')
    }
  }
  console.error('Finance service failure', error)
  return new FinanceServiceError('INTERNAL_ERROR', 500, 'The finance operation could not be completed.')
}
