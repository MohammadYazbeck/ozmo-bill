import { formatIncomeUsd, type IncomeAnalysis } from '@/lib/finance/income-analysis'

export function IncomeSummary({ analysis }: { analysis: IncomeAnalysis }) {
  return <section className="kpi-grid income-summary" aria-label="ملخص الدخل حسب نتائج البحث والفلترة">
    <article className="kpi green"><div className="kpi-label">إجمالي الدخل</div><strong>{formatIncomeUsd(analysis.total)}</strong><small>{analysis.count} حركة</small></article>
    {analysis.groups.map(group => <article key={group.type} className="kpi" style={{ borderTopColor: group.color }}>
      <div className="kpi-label">{group.label}</div><strong>{formatIncomeUsd(group.amount)}</strong><small>{group.count} حركة</small>
    </article>)}
  </section>
}

export function IncomeBreakdown({ analysis }: { analysis: IncomeAnalysis }) {
  return <section className="panel" aria-labelledby="income-breakdown-title">
    <div className="panel-title"><h2 id="income-breakdown-title">تصنيف الدخل</h2><span>حسب نتائج البحث والفلترة الحالية</span></div>
    {analysis.count === 0 ? <p className="income-empty">لا توجد حركات دخل ضمن النتائج الحالية.</p> : <div className="expense-list detailed">
      {analysis.groups.map(group => <div className="expense-row" key={group.type}>
        <div className="expense-top"><span><i className="dot" style={{ background: group.color }}/>{group.label}</span><b>{formatIncomeUsd(group.amount)}</b></div>
        <div className="expense-track" role="meter" aria-label={group.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={group.share} aria-valuetext={`${group.share.toFixed(1)}% من الدخل، ${formatIncomeUsd(group.amount)}`}>
          <span style={{ width: `${group.share}%`, background: group.color }}/>
        </div>
        <small><bdi dir="ltr">{group.share.toFixed(1)}%</bdi> من الدخل · {group.count} حركة</small>
      </div>)}
    </div>}
    <p className="field-help">المبالغ المحصّلة بالدولار حسب قيمة الحركة المحفوظة، وليست قيمة العقود أو الفواتير غير المدفوعة. الدخل الإضافي والخارجي لا يُحسبان كدفعات اشتراك.</p>
  </section>
}
