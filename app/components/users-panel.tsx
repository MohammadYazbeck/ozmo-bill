'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { roleLabel, type Principal, type UserDto } from '@/lib/auth/types'

async function readUsers(response: Response): Promise<UserDto[]> {
  const body = await response.json()
  if (!response.ok) throw new Error(body.error?.message || 'تعذّر تحميل المستخدمين.')
  if (!Array.isArray(body.users)) throw new Error('استجابة المستخدمين غير صالحة.')
  return body.users
}

export function UsersPanel({ currentUser, onChanged }: { currentUser: Principal; onChanged: () => Promise<void> }) {
  const [users, setUsers] = useState<UserDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<UserDto | 'new' | null>(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const refresh = useCallback(async () => {
    setLoading(true); setError('')
    try { setUsers(await readUsers(await fetch('/api/users', { credentials: 'same-origin', cache: 'no-store' }))) }
    catch (error) { setError(error instanceof Error ? error.message : 'تعذّر تحميل المستخدمين.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh() }, 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editing || saving) return
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') || '')
    const fields = { name: String(form.get('name') || ''), role: String(form.get('role') || 'VIEWER') }
    const command = editing === 'new'
      ? { type: 'create', ...fields, username: String(form.get('username') || ''), password }
      : { type: 'update', ...fields, id: editing.id, version: editing.version, active: form.get('active') === 'on', ...(password ? { password } : {}) }
    if (editing !== 'new' && editing.id === currentUser.id && (!('active' in command) || !command.active || fields.role === 'VIEWER' || password)) {
      if (!window.confirm('أنت تعدّل حسابك الحالي. تغيير كلمة المرور أو تعطيل الحساب قد يطلب تسجيل الدخول مجددًا؛ تخفيض الصلاحية يمنعك من إدارة المستخدمين. متابعة؟')) return
    }
    setSaving(true); setError('')
    try {
      setUsers(await readUsers(await fetch('/api/users', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) })))
      setEditing(null)
      await onChanged()
    } catch (error) { setError(error instanceof Error ? error.message : 'تعذّر حفظ المستخدم.') }
    finally { setSaving(false) }
  }

  const rows = users.filter(user => `${user.name} ${user.username}`.toLocaleLowerCase('ar').includes(search.toLocaleLowerCase('ar')))
  return <>
    <header className="page-head"><div><span className="eyebrow">الحسابات والصلاحيات</span><h1>المستخدمون</h1><p>حساب مستقل لكل شخص، مع تسجيل اسم مُدخل السجلات والحركات.</p></div><button className="btn primary" disabled={loading || saving} onClick={() => { setError(''); setEditing('new') }}>+ إضافة مستخدم</button></header>
    <div className="notice">«مشاهدة فقط»: عرض الأقسام والبحث والتصدير دون تغيير. «تعديل»: نفس صلاحيات المدير، بما فيها إدارة المستخدمين. حساب المالك الأساسي محمي ولا يمكن تعطيله من هنا.</div>
    {error && <div className="notice error-notice" role="alert">{error}</div>}
    <section className="panel table-panel"><div className="list-tools"><div><h2>حسابات المستخدمين</h2><span>{users.length} حسابات إضافية</span></div><div className="table-filters"><input className="search" placeholder="ابحث بالاسم أو اسم المستخدم…" value={search} onChange={event => setSearch(event.target.value)}/><button className="btn ghost" disabled={loading || saving} onClick={() => void refresh()}>تحديث</button></div></div>
      <div className="table-scroll"><table><thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الصلاحية</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>
        {currentUser.role === 'OWNER' && <tr><td>{currentUser.name}</td><td dir="ltr">{currentUser.username}</td><td>المالك — مدير</td><td>فعّال</td><td><small>حساب أساسي محمي</small></td></tr>}
        {loading ? <tr><td colSpan={5}>جاري تحميل المستخدمين…</td></tr> : rows.map(user => <tr key={user.id}><td className="strong">{user.name}{user.id === currentUser.id && <small> — حسابك</small>}{user.createdBy && <small className="entry-author">تم الإدخال بواسطة {user.createdBy}</small>}</td><td dir="ltr">{user.username}</td><td>{roleLabel(user.role)}</td><td>{user.active ? 'فعّال' : 'معطّل'}</td><td><button className="table-action" disabled={saving} onClick={() => { setError(''); setEditing(user) }}>تعديل / تعطيل</button></td></tr>)}
        {!loading && rows.length === 0 && <tr><td colSpan={5}>لا توجد حسابات مطابقة. يمكنك إضافة مستخدم جديد.</td></tr>}
      </tbody></table></div>
    </section>
    <p className="field-help">الدخول بنفس نافذة اسم المستخدم وكلمة المرور الحالية للنظام. لتجربة حساب آخر بدون تغيير حسابك الحالي استخدم نافذة خاصة. لا تُعرض كلمات المرور أو تُصدّر؛ اترك حقلها فارغًا عند التعديل للإبقاء عليها.</p>
    {editing && <div className="action-overlay" role="presentation"><section className="action-dialog" role="dialog" aria-modal="true" aria-labelledby="user-form-title"><button className="guide-close" aria-label="إغلاق" disabled={saving} onClick={() => setEditing(null)}>×</button><header><span className="eyebrow">إدارة المستخدمين</span><h2 id="user-form-title">{editing === 'new' ? 'إضافة مستخدم' : `تعديل حساب ${editing.name}`}</h2></header>
      {error && <div className="notice error-notice" role="alert">{error}</div>}
      <form key={editing === 'new' ? 'new' : `${editing.id}:${editing.version}`} className="action-form" onSubmit={save}>
        <label className="field"><span>الاسم الظاهر في الحركات</span><input name="name" required maxLength={100} defaultValue={editing === 'new' ? '' : editing.name} autoComplete="off"/></label>
        <label className="field"><span>اسم المستخدم للدخول</span><input name="username" dir="ltr" required minLength={3} maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}" readOnly={editing !== 'new'} defaultValue={editing === 'new' ? '' : editing.username} autoComplete="off"/></label>
        <label className="field"><span>الصلاحية</span><select name="role" defaultValue={editing === 'new' ? 'VIEWER' : editing.role}><option value="VIEWER">مشاهدة فقط</option><option value="EDITOR">تعديل — مدير</option></select></label>
        <label className="field"><span>{editing === 'new' ? 'كلمة المرور' : 'كلمة مرور جديدة — اختياري'}</span><input name="password" type="password" required={editing === 'new'} minLength={12} maxLength={128} autoComplete="new-password"/></label>
        <div className="field-help full">اسم المستخدم: أحرف إنكليزية وأرقام و . _ -، ويُحفظ بأحرف صغيرة. كلمة المرور: 12 محرفًا على الأقل، بينها 6 محارف مختلفة. سلّم بيانات الدخول للشخص المقصود بشكل خاص.</div>
        {editing !== 'new' && <label className="field"><span>الحساب فعّال</span><input name="active" type="checkbox" defaultChecked={editing.active}/></label>}
        <div className="form-actions full"><button className="btn ghost" type="button" disabled={saving} onClick={() => setEditing(null)}>إلغاء</button><button className="btn primary" type="submit" disabled={saving}>{saving ? 'جاري الحفظ…' : 'حفظ المستخدم'}</button></div>
      </form>
    </section></div>}
  </>
}
