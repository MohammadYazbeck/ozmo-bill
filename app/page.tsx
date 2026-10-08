'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import Image from 'next/image'
import { downloadInvoiceXlsx } from './invoice'
import { decimalToUnits, unitsToDecimal } from '@/lib/finance/accounting'
import type {
  CashLedgerEntryDto,
  ClientDto,
  ClientRecord,
  Currency,
  EmployeeDto,
  ExpenseDto,
  FinanceCommandInput,
  FinanceSnapshot,
  FixedExpenseDto,
  FixedExpenseRecord,
  LiabilityRecord,
  PayrollSettlementDto,
  ServiceDto,
  ServiceRecord,
} from '@/lib/finance/contracts'

type View =
  | 'dashboard'
  | 'subscriptions'
  | 'clients'
  | 'income'
  | 'expenses'
  | 'liabilities'
  | 'payroll'
  | 'advances'
  | 'cashbox'
  | 'reports'
  | 'settings'

type IconName = 'grid' | 'repeat' | 'users' | 'in' | 'out' | 'briefcase' | 'wallet' | 'safe' | 'chart' | 'gear'

const navigation: { id: View; label: string; icon: IconName }[] = [
  { id: 'dashboard', label: 'نظرة عامة', icon: 'grid' },
  { id: 'subscriptions', label: 'الاشتراكات', icon: 'repeat' },
  { id: 'clients', label: 'العملاء', icon: 'users' },
  { id: 'income', label: 'الدخل', icon: 'in' },
  { id: 'expenses', label: 'المصروفات', icon: 'out' },
  { id: 'liabilities', label: 'الذمم المستحقة', icon: 'briefcase' },
  { id: 'payroll', label: 'الموظفون والرواتب', icon: 'briefcase' },
  { id: 'advances', label: 'السلف والسحوبات', icon: 'wallet' },
  { id: 'cashbox', label: 'الصندوق', icon: 'safe' },
  { id: 'reports', label: 'التقارير', icon: 'chart' },
  { id: 'settings', label: 'الإعدادات', icon: 'gear' },
]

type FinanceContextValue = {
  data: FinanceSnapshot
  mutating: boolean
  mutationError: string
  refresh: () => Promise<void>
  runCommand: (command: FinanceCommandInput) => Promise<void>
}

const FinanceContext = createContext<FinanceContextValue | null>(null)

function useFinance() {
  const value = useContext(FinanceContext)
  if (!value) throw new Error('Finance context is unavailable')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFinanceSnapshot(value: unknown): value is FinanceSnapshot {
  if (!isRecord(value)) return false
  return Array.isArray(value.clients)
    && Array.isArray(value.incomes)
    && Array.isArray(value.expenses)
    && Array.isArray(value.liabilities)
    && Array.isArray(value.employees)
    && Array.isArray(value.advances)
    && Array.isArray(value.fixedExpenses)
    && Array.isArray(value.services)
    && Array.isArray(value.cashLedger)
    && Array.isArray(value.payrollSettlements)
    && typeof value.exchangeRate === 'string'
    && isRecord(value.cashbox)
    && typeof value.revision === 'string'
    && typeof value.generatedAt === 'string'
}

async function readFinanceResponse(response: Response): Promise<FinanceSnapshot> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error('أعاد الخادم استجابة غير صالحة. حاول مجددًا.')
  }

  const apiMessage = isRecord(body)
    && isRecord(body.error)
    && typeof body.error.message === 'string'
    ? body.error.message
    : ''

  if (!response.ok) {
    throw new Error(apiMessage || 'تعذّر تنفيذ الطلب. حاول مجددًا.')
  }

  const snapshot = isRecord(body) ? body.data : undefined
  if (!isFinanceSnapshot(snapshot)) {
    throw new Error('لم يرسل الخادم لقطة مالية صالحة. حاول تحديث الصفحة.')
  }
  return snapshot
}

function requestErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function EmptyTableRow({ columns, text = 'لا توجد بيانات بعد. استخدم زر الإضافة للبدء.' }: { columns: number; text?: string }) {
  return <tr><td colSpan={columns} style={{ textAlign: 'center', padding: '32px', color: '#806f63' }}>{text}</td></tr>
}

// Kept only for the non-rendered prototype screens below while the local screens
// use FinanceContext. All arrays are intentionally empty.
const clients: ClientRecord[] = []
const months: { month: string; income: number; expense: number; profit: number; collection: number }[] = []
const expenses: { category: string; amount: number; color: string }[] = []
const incomeRows: { date: string; source: string; type: string; original: string; usd: string; note: string }[] = []
const payroll: { name: string; base: number; bonus: number; deductions: number; loan: number; net: number; status: string }[] = []
const fixedExpenses: FixedExpenseRecord[] = []
const serviceSubscriptions: ServiceRecord[] = []
const liabilities: LiabilityRecord[] = []
const clientProfitability: { client: string; revenue: number; paidExpenses: number; openLiabilities: number }[] = []
const linkedExpenses: { date: string; client: string; category: string; description: string; amount: number }[] = []

type ActionRequest = { action: string; subject?: string; subjectId?: string }

function openAction(action: string, subject?: string, subjectId?: string) {
  window.dispatchEvent(new CustomEvent<ActionRequest>('ozmo-open-action', { detail: { action, subject, subjectId } }))
}

const guideSteps = [
  {
    kicker: 'أهلًا بك في OZMO Finance',
    title: 'كل الوضع المالي للشركة في مكان واحد',
    description: 'هذا النظام يساعدك على متابعة الاشتراكات والدخل والمصروفات والرواتب والصندوق، ثم يحوّلها إلى تقارير واضحة وسريعة.',
    symbol: 'OZ',
    points: ['واجهة عربية بسيطة', 'أرقام أساسية بالدولار', 'جداول عملية تشبه Excel'],
  },
  {
    kicker: 'القائمة الرئيسية',
    title: 'من هنا تصل إلى كل قسم',
    description: 'القائمة السوداء على يمين الشاشة هي نقطة البداية. اختر القسم المطلوب، وستتبدل مساحة العمل من دون أن تضيع الصفحة التي تعمل عليها.',
    symbol: '01',
    points: ['الاشتراكات والعملاء للتحصيل', 'الدخل والمصروفات للحركات اليومية', 'الذمم المستحقة قبل الدفع', 'الصندوق والتقارير لمعرفة النتيجة'],
  },
  {
    kicker: 'تسجيل الدخل',
    title: 'اختر نوع الدخل الصحيح أولًا',
    description: 'فصل أنواع الدخل يجعل تقاريرك دقيقة. دخل الإعلانات مستقل ولا يحتاج إلى اختيار عميل، بينما دفعة الاشتراك تُربط بفاتورة العميل.',
    symbol: '02',
    points: ['دفعة اشتراك', 'دخل عميل إضافي', 'دخل تشغيل إعلانات', 'دخل خارجي'],
  },
  {
    kicker: 'العملات والصندوق',
    title: 'أدخل بالدولار أو بالليرة',
    description: 'الدولار هو أساس التقارير. عند إدخال مبلغ بالليرة يستخدم النظام سعر الصرف الموجود في الإعدادات، ويحفظ السعر المستعمل مع الحركة.',
    symbol: '$',
    points: ['صندوق واحد برصيد دولار ورصيد ليرة', 'تغيير السعر يؤثر في الحركات الجديدة فقط', 'المبلغ الأصلي يبقى محفوظًا'],
  },
  {
    kicker: 'قبل أن تبدأ',
    title: 'ابدأ ببيانات شركتك',
    description: 'تُحفظ كل الحركات في قاعدة البيانات المركزية وتظهر لك بنفس الأرقام عند تسجيل الدخول من أي جهاز.',
    symbol: '✓',
    points: ['ابدأ بإضافة عميل ثم اشتراكه', 'زر دليل الاستخدام يعيد هذه الجولة بأي وقت', 'الحفظ مركزي ومحمي بكلمة المرور'],
  },
]

function decimal(value: string | number | undefined) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function subtractMoney(left: string, right: string) {
  try {
    const difference = decimalToUnits(left) - decimalToUnits(right)
    return unitsToDecimal(difference > 0n ? difference : 0n)
  } catch {
    return '0'
  }
}

function hasPositiveMoney(value: string) {
  try {
    return decimalToUnits(value) > 0n
  } catch {
    return false
  }
}

function businessDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Damascus',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function requestReversalReason(subject: string) {
  const reason = window.prompt(
    `أدخل سبب عكس ${subject}. سيبقى السجل الأصلي محفوظًا وسيُنشأ قيد معاكس دائم للتدقيق.`,
  )?.trim()
  if (!reason) return null
  if (reason.length < 3) {
    window.alert('اكتب سببًا واضحًا من 3 محارف على الأقل.')
    return null
  }
  if (reason.length > 1_000) {
    window.alert('سبب العكس طويل جدًا. الحد الأقصى 1000 محرف.')
    return null
  }
  return window.confirm('تأكيد العكس؟ لا يمكن عكس قيد العكس نفسه.') ? reason : null
}

function money(value: string | number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(decimal(value))
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    repeat: <><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 013-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 01-3 3H3"/></>,
    users: <><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></>,
    in: <><path d="M12 19V5"/><path d="M5 12l7 7 7-7"/></>,
    out: <><path d="M12 5v14"/><path d="M19 12l-7-7-7 7"/></>,
    briefcase: <><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2M3 12h18"/></>,
    wallet: <><path d="M20 7V5a2 2 0 00-2-2H5a3 3 0 000 6h15v12H5a3 3 0 01-3-3V6"/><path d="M16 13h2"/></>,
    safe: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="4"/><path d="M12 8v4l3 2M7 3v3M17 3v3"/></>,
    chart: <><path d="M3 3v18h18"/><path d="M7 16l4-5 4 3 5-7"/></>,
    gear: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0015 19.4a1.7 1.7 0 00-1 .6 1.7 1.7 0 00-.4 1.1V21H9v-.1A1.7 1.7 0 008 19.4a1.7 1.7 0 00-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 003.6 15a1.7 1.7 0 00-.6-1 1.7 1.7 0 00-1.1-.4H2V9h.1A1.7 1.7 0 003.6 8a1.7 1.7 0 00-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 008 3.6a1.7 1.7 0 001-.6 1.7 1.7 0 00.4-1.1V2H14v.1A1.7 1.7 0 0015 3.6a1.7 1.7 0 001.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0019.4 8c.16.39.4.73.72 1 .3.25.7.4 1.1.4H22V14h-.1a1.7 1.7 0 00-1.5 1z"/></>,
  }
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function Status({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'good' | 'warn' | 'bad' | 'neutral' }) {
  return <span className={`status ${tone}`}>{children}</span>
}

function receivableStatusTone(status: ClientRecord['status']): 'good' | 'warn' | 'bad' {
  if (status === 'مسدد') return 'good'
  if (status === 'متأخر') return 'bad'
  return 'warn'
}

function Kpi({ label, value, sub, tone = 'dark' }: { label: string; value: string; sub: string; tone?: 'dark' | 'orange' | 'green' | 'red' }) {
  return (
    <article className={`kpi ${tone}`}>
      <div className="kpi-label">{label}</div>
      <strong>{value}</strong>
      <small>{sub}</small>
    </article>
  )
}

function Toolbar({ onExport, onApply }: { onExport?: () => void; onApply?: () => void }) {
  return (
    <div className="toolbar">
      <label><span>من تاريخ</span><input type="date" defaultValue="2026-08-01" /></label>
      <label><span>إلى تاريخ</span><input type="date" defaultValue="2026-08-31" /></label>
      <label><span>الفترة السريعة</span><select defaultValue="month"><option value="month">هذا الشهر</option><option>الربع الحالي</option><option>هذه السنة</option></select></label>
      <button className="btn primary" onClick={onApply}>تطبيق</button>
      <button className="btn ghost" onClick={onExport}>تصدير التقرير</button>
    </div>
  )
}

/* eslint-disable @typescript-eslint/no-unused-vars -- retained prototype screens, not rendered in local mode */
function Reports() {
  const [tab, setTab] = useState<'performance' | 'receivables' | 'expenses'>('performance')
  const [notice, setNotice] = useState('')
  const totalExpenses = expenses.reduce((sum, item) => sum + item.amount, 0)
  return (
    <>
      <PageHead eyebrow="تقارير الإدارة" title="التقارير والتحليل" description="صورة مالية واضحة تساعدك على اتخاذ القرار بسرعة." action="تقرير جديد" />
      {notice && <div className="notice">{notice}</div>}
      <Toolbar onApply={() => { setNotice('تم تطبيق فترة التقرير على البيانات التجريبية.'); setTimeout(() => setNotice(''), 3500) }} onExport={() => { setNotice('تم تجهيز معاينة التصدير. ربط ملف Excel سيتم في مرحلة قاعدة البيانات.'); setTimeout(() => setNotice(''), 4500) }} />
      <section className="kpi-grid five">
        <Kpi label="إجمالي الدخل" value="$10,450" sub="↑ 14.6% عن الشهر السابق" tone="green" />
        <Kpi label="إجمالي المصروف" value="$6,180" sub="59.1% من الدخل" tone="red" />
        <Kpi label="صافي الربح" value="$4,270" sub="هامش ربح 40.9%" tone="orange" />
        <Kpi label="ذمم العملاء" value="$2,350" sub="على 3 عملاء" />
        <Kpi label="قيمة العقود الشهرية" value="$8,900" sub="12 اشتراكًا فعالًا" />
      </section>

      <div className="tabs" role="tablist">
        <button className={tab === 'performance' ? 'active' : ''} onClick={() => setTab('performance')}>الأداء المالي</button>
        <button className={tab === 'receivables' ? 'active' : ''} onClick={() => setTab('receivables')}>الذمم والتحصيل</button>
        <button className={tab === 'expenses' ? 'active' : ''} onClick={() => setTab('expenses')}>المصروفات</button>
      </div>

      {tab === 'performance' && <>
        <section className="panel table-panel">
          <PanelTitle title="الأداء الشهري" meta="آخر 5 أشهر" />
          <div className="table-scroll"><table><thead><tr><th>الشهر</th><th>الدخل</th><th>المصروف</th><th>صافي الربح</th><th>هامش الربح</th><th>نسبة التحصيل</th></tr></thead><tbody>
            {months.map(row => <tr key={row.month}><td className="strong">{row.month}</td><td className="positive">{money(row.income)}</td><td className="negative">{money(row.expense)}</td><td className="strong">{money(row.profit)}</td><td>{Math.round(row.profit / row.income * 100)}%</td><td><div className="progress"><span style={{ width: `${row.collection}%` }} /></div><b>{row.collection}%</b></td></tr>)}
          </tbody></table></div>
        </section>
        <div className="split-grid">
          <section className="panel chart-panel"><PanelTitle title="اتجاه الدخل والمصروف" meta="بالدولار" /><BarChart /></section>
          <section className="panel chart-panel"><PanelTitle title="توزيع المصروفات" meta={money(totalExpenses)} /><ExpenseBars total={totalExpenses} /></section>
        </div>
      </>}

      {tab === 'receivables' && <Receivables />}
      {tab === 'expenses' && <section className="panel"><PanelTitle title="المصروفات حسب التصنيف" meta="آب 2026" /><ExpenseBars total={totalExpenses} detailed /></section>}
    </>
  )
}

function BarChart() {
  return <div className="mini-chart">
    {months.map((m, i) => <div className="month-bars" key={m.month}><div className="bars"><span className="bar income" style={{ height: `${m.income / 115}px` }} /><span className="bar expense" style={{ height: `${m.expense / 115}px` }} /></div><small>{['نيسان','أيار','حزيران','تموز','آب'][i]}</small></div>)}
    <div className="legend"><span><i className="dot orange"/>الدخل</span><span><i className="dot dark"/>المصروف</span></div>
  </div>
}

function ExpenseBars({ total, detailed = false }: { total: number; detailed?: boolean }) {
  return <div className={detailed ? 'expense-list detailed' : 'expense-list'}>{expenses.map(item => <div className="expense-row" key={item.category}><div className="expense-top"><span><i className="dot" style={{ background: item.color }}/>{item.category}</span><b>{money(item.amount)}</b></div><div className="expense-track"><span style={{ width: `${item.amount / total * 100}%`, background: item.color }} /></div>{detailed && <small>{(item.amount / total * 100).toFixed(1)}% من إجمالي المصروفات</small>}</div>)}</div>
}

function Receivables() {
  const debtors = clients.filter(client => client.due > 0)
  return <section className="panel table-panel"><PanelTitle title="المبالغ المتبقية على العملاء" meta={`${debtors.length} عملاء`} /><div className="table-scroll"><table><thead><tr><th>العميل</th><th>قيمة الاشتراك</th><th>المدفوع هذا الشهر</th><th>الرصيد المتراكم</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{debtors.map(client => <tr key={client.name}><td className="strong">{client.name}</td><td>{money(client.monthly)}</td><td>{money(client.paid)}</td><td className="negative strong">{money(client.due)}</td><td><Status tone={client.status === 'متأخر' ? 'bad' : 'warn'}>{client.status}</Status></td><td><button className="table-action" onClick={() => openAction('الحساب الشهري', client.name)}>عرض الحساب</button></td></tr>)}</tbody></table></div></section>
}

function PageHead({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: string }) {
  return <header className="page-head"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action && <button className="btn primary plus" onClick={() => openAction(action)}>+ {action}</button>}</header>
}

function PanelTitle({ title, meta }: { title: string; meta?: string }) {
  return <div className="panel-title"><h2>{title}</h2>{meta && <span>{meta}</span>}</div>
}

function Dashboard({ changeView }: { changeView: (view: View) => void }) {
  return <>
    <PageHead eyebrow="اليوم 17 أيلول 2026" title="صباح الخير 👋" description="هذه أهم أرقام الشركة حتى هذه اللحظة." />
    <section className="kpi-grid four">
      <Kpi label="دخل الشهر" value="$10,450" sub="من 18 حركة" tone="green" /><Kpi label="مصروف الشهر" value="$6,180" sub="من 24 حركة" tone="red" /><Kpi label="صافي الربح" value="$4,270" sub="40.9% هامش الربح" tone="orange" /><Kpi label="المطلوب تحصيله" value="$2,350" sub="3 عملاء متأخرين" />
    </section>
    <div className="split-grid dashboard-grid">
      <section className="panel"><PanelTitle title="إجراءات سريعة" meta="الأكثر استخدامًا" /><div className="quick-actions"><button onClick={() => changeView('income')}><b>+</b><span>تسجيل دخل</span><small>اشتراك، إعلان أو دخل خارجي</small></button><button onClick={() => changeView('expenses')}><b>−</b><span>تسجيل مصروف</span><small>مصروف جديد في الصندوق</small></button><button onClick={() => changeView('subscriptions')}><b>✓</b><span>تحصيل اشتراك</span><small>تسديد كامل أو جزئي</small></button><button onClick={() => changeView('reports')}><b>↗</b><span>عرض التقارير</span><small>تحليل أداء الفترة</small></button></div></section>
      <section className="panel"><PanelTitle title="تنبيهات تحتاج انتباهك" meta="3 عناصر" /><div className="alerts"><div><i className="danger"/><span><b>إيوان</b><small>رصيد متأخر بقيمة $1,300</small></span><button onClick={() => changeView('subscriptions')}>عرض</button></div><div><i className="warning"/><span><b>راتبان جاهزان للدفع</b><small>إجمالي صافي $1,245</small></span><button onClick={() => changeView('payroll')}>عرض</button></div><div><i className="info"/><span><b>سعر الصرف</b><small>آخر تحديث منذ 12 يومًا</small></span><button onClick={() => changeView('settings')}>تحديث</button></div></div></section>
    </div>
    <Receivables />
  </>
}

function Subscriptions() {
  const [search, setSearch] = useState('')
  const filtered = clients.filter(c => c.name.includes(search))
  return <><PageHead eyebrow="إدارة الإيراد المتكرر" title="الاشتراكات الشهرية" description="الفواتير الشهرية والتحصيل والرصيد المرحّل لكل عقد عميل." action="اشتراك جديد" />
    <div className="concept-note"><b>الاشتراك وصافي الشهر</b><span>نسجّل التكلفة من «المصروفات» أو «الذمم» ونربطها بالعميل، ثم نعرض هنا التكاليف المباشرة وصافي الاشتراك تلقائيًا. لا يوجد إدخال مصروف مكرر داخل الاشتراك.</span></div>
    <div className="summary-strip"><span><b>12</b> اشتراكًا فعالًا</span><span><b>$8,900</b> قيمة شهرية</span><span><b>91%</b> نسبة التحصيل</span><span className="danger-text"><b>$2,350</b> متبقي للتحصيل</span></div>
    <section className="panel table-panel"><div className="list-tools"><div><h2>حسابات الاشتراكات الشهرية</h2><span>{filtered.length} سجلات تجريبية</span></div><input className="search" placeholder="ابحث باسم العميل…" value={search} onChange={e => setSearch(e.target.value)} /></div><div className="table-scroll"><table><thead><tr><th>العميل</th><th>الباقة</th><th>الاشتراك الشهري</th><th>التكاليف المباشرة</th><th>صافي الاشتراك</th><th>مدفوع آب</th><th>الرصيد المتبقي</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{filtered.map(c => { const profitability = clientProfitability.find(row => row.client === c.name); const directCosts = profitability ? profitability.paidExpenses + profitability.openLiabilities : 0; const net = c.monthly - directCosts; return <tr key={c.name}><td className="strong">{c.name}</td><td>{c.package}</td><td>{money(c.monthly)}</td><td className={directCosts ? 'negative' : ''}>{directCosts ? `-${money(directCosts)}` : money(0)}</td><td className={net >= 0 ? 'positive strong' : 'negative strong'}>{money(net)}</td><td className="positive">{money(c.paid)}</td><td className={c.due ? 'negative strong' : ''}>{money(c.due)}</td><td><Status tone={receivableStatusTone(c.status)}>{c.status}</Status></td><td><div className="row-actions"><button className="table-action" onClick={() => openAction('الحساب الشهري', c.name)}>عرض الحساب والتكاليف</button><button className="table-action primary-action" onClick={() => void downloadInvoiceXlsx(c, clients.findIndex(client => client.name === c.name))}>فاتورة Excel</button></div></td></tr> })}</tbody></table></div></section></>
}

function Clients() {
  return <><PageHead eyebrow="دليل العملاء" title="العملاء" description="بيانات التواصل والملف العام والخدمات المرتبطة بكل عميل." action="عميل جديد"/>
    <div className="concept-note"><b>ما الفرق عن الاشتراكات؟</b><span>«العميل» هو الشخص أو الشركة وبياناته. «الاشتراك» هو العقد الشهري والفواتير والدفعات التابعة لهذا العميل.</span></div>
    <section className="panel table-panel"><PanelTitle title="قائمة العملاء" meta={`${clients.length} عملاء تجريبيين`} /><div className="table-scroll"><table><thead><tr><th>اسم العميل</th><th>الخدمة</th><th>قيمة العقد</th><th>الرصيد الحالي</th><th>حالة العقد</th><th>آخر دفعة</th><th>إجراء</th></tr></thead><tbody>{clients.map((c, i) => <tr key={c.name}><td className="strong client-name"><span>{c.name.slice(0,1)}</span>{c.name}</td><td>{c.package}</td><td>{money(c.monthly)}</td><td className={c.due ? 'negative strong' : 'positive'}>{c.due ? money(c.due) : 'لا يوجد'}</td><td><Status tone="good">فعال</Status></td><td>{i % 2 ? '2026-08-10' : '2026-08-01'}</td><td><button className="table-action" onClick={() => openAction('ملف العميل', c.name)}>فتح ملف العميل</button></td></tr>)}</tbody></table></div></section>
    <section className="panel table-panel"><PanelTitle title="صافي العملاء لهذا الشهر" meta="الدخل − المصروف المدفوع − الذمم المفتوحة"/><div className="table-scroll"><table><thead><tr><th>العميل</th><th>الدخل المسجل</th><th>مصروفات مدفوعة مرتبطة</th><th>ذمم غير مدفوعة</th><th>صافي العميل المتوقع</th></tr></thead><tbody>{clientProfitability.map(row => { const net = row.revenue - row.paidExpenses - row.openLiabilities; return <tr key={row.client}><td className="strong">{row.client}</td><td className="positive">{money(row.revenue)}</td><td className="negative">-{money(row.paidExpenses)}</td><td className="negative">-{money(row.openLiabilities)}</td><td className={net >= 0 ? 'positive strong' : 'negative strong'}>{money(net)}</td></tr> })}</tbody></table></div></section>
  </>
}

function Income() {
  return <><PageHead eyebrow="حركة الصندوق الداخلة" title="الدخل" description="اختر العميل عند دفع الاشتراك ليُخصم المبلغ تلقائيًا من أقدم فاتورة غير مسددة." action="تسجيل دخل"/><div className="concept-note"><b>دفع الاشتراك</b><span>اختر «دفعة اشتراك» ثم العميل. سيعرض النظام الرصيد قبل الدفعة وكيف سيتوزع المبلغ على أقدم شهر مستحق.</span></div><section className="category-cards"><article><span>01</span><b>دفعة اشتراك</b><small>تُخصم تلقائيًا من أقدم فاتورة للعميل</small></article><article><span>02</span><b>دخل عميل إضافي</b><small>يرتبط بالعميل لكنه لا يسدد الاشتراك</small></article><article><span>03</span><b>دخل تشغيل إعلانات</b><small>مبلغ مستقل، لا يحتاج عميلًا</small></article><article><span>04</span><b>دخل خارجي</b><small>دخل غير مرتبط بعميل أو إعلان</small></article></section><section className="panel table-panel"><PanelTitle title="آخر حركات الدخل" meta="بيانات تجريبية"/><div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>المصدر</th><th>نوع الدخل</th><th>المبلغ الأصلي</th><th>المبلغ بالدولار</th><th>البيان</th></tr></thead><tbody>{incomeRows.map((r,i)=><tr key={i}><td>{r.date}</td><td className="strong">{r.source}</td><td>{r.type}</td><td>{r.original}</td><td className="positive strong">{r.usd}</td><td>{r.note}</td></tr>)}</tbody></table></div></section></>
}

