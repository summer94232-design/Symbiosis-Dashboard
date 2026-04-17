import { useState, useEffect } from 'react'
import { collection, getDocs, addDoc, deleteDoc, doc, orderBy, query, setDoc, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { calcPositions, type TradeRecord } from '../../lib/calc'
import { FOMC_DATES, TECH_EVENTS, getFuturesSettlementDates, EVENT_COLORS, EVENT_LABELS, type CalendarEvent } from '../../lib/calendarData'
import { Plus, X, ChevronLeft, ChevronRight, RefreshCw, ExternalLink } from 'lucide-react'

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

// Firestore investorMeetings 文件格式
// doc ID: `{stockCode}-{YYYY-MM}`  例如 `2330-2026-04`
// 欄位: { stockCode, stockName, yearMonth, dates: string[], updatedAt }

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
    const [loadingInvestor, setLoadingInvestor] = useState(false)
    const [investorError, setInvestorError] = useState<string | null>(null)
    const [investorInfo, setInvestorInfo] = useState<string | null>(null)
    const [watchList, setWatchList] = useState<string[]>([])
    const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set(['fomc', 'futures', 'tech', 'investor', 'personal', 'dividend']))
    const [form, setForm] = useState({ title: '', date: '', description: '', url: '' })

    const loadPersonal = async () => {
        const snap = await getDocs(query(userCol(investDB, 'calendarEvents'), orderBy('date', 'asc')))
        setPersonalEvents(snap.docs.map(d => ({ id: d.id, ...d.data() } as CalendarEvent)))
    }

    const loadWatchList = async () => {
        const snap = await getDocs(userCol(investDB, 'calendarWatchList'))
        setWatchList(snap.docs.map(d => d.data().code as string).filter(Boolean))
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

    // 從 Firestore 讀取已儲存的法說會資料（進入頁面時呼叫）
    const loadInvestorFromFirestore = async (y: number, m: number) => {
        const yearMonth = `${y}-${String(m).padStart(2, '0')}`
        const snap = await getDocs(userCol(investDB, 'investorMeetings'))
        const evts: CalendarEvent[] = []
        snap.docs.forEach(d => {
            const data = d.data()
            // 只取當月資料
            if (data.yearMonth !== yearMonth) return
            const dates: string[] = Array.isArray(data.dates) ? data.dates : []
            dates.forEach((isoDate: string) => {
                evts.push({
                    id: `investor-${data.stockCode}-${isoDate}`,
                    date: isoDate,
                    title: `${data.stockName || data.stockCode} 法說會`,
                    type: 'investor',
                    stockCode: data.stockCode,
                    description: `${data.stockName || data.stockCode}（${data.stockCode}）法人說明會`
                })
            })
        })
        setInvestorEvents(evts)
    }

    // 手動更新法說會：打 API → 比對 Firestore → 有變動就寫入
    const loadInvestorMeetings = async () => {
        setLoadingInvestor(true)
        setInvestorError(null)
        setInvestorInfo(null)

        try {
            // 取得持倉股票
            const tradesSnap = await getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'asc')))
            const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
            const { holdings } = calcPositions(trades)
            const holdingCodes = Object.keys(holdings)

            // 查詢清單 = 持倉 + 關注清單（去重）
            const currentWatchList = Array.isArray(watchList) ? watchList : []
            const allCodes = [...new Set([...holdingCodes, ...currentWatchList])]

            console.log('法說會查詢股票清單：', allCodes)

            if (allCodes.length === 0) {
                setInvestorEvents([])
                setLoadingInvestor(false)
                return
            }

            const yearMonth = `${year}-${String(month).padStart(2, '0')}`
            let successCount = 0
            let failCount = 0
            let changedCount = 0  // 有變動的股票數
            const newAllEvents: CalendarEvent[] = []

            for (const code of allCodes) {
                try {
                    console.log(`查詢 ${code} 法說會...`)

                    const res = await fetch(
                        `/.netlify/functions/mops-proxy?stockNo=${encodeURIComponent(code)}&year=${year}&month=${month}`
                    )

                    if (!res.ok) {
                        console.warn(`${code} 回應異常：HTTP ${res.status}`)
                        failCount++
                        continue
                    }

                    let json: { source?: string; dates?: string[]; error?: string }
                    try {
                        json = await res.json()
                    } catch {
                        console.warn(`${code} JSON 解析失敗`)
                        failCount++
                        continue
                    }

                    if (json.error) {
                        console.warn(`${code} 查詢錯誤：`, json.error)
                        failCount++
                        continue
                    }

                    // 過濾有效日期（當月）
                    const rawDates: string[] = Array.isArray(json.dates) ? json.dates : []
                    const newDates = rawDates.filter(isoDate => {
                        if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false
                        const [y, m] = isoDate.split('-')
                        return parseInt(y) === year && parseInt(m) === month
                    })

                    console.log(`${code} 法說會日期（來源：${json.source}）:`, newDates)

                    const stockName = holdings[code]?.name || code
                    const docId = `${code}-${yearMonth}`
                    const docRef = userDoc(investDB, 'investorMeetings', docId)

                    // 讀取 Firestore 既有資料做比對
                    const existing = await getDoc(docRef)
                    const oldDates: string[] = existing.exists() ? (existing.data().dates || []) : []

                    // 比對：排序後轉字串比較
                    const oldSorted = [...oldDates].sort().join(',')
                    const newSorted = [...newDates].sort().join(',')
                    const hasChanged = oldSorted !== newSorted

                    if (hasChanged) {
                        // 寫入 Firestore（新增或更新）
                        await setDoc(docRef, {
                            stockCode: code,
                            stockName,
                            yearMonth,
                            dates: newDates,
                            updatedAt: new Date().toISOString()
                        })
                        changedCount++
                        console.log(`${code} 法說會有變動：${JSON.stringify(oldDates)} → ${JSON.stringify(newDates)}`)
                    }

                    // 組成 CalendarEvent
                    newDates.forEach((isoDate: string) => {
                        newAllEvents.push({
                            id: `investor-${code}-${isoDate}`,
                            date: isoDate,
                            title: `${stockName} 法說會`,
                            type: 'investor',
                            stockCode: code,
                            description: `${stockName}（${code}）法人說明會`
                        })
                    })

                    successCount++
                } catch (err) {
                    console.error(`${code} 法說會查詢失敗：`, err)
                    failCount++
                }
            }

            console.log(`法說會查詢完成：成功 ${successCount} / 失敗 ${failCount}，變動 ${changedCount} 檔，共 ${newAllEvents.length} 個事件`)
            setInvestorEvents(newAllEvents)

            // 顯示結果訊息
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

    useEffect(() => {
        loadPersonal()
        loadWatchList()
        loadDividends()
        loadTasks()
    }, [])

    // 切換月份或初始進入時，從 Firestore 直接讀取（不打 API）
    useEffect(() => {
        loadInvestorFromFirestore(year, month)
    }, [year, month])

    // 合併所有事件
    useEffect(() => {
        const futuresDates = getFuturesSettlementDates(year, month)
        const allEvents = [
            ...FOMC_DATES,
            ...TECH_EVENTS,
            ...futuresDates,
            ...personalEvents,
            ...dividendEvents,
            ...investorEvents,
            ...taskEvents,
        ].filter(e => filterTypes.has(e.type))
        setEvents(allEvents)
    }, [year, month, personalEvents, dividendEvents, investorEvents, taskEvents, filterTypes])

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
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={loadInvestorMeetings} disabled={loadingInvestor} style={btn('#21253a')}>
                            <RefreshCw size={14} style={{ animation: loadingInvestor ? 'spin 1s linear infinite' : 'none' }} />
                            {loadingInvestor ? '更新中...' : '更新法說會'}
                        </button>
                        <button onClick={() => setShowForm(true)} style={btn('#4f8ef7')}>
                            <Plus size={14} />新增行程
                        </button>
                    </div>
                </div>

                {/* 法說會錯誤提示 */}
                {investorError && (
                    <div style={{
                        backgroundColor: 'rgba(255,180,0,0.10)',
                        border: '1px solid rgba(255,180,0,0.35)',
                        borderRadius: '8px',
                        padding: '10px 16px',
                        marginBottom: '16px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '12px'
                    }}>
                        <span style={{ fontSize: '13px', color: '#f5c842' }}>⚠️ {investorError}</span>
                        <button onClick={() => setInvestorError(null)}
                            style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer', flexShrink: 0 }}>
                            <X size={14} />
                        </button>
                    </div>
                )}

                {/* 法說會更新成功提示 */}
                {investorInfo && (
                    <div style={{
                        backgroundColor: 'rgba(0,200,150,0.10)',
                        border: '1px solid rgba(0,200,150,0.35)',
                        borderRadius: '8px',
                        padding: '10px 16px',
                        marginBottom: '16px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '12px'
                    }}>
                        <span style={{ fontSize: '13px', color: '#00c896' }}>{investorInfo}</span>
                        <button onClick={() => setInvestorInfo(null)}
                            style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer', flexShrink: 0 }}>
                            <X size={14} />
                        </button>
                    </div>
                )}

                {/* 篩選器 */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '16px' }}>
                    {Object.entries(EVENT_LABELS).map(([type, label]) => (
                        <button key={type} onClick={() => toggleFilter(type)}
                            style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 12px', borderRadius: '20px', border: '1px solid', borderColor: filterTypes.has(type) ? EVENT_COLORS[type] : '#2e3349', backgroundColor: filterTypes.has(type) ? `${EVENT_COLORS[type]}18` : 'transparent', color: filterTypes.has(type) ? EVENT_COLORS[type] : '#8892a4', fontSize: '12px', cursor: 'pointer' }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: EVENT_COLORS[type], display: 'inline-block' }} />
                            {label}
                        </button>
                    ))}
                </div>

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

                {/* 新增行程表單 */}
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