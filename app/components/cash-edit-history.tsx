import type { CashEntryEditDto } from '@/lib/finance/contracts'
import { cashEditFieldLabels } from '@/lib/finance/edit-history'

export function CashEditHistory({ history }: { history: CashEntryEditDto[] }) {
  const renderEdit = (edit: CashEntryEditDto) => <article key={edit.id}>
    <p>تم تعديل {edit.changes.map(change => cashEditFieldLabels[change.field] ?? change.field).join('، ') || 'الحركة'} من قبل <b>{edit.actor}</b> بتاريخ <time dateTime={edit.occurredAt}>{new Intl.DateTimeFormat('ar-SY-u-nu-latn', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Damascus',
    }).format(new Date(edit.occurredAt))}</time></p>
    <ul>{edit.changes.map(change => <li key={change.field}>{cashEditFieldLabels[change.field] ?? change.field}: من <span dir="auto">{change.before || '—'}</span> إلى <span dir="auto">{change.after || '—'}</span></li>)}</ul>
    {edit.reason && <small>سبب التعديل: {edit.reason}</small>}
  </article>
  if (!history.length) return null
  return <div className="cash-edit-history" aria-label="سجل تعديلات الحركة">
    {renderEdit(history[0])}
    {history.length > 1 && <details><summary>التعديلات السابقة ({history.length - 1})</summary>{history.slice(1).map(renderEdit)}</details>}
  </div>
}