function ExpensesPage() {
  const [tab, setTab] = useState<'overview' | 'linked' | 'fixed' | 'services'>('overview')
  return <><PageHead eyebrow="حركة الصندوق الخارجة" title="المصروفات" description="الحركات اليومية والمصاريف الثابتة واشتراكات خدمات الشركة." action="تسجيل مصروف"/>
    <div className="concept-note"><b>صافي العميل</b><span>يمكن ربط أي مصروف بعميل، أو تركه «مصروفًا عامًا». المصروف المرتبط يدخل مباشرة في احتساب صافي ربح العميل.</span></div>
    <div className="tabs expense-tabs"><button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>ملخص المصروفات</button><button className={tab === 'linked' ? 'active' : ''} onClick={() => setTab('linked')}>مرتبطة بعميل</button><button className={tab === 'fixed' ? 'active' : ''} onClick={() => setTab('fixed')}>المصاريف الثابتة</button><button className={tab === 'services' ? 'active' : ''} onClick={() => setTab('services')}>اشتراكات الخدمات</button></div>
    {tab === 'overview' && <><section className="kpi-grid four"><Kpi label="مصروفات الشهر" value="$6,180" sub="24 حركة" tone="red"/><Kpi label="الرواتب" value="$3,100" sub="50.2% من المصروف"/><Kpi label="المصاريف الثابتة" value="$870" sub="إيجار وخدمات"/><Kpi label="اشتراكات الخدمات" value="$130" sub="برامج واستضافة"/></section><section className="panel"><PanelTitle title="تصنيف المصروفات" meta="آب 2026"/><ExpenseBars total={6180} detailed/></section></>}
    {tab === 'linked' && <section className="panel table-panel"><div className="list-tools"><div><h2>مصروفات مرتبطة بالعملاء</h2><span>تظهر ضمن صافي كل عميل</span></div><button className="btn primary" onClick={() => openAction('تسجيل مصروف مرتبط')}>+ تسجيل مصروف مرتبط</button></div><div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>العميل</th><th>التصنيف</th><th>البيان</th><th>المبلغ</th></tr></thead><tbody>{linkedExpenses.map(item => <tr key={`${item.date}-${item.client}`}><td>{item.date}</td><td className="strong">{item.client}</td><td>{item.category}</td><td>{item.description}</td><td className="negative strong">-{money(item.amount)}</td></tr>)}</tbody></table></div></section>}
    {tab === 'fixed' && <section className="panel table-panel"><div className="list-tools"><div><h2>قائمة المصاريف الثابتة</h2><span>تتكرر شهريًا ولا تُسجّل كمدفوعة تلقائيًا</span></div><button className="btn primary" onClick={() => openAction('مصروف ثابت جديد')}>+ إضافة مصروف ثابت</button></div><div className="table-scroll"><table><thead><tr><th>المصروف</th><th>التصنيف</th><th>المبلغ الشهري</th><th>يوم الاستحقاق</th><th>حالة هذا الشهر</th><th>إجراء</th></tr></thead><tbody>{fixedExpenses.map(item => <tr key={item.name}><td className="strong">{item.name}</td><td>{item.category}</td><td>{money(item.amount)}</td><td>يوم {item.dueDay}</td><td><Status tone={item.status === 'مدفوع' ? 'good' : 'warn'}>{item.status}</Status></td><td><button className="table-action" disabled={item.status === 'مدفوع'} onClick={() => openAction('دفع مصروف ثابت', item.name)}>{item.status === 'مدفوع' ? 'تم الدفع' : 'تسجيل الدفع'}</button></td></tr>)}</tbody></table></div></section>}
    {tab === 'services' && <section className="panel table-panel"><div className="list-tools"><div><h2>اشتراكات خدمات الشركة</h2><span>برامج، استضافة، أدوات وخدمات شهرية</span></div><button className="btn primary" onClick={() => openAction('اشتراك خدمة جديد')}>+ إضافة اشتراك خدمة</button></div><div className="table-scroll"><table><thead><tr><th>الخدمة</th><th>التصنيف</th><th>القيمة</th><th>الدورة</th><th>التجديد القادم</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{serviceSubscriptions.map(item => <tr key={item.name}><td className="strong">{item.name}</td><td>{item.category}</td><td>{money(item.amount)}</td><td>{item.cycle}</td><td>{item.next}</td><td><Status tone="good">{item.status}</Status></td><td><button className="table-action" onClick={() => openAction('تسجيل دفع اشتراك خدمة', item.name)}>تسجيل الدفع</button></td></tr>)}</tbody></table></div></section>}
  </>
}

function Liabilities() {
  const [tab, setTab] = useState<'open' | 'all' | 'settled'>('open')
  const shown = liabilities.filter(item => tab === 'all' || (tab === 'open' ? item.total > item.paid : item.total === item.paid))
  const total = liabilities.reduce((sum, item) => sum + item.total, 0)
  const paid = liabilities.reduce((sum, item) => sum + item.paid, 0)
  const remaining = total - paid
  return <><PageHead eyebrow="مبالغ علينا لم تُدفع بعد" title="الذمم المستحقة" description="التزامات للمصورين والمودلز والموردين والمستقلين، مع إمكانية ربطها بعميل." action="إضافة ذمة"/>
    <div className="concept-note"><b>كيف تعمل الذمة؟</b><span>تدخل في تكلفة العميل المتوقعة فور تسجيلها، لكنها لا تخصم من الصندوق ولا تظهر كمصروف مدفوع إلا عند تسجيل دفعة فعلية.</span></div>
    <section className="kpi-grid four"><Kpi label="إجمالي الذمم" value={money(total)} sub={`${liabilities.length} قيود`}/><Kpi label="المدفوع منها" value={money(paid)} sub="خرج فعلي من الصندوق" tone="green"/><Kpi label="المتبقي علينا" value={money(remaining)} sub="بانتظار الدفع" tone="red"/><Kpi label="مرتبطة بعملاء" value="4" sub="تدخل في صافي العميل" tone="orange"/></section>
    <div className="tabs"><button className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>المفتوحة</button><button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>الكل</button><button className={tab === 'settled' ? 'active' : ''} onClick={() => setTab('settled')}>المسددة</button></div>
    <section className="panel table-panel"><PanelTitle title="سجل الذمم" meta={`${shown.length} قيود`}/><div className="table-scroll"><table><thead><tr><th>المرجع</th><th>التاريخ</th><th>المستفيد</th><th>النوع</th><th>العميل المرتبط</th><th>البيان</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th><th>الاستحقاق</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{shown.map(item => { const due = item.total - item.paid; return <tr key={item.id}><td>{item.id}</td><td>{item.date}</td><td className="strong">{item.party}</td><td>{item.kind}</td><td><Status>{item.client}</Status></td><td>{item.description}</td><td>{money(item.total)}</td><td className="positive">{money(item.paid)}</td><td className={due ? 'negative strong' : 'positive strong'}>{money(due)}</td><td>{item.due}</td><td><Status tone={due ? 'warn' : 'good'}>{due ? 'مفتوحة' : 'مسددة'}</Status></td><td><button className="table-action" disabled={!due} onClick={() => openAction('دفع ذمة', item.party)}>{due ? 'تسجيل دفعة' : 'تم السداد'}</button></td></tr> })}</tbody></table></div></section>
  </>
}

function Payroll() {
  return <><PageHead eyebrow="الموظفون والرواتب" title="رواتب آب 2026" description="الراتب الأساسي + المكافآت − الحسومات − السلف = صافي الراتب." action="إضافة موظف"/><div className="summary-strip"><span><b>{money(2690)}</b> الرواتب الأساسية</span><span><b>{money(190)}</b> إضافي ومكافآت</span><span><b>{money(30)}</b> الحسومات</span><span><b>{money(150)}</b> سلف موظفين</span><span><b>{money(2700)}</b> صافي الدفع</span></div><section className="panel table-panel"><PanelTitle title="مسير الرواتب" meta="يمكن إضافة مكافأة قبل دفع كل راتب"/><div className="table-scroll"><table><thead><tr><th>الموظف</th><th>الراتب الأساسي</th><th>إضافي / مكافأة</th><th>الحسومات</th><th>حسم السلفة</th><th>صافي الراتب</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{payroll.map(p => <tr key={p.name}><td className="strong">{p.name}</td><td>{money(p.base)}</td><td className="positive strong">+{money(p.bonus)}</td><td className="negative">-{money(p.deductions)}</td><td className="negative">-{money(p.loan)}</td><td className="strong">{money(p.net)}</td><td><Status tone={p.status==='مدفوع'?'good':'warn'}>{p.status}</Status></td><td><div className="row-actions"><button className="table-action" onClick={() => openAction('إضافة مكافأة', p.name)}>إضافة مكافأة</button><button className="table-action primary-action" disabled={p.status==='مدفوع'} onClick={() => openAction('دفع راتب', p.name)}>{p.status==='مدفوع'?'تم الدفع':'دفع الراتب'}</button></div></td></tr>)}</tbody></table></div></section></>
}

function Advances() {
  return <><PageHead eyebrow="خارج حساب المصروف" title="السلف والسحوبات" description="سلف الموظفين وسحوبات المالك أو الشريك تظهر كذمم مستقلة." action="تسجيل سلفة"/><section className="kpi-grid three"><Kpi label="سلف الموظفين" value="$430" sub="على 3 موظفين"/><Kpi label="سحوبات المالك" value="$1,200" sub="الرصيد المفتوح"/><Kpi label="المسدّد هذا الشهر" value="$250" sub="تسويات وليست مصروفات" tone="green"/></section><section className="panel table-panel"><PanelTitle title="سجل السلف" meta="بيانات تجريبية"/><div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>الاسم</th><th>النوع</th><th>المبلغ</th><th>المسدّد</th><th>المتبقي</th><th>الحالة</th></tr></thead><tbody><tr><td>2026-08-03</td><td className="strong">أحمد</td><td>سلفة موظف</td><td>$300</td><td>$100</td><td className="negative strong">$200</td><td><Status tone="warn">مفتوحة</Status></td></tr><tr><td>2026-08-07</td><td className="strong">المالك</td><td>سحب مالك</td><td>$1,200</td><td>$0</td><td className="negative strong">$1,200</td><td><Status tone="warn">مفتوحة</Status></td></tr></tbody></table></div></section></>
}

function Cashbox() {
  return <><PageHead eyebrow="صندوق واحد — عملتان" title="الصندوق" description="الرصيد الفعلي محفوظ بالدولار والليرة كلٌ على حدة." action="تسوية صندوق"/><section className="cash-cards"><article><span>رصيد الدولار</span><strong>$7,840.00</strong><small>دخل $10,450 − خرج $2,610</small></article><article><span>رصيد الليرة السورية</span><strong>4,850,000 ل.س</strong><small>ما يعادل $404.17 حسب السعر الحالي</small></article><article className="total"><span>القيمة الإجمالية التقريبية</span><strong>$8,244.17</strong><small>للعرض فقط — لا يغيّر أرصدة العملات</small></article></section><section className="panel"><PanelTitle title="حركة الرصيد خلال الشهر" meta="آخر تحديث اليوم"/><BarChart/></section></>
}

function Settings() {
  const [rate, setRate] = useState('12000')
  const [saved, setSaved] = useState(false)
  const converted = useMemo(() => Number(rate) > 0 ? (1_000_000 / Number(rate)).toFixed(2) : '0.00', [rate])
  return <><PageHead eyebrow="إعدادات النظام" title="الإعدادات" description="تحكّم بسعر الصرف والخيارات الأساسية للنظام."/><div className="settings-grid"><section className="panel settings-card"><PanelTitle title="سعر الصرف" meta="يؤثر في القيود الجديدة فقط"/><p>حدد عدد الليرات السورية المقابلة لدولار أمريكي واحد.</p><label className="big-input"><span>1 دولار أمريكي =</span><input inputMode="numeric" value={rate} onChange={e => { setRate(e.target.value.replace(/\D/g,'')); setSaved(false) }}/><b>ل.س</b></label><div className="conversion-example">مثال: 1,000,000 ل.س = <b>${converted}</b></div><button className="btn primary" onClick={() => setSaved(true)}>{saved ? 'تم الحفظ ✓' : 'حفظ سعر الصرف'}</button></section><section className="panel settings-card"><PanelTitle title="قواعد العملات"/><ul className="rules"><li>الدولار هو عملة التقارير الأساسية.</li><li>يُحفظ المبلغ الأصلي كما أُدخل.</li><li>يُحفظ سعر الصرف المستخدم مع كل حركة.</li><li>تغيير السعر لا يعيد حساب الحركات القديمة.</li></ul></section><section className="panel settings-card"><PanelTitle title="بيانات الشركة"/><label className="field"><span>اسم الشركة</span><input defaultValue="OZMO"/></label><label className="field"><span>نوع الإيصالات</span><select defaultValue="internal"><option value="internal">إيصالات داخلية فقط</option></select></label><label className="field"><span>المستخدمون</span><select defaultValue="owner"><option value="owner">المالك فقط</option></select></label></section></div></>
}

