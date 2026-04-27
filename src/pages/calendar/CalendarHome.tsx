import { useState, useEffect, useRef } from 'react'
import { getDocs, addDoc, deleteDoc, orderBy, query, where, setDoc, getDoc, updateDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { calcPositions, type TradeRecord } from '../../lib/calc'
import { FOMC_DATES, TECH_EVENTS, getFuturesSettlementDates, EVENT_COLORS, EVENT_LABELS, type CalendarEvent } from '../../lib/calendarData'
import { Plus, X, ChevronLeft, ChevronRight, ExternalLink, Upload } from 'lucide-react'
import * as XLSX from 'xlsx'

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

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
    const [loadingInvestor, setLoadingInvestor] = useState(false)
    const [investorError, setInvestorError] = useState<string | null>(null)
    const [investorInfo, setInvestorInfo] = useState<string | null>(null)
    const [xlsxImporting, setXlsxImporting] = useState(false)
    // 用 ref 保存最新 watchList，避免 closure 捕捉到舊值
    const watchListRef = useRef<{ code: string; name: string }[]>([])
    const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set(['fomc', 'futures', 'tech', 'investor', 'personal', 'dividend']))
    const [myStocksOnly, setMyStocksOnly] = useState(true)
    const [myStockCodes, setMyStockCodes] = useState<Set<string>>(new Set())
    const [form, setForm] = useState({ title: '', date: '', description: '', url: '' })

    const loadPersonal = async () => {
        const snap = await getDocs(query(userCol(investDB, 'calendarEvents'), orderBy('date', 'asc')))
        setPersonalEvents(snap.docs.map(d => ({ id: d.id, ...d.data() } as CalendarEvent)))
    }

    const loadWatchList = async () => {
        const [watchSnap, tradesSnap] = await Promise.all([
            getDocs(userCol(investDB, 'calendarWatchList')),
            getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'asc'))),
        ])
        const list = watchSnap.docs.map(d => ({
            code: d.data().code || d.id,
            name: d.data().name || d.data().code || d.id
        }))
        watchListRef.current = list
        // ✅ 修正：trades 已在此處讀取，直接傳入，不重複查詢
        const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
        refreshMyStockCodes(trades, list.map(w => w.code))
    }

    // ✅ 修正：接收已讀取的 trades，不再重複查詢 Firestore
    const refreshMyStockCodes = (trades: TradeRecord[], watchCodes?: string[]) => {
        try {
            const { holdings } = calcPositions(trades)
            const holdingCodes = Object.keys(holdings).filter(c => holdings[c].shares > 0)
            const wl = watchCodes ?? watchListRef.current.map(w => w.code)
            setMyStockCodes(new Set([...holdingCodes, ...wl]))
        } catch { /* ignore */ }
    }

    const loadDividends = async () => {
        const snap = await getDocs(userCol(investDB, 'dividends'))
        const divEvents: CalendarEvent[] = snap.docs
            .map(d => d.data())
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
        const snap = await getDocs(userCol(investDB, 'tasks'))
        const taskEvts: CalendarEvent[] = snap.docs
            .map(d => d.data())
            .filter(t => t.dueDate && !t.done)
            .map(t => ({
                id: `task-${t.createdAt}`,
                date: t.dueDate,
                title: `📋 ${t.title}`,
                type: 'personal' as const,
                description: `優先級：${{ high: '高', medium: '中', low: '低' }[t.priority as string] || '中'}`
            }))
        setTaskEvents(taskEvts)
    }

    // 從 Firestore 讀取已儲存的法說會資料（進入頁面或切換月份時呼叫）
    const loadInvestorFromFirestore = async (y: number, m: number) => {
        if (loadingInvestor) return  // 手動更新進行中時不觸發
        const yearMonth = `${y}-${String(m).padStart(2, '0')}`

        try {
            // ✅ 修正：直接查詢當月所有文件（不限於關注清單），確保 xlsx 匯入的資料也能顯示
            const q = query(userCol(investDB, 'investorMeetings'), where('yearMonth', '==', yearMonth))
            const snap = await getDocs(q)
            const evtMap = new Map<string, CalendarEvent>()

            snap.docs.forEach(docSnap => {
                const data = docSnap.data()
                const dates: string[] = Array.isArray(data.dates) ? data.dates : []
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

    // 手動更新法說會：打 API → 比對 Firestore → 有變動就寫入
    const loadInvestorMeetings = async () => {
        setLoadingInvestor(true)
        setInvestorError(null)
        setInvestorInfo(null)

        try {
            // ✅ 修正：loadWatchList 內部已讀取 trades 並計算 myStockCodes
            //    這裡只需重新讀取 watchList（trades 已在 loadWatchList 中處理）
            await loadWatchList()
            const currentWatchList = watchListRef.current
            const watchCodes = currentWatchList.map(w => w.code)
            const watchNameMap: Record<string, string> = {}
            currentWatchList.forEach(w => { watchNameMap[w.code] = w.name })

            // myStockCodes 已被 loadWatchList 更新，取出持倉代號
            const holdingCodes = [...myStockCodes].filter(c => !watchCodes.includes(c))

            // 查詢清單 = 持倉 + 關注清單（去重）
            const allCodes = [...new Set([...holdingCodes, ...watchCodes])]

            console.log('法說會查詢股票清單：', allCodes)

            if (allCodes.length === 0) {
                setInvestorEvents([])
                setLoadingInvestor(false)
                return
            }

            const yearMonth = `${year}-${String(month).padStart(2, '0')}`
            let successCount = 0
            let failCount = 0
            let changedCount = 0
            const evtMap = new Map<string, CalendarEvent>()

            for (const code of allCodes) {
                try {
                    const res = await fetch(
                        `/.netlify/functions/mops-proxy?stockNo=${encodeURIComponent(code)}&year=${year}&month=${month}`
                    )

                    if (!res.ok) { failCount++; continue }

                    let json: { source?: string; dates?: string[]; error?: string }
                    try { json = await res.json() } catch { failCount++; continue }
                    if (json.error) { failCount++; continue }

                    const rawDates: string[] = Array.isArray(json.dates) ? json.dates : []
                    const newDates = rawDates.filter(isoDate => {
                        if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false
                        const [y, m] = isoDate.split('-')
                        return parseInt(y) === year && parseInt(m) === month
                    })

                    console.log(`${code} 法說會日期（來源：${json.source}）:`, newDates)

                    // 名稱優先順序：持倉 > watchList > code
                    const stockName = watchNameMap[code] || code
                    const docId = `${code}-${yearMonth}`
                    const docRef = userDoc(investDB, 'investorMeetings', docId)

                    const existing = await getDoc(docRef)
                    const oldDates: string[] = existing.exists() ? (existing.data().dates || []) : []
                    const oldSorted = [...oldDates].sort().join(',')
                    const newSorted = [...newDates].sort().join(',')

                    if (oldSorted !== newSorted) {
                        await setDoc(docRef, {
                            stockCode: code,
                            stockName,
                            yearMonth,
                            dates: newDates,
                            updatedAt: new Date().toISOString()
                        })
                        changedCount++
                    }

                    newDates.forEach((isoDate: string) => {
                        const id = `investor-${code}-${isoDate}`
                        if (!evtMap.has(id)) {
                            evtMap.set(id, {
                                id,
                                date: isoDate,
                                title: `${stockName} 法說會`,
                                type: 'investor',
                                stockCode: code,
                                description: `${stockName}（${code}）法人說明會`
                            })
                        }
                    })

                    successCount++
                } catch (err) {
                    console.error(`${code} 法說會查詢失敗：`, err)
                    failCount++
                }
            }

            setInvestorEvents([...evtMap.values()])

            if (failCount > 0 && successCount === 0) {
                setInvestorError(`查詢失敗（${failCount} 檔），請確認 mops-proxy 是否正常運作`)
            } else if (failCount > 0) {
                setInvestorError(`部分查詢失敗（${failCount} 檔），其餘 ${successCount} 檔已更新`)
            } else if (changedCount > 0) {
                setInvestorInfo(`✅ 更新完成，偵測到 ${changedCount} 檔有變動並已同步`)
            } else {
                setInvestorInfo(`✅ 更新完成，本月資料無變動（${successCount} 檔）`)
            }
        } catch (err) {
            console.error('loadInvestorMeetings 錯誤：', err)
            setInvestorError('法說會更新失敗，請稍後再試')
        }

        setLoadingInvestor(false)
    }

    // ── xlsx 手動匯入法說會 ──────────────────────────────────────────────
    const handleXlsxImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        setXlsxImporting(true)

        const reader = new FileReader()
        reader.onload = async (evt) => {
            try {
                const data = new Uint8Array(evt.target!.result as ArrayBuffer)
                // ⚠️ 不使用 cellDates:true，避免 UTC 轉換在 UTC+8 時區造成日期差一天
                // 改用 dateNF 格式字串，讓 SheetJS 直接輸出 YYYY-MM-DD 文字
                const wb = XLSX.read(data, { type: 'array', cellDates: false, dateNF: 'yyyy-mm-dd' })
                const sheet = wb.Sheets[wb.SheetNames[0]]
                const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '', raw: false })

                const byDoc: Record<string, { stockCode: string; stockName: string; yearMonth: string; dates: Set<string> }> = {}

                for (const row of rows) {
                    const code = String(row['股票代號'] || row['代號'] || row['code'] || '').trim()
                    const name = String(row['股票名稱'] || row['名稱'] || row['name'] || code).trim()

                    // raw:false 讓日期以格式字串輸出，取前 10 碼即為 YYYY-MM-DD
                    const rawDate = String(row['法說會日期'] || row['日期'] || row['date'] || '').trim()
                    const isoDate = rawDate.slice(0, 10).replace(/\//g, '-')

                    if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) continue

                    const [y, m] = isoDate.split('-')
                    const yearMonth = `${y}-${m}`
                    const docId = `${code}-${yearMonth}`

                    if (!byDoc[docId]) {
                        byDoc[docId] = { stockCode: code, stockName: name, yearMonth, dates: new Set() }
                    }
                    byDoc[docId].dates.add(isoDate)
                }

                let written = 0
                for (const [, info] of Object.entries(byDoc)) {
                    const docId = `${info.stockCode}-${info.yearMonth}`
                    const docRef = userDoc(investDB, 'investorMeetings', docId)
                    const existing = await getDoc(docRef)
                    const oldDates: string[] = existing.exists() ? (existing.data().dates || []) : []
                    // 合併並去重：用 Set 確保同一股票同一日期不重複
                    const mergedDates = [...new Set([...oldDates, ...info.dates])].sort()

                    await setDoc(docRef, {
                        stockCode: info.stockCode,
                        stockName: info.stockName,
                        yearMonth: info.yearMonth,
                        dates: mergedDates,
                        updatedAt: new Date().toISOString()
                    })
                    written++
                }

                setInvestorInfo(`✅ xlsx 匯入完成，已寫入 ${written} 筆法說會資料`)
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

    useEffect(() => {
        loadPersonal()
        loadDividends()
        loadTasks()
        // 先載入關注清單，再載入法說會（確保 watchListRef 有值）
        loadWatchList().then(() => loadInvestorFromFirestore(year, month))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        // 切換月份時重新載入法說會（watchListRef 此時已有值）
        loadInvestorFromFirestore(year, month)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [year, month])

    useEffect(() => {
        const futuresDates = getFuturesSettlementDates(year, month)
        // 法說會依「只顯示我的股票」篩選
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
        await addDoc(userCol(investDB, 'calendarEvents'), {
            title: form.title, date: form.date,
            description: form.description, url: form.url,
            type: 'personal'
        })
        setForm({ title: '', date: '', description: '', url: '' })
        setShowForm(false)
        loadPersonal()
    }

    const handleDeleteEvent = async (id: string) => {
        if (!confirm('確定要刪除此行程？')) return
        await deleteDoc(userDoc(investDB, 'calendarEvents', id))
        loadPersonal()
    }

    // 刪除單筆法說會日期（從 investorMeetings.dates[] 移除）
    const handleDeleteInvestorDate = async (stockCode: string, isoDate: string) => {
        if (!confirm(`確定要刪除 ${stockCode} 在 ${isoDate} 的法說會？`)) return
        const yearMonth = `${year}-${String(month).padStart(2, '0')}`
        const docRef = userDoc(investDB, 'investorMeetings', `${stockCode}-${yearMonth}`)
        const snap = await getDoc(docRef)
        if (!snap.exists()) return
        const oldDates: string[] = snap.data().dates || []
        const newDates = oldDates.filter(d => d !== isoDate)
        await updateDoc(docRef, { dates: newDates, updatedAt: new Date().toISOString() })
        // 重新載入
        await loadInvestorFromFirestore(year, month)
    }

    // 刪除除權息事件（找到對應 dividends 文件刪除）
    const handleDeleteDividend = async (ev: CalendarEvent) => {
        if (!confirm(`確定要刪除 ${ev.title}？`)) return
        const snap = await getDocs(userCol(investDB, 'dividends'))
        const match = snap.docs.find(d => {
            const data = d.data()
            return data.code === ev.stockCode && data.date === ev.date
        })
        if (match) {
            await deleteDoc(userDoc(investDB, 'dividends', match.id))
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
        .cal-day.selected { background: rgba(79,142,247,0.15); outline: 1px solid #4f8ef7; }
        @media (max-width: 768px) { .cal-day { min-height: 56px; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1400px', margin: '0 auto' }}>

                {/* 標題列 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>財經行事曆</h1>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button onClick={() => setShowXlsxImport(true)} style={btn('#21253a')} title="從 xlsx 手動匯入法說會日期">
                            <Upload size={14} />匯入法說會
                        </button>
                        <button onClick={() => setShowForm(true)} style={btn('#4f8ef7')}>
                            <Plus size={14} />新增行程
                        </button>
                    </div>
                </div>

                {/* 錯誤 / 成功提示 */}
                {investorError && (
                    <div style={{ backgroundColor: 'rgba(255,180,0,0.10)', border: '1px solid rgba(255,180,0,0.35)', borderRadius: '8px', padding: '10px 16px', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '13px', color: '#f5c842' }}>⚠️ {investorError}</span>
                        <button onClick={() => setInvestorError(null)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={14} /></button>
                    </div>
                )}
                {investorInfo && (
                    <div style={{ backgroundColor: 'rgba(0,200,150,0.10)', border: '1px solid rgba(0,200,150,0.35)', borderRadius: '8px', padding: '10px 16px', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '13px', color: '#00c896' }}>{investorInfo}</span>
                        <button onClick={() => setInvestorInfo(null)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={14} /></button>
                    </div>
                )}

                {/* 篩選器 */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                    {Object.entries(EVENT_LABELS).map(([type, label]) => (
                        <button key={type} onClick={() => toggleFilter(type)}
                            style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 12px', borderRadius: '20px', border: '1px solid', borderColor: filterTypes.has(type) ? EVENT_COLORS[type] : '#2e3349', backgroundColor: filterTypes.has(type) ? `${EVENT_COLORS[type]}18` : 'transparent', color: filterTypes.has(type) ? EVENT_COLORS[type] : '#8892a4', fontSize: '12px', cursor: 'pointer' }}>
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
                            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 14px', borderRadius: '20px', border: `1px solid ${myStocksOnly ? '#00c896' : '#2e3349'}`, backgroundColor: myStocksOnly ? 'rgba(0,200,150,0.12)' : 'transparent', color: myStocksOnly ? '#00c896' : '#8892a4', fontSize: '12px', cursor: 'pointer' }}>
                            {/* 自製 toggle */}
                            <span style={{ width: '28px', height: '15px', borderRadius: '8px', backgroundColor: myStocksOnly ? '#00c896' : '#2e3349', display: 'inline-flex', alignItems: 'center', padding: '2px', transition: 'background 0.2s', flexShrink: 0 }}>
                                <span style={{ width: '11px', height: '11px', borderRadius: '50%', backgroundColor: '#fff', transform: myStocksOnly ? 'translateX(13px)' : 'translateX(0)', transition: 'transform 0.2s', display: 'block' }} />
                            </span>
                            法說會：只顯示持倉 &amp; 關注清單的股票
                        </button>
                    </div>
                )}

                <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: selectedDay ? '1fr 300px' : '1fr' }}>
                    {/* 月曆 */}
                    <div style={card}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                            <button onClick={prevMonth} style={{ background: 'none', border: 'none', color: '#e2e8f0', cursor: 'pointer', display: 'flex', padding: '6px' }}><ChevronLeft size={20} /></button>
                            <span style={{ fontSize: '18px', fontWeight: 700, color: '#e2e8f0' }}>{year} 年 {month} 月</span>
                            <button onClick={nextMonth} style={{ background: 'none', border: 'none', color: '#e2e8f0', cursor: 'pointer', display: 'flex', padding: '6px' }}><ChevronRight size={20} /></button>
                        </div>

                        <div className="cal-grid" style={{ marginBottom: '4px' }}>
                            {WEEKDAYS.map(d => (
                                <div key={d} style={{ textAlign: 'center', fontSize: '12px', color: '#8892a4', padding: '4px', fontWeight: 600 }}>{d}</div>
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
                                        <div style={{ fontSize: '13px', fontWeight: isToday ? 700 : 400, color: isToday ? '#4f8ef7' : isWeekend ? '#ff8888' : '#e2e8f0', marginBottom: '4px' }}>{d}</div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                            {dayEvents.slice(0, 3).map(ev => (
                                                <div key={ev.id} style={{ fontSize: '10px', backgroundColor: `${EVENT_COLORS[ev.type]}22`, color: EVENT_COLORS[ev.type], borderRadius: '3px', padding: '1px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {ev.title}
                                                </div>
                                            ))}
                                            {dayEvents.length > 3 && <div style={{ fontSize: '10px', color: '#8892a4' }}>+{dayEvents.length - 3} 更多</div>}
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
                                <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>{selectedDay.replace(/-/g, '/')}</span>
                                <button onClick={() => setSelectedDay(null)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={16} /></button>
                            </div>
                            {selectedEvents.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '32px', color: '#8892a4', fontSize: '13px' }}>這天沒有事件</div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {selectedEvents.map(ev => (
                                        <div key={ev.id} style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '12px', borderLeft: `3px solid ${EVENT_COLORS[ev.type]}` }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                                                <div style={{ flex: 1 }}>
                                                    <div style={{ fontSize: '12px', color: EVENT_COLORS[ev.type], fontWeight: 600, marginBottom: '4px' }}>{EVENT_LABELS[ev.type]}</div>
                                                    <div style={{ fontSize: '13px', color: '#e2e8f0', fontWeight: 600, marginBottom: '4px' }}>{ev.title}</div>
                                                    {ev.description && <div style={{ fontSize: '12px', color: '#8892a4' }}>{ev.description}</div>}
                                                </div>
                                                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                                                    {ev.url && (
                                                        <a href={ev.url} target="_blank" rel="noopener noreferrer"
                                                            style={{ color: '#4f8ef7', display: 'flex' }}><ExternalLink size={14} /></a>
                                                    )}
                                                    {ev.type === 'personal' && (
                                                        <button onClick={() => handleDeleteEvent(ev.id)}
                                                            style={{ background: 'none', border: 'none', color: '#ff5757', cursor: 'pointer', padding: 0 }}>
                                                            <X size={14} />
                                                        </button>
                                                    )}
                                                    {ev.type === 'investor' && ev.stockCode && (
                                                        <button onClick={() => handleDeleteInvestorDate(ev.stockCode!, ev.date)}
                                                            style={{ background: 'none', border: 'none', color: '#ff5757', cursor: 'pointer', padding: 0 }}
                                                            title="刪除此法說會日期">
                                                            <X size={14} />
                                                        </button>
                                                    )}
                                                    {ev.type === 'dividend' && (
                                                        <button onClick={() => handleDeleteDividend(ev)}
                                                            style={{ background: 'none', border: 'none', color: '#ff5757', cursor: 'pointer', padding: 0 }}
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
                            <button onClick={() => { setForm(f => ({ ...f, date: selectedDay })); setShowForm(true) }}
                                style={{ ...btn('#21253a'), border: '1px solid #2e3349', width: '100%', justifyContent: 'center', marginTop: '12px', fontSize: '13px' }}>
                                <Plus size={13} />新增行程到這天
                            </button>
                        </div>
                    )}
                </div>

                {/* xlsx 匯入法說會 Modal */}
                {showXlsxImport && (
                    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                        <div style={{ ...card, width: '100%', maxWidth: '520px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <span style={{ fontSize: '16px', fontWeight: 600, color: '#e2e8f0' }}>手動匯入法說會日期</span>
                                <button onClick={() => setShowXlsxImport(false)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={18} /></button>
                            </div>
                            <div style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', border: '1px solid #2e3349', fontSize: '12px', color: '#8892a4', lineHeight: 1.8 }}>
                                <span style={{ color: '#4f8ef7', fontWeight: 600 }}>支援 .xlsx / .xls 格式，必要欄位（順序不限）：</span><br />
                                <span style={{ color: '#e2e8f0' }}>股票代號</span>、<span style={{ color: '#e2e8f0' }}>股票名稱</span>、<span style={{ color: '#e2e8f0' }}>法說會日期</span><br />
                                日期格式：<span style={{ color: '#00c896' }}>YYYY-MM-DD</span> 或 <span style={{ color: '#00c896' }}>YYYY/MM/DD</span>（Excel 日期格式亦可）<br />
                                <span style={{ color: '#f5a623' }}>※ 匯入的日期會與 Firestore 既有資料合併（不覆蓋）</span>
                            </div>
                            <label style={{ ...btn('#00c896'), width: 'fit-content', cursor: 'pointer', opacity: xlsxImporting ? 0.6 : 1 }}>
                                <Upload size={15} />
                                {xlsxImporting ? '匯入中...' : '選擇 Excel 檔案匯入'}
                                <input type="file" accept=".xlsx,.xls" onChange={handleXlsxImport} disabled={xlsxImporting} style={{ display: 'none' }} />
                            </label>
                            <button style={{ ...btn('#2e3349'), marginTop: '12px' }} onClick={() => setShowXlsxImport(false)}><X size={14} />關閉</button>
                        </div>
                    </div>
                )}

                {/* 新增行程 Modal */}
                {showForm && (
                    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                        <div style={{ ...card, width: '100%', maxWidth: '480px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                                <span style={{ fontSize: '16px', fontWeight: 600, color: '#e2e8f0' }}>新增個人行程</span>
                                <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={18} /></button>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
                                <button style={btn('#2e3349')} onClick={() => setShowForm(false)}><X size={14} />取消</button>
                                <button style={btn('#4f8ef7')} onClick={handleAddEvent}>新增</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </>
    )
}