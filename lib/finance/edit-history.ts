import type { CashEntryEditDto } from './contracts'

type EditAudit = {
  id: string
  entityId: string
  actor: string | null
  occurredAt: Date
  before: unknown
  after: unknown
  metadata: unknown
}

export const cashEditFieldLabels: Record<string, string> = {
  date: 'التاريخ', description: 'البند / المصدر', type: 'نوع الحركة',
  amount: 'المبلغ الأصلي', currency: 'العملة', usd: 'المبلغ بالدولار',
  exchangeRate: 'سعر الصرف', client: 'العميل', category: 'التصنيف', note: 'البيان',
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

export function cashEditChanges(before: unknown, after: unknown) {
  const old = record(before)
  const next = record(after)
  return Object.keys(cashEditFieldLabels).flatMap(field => {
    const a = String(old[field] ?? '')
    const b = String(next[field] ?? '')
    return a === b ? [] : [{ field, before: a, after: b }]
  })
}

/** Follow immutable replacement IDs so a second edit keeps the first edit visible. */
export function buildCashEditHistories(audits: EditAudit[]) {
  const byEntry = new Map(audits.map(event => [event.entityId, event]))
  const histories = new Map<string, CashEntryEditDto[]>()
  for (const entryId of byEntry.keys()) {
    const history: CashEntryEditDto[] = []
    const seen = new Set<string>()
    let current: string | undefined = entryId
    while (current && !seen.has(current)) {
      seen.add(current)
      const event = byEntry.get(current)
      if (!event) break
      const metadata = record(event.metadata)
      history.push({
        id: event.id, actor: event.actor || 'غير محدد',
        occurredAt: event.occurredAt.toISOString(),
        reason: typeof metadata.reason === 'string' ? metadata.reason : '',
        changes: cashEditChanges(event.before, event.after),
      })
      current = typeof metadata.previousCashEntryId === 'string' ? metadata.previousCashEntryId : undefined
    }
    histories.set(entryId, history)
  }
  return histories
}

/** Liability links keep the same entity ID, so retain every event instead of replacing by ID. */
export function buildLiabilityClientHistories(audits: EditAudit[]) {
  const histories = new Map<string, CashEntryEditDto[]>()
  for (const event of audits) {
    const metadata = record(event.metadata)
    const history = histories.get(event.entityId) ?? []
    history.push({
      id: event.id, actor: event.actor || 'غير محدد', occurredAt: event.occurredAt.toISOString(),
      reason: typeof metadata.reason === 'string' ? metadata.reason : '',
      changes: cashEditChanges(event.before, event.after),
    })
    histories.set(event.entityId, history)
  }
  return histories
}
