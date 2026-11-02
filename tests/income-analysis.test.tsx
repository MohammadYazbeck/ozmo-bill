import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { analyzeIncome, filterIncomeRows, formatIncomeUsd } from '@/lib/finance/income-analysis'
import type { IncomeDto } from '@/lib/finance/contracts'
import { IncomeBreakdown, IncomeSummary } from '@/app/components/income-analysis'

function income(type: string, usd: string, extra: Partial<IncomeDto> = {}): IncomeDto {
  return { id: type, cashEntryId: type, source: 'Burgasm', date: '2026-11-01', type, amount: usd, currency: 'USD', usd, note: '', ...extra }
}

describe('income-only summaries and classification', () => {
  it('keeps subscription payments, extra client income, advertising and external income separate', () => {
    const rows = [income('دفعة اشتراك', '200'), income('دخل خارجي', '150'), income('دخل إضافي من عميل', '50', { clientId: 'same-client' }), income('دخل إعلاني', '100')]
    const result = analyzeIncome(rows)
    expect(result.total).toBe('500')
    expect(result.count).toBe(4)
    expect(result.groups.map(group => [group.type, group.amount, group.count, group.share])).toEqual([
      ['دفعة اشتراك', '200', 1, 40], ['دخل عميل إضافي', '50', 1, 10],
      ['دخل تشغيل إعلانات', '100', 1, 20], ['دخل خارجي', '150', 1, 30],
    ])
  })
  it('normalizes both saved and form labels without splitting the same category', () => {
    const result = analyzeIncome([income('دخل إعلاني', '5'), income('دخل تشغيل إعلانات', '10'), income('دخل عميل إضافي', '20'), income('دخل إضافي من عميل', '30')])
    expect(result.groups.find(group => group.type === 'دخل تشغيل إعلانات')).toMatchObject({ amount: '15', count: 2 })
    expect(result.groups.find(group => group.type === 'دخل عميل إضافي')).toMatchObject({ amount: '50', count: 2 })
  })
  it('uses booked USD, not original SYP or a new exchange rate', () => {
    expect(analyzeIncome([income('دخل خارجي', '10', { amount: '120000', currency: 'SYP' })]).total).toBe('10')
  })
  it('sums four-place decimals exactly and rounds money only for display', () => {
    expect(analyzeIncome([income('دخل خارجي', '0.1'), income('دخل خارجي', '0.2'), income('دخل خارجي', '0.0001')]).total).toBe('0.3001')
    expect(formatIncomeUsd('1234.565')).toBe('$1,234.57')
    expect(formatIncomeUsd('0.0049')).toBe('$0.00')
    expect(formatIncomeUsd('9007199254740991.9999')).toBe('$9,007,199,254,740,992.00')
  })
  it('returns stable zero cards and no NaN percentages for empty or zero-value results', () => {
    for (const rows of [[], [income('دفعة اشتراك', '0')]]) {
      const result = analyzeIncome(rows)
      expect(result.total).toBe('0')
      expect(result.groups).toHaveLength(4)
      expect(result.groups.every(group => group.share === 0)).toBe(true)
    }
  })
  it('does not silently discard unsupported historical income types', () => {
    const result = analyzeIncome([income('نوع قديم', '25')])
    expect(result.total).toBe('25')
    expect(result.groups.at(-1)).toMatchObject({ label: 'دخل غير مصنّف', amount: '25', share: 100 })
  })
  it('feeds the same searched and type-filtered rows into totals, counts and bars', () => {
    const rows = [income('دفعة اشتراك', '200'), income('دخل خارجي', '150'), income('دخل خارجي', '75', { source: 'Other' })]
    expect(analyzeIncome(filterIncomeRows(rows, ' BURGASM ', 'الكل')).total).toBe('350')
    const external = analyzeIncome(filterIncomeRows(rows, 'burgasm', 'دخل خارجي'))
    expect(external).toMatchObject({ total: '150', count: 1 })
    expect(external.groups.find(group => group.type === 'دفعة اشتراك')?.amount).toBe('0')
    expect(analyzeIncome(filterIncomeRows(rows, 'missing', 'الكل')).count).toBe(0)
    expect(analyzeIncome(filterIncomeRows(rows, '', 'الكل')).total).toBe('425')
  })
  it('preserves source rows and matches date, note and linked-client searches', () => {
    const row = Object.freeze(income('دخل إضافي من عميل', '12', { source: 'Source', client: 'عميل إضافي', note: 'ملاحظة للاختبار' }))
    for (const query of ['2026-11-01', 'ملاحظة', 'عميل']) expect(filterIncomeRows([row], query, 'دخل عميل إضافي')).toEqual([row])
    analyzeIncome([row])
    expect(row.type).toBe('دخل إضافي من عميل')
    expect(row.usd).toBe('12')
  })
  it('renders matching cards and accessible percentage bars with income wording, not expense categories', () => {
    const analysis = analyzeIncome([income('دفعة اشتراك', '200'), income('دخل خارجي', '150')])
    const html = renderToStaticMarkup(createElement('div', null, createElement(IncomeSummary, { analysis }), createElement(IncomeBreakdown, { analysis })))
    expect(html).toContain('إجمالي الدخل')
    expect(html).toContain('$350.00')
    expect(html).toContain('تصنيف الدخل')
    expect(html).toContain('aria-valuenow="57.1"')
    expect(html).toContain('42.9%')
    expect(html).toContain('حسب نتائج البحث والفلترة الحالية')
    expect(html).not.toContain('من المصروفات')
  })
  it('renders a useful empty result without infinity or broken bar widths', () => {
    const html = renderToStaticMarkup(createElement(IncomeBreakdown, { analysis: analyzeIncome([]) }))
    expect(html).toContain('لا توجد حركات دخل ضمن النتائج الحالية.')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('Infinity')
    expect(html).not.toContain('role="meter"')
  })
})