function ActionDialog({ request, onClose }: { request: ActionRequest; onClose: () => void }) {
  const [saved, setSaved] = useState(false)
  const [incomeType, setIncomeType] = useState(request.action === 'تسجيل دفعة اشتراك' ? 'دفعة اشتراك' : 'دفعة اشتراك')
  const [selectedClient, setSelectedClient] = useState(request.subject ?? '')
  const [linkedClient, setLinkedClient] = useState('')
  const [amount, setAmount] = useState('')
  const isClientAccount = request.action === 'الحساب الشهري'
  const isClientFile = request.action === 'ملف العميل'
  const needsEmployee = request.action === 'إضافة مكافأة' || request.action === 'دفع راتب'
  const isIncome = request.action === 'تسجيل دخل' || request.action === 'تسجيل دفعة اشتراك'
  const isExpense = request.action.includes('مصروف') || request.action.includes('اشتراك خدمة')
  const isLiability = request.action === 'إضافة ذمة' || request.action === 'دفع ذمة'
  const subscriptionPayment = isIncome && incomeType === 'دفعة اشتراك'
  const clientIncome = isIncome && (incomeType === 'دفعة اشتراك' || incomeType === 'دخل عميل إضافي')
  const selectedClientRecord = clients.find(client => client.name === selectedClient)
  const amountNumber = Number(amount) || 0
  const balanceBefore = selectedClientRecord?.due ?? 0
  const balanceAfter = Math.max(balanceBefore - amountNumber, 0)
  const title = request.subject ? `${request.action} — ${request.subject}` : request.action

  return <div className="action-overlay" role="presentation">
    <section className="action-dialog" role="dialog" aria-modal="true" aria-labelledby="action-title">
      <button className="guide-close" onClick={onClose} aria-label="إغلاق النافذة">×</button>
      <header><span className="eyebrow">عملية تجريبية</span><h2 id="action-title">{title}</h2><p>{isClientAccount ? 'تفاصيل الفواتير والدفعات والمتبقي شهرًا بشهر.' : isClientFile ? 'البيانات الأساسية والخدمة والحالة المالية للعميل.' : 'أدخل البيانات ثم اضغط حفظ. لن تنتقل إلى قاعدة بيانات حقيقية في هذه المرحلة.'}</p></header>

      {isClientAccount ? <div className="account-preview"><div className="account-summary"><span><small>الاشتراك الشهري</small><b>$650</b></span><span><small>إجمالي المتبقي</small><b className="negative">$1,300</b></span><span><small>حالة العقد</small><b>فعال</b></span></div><div className="table-scroll"><table><thead><tr><th>الشهر</th><th>قيمة الفاتورة</th><th>المدفوع</th><th>المتبقي</th><th>الحالة</th></tr></thead><tbody><tr><td>تموز 2026</td><td>$650</td><td>$0</td><td className="negative">$650</td><td><Status tone="bad">متأخر</Status></td></tr><tr><td>آب 2026</td><td>$650</td><td>$0</td><td className="negative">$650</td><td><Status tone="bad">متأخر</Status></td></tr></tbody></table></div><button className="btn primary" onClick={() => openAction('تسجيل دفعة اشتراك', request.subject)}>تسجيل دفعة</button></div>
      : isClientFile ? <div className="profile-preview"><div className="profile-avatar">{request.subject?.slice(0, 1)}</div><dl><div><dt>اسم العميل</dt><dd>{request.subject}</dd></div><div><dt>الخدمة الحالية</dt><dd>إدارة محتوى</dd></div><div><dt>رقم الهاتف</dt><dd dir="ltr">+963 9xx xxx xxx</dd></div><div><dt>حالة العميل</dt><dd><Status tone="good">فعال</Status></dd></div></dl><button className="btn ghost" onClick={() => openAction('الحساب الشهري', request.subject)}>فتح الحساب الشهري</button></div>
      : saved ? <div className="saved-state"><span>✓</span><h3>تم تسجيل العملية تجريبيًا</h3><p>{subscriptionPayment && selectedClient ? `تم توزيع ${money(amountNumber)} على أقدم فاتورة مستحقة للعميل ${selectedClient}. الرصيد المتبقي بعد الدفعة ${money(balanceAfter)}.` : 'عند ربط قاعدة البيانات ستُحفظ العملية وتظهر مباشرة في الجداول والتقارير.'}</p><button className="btn primary" onClick={onClose}>تم</button></div>
      : <form className="action-form" onSubmit={event => { event.preventDefault(); setSaved(true) }}>
          {request.subject && !isIncome && <label className="field"><span>{needsEmployee ? 'الموظف' : isLiability ? 'المستفيد' : 'البند'}</span><input value={request.subject} readOnly/></label>}
          {request.action === 'عميل جديد' && <><label className="field"><span>اسم العميل</span><input required placeholder="اسم الشخص أو الشركة"/></label><label className="field"><span>رقم الهاتف</span><input dir="ltr" placeholder="+963"/></label></>}
          {request.action === 'اشتراك جديد' && <><label className="field"><span>العميل</span><select required defaultValue=""><option value="" disabled>اختر العميل</option>{clients.map(c => <option key={c.name}>{c.name}</option>)}</select></label><label className="field"><span>الخدمة أو الباقة</span><input required placeholder="مثال: إدارة كاملة"/></label></>}
          {request.action === 'إضافة موظف' && <><label className="field"><span>اسم الموظف</span><input required/></label><label className="field"><span>الراتب الأساسي</span><input required type="number" min="0"/></label></>}
          {request.action === 'تسجيل سلفة' && <><label className="field"><span>نوع السلفة</span><select><option>سلفة موظف</option><option>سحب مالك أو شريك</option></select></label><label className="field"><span>الاسم</span><input required/></label></>}
          {isIncome && <><label className="field"><span>نوع الدخل</span><select value={incomeType} onChange={event => { setIncomeType(event.target.value); setSelectedClient('') }} disabled={request.action === 'تسجيل دفعة اشتراك'}><option>دفعة اشتراك</option><option>دخل عميل إضافي</option><option>دخل تشغيل إعلانات</option><option>دخل خارجي</option></select></label>{clientIncome ? <label className="field"><span>العميل</span><select required value={selectedClient} onChange={event => setSelectedClient(event.target.value)}><option value="" disabled>اختر من قائمة العملاء</option>{clients.map(c => <option key={c.name}>{c.name}</option>)}</select></label> : <label className="field"><span>المصدر — اختياري</span><input placeholder={incomeType === 'دخل تشغيل إعلانات' ? 'مثال: نسبة تشغيل الإعلانات' : 'مثال: مشروع تصميم خارجي'}/></label>}</>}
          {isExpense && !request.subject && <><label className="field"><span>اسم البند</span><input required placeholder={request.action.includes('خدمة') ? 'مثال: Adobe Creative Cloud' : 'مثال: إيجار المكتب'}/></label><label className="field"><span>التصنيف</span><select><option>أجار</option><option>خدمات</option><option>برامج</option><option>استضافة</option><option>تشغيل</option><option>أخرى</option></select></label></>}
          {isExpense && <label className="field full"><span>مرتبط بعميل — اختياري</span><select value={linkedClient} onChange={event => setLinkedClient(event.target.value)}><option value="">مصروف عام — غير مرتبط بعميل</option>{clients.map(c => <option key={c.name}>{c.name}</option>)}</select><small className="field-help">{linkedClient ? `سيظهر هذا المصروف ضمن صافي العميل ${linkedClient}.` : 'اتركه عامًا إذا كان المصروف يخص الشركة ككل.'}</small></label>}
          {request.action === 'إضافة ذمة' && <><label className="field"><span>اسم المستفيد</span><input required placeholder="اسم المصور أو المودل أو المورد"/></label><label className="field"><span>نوع المستفيد</span><select><option>مصور</option><option>مودل</option><option>مورد</option><option>مستقل</option><option>أخرى</option></select></label><label className="field full"><span>مرتبطة بعميل — اختياري</span><select value={linkedClient} onChange={event => setLinkedClient(event.target.value)}><option value="">ذمة عامة على الشركة</option>{clients.map(c => <option key={c.name}>{c.name}</option>)}</select></label></>}
          {request.action === 'تقرير جديد' && <label className="field full"><span>اسم التقرير</span><input required placeholder="مثال: تقرير الربع الثالث"/></label>}
          {!['عميل جديد', 'إضافة موظف', 'تقرير جديد'].includes(request.action) && <label className="field"><span>{request.action === 'إضافة مكافأة' ? 'قيمة المكافأة' : 'المبلغ'}</span><input required type="number" min="0" step="0.01" placeholder="0.00" value={amount} onChange={event => setAmount(event.target.value)}/></label>}
          {request.action === 'اشتراك جديد' && <label className="field"><span>القيمة الشهرية</span><input required type="number" min="0"/></label>}
          <label className="field"><span>العملة</span><select defaultValue="USD"><option value="USD">دولار USD</option><option value="SYP">ليرة سورية SYP</option></select></label>
          <label className="field"><span>{isLiability && request.action === 'إضافة ذمة' ? 'تاريخ الاستحقاق' : 'التاريخ'}</span><input type="date" defaultValue="2026-09-19"/></label>
          {subscriptionPayment && selectedClientRecord && <div className="allocation-preview full"><div><small>الاشتراك الشهري</small><b>{money(selectedClientRecord.monthly)}</b></div><div><small>الرصيد قبل الدفعة</small><b className={balanceBefore ? 'negative' : 'positive'}>{money(balanceBefore)}</b></div><div><small>التوزيع التلقائي</small><b>{balanceBefore ? (balanceBefore > selectedClientRecord.monthly ? 'أقدم شهر ثم الذي يليه' : 'أقدم شهر مستحق') : 'لا توجد فاتورة مستحقة'}</b></div><div><small>الرصيد بعد الدفعة</small><b className={balanceAfter ? 'negative' : 'positive'}>{money(balanceAfter)}</b></div>{balanceBefore === 0 && <p>لا توجد فاتورة اشتراك مستحقة لهذا العميل. استخدم «دخل عميل إضافي» إذا لم تكن الدفعة مقدّمة.</p>}</div>}
          <label className="field full"><span>ملاحظات</span><input placeholder="تفاصيل اختيارية"/></label>
          <div className="form-actions full"><button type="button" className="btn ghost" onClick={onClose}>إلغاء</button><button type="submit" className="btn primary">حفظ تجريبي</button></div>
        </form>}
    </section>
  </div>
}

/* eslint-enable @typescript-eslint/no-unused-vars */
function localTotals(data: FinanceSnapshot) {
  const income = data.incomes.reduce((sum, row) => sum + decimal(row.usd), 0)
  const expense = data.expenses.reduce((sum, row) => sum + decimal(row.usd), 0)
  const receivables = data.clients.reduce((sum, row) => sum + decimal(row.due), 0)
  return { income, expense, profit: income - expense, receivables }
}

function LocalDashboard({ changeView }: { changeView: (view: View) => void }) {
  const { data } = useFinance()
  const totals = localTotals(data)
  const debtors = data.clients.filter(client => decimal(client.due) > 0)
  return <>
    <PageHead eyebrow="منظومة الإدارة المالية" title="مرحبًا بك في OZMO Finance" description="البيانات محفوظة في قاعدة البيانات ومحدّثة لحظيًا." />
    <section className="kpi-grid four"><Kpi label="إجمالي الدخل" value={money(totals.income)} sub={`${data.incomes.length} حركة`} tone="green"/><Kpi label="إجمالي المصروف" value={money(totals.expense)} sub={`${data.expenses.length} حركة`} tone="red"/><Kpi label="صافي الربح" value={money(totals.profit)} sub="الدخل ناقص المصروف" tone="orange"/><Kpi label="المطلوب تحصيله" value={money(totals.receivables)} sub={`${debtors.length} عملاء`}/></section>
    <section className="panel"><PanelTitle title="ابدأ من هنا" meta="خطوات بسيطة"/><div className="quick-actions"><button onClick={() => changeView('clients')}><b>1</b><span>إضافة عميل</span><small>أنشئ ملف العميل أولًا</small></button><button onClick={() => changeView('subscriptions')}><b>2</b><span>إنشاء اشتراك</span><small>حدد الباقة والقيمة الشهرية</small></button><button onClick={() => changeView('income')}><b>3</b><span>تسجيل دخل</span><small>دفعة اشتراك أو دخل آخر</small></button><button onClick={() => changeView('reports')}><b>4</b><span>عرض التقارير</span><small>تُحسب من بياناتك تلقائيًا</small></button></div></section>
    <LocalReceivables/>
  </>
}

function LocalReceivables() {
  const { data } = useFinance()
  const rows = data.clients.filter(client => decimal(client.due) > 0)
  return <section className="panel table-panel"><PanelTitle title="المبالغ المتبقية على العملاء" meta={`${rows.length} عملاء`}/><div className="table-scroll"><table><thead><tr><th>العميل</th><th>قيمة الاشتراك</th><th>المدفوع</th><th>المتبقي</th><th>الحالة</th></tr></thead><tbody>{rows.length === 0 ? <EmptyTableRow columns={5}/> : rows.map(row => <tr key={row.id}><td className="strong">{row.name}</td><td>{money(row.monthly)}</td><td className="positive">{money(row.paid)}</td><td className="negative strong">{money(row.due)}</td><td><Status tone={row.status === 'متأخر' ? 'bad' : 'warn'}>{row.status}</Status></td></tr>)}</tbody></table></div></section>
}

function LocalSubscriptions() {
  const { data, runCommand, mutating } = useFinance()
  const [search, setSearch] = useState('')
  const rows = data.clients.filter(client => decimal(client.monthly) > 0 && client.name.includes(search))
  const value = rows.reduce((sum, row) => sum + decimal(row.monthly), 0)
  const due = rows.reduce((sum, row) => sum + decimal(row.due), 0)
  const archive = async (row: ClientDto) => {
    if (!row.subscriptionId) {
      window.alert('لم يعد هذا الاشتراك متاحًا. حدّث الصفحة وحاول مجددًا.')
      return
    }
    if (!window.confirm(`أرشفة اشتراك ${row.name}؟ ستبقى الفواتير والدفعات السابقة محفوظة.`)) return
    await runCommand({ type: 'subscription.archive', requestId: crypto.randomUUID(), payload: { subscriptionId: row.subscriptionId } })
  }
  const exportInvoice = (row: ClientDto, index: number) => downloadInvoiceXlsx({
    name: row.name,
    package: row.currentInvoiceLines?.[0]?.description ?? row.package,
    monthly: decimal(row.currentInvoiceTotal ?? row.monthly),
    due: decimal(row.currentInvoiceDue ?? row.currentInvoiceTotal ?? row.monthly),
    invoiceNumber: row.currentInvoiceNumber,
    invoiceDate: row.currentInvoiceIssueDate,
    invoiceDueDate: row.currentInvoiceDueDate,
    invoiceSubtotal: decimal(row.currentInvoiceSubtotal ?? row.monthly),
    invoiceTotal: decimal(row.currentInvoiceTotal ?? row.monthly),
    invoicePaid: decimal(row.currentInvoicePaid ?? '0'),
    invoiceDue: decimal(row.currentInvoiceDue ?? row.currentInvoiceTotal ?? row.monthly),
    invoiceOpeningBalance: decimal(row.currentInvoiceOpeningBalance ?? '0'),
    invoiceLines: row.currentInvoiceLines?.map(lineItem => ({
      description: lineItem.description,
      quantity: decimal(lineItem.quantity),
      unitAmount: decimal(lineItem.unitAmount),
      total: decimal(lineItem.total),
    })),
  }, index)
  return <><PageHead eyebrow="إدارة الإيراد المتكرر" title="الاشتراكات الشهرية" description="العقود الشهرية والتحصيل والرصيد المتبقي لكل عميل." action="اشتراك جديد"/><div className="summary-strip"><span><b>{rows.length}</b> اشتراكًا</span><span><b>{money(value)}</b> قيمة شهرية</span><span className="danger-text"><b>{money(due)}</b> متبقي للتحصيل</span></div><section className="panel table-panel"><div className="list-tools"><div><h2>حسابات الاشتراكات</h2><span>{rows.length} سجل</span></div><input className="search" placeholder="ابحث باسم العميل…" value={search} onChange={event => setSearch(event.target.value)}/></div><div className="table-scroll"><table><thead><tr><th>العميل</th><th>الباقة</th><th>القيمة الشهرية</th><th>المدفوع</th><th>المتبقي</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{rows.length === 0 ? <EmptyTableRow columns={7} text={data.clients.length ? 'لا توجد اشتراكات. اضغط «اشتراك جديد» للبدء.' : 'أضف عميلًا أولًا، ثم أنشئ له اشتراكًا.'}/> : rows.map((row, index) => <tr key={row.id}><td className="strong">{row.name}</td><td>{row.package}</td><td>{money(row.monthly)}</td><td className="positive">{money(row.paid)}</td><td className={decimal(row.due) ? 'negative strong' : ''}>{money(row.due)}</td><td><Status tone={receivableStatusTone(row.status)}>{row.status}</Status></td><td><div className="row-actions"><button className="table-action" disabled={mutating} onClick={() => openAction('تسجيل دفعة اشتراك', row.name, row.id)}>دفعة</button><button className="table-action" disabled={mutating || !row.subscriptionId} onClick={() => openAction('تعديل اشتراك', row.name, row.subscriptionId)}>تعديل</button><button className="table-action primary-action" disabled={!row.currentInvoiceId} onClick={() => void exportInvoice(row, index)}>Excel</button><button className="table-action danger-action" disabled={mutating || !row.subscriptionId} onClick={() => void archive(row).catch(() => undefined)}>أرشفة</button></div></td></tr>)}</tbody></table></div></section></>
}

