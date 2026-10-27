import type { ExpenseDto, IncomeDto } from './contracts'

export function incomeFormType(type: string) {
  if (type === 'دخل إضافي من عميل') return 'دخل عميل إضافي'
  if (type === 'دخل إعلاني') return 'دخل تشغيل إعلانات'
  return type
}

type CommonDraft = Pick<ExpenseDto, 'date' | 'amount' | 'currency' | 'note' | 'clientId' | 'client'>

/** Copy form values only: never copy ledger identity, USD/rate snapshots, or audit history. */
export function incomeDuplicateDraft(row: IncomeDto) {
  const type = (['دفعة اشتراك', 'دخل عميل إضافي', 'دخل تشغيل إعلانات', 'دخل خارجي'] as const)
    .find(candidate => candidate === incomeFormType(row.type))
  if (!row.cashEntryId || !type) return null
  return {
    date: row.date, amount: row.amount, currency: row.currency, note: row.note,
    ...(row.clientId ? { clientId: row.clientId } : {}),
    ...(row.client ? { client: row.client } : {}),
    type, source: row.description ?? row.source,
  } satisfies CommonDraft & { type: string; source: string }
}

/** Structured payments become independent manual expenses; their payable IDs are not copied. */
export function expenseDuplicateDraft(row: ExpenseDto) {
  if (!row.cashEntryId) return null // Noncash payroll deductions are not repeatable cash payments.
  return {
    date: row.date, amount: row.amount, currency: row.currency, note: row.note,
    ...(row.clientId ? { clientId: row.clientId } : {}),
    ...(row.client ? { client: row.client } : {}),
    name: row.name, category: row.category,
  } satisfies CommonDraft & { name: string; category: string }
}
