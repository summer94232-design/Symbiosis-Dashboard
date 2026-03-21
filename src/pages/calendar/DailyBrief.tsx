import { useState, useEffect } from 'react'
import { collection, getDocs, query, orderBy } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { getDailyNews } from '../../lib/gemini'
import { FOMC_DATES, TECH_EVENTS, getFuturesSettlementDates, EVENT_COLORS, EVENT_LABELS } from '../../lib/calendarData'
import { RefreshCw, Calendar, CheckSquare, TrendingUp, Globe, Newspaper, AlertCircle } from 'lucide-react'

interface NewsItem {
  title: string
  summary: string
  category: string
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

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const CATEGORY_COLORS: Record<string, string> = {
  市場: '#00c896', 科技: '#a78bfa', 經濟: '#f5a623', 政治: '#ff5757'
}

export default function DailyBrief() {
  const today = new Date()
  const todayStr = today.toISOString().split('T')[0]
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0]

  const [news, setNews] = useState<NewsItem[]>([])
  const [newsLoading, setNewsLoading] = useState(false)
  const [newsError, setNewsError] = useState(false)
  const [todayEvents, setTodayEvents] = useState<EventItem[]>([])
  const [upcomingEvents, setUpcomingEvents] = useState<EventItem[]>([])
  const [todayTasks, setTodayTasks] = useState<TaskItem[]>([])
  const [overdueTasks, setOverdueTasks] = useState<TaskItem[]>([])
  const [holdings, setHoldings] = useState<HoldingItem[]>([])
  const [dataLoading, setDataLoading] = useState(true)
  const [expandedNews, setExpandedNews] = useState<number | null>(null)
  const [lastNewsTime, setLastNewsTime] = useState('')

