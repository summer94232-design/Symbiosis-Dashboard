import { card, inp, lbl, btn } from '../../ui/styles'
import { confirmAction } from '../../ui/dialogs'
import { useLatestReads } from '../../lib/useLatestReads'
import { useInvestSync } from '../../InvestSyncContext'
import CalendarTimingFields from '../../components/CalendarTimingFields'
import GoogleSeriesEditor from '../../components/GoogleSeriesEditor'
import AnnualDataNotice from '../../components/AnnualDataNotice'
import { getAnnualDataWarnings, googleSyncDateRange } from '../../lib/annualDataCoverage'
import { eventOccursOn, eventScheduleLabel, timingDraft, timingForWrite, emptyTimingDraft } from '../../lib/calendarTiming'
import { parseCalendarDate } from '../../lib/calendarTimingInput'
import { useSafeMutation } from '../../lib/useSafeMutation'
import { toLocalDateString } from '../../lib/date'
import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import { getDocs, doc, runTransaction, onSnapshot, collection, query, where } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { captureUserSession } from '../../lib/userDB'
import { commitLedgerWrites } from '../../lib/ledgerWrites'
import { calcPositions, type TradeRecord, type DividendRecord } from '../../lib/calc'
import { buildDividendForecasts, getDividendFeedState, subscribeDividendFeed } from '../../lib/dividendAnnouncements'
import { fetchTrades, fetchDividends, invalidateDividends, invalidateTrades } from '../../lib/investData'
import { FOMC_DATES, TECH_EVENTS, getFuturesSettlementDates, EVENT_COLORS, EVENT_LABELS, type CalendarEvent } from '../../lib/calendarData'
import { Plus, X, ChevronLeft, ChevronRight, ExternalLink, Upload, Pencil, RefreshCw, UploadCloud } from 'lucide-react'
import { deleteCalendarEventWithGoogle, resolveGoogleDeletionConflict, getGoogleCalendarAuth, performGoogleCalendarSync, type SyncSummary } from '../../lib/googleCalendar'
import { fetchCalendarEvents, fetchTasks, invalidateCalendarEvents, invalidateTasks } from '../../lib/plannerData'
import { addInvestorMeetingDates, fetchInvestorMeetings, removeInvestorMeetingDate, syncYahooInvestorMeetings } from '../../lib/investorMeetings'


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
    const dividendFeed = useSyncExternalStore(subscribeDividendFeed, getDividendFeedState)
    const [seriesId, setSeriesId] = useState<string | null>(null)
    const mutation = useSafeMutation()
    const { run: readLatest, states: readStates } = useLatestReads()
    const { version: syncVersion, status: syncStatus } = useInvestSync()
    const [subscriptionError, setSubscriptionError] = useState('')
    const activeMonth = useRef('')
    const eventDraftId = useRef<string | null>(null)
    const [timing, setTiming] = useState(emptyTimingDraft)
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
    const gcalSyncLock = useRef(false)
    const [gcalStage, setGcalStage] = useState<string | null>(null)

    const loadPersonal = useCallback(() => readLatest('個人行程', () => fetchCalendarEvents<CalendarEvent>(), setPersonalEvents), [readLatest])
    const loadWatchList = useCallback(() => readLatest('持倉與關注清單', async () => {
        const session = captureUserSession()
        const [watchSnap, trades] = await Promise.all([getDocs(session.col(investDB, 'calendarWatchList')), fetchTrades<TradeRecord>('asc')])
        session.assertActive()
        const list = watchSnap.docs.map(d => ({ code: d.data().code || d.id, name: d.data().name || d.data().code || d.id }))
        const { holdings } = calcPositions(trades, [], { asOf: toLocalDateString() })
        return { list, codes: new Set([...Object.keys(holdings).filter(c => holdings[c].shares > 0), ...list.map(w => w.code)]) }
    }, ({ list, codes }) => { watchListRef.current = list; setMyStockCodes(codes) }), [readLatest])
    const loadDividends = useCallback(() => readLatest('除權息', async () => {
        const [rows, trades] = await Promise.all([fetchDividends<DividendRecord>('asc'), fetchTrades<TradeRecord>()])
        const saved = rows.filter(d => d.date).map(d => ({ id: 'div-' + d.code + '-' + d.date, date: d.date, title: (d.name || d.code) + ' 除權息', type: 'dividend' as const, stockCode: d.code, description: '現金股利：' + (d.cashDividend || 0) + ' 元' }))
        const forecasts = buildDividendForecasts(dividendFeed.catalog, trades, rows, toLocalDateString()).map(forecast => ({
            id: 'div-auto-' + forecast.announcement.id, date: forecast.announcement.date,
            title: forecast.announcement.name + ' 除權息預告', type: 'dividend' as const, stockCode: forecast.announcement.code,
            description: `資格試算 ${forecast.shares} 股；現金${forecast.cashGross === null ? '待公告' : `約 ${forecast.cashGross} ${forecast.foreignCurrency ? '（外幣待確認）' : '元（未扣費）'}`}；配股約 ${forecast.stockShares} 股。尚未入帳，實領請至除權息頁確認。`,
        }))
        return [...saved, ...forecasts]
    }, setDividendEvents), [readLatest, dividendFeed.catalog])
    const loadTasks = useCallback(() => readLatest('任務', async () => {
        const rows = await fetchTasks<{ id: string; dueDate?: string; done: boolean; title: string; priority: string }>()
        return rows.filter(t => t.dueDate && !t.done).map(t => ({ id: 'task-' + t.id, date: t.dueDate!, title: '📋 ' + t.title, type: 'personal' as const, description: '優先級：' + ({ high: '高', medium: '中', low: '低' }[t.priority] || '中') }))
    }, setTaskEvents), [readLatest])
    const loadInvestorFromFirestore = useCallback((y: number, m: number) => {
        const yearMonth = y + '-' + String(m).padStart(2, '0')
        if (activeMonth.current !== yearMonth) return Promise.resolve(false)
        return readLatest('法說會', async () => {
            const rows = await fetchInvestorMeetings([yearMonth])
            const result = new Map<string, CalendarEvent>()
            rows.forEach(data => data.dates.forEach(date => {
                const id = 'investor-' + data.stockCode + '-' + date
                result.set(id, { id, date, title: (data.stockName || data.stockCode) + ' 法說會', type: 'investor', stockCode: data.stockCode, description: (data.stockName || data.stockCode) + '（' + data.stockCode + '）法人說明會' })
            }))
            return [...result.values()]
        }, setInvestorEvents)
    }, [readLatest])
    const reloadCalendar = useCallback(() => {
        invalidateCalendarEvents(); invalidateTasks(); invalidateTrades(); invalidateDividends()
        return Promise.all([loadPersonal(), loadDividends(), loadTasks(), loadWatchList(), loadInvestorFromFirestore(year, month)])
    }, [loadPersonal, loadDividends, loadTasks, loadWatchList, loadInvestorFromFirestore, year, month])

    // ── 從 Yahoo 台股行事曆整頁抓取全市場法說會（手動觸發）──────────────
    const loadYahooCalendar = async () => {
        setLoadingYahoo(true)
        setInvestorError(null)
        setInvestorInfo(null)

        try {
            const result = await syncYahooInvestorMeetings()
            if (result.fetched === 0) {
                setInvestorInfo('未從 Yahoo 取得任何法說會資料（可能該時段無排程）')
                setLoadingYahoo(false)
                return
            }
            await loadInvestorFromFirestore(year, month)
            setInvestorInfo(`✅ Yahoo 法說會更新完成：抓到 ${result.fetched} 筆，${result.changedGroups > 0 ? `更新 ${result.changedGroups} 組個人資料` : '沒有新異動'}；全域資料未被修改`)
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
        const session = captureUserSession()
        setXlsxImporting(true)

        const reader = new FileReader()
        reader.onload = async (evt) => {
            try {
                const data = new Uint8Array(evt.target!.result as ArrayBuffer)
                const XLSX = await import('xlsx')
                // raw: true 保留原始值（含 Excel 序列數字），不讓 SheetJS 自動轉換
                const wb = XLSX.read(data, { type: 'array', cellDates: false })
                const sheet = wb.Sheets[wb.SheetNames[0]]
                const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true })

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
                })), session)
                session.assertActive()

                setInvestorInfo(`✅ xlsx 匯入完成，已寫入 ${written} 組個人法說會資料`)
                setShowXlsxImport(false)
                await loadInvestorFromFirestore(year, month)
            } catch (err) {
                console.error('xlsx 匯入失敗：', err)
                setInvestorError(`xlsx 匯入未完成：${err instanceof Error ? err.message : '請確認欄位格式'}`)
            }
            setXlsxImporting(false)
            e.target.value = ''
        }
        reader.onerror = () => { setXlsxImporting(false); setInvestorError('檔案讀取失敗，請重新選擇檔案。'); e.target.value = '' }
        reader.readAsArrayBuffer(file)
    }

    // ── 雙向同步「未來半年」的行事曆事件（手動觸發）────────────────────
    const handleSyncGoogleCalendar = async () => {
        setInvestorError(null)
        setInvestorInfo(null)

        if (gcalSyncLock.current || mutation.busy) return
        gcalSyncLock.current = true
        setGcalSyncing(true)
        setGcalStage('準備中')
        try {
            const session = captureUserSession()
            const auth = await getGoogleCalendarAuth()
            session.assertActive()
            if (!auth) throw new Error('尚未連結 Google 帳號，請先到行事曆設定連結')
            const summary: SyncSummary = await performGoogleCalendarSync(auth, stage => setGcalStage(stage))
            session.assertActive()
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
            if (summary.warnings.length) parts.push(`同步提示 ${summary.warnings.length} 筆；${summary.warnings.slice(0, 3).join('；')}`)
            if (auth.syncTypes.includes('fomc')) parts.push(...getAnnualDataWarnings({ fomcRange: googleSyncDateRange() }))
            const message = parts.length > 0 ? parts.join('、') : '沒有需要異動的事件'

            setInvestorInfo(`✅ Google 行事曆同步完成：${message}`)
            if (summary.errors.length > 0) {
                console.error('[Google Calendar 同步錯誤]', summary.errors)
            }
        } catch (err) {
            console.error('handleSyncGoogleCalendar 失敗：', err)
            setInvestorError(`Google 行事曆同步失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
        } finally {
            gcalSyncLock.current = false
            setGcalSyncing(false)
            setGcalStage(null)
        }
    }

    useEffect(() => {
        void loadPersonal(); void loadDividends(); void loadTasks(); void loadWatchList()
    }, [loadPersonal, loadDividends, loadTasks, loadWatchList, syncVersion])

    useEffect(() => {
        const yearMonth = year + '-' + String(month).padStart(2, '0')
        activeMonth.current = yearMonth
        let active = true
        setSubscriptionError('')
        void loadInvestorFromFirestore(year, month)
        const unsubscribe = onSnapshot(query(collection(investDB, 'investorMeetings'), where('yearMonth', '==', yearMonth)), () => {
            if (active) { setSubscriptionError(''); void loadInvestorFromFirestore(year, month) }
        }, () => { if (active) setSubscriptionError('法說會即時更新中斷，請重新整理或稍後重試。') })
        return () => { active = false; unsubscribe() }
    }, [year, month, loadInvestorFromFirestore])

    useEffect(() => { void loadInvestorFromFirestore(year, month) }, [syncVersion, year, month, loadInvestorFromFirestore])

    useEffect(() => {
        const refresh = () => { void reloadCalendar() }
        window.addEventListener('online', refresh)
        window.addEventListener('focus', refresh)
        return () => { window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh) }
    }, [reloadCalendar])

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
        await mutation.run(async session => {
            if (!parseCalendarDate(form.date)) throw new Error('請填寫有效的開始日期。')
            if (form.type === 'investor') {
                const stockCode = form.title.match(/^(\d{4,6})/)?.[1] || form.title
                await addInvestorMeetingDates([{ stockCode, stockName: form.title, yearMonth: form.date.slice(0, 7), dates: [form.date] }], session)
                await loadInvestorFromFirestore(year, month)
            } else {
                const schedule = timingForWrite(form.date, timing)
                const id = eventDraftId.current ||= doc(session.col(investDB, 'calendarEvents')).id
                const ref = session.doc(investDB, 'calendarEvents', id)
                const payload = { ...form, ...schedule }
                await runTransaction(investDB, async transaction => {
                    const current = await transaction.get(ref)
                    session.assertActive()
                    if (current.exists()) {
                        const existing = current.data()
                        if (Object.entries(payload).some(([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value))) throw new Error('這筆行程已送達且內容不同，請重新整理後編輯，避免覆寫。')
                        return
                    }
                    transaction.set(ref, { ...payload, updatedAt: new Date().toISOString() })
                })
                session.assertActive()
                invalidateCalendarEvents()
                await loadPersonal()
            }
            session.assertActive()
            eventDraftId.current = null
            setForm({ title: '', date: '', description: '', url: '', type: 'personal' })
            setTiming(emptyTimingDraft())
            setShowForm(false)
        })
    }

    const handleDeleteEvent = async (id: string) => {
        if (mutation.busy || gcalSyncLock.current) return
        const selected = personalEvents.find(event => event.id === id)
        if (!await confirmAction(selected?.recurringEventId ? '確定刪除這一次重複行程？Google 對應事件也會刪除，其他次數與整組規則會保留。' : '確定要刪除此行程？若已連結 Google，對應事件也會刪除。')) return
        await mutation.run(async session => {
            await deleteCalendarEventWithGoogle(id, session)
            session.assertActive()
            invalidateCalendarEvents()
            await loadPersonal()
        })
    }

    const handleEditEvent = (ev: CalendarEvent) => {
        if (mutation.busy) return
        setEditingEvent(ev)
        setTiming(timingDraft(ev))
        setForm({ title: ev.title, date: ev.date, description: ev.description || '', url: ev.url || '', type: ev.type })
    }

    const handleResolveGoogleDeletion = async (keep: boolean) => {
        if (!editingEvent) return
        await mutation.run(async session => {
            const data = keep ? { ...form, ...timingForWrite(form.date, timing, editingEvent) } : undefined
            await resolveGoogleDeletionConflict(editingEvent, data, session)
            session.assertActive()
            invalidateCalendarEvents()
            setEditingEvent(null)
            await loadPersonal()
            session.assertActive()
            if (keep) await handleSyncGoogleCalendar()
        })
    }

    const handleUpdateEvent = async () => {
        if (!editingEvent || !form.title || !form.date) return
        await mutation.run(async session => {
            const schedule = timingForWrite(form.date, timing, editingEvent)
            const ref = session.doc(investDB, 'calendarEvents', editingEvent.id)
            await runTransaction(investDB, async transaction => {
                const current = await transaction.get(ref)
                session.assertActive()
                if (!current.exists() || (current.data()?.updatedAt || '') !== (editingEvent.updatedAt || '')) throw new Error('行程已被同步或其他操作更新，請重新開啟編輯。')
                transaction.update(ref, { ...form, ...schedule, updatedAt: new Date().toISOString(), googlePendingLocalChange: true })
            })
            session.assertActive()
            invalidateCalendarEvents()
            setEditingEvent(null)
            setTiming(emptyTimingDraft())
            setForm({ title: '', date: '', description: '', url: '', type: 'personal' })
            await loadPersonal()
        })
    }

    // 全域資料不刪除；在目前使用者的 override 中隱藏該日期。
    const handleDeleteInvestorDate = async (stockCode: string, isoDate: string) => {
        if (!await confirmAction(`確定要刪除 ${stockCode} 在 ${isoDate} 的法說會？`)) return
        const event = investorEvents.find(item => item.stockCode === stockCode && item.date === isoDate)
        const stockName = event?.title.replace(/\s*法說會$/, '') || stockCode
        await removeInvestorMeetingDate(stockCode, stockName, isoDate)
        await loadInvestorFromFirestore(year, month)
    }

    const handleDeleteDividend = async (ev: CalendarEvent) => {
        if (!await confirmAction(`確定要刪除 ${ev.title}？`)) return
        await mutation.run(async session => {
            const divs = await fetchDividends<{ id: string; code?: string; date?: string }>('asc')
            session.assertActive()
            const match = divs.find(d => d.code === ev.stockCode && d.date === ev.date)
            if (match) {
                await commitLedgerWrites([{ collection: 'dividends', id: match.id }], session)
                session.assertActive()
                invalidateDividends()
                await loadDividends()
            }
        })
    }

    const prevMonth = () => { if (month === 1) { setYear(y => y - 1); setMonth(12) } else setMonth(m => m - 1) }
    const nextMonth = () => { if (month === 12) { setYear(y => y + 1); setMonth(1) } else setMonth(m => m + 1) }

    const firstDay = new Date(year, month - 1, 1).getDay()
    const daysInMonth = new Date(year, month, 0).getDate()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const getDateStr = (d: number) => `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const getEventsForDate = (d: number) => events.filter(e => eventOccursOn(e, getDateStr(d)))
    const selectedEvents = selectedDay ? events.filter(e => eventOccursOn(e, selectedDay)) : []

    return (
        <>
            <style>{`
        .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
        .calendar-filter-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
        .calendar-filter-strip button { flex: 0 0 auto; }
        .calendar-month-button { display: inline-flex !important; width: 44px; height: 44px; align-items: center; justify-content: center; padding: 0 !important; border-radius: 8px; }
        .cal-day { width: 100%; min-width: 0; min-height: 80px; padding: 6px; border: 0; border-radius: 6px; color: inherit; background: transparent; cursor: pointer; transition: background 0.15s; position: relative; text-align: left; font: inherit; }
        .cal-day:hover { background: rgba(79,142,247,0.06); }
        .cal-day:focus-visible { outline: 2px solid var(--c-accent); outline-offset: -2px; }
        .cal-day.today { background: rgba(79,142,247,0.10); }
        .cal-day.selected { background: rgba(79,142,247,0.15); outline: 1px solid var(--c-accent); }
        .calendar-event-icon-button { display: inline-flex; width: 36px; height: 36px; align-items: center; justify-content: center; border-radius: 8px; }
        @media (max-width: 767px), (max-width: 950px) and (pointer: coarse) and (orientation: landscape) {
            .calendar-filter-strip { flex-wrap: nowrap; max-width: 100%; min-width: 0; padding: 0 0 6px; overflow-x: auto; overscroll-behavior-inline: contain; scrollbar-width: none; }
            .calendar-filter-strip::-webkit-scrollbar { display: none; }
            .calendar-filter-strip button { min-height: 44px; }
            .cal-day { min-height: 56px; }
            .calendar-event-icon-button { width: 44px; height: 44px; }
        }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
      <div aria-live="polite" style={{ marginBottom: 12 }}>
        {Object.values(readStates).some(state => state.loading) && <span role="status">月曆更新中…</span>}
        {(syncStatus === 'error' || subscriptionError) && <p role="alert">{subscriptionError || '跨裝置同步中斷，目前顯示最後成功讀取的資料。'}</p>}
        {Object.entries(readStates).filter(([, state]) => state.error).map(([key, state]) => <p key={key} role="alert" style={{ color: 'var(--c-danger)' }}>{key}讀取失敗：{state.error}（保留最後成功的資料）</p>)}
      </div>
      {mutation.error && !showForm && !editingEvent && <p role="alert" style={{ color: 'var(--c-danger)' }}>{mutation.error}</p>}

            <div style={{ padding: 'var(--ui-page-padding, clamp(16px, 3vw, 32px))', maxWidth: '1400px', margin: '0 auto' }}>

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
                        <button className="calendar-primary-action" onClick={() => { setForm({ title: '', date: selectedDay || toLocalDateString(), description: '', url: '', type: 'personal' }); setTiming(emptyTimingDraft()); eventDraftId.current = null; setShowForm(true) }} style={btn('var(--c-accent)')}>
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
                <AnnualDataNotice fomcRange={filterTypes.has('fomc') ? { start: `${year}-01-01`, end: `${year}-12-31` } : undefined} />
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
                <div className="calendar-filter-strip" aria-label="事件類型篩選">
                    {Object.entries(EVENT_LABELS).map(([type, label]) => (
                        <button key={type} type="button" onClick={() => toggleFilter(type)} aria-pressed={filterTypes.has(type)}
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
                            <button type="button" className="calendar-month-button" onClick={prevMonth} aria-label="上一個月" title="上一個月" style={{ background: 'none', border: 'none', color: 'var(--c-text)', cursor: 'pointer' }}><ChevronLeft size={20} /></button>
                            <span style={{ fontSize: '18px', fontWeight: 700, color: 'var(--c-text)' }}>{year} 年 {month} 月</span>
                            <button type="button" className="calendar-month-button" onClick={nextMonth} aria-label="下一個月" title="下一個月" style={{ background: 'none', border: 'none', color: 'var(--c-text)', cursor: 'pointer' }}><ChevronRight size={20} /></button>
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
                                    <button key={d} type="button" className={`cal-day${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`}
                                        aria-label={`${year} 年 ${month} 月 ${d} 日，${dayEvents.length} 個事件`}
                                        aria-pressed={isSelected}
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
                                    </button>
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
                                                    <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>{eventScheduleLabel(ev)}</div>
                                                    {ev.description && <div style={{ fontSize: '12px', color: 'var(--c-muted)' }}>{ev.description}</div>}
                                                </div>
                                                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                                                    {ev.url && (
                                                        <a href={ev.url} target="_blank" rel="noopener noreferrer"
                                                            className="calendar-event-icon-button" aria-label={`開啟「${ev.title}」連結`} title="開啟外部連結"
                                                            style={{ color: 'var(--c-accent)' }}><ExternalLink size={14} /></a>
                                                    )}
                                                    {/* 手動建立的行程（存在 calendarEvents collection）才顯示編輯／刪除鈕 */}
                                                    {['personal', 'tech', 'fomc', 'dividend', 'shareholder', 'futures'].includes(ev.type) && ev.id && !ev.id.startsWith('fomc-') && !ev.id.startsWith('gtc-') && !ev.id.startsWith('wwdc-') && !ev.id.startsWith('build-') && !ev.id.startsWith('google-io-') && !ev.id.startsWith('ces-') && !ev.id.startsWith('futures-') && !ev.id.startsWith('div-') && (
                                                        <>
                                                            <button type="button" className="calendar-event-icon-button" onClick={() => handleEditEvent(ev)}
                                                                aria-label={`編輯「${ev.title}」`}
                                                                style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', padding: 0 }}
                                                                title="編輯此行程">
                                                                <Pencil size={13} />
                                                            </button>
                                                            <button type="button" className="calendar-event-icon-button" onClick={() => handleDeleteEvent(ev.id)}
                                                                aria-label={`刪除「${ev.title}」`}
                                                                style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer', padding: 0 }}
                                                                title="刪除此行程">
                                                                <X size={14} />
                                                            </button>
                                                        </>
                                                    )}
                                                    {ev.type === 'investor' && ev.stockCode && (
                                                        <button type="button" className="calendar-event-icon-button" onClick={() => handleDeleteInvestorDate(ev.stockCode!, ev.date)}
                                                            aria-label={`刪除「${ev.title}」日期`}
                                                            style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer', padding: 0 }}
                                                            title="刪除此法說會日期">
                                                            <X size={14} />
                                                        </button>
                                                    )}
                                                    {ev.type === 'dividend' && !ev.id?.startsWith('div-auto-') && (
                                                        <button type="button" className="calendar-event-icon-button" onClick={() => handleDeleteDividend(ev)}
                                                            aria-label={`刪除「${ev.title}」記錄`}
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
                            <button onClick={() => { setForm({ title: '', date: selectedDay, description: '', url: '', type: 'personal' }); setTiming(emptyTimingDraft()); eventDraftId.current = null; setShowForm(true) }}
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
                                <button disabled={mutation.busy} onClick={() => setEditingEvent(null)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={18} /></button>
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
                                            <button disabled={mutation.busy} key={t} onClick={() => setForm(f => ({ ...f, type: t }))}
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
                                    <input disabled={mutation.busy} style={inp} placeholder="行程標題" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
                                </div>
                                <CalendarTimingFields date={form.date} onDateChange={date => setForm(f => ({ ...f, date }))}
                                    value={timing} onChange={setTiming} disabled={mutation.busy} />
                                <div>
                                    <label style={lbl}>備註</label>
                                    <input disabled={mutation.busy} style={inp} placeholder="備註說明" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                                </div>
                                <div>
                                    <label style={lbl}>連結</label>
                                    <input disabled={mutation.busy} style={inp} placeholder="https://..." value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
                                </div>
                            </div>
                            {editingEvent.googleSyncConflict === 'remote-deleted' && <div role="alert" style={{ fontSize: '13px', color: 'var(--c-warning)' }}>
                                Google 已刪除此行程，本機修改已保留。請選擇：
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
                                    <button className="ui-button ui-button-secondary" disabled={mutation.busy || gcalSyncing || !form.title || !form.date} onClick={() => handleResolveGoogleDeletion(true)}>保留並重新同步</button>
                                    <button className="ui-button ui-button-secondary" disabled={mutation.busy || gcalSyncing} onClick={() => handleResolveGoogleDeletion(false)}>接受刪除</button>
                                </div>
                            </div>}
                            {editingEvent.recurringEventId && <p>目前表單只編輯本次行程。<button disabled={mutation.busy} onClick={() => { setSeriesId(editingEvent.recurringEventId!); setEditingEvent(null) }}>編輯整組重複規則</button></p>}
                            {mutation.error && <p role="alert" style={{ color: 'var(--c-danger)' }}>{mutation.error}</p>}
                            <div style={{ display: 'flex', gap: '8px', marginTop: '20px', justifyContent: 'flex-end' }}>
                                <button disabled={mutation.busy} style={btn('var(--c-border)')} onClick={() => setEditingEvent(null)}><X size={14} />取消</button>
                                <button style={{ ...btn(EVENT_COLORS[form.type] || 'var(--c-accent)') }} disabled={mutation.busy} onClick={handleUpdateEvent}><Pencil size={14} />儲存</button>
                            </div>
                        </div>
                    </div>
                )}

                {seriesId && <GoogleSeriesEditor key={seriesId} seriesId={seriesId} onClose={() => setSeriesId(null)} onRefreshed={() => { void reloadCalendar() }} />}
                {/* xlsx 匯入法說會 Modal */}
                {showXlsxImport && (
                    <div className="mobile-modal" style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                        <div style={{ ...card, width: '100%', maxWidth: '520px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--c-text)' }}>手動匯入法說會日期</span>
                                <button onClick={() => setShowXlsxImport(false)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={18} /></button>
                            </div>
                            <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', border: '1px solid var(--c-border)', fontSize: '12px', color: 'var(--c-muted)', lineHeight: 1.8 }}><span style={{ color: 'var(--c-accent)', fontWeight: 600 }}>.xlsx／.xls 必填：股票代號、股票名稱、法說會日期。</span><br />日期：YYYY-MM-DD、YYYY/MM/DD 或 Excel 日期。<br /><span style={{ color: 'var(--c-warning)' }}>合併匯入，不覆蓋。</span></div>
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
                                <button disabled={mutation.busy} onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={18} /></button>
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
                                            <button disabled={mutation.busy} key={t} onClick={() => setForm(f => ({ ...f, type: t }))}
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
                                    <input disabled={mutation.busy} style={inp}
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
                                <CalendarTimingFields date={form.date} onDateChange={date => setForm(f => ({ ...f, date }))}
                                    value={timing} onChange={setTiming} disabled={mutation.busy} dateOnly={form.type === 'investor'} />
                                <div>
                                    <label style={lbl}>備註</label>
                                    <input disabled={mutation.busy} style={inp} placeholder="備註說明" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                                </div>
                                <div>
                                    <label style={lbl}>連結</label>
                                    <input disabled={mutation.busy} style={inp} placeholder="https://..." value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
                                </div>
                            </div>
                            {mutation.error && <p role="alert" style={{ color: 'var(--c-danger)' }}>{mutation.error}</p>}
                            <div style={{ display: 'flex', gap: '8px', marginTop: '20px', justifyContent: 'flex-end' }}>
                                <button disabled={mutation.busy} style={btn('var(--c-border)')} onClick={() => setShowForm(false)}><X size={14} />取消</button>
                                <button style={{ ...btn(EVENT_COLORS[form.type] || 'var(--c-accent)') }} disabled={mutation.busy} onClick={handleAddEvent}>新增</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </>
    )
}
