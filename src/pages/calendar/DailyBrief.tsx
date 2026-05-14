import { useState, useEffect } from 'react'
import { collection, getDocs, query, orderBy } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { getDailyNews } from '../../lib/gemini'
import { FOMC_DATES, TECH_EVENTS, getFuturesSettlementDates, EVENT_COLORS, EVENT_LABELS } from '../../lib/calendarData'
import { calcPositions, type TradeRecord, type DividendRecord } from '../../lib/calc'
import { RefreshCw, Calendar, CheckSquare, TrendingUp, Globe, Newspaper, AlertCircle } from 'lucide-react'

interface NewsItem {
    title: string
    category: string
    url: string
    source: string
}

interface EventItem {
    id: string
    date: string
    title: string
    type: string
    description?: string
}

interface TaskItem {
    id: string
    title: string
    done: boolean
    dueDate?: string
    priority?: string
}

interface HoldingItem {
    code: string
    name: string
    shares: number
    currentPrice: number | null
    avgCost: number
    returnRate: number | null
}

const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px' }
const CATEGORY_COLORS: Record<string, string> = {
    市場: 'var(--c-positive)', 科技: '#a78bfa', 經濟: 'var(--c-warning)', 政治: 'var(--c-danger)'
}

export default function DailyBrief() {
    const today = new Date()
    const todayStr = today.toISOString().split('T')[0]

    const [news, setNews] = useState<NewsItem[]>([])
    const [newsLoading, setNewsLoading] = useState(false)
    const [newsError, setNewsError] = useState(false)
    const [todayEvents, setTodayEvents] = useState<EventItem[]>([])
    const [upcomingEvents, setUpcomingEvents] = useState<EventItem[]>([])
    const [todayTasks, setTodayTasks] = useState<TaskItem[]>([])
    const [overdueTasks, setOverdueTasks] = useState<TaskItem[]>([])
    const [holdings, setHoldings] = useState<HoldingItem[]>([])
    const [dataLoading, setDataLoading] = useState(true)
    const [lastNewsTime, setLastNewsTime] = useState('')
    const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set())

    const loadData = async () => {
        setDataLoading(true)
        try {
            const [personalSnap, taskSnap, tradesSnap, dividendsSnap, settingsSnap] = await Promise.all([
                getDocs(userCol(investDB, 'calendarEvents')),
                getDocs(query(userCol(investDB, 'tasks'), orderBy('order', 'asc'))),
                getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'asc'))),
                getDocs(userCol(investDB, 'dividends')),
                getDocs(userCol(investDB, 'settings'))
            ])

            // 行事曆事件
            const personal: EventItem[] = personalSnap.docs.map(d => ({
                id: d.id,
                date: d.data().date as string,
                title: d.data().title as string,
                type: 'personal',
                description: d.data().description
            }))

            const futuresThisMonth = getFuturesSettlementDates(today.getFullYear(), today.getMonth() + 1)
            const next14Str = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]

            const allEvents: EventItem[] = [
                ...FOMC_DATES,
                ...TECH_EVENTS,
                ...futuresThisMonth,
                ...personal,
            ]

            setTodayEvents(allEvents.filter(e => e.date === todayStr))
            setUpcomingEvents(
                allEvents
                    .filter(e => e.date > todayStr && e.date <= next14Str)
                    .sort((a, b) => a.date.localeCompare(b.date))
                    .slice(0, 5)
            )

            // 任務
            const tasks: TaskItem[] = taskSnap.docs.map(d => ({
                id: d.id,
                title: d.data().title as string,
                done: d.data().done as boolean,
                dueDate: d.data().dueDate as string | undefined,
                priority: d.data().priority as string | undefined
            }))
            setTodayTasks(tasks.filter(t => !t.done && t.dueDate === todayStr))
            setOverdueTasks(tasks.filter(t => !t.done && t.dueDate && t.dueDate < todayStr))

            // 持倉
            const priceData: Record<string, number> = settingsSnap.docs.find(d => d.id === 'lastPrices')?.data() || {}
            const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
            const dividends = dividendsSnap.docs.map(d => d.data() as DividendRecord)
            const { holdings: positions } = calcPositions(trades, dividends)

            const holdingList: HoldingItem[] = Object.values(positions)
                .filter(pos => pos.shares > 0)
                .map(pos => {
                    const currentPrice = priceData[pos.code] ?? null
                    const returnRate = currentPrice !== null
                        ? ((currentPrice - pos.avgCost) / pos.avgCost) * 100
                        : null
                    return { code: pos.code, name: pos.name, shares: pos.shares, currentPrice, avgCost: pos.avgCost, returnRate }
                })
                .sort((a, b) => (b.returnRate ?? -999) - (a.returnRate ?? -999))

            setHoldings(holdingList)
        } catch (err) { console.error(err) }
        setDataLoading(false)
    }

    const loadNews = async () => {
        setNewsLoading(true)
        setNewsError(false)
        try {
            const result = await getDailyNews()
            if (result.length === 0) {
                setNewsError(true)
            } else {
                const time = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
                const todayDate = new Date().toISOString().split('T')[0]
                setNews(result)
                setLastNewsTime(time)
                setSelectedSources(new Set())
                sessionStorage.setItem('newsDate', todayDate)
                sessionStorage.setItem('newsData', JSON.stringify(result))
                sessionStorage.setItem('newsTime', time)
            }
        } catch { setNewsError(true) }
        setNewsLoading(false)
    }

    useEffect(() => {
        loadData()

        const todayDate = new Date().toISOString().split('T')[0]
        const cachedDate = sessionStorage.getItem('newsDate')
        const cachedNews = sessionStorage.getItem('newsData')

        if (cachedDate === todayDate && cachedNews) {
            try {
                setNews(JSON.parse(cachedNews))
                setLastNewsTime(sessionStorage.getItem('newsTime') || '')
            } catch { loadNews() }
        } else {
            loadNews()
        }
    }, [])

    // 來源篩選邏輯
    const allSources = Array.from(new Set(news.map(n => n.source).filter(Boolean)))
    const filteredNews = selectedSources.size === 0
        ? news
        : news.filter(n => selectedSources.has(n.source))

    const toggleSource = (src: string) => {
        setSelectedSources(prev => {
            const next = new Set(prev)
            if (next.has(src)) next.delete(src)
            else next.add(src)
            return next
        })
    }

    return (
        <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1200px', margin: '0 auto' }}>
            {/* 標題 */}
            <div style={{ marginBottom: '24px' }}>
                <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>
                    每日簡報
                </h1>
                <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>
                    {today.toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
                </p>
            </div>

            <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>

                {/* 今日事件 */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                        <Calendar size={16} color="var(--c-accent)" />
                        <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-text)' }}>今日事件</span>
                    </div>
                    {dataLoading ? (
                        <div style={{ color: 'var(--c-muted)', fontSize: '13px' }}>載入中...</div>
                    ) : todayEvents.length === 0 ? (
                        <div style={{ color: 'var(--c-muted)', fontSize: '13px' }}>今日無排程事件</div>
                    ) : (
                        todayEvents.map(e => (
                            <div key={e.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '10px', backgroundColor: 'var(--c-bg)', borderRadius: '8px', marginBottom: '8px' }}>
                                <span style={{ fontSize: '11px', backgroundColor: `${EVENT_COLORS[e.type] || 'var(--c-muted)'}20`, color: EVENT_COLORS[e.type] || 'var(--c-muted)', padding: '2px 8px', borderRadius: '10px', whiteSpace: 'nowrap', marginTop: '1px' }}>
                                    {EVENT_LABELS[e.type] || e.type}
                                </span>
                                <div>
                                    <div style={{ fontSize: '13px', color: 'var(--c-text)' }}>{e.title}</div>
                                    {e.description && <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginTop: '2px' }}>{e.description}</div>}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* 近期事件 */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                        <Globe size={16} color="#a78bfa" />
                        <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-text)' }}>近 14 天事件</span>
                    </div>
                    {dataLoading ? (
                        <div style={{ color: 'var(--c-muted)', fontSize: '13px' }}>載入中...</div>
                    ) : upcomingEvents.length === 0 ? (
                        <div style={{ color: 'var(--c-muted)', fontSize: '13px' }}>近期無特別事件</div>
                    ) : (
                        upcomingEvents.map(e => (
                            <div key={e.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px', backgroundColor: 'var(--c-bg)', borderRadius: '8px', marginBottom: '8px' }}>
                                <div style={{ fontSize: '12px', color: 'var(--c-muted)', whiteSpace: 'nowrap', marginTop: '1px', minWidth: '72px' }}>{e.date.slice(5)}</div>
                                <div>
                                    <span style={{ fontSize: '11px', backgroundColor: `${EVENT_COLORS[e.type] || 'var(--c-muted)'}20`, color: EVENT_COLORS[e.type] || 'var(--c-muted)', padding: '1px 6px', borderRadius: '10px', marginRight: '6px' }}>
                                        {EVENT_LABELS[e.type] || e.type}
                                    </span>
                                    <span style={{ fontSize: '13px', color: 'var(--c-text)' }}>{e.title}</span>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* 今日任務 */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                        <CheckSquare size={16} color="var(--c-positive)" />
                        <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-text)' }}>今日任務</span>
                        {overdueTasks.length > 0 && (
                            <span style={{ fontSize: '11px', backgroundColor: 'rgba(255,87,87,0.15)', color: 'var(--c-danger)', padding: '2px 8px', borderRadius: '10px' }}>
                                {overdueTasks.length} 個逾期
                            </span>
                        )}
                    </div>
                    {dataLoading ? (
                        <div style={{ color: 'var(--c-muted)', fontSize: '13px' }}>載入中...</div>
                    ) : (
                        <>
                            {todayTasks.length === 0 && overdueTasks.length === 0 ? (
                                <div style={{ color: 'var(--c-muted)', fontSize: '13px' }}>今日無待辦任務 🎉</div>
                            ) : null}
                            {overdueTasks.map(t => (
                                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', backgroundColor: 'rgba(255,87,87,0.08)', border: '1px solid rgba(255,87,87,0.2)', borderRadius: '8px', marginBottom: '6px' }}>
                                    <AlertCircle size={13} color="var(--c-danger)" />
                                    <span style={{ fontSize: '13px', color: 'var(--c-text)', flex: 1 }}>{t.title}</span>
                                    <span style={{ fontSize: '11px', color: 'var(--c-danger)' }}>{t.dueDate}</span>
                                </div>
                            ))}
                            {todayTasks.map(t => (
                                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', backgroundColor: 'var(--c-bg)', borderRadius: '8px', marginBottom: '6px' }}>
                                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: t.priority === 'high' ? 'var(--c-danger)' : t.priority === 'low' ? 'var(--c-positive)' : 'var(--c-warning)', flexShrink: 0 }} />
                                    <span style={{ fontSize: '13px', color: 'var(--c-text)' }}>{t.title}</span>
                                </div>
                            ))}
                        </>
                    )}
                </div>

                {/* 持倉概覽 */}
                <div style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                        <TrendingUp size={16} color="var(--c-warning)" />
                        <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-text)' }}>持倉概覽</span>
                    </div>
                    {dataLoading ? (
                        <div style={{ color: 'var(--c-muted)', fontSize: '13px' }}>載入中...</div>
                    ) : holdings.length === 0 ? (
                        <div style={{ color: 'var(--c-muted)', fontSize: '13px' }}>目前無持倉</div>
                    ) : (
                        holdings.slice(0, 6).map(h => (
                            <div key={h.code} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', backgroundColor: 'var(--c-bg)', borderRadius: '8px', marginBottom: '6px' }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: '13px', color: 'var(--c-accent)', fontWeight: 600 }}>{h.code}</div>
                                    <div style={{ fontSize: '11px', color: 'var(--c-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name} · {h.shares.toLocaleString()} 股</div>
                                </div>
                                {h.returnRate !== null ? (
                                    <span style={{ fontSize: '13px', fontWeight: 600, color: h.returnRate >= 0 ? 'var(--c-positive)' : 'var(--c-danger)', whiteSpace: 'nowrap' }}>
                                        {h.returnRate >= 0 ? '+' : ''}{h.returnRate.toFixed(2)}%
                                    </span>
                                ) : (
                                    <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>—</span>
                                )}
                            </div>
                        ))
                    )}
                    {holdings.length > 6 && (
                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', textAlign: 'center', marginTop: '8px' }}>
                            還有 {holdings.length - 6} 檔持倉...
                        </div>
                    )}
                </div>

                {/* 市場新聞 */}
                <div style={{ ...card, gridColumn: 'span 2' }}>
                    {/* 標題列 */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Newspaper size={16} color="var(--c-accent)" />
                            <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-text)' }}>市場新聞</span>
                            {lastNewsTime && <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>更新於 {lastNewsTime}</span>}
                        </div>
                        <button onClick={loadNews} disabled={newsLoading}
                            style={{ background: 'none', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '6px 12px', color: 'var(--c-muted)', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', opacity: newsLoading ? 0.6 : 1 }}>
                            <RefreshCw size={13} style={{ animation: newsLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {newsLoading ? '載入中...' : '重新整理'}
                        </button>
                    </div>

                    {/* 來源篩選 tabs */}
                    {allSources.length > 0 && (
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '16px' }}>
                            <button
                                onClick={() => setSelectedSources(new Set())}
                                style={{
                                    fontSize: '12px', padding: '4px 14px', borderRadius: '20px',
                                    border: '1px solid', cursor: 'pointer', transition: 'all 0.15s',
                                    backgroundColor: selectedSources.size === 0 ? 'var(--c-accent)' : 'transparent',
                                    borderColor: selectedSources.size === 0 ? 'var(--c-accent)' : 'var(--c-border)',
                                    color: selectedSources.size === 0 ? '#fff' : 'var(--c-muted)',
                                }}>
                                全部 {selectedSources.size === 0 && <span style={{ opacity: 0.75 }}>({news.length})</span>}
                            </button>
                            {allSources.map(src => {
                                const active = selectedSources.has(src)
                                const count = news.filter(n => n.source === src).length
                                return (
                                    <button
                                        key={src}
                                        onClick={() => toggleSource(src)}
                                        style={{
                                            fontSize: '12px', padding: '4px 14px', borderRadius: '20px',
                                            border: '1px solid', cursor: 'pointer', transition: 'all 0.15s',
                                            backgroundColor: active ? 'var(--c-accent)' : 'transparent',
                                            borderColor: active ? 'var(--c-accent)' : 'var(--c-border)',
                                            color: active ? '#fff' : 'var(--c-muted)',
                                        }}>
                                        {src} <span style={{ opacity: 0.75 }}>({count})</span>
                                    </button>
                                )
                            })}
                        </div>
                    )}

                    {newsError ? (
                        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)' }}>
                            <AlertCircle size={24} style={{ marginBottom: '8px', color: 'var(--c-danger)' }} />
                            <div style={{ fontSize: '14px' }}>新聞載入失敗，請稍後再試</div>
                        </div>
                    ) : newsLoading && news.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)', fontSize: '14px' }}>
                            正在搜尋最新市場資訊...
                        </div>
                    ) : filteredNews.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)', fontSize: '14px' }}>
                            此來源目前沒有新聞
                        </div>
                    ) : (
                        <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                            {filteredNews.map((item, i) => (
                                <a
                                    key={i}
                                    href={item.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                        padding: '12px',
                                        backgroundColor: 'var(--c-bg)',
                                        borderRadius: '8px',
                                        border: '1px solid var(--c-border)',
                                        textDecoration: 'none',
                                        display: 'block',
                                        transition: 'border-color 0.15s',
                                    }}
                                    onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--c-accent)')}
                                    onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--c-border)')}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                        <span style={{ fontSize: '11px', backgroundColor: `${CATEGORY_COLORS[item.category] || 'var(--c-muted)'}20`, color: CATEGORY_COLORS[item.category] || 'var(--c-muted)', padding: '2px 8px', borderRadius: '10px', whiteSpace: 'nowrap' }}>
                                            {item.category}
                                        </span>
                                        {item.source && (
                                            <span style={{ fontSize: '11px', color: 'var(--c-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {item.source}
                                            </span>
                                        )}
                                    </div>
                                    <div style={{ fontSize: '13px', color: 'var(--c-text)', fontWeight: 500, lineHeight: 1.5 }}>
                                        {item.title}
                                    </div>
                                    <div style={{ fontSize: '11px', color: 'var(--c-accent)', marginTop: '8px' }}>
                                        閱讀原文 →
                                    </div>
                                </a>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
        </div>
    )
}