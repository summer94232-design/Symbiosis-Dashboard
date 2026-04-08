import { useState, useEffect, useRef } from 'react'
import { collection, getDocs, orderBy, query, doc, setDoc, getDoc, updateDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { getMultipleQuotes } from '../../lib/fugle'
import { calcPositions, calcAvailableCash, type TradeRecord, type DividendRecord } from '../../lib/calc'
import { DollarSign, BarChart2, RefreshCw, Calendar, CheckSquare, ExternalLink } from 'lucide-react'
import { PieChart, Pie, Tooltip, ResponsiveContainer } from 'recharts'
import { useNavigate } from 'react-router-dom'

const COLORS = ['#4f8ef7', '#00c896', '#f5a623', '#ff5757', '#a78bfa', '#34d399', '#fb923c', '#60a5fa']
const CASH_COLOR = '#8892a4'
const pnlColor = (v: number) => v >= 0 ? '#00c896' : '#ff5757'
const card: React.CSSProperties = {
    backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px'
}

interface HoldingItem {
    code: string
    name: string
    shares: number
    avgCost: number
    totalCost: number
    currentPrice: number | null
    marketValue: number
    unrealizedPnL: number
    returnRate: number
    ratio: number
}

interface PieEntry {
    name: string
    value: number
    fill: string
}

interface CashRecord {
    type: 'in' | 'out'
    amount: number
}

interface CalendarEvent {
    id: string
    date: string
    title: string
    type: string
}

interface Task {
    id: string
    title: string
    done: boolean
    dueDate?: string
    priority: 'high' | 'medium' | 'low'
    order: number
}

const PRIORITY_COLORS = { high: '#ff5757', medium: '#f5a623', low: '#00c896' }
const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' }

export default function Dashboard() {
    const navigate = useNavigate()
    const [holdings, setHoldings] = useState<HoldingItem[]>([])
    const [totalCash, setTotalCash] = useState(0)
    const [realizedPnL, setRealizedPnL] = useState(0)
    const [loading, setLoading] = useState(true)
    const [priceLoading, setPriceLoading] = useState(false)
    const [lastUpdated, setLastUpdated] = useState('')
    const [hasPrice, setHasPrice] = useState(false)

    const [upcomingEvents, setUpcomingEvents] = useState<CalendarEvent[]>([])
    const [tasks, setTasks] = useState<Task[]>([])

    const loadData = async () => {
        setLoading(true)
        try {
            const [tradesSnap, dividendsSnap, cashSnap] = await Promise.all([
                getDocs(query(collection(investDB, 'trades'), orderBy('date', 'asc'))),
                getDocs(query(collection(investDB, 'dividends'), orderBy('date', 'asc'))),
                getDocs(collection(investDB, 'cashflow')),
            ])
            const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
            const dividends = dividendsSnap.docs.map(d => d.data() as DividendRecord)
            const cashRecords = cashSnap.docs.map(d => d.data() as CashRecord)

            const { holdings: positions, realized } = calcPositions(trades, dividends)
            setRealizedPnL(realized.reduce((s, r) => s + r.realized, 0))

            const priceDoc = await getDoc(doc(investDB, 'settings', 'lastPrices'))
            const savedPrices: Record<string, number | string> = priceDoc.exists() ? priceDoc.data() : {}
            const savedAt = typeof savedPrices._updatedAt === 'string' ? savedPrices._updatedAt : ''

            let totalMarketValue = 0
            let priceAvailable = false

            const holdingList: HoldingItem[] = Object.values(positions).map(pos => {
                const currentPrice = typeof savedPrices[pos.code] === 'number'
                    ? savedPrices[pos.code] as number
                    : null
                if (currentPrice !== null) priceAvailable = true
                const marketValue = currentPrice !== null ? currentPrice * pos.shares : pos.totalCost
                const unrealizedPnL = currentPrice !== null ? marketValue - pos.totalCost : 0
                const returnRate = (currentPrice !== null && pos.totalCost > 0)
                    ? (unrealizedPnL / pos.totalCost) * 100
                    : 0
                totalMarketValue += marketValue
                return { ...pos, currentPrice, marketValue, unrealizedPnL, returnRate, ratio: 0 }
            })

            holdingList.forEach(h => {
                h.ratio = totalMarketValue > 0 ? (h.marketValue / totalMarketValue) * 100 : 0
            })
            holdingList.sort((a, b) => b.marketValue - a.marketValue)

            setHoldings(holdingList)
            setTotalCash(calcAvailableCash(trades, cashRecords))
            setHasPrice(priceAvailable)
            if (savedAt) setLastUpdated(savedAt)
        } catch (err) { console.error(err) }
        finally { setLoading(false) }
    }

    // 近 14 天行事曆事件（從 calendarEvents collection）
    const loadCalendarEvents = async () => {
        try {
            const snap = await getDocs(collection(investDB, 'calendarEvents'))
            const todayStr = new Date().toISOString().split('T')[0]
            const future14Str = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]

            const events: CalendarEvent[] = snap.docs
                .map(d => ({ id: d.id, ...d.data() } as CalendarEvent))
                .filter(e => e.date >= todayStr && e.date <= future14Str)
                .sort((a, b) => a.date.localeCompare(b.date))

            setUpcomingEvents(events)
        } catch (err) { console.error(err) }
    }

    // 待辦任務（從 tasks collection，與 TaskManager 共用）
    const loadTasks = async () => {
        try {
            const snap = await getDocs(query(collection(investDB, 'tasks'), orderBy('order', 'asc')))
            const all = snap.docs.map(d => ({ id: d.id, ...d.data() } as Task))
            setTasks(all.filter(t => !t.done))
        } catch (err) { console.error(err) }
    }

    // 勾選任務（標記完成，從列表移除）
    const toggleTask = async (id: string, done: boolean) => {
        try {
            await updateDoc(doc(investDB, 'tasks', id), { done: !done })
            setTasks(prev => prev.filter(t => t.id !== id))
        } catch (err) { console.error(err) }
    }

    const updatePrices = async () => {
        setPriceLoading(true)
        try {
            const symbols = holdings.map(h => h.code)
            if (symbols.length === 0) { setPriceLoading(false); return }

            const quotes = await getMultipleQuotes(symbols)
            const now = new Date().toLocaleString('zh-TW')

            const priceData: Record<string, number | string> = { _updatedAt: now }
            symbols.forEach(s => { if (quotes[s] !== null) priceData[s] = quotes[s] as number })
            await setDoc(doc(investDB, 'settings', 'lastPrices'), priceData)

            let totalMarketValue = 0
            let priceAvailable = false

            const updated: HoldingItem[] = holdings.map(h => {
                const currentPrice = quotes[h.code] ?? null
                if (currentPrice !== null) priceAvailable = true
                const marketValue = currentPrice !== null ? currentPrice * h.shares : h.totalCost
                const unrealizedPnL = currentPrice !== null ? marketValue - h.totalCost : 0
                const returnRate = (currentPrice !== null && h.totalCost > 0)
                    ? (unrealizedPnL / h.totalCost) * 100
                    : 0
                totalMarketValue += marketValue
                return { ...h, currentPrice, marketValue, unrealizedPnL, returnRate }
            })

            updated.forEach(h => {
                h.ratio = totalMarketValue > 0 ? (h.marketValue / totalMarketValue) * 100 : 0
            })
            updated.sort((a, b) => b.marketValue - a.marketValue)

            setHoldings(updated)
            setHasPrice(priceAvailable)
            setLastUpdated(now)
        } catch (err) { console.error(err) }
        setPriceLoading(false)
    }

    const didLoad = useRef(false)
    useEffect(() => {
        if (didLoad.current) return
        didLoad.current = true
        const timer = setTimeout(() => {
            void loadData()
            void loadCalendarEvents()
            void loadTasks()
        }, 0)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const totalMarketValue = holdings.reduce((s, h) => s + h.marketValue, 0)
    const totalCost = holdings.reduce((s, h) => s + h.totalCost, 0)
    const totalAssets = totalMarketValue + totalCash

    const holdingsWithPrice = holdings.filter(h => h.currentPrice !== null)
    const holdingsWithoutPrice = holdings.filter(h => h.currentPrice === null)
    const totalUnrealized = holdingsWithPrice.reduce((s, h) => s + h.unrealizedPnL, 0)

    const pieData: PieEntry[] = [
        ...holdings.map((h, i) => ({
            name: `${h.code} ${h.name}`,
            value: h.marketValue,
            fill: COLORS[i % COLORS.length]
        })),
        ...(totalCash > 0 ? [{ name: '現金', value: totalCash, fill: CASH_COLOR }] : [])
    ]

    const unrealizedLabel = hasPrice && holdingsWithoutPrice.length > 0
        ? `未實現損益（${holdingsWithPrice.length}/${holdings.length} 檔）`
        : '未實現損益'

    const tooltipFormatter = (value: number | string | readonly (string | number)[] | undefined): [string, string] => {
        const num = value === undefined ? 0 : typeof value === 'number' ? value : Number(value)
        return [`$${num.toLocaleString()}`, '金額']
    }

    const todayStr = new Date().toISOString().split('T')[0]
    const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0]

    const formatEventDate = (dateStr: string) => {
        const mmdd = dateStr.slice(5).replace('-', '/')
        if (dateStr === todayStr) return `${mmdd}（今天）`
        if (dateStr === tomorrowStr) return `${mmdd}（明天）`
        const diff = Math.round((new Date(dateStr).getTime() - new Date(todayStr).getTime()) / 86400000)
        return `${mmdd}（${diff} 天後）`
    }

    const overdueTasks = tasks.filter(t => t.dueDate && t.dueDate < todayStr)
    const todayTasks = tasks.filter(t => t.dueDate === todayStr)
    const futureTasks = tasks.filter(t => !t.dueDate || t.dueDate > todayStr)

    return (
        <>
            <style>{`
        .dash-stats { display: grid; gap: 16px; grid-template-columns: repeat(3, 1fr); margin-bottom: 16px; }
        @media (max-width: 900px) { .dash-stats { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .dash-stats { grid-template-columns: 1fr; } }
        .dash-bottom { display: grid; gap: 16px; grid-template-columns: 300px 1fr; }
        @media (max-width: 900px) { .dash-bottom { grid-template-columns: 1fr; } }
        .dash-extra { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; margin-top: 16px; }
        @media (max-width: 700px) { .dash-extra { grid-template-columns: 1fr; } }
        .h-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .h-table th { padding: 8px 10px; text-align: left; color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; white-space: nowrap; }
        .h-table td { padding: 10px; border-bottom: 1px solid #2e3349; color: #e2e8f0; white-space: nowrap; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .task-row:hover { background-color: rgba(79,142,247,0.06) !important; }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>儀表板</h1>
                        <p style={{ fontSize: '12px', color: '#8892a4', margin: '4px 0 0' }}>
                            {lastUpdated ? `現價更新：${lastUpdated}` : '尚未更新現價，點「更新現價」取得最新報價'}
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            onClick={() => void loadData()}
                            disabled={loading}
                            style={{ backgroundColor: '#21253a', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 14px', color: '#e2e8f0', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
                        >
                            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
                            重新載入
                        </button>
                        <button
                            onClick={() => void updatePrices()}
                            disabled={priceLoading || loading}
                            style={{ backgroundColor: '#4f8ef7', border: 'none', borderRadius: '8px', padding: '8px 14px', color: '#fff', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
                        >
                            <RefreshCw size={14} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {priceLoading ? '更新中...' : '更新現價'}
                        </button>
                    </div>
                </div>

                {loading ? (
                    <div style={{ textAlign: 'center', padding: '80px', color: '#8892a4' }}>載入中...</div>
                ) : (
                    <>
                        <div className="dash-stats">
                            {[
                                { label: '總資產', value: `$${totalAssets.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#4f8ef7', icon: DollarSign },
                                { label: '股票總市值', value: `$${totalMarketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#4f8ef7', icon: BarChart2 },
                                { label: '可用現金', value: `$${totalCash.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#f5a623', icon: DollarSign },
                            ].map(({ label, value, color, icon: Icon }) => (
                                <div key={label} style={card}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <div>
                                            <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>{label}</div>
                                            <div style={{ fontSize: 'clamp(16px, 2vw, 22px)', fontWeight: 700, color }}>{value}</div>
                                        </div>
                                        <Icon size={18} color={color} style={{ opacity: 0.5 }} />
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="dash-stats">
                            {[
                                { label: '股票總成本', value: `$${totalCost.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#8892a4' },
                                {
                                    label: unrealizedLabel,
                                    value: hasPrice
                                        ? `${totalUnrealized >= 0 ? '+' : ''}$${totalUnrealized.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`
                                        : '—',
                                    color: pnlColor(totalUnrealized)
                                },
                                {
                                    label: '已實現損益',
                                    value: `${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`,
                                    color: pnlColor(realizedPnL)
                                },
                            ].map(({ label, value, color }) => (
                                <div key={label} style={card}>
                                    <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>{label}</div>
                                    <div style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 700, color }}>{value}</div>
                                </div>
                            ))}
                        </div>

                        {hasPrice && holdingsWithoutPrice.length > 0 && (
                            <div style={{ marginBottom: '12px', padding: '10px 14px', backgroundColor: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.25)', borderRadius: '8px', fontSize: '12px', color: '#f5a623' }}>
                                ⚠️ {holdingsWithoutPrice.length} 檔持倉（{holdingsWithoutPrice.map(h => h.code).join('、')}）尚未更新現價，市值以成本計算，未實現損益僅計算已有現價的持倉。
                            </div>
                        )}

                        <div className="dash-bottom">
                            <div style={card}>
                                <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>資產分布</div>
                                {pieData.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '40px', color: '#8892a4', fontSize: '13px' }}>尚無持倉</div>
                                ) : (
                                    <>
                                        <ResponsiveContainer width="100%" height={180}>
                                            <PieChart>
                                                <Pie data={pieData} cx="50%" cy="50%" innerRadius={45} outerRadius={75} paddingAngle={2} dataKey="value" />
                                                <Tooltip formatter={tooltipFormatter} contentStyle={{ backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '8px', color: '#e2e8f0' }} />
                                            </PieChart>
                                        </ResponsiveContainer>
                                        <div style={{ marginTop: '8px' }}>
                                            {pieData.map(item => (
                                                <div key={item.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '12px' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                        <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: item.fill, flexShrink: 0 }} />
                                                        <span style={{ color: '#e2e8f0' }}>{item.name}</span>
                                                    </div>
                                                    <span style={{ color: '#8892a4' }}>{totalAssets > 0 ? ((item.value / totalAssets) * 100).toFixed(1) : 0}%</span>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </div>

                            <div style={card}>
                                <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>目前持倉</div>
                                {holdings.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '40px', color: '#8892a4', fontSize: '13px' }}>尚無持倉資料</div>
                                ) : (
                                    <div style={{ overflowX: 'auto' }}>
                                        <table className="h-table">
                                            <thead>
                                                <tr>{['代號', '名稱', '股數', '均價', '現價', '未實現損益', '報酬率', '佔比'].map(h => <th key={h}>{h}</th>)}</tr>
                                            </thead>
                                            <tbody>
                                                {holdings.map(h => (
                                                    <tr key={h.code}>
                                                        <td style={{ color: '#4f8ef7', fontWeight: 700 }}>{h.code}</td>
                                                        <td>{h.name}</td>
                                                        <td>{h.shares.toLocaleString()}</td>
                                                        <td>{h.avgCost.toFixed(2)}</td>
                                                        <td style={{ color: h.currentPrice === null ? '#8892a4' : h.currentPrice > h.avgCost ? '#00c896' : '#ff5757', fontWeight: 600 }}>
                                                            {h.currentPrice === null ? '—' : h.currentPrice.toFixed(2)}
                                                        </td>
                                                        <td style={{ color: h.currentPrice === null ? '#8892a4' : pnlColor(h.unrealizedPnL), fontWeight: 600 }}>
                                                            {h.currentPrice === null ? '—' : `${h.unrealizedPnL >= 0 ? '+' : ''}${h.unrealizedPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`}
                                                        </td>
                                                        <td>
                                                            {h.currentPrice === null
                                                                ? <span style={{ color: '#8892a4', fontSize: '12px' }}>點「更新現價」</span>
                                                                : <span style={{ backgroundColor: h.returnRate >= 0 ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)', color: pnlColor(h.returnRate), padding: '2px 8px', borderRadius: '20px', fontSize: '12px', fontWeight: 600 }}>
                                                                    {h.returnRate >= 0 ? '+' : ''}{h.returnRate.toFixed(2)}%
                                                                </span>
                                                            }
                                                        </td>
                                                        <td style={{ color: '#8892a4' }}>{h.ratio.toFixed(1)}%</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* ── 兩欄：近14天行程 / 待辦任務 ── */}
                        <div className="dash-extra">

                            {/* 近 14 天行程 */}
                            <div style={card}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <Calendar size={15} color="#4f8ef7" />
                                        <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>近 14 天行程</span>
                                    </div>
                                    <button onClick={() => navigate('/calendar')}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4f8ef7', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        <ExternalLink size={12} />前往月曆
                                    </button>
                                </div>

                                {upcomingEvents.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '32px 0', color: '#8892a4', fontSize: '13px' }}>近 14 天無行程</div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '300px', overflowY: 'auto' }}>
                                        {upcomingEvents.map(ev => {
                                            const isToday = ev.date === todayStr
                                            return (
                                                <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', backgroundColor: '#0f1117', borderRadius: '8px', borderLeft: `3px solid ${isToday ? '#f5a623' : '#4f8ef7'}` }}>
                                                    <div style={{ flex: 1, minWidth: 0 }}>
                                                        <div style={{ fontSize: '13px', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</div>
                                                        <div style={{ fontSize: '11px', color: isToday ? '#f5a623' : '#4f8ef7', marginTop: '2px' }}>{formatEventDate(ev.date)}</div>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                            </div>

                            {/* 待辦任務 */}
                            <div style={card}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <CheckSquare size={15} color="#00c896" />
                                        <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>待辦任務</span>
                                        {tasks.length > 0 && (
                                            <span style={{ backgroundColor: 'rgba(0,200,150,0.15)', color: '#00c896', borderRadius: '20px', padding: '1px 8px', fontSize: '11px', fontWeight: 600 }}>
                                                {tasks.length}
                                            </span>
                                        )}
                                    </div>
                                    <button onClick={() => navigate('/calendar/tasks')}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#00c896', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        <ExternalLink size={12} />任務管理
                                    </button>
                                </div>

                                {tasks.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '32px 0', color: '#8892a4', fontSize: '13px' }}>🎉 沒有待辦任務！</div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '300px', overflowY: 'auto' }}>
                                        {overdueTasks.length > 0 && (
                                            <>
                                                <div style={{ fontSize: '11px', color: '#ff5757', fontWeight: 600, padding: '4px 0 2px' }}>⚠️ 逾期</div>
                                                {overdueTasks.map(t => <TaskRow key={t.id} task={t} todayStr={todayStr} onToggle={toggleTask} />)}
                                            </>
                                        )}
                                        {todayTasks.length > 0 && (
                                            <>
                                                <div style={{ fontSize: '11px', color: '#f5a623', fontWeight: 600, padding: '4px 0 2px' }}>今日到期</div>
                                                {todayTasks.map(t => <TaskRow key={t.id} task={t} todayStr={todayStr} onToggle={toggleTask} />)}
                                            </>
                                        )}
                                        {futureTasks.length > 0 && (
                                            <>
                                                {(overdueTasks.length > 0 || todayTasks.length > 0) && (
                                                    <div style={{ fontSize: '11px', color: '#8892a4', fontWeight: 600, padding: '4px 0 2px' }}>其他</div>
                                                )}
                                                {futureTasks.map(t => <TaskRow key={t.id} task={t} todayStr={todayStr} onToggle={toggleTask} />)}
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>

                        </div>
                    </>
                )}
            </div>
        </>
    )
}

function TaskRow({ task, todayStr, onToggle }: {
    task: Task
    todayStr: string
    onToggle: (id: string, done: boolean) => void
}) {
    const isOverdue = task.dueDate && task.dueDate < todayStr
    return (
        <div className="task-row"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', backgroundColor: '#0f1117', borderRadius: '8px', cursor: 'pointer' }}
            onClick={() => onToggle(task.id, task.done)}
        >
            <div style={{ width: '16px', height: '16px', border: `1.5px solid ${PRIORITY_COLORS[task.priority]}`, borderRadius: '4px', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: '13px', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
            <div style={{ display: 'flex', gap: '4px', flexShrink: 0, alignItems: 'center' }}>
                {task.dueDate && (
                    <span style={{ fontSize: '11px', color: isOverdue ? '#ff5757' : '#8892a4' }}>
                        {task.dueDate.slice(5).replace('-', '/')}{isOverdue ? ' ⚠️' : ''}
                    </span>
                )}
                <span style={{ fontSize: '11px', backgroundColor: `${PRIORITY_COLORS[task.priority]}18`, color: PRIORITY_COLORS[task.priority], borderRadius: '10px', padding: '1px 6px' }}>
                    {PRIORITY_LABELS[task.priority]}
                </span>
            </div>
        </div>
    )
}