function LocalClients() {
  const { data, runCommand, mutating } = useFinance()
  const [search, setSearch] = useState('')
  const clients = data.clients.filter(row => `${row.name} ${row.phone} ${row.package}`.toLocaleLowerCase('ar').includes(search.toLocaleLowerCase('ar')))
  const profitability = data.clients.map(client => {
    const revenue = data.incomes.filter(row => row.clientId === client.id).reduce((sum, row) => sum + decimal(row.usd), 0)
    const paidExpenses = data.expenses.filter(row => row.clientId === client.id).reduce((sum, row) => sum + decimal(row.usd), 0)
    const openLiabilities = data.liabilities.filter(row => row.clientId === client.id).reduce((sum, row) => sum + decimal(row.total) - decimal(row.paid), 0)
    return { client, revenue, paidExpenses, openLiabilities }
  })
  const setActive = async (row: ClientDto, active: boolean) => {
    if (!window.confirm(`تعطيل العميل ${row.name}؟ لن تُحذف أي حركة أو فاتورة أو بيانات مالية مرتبطة به.`)) return
    await runCommand({ type: 'client.setActive', requestId: crypto.randomUUID(), payload: { clientId: row.id, active } })
  }
  return <><PageHead eyebrow="دليل العملاء" title="العملاء" description="بيانات العملاء والاشتراكات والنتيجة المالية لكل عميل." action="عميل جديد"/><section className="panel table-panel"><div className="list-tools"><div><h2>قائمة العملاء</h2><span>{clients.length} من {data.clients.length}</span></div><input className="search" placeholder="ابحث بالاسم أو الهاتف أو الخدمة…" value={search} onChange={event=>setSearch(event.target.value)}/></div><div className="table-scroll"><table><thead><tr><th>اسم العميل</th><th>الهاتف</th><th>الخدمة</th><th>قيمة العقد</th><th>الرصيد</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{clients.length === 0 ? <EmptyTableRow columns={7}/> : clients.map(row => <tr key={row.id}><td className="strong client-name"><span>{row.name.slice(0,1)}</span>{row.name}</td><td dir="ltr">{row.phone || '—'}</td><td>{row.package || 'لا يوجد اشتراك'}</td><td>{money(row.monthly)}</td><td className={decimal(row.due) ? 'negative strong' : 'positive'}>{money(row.due)}</td><td><Status tone={row.active ? 'good' : 'neutral'}>{row.active ? 'فعال' : 'غير فعال'}</Status></td><td><div className="row-actions"><button className="table-action" disabled={mutating} onClick={()=>openAction('تعديل عميل', row.name, row.id)}>تعديل</button>{row.active ? <button className="table-action danger-action" disabled={mutating} onClick={()=>void setActive(row, false).catch(() => undefined)}>تعطيل</button> : <button className="table-action primary-action" disabled={mutating} onClick={()=>void runCommand({ type: 'client.setActive', requestId: crypto.randomUUID(), payload: { clientId: row.id, active: true } }).catch(() => undefined)}>إعادة تفعيل</button>}</div></td></tr>)}</tbody></table></div></section><section className="panel table-panel"><PanelTitle title="صافي العملاء" meta="الدخل − المصروفات − الذمم المفتوحة"/><div className="table-scroll"><table><thead><tr><th>العميل</th><th>الدخل</th><th>المصروفات المرتبطة</th><th>الذمم المفتوحة</th><th>الصافي المتوقع</th></tr></thead><tbody>{profitability.length === 0 ? <EmptyTableRow columns={5}/> : profitability.map(row => { const net = row.revenue - row.paidExpenses - row.openLiabilities; return <tr key={row.client.id}><td className="strong">{row.client.name}</td><td className="positive">{money(row.revenue)}</td><td className="negative">-{money(row.paidExpenses)}</td><td className="negative">-{money(row.openLiabilities)}</td><td className={net >= 0 ? 'positive strong' : 'negative strong'}>{money(net)}</td></tr>})}</tbody></table></div></section></>
}

function originalMoney(amount: string | number, currency: Currency) {
  return currency === 'USD' ? money(amount) : `${new Intl.NumberFormat('en-US').format(decimal(amount))} ل.س`
}

function LocalIncome() {
  const { data } = useFinance()
  const [search, setSearch] = useState('')
  const [type, setType] = useState('الكل')
  const query = search.trim().toLocaleLowerCase('ar')
  const rows = data.incomes.filter(row => (type === 'الكل' || row.type === type) && `${row.date} ${row.source} ${row.client ?? ''} ${row.type} ${row.note}`.toLocaleLowerCase('ar').includes(query))
  return <><PageHead eyebrow="حركة الصندوق الداخلة" title="الدخل" description="دفعة الاشتراك تُخصم تلقائيًا من الرصيد المتبقي للعميل." action="تسجيل دخل"/><section className="panel table-panel"><div className="list-tools search-tools"><div><h2>حركات الدخل</h2><span>{rows.length} من {data.incomes.length} حركة</span></div><div className="table-filters"><input className="search" placeholder="ابحث بالمصدر أو العميل أو البيان أو التاريخ…" value={search} onChange={event=>setSearch(event.target.value)}/><select value={type} onChange={event=>setType(event.target.value)}><option>الكل</option><option>دفعة اشتراك</option><option>دخل عميل إضافي</option><option>دخل تشغيل إعلانات</option><option>دخل خارجي</option></select>{(search || type !== 'الكل') && <button className="btn ghost" onClick={()=>{setSearch('');setType('الكل')}}>مسح</button>}</div></div><div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>المصدر</th><th>النوع</th><th>المبلغ الأصلي</th><th>بالدولار</th><th>البيان</th></tr></thead><tbody>{rows.length === 0 ? <EmptyTableRow columns={6} text={data.incomes.length ? 'لا توجد نتائج مطابقة للبحث.' : 'لا توجد حركات دخل بعد.'}/> : rows.map(row => <tr key={row.id}><td>{row.date}</td><td className="strong">{row.source}</td><td>{row.type}</td><td>{originalMoney(row.amount, row.currency)}</td><td className="positive strong">{money(row.usd)}</td><td>{row.note || '—'}</td></tr>)}</tbody></table></div></section></>
}

function expenseGroups(rows: ExpenseDto[]) {
  const colors = ['#ff5a0a', '#24211f', '#ff9a64', '#806f63', '#d8c8b8']
  return Array.from(rows.reduce((map, row) => map.set(row.category, (map.get(row.category) ?? 0) + decimal(row.usd)), new Map<string, number>())).map(([category, amount], index) => ({ category, amount, color: colors[index % colors.length] }))
}

function LocalExpenseBars({ rows }: { rows: ExpenseDto[] }) {
  const groups = expenseGroups(rows)
  const total = groups.reduce((sum, row) => sum + row.amount, 0)
  if (!total) return <div style={{ padding: 32, textAlign: 'center', color: '#806f63' }}>لا توجد مصروفات بعد.</div>
  return <div className="expense-list detailed">{groups.map(row => <div className="expense-row" key={row.category}><div className="expense-top"><span><i className="dot" style={{ background: row.color }}/>{row.category}</span><b>{money(row.amount)}</b></div><div className="expense-track"><span style={{ width: `${row.amount / total * 100}%`, background: row.color }}/></div><small>{(row.amount / total * 100).toFixed(1)}% من المصروفات</small></div>)}</div>
}

function LocalExpenses() {
  const { data, runCommand, mutating } = useFinance()
  const [tab, setTab] = useState<'overview' | 'linked' | 'fixed' | 'services'>('overview')
  const [search, setSearch] = useState('')
  const query = search.trim().toLocaleLowerCase('ar')
  const filteredExpenses = data.expenses.filter(row => `${row.date} ${row.name} ${row.category} ${row.client ?? ''} ${row.note}`.toLocaleLowerCase('ar').includes(query))
  const total = data.expenses.reduce((sum, row) => sum + decimal(row.usd), 0)
  const linked = filteredExpenses.filter(row => row.client)
  const archiveFixed = async (row: FixedExpenseDto) => {
    if (!window.confirm(`أرشفة المصروف الثابت «${row.name}»؟ لن تُحذف أي حركة دفع سابقة.`)) return
    await runCommand({ type: 'fixedExpense.archive', requestId: crypto.randomUUID(), payload: { fixedExpenseId: row.id } })
  }
  const archiveService = async (row: ServiceDto) => {
    if (!window.confirm(`أرشفة اشتراك الخدمة «${row.name}»؟ لن تُحذف أي حركة دفع سابقة.`)) return
    await runCommand({ type: 'service.archive', requestId: crypto.randomUUID(), payload: { serviceId: row.id } })
  }
  const expenseTable = <section className="panel table-panel"><div className="list-tools search-tools"><div><h2>حركات المصروفات</h2><span>{filteredExpenses.length} من {data.expenses.length} حركة</span></div><div className="table-filters"><input className="search" placeholder="ابحث بالبند أو العميل أو التصنيف أو التاريخ…" value={search} onChange={event=>setSearch(event.target.value)}/>{search && <button className="btn ghost" onClick={()=>setSearch('')}>مسح</button>}</div></div><div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>البند</th><th>التصنيف</th><th>العميل</th><th>المبلغ الأصلي</th><th>بالدولار</th><th>البيان</th></tr></thead><tbody>{filteredExpenses.length === 0 ? <EmptyTableRow columns={7} text={data.expenses.length ? 'لا توجد نتائج مطابقة للبحث.' : 'لا توجد حركات مصروفات بعد.'}/> : filteredExpenses.map(row=><tr key={row.id}><td>{row.date}</td><td className="strong">{row.name}</td><td>{row.category}</td><td>{row.client || 'عام'}</td><td>{originalMoney(row.amount,row.currency)}</td><td className="negative strong">-{money(row.usd)}</td><td>{row.note || '—'}</td></tr>)}</tbody></table></div></section>
  const linkedTotal = data.expenses.filter(row => row.clientId).reduce((sum, row) => sum + decimal(row.usd), 0)
  const generalTotal = data.expenses.filter(row => !row.clientId).reduce((sum, row) => sum + decimal(row.usd), 0)
  return <>
    <PageHead eyebrow="حركة الصندوق الخارجة" title="المصروفات" description="سجّل المصروف العام أو اربطه بعميل لمعرفة صافي العميل." action="تسجيل مصروف"/>
    <div className="tabs expense-tabs"><button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>الملخص والحركات</button><button className={tab === 'linked' ? 'active' : ''} onClick={() => setTab('linked')}>مرتبطة بعميل</button><button className={tab === 'fixed' ? 'active' : ''} onClick={() => setTab('fixed')}>المصاريف الثابتة</button><button className={tab === 'services' ? 'active' : ''} onClick={() => setTab('services')}>اشتراكات الخدمات</button></div>
    {tab === 'overview' && <><section className="kpi-grid three"><Kpi label="إجمالي المصروفات" value={money(total)} sub={`${data.expenses.length} حركة`} tone="red"/><Kpi label="مرتبطة بعملاء" value={money(linkedTotal)} sub={`${data.expenses.filter(row=>row.clientId).length} حركة`}/><Kpi label="مصروفات عامة" value={money(generalTotal)} sub="على الشركة"/></section>{expenseTable}<section className="panel"><PanelTitle title="التصنيف"/><LocalExpenseBars rows={data.expenses}/></section></>}
    {tab === 'linked' && <section className="panel table-panel"><div className="list-tools search-tools"><div><h2>مصروفات مرتبطة بالعملاء</h2><span>{linked.length} حركة</span></div><input className="search" placeholder="ابحث بالعميل أو البند…" value={search} onChange={event=>setSearch(event.target.value)}/></div><div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>العميل</th><th>التصنيف</th><th>البيان</th><th>المبلغ</th></tr></thead><tbody>{linked.length === 0 ? <EmptyTableRow columns={5}/> : linked.map(row => <tr key={row.id}><td>{row.date}</td><td className="strong">{row.client}</td><td>{row.category}</td><td>{row.name}</td><td className="negative strong">-{money(row.usd)}</td></tr>)}</tbody></table></div></section>}
    {tab === 'fixed' && <section className="panel table-panel"><div className="list-tools"><div><h2>المصاريف الثابتة</h2><span>إضافة وتعديل ودف المصروف عند تسديده</span></div><button className="btn primary" onClick={() => openAction('مصروف ثابت جديد')}>+ إضافة</button></div><div className="table-scroll"><table><thead><tr><th>البند</th><th>التصنيف</th><th>المبلغ</th><th>يوم الاستحقاق</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{data.fixedExpenses.length === 0 ? <EmptyTableRow columns={6}/> : data.fixedExpenses.map(row => <tr key={row.id}><td className="strong">{row.name}</td><td>{row.category}</td><td>{money(row.amount)}</td><td>{row.dueDay}</td><td><Status tone={row.status === 'مدفوع' ? 'good' : 'warn'}>{row.status}</Status></td><td><div className="row-actions"><button className="table-action primary-action" disabled={mutating || row.status === 'مدفوع'} onClick={()=>openAction('دفع مصروف ثابت', row.name, row.id)}>{row.status === 'مدفوع' ? 'تم الدفع' : 'دفع'}</button><button className="table-action" disabled={mutating} onClick={()=>openAction('تعديل مصروف ثابت', row.name, row.id)}>تعديل</button><button className="table-action danger-action" disabled={mutating} onClick={()=>void archiveFixed(row).catch(() => undefined)}>أرشفة</button></div></td></tr>)}</tbody></table></div></section>}
    {tab === 'services' && <section className="panel table-panel"><div className="list-tools"><div><h2>اشتراكات خدمات الشركة</h2><span>إضافة وتعديل ودفع وأرشفة</span></div><button className="btn primary" onClick={() => openAction('اشتراك خدمة جديد')}>+ إضافة</button></div><div className="table-scroll"><table><thead><tr><th>الخدمة</th><th>التصنيف</th><th>القيمة</th><th>الدورة</th><th>التجديد</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{data.services.length === 0 ? <EmptyTableRow columns={7}/> : data.services.map(row => <tr key={row.id}><td className="strong">{row.name}</td><td>{row.category}</td><td>{money(row.amount)}</td><td>{row.cycle}</td><td>{row.next}</td><td><Status tone={row.status === 'مدفوع' ? 'good' : 'warn'}>{row.status}</Status></td><td><div className="row-actions"><button className="table-action primary-action" disabled={mutating || row.status === 'مدفوع'} onClick={()=>openAction('دفع اشتراك خدمة', row.name, row.id)}>{row.status === 'مدفوع' ? 'تم الدفع' : 'دفع'}</button><button className="table-action" disabled={mutating} onClick={()=>openAction('تعديل اشتراك خدمة', row.name, row.id)}>تعديل</button><button className="table-action danger-action" disabled={mutating} onClick={()=>void archiveService(row).catch(() => undefined)}>أرشفة</button></div></td></tr>)}</tbody></table></div></section>}
  </>
}

