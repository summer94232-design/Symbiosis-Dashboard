import { useState, useEffect, useRef } from 'react'
import { getDocs, addDoc, deleteDoc, updateDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { calcPositions, type TradeRecord } from '../../lib/calc'
import { fetchTrades, fetchDividends, invalidateDividends } from '../../lib/investData'
import { FOMC_DATES, TECH_EVENTS, getFuturesSettlementDates, EVENT_COLORS, EVENT_LABELS, type CalendarEvent } from '../../lib/calendarData'
import { Plus, X, ChevronLeft, ChevronRight, ExternalLink, Upload, Pencil, RefreshCw, UploadCloud } from 'lucide-react'
import { getGoogleCalendarAuth, performGoogleCalendarSync, type SyncSummary } from '../../lib/googleCalendar'
import * as XLSX from 'xlsx'
import { fetchCalendarEvents, fetchTasks, invalidateCalendarEvents } from '../../lib/plannerData'
import { addInvestorMeetingDates, fetchInvestorMeetings, removeInvestorMeetingDate } from '../../lib/investorMeetings'

const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 12px', color: 'var(--c-text)', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

// Excel 序列日期 → YYYY-MM-DD
const excelSerialToDate = (serial: number): string => {
    const utc_days = Math.floor(serial - 25569)
    const date = new Date(utc_days * 86400 * 1000)
    const y = date.getUTCFullYear()
    const m = String(date.getUTCMonth() + 1).padStart(2, '0')
    const d = String(date.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

export default function CalendarHome() {
    const today = new Date()
    const [year, setYear] = useState(today.getFullYear())
    const [month, setMonth] = useState(today.getMonth() + 1)
    const [events, setEvents] = useState<CalendarEvent[]>([])
    const [personalEvents, setPersonalEvents] = useState<CalendarEvent[]>([])
    const [dividendEvents, setDividendEvents] = useState<CalendarEvent[]>([])
    const [investorEvents, setInvestorEvents] = useState<CalendarEvent[]>([])
    const [taskEvents, setTaskEvents] = useState<CalendarEvent[]>([])
    const [selectedDay, setSelectedDay] = useState<string | null>(null)
    const [showForm, setShowForm] = useState(false)
    const [showXlsxImport, setShowXlsxImport] = useState(false)
    const [loadingYahoo, setLoadingYahoo] = useState(false)
    const [investorError, setInvestorError] = useState<string | null>(null)
    const [investorInfo, setInvestorInfo] = useState<string | null>(null)
    const [xlsxImporting, setXlsxImporting] = useState(false)
    const watchListRef = useRef<{ code: string; name: string }[]>([])
    const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set(['fomc', 'futures', 'tech', 'investor', 'personal', 'dividend', 'shareholder']))
    const [myStocksOnly, setMyStocksOnly] = useState(true)
    const [myStockCodes, setMyStockCodes] = useState<Set<string>>(new Set())
    const [form, setForm] = useState({ title: '', date: '', description: '', url: '', type: 'personal' as CalendarEvent['type'] })
    const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null)
    const [gcalSyncing, setGcalSyncing] = useState(false)
    const [gcalStage, setGcalStage] = useState<string | null>(null)

    const loadPersonal = async () => {
        // 讀取所有手動建立的行程（不限 type，支援 personal / tech / fomc / dividend / shareholder 等）
        setPersonalEvents(await fetchCalendarEvents<CalendarEvent>())
    }

    const loadWatchList = async () => {
        // ✅ 1-1：trades 改走共用快取層（lib/investData）
        const [watchSnap, trades] = await Promise.all([
            getDocs(userCol(investDB, 'calendarWatchList')),
            fetchTrades<TradeRecord>('asc'),
        ])
        const list = watchSnap.docs.map(d => ({
            code: d.data().code || d.id,
            name: d.data().name || d.data().code || d.id
        }))
        watchListRef.current = list
        refreshMyStockCodes(trades, list.map(w => w.code))
    }

    const refreshMyStockCodes = (trades: TradeRecord[], watchCodes?: string[]) => {
        try {
            const { holdings } = calcPositions(trades)
            const holdingCodes = Object.keys(holdings).filter(c => holdings[c].shares > 0)
            const wl = watchCodes ?? watchListRef.current.map(w => w.code)
            setMyStockCodes(new Set([...holdingCodes, ...wl]))
        } catch { /* ignore */ }
    }

    const loadDividends = async () => {
        // ✅ 1-1：改走共用快取層（lib/investData）
        const divs = await fetchDividends<Record<string, any>>('asc')
        const divEvents: CalendarEvent[] = divs
            .filter(d => d.date)
            .map(d => ({
                id: `div-${d.code}-${d.date}`,
                date: d.date,
                title: `${d.name || d.code} 除權息`,
                type: 'dividend' as const,
                stockCode: d.code,
                description: `現金股利：${d.cashDividend || 0} 元`
            }))
        setDividendEvents(divEvents)
    }

    const loadTasks = async () => {
        const rows = await fetchTasks<{ createdAt: string; dueDate?: string; done: boolean; title: string; priority: string }>()
        const taskEvts: CalendarEvent[] = rows
            .filter(t => t.dueDate && !t.done)
            .map(t => ({
                id: `task-${t.createdAt}`,
                date: t.dueDate!,
                title: `📋 ${t.title}`,
                type: 'personal' as const,
                description: `優先級：${{ high: '高', medium: '中', low: '低' }[t.priority as string] || '中'}`
            }))
        setTaskEvents(taskEvts)
    }

    // 全域法說會由後端維護；前端讀取時合併目前使用者的新增／隱藏 override。
    const loadInvestorFromFirestore = async (y: number, m: number) => {
        const yearMonth = `${y}-${String(m).padStart(2, '0')}`

        try {
            const rows = await fetchInvestorMeetings([yearMonth])
            const evtMap = new Map<string, CalendarEvent>()

            rows.forEach(data => {
                const dates = data.dates
                dates.forEach((isoDate: string) => {
                    const id = `investor-${data.stockCode}-${isoDate}`
                    if (!evtMap.has(id)) {
                        evtMap.set(id, {
                            id,
                            date: isoDate,
                            title: `${data.stockName || data.stockCode} 法說會`,
                            type: 'investor',
                            stockCode: data.stockCode,
                            description: `${data.stockName || data.stockCode}（${data.stockCode}）法人說明會`
                        })
                    }
                })
            })

            setInvestorEvents([...evtMap.values()])
        } catch (err) {
            console.error('loadInvestorFromFirestore 錯誤：', err)
        }
    }

    // ── 從 Yahoo 台股行事曆整頁抓取全市場法說會（手動觸發）──────────────
    const loadYahooCalendar = async () => {
        setLoadingYahoo(true)
        setInvestorError(null)
        setInvestorInfo(null)

        try {
            const res = await fetch('/.netlify/functions/yahoo-calendar-proxy')
            if (!res.ok) throw new Error(`proxy HTTP ${res.status}`)

            const json = await res.json()
            if (json.error) throw new Error(json.error)

            const list: { code: string; name: string; date: string }[] = Array.isArray(json.events) ? json.events : []
            if (list.length === 0) {
                setInvestorInfo('未從 Yahoo 取得任何法說會資料（可能該時段無排程）')
                setLoadingYahoo(false)
                return
            }

            // Yahoo 手動更新只寫入目前使用者的 override，不再改動全域共享資料。
            const groups = new Map<string, { stockCode: string; stockName: string; yearMonth: string; dates: Set<string> }>()
            for (const ev of list) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) continue
                const ym = ev.date.slice(0, 7)          // YYYY-MM
                const docId = `${ev.code}-${ym}`
                if (!groups.has(docId)) {
                    groups.set(docId, { stockCode: ev.code, stockName: ev.name || ev.code, yearMonth: ym, dates: new Set() })
                }
                groups.get(docId)!.dates.add(ev.date)
            }

            const changed = await addInvestorMeetingDates([...groups.values()].map(group => ({
                ...group,
                dates: [...group.dates],
            })))

            await loadInvestorFromFirestore(year, month)
            setInvestorInfo(`✅ Yahoo 法說會更新完成：抓到 ${list.length} 筆，已寫入 ${changed} 組個人資料；全域資料未被修改`)
        } catch (err) {
            console.error('loadYahooCalendar 失敗：', err)
            setInvestorError(`Yahoo 法說會更新失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
        }

        setLoadingYahoo(false)
    }

    // ── xlsx 手動匯入法說會（寫入個人 override）────────────────────────
    const handleXlsxImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        setXlsxImporting(true)

        const reader = new FileReader()
        reader.onload = async (evt) => {
            try {
                const data = new Uint8Array(evt.target!.result as ArrayBuffer)
                // raw: true 保留原始值（含 Excel 序列數字），不讓 SheetJS 自動轉換
                const wb = XLSX.read(data, { type: 'array', cellDates: false })
                const sheet = wb.Sheets[wb.SheetNames[0]]
                const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '', raw: true })

                const byDoc: Record<string, { stockCode: string; stockName: string; yearMonth: string; dates: Set<string> }> = {}

                for (const row of rows) {
                    const code = String(row['股票代號'] || row['代號'] || row['code'] || '').trim()
                    const name = String(row['股票名稱'] || row['名稱'] || row['name'] || code).trim()
                    const rawDate = row['法說會日期'] || row['日期'] || row['date'] || ''

                    // ✅ 同時支援 Excel 序列數字 和 文字日期
                    let isoDate = ''
                    const num = Number(rawDate)
                    if (!isNaN(num) && num > 40000) {
                        // Excel 序列日期（如 46175）
                        isoDate = excelSerialToDate(num)
                    } else {
                        // 文字日期（如 2026-05-18 或 2026/05/18）
                        isoDate = String(rawDate).slice(0, 10).replace(/\//g, '-')
                    }

                    if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) continue

                    const [y, m] = isoDate.split('-')
                    const yearMonth = `${y}-${m}`
                    const docId = `${code}-${yearMonth}`

                    if (!byDoc[docId]) {
                        byDoc[docId] = { stockCode: code, stockName: name, yearMonth, dates: new Set() }
                    }
                    byDoc[docId].dates.add(isoDate)
                }

                const written = await addInvestorMeetingDates(Object.values(byDoc).map(info => ({
                    stockCode: info.stockCode,
                    stockName: info.stockName,
                    yearMonth: info.yearMonth,
                    dates: [...info.dates],
                })))

                setInvestorInfo(`✅ xlsx 匯入完成，已寫入 ${written} 組個人法說會資料`)
                setShowXlsxImport(false)
                await loadInvestorFromFirestore(year, month)
            } catch (err) {
                console.error('xlsx 匯入失敗：', err)
                setInvestorError('xlsx 匯入失敗，請確認欄位格式（股票代號、股票名稱、法說會日期）')
            }
            setXlsxImporting(false)
            e.target.value = ''
        }
        reader.readAsArrayBuffer(file)
    }

    // ── 雙向同步「未來半年」的行事曆事件（手動觸發）────────────────────
    const handleSyncGoogleCalendar = async () => {
        setInvestorError(null)
        setInvestorInfo(null)

        const auth = await getGoogleCalendarAuth()
        if (!auth) {
            setInvestorError('尚未連結 Google 帳號，請先到「行事曆設定」頁面連結')
            return
        }

        setGcalSyncing(true)
        setGcalStage('準備中')
        try {
            const summary: SyncSummary = await performGoogleCalendarSync(auth, stage => setGcalStage(stage))
            // 同步可能從 Google 新增、更新或刪除 Firestore 行程；立即重讀，
            // 避免畫面繼續顯示同步前的 React state，必須重開頁面才更新。
            invalidateCalendarEvents()
            await loadPersonal()

            const parts: string[] = []
            if (summary.pushedCreated > 0) parts.push(`推送新增 ${summary.pushedCreated} 筆`)
            if (summary.pushedUpdated > 0) parts.push(`推送更新 ${summary.pushedUpdated} 筆`)
            if (summary.pushedDeleted > 0) parts.push(`推送刪除 ${summary.pushedDeleted} 筆`)
            if (summary.pulledCreated > 0) parts.push(`從 Google 新增 ${summary.pulledCreated} 筆`)
            if (summary.pulledUpdated > 0) parts.push(`從 Google 更新 ${summary.pulledUpdated} 筆`)
            if (summary.pulledDeleted > 0) parts.push(`從 Google 刪除 ${summary.pulledDeleted} 筆`)
            if (summary.failed > 0) parts.push(`失敗 ${summary.failed} 筆`)
            const message = parts.length > 0 ? parts.join('、') : '沒有需要異動的事件'

            setInvestorInfo(`✅ Google 行事曆同步完成：${message}`)
            if (summary.errors.length > 0) {
                console.error('[Google Calendar 同步錯誤]', summary.errors)
            }
        } catch (err) {
            console.error('handleSyncGoogleCalendar 失敗：', err)
            setInvestorError(`Google 行事曆同步失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
        }
        setGcalSyncing(false)
        setGcalStage(null)
    }

    // ✅ 修正 Bug 1：mount 時只載入一次靜態資料，不再重複呼叫 loadInvestorFromFirestore
    useEffect(() => {
        loadPersonal()
        loadDividends()
        loadTasks()
        loadWatchList()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // ✅ year/month 變動時（含初始 mount）統一由這個 useEffect 負責載入法說會
    useEffect(() => {
        loadInvestorFromFirestore(year, month)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [year, month])

    useEffect(() => {
        const futuresDates = getFuturesSettlementDates(year, month)
        const filteredInvestor = myStocksOnly
            ? investorEvents.filter(e => e.stockCode && myStockCodes.has(e.stockCode))
            : investorEvents
        const allEvents = [
            ...FOMC_DATES,
            ...TECH_EVENTS,
            ...futuresDates,
            ...personalEvents,
            ...dividendEvents,
            ...filteredInvestor,
            ...taskEvents,
        ].filter(e => filterTypes.has(e.type))
        setEvents(allEvents)
    }, [year, month, personalEvents, dividendEvents, investorEvents, taskEvents, filterTypes, myStocksOnly, myStockCodes])

    const toggleFilter = (type: string) => {
        setFilterTypes(prev => {
            const next = new Set(prev)
            if (next.has(type)) next.delete(type); else next.add(type)
            return next
        })
    }

    const handleAddEvent = async () => {
        if (!form.title || !form.date) return
        const type = form.type

        if (type === 'investor') {
            const [y, m] = form.date.split('-')
            const yearMonth = `${y}-${m}`
            const stockCode = form.title.match(/^(\d{4,6})/)?.[1] || form.title
            await addInvestorMeetingDates([{
                stockCode,
                stockName: form.title,
                yearMonth,
                dates: [form.date],
            }])
            await loadInvestorFromFirestore(year, month)
        } else {
            // 其餘類型（personal, fomc, tech, dividend, shareholder, futures）全寫入 calendarEvents
            await addDoc(userCol(investDB, 'calendarEvents'), {
                title: form.title,
                date: form.date,
                description: form.description,
                url: form.url,
                type,
                updatedAt: new Date().toISOString(),
            })
            invalidateCalendarEvents()
            loadPersonal()
        }

        setForm({ title: '', date: '', description: '', url: '', type: 'personal' })
        setShowForm(false)
    }

    const handleDeleteEvent = async (id: string) => {
        if (!confirm('確定要刪除此行程？')) return
        await deleteDoc(userDoc(investDB, 'calendarEvents', id))
        invalidateCalendarEvents()
        loadPersonal()
    }

    const handleEditEvent = (ev: CalendarEvent) => {
        setEditingEvent(ev)
        setForm({ title: ev.title, date: ev.date, description: ev.description || '', url: ev.url || '', type: ev.type })
    }

    const handleUpdateEvent = async () => {
        if (!editingEvent || !form.title || !form.date) return
        await updateDoc(userDoc(investDB, 'calendarEvents', editingEvent.id), {
            title: form.title,
            date: form.date,
            description: form.description,
            url: form.url,
            type: form.type,
            updatedAt: new Date().toISOString(),
        })
        invalidateCalendarEvents()
        setEditingEvent(null)
        setForm({ title: '', date: '', description: '', url: '', type: 'personal' })
        loadPersonal()
    }

    // 全域資料不刪除；在目前使用者的 override 中隱藏該日期。
    const handleDeleteInvestorDate = async (stockCode: string, isoDate: string) => {
        if (!confirm(`確定要刪除 ${stockCode} 在 ${isoDate} 的法說會？`)) return
        const event = investorEvents.find(item => item.stockCode === stockCode && item.date === isoDate)
        const stockName = event?.title.replace(/\s*法說會$/, '') || stockCode
        await removeInvestorMeetingDate(stockCode, stockName, isoDate)
        await loadInvestorFromFirestore(year, month)
    }

    const handleDeleteDividend = async (ev: CalendarEvent) => {
        if (!confirm(`確定要刪除 ${ev.title}？`)) return
        // ✅ 1-1：改走共用快取層找出對應文件 id（快取資料已含 id）
        const divs = await fetchDividends<{ id: string; code?: string; date?: string }>('asc')
        const match = divs.find(d => d.code === ev.stockCode && d.date === ev.date)
        if (match) {
            await deleteDoc(userDoc(investDB, 'dividends', match.id))
            invalidateDividends()   // ✅ 1-1：寫入後清快取
            loadDividends()
        }
    }

    const prevMonth = () => { if (month === 1) { setYear(y => y - 1); setMonth(12) } else setMonth(m => m - 1) }
    const nextMonth = () => { if (month === 12) { setYear(y => y + 1); setMonth(1) } else setMonth(m => m + 1) }

    const firstDay = new Date(year, month - 1, 1).getDay()
    const daysInMonth = new Date(year, month, 0).getDate()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const getDateStr = (d: number) => `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const getEventsForDate = (d: number) => events.filter(e => e.date === getDateStr(d))
    const selectedEvents = selectedDay ? events.filter(e => e.date === selectedDay) : []

    return (
        <>
            <style>{`
        .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
        .cal-day { min-height: 80px; padding: 6px; border-radius: 6px; cursor: pointer; transition: background 0.15s; position: relative; }
        .cal-day:hover { background: rgba(79,142,247,0.06); }
        .cal-day.today { background: rgba(79,142,247,0.10); }
        .cal-day.selected { background: rgba(79,142,247,0.15); outline: 1px solid var(--c-accent); }
        @media (max-width: 768px) { .cal-day { min-height: 56px; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1400px', margin: '0 auto' }}>

                {/* 標題列 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>財經行事曆</h1>
                    <div className="page-actions calendar-actions" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button className="calendar-secondary-action" onClick={loadYahooCalendar} disabled={loadingYahoo}
                            style={{ ...btn('#7c5cff'), opacity: loadingYahoo ? 0.6 : 1 }}
                            title="從 Yahoo 股市台股行事曆抓取全市場法說會並更新">
                            <RefreshCw size={14} style={loadingYahoo ? { animation: 'spin 1s linear infinite' } : undefined} />
                            {loadingYahoo ? '抓取中…' : '抓取法說會'}
                        </button>
                        <button className="calendar-secondary-action" onClick={() => setShowXlsxImport(true)} style={btn('var(--c-border)')} title="從 xlsx 手動匯入法說會日期">
                            <Upload size={14} />匯入法說會
                        </button>
                        <button className="calendar-secondary-action" onClick={handleSyncGoogleCalendar} disabled={gcalSyncing}
                            style={{ ...btn('#4285f4'), opacity: gcalSyncing ? 0.6 : 1 }}
                            title="把未來半年的行事曆事件同步到 Google 行事曆">
                            <UploadCloud size={14} style={gcalSyncing ? { animation: 'spin 1s linear infinite' } : undefined} />
                            {gcalSyncing ? (gcalStage || '同步中…') : '同步到 Google'}
                        </button>
                        <button className="calendar-primary-action" onClick={() => setShowForm(true)} style={btn('var(--c-accent)')}>
                            <Plus size={14} />新增行程
                        </button>
                        <details className="calendar-mobile-more">
                            <summary>更多操作</summary>
                            <div className="calendar-mobile-more-panel">
                                <button onClick={loadYahooCalendar} disabled={loadingYahoo} style={{ ...btn('#7c5cff'), opacity: loadingYahoo ? 0.6 : 1 }}>
                                    <RefreshCw size={14} />{loadingYahoo ? '抓取中…' : '抓取法說會'}
                                </button>
                                <button onClick={() => setShowXlsxImport(true)} style={btn('var(--c-border)')}>
                                    <Upload size={14} />匯入法說會
                                </button>
                                <button onClick={handleSyncGoogleCalendar} disabled={gcalSyncing} style={{ ...btn('#4285f4'), opacity: gcalSyncing ? 0.6 : 1 }}>
                                    <UploadCloud size={14} />{gcalSyncing ? (gcalStage || '同步中…') : '同步到 Google'}
                                </button>
                            </div>
                        </details>
                    </div>
                </div>

                {/* 錯誤 / 成功提示 */}
                {investorError && (
                    <div style={{ backgroundColor: 'rgba(255,180,0,0.10)', border: '1px solid rgba(255,180,0,0.35)', borderRadius: '8px', padding: '10px 16px', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '13px', color: 'var(--c-warning)' }}>⚠️ {investorError}</span>
                        <button onClick={() => setInvestorError(null)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={14} /></button>
                    </div>
                )}
                {investorInfo && (
                    <div style={{ backgroundColor: 'rgba(0,200,150,0.10)', border: '1px solid rgba(0,200,150,0.35)', borderRadius: '8px', padding: '10px 16px', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '13px', color: 'var(--c-positive)' }}>{investorInfo}</span>
                        <button onClick={() => setInvestorInfo(null)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={14} /></button>
                    </div>
                )}

                {/* 篩選器 */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                    {Object.entries(EVENT_LABELS).map(([type, label]) => (
                        <button key={type} onClick={() => toggleFilter(type)}
                            style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 12px', borderRadius: '20px', border: '1px solid', borderColor: filterTypes.has(type) ? EVENT_COLORS[type] : 'var(--c-border)', backgroundColor: filterTypes.has(type) ? `${EVENT_COLORS[type]}18` : 'transparent', color: filterTypes.has(type) ? EVENT_COLORS[type] : 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: EVENT_COLORS[type], display: 'inline-block' }} />
                            {label}
                        </button>
                    ))}
                </div>

                {/* 法說會篩選：只顯示我的股票 */}
                {filterTypes.has('investor') && (
                    <div style={{ marginBottom: '16px' }}>
                        <button
                            onClick={() => setMyStocksOnly(v => !v)}
                            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 14px', borderRadius: '20px', border: `1px solid ${myStocksOnly ? 'var(--c-positive)' : 'var(--c-border)'}`, backgroundColor: myStocksOnly ? 'rgba(0,200,150,0.12)' : 'transparent', color: myStocksOnly ? 'var(--c-positive)' : 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>
                            <span style={{ width: '28px', height: '15px', borderRadius: '8px', backgroundColor: myStocksOnly ? 'var(--c-positive)' : 'var(--c-border)', display: 'inline-flex', alignItems: 'center', padding: '2px', transition: 'background 0.2s', flexShrink: 0 }}>
                                <span style={{ width: '11px', height: '11px', borderRadius: '50%', backgroundColor: '#fff', transform: myStocksOnly ? 'translateX(13px)' : 'translateX(0)', transition: 'transform 0.2s', display: 'block' }} />
                            </span>
                            法說會：只顯示持倉 &amp; 關注清單的股票
                        </button>
                    </div>
                )}

                <div className="calendar-layout" style={{ display: 'grid', gap: '16px', gridTemplateColumns: selectedDay ? '1fr 300px' : '1fr' }}>
                    {/* 月曆 */}
                    <div style={card}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                            <button onClick={prevMonth} style={{ background: 'none', border: 'none', color: 'var(--c-text)', cursor: 'pointer', display: 'flex', padding: '6px' }}><ChevronLeft size={20} /></button>
                            <span style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-text)' }}>{year} 年 {month} 月</span>
                            <button onClick={nextMonth} style={{ background: 'none', border: 'none', color: 'var(--c-text)', cursor: 'pointer', display: 'flex', padding: '6px' }}><ChevronRight size={20} /></button>
                        </div>

                        <div className="cal-grid" style={{ marginBottom: '4px' }}>
                            {WEEKDAYS.map(d => (
                                <div key={d} style={{ textAlign: 'center', fontSize: '12px', color: 'var(--c-muted)', padding: '4px', fontWeight: 600 }}>{d}</div>
                            ))}
                        </div>

                        <div className="cal-grid">
                            {Array.from({ length: firstDay }).map((_, i) => <div key={`empty-${i}`} />)}
                            {Array.from({ length: daysInMonth }).map((_, i) => {
                                const d = i + 1
                                const dateStr = getDateStr(d)
                                const dayEvents = getEventsForDate(d)
                                const isToday = dateStr === todayStr
                                const isSelected = dateStr === selectedDay
                                const isWeekend = new Date(year, month - 1, d).getDay() === 0 || new Date(year, month - 1, d).getDay() === 6
                                return (
                                    <div key={d} className={`cal-day${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`}
                                        onClick={() => setSelectedDay(isSelected ? null : dateStr)}>
                                        <div style={{ fontSize: '13px', fontWeight: isToday ? 700 : 400, color: isToday ? 'var(--c-accent)' : isWeekend ? 'var(--c-danger)' : 'var(--c-text)', marginBottom: '4px' }}>{d}</div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                            {dayEvents.slice(0, 3).map(ev => (
                                                <div key={ev.id} className="cal-event-chip" title={ev.title} style={{ fontSize: '10px', backgroundColor: `${EVENT_COLORS[ev.type]}22`, color: EVENT_COLORS[ev.type], borderRadius: '3px', padding: '1px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {ev.title}
                                                </div>
                                            ))}
                                            {dayEvents.length > 3 && <div className="cal-more-count" style={{ fontSize: '10px', color: 'var(--c-muted)' }}>+{dayEvents.length - 3} 更多</div>}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    {/* 右側事件詳情 */}
                    {selectedDay && (
                        <div style={card}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>{selectedDay.replace(/-/g, '/')}</span>
                                <button onClick={() => setSelectedDay(null)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={16} /></button>
                            </div>
                            {selectedEvents.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)', fontSize: '13px' }}>這天沒有事件</div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {selectedEvents.map(ev => (
                                        <div key={ev.id} style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '12px', borderLeft: `3px solid ${EVENT_COLORS[ev.type]}` }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                                                <div style={{ flex: 1 }}>
                                                    <div style={{ fontSize: '12px', color: EVENT_COLORS[ev.type], fontWeight: 600, marginBottom: '4px' }}>{EVENT_LABELS[ev.type]}</div>
                                                    <div style={{ fontSize: '13px', color: 'var(--c-text)', fontWeight: 600, marginBottom: '4px' }}>{ev.title}</div>
                                                    {ev.description && <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>{ev.description}</div>}
                                                </div>
                                                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                                                    {ev.url && (
                                                        <a href={ev.url} target="_blank" rel="noopener noreferrer"
                                                            style={{ color: 'var(--c-accent)', display: 'flex' }}><ExternalLink size={14} /></a>
                                                    )}
                                                    {/* 手動建立的行程（存在 calendarEvents collection）才顯示編輯／刪除鈕 */}
                                                    {['personal', 'tech', 'fomc', 'dividend', 'shareholder', 'futures'].includes(ev.type) && ev.id && !ev.id.startsWith('fomc-') && !ev.id.startsWith('gtc-') && !ev.id.startsWith('wwdc-') && !ev.id.startsWith('build-') && !ev.id.startsWith('google-io-') && !ev.id.startsWith('ces-') && !ev.id.startsWith('futures-') && !ev.id.startsWith('div-') && (
                                                        <>
                                                            <button onClick={() => handleEditEvent(ev)}
                                                                style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', padding: 0 }}
                                                                title="編輯此行程">
                                                                <Pencil size={13} />
                                                            </button>
                                                            <button onClick={() => handleDeleteEvent(ev.id)}
                                                                style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer', padding: 0 }}
                                                                title="刪除此行程">
                                                                <X size={14} />
                                                            </button>
                                                        </>
                                                    )}
                                                    {ev.type === 'investor' && ev.stockCode && (
                                                        <button onClick={() => handleDeleteInvestorDate(ev.stockCode!, ev.date)}
                                                            style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer', padding: 0 }}
                                                            title="刪除此法說會日期">
                                                            <X size={14} />
                                                        </button>
                                                    )}
                                                    {ev.type === 'dividend' && (
                                                        <button onClick={() => handleDeleteDividend(ev)}
                                                            style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer', padding: 0 }}
                                                            title="刪除此除權息記錄">
                                                            <X size={14} />
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <button onClick={() => { setForm(f => ({ ...f, date: selectedDay, type: 'personal' })); setShowForm(true) }}
                                style={{ ...btn('var(--c-border)'), border: '1px solid var(--c-border)', width: '100%', justifyContent: 'center', marginTop: '12px', fontSize: '13px' }}>
                                <Plus size={13} />新增行程到這天
                            </button>
                        </div>
                    )}
                </div>

                {/* 編輯行程 Modal */}
                {editingEvent && (
                    <div className="mobile-modal" style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                        <div style={{ ...card, width: '100%', maxWidth: '480px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                                <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--c-text)' }}>編輯行程</span>
                                <button onClick={() => setEditingEvent(null)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={18} /></button>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                                {/* 類型選擇 */}
                                <div>
                                    <label style={lbl}>類型 *</label>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                        {([
                                            ['personal', '個人行程'],
                                            ['tech', '科技活動'],
                                            ['fomc', 'FOMC'],
                                            ['dividend', '除權息'],
                                            ['shareholder', '股東會'],
                                        ] as [CalendarEvent['type'], string][]).map(([t, label]) => (
                                            <button key={t} onClick={() => setForm(f => ({ ...f, type: t }))}
                                                style={{
                                                    padding: '5px 14px', borderRadius: '20px', border: `1px solid`,
                                                    borderColor: form.type === t ? EVENT_COLORS[t] : 'var(--c-border)',
                                                    backgroundColor: form.type === t ? `${EVENT_COLORS[t]}22` : 'transparent',
                                                    color: form.type === t ? EVENT_COLORS[t] : 'var(--c-muted)',
                                                    fontSize: '12px', cursor: 'pointer', fontWeight: form.type === t ? 600 : 400,
                                                    display: 'flex', alignItems: 'center', gap: '5px'
                                                }}>
                                                <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: EVENT_COLORS[t], display: 'inline-block' }} />
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <label style={lbl}>標題 *</label>
                                    <input style={inp} placeholder="行程標題" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
                                </div>
                                <div>
                                    <label style={lbl}>日期 *</label>
                                    <input type="date" style={inp} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
                                </div>
                                <div>
                                    <label style={lbl}>備註</label>
                                    <input style={inp} placeholder="備註說明" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                                </div>
                                <div>
                                    <label style={lbl}>連結</label>
                                    <input style={inp} placeholder="https://..." value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: '8px', marginTop: '20px', justifyContent: 'flex-end' }}>
                                <button style={btn('var(--c-border)')} onClick={() => setEditingEvent(null)}><X size={14} />取消</button>
                                <button style={{ ...btn(EVENT_COLORS[form.type] || 'var(--c-accent)') }} onClick={handleUpdateEvent}><Pencil size={14} />儲存</button>
                            </div>
                        </div>
                    </div>
                )}

                {/* xlsx 匯入法說會 Modal */}
                {showXlsxImport && (
                    <div className="mobile-modal" style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                        <div style={{ ...card, width: '100%', maxWidth: '520px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--c-text)' }}>手動匯入法說會日期</span>
                                <button onClick={() => setShowXlsxImport(false)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={18} /></button>
                            </div>
                            <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', border: '1px solid var(--c-border)', fontSize: '12px', color: 'var(--c-muted)', lineHeight: 1.8 }}>
                                <span style={{ color: 'var(--c-accent)', fontWeight: 600 }}>支援 .xlsx / .xls 格式，必要欄位（順序不限）：</span><br />
                                <span style={{ color: 'var(--c-text)' }}>股票代號</span>、<span style={{ color: 'var(--c-text)' }}>股票名稱</span>、<span style={{ color: 'var(--c-text)' }}>法說會日期</span><br />
                                日期格式：<span style={{ color: 'var(--c-positive)' }}>YYYY-MM-DD</span>、<span style={{ color: 'var(--c-positive)' }}>YYYY/MM/DD</span> 或 <span style={{ color: 'var(--c-positive)' }}>Excel 日期格式</span> 皆可<br />
                                <span style={{ color: 'var(--c-warning)' }}>※ 匯入的日期會與 Firestore 既有資料合併（不覆蓋）</span>
                            </div>
                            <label style={{ ...btn('var(--c-positive)'), width: 'fit-content', cursor: 'pointer', opacity: xlsxImporting ? 0.6 : 1 }}>
                                <Upload size={15} />
                                {xlsxImporting ? '匯入中...' : '選擇 Excel 檔案匯入'}
                                <input type="file" accept=".xlsx,.xls" onChange={handleXlsxImport} disabled={xlsxImporting} style={{ display: 'none' }} />
                            </label>
                            <button style={{ ...btn('var(--c-border)'), marginTop: '12px' }} onClick={() => setShowXlsxImport(false)}><X size={14} />關閉</button>
                        </div>
                    </div>
                )}

                {/* 新增行程 Modal */}
                {showForm && (
                    <div className="mobile-modal" style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                        <div style={{ ...card, width: '100%', maxWidth: '480px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                                <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--c-text)' }}>新增行程</span>
                                <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={18} /></button>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                                {/* 類型選擇 */}
                                <div>
                                    <label style={lbl}>類型 *</label>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                        {([
                                            ['personal', '個人行程'],
                                            ['tech', '科技活動'],
                                            ['fomc', 'FOMC'],
                                            ['investor', '法說會'],
                                            ['dividend', '除權息'],
                                            ['shareholder', '股東會'],
                                        ] as [CalendarEvent['type'], string][]).map(([t, label]) => (
                                            <button key={t} onClick={() => setForm(f => ({ ...f, type: t }))}
                                                style={{
                                                    padding: '5px 14px', borderRadius: '20px', border: `1px solid`,
                                                    borderColor: form.type === t ? EVENT_COLORS[t] : 'var(--c-border)',
                                                    backgroundColor: form.type === t ? `${EVENT_COLORS[t]}22` : 'transparent',
                                                    color: form.type === t ? EVENT_COLORS[t] : 'var(--c-muted)',
                                                    fontSize: '12px', cursor: 'pointer', fontWeight: form.type === t ? 600 : 400,
                                                    display: 'flex', alignItems: 'center', gap: '5px'
                                                }}>
                                                <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: EVENT_COLORS[t], display: 'inline-block' }} />
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                    {form.type === 'investor' && (
                                        <div style={{ fontSize: '11px', color: 'var(--c-warning)', marginTop: '6px' }}>
                                            ⚠️ 法說會請在標題填入「股票代號 公司名稱」，如：2330 台積電
                                        </div>
                                    )}
                                </div>
                                <div>
                                    <label style={lbl}>標題 *</label>
                                    <input style={inp}
                                        placeholder={
                                            form.type === 'investor' ? '2330 台積電' :
                                                form.type === 'tech' ? '例：Apple 發表會' :
                                                    form.type === 'fomc' ? 'FOMC 會議結果' :
                                                        form.type === 'dividend' ? '例：2330 台積電 除權息' :
                                                            form.type === 'shareholder' ? '例：2330 台積電 股東會' :
                                                                '行程標題'
                                        }
                                        value={form.title}
                                        onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
                                </div>
                                <div>
                                    <label style={lbl}>日期 *</label>
                                    <input type="date" style={inp} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
                                </div>
                                <div>
                                    <label style={lbl}>備註</label>
                                    <input style={inp} placeholder="備註說明" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                                </div>
                                <div>
                                    <label style={lbl}>連結</label>
                                    <input style={inp} placeholder="https://..." value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: '8px', marginTop: '20px', justifyContent: 'flex-end' }}>
                                <button style={btn('var(--c-border)')} onClick={() => setShowForm(false)}><X size={14} />取消</button>
                                <button style={{ ...btn(EVENT_COLORS[form.type] || 'var(--c-accent)') }} onClick={handleAddEvent}>新增</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </>
    )
}