  const loadData = async () => {
    setDataLoading(true)
    try {
      const [personalSnap, taskSnap, tradesSnap, settingsSnap] = await Promise.all([
        getDocs(collection(investDB, 'calendarEvents')),
        getDocs(query(collection(investDB, 'tasks'), orderBy('order', 'asc'))),
        getDocs(query(collection(investDB, 'trades'), orderBy('date', 'asc'))),
        getDocs(collection(investDB, 'settings'))
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
      const trades = tradesSnap.docs.map(d => d.data())
      const map: Record<string, { shares: number; cost: number; name: string }> = {}

      trades.forEach((t: any) => {
        if (!map[t.code]) map[t.code] = { shares: 0, cost: 0, name: t.name || t.code }
        if (t.type === 'buy') {
          map[t.code].shares += t.shares
          map[t.code].cost += t.price * t.shares
        } else {
          const avgCost = map[t.code].shares > 0 ? map[t.code].cost / map[t.code].shares : 0
          map[t.code].shares -= t.shares
          map[t.code].cost -= avgCost * t.shares
        }
      })

      const holdingList: HoldingItem[] = Object.entries(map)
        .filter(([, v]) => v.shares > 0)
        .map(([code, v]) => {
          const currentPrice = priceData[code] ?? null
          const avgCost = v.shares > 0 ? v.cost / v.shares : 0
          const returnRate = currentPrice !== null ? ((currentPrice - avgCost) / avgCost) * 100 : null
          return { code, name: v.name, shares: v.shares, currentPrice, avgCost, returnRate }
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
const today = new Date().toISOString().split('T')[0]
setNews(result)
setLastNewsTime(time)
// 存入 sessionStorage，同一天內不重複搜尋
sessionStorage.setItem('newsDate', today)
sessionStorage.setItem('newsData', JSON.stringify(result))
sessionStorage.setItem('newsTime', time)
      }
    } catch { setNewsError(true) }
    setNewsLoading(false)
  }

  useEffect(() => {
  loadData()

  // 檢查今天是否已經載入過新聞
  const today = new Date().toISOString().split('T')[0]
  const cachedDate = sessionStorage.getItem('newsDate')
  const cachedNews = sessionStorage.getItem('newsData')

  if (cachedDate === today && cachedNews) {
    // 今天已載入過，直接用快取
    try {
      setNews(JSON.parse(cachedNews))
      setLastNewsTime(sessionStorage.getItem('newsTime') || '')
    } catch { loadNews() }
  } else {
    // 今天第一次打開，重新搜尋
    loadNews()
  }
}, [])

  const pnlColor = (v: number) => v >= 0 ? '#00c896' : '#ff5757'
  const dateLabel = today.toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })

  return (
    <>
      <style>{`
        .brief-grid { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; }
        @media (max-width: 900px) { .brief-grid { grid-template-columns: 1fr; } }
        .brief-grid-3 { display: grid; gap: 16px; grid-template-columns: 1fr 1fr 1fr; }
        @media (max-width: 900px) { .brief-grid-3 { grid-template-columns: 1fr; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .news-card { cursor: pointer; transition: border-color 0.15s; }
        .news-card:hover { border-color: #4f8ef7 !important; }
      `}</style>

      <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1400px', margin: '0 auto' }}>

        {/* 標題 */}
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 24px)', fontWeight: 700, color: '#e2e8f0', margin: '0 0 4px' }}>☀️ 今日簡報</h1>
          <p style={{ fontSize: '14px', color: '#8892a4', margin: 0 }}>{dateLabel}</p>
        </div>

        {/* 摘要卡片 */}
        <div className="brief-grid-3" style={{ marginBottom: '20px' }}>
          <div style={{ ...card, borderColor: todayEvents.length > 0 ? '#f5a623' : '#2e3349' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <Calendar size={16} color="#f5a623" />
              <span style={{ fontSize: '13px', color: '#8892a4' }}>今日事件</span>
            </div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: todayEvents.length > 0 ? '#f5a623' : '#e2e8f0' }}>
              {todayEvents.length}
            </div>
            <div style={{ fontSize: '12px', color: '#8892a4', marginTop: '4px' }}>
              {todayEvents.length > 0 ? todayEvents.map(e => e.title).join('、') : '今天沒有特別事件'}
            </div>
          </div>

          <div style={{ ...card, borderColor: (todayTasks.length + overdueTasks.length) > 0 ? '#4f8ef7' : '#2e3349' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <CheckSquare size={16} color="#4f8ef7" />
              <span style={{ fontSize: '13px', color: '#8892a4' }}>待辦任務</span>
            </div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: '#4f8ef7' }}>
              {todayTasks.length + overdueTasks.length}
            </div>
            <div style={{ fontSize: '12px', color: '#8892a4', marginTop: '4px' }}>
              {overdueTasks.length > 0 && <span style={{ color: '#ff5757' }}>⚠️ {overdueTasks.length} 件逾期　</span>}
              {todayTasks.length > 0 ? `今日到期 ${todayTasks.length} 件` : overdueTasks.length === 0 ? '沒有待辦任務 🎉' : ''}
            </div>
          </div>

          <div style={{ ...card, borderColor: '#00c896' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <TrendingUp size={16} color="#00c896" />
              <span style={{ fontSize: '13px', color: '#8892a4' }}>持倉狀況</span>
            </div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: '#00c896' }}>{holdings.length}</div>
            <div style={{ fontSize: '12px', color: '#8892a4', marginTop: '4px' }}>
              {holdings.length > 0
                ? holdings.some(h => h.currentPrice !== null)
                  ? `最佳：${holdings[0].code} ${holdings[0].returnRate !== null ? `${holdings[0].returnRate >= 0 ? '+' : ''}${holdings[0].returnRate.toFixed(1)}%` : '—'}`
                  : '請更新現價'
                : '尚無持倉'}
            </div>
          </div>
        </div>

        <div className="brief-grid">
          {/* 左欄 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* 行事曆 */}
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                <Calendar size={16} color="#4f8ef7" />
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>行事曆</span>
              </div>
              {dataLoading ? (
                <div style={{ color: '#8892a4', fontSize: '13px' }}>載入中...</div>
              ) : (
                <>
                  {todayEvents.length > 0 && (
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ fontSize: '11px', color: '#f5a623', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>今天</div>
                      {todayEvents.map((ev, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', backgroundColor: '#0f1117', borderRadius: '8px', marginBottom: '4px', borderLeft: `3px solid ${EVENT_COLORS[ev.type] || '#4f8ef7'}` }}>
                          <span style={{ fontSize: '11px', color: EVENT_COLORS[ev.type] || '#4f8ef7', fontWeight: 600, flexShrink: 0 }}>{EVENT_LABELS[ev.type] || '行程'}</span>
                          <span style={{ fontSize: '13px', color: '#e2e8f0' }}>{ev.title}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {upcomingEvents.length > 0 && (
                    <div>
                      <div style={{ fontSize: '11px', color: '#8892a4', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>近 14 天</div>
                      {upcomingEvents.map((ev, i) => {
                        const isTomorrow = ev.date === tomorrowStr
                        const label = isTomorrow ? '明天' : ev.date.slice(5).replace('-', '/')
                        return (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', backgroundColor: '#0f1117', borderRadius: '8px', marginBottom: '4px', borderLeft: `3px solid ${EVENT_COLORS[ev.type] || '#4f8ef7'}` }}>
                            <span style={{ fontSize: '11px', color: isTomorrow ? '#ff5757' : '#8892a4', flexShrink: 0, minWidth: '32px' }}>{label}</span>
                            <span style={{ fontSize: '13px', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {todayEvents.length === 0 && upcomingEvents.length === 0 && (
                    <p style={{ fontSize: '13px', color: '#8892a4', margin: 0 }}>近 14 天沒有特別事件</p>
                  )}
                </>
              )}
            </div>

            {/* 待辦任務 */}
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                <CheckSquare size={16} color="#4f8ef7" />
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>今日待辦</span>
              </div>
              {dataLoading ? (
                <div style={{ color: '#8892a4', fontSize: '13px' }}>載入中...</div>
              ) : (
                <>
                  {overdueTasks.length > 0 && (
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ fontSize: '11px', color: '#ff5757', fontWeight: 600, marginBottom: '6px' }}>⚠️ 逾期任務</div>
                      {overdueTasks.slice(0, 3).map(t => (
                        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', backgroundColor: 'rgba(255,87,87,0.06)', borderRadius: '8px', marginBottom: '4px', borderLeft: '3px solid #ff5757' }}>
                          <span style={{ fontSize: '13px', color: '#e2e8f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                          <span style={{ fontSize: '11px', color: '#ff5757', flexShrink: 0 }}>{t.dueDate?.slice(5).replace('-', '/')}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {todayTasks.length > 0 ? (
                    <div>
                      <div style={{ fontSize: '11px', color: '#4f8ef7', fontWeight: 600, marginBottom: '6px' }}>今天到期</div>
                      {todayTasks.map(t => (
                        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', backgroundColor: '#0f1117', borderRadius: '8px', marginBottom: '4px', borderLeft: '3px solid #4f8ef7' }}>
                          <span style={{ fontSize: '13px', color: '#e2e8f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                        </div>
                      ))}
                    </div>
                  ) : overdueTasks.length === 0 ? (
                    <p style={{ fontSize: '13px', color: '#8892a4', margin: 0 }}>🎉 沒有待辦任務，今天輕鬆！</p>
                  ) : null}
                </>
              )}
            </div>

            {/* 持倉概覽 */}
            {holdings.length > 0 && (
              <div style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                  <TrendingUp size={16} color="#00c896" />
                  <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>持倉概覽</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {holdings.slice(0, 5).map(h => (
                    <div key={h.code} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 10px', backgroundColor: '#0f1117', borderRadius: '8px' }}>
                      <span style={{ fontSize: '13px', color: '#4f8ef7', fontWeight: 700, minWidth: '45px' }}>{h.code}</span>
                      <span style={{ fontSize: '12px', color: '#8892a4', flex: 1 }}>{h.name}</span>
                      {h.currentPrice !== null ? (
                        <span style={{ fontSize: '13px', color: h.returnRate !== null ? pnlColor(h.returnRate) : '#8892a4', fontWeight: 600 }}>
                          {h.returnRate !== null ? `${h.returnRate >= 0 ? '+' : ''}${h.returnRate.toFixed(1)}%` : '—'}
                        </span>
                      ) : (
                        <span style={{ fontSize: '11px', color: '#8892a4' }}>未更新</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 右欄：國際新聞 */}
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Globe size={16} color="#4f8ef7" />
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>今日國際新聞</span>
                {lastNewsTime && <span style={{ fontSize: '11px', color: '#8892a4' }}>更新於 {lastNewsTime}</span>}
              </div>
              <button onClick={loadNews} disabled={newsLoading}
                style={{ background: 'none', border: '1px solid #2e3349', borderRadius: '6px', padding: '4px 10px', color: '#8892a4', cursor: 'pointer', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <RefreshCw size={12} style={{ animation: newsLoading ? 'spin 1s linear infinite' : 'none' }} />
                {newsLoading ? '更新中...' : '重新整理'}
              </button>
            </div>

            {newsLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px', color: '#8892a4', gap: '12px' }}>
                <div style={{ width: '24px', height: '24px', border: '2px solid #2e3349', borderTopColor: '#4f8ef7', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                <span style={{ fontSize: '13px' }}>AI 正在搜尋今日新聞...</span>
              </div>
            ) : newsError ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px', color: '#8892a4', gap: '12px' }}>
                <AlertCircle size={32} style={{ opacity: 0.4 }} />
                <p style={{ fontSize: '13px', margin: 0, textAlign: 'center' }}>新聞載入失敗，請點「重新整理」再試</p>
              </div>
            ) : news.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4', fontSize: '13px' }}>
                點「重新整理」載入今日新聞
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {news.map((item, i) => (
                  <div key={i} className="news-card"
                    onClick={() => setExpandedNews(expandedNews === i ? null : i)}
                    style={{ backgroundColor: '#0f1117', borderRadius: '10px', padding: '14px', border: '1px solid #2e3349' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', marginBottom: expandedNews === i ? '10px' : 0 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                          <span style={{ fontSize: '10px', backgroundColor: `${CATEGORY_COLORS[item.category] || '#4f8ef7'}18`, color: CATEGORY_COLORS[item.category] || '#4f8ef7', borderRadius: '10px', padding: '2px 8px', fontWeight: 600, flexShrink: 0 }}>
                            {item.category}
                          </span>
                        </div>
                        <div style={{ fontSize: '14px', color: '#e2e8f0', fontWeight: 600, lineHeight: 1.4 }}>{item.title}</div>
                      </div>
                      <Newspaper size={14} color="#8892a4" style={{ flexShrink: 0, marginTop: '2px' }} />
                    </div>
                    {expandedNews === i && (
                      <div style={{ fontSize: '13px', color: '#8892a4', lineHeight: 1.7, borderTop: '1px solid #2e3349', paddingTop: '10px' }}>
                        {item.summary}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}