function LocalLiabilities() {
  const { data } = useFinance()
  const total = data.liabilities.reduce((sum,row)=>sum + decimal(row.total),0)
  const paid = data.liabilities.reduce((sum,row)=>sum + decimal(row.paid),0)
  return <><PageHead eyebrow="مبالغ علينا لم تُدفع بعد" title="الذمم المستحقة" description="التزامات للمصورين والمودلز والموردين والمستقلين." action="إضافة ذمة"/><section className="kpi-grid three"><Kpi label="إجمالي الذمم" value={money(total)} sub={`${data.liabilities.length} قيود`}/><Kpi label="المدفوع" value={money(paid)} sub="خرج من الصندوق" tone="green"/><Kpi label="المتبقي" value={money(total-paid)} sub="بانتظار الدفع" tone="red"/></section><section className="panel table-panel"><PanelTitle title="سجل الذمم"/><div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>المستفيد</th><th>النوع</th><th>العميل</th><th>البيان</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th><th>الاستحقاق</th><th>إجراء</th></tr></thead><tbody>{data.liabilities.length === 0 ? <EmptyTableRow columns={10}/> : data.liabilities.map(row => { const remaining = subtractMoney(row.total, row.paid); const payable = hasPositiveMoney(remaining); return <tr key={row.id}><td>{row.date}</td><td className="strong">{row.party}</td><td>{row.kind}</td><td>{row.client || 'عام'}</td><td>{row.description || '—'}</td><td>{money(row.total)}</td><td className="positive">{money(row.paid)}</td><td className="negative strong">{money(remaining)}</td><td>{row.due}</td><td><button className="table-action primary-action" disabled={!payable} onClick={() => openAction('دفع ذمة', row.party, row.id)}>{payable ? 'دفع' : 'مسددة'}</button></td></tr> })}</tbody></table></div></section></>
}

function LocalPayroll() {
  const { data, runCommand, mutating } = useFinance()
  const [search, setSearch] = useState('')
  const rows = data.employees.filter(row => row.name.toLocaleLowerCase('ar').includes(search.toLocaleLowerCase('ar')))
  const net = (row: EmployeeDto) => decimal(row.base) + decimal(row.bonus) - decimal(row.deductions) - decimal(row.loan)
  const baseTotal = data.employees.reduce((sum, row) => sum + decimal(row.base), 0)
  const bonusTotal = data.employees.reduce((sum, row) => sum + decimal(row.bonus), 0)
  const deductionTotal = data.employees.reduce((sum, row) => sum + decimal(row.deductions) + decimal(row.loan), 0)
  const netTotal = data.employees.reduce((sum, row) => sum + net(row), 0)
  const archive = async (row: EmployeeDto) => {
    if (!window.confirm(`أرشفة الموظف ${row.name}؟ لن تُحذف حركات الرواتب والمصروفات السابقة.`)) return
    await runCommand({ type: 'employee.archive', requestId: crypto.randomUUID(), payload: { employeeId: row.id } })
  }
  const reversePayroll = async (row: PayrollSettlementDto) => {
    const reason = requestReversalReason(`تسوية راتب ${row.employeeName} عن ${row.period}`)
    if (!reason) return
    await runCommand({
      type: 'payroll.reverse',
      requestId: crypto.randomUUID(),
      payload: {
        payrollItemId: row.payrollItemId,
        date: businessDate(),
        reason,
      },
    })
  }
  const payrollStatus = (status: PayrollSettlementDto['status']) => {
    if (status === 'PAID') return 'مدفوع'
    if (status === 'PARTIALLY_PAID') return 'مدفوع جزئيًا'
    if (status === 'VOID') return 'ملغى'
    return 'جاهز'
  }

  return <>
    <PageHead eyebrow="الموظفون والرواتب" title="الموظفون والرواتب" description="الراتب الأساسي + المكافآت − الحسومات − السلف." action="إضافة موظف"/>
    <div className="summary-strip payroll-summary"><span><b>{data.employees.length}</b> إجمالي الموظفين</span><span><b>{money(baseTotal)}</b> الرواتب الأساسية</span><span><b>{money(bonusTotal)}</b> المكافآت</span><span className="danger-text"><b>{money(deductionTotal)}</b> الحسومات والسلف</span><span><b>{money(netTotal)}</b> صافي الرواتب</span></div>
    <section className="panel table-panel">
      <div className="list-tools"><div><h2>مسير الرواتب</h2><span>{rows.length} من {data.employees.length} موظفين</span></div><input className="search" placeholder="ابحث باسم الموظف…" value={search} onChange={event=>setSearch(event.target.value)}/></div>
      <div className="table-scroll"><table><thead><tr><th>الموظف</th><th>الأساسي</th><th>المكافأة</th><th>الحسومات</th><th>السلفة</th><th>الصافي</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{rows.length === 0 ? <EmptyTableRow columns={8}/> : rows.map(row => <tr key={row.id}><td className="strong">{row.name}</td><td>{money(row.base)}</td><td className="positive">+{money(row.bonus)}</td><td className="negative">-{money(row.deductions)}</td><td className="negative">-{money(row.loan)}</td><td className="strong">{money(net(row))}</td><td><Status tone={row.status === 'مدفوع' ? 'good' : 'warn'}>{row.status}</Status></td><td><div className="row-actions"><button className="table-action primary-action" disabled={mutating || row.status === 'مدفوع'} onClick={()=>openAction('دفع راتب', row.name, row.id)}>{row.status === 'مدفوع' ? 'تم الدفع' : 'دفع'}</button><button className="table-action" disabled={mutating} onClick={()=>openAction('تعديل موظف', row.name, row.id)}>تعديل</button><button className="table-action danger-action" disabled={mutating} onClick={()=>void archive(row).catch(() => undefined)}>أرشفة</button></div></td></tr>)}</tbody></table></div>
    </section>
    <section className="panel table-panel">
      <PanelTitle title="سجل تسويات الرواتب" meta="يشمل التسويات النقدية وحسومات السلف غير النقدية"/>
      <div className="table-scroll"><table><thead><tr><th>الفترة</th><th>الموظف</th><th>الصافي</th><th>المدفوع نقدًا</th><th>حسم السلفة</th><th>تاريخ الدفع</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{data.payrollSettlements.length === 0 ? <EmptyTableRow columns={8} text="لا توجد تسويات رواتب بعد."/> : data.payrollSettlements.map(row => <tr key={row.payrollItemId}><td>{row.period}</td><td className="strong">{row.employeeName}</td><td>{money(row.netPay)}</td><td>{money(row.cashPaid)}</td><td>{money(row.advanceApplied)}</td><td>{row.paidOn || '—'}</td><td><Status tone={row.status === 'PAID' ? 'good' : row.status === 'VOID' ? 'neutral' : 'warn'}>{payrollStatus(row.status)}</Status></td><td>{row.reversible ? <button className="table-action danger-action" disabled={mutating} onClick={()=>void reversePayroll(row).catch(() => undefined)}>عكس التسوية</button> : '—'}</td></tr>)}</tbody></table></div>
    </section>
  </>
}

function LocalAdvances() {
  const { data } = useFinance()
  return <><PageHead eyebrow="السلف والسحوبات" title="السلف والسحوبات" description="سلف الموظفين وسحوبات المالك تبقى أرصدة مستقلة." action="تسجيل سلفة"/><section className="panel table-panel"><PanelTitle title="سجل السلف" meta={`${data.advances.length} قيود`}/><div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>الاسم</th><th>النوع</th><th>المبلغ</th><th>المسدّد</th><th>المتبقي</th><th>إجراء</th></tr></thead><tbody>{data.advances.length === 0 ? <EmptyTableRow columns={7}/> : data.advances.map(row => { const remaining = subtractMoney(row.amount, row.paid); const repayable = hasPositiveMoney(remaining); return <tr key={row.id}><td>{row.date}</td><td className="strong">{row.name}</td><td>{row.kind}</td><td>{money(row.amount)}</td><td>{money(row.paid)}</td><td className="negative strong">{money(remaining)}</td><td><button className="table-action primary-action" disabled={!repayable} onClick={() => openAction('تسديد سلفة', row.name, row.id)}>{repayable ? 'تسديد' : 'مسددة'}</button></td></tr> })}</tbody></table></div></section></>
}

function LocalCashbox() {
  const { data, runCommand, mutating } = useFinance()
  const reverseEntry = async (row: CashLedgerEntryDto) => {
    if (!row.reversalCommand || !row.reversalTargetId) return
    const reason = requestReversalReason(`القيد «${row.description}»`)
    if (!reason) return
    const date = businessDate()
    if (row.reversalCommand === 'payroll.reverse') {
      await runCommand({
        type: 'payroll.reverse',
        requestId: crypto.randomUUID(),
        payload: { payrollItemId: row.reversalTargetId, date, reason },
      })
      return
    }
    await runCommand({
      type: 'cashEntry.reverse',
      requestId: crypto.randomUUID(),
      payload: { cashEntryId: row.reversalTargetId, date, reason },
    })
  }
  const ledgerStatus = (row: CashLedgerEntryDto) => {
    if (row.reversalOfId) return 'قيد عكسي'
    return row.status === 'REVERSED' ? 'معكوس' : 'مرحّل'
  }

  return <>
    <PageHead eyebrow="صندوق واحد — عملتان" title="الصندوق" description="الأرصدة محسوبة من كافة حركات دفتر الأستاذ في قاعدة البيانات، مع حفظ القيود المعكوسة للتدقيق."/>
    <section className="cash-cards"><article><span>رصيد الدولار</span><strong>{money(data.cashbox.usd)}</strong><small>صافي كافة حركات USD</small></article><article><span>رصيد الليرة السورية</span><strong>{new Intl.NumberFormat('en-US').format(decimal(data.cashbox.syp))} ل.س</strong><small>صافي كافة حركات SYP</small></article><article className="total"><span>القيمة الإجمالية التقريبية</span><strong>{money(data.cashbox.totalUsd)}</strong><small>حسب سعر الصرف الحالي</small></article></section>
    <section className="panel table-panel">
      <PanelTitle title="دفتر حركات الصندوق" meta="العكس ينشئ قيدًا معاكسًا ولا يحذف السجل الأصلي"/>
      <div className="table-scroll"><table><thead><tr><th>التاريخ</th><th>البيان</th><th>النوع</th><th>الاتجاه</th><th>المبلغ الأصلي</th><th>بالدولار</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{data.cashLedger.length === 0 ? <EmptyTableRow columns={8} text="لا توجد حركات صندوق بعد."/> : data.cashLedger.map(row => <tr key={row.id}><td>{row.date}</td><td className="strong">{row.description}</td><td>{row.kind}</td><td><Status tone={row.direction === 'INFLOW' ? 'good' : 'bad'}>{row.direction === 'INFLOW' ? 'داخل' : 'خارج'}</Status></td><td>{originalMoney(row.amount, row.currency)}</td><td className={row.direction === 'INFLOW' ? 'positive strong' : 'negative strong'}>{row.direction === 'INFLOW' ? '' : '-'}{money(row.usd)}</td><td><Status tone={row.status === 'REVERSED' ? 'neutral' : row.reversalOfId ? 'warn' : 'good'}>{ledgerStatus(row)}</Status></td><td>{row.reversible ? <button className="table-action danger-action" disabled={mutating} onClick={()=>void reverseEntry(row).catch(() => undefined)}>عكس القيد</button> : '—'}</td></tr>)}</tbody></table></div>
    </section>
  </>
}

function LocalReports() {
  const { data } = useFinance()
  const totals = localTotals(data)
  const monthlyContracts = data.clients.reduce((sum,row)=>sum + decimal(row.monthly),0)
  return <><PageHead eyebrow="تقارير الإدارة" title="التقارير والتحليل" description="تُحسب هذه الأرقام مباشرة من بيانات قاعدة البيانات."/><section className="kpi-grid five"><Kpi label="إجمالي الدخل" value={money(totals.income)} sub={`${data.incomes.length} حركة`} tone="green"/><Kpi label="إجمالي المصروف" value={money(totals.expense)} sub={`${data.expenses.length} حركة`} tone="red"/><Kpi label="صافي الربح" value={money(totals.profit)} sub="الدخل ناقص المصروف" tone="orange"/><Kpi label="ذمم العملاء" value={money(totals.receivables)} sub="متبقي الاشتراكات"/><Kpi label="العقود الشهرية" value={money(monthlyContracts)} sub={`${data.clients.filter(row=>decimal(row.monthly)>0).length} اشتراك`}/></section><div className="split-grid"><section className="panel"><PanelTitle title="تصنيف المصروفات"/><LocalExpenseBars rows={data.expenses}/></section><LocalReceivables/></div></>
}

