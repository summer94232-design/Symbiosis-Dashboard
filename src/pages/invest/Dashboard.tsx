import { useState, useEffect } from 'react'
import { collection, getDocs, orderBy, query, doc, setDoc, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { getMultipleQuotes } from '../../lib/fugle'
import { calcPositions, calcAvailableCash, type TradeRecord } from '../../lib/calc'
import { DollarSign, BarChart2, RefreshCw, Calendar } from 'lucide-react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { FOMC_DATES, TECH_EVENTS, getFuturesSettlementDates } from '../../lib/calendarData'
import { useNavigate } from 'react-router-dom'

const COLORS = ['#4f8ef7', '#00c896', '#f5a623', '#ff5757', '#a78bfa', '#34d399', '#fb923c', '#60a5fa']
const CASH_COLOR = '#8892a4'
const pnlColor = (v: number) => v >= 0 ? '#00c896' : '#ff5757'
const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '16px' }

const EVENT_COLORS: Record<string, string> = {
  fomc: '#ff5757', futures: '#f5a623', tech: '#a78bfa',
  investor: '#00c896', personal: '#4f8ef7', task: '#4f8ef7', dividend: '#00c896'
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [holdings, setHoldings] = useState<any[]>([])
  const [totalCash, setTotalCash] = useState(0)
  const [realizedPnL, setRealizedPnL] = useState(0)
  const [loading, setLoading] = useState(true)
  const [priceLoading, setPriceLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState('')
  const [hasPrice, setHasPrice] = useState(false)
  const [upcomingEvents, setUpcomingEvents] = useState<any[]>([])

  const loadData = async () => {
    setLoading(true)
    try {
      const [tradesSnap, cashSnap, priceDoc] = await Promise.all([
        getDocs(query(collection(investDB, 'trades'), orderBy('date', 'asc'))),
        getDocs(collection(investDB, 'cashflow')),
        getDoc(doc(investDB, 'settings', 'lastPrices'))
      ])

      const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
      const cashRecords = cashSnap.docs.map(d => d.data() as any)
      const { holdings: positions, realized } = calcPositions(trades)
      setRealizedPnL(realized.reduce((s, r) => s + r.realized, 0))

      const savedPrices: Record<string, any> = priceDoc.exists() ? priceDoc.data() : {}
      const savedAt = savedPrices._updatedAt || ''

      let totalMarketValue = 0
      let priceAvailable = false

      const holdingList = Object.values(positions).map(pos => {
        const currentPrice = savedPrices[pos.code] ?? null
        if (currentPrice) priceAvailable = true
        const marketValue = currentPrice ? currentPrice * pos.shares : pos.totalCost
        const unrealizedPnL = currentPrice ? marketValue - pos.totalCost : 0
        const returnRate = pos.totalCost > 0 ? (unrealizedPnL / pos.totalCost) * 100 : 0
        totalMarketValue += marketValue
        return { ...pos, currentPrice, marketValue, unrealizedPnL, returnRate, ratio: 0 }
      })

      holdingList.forEach(h => { h.ratio = totalMarketValue > 0 ? (h.marketValue / totalMarketValue) * 100 : 0 })
      holdingList.sort((a, b) => b.marketValue - a.marketValue)

      setHoldings(holdingList)
      setTotalCash(calcAvailableCash(trades, cashRecords))
      setHasPrice(priceAvailable)
      if (savedAt) setLastUpdated(savedAt)
    } catch (err) { console.error(err) }
    setLoading(false)
  }

  const loadUpcoming = async () => {
    try {
      const today = new Date().toISOString().split('T')[0]
      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 14)
      const futureDateStr = futureDate.toISOString().split('T')[0]

      const [personalSnap, taskSnap] = await Promise.all([
        getDocs(collection(investDB, 'calendarEvents')),
        getDocs(collection(investDB, 'tasks'))
      ])

      const personal = personalSnap.docs.map(d => ({ ...d.data(), type: 'personal' }))
        .filter((e: any) => e.date >= today && e.date <= futureDateStr)

      const tasks = taskSnap.docs.map(d => d.data())
        .filter(t => t.dueDate && !t.done && t.dueDate >= today && t.dueDate <= futureDateStr)
        .map(t => ({ title: `📋 ${t.title}`, date: t.dueDate, type: 'task' }))

      const now = new Date()
      const y = now.getFullYear()
      const m = now.getMonth() + 1
      const ny = m === 12 ? y + 1 : y
      const nm = m === 12 ? 1 : m + 1
      const builtin = [
        ...FOMC_DATES, ...TECH_EVENTS,
        ...getFuturesSettlementDates(y, m),
        ...getFuturesSettlementDates(ny, nm),
      ].filter(e => e.date >= today && e.date <= futureDateStr)

      const all = [...personal, ...tasks, ...builtin]
        .sort((a: any, b: any) => a.date.localeCompare(b.date))
        .slice(0, 6)

      setUpcomingEvents(all)
    } catch (err) { console.error(err) }
  }

  const updatePrices = async () => {
    setPriceLoading(true)
    try {
      const symbols = holdings.map(h => h.code)
      if (symbols.length === 0) { setPriceLoading(false); return }

      const quotes = await getMultipleQuotes(symbols)
      const now = new Date().toLocaleString('zh-TW')

      const priceData: Record<string, any> = { _updatedAt: now }
      symbols.forEach(s => { if (quotes[s] !== null) priceData[s] = quotes[s] })
      await setDoc(doc(investDB, 'settings', 'lastPrices'), priceData)

      let totalMarketValue = 0
      let priceAvailable = false

      const updated = holdings.map(h => {
        const currentPrice = quotes[h.code] ?? null
        if (currentPrice) priceAvailable = true
        const marketValue = currentPrice ? currentPrice * h.shares : h.totalCost
        const unrealizedPnL = currentPrice ? marketValue - h.totalCost : 0
        const returnRate = h.totalCost > 0 ? (unrealizedPnL / h.totalCost) * 100 : 0
        totalMarketValue += marketValue
        return { ...h, currentPrice, marketValue, unrealizedPnL, returnRate }
      })

      updated.forEach(h => { h.ratio = totalMarketValue > 0 ? (h.marketValue / totalMarketValue) * 100 : 0 })
      updated.sort((a, b) => b.marketValue - a.marketValue)

      setHoldings(updated)
      setHasPrice(priceAvailable)
      setLastUpdated(now)
    } catch (err) { console.error(err) }
    setPriceLoading(false)
  }

  useEffect(() => {
    Promise.all([loadData(), loadUpcoming()])
  }, [])

  const totalMarketValue = holdings.reduce((s, h) => s + h.marketValue, 0)
  const totalCost = holdings.reduce((s, h) => s + h.totalCost, 0)
  const totalUnrealized = holdings.reduce((s, h) => s + h.unrealizedPnL, 0)
  const totalAssets = totalMarketValue + totalCash

  const pieData = [
    ...holdings.map(h => ({ name: `${h.code} ${h.name}`, value: h.marketValue })),
    ...(totalCash > 0 ? [{ name: '現金', value: totalCash }] : [])
  ]
  const pieColors = [...holdings.map((_, i) => COLORS[i % COLORS.length]), CASH_COLOR]

  return (
    <>
      <style>{`
        .dash-stats { display: grid; gap: 10px; grid-template-columns: repeat(3, 1fr); margin-bottom: 10px; }
        @media (max-width: 900px) { .dash-stats { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 480px) { .dash-stats { grid-template-columns: repeat(2, 1fr); gap: 8px; } }
        .dash-bottom { display: grid; gap: 12px; grid-template-columns: 280px 1fr; }
        @media (max-width: 900px) { .dash-bottom { grid-template-columns: 1fr; } }
        .dash-lower { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; margin-top: 12px; }
        @media (max-width: 900px) { .dash-lower { grid-template-columns: 1fr; } }
        .h-table { width: 100%; border-collapse: collapse; font-size: 11px; }
        .h-table th { padding: 6px 6px; text-align: left; color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; white-space: nowrap; }
        .h-table td { padding: 7px 6px; border-bottom: 1px solid #2e3349; color: #e2e8f0; white-space: nowrap; }
        .stat-card { background: #1a1d27; border: 1px solid #2e3349; border-radius: 10px; padding: 12px; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      <div style={{ padding: 'clamp(12px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>

        {/* 標題列 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <h1 style={{ fontSize: 'clamp(16px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>儀表板</h1>
            <p style={{ fontSize: '11px', color: '#8892a4', margin: '2px 0 0' }}>
              {lastUpdated ? `現價更新：${lastUpdated}` : '尚未更新現價'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={() => Promise.all([loadData(), loadUpcoming()])} disabled={loading}
              style={{ backgroundColor: '#21253a', border: '1px solid #2e3349', borderRadius: '8px', padding: '7px 10px', color: '#e2e8f0', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
              <span style={{ display: 'none' }} className="btn-label">重新載入</span>
            </button>
            <button onClick={updatePrices} disabled={priceLoading || loading}
              style={{ backgroundColor: '#4f8ef7', border: 'none', borderRadius: '8px', padding: '7px 12px', color: '#fff', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <RefreshCw size={12} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
              {priceLoading ? '更新中...' : '更新現價'}
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px', color: '#8892a4' }}>載入中...</div>
        ) : (
          <>
            {/* 第一排統計：3欄（手機也是3欄，字小一點） */}
            <div className="dash-stats">
              {[
                { label: '總資產', value: `$${totalAssets.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#4f8ef7', icon: DollarSign },
                { label: '股票市值', value: `$${totalMarketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#4f8ef7', icon: BarChart2 },
                { label: '可用現金', value: `$${totalCash.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#f5a623', icon: DollarSign },
              ].map(({ label, value, color, icon: Icon }) => (
                <div key={label} className="stat-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px', whiteSpace: 'nowrap' }}>{label}</div>
                      <div style={{ fontSize: 'clamp(13px, 3.5vw, 20px)', fontWeight: 700, color, wordBreak: 'break-all' }}>{value}</div>
                    </div>
                    <Icon size={14} color={color} style={{ opacity: 0.4, flexShrink: 0, marginLeft: '4px' }} />
                  </div>
                </div>
              ))}
            </div>

            {/* 第二排統計：手機 2欄（最後一個佔滿） */}
            <div className="dash-stats" style={{ marginBottom: '12px' }}>
              {[
                { label: '股票總成本', value: `$${totalCost.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#8892a4' },
                { label: '未實現損益', value: hasPrice ? `${totalUnrealized >= 0 ? '+' : ''}$${totalUnrealized.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}` : '—', color: pnlColor(totalUnrealized) },
                { label: '已實現損益', value: `${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: pnlColor(realizedPnL) },
              ].map(({ label, value, color }) => (
                <div key={label} className="stat-card">
                  <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '6px' }}>{label}</div>
                  <div style={{ fontSize: 'clamp(13px, 3.5vw, 18px)', fontWeight: 700, color, wordBreak: 'break-all' }}>{value}</div>
                </div>
              ))}
            </div>

            {/* 資產分布 + 持倉表格 */}
            <div className="dash-bottom">
              <div style={card}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0', marginBottom: '12px' }}>資產分布</div>
                {pieData.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px', color: '#8892a4', fontSize: '13px' }}>尚無持倉</div>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={160}>
                      <PieChart>
                        <Pie data={pieData} cx="50%" cy="50%" innerRadius={38} outerRadius={65} paddingAngle={2} dataKey="value">
                          {pieData.map((_, i) => <Cell key={i} fill={pieColors[i]} />)}
                        </Pie>
                        <Tooltip formatter={(v: any) => [`$${Number(v).toLocaleString()}`, '金額']} contentStyle={{ backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '8px', color: '#e2e8f0', fontSize: '12px' }} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ marginTop: '6px' }}>
                      {pieData.map((item, i) => (
                        <div key={item.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: '11px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', overflow: 'hidden' }}>
                            <div style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: pieColors[i], flexShrink: 0 }} />
                            <span style={{ color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                          </div>
                          <span style={{ color: '#8892a4', flexShrink: 0, marginLeft: '6px' }}>{totalAssets > 0 ? ((item.value / totalAssets) * 100).toFixed(1) : 0}%</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* 持倉表格：手機上只顯示關鍵欄位 */}
              <div style={card}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0', marginBottom: '12px' }}>目前持倉</div>
                {holdings.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px', color: '#8892a4', fontSize: '13px' }}>尚無持倉資料</div>
                ) : (
                  <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                    <table className="h-table">
                      <thead>
                        <tr>{['代號', '名稱', '均價', '現價', '報酬率', '佔比'].map(h => <th key={h}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {holdings.map((h, i) => (
                          <tr key={h.code}>
                            <td style={{ color: '#4f8ef7', fontWeight: 700 }}>{h.code}</td>
                            <td style={{ maxWidth: '60px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.name}</td>
                            <td>{h.avgCost.toFixed(1)}</td>
                            <td style={{ color: h.currentPrice === null ? '#8892a4' : h.currentPrice > h.avgCost ? '#00c896' : '#ff5757', fontWeight: 600 }}>
                              {h.currentPrice === null ? '—' : h.currentPrice.toFixed(1)}
                            </td>
                            <td>
                              {h.currentPrice === null
                                ? <span style={{ color: '#8892a4', fontSize: '10px' }}>—</span>
                                : <span style={{ backgroundColor: h.returnRate >= 0 ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)', color: pnlColor(h.returnRate), padding: '1px 5px', borderRadius: '20px', fontSize: '11px', fontWeight: 600 }}>
                                    {h.returnRate >= 0 ? '+' : ''}{h.returnRate.toFixed(1)}%
                                  </span>
                              }
                            </td>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <div style={{ flex: 1, height: '3px', backgroundColor: '#2e3349', borderRadius: '2px', minWidth: '24px' }}>
                                  <div style={{ width: `${h.ratio}%`, height: '100%', backgroundColor: COLORS[i % COLORS.length], borderRadius: '2px' }} />
                                </div>
                                <span style={{ fontSize: '10px', color: '#8892a4', minWidth: '28px' }}>{h.ratio.toFixed(0)}%</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* 近 14 天行事曆 + 待辦任務 */}
            <div className="dash-lower">
              <div style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Calendar size={14} color="#4f8ef7" />
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>近 14 天行程</span>
                  </div>
                  <button onClick={() => navigate('/calendar')}
                    style={{ background: 'none', border: 'none', color: '#4f8ef7', fontSize: '11px', cursor: 'pointer' }}>
                    全部 →
                  </button>
                </div>
                {upcomingEvents.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '20px', color: '#8892a4', fontSize: '12px' }}>近 14 天沒有行程</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {upcomingEvents.map((ev: any, i) => {
                      const todayStr = new Date().toISOString().split('T')[0]
                      const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0]
                      const isToday = ev.date === todayStr
                      const isTomorrow = ev.date === tomorrowStr
                      const dateLabel = isToday ? '今天' : isTomorrow ? '明天' : ev.date.slice(5).replace('-', '/')
                      const color = EVENT_COLORS[ev.type] || '#4f8ef7'
                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', backgroundColor: '#0f1117', borderRadius: '7px', borderLeft: `3px solid ${color}` }}>
                          <span style={{ fontSize: '10px', color: isToday ? '#ff5757' : '#8892a4', fontWeight: isToday ? 700 : 400, flexShrink: 0, minWidth: '28px' }}>{dateLabel}</span>
                          <span style={{ fontSize: '12px', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{ev.title}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <div style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>📋 待辦任務</span>
                  <button onClick={() => navigate('/calendar/tasks')}
                    style={{ background: 'none', border: 'none', color: '#4f8ef7', fontSize: '11px', cursor: 'pointer' }}>
                    全部 →
                  </button>
                </div>
                <TodoWidget />
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}

function TodoWidget() {
  const [tasks, setTasks] = useState<any[]>([])

  useEffect(() => {
    const load = async () => {
      const snap = await getDocs(query(collection(investDB, 'tasks'), orderBy('order', 'asc')))
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter((t: any) => !t.done)
        .slice(0, 5)
      setTasks(data)
    }
    load()
  }, [])

  const PRIORITY_COLORS: Record<string, string> = { high: '#ff5757', medium: '#f5a623', low: '#00c896' }

  if (tasks.length === 0) {
    return <div style={{ textAlign: 'center', padding: '20px', color: '#8892a4', fontSize: '12px' }}>🎉 沒有待辦任務</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
      {tasks.map((t: any) => {
        const isOverdue = t.dueDate && new Date(t.dueDate) < new Date()
        return (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', backgroundColor: '#0f1117', borderRadius: '7px', borderLeft: `3px solid ${PRIORITY_COLORS[t.priority] || '#4f8ef7'}` }}>
            <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: PRIORITY_COLORS[t.priority] || '#4f8ef7', flexShrink: 0 }} />
            <span style={{ fontSize: '12px', color: '#e2e8f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
            {t.dueDate && (
              <span style={{ fontSize: '10px', color: isOverdue ? '#ff5757' : '#8892a4', flexShrink: 0 }}>
                {isOverdue ? '⚠️' : ''}{t.dueDate.slice(5).replace('-', '/')}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}