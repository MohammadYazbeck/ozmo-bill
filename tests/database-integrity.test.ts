import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = process.cwd()
const schema = readFileSync(join(projectRoot, 'prisma', 'schema.prisma'), 'utf8')
const migration = readFileSync(
  join(projectRoot, 'prisma', 'migrations', '20260930000000_init', 'migration.sql'),
  'utf8',
)

const applicationFamilies = [
  ['CustomerPayment', 'CUSTOMER_PAYMENT', 'SUBSCRIPTION_PAYMENT'],
  ['LiabilityPayment', 'LIABILITY_PAYMENT', 'LIABILITY_PAYMENT'],
  ['PayrollPayment', 'PAYROLL_PAYMENT', 'PAYROLL_PAYMENT'],
  ['Advance', 'ADVANCE_DISBURSEMENT', 'ADVANCE_DISBURSEMENT'],
  ['AdvanceRepayment', 'ADVANCE_REPAYMENT', 'ADVANCE_REPAYMENT'],
  ['RecurringExpensePayment', 'RECURRING_EXPENSE_PAYMENT', 'RECURRING_EXPENSE_PAYMENT'],
  ['ServicePayment', 'SERVICE_PAYMENT', 'SERVICE_PAYMENT'],
] as const

describe('cash-entry application integrity migration', () => {
  it('represents the global registry in both Prisma and PostgreSQL', () => {
    expect(schema).toContain('enum CashApplicationKind {')
    expect(schema).toContain('model CashEntryApplication {')
    expect(schema).toContain('cashEntryId     String              @id @db.Uuid')
    expect(schema).toContain('@@unique([applicationKind, applicationId])')
    expect(migration).toContain('CONSTRAINT "CashEntryApplication_pkey" PRIMARY KEY ("cashEntryId")')
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "CashEntryApplication_applicationKind_applicationId_key"',
    )
    expect(migration).toContain('CONSTRAINT "CashEntryApplication_cashEntryId_fkey"')
  })

  it.each(applicationFamilies)(
    'registers and freezes the %s binding as %s',
    (table, applicationKind) => {
      expect(migration).toContain(`WHEN '${table}' THEN application_kind := '${applicationKind}';`)
      expect(migration).toContain(`CREATE TRIGGER "${table}_register_cash_entry"`)
      expect(migration).toContain(`CREATE TRIGGER "${table}_immutable_binding"`)
    },
  )

  it.each(applicationFamilies)(
    'requires %s cash entries to map from %s to %s',
    (_table, applicationKind, cashKind) => {
      expect(migration).toContain(
        `WHEN '${cashKind}' THEN expected_application_kind := '${applicationKind}';`,
      )
    },
  )

  it('skips noncash payroll advance deductions and validates cash semantics', () => {
    expect(migration).toContain(
      `IF TG_TABLE_NAME = 'AdvanceRepayment' AND NEW."cashEntryId" IS NULL THEN`,
    )
    expect(migration).toContain('cash_status <> \'POSTED\'')
    expect(migration).toContain('cash_kind <> expected_cash_kind')
    expect(migration).toContain(
      'cash_organization_id IS DISTINCT FROM application_organization_id',
    )
    expect(migration).toContain('cash_occurred_on IS DISTINCT FROM application_date')
    expect(migration).toContain('cash_amount_usd IS DISTINCT FROM application_amount_usd')
    expect(migration).toContain("RAISE EXCEPTION 'A new non-reversal cash entry must be posted'")
  })

  it('defers completeness until transaction commit and forbids registry mutation', () => {
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER "CashEntry_application_complete"')
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(migration).toContain('CONSTRAINT = \'CashEntry_application_forbidden\'')
    expect(migration).toContain('CONSTRAINT = \'CashEntry_application_required\'')
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "CashEntryApplication"')
  })
})