function LocalSettings() {
  const { data, runCommand, mutating } = useFinance()
  const requestIdRef = useRef(crypto.randomUUID())
  const [rate, setRate] = useState(String(data.exchangeRate))
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const backup = () => { const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `ozmo-finance-snapshot-${new Date().toISOString().slice(0,10)}.json`; link.click(); URL.revokeObjectURL(link.href) }
  const saveRate = async () => {
    setSaveError('')
    try {
      await runCommand({ type: 'exchangeRate.update', requestId: requestIdRef.current, payload: { rate } })
      requestIdRef.current = crypto.randomUUID()
      setSaved(true)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'تعذّر حفظ سعر الصرف.')
    }
  }
  return <><PageHead eyebrow="إعدادات النظام" title="الإعدادات" description="سعر الصرف وتصدير لقطة من قاعدة البيانات."/><div className="settings-grid"><section className="panel settings-card"><PanelTitle title="سعر الصرف"/><label className="big-input"><span>1 دولار =</span><input inputMode="decimal" value={rate} onChange={event => { setRate(event.target.value.replace(/[^\d.]/g,'')); requestIdRef.current = crypto.randomUUID(); setSaved(false); setSaveError('') }}/><b>ل.س</b></label>{saveError && <div className="notice error-notice">{saveError}</div>}<button className="btn primary" disabled={mutating} onClick={() => void saveRate()}>{mutating ? 'جاري الحفظ…' : saved ? 'تم الحفظ ✓' : 'حفظ سعر الصرف'}</button></section><section className="panel settings-card"><PanelTitle title="تصدير البيانات"/><p>نزّل لقطة JSON للمراجعة أو الأرشفة. مسح بيانات المتصفح لن يؤثر في السجلات المحفوظة.</p><button className="btn primary" onClick={backup}>تنزيل لقطة JSON</button></section><section className="panel settings-card"><PanelTitle title="عن الحفظ"/><ul className="rules"><li>البيانات محفوظة في قاعدة PostgreSQL المركزية.</li><li>كل دفع يُسجّل كحركة مالية مستقلة قابلة للمراجعة.</li><li>تغيير سعر الصرف يؤثر في القيود الجديدة فقط.</li></ul></section></div></>
}

