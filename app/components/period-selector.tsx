'use client'

import { isReportMonth, type ReportPeriod } from '@/lib/finance/period-view'

export function PeriodSelector({ period, businessMonth, note, onChange }: {
  period: ReportPeriod; businessMonth: string; note: string; onChange: (period: ReportPeriod) => void
}) {
  return <section className="toolbar period-toolbar" aria-label="اختيار الفترة">
    <label><span>عرض البيانات</span><select aria-label="عرض البيانات" value={period === 'all' ? 'all' : 'month'} onChange={event => onChange(event.target.value === 'all' ? 'all' : businessMonth)}>
      <option value="all">كل الأشهر</option><option value="month">شهر محدد</option>
    </select></label>
    {period !== 'all' && <label><span>الشهر</span><input aria-label="الشهر" type="month" min="1900-01" max={businessMonth} value={period} onChange={event => { if (isReportMonth(event.target.value)) onChange(event.target.value) }}/></label>}
    <div className="period-help"><b>{period === 'all' ? 'كل الأشهر — العرض الإجمالي' : `الفترة: ${period}`}</b><small>{note}</small><small>اختيار الفترة للعرض فقط؛ تاريخ الحفظ يُحدد داخل نموذج الحركة.</small></div>
  </section>
}
