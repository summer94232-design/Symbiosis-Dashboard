import { card } from '../../ui/styles'
import { captureUserSession } from '../../lib/userDB'
import AnnualDataNotice from '../../components/AnnualDataNotice'
import { useInvestSync } from '../../InvestSyncContext'
import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchCalendarEvents, fetchTasks } from '../../lib/plannerData'
import { getDailyNews } from '../../lib/gemini'
import { FOMC_DATES, TECH_EVENTS, getFuturesSettlementDates, EVENT_COLORS, EVENT_LABELS } from '../../lib/calendarData'
import { toLocalDateString } from '../../lib/date'
import { eventOccursOn, type EventTiming } from '../../lib/calendarTiming'
import { RefreshCw, Calendar, CheckSquare, Globe, Newspaper, AlertCircle } from 'lucide-react'

interface NewsItem {
    title: string
    category: string
    url: string
    source: string
}

interface EventItem extends EventTiming {
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

const CATEGORY_COLORS: Record<string, string> = {
    市場: 'var(--c-positive)', 科技: '#a78bfa', 經濟: 'var(--c-warning)', 政治: 'var(--c-danger)'
}

function readNewsCache(): { news: NewsItem[]; time: string } | null {
    try {
        if (sessionStorage.getItem('newsDate') !== toLocalDateString()) return null
        const rows: unknown = JSON.parse(sessionStorage.getItem('newsData') || 'null')
        if (!Array.isArray(rows) || !rows.length || !rows.every(row => row && ['title', 'category', 'url', 'source'].every(key => typeof row[key] === 'string'))) return null
        return { news: rows, time: sessionStorage.getItem('newsTime') || '' }
    } catch { return null }
}

export default function DailyBrief() {
    const { version: syncVersion } = useInvestSync()
    const [cachedNews] = useState(readNewsCache)
    const [dataError, setDataError] = useState('')
    const newsRequest = useRef(0)
    const today = new Date()
    const todayStr = toLocalDateString(today)

    const [news, setNews] = useState<NewsItem[]>(cachedNews?.news || [])
    const [newsLoading, setNewsLoading] = useState(!cachedNews)
    const [newsError, setNewsError] = useState('')
    const [todayEvents, setTodayEvents] = useState<EventItem[]>([])
    const [upcomingEvents, setUpcomingEvents] = useState<EventItem[]>([])
    const [todayTasks, setTodayTasks] = useState<TaskItem[]>([])
    const [overdueTasks, setOverdueTasks] = useState<TaskItem[]>([])
    const [dataLoading, setDataLoading] = useState(true)
    const [lastNewsTime, setLastNewsTime] = useState(cachedNews?.time || '')
    const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set())

    useEffect(() => {
        let active = true
        const loadData = async () => {
            try {
                const session = captureUserSession()
                const [personalRows, taskRows] = await Promise.all([
                    fetchCalendarEvents<EventItem>(),
                    fetchTasks<TaskItem>(),
                ])

                if (!active) return
                session.assertActive()
                setDataError('')
                // 行事曆事件
                const personal: EventItem[] = personalRows.map(row => ({
                    ...row,
                    type: row.type || 'personal',
                }))

                const futuresThisMonth = getFuturesSettlementDates(Number(todayStr.slice(0, 4)), Number(todayStr.slice(5, 7)))
                const next14Str = toLocalDateString(new Date(Date.now() + 14 * 86400000))

                const allEvents: EventItem[] = [
                    ...FOMC_DATES,
                    ...TECH_EVENTS,
                    ...futuresThisMonth,
                    ...personal,
                ]

                setTodayEvents(allEvents.filter(e => eventOccursOn(e, todayStr)))
                setUpcomingEvents(
                    allEvents
                        .filter(e => e.date > todayStr && e.date <= next14Str)
                        .sort((a, b) => a.date.localeCompare(b.date))
                        .slice(0, 5)
                )

                // 任務
                const tasks = taskRows
                setTodayTasks(tasks.filter(t => !t.done && t.dueDate === todayStr))
                setOverdueTasks(tasks.filter(t => !t.done && t.dueDate && t.dueDate < todayStr))

            } catch {
                if (active) setDataError('行程與任務載入失敗，請重新整理後重試。')
            } finally { if (active) setDataLoading(false) }
        }
        void loadData()
        return () => { active = false }
    }, [todayStr, syncVersion])

    const loadNews = useCallback(async () => {
        const request = ++newsRequest.current
        try {
            const result = await getDailyNews()
            if (request !== newsRequest.current) return
            setNewsError('')
            if (result.length === 0) {
                setNewsError('新聞服務未回傳資料，請稍後再試')
            } else {
                const time = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
                const todayDate = toLocalDateString()
                setNews(result)
                setLastNewsTime(time)
                setSelectedSources(new Set())
                // Storage restrictions must not turn a successful fetch into an error.
                try {
                    sessionStorage.setItem('newsDate', todayDate)
                    sessionStorage.setItem('newsData', JSON.stringify(result))
                    sessionStorage.setItem('newsTime', time)
                } catch { /* The fetched news is still usable in memory. */ }
            }
        } catch (error) { if (request === newsRequest.current) setNewsError(error instanceof Error ? error.message : '新聞載入失敗') }
        finally { if (request === newsRequest.current) setNewsLoading(false) }
    }, [])

    const cancelNews = useCallback(() => { newsRequest.current++ }, [])
    useEffect(() => {
        if (!cachedNews) void loadNews()
        return cancelNews
    }, [cachedNews, loadNews, cancelNews])

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
        <div style={{ padding: 'var(--ui-page-padding, clamp(16px, 3vw, 32px))', maxWidth: '1200px', margin: '0 auto' }}>
            {dataError && <p role="alert" style={{ color: 'var(--c-danger)' }}>{dataError}</p>}
            {/* 標題 */}
            <div style={{ marginBottom: '16px' }}>
                <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>
                    每日簡報
                </h1>
                <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>
                    {today.toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
                </p>
            </div>

            <AnnualDataNotice fomcRange={{ start: todayStr, end: toLocalDateString(new Date(Date.now() + 14 * 86400000)) }} />
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

                {/* 市場新聞 */}
                <div style={{ ...card, gridColumn: '1 / -1' }}>
                    {/* 標題列 */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Newspaper size={16} color="var(--c-accent)" />
                            <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-text)' }}>市場新聞</span>
                            {lastNewsTime && <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>更新於 {lastNewsTime}</span>}
                        </div>
                        <button onClick={() => { setNewsLoading(true); setNewsError(''); void loadNews() }} disabled={newsLoading}
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
                                    backgroundColor: selectedSources.size === 0 ? 'var(--c-button-accent)' : 'transparent',
                                    borderColor: selectedSources.size === 0 ? 'var(--c-button-accent)' : 'var(--c-border)',
                                    color: selectedSources.size === 0 ? 'var(--c-on-accent)' : 'var(--c-muted)',
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
                                            backgroundColor: active ? 'var(--c-button-accent)' : 'transparent',
                                            borderColor: active ? 'var(--c-button-accent)' : 'var(--c-border)',
                                            color: active ? 'var(--c-on-accent)' : 'var(--c-muted)',
                                        }}>
                                        {src} <span style={{ opacity: 0.75 }}>({count})</span>
                                    </button>
                                )
                            })}
                        </div>
                    )}

                    {newsError && (
                        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)' }}>
                            <AlertCircle size={24} style={{ marginBottom: '8px', color: 'var(--c-danger)' }} />
                            <div role="alert" style={{ fontSize: '14px' }}>{newsError}</div>
                        </div>
                    )}
                    {newsLoading && news.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)', fontSize: '14px' }}>
                            正在搜尋最新市場資訊...
                        </div>
                    ) : newsError && news.length === 0 ? null : filteredNews.length === 0 ? (
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