function LocalActionDialog({ request, onClose }: { request: ActionRequest; onClose: () => void }) {
  const { data, runCommand, mutating } = useFinance()
  const requestIdRef = useRef(crypto.randomUUID())
  const clientRecord = data.clients.find(row => row.id === request.subjectId)
  const subscriptionClient = data.clients.find(row => row.subscriptionId === request.subjectId)
  const employeeRecord = data.employees.find(row => row.id === request.subjectId)
  const liabilityRecord = data.liabilities.find(row => row.id === request.subjectId)
  const advanceRecord = data.advances.find(row => row.id === request.subjectId)
  const fixedRecord = data.fixedExpenses.find(row => row.id === request.subjectId)
  const serviceRecord = data.services.find(row => row.id === request.subjectId)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [incomeType, setIncomeType] = useState('دفعة اشتراك')
  const [selectedClientId, setSelectedClientId] = useState(request.action === 'تسجيل دفعة اشتراك' ? request.subjectId ?? '' : '')
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('')
  const [advanceKind, setAdvanceKind] = useState('سلفة موظف')
  const [currency, setCurrency] = useState<Currency>('USD')
  const initialAmount = fixedRecord?.payable
    ?? serviceRecord?.payable
    ?? (liabilityRecord ? subtractMoney(liabilityRecord.total, liabilityRecord.paid) : undefined)
    ?? (advanceRecord ? subtractMoney(advanceRecord.amount, advanceRecord.paid) : undefined)
    ?? ''
  const [amount, setAmount] = useState(initialAmount)
  const today = businessDate()
  const currentPeriod = today.slice(0, 7)
  const isIncome = request.action === 'تسجيل دخل' || request.action === 'تسجيل دفعة اشتراك'
  const isExpense = request.action === 'تسجيل مصروف'
  const needsClient = isIncome && (incomeType === 'دفعة اشتراك' || incomeType === 'دخل عميل إضافي')
  const currencyActions = ['تسجيل دخل', 'تسجيل دفعة اشتراك', 'تسجيل مصروف', 'دفع ذمة', 'دفع مصروف ثابت', 'دفع اشتراك خدمة']
  const amountActions = [...currencyActions, 'إضافة ذمة', 'تسجيل سلفة', 'تسديد سلفة', 'مصروف ثابت جديد', 'اشتراك خدمة جديد']
  const dateActions = [...currencyActions, 'تسجيل سلفة', 'تسديد سلفة', 'دفع راتب']
  const noteActions = [...currencyActions, 'إضافة ذمة', 'تسديد سلفة', 'دفع راتب']
  const selectedClient = data.clients.find(row => row.id === selectedClientId)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget).entries())
    const value = (name: string) => String(values[name] ?? '').trim()
    const optional = (name: string) => value(name) || undefined
    const requestId = requestIdRef.current
    let command: FinanceCommandInput

    try {
      switch (request.action) {
        case 'عميل جديد':
          command = { type: 'client.create', requestId, payload: { name: value('name'), phone: optional('phone') } }
          break
        case 'تعديل عميل':
          if (!clientRecord) throw new Error('لم يعد هذا العميل متاحًا. أغلق النافذة وحدّث البيانات.')
          command = { type: 'client.update', requestId, payload: { clientId: clientRecord.id, name: value('name'), phone: value('phone') } }
          break
        case 'اشتراك جديد':
          command = { type: 'subscription.create', requestId, payload: { clientId: value('clientId'), package: value('package'), monthly: value('monthly') } }
          break
        case 'تعديل اشتراك':
          if (!subscriptionClient?.subscriptionId) throw new Error('لم يعد هذا الاشتراك متاحًا.')
          command = { type: 'subscription.update', requestId, payload: { subscriptionId: subscriptionClient.subscriptionId, package: value('package'), monthly: value('monthly') } }
          break
        case 'تسجيل دخل':
        case 'تسجيل دفعة اشتراك':
          command = { type: 'income.create', requestId, payload: { date: value('date'), source: (selectedClient?.name ?? value('source')) || incomeType, type: incomeType, amount, currency, note: optional('note'), clientId: selectedClientId || undefined } }
          break
        case 'تسجيل مصروف':
          command = { type: 'expense.create', requestId, payload: { date: value('date'), name: value('name'), category: value('category'), amount, currency, note: optional('note'), clientId: selectedClientId || undefined } }
          break
        case 'إضافة ذمة':
          command = { type: 'liability.create', requestId, payload: { date: value('createdDate'), party: value('name'), kind: value('kind'), clientId: selectedClientId || undefined, description: optional('note'), total: amount, due: value('due') } }
          break
        case 'دفع ذمة':
          if (!liabilityRecord) throw new Error('لم يعد هذا القيد متاحًا.')
          command = { type: 'liability.pay', requestId, payload: { liabilityId: liabilityRecord.id, date: value('date'), amount, currency, note: optional('note') } }
          break
        case 'إضافة موظف':
          command = { type: 'employee.create', requestId, payload: { name: value('name'), base: value('base') } }
          break
        case 'تعديل موظف':
          if (!employeeRecord) throw new Error('لم يعد هذا الموظف متاحًا.')
          command = { type: 'employee.update', requestId, payload: { employeeId: employeeRecord.id, name: value('name'), base: value('base'), bonus: value('bonus'), deductions: value('deductions'), loan: value('loan') } }
          break
        case 'دفع راتب':
          if (!employeeRecord) throw new Error('لم يعد هذا الموظف متاحًا.')
          command = { type: 'payroll.pay', requestId, payload: { employeeId: employeeRecord.id, period: value('period'), date: value('date'), note: optional('note') } }
          break
        case 'تسجيل سلفة': {
          const employeeId = advanceKind === 'سلفة موظف' ? selectedEmployeeId || undefined : undefined
          if (advanceKind === 'سلفة موظف' && !employeeId) throw new Error('اختر الموظف المرتبط بالسلفة.')
          const linkedEmployee = data.employees.find(row => row.id === employeeId)
          command = { type: 'advance.create', requestId, payload: { date: value('date'), name: linkedEmployee?.name ?? value('name'), kind: advanceKind, amount, employeeId } }
          break
        }
        case 'تسديد سلفة':
          if (!advanceRecord) throw new Error('لم يعد هذا القيد متاحًا.')
          command = { type: 'advance.repay', requestId, payload: { advanceId: advanceRecord.id, date: value('date'), amount, note: optional('note') } }
          break
        case 'مصروف ثابت جديد':
          command = { type: 'fixedExpense.create', requestId, payload: { name: value('name'), category: value('category'), amount, dueDay: Number(value('day')) } }
          break
        case 'تعديل مصروف ثابت':
          if (!fixedRecord) throw new Error('لم يعد هذا المصروف متاحًا.')
          command = { type: 'fixedExpense.update', requestId, payload: { fixedExpenseId: fixedRecord.id, name: value('name'), category: value('category'), amount: value('fixedAmount'), dueDay: Number(value('day')) } }
          break
        case 'دفع مصروف ثابت':
          if (!fixedRecord) throw new Error('لم يعد هذا المصروف متاحًا.')
          command = { type: 'fixedExpense.pay', requestId, payload: { fixedExpenseId: fixedRecord.id, date: value('date'), amount, currency, note: optional('note') } }
          break
        case 'اشتراك خدمة جديد':
          command = { type: 'service.create', requestId, payload: { name: value('name'), category: value('category'), amount, cycle: value('cycle'), next: value('next') } }
          break
        case 'تعديل اشتراك خدمة':
          if (!serviceRecord) throw new Error('لم يعد هذا الاشتراك متاحًا.')
          command = { type: 'service.update', requestId, payload: { serviceId: serviceRecord.id, name: value('name'), category: value('category'), amount: value('serviceAmount'), cycle: value('cycle'), next: value('next') } }
          break
        case 'دفع اشتراك خدمة':
          if (!serviceRecord) throw new Error('لم يعد هذا الاشتراك متاحًا.')
          command = { type: 'service.pay', requestId, payload: { serviceId: serviceRecord.id, date: value('date'), amount, currency, note: optional('note') } }
          break
        default:
          throw new Error('هذه العملية غير مدعومة.')
      }
      setSaveError('')
      await runCommand(command)
      setSaved(true)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'تعذّر حفظ العملية.')
    }
  }

  const title = request.subject ? `${request.action} — ${request.subject}` : request.action
  const balanceBefore = selectedClient?.due ?? '0'
  const balanceAfter = subtractMoney(balanceBefore, amount)
  return <div className="action-overlay" role="presentation"><section className="action-dialog" role="dialog" aria-modal="true"><button className="guide-close" onClick={onClose} aria-label="إغلاق">×</button><header><span className="eyebrow">حفظ آمن</span><h2>{title}</h2><p>ستُحفظ العملية في قاعدة البيانات وتُحدّث الأرصدة والتقارير فورًا.</p></header>{saved ? <div className="saved-state"><span>✓</span><h3>تم الحفظ</h3><p>سُجّلت العملية في قاعدة البيانات وتم تحديث الواجهة.</p><button className="btn primary" onClick={onClose}>تم</button></div> : <form className="action-form" onSubmit={submit}>
    {saveError && <div className="notice error-notice full" role="alert">{saveError}</div>}
    {request.action === 'عميل جديد' && <><label className="field"><span>اسم العميل</span><input name="name" required maxLength={200}/></label><label className="field"><span>رقم الهاتف</span><input name="phone" dir="ltr" maxLength={50}/></label></>}
    {request.action === 'تعديل عميل' && clientRecord && <><label className="field"><span>اسم العميل</span><input name="name" required maxLength={200} defaultValue={clientRecord.name}/></label><label className="field"><span>رقم الهاتف</span><input name="phone" dir="ltr" maxLength={50} defaultValue={clientRecord.phone}/></label></>}
    {request.action === 'اشتراك جديد' && <><label className="field"><span>العميل</span><select name="clientId" required defaultValue=""><option value="" disabled>اختر العميل</option>{data.clients.filter(row=>row.active && !row.subscriptionId).map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label className="field"><span>الباقة</span><input name="package" required placeholder="مثال: إدارة محتوى"/></label><label className="field"><span>القيمة الشهرية بالدولار</span><input name="monthly" type="number" min="0.01" step="0.01" required/></label></>}
    {request.action === 'تعديل اشتراك' && subscriptionClient && <><label className="field"><span>العميل</span><input value={subscriptionClient.name} readOnly/></label><label className="field"><span>الباقة</span><input name="package" required defaultValue={subscriptionClient.package}/></label><label className="field"><span>القيمة الشهرية</span><input name="monthly" type="number" min="0.01" step="0.01" required defaultValue={subscriptionClient.monthly}/></label><div className="field-help full">تعديل قيمة العقد لا يغيّر الفواتير أو الدفعات السابقة.</div></>}
    {isIncome && <><label className="field"><span>نوع الدخل</span><select value={incomeType} onChange={event=>{setIncomeType(event.target.value); if (request.action !== 'تسجيل دفعة اشتراك') setSelectedClientId('')}} disabled={request.action === 'تسجيل دفعة اشتراك'}><option>دفعة اشتراك</option><option>دخل عميل إضافي</option><option>دخل تشغيل إعلانات</option><option>دخل خارجي</option></select></label>{needsClient ? <label className="field"><span>العميل</span><select required value={selectedClientId} onChange={event=>setSelectedClientId(event.target.value)}><option value="" disabled>اختر العميل</option>{data.clients.filter(row=>row.active).map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label> : <label className="field"><span>المصدر</span><input name="source" required/></label>}</>}
    {isExpense && <><label className="field"><span>اسم البند</span><input name="name" required/></label><label className="field"><span>التصنيف</span><CategorySelect/></label><label className="field full"><span>مرتبط بعميل — اختياري</span><select value={selectedClientId} onChange={event=>setSelectedClientId(event.target.value)}><option value="">مصروف عام</option>{data.clients.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label></>}
    {request.action === 'إضافة ذمة' && <><label className="field"><span>اسم المستفيد</span><input name="name" required/></label><label className="field"><span>النوع</span><select name="kind"><option>مصور</option><option>مودل</option><option>مورد</option><option>مستقل</option><option>أخرى</option></select></label><label className="field full"><span>العميل — اختياري</span><select value={selectedClientId} onChange={event=>setSelectedClientId(event.target.value)}><option value="">ذمة عامة</option>{data.clients.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label className="field"><span>تاريخ القيد</span><input name="createdDate" type="date" defaultValue={today} required/></label><label className="field"><span>تاريخ الاستحقاق</span><input name="due" type="date" defaultValue={today} required/></label></>}
    {request.action === 'دفع ذمة' && liabilityRecord && <ReadOnlySummary label="المستفيد" value={liabilityRecord.party} help={`المتبقي ${money(subtractMoney(liabilityRecord.total, liabilityRecord.paid))}`}/>} 
    {request.action === 'إضافة موظف' && <><label className="field"><span>اسم الموظف</span><input name="name" required/></label><label className="field"><span>الراتب الأساسي</span><input name="base" type="number" min="0.01" step="0.01" required/></label></>}
    {request.action === 'تعديل موظف' && employeeRecord && <><label className="field"><span>اسم الموظف</span><input name="name" required defaultValue={employeeRecord.name}/></label><label className="field"><span>الراتب الأساسي</span><input name="base" type="number" min="0.01" step="0.01" required defaultValue={employeeRecord.base}/></label><label className="field"><span>المكافآت</span><input name="bonus" type="number" min="0" step="0.01" defaultValue={employeeRecord.bonus}/></label><label className="field"><span>الحسومات</span><input name="deductions" type="number" min="0" step="0.01" defaultValue={employeeRecord.deductions}/></label><label className="field"><span>حسم السلفة</span><input name="loan" type="number" min="0" step="0.01" defaultValue={employeeRecord.loan}/></label></>}
    {request.action === 'دفع راتب' && employeeRecord && <><ReadOnlySummary label="الموظف" value={employeeRecord.name} help={`صافي الفترة ${money(decimal(employeeRecord.payBase) + decimal(employeeRecord.payBonus) - decimal(employeeRecord.payDeductions) - decimal(employeeRecord.payLoan))}${employeeRecord.outstandingPeriods > 1 ? ` — ${employeeRecord.outstandingPeriods} فترات غير مدفوعة` : ''}`}/><label className="field"><span>فترة الراتب</span><input name="period" type="month" defaultValue={employeeRecord.period || currentPeriod} readOnly required/></label></>}
    {request.action === 'تسجيل سلفة' && <><label className="field"><span>النوع</span><select value={advanceKind} onChange={event=>{ const kind = event.target.value; setAdvanceKind(kind); if (kind !== 'سلفة موظف') setSelectedEmployeeId('') }}><option>سلفة موظف</option><option>سحب مالك أو شريك</option></select></label>{advanceKind === 'سلفة موظف' ? <label className="field"><span>الموظف</span><select required value={selectedEmployeeId} onChange={event=>setSelectedEmployeeId(event.target.value)}><option value="" disabled>اختر الموظف</option>{data.employees.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label> : <label className="field"><span>اسم المالك أو الشريك</span><input name="name" required/></label>}</>}
    {request.action === 'تسديد سلفة' && advanceRecord && <ReadOnlySummary label="صاحب السلفة" value={advanceRecord.name} help={`المتبقي ${money(subtractMoney(advanceRecord.amount, advanceRecord.paid))}`}/>} 
    {request.action === 'مصروف ثابت جديد' && <><label className="field"><span>اسم البند</span><input name="name" required/></label><label className="field"><span>التصنيف</span><CategorySelect/></label><label className="field"><span>يوم الاستحقاق</span><input name="day" type="number" min="1" max="31" defaultValue="1" required/></label></>}
    {request.action === 'تعديل مصروف ثابت' && fixedRecord && <><label className="field"><span>اسم البند</span><input name="name" required defaultValue={fixedRecord.name}/></label><label className="field"><span>التصنيف</span><CategorySelect defaultValue={fixedRecord.category}/></label><label className="field"><span>المبلغ</span><input name="fixedAmount" type="number" min="0.01" step="0.01" required defaultValue={fixedRecord.amount}/></label><label className="field"><span>يوم الاستحقاق</span><input name="day" type="number" min="1" max="31" defaultValue={fixedRecord.dueDay} required/></label></>}
    {request.action === 'دفع مصروف ثابت' && fixedRecord && <ReadOnlySummary label="المصروف" value={fixedRecord.name} help={`القسط الأقدم المستحق ${money(fixedRecord.payable)} — إجمالي المتأخرات ${money(fixedRecord.outstanding)}`}/>} 
    {request.action === 'اشتراك خدمة جديد' && <><label className="field"><span>اسم الخدمة</span><input name="name" required/></label><label className="field"><span>التصنيف</span><CategorySelect defaultValue="برامج"/></label><label className="field"><span>الدورة</span><select name="cycle" defaultValue="شهري"><option>شهري</option><option>سنوي</option><option>مرة واحدة</option></select></label><label className="field"><span>التجديد القادم</span><input name="next" type="date" defaultValue={today} required/></label></>}
    {request.action === 'تعديل اشتراك خدمة' && serviceRecord && <><label className="field"><span>اسم الخدمة</span><input name="name" required defaultValue={serviceRecord.name}/></label><label className="field"><span>التصنيف</span><CategorySelect defaultValue={serviceRecord.category}/></label><label className="field"><span>المبلغ</span><input name="serviceAmount" type="number" min="0.01" step="0.01" required defaultValue={serviceRecord.amount}/></label><label className="field"><span>الدورة</span><select name="cycle" defaultValue={serviceRecord.cycle}><option>شهري</option><option>سنوي</option><option>مرة واحدة</option></select></label><label className="field"><span>التجديد القادم</span><input name="next" type="date" defaultValue={serviceRecord.next} required/></label></>}
    {request.action === 'دفع اشتراك خدمة' && serviceRecord && <ReadOnlySummary label="الخدمة" value={serviceRecord.name} help={`القسط الأقدم المستحق ${money(serviceRecord.payable)} — إجمالي المتأخرات ${money(serviceRecord.outstanding)}`}/>} 
    {amountActions.includes(request.action) && <label className="field"><span>المبلغ</span><input name="amount" type="number" min="0.01" step="0.01" required value={amount} onChange={event=>setAmount(event.target.value)}/></label>}
    {currencyActions.includes(request.action) && <label className="field"><span>العملة</span><select value={currency} onChange={event=>{setCurrency(event.target.value as Currency); setAmount('')}}><option value="USD">دولار USD</option><option value="SYP">ليرة سورية SYP</option></select></label>}
    {dateActions.includes(request.action) && <label className="field"><span>التاريخ</span><input name="date" type="date" defaultValue={today} required/></label>}
    {request.action === 'تسجيل دفعة اشتراك' && selectedClient && <div className="allocation-preview full"><div><small>الاشتراك الشهري</small><b>{money(selectedClient.monthly)}</b></div><div><small>الرصيد قبل الدفعة</small><b>{money(balanceBefore)}</b></div><div><small>التوزيع</small><b>أقدم فاتورة ثم التي تليها</b></div><div><small>الرصيد بعد الدفعة</small><b>{money(balanceAfter)}</b></div></div>}
    {noteActions.includes(request.action) && <label className="field full"><span>ملاحظات</span><input name="note" maxLength={request.action === 'إضافة ذمة' ? 300 : 4000}/></label>}
    <div className="form-actions full"><button type="button" className="btn ghost" disabled={mutating} onClick={onClose}>إلغاء</button><button type="submit" className="btn primary" disabled={mutating}>{mutating ? 'جاري الحفظ…' : 'حفظ'}</button></div>
  </form>}</section></div>
}

function CategorySelect({ defaultValue = 'تشغيل' }: { defaultValue?: string }) {
  return <select name="category" defaultValue={defaultValue}><option>تشغيل</option><option>رواتب</option><option>أجار</option><option>خدمات</option><option>برامج</option><option>استضافة</option><option>أخرى</option></select>
}

function ReadOnlySummary({ label, value, help }: { label: string; value: string; help: string }) {
  return <><label className="field"><span>{label}</span><input value={value} readOnly/></label><div className="field-help">{help}</div></>
}

function UserGuide({ step, onStep, onClose }: { step: number; onStep: (step: number) => void; onClose: () => void }) {
  const current = guideSteps[step]
  const isLast = step === guideSteps.length - 1
  return <div className="guide-overlay" role="presentation">
    <section className="guide-dialog" role="dialog" aria-modal="true" aria-labelledby="guide-title">
      <button className="guide-close" onClick={onClose} aria-label="إغلاق دليل الاستخدام">×</button>
      <div className="guide-visual"><span>{current.symbol}</span><small>OZMO FINANCE</small></div>
      <div className="guide-content">
        <span className="guide-kicker">{current.kicker}</span>
        <h2 id="guide-title">{current.title}</h2>
        <p>{current.description}</p>
        <ul>{current.points.map(point => <li key={point}>{point}</li>)}</ul>
        <div className="guide-progress" aria-label={`الخطوة ${step + 1} من ${guideSteps.length}`}>
          {guideSteps.map((_, index) => <i className={index === step ? 'active' : ''} key={index}/>) }
          <span>{step + 1} / {guideSteps.length}</span>
        </div>
        <div className="guide-actions">
          {step > 0 ? <button className="btn ghost" onClick={() => onStep(step - 1)}>السابق</button> : <button className="guide-skip" onClick={onClose}>تخطي الجولة</button>}
          <button className="btn primary" onClick={() => isLast ? onClose() : onStep(step + 1)}>{isLast ? 'ابدأ استخدام النظام' : 'التالي'}</button>
        </div>
      </div>
    </section>
  </div>
}

export default function Home() {
  const [view, setView] = useState<View>('dashboard')
  const [data, setData] = useState<FinanceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [mutating, setMutating] = useState(false)
  const [mutationError, setMutationError] = useState('')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [guideStep, setGuideStep] = useState(0)
  const [actionRequest, setActionRequest] = useState<ActionRequest | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const response = await fetch('/api/finance', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      setData(await readFinanceResponse(response))
    } catch (error) {
      setLoadError(requestErrorMessage(error, 'تعذّر تحميل البيانات المالية.'))
      throw error
    } finally {
      setLoading(false)
    }
  }, [])

  const runCommand = useCallback(async (command: FinanceCommandInput) => {
    setMutating(true)
    setMutationError('')
    try {
      const response = await fetch('/api/finance', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(command),
      })
      setData(await readFinanceResponse(response))
    } catch (error) {
      const message = requestErrorMessage(error, 'تعذّر حفظ العملية.')
      setMutationError(message)
      throw new Error(message)
    } finally {
      setMutating(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch(() => undefined)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refresh])
  useEffect(() => {
    if (window.localStorage.getItem('ozmo-finance-guide-seen') === 'yes') return
    const timer = window.setTimeout(() => setGuideOpen(true), 0)
    return () => window.clearTimeout(timer)
  }, [])
  useEffect(() => {
    const open = (event: Event) => setActionRequest((event as CustomEvent<ActionRequest>).detail)
    window.addEventListener('ozmo-open-action', open)
    return () => window.removeEventListener('ozmo-open-action', open)
  }, [])
  const closeGuide = () => {
    window.localStorage.setItem('ozmo-finance-guide-seen', 'yes')
    setGuideOpen(false)
    setGuideStep(0)
  }
  const openGuide = () => {
    setGuideStep(0)
    setGuideOpen(true)
    setMobileOpen(false)
  }

  if (!data) {
    return <main className="app-shell"><section className="workspace" style={{ marginRight: 0, maxWidth: 760, marginInline: 'auto', paddingTop: 100 }}><section className="panel settings-card"><span className="eyebrow">OZMO Finance</span><h1>{loading ? 'جاري تحميل البيانات…' : 'تعذّر الاتصال بقاعدة البيانات'}</h1><p>{loading ? 'يتم الآن قراءة أحدث الأرصدة والسجلات من PostgreSQL.' : loadError}</p>{!loading && <button className="btn primary" onClick={() => void refresh().catch(() => undefined)}>إعادة المحاولة</button>}</section></section></main>
  }

  const content: Record<View, React.ReactNode> = {
    dashboard: <LocalDashboard changeView={setView}/>, subscriptions: <LocalSubscriptions/>, clients: <LocalClients/>, income: <LocalIncome/>, expenses: <LocalExpenses/>, liabilities: <LocalLiabilities/>, payroll: <LocalPayroll/>, advances: <LocalAdvances/>, cashbox: <LocalCashbox/>, reports: <LocalReports/>, settings: <LocalSettings/>,
  }
  return <FinanceContext.Provider value={{ data, mutating, mutationError, refresh, runCommand }}><main className="app-shell">
    <button className="mobile-menu" onClick={() => setMobileOpen(!mobileOpen)} aria-label="فتح القائمة">☰</button>
    {mobileOpen && <button className="backdrop" onClick={() => setMobileOpen(false)} aria-label="إغلاق القائمة"/>}
    <aside className={mobileOpen ? 'sidebar open' : 'sidebar'}>
      <div className="brand"><span className="logo-frame"><Image src="/logo-ozmo.png" alt="OZMO" width={192} height={108} priority/></span><div><b>OZMO</b><span>FINANCE CONTROL</span></div></div>
      <nav>{navigation.map(item => { const overdue = data.clients.filter(client => client.status === 'متأخر').length; return <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => { setView(item.id); setMobileOpen(false) }}><Icon name={item.icon}/><span>{item.label}</span>{item.id === 'subscriptions' && overdue > 0 && <em>{overdue}</em>}</button> })}</nav>
      <button className="guide-launcher" onClick={openGuide}><span>؟</span><div><b>دليل الاستخدام</b><small>شرح سريع للنظام</small></div></button>
      <div className="owner"><span>GK</span><div><b>المالك</b><small>صلاحية كاملة</small></div><i>•••</i></div>
    </aside>
    <section className="workspace">{mutationError && <div className="notice error-notice" role="alert">{mutationError}</div>}{loadError && <div className="notice error-notice" role="alert">{loadError}</div>}{content[view]}<footer><span>OZMO Finance V2</span><span>البيانات محفوظة مركزيًا في PostgreSQL</span></footer></section>
    {guideOpen && <UserGuide step={guideStep} onStep={setGuideStep} onClose={closeGuide}/>} 
    {actionRequest && <LocalActionDialog request={actionRequest} onClose={() => setActionRequest(null)}/>} 
  </main></FinanceContext.Provider>
}
