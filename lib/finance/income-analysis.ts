import { decimalToUnits, unitsToDecimal } from './accounting'
import type { IncomeDto } from './contracts'
import { incomeFormType } from './duplicate-draft'

const categories = [
  { type: 'دفعة اشتراك', label: 'دفعات الاشتراكات', color: '#ff5a0a' },
  { type: 'دخل عميل إضافي', label: 'دخل إضافي من العملاء', color: '#24211f' },
  { type: 'دخل تشغيل إعلانات', label: 'دخل تشغيل الإعلانات', color: '#ff9a64' },
  { type: 'دخل خارجي', label: 'دخل خارجي', color: '#806f63' },
] as const

export type IncomeAnalysis = {
  total: string
  count: number
  groups: { type: string; label: string; color: string; amount: string; count: number; share: number }[]
}

export function filterIncomeRows(rows: IncomeDto[], search: string, type: string) {
  const query = search.trim().toLocaleLowerCase('ar')
  return rows.filter(row => (type === 'الكل' || incomeFormType(row.type) === type)
    && `${row.date} ${row.source} ${row.client ?? ''} ${row.type} ${row.note}`.toLocaleLowerCase('ar').includes(query))
}

/** Classify by the saved income type, never by source text, client name or original currency. */
export function analyzeIncome(rows: Pick<IncomeDto, 'type' | 'usd'>[]): IncomeAnalysis {
  const totals = new Map<string, { units: bigint; count: number }>()
  for (const row of rows) {
    const canonical = incomeFormType(row.type)
    const type = categories.some(category => category.type === canonical) ? canonical : 'unclassified'
    const previous = totals.get(type) ?? { units: 0n, count: 0 }
    totals.set(type, { units: previous.units + decimalToUnits(row.usd), count: previous.count + 1 })
  }
  const total = [...totals.values()].reduce((sum, group) => sum + group.units, 0n)
  const visibleCategories: { type: string; label: string; color: string }[] = [...categories]
  if (totals.has('unclassified')) visibleCategories.push({ type: 'unclassified', label: 'دخل غير مصنّف', color: '#d8c8b8' })
  return {
    total: unitsToDecimal(total), count: rows.length,
    groups: visibleCategories.map(category => {
      const value = totals.get(category.type) ?? { units: 0n, count: 0 }
      return { ...category, amount: unitsToDecimal(value.units), count: value.count,
        share: total > 0n ? Number((value.units * 1000n + total / 2n) / total) / 10 : 0 }
    }),
  }
}

/** Format only for display; aggregate decimal strings at the stored four-place precision. */
export function formatIncomeUsd(amount: string) {
  const cents = (decimalToUnits(amount) + 50n) / 100n
  return `$${new Intl.NumberFormat('en-US').format(cents / 100n)}.${(cents % 100n).toString().padStart(2, '0')}`
}
