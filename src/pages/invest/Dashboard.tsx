import { useState, useEffect, useRef } from 'react'
import { collection, getDocs, orderBy, query, doc, setDoc, getDoc, updateDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { getMultipleQuotes } from '../../lib/fugle'
import { calcPositions, calcAvailableCash, simulateMarginBuy, type TradeRecord, type DividendRecord } from '../../lib/calc'
import { DollarSign, BarChart2, RefreshCw, Calendar, CheckSquare, ExternalLink, Tag, TrendingDown } from 'lucide-react'
import { PieChart, Pie, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { useNavigate } from 'react-router-dom'

const COLORS = ['#4f8ef7', '#00c896', '#f5a623', '#ff5757', '#a78bfa', '#34d399', '#fb923c', '#60a5fa', '#f472b6', '#facc15', '#38bdf8', '#4ade80']
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

// 族群圓餅圖 active label
function renderCustomLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) {
    if (percent < 0.05) return null
    const RADIAN = Math.PI / 180
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5
    const x = cx + radius * Math.cos(-midAngle * RADIAN)
    const y = cy + radius * Math.sin(-midAngle * RADIAN)
    return (
        <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600}>
            {`${(percent * 100).toFixed(0)}%`}
        </text>
    )
}

// 個股圓餅圖 — 自訂 Tooltip
function AssetTooltip({ active, payload, totalAssets }: any) {
    if (!active || !payload?.length) return null
    const { name, value, payload: { fill } } = payload[0]
    const pct = totalAssets > 0 ? ((value / totalAssets) * 100).toFixed(1) : '0.0'
    return (
        <div style={{ backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '10px', padding: '10px 14px', minWidth: '160px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '8px' }}>
                <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: fill, flexShrink: 0 }} />
                <span style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0' }}>{name}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '20px', fontSize: '12px' }}>
                <span style={{ color: '#8892a4' }}>市值</span>
                <span style={{ color: '#e2e8f0', fontWeight: 600 }}>${value.toLocaleString()}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '20px', fontSize: '12px', marginTop: '4px' }}>
                <span style={{ color: '#8892a4' }}>佔比</span>
                <span style={{ color: '#4f8ef7', fontWeight: 600 }}>{pct}%</span>
            </div>
        </div>
    )
}

// 族群圓餅圖 — 自訂 Tooltip
function GroupTooltip({ active, payload, totalAssets }: any) {
    if (!active || !payload?.length) return null
    const { name, value, payload: { fill } } = payload[0]
    const pct = totalAssets > 0 ? ((value / totalAssets) * 100).toFixed(1) : '0.0'
    return (
        <div style={{ backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '10px', padding: '10px 14px', minWidth: '160px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '8px' }}>
                <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: fill, flexShrink: 0 }} />
                <span style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0' }}>{name}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '20px', fontSize: '12px' }}>
                <span style={{ color: '#8892a4' }}>市值</span>
                <span style={{ color: '#e2e8f0', fontWeight: 600 }}>${value.toLocaleString()}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '20px', fontSize: '12px', marginTop: '4px' }}>
                <span style={{ color: '#8892a4' }}>佔比</span>
                <span style={{ color: '#a78bfa', fontWeight: 600 }}>{pct}%</span>
            </div>
        </div>
    )
}

export default function Dashboard() {
    const navigate = useNavigate()
    const [holdings, setHoldings] = useState<HoldingItem[]>([])
    const [totalCash, setTotalCash] = useState(0)
    const [realizedPnL, setRealizedPnL] = useState(0)
    const [loading, setLoading] = useState(true)
    const [priceLoading, setPriceLoading] = useState(false)
    const [lastUpdated, setLastUpdated] = useState('')
    const [hasPrice, setHasPrice] = useState(false)
    const [stockGroups, setStockGroups] = useState<Record<string, string>>({})
    const [reloadCooldown, setReloadCooldown] = useState(0) // 秒數倒數
    const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const [upcomingEvents, setUpcomingEvents] = useState<CalendarEvent[]>([])
    const [tasks, setTasks] = useState<Task[]>([])

    // 融資維持率相關
    interface MarginPosition {
        code: string
        name: string
        shares: number
        marginAmount: number  // 融資借款金額
        marginCost: number    // 融資買入時股票總市值（用於計算原始成本）
    }
    const [marginPositions, setMarginPositions] = useState<MarginPosition[]>([])

    // 融資加碼試算 state
    const [simOpen, setSimOpen] = useState(false)
    const [simPrice, setSimPrice] = useState('')
    const [simShares, setSimShares] = useState('')
    const [simRatio, setSimRatio] = useState('0.6')

    // ✅ 優化：單一 Promise.all 並行抓取所有資料，消除串行等待
    const loadData = async () => {
        setLoading(true)
        try {
            const todayStr_ = new Date().toISOString().split('T')[0]
            const future14Str = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]

            const [
                tradesSnap, dividendsSnap, cashSnap,
                priceDoc, groupDoc,
                eventsSnap, tasksSnap,
            ] = await Promise.all([
                getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'asc'))),
                getDocs(query(userCol(investDB, 'dividends'), orderBy('date', 'asc'))),
                getDocs(userCol(investDB, 'cashflow')),
                getDoc(userDocNested(investDB, 'settings', 'lastPrices')),
                getDoc(userDocNested(investDB, 'settings', 'stockGroups')),
                getDocs(userCol(investDB, 'calendarEvents')),
                getDocs(query(userCol(investDB, 'tasks'), orderBy('order', 'asc'))),
            ])

            const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
            const dividends = dividendsSnap.docs.map(d => d.data() as DividendRecord)
            const cashRecords = cashSnap.docs.map(d => d.data() as CashRecord)

            const { holdings: positions, realized } = calcPositions(trades, dividends)
            setRealizedPnL(realized.reduce((s, r) => s + r.realized, 0))

            const savedPrices: Record<string, number | string> = priceDoc.exists() ? priceDoc.data() : {}
            const savedAt = typeof savedPrices._updatedAt === 'string' ? savedPrices._updatedAt : ''

            const groups: Record<string, string> = groupDoc.exists() ? groupDoc.data() : {}
            setStockGroups(groups)

            // 行事曆事件
            const calEvents: CalendarEvent[] = eventsSnap.docs
                .map(d => ({ id: d.id, ...d.data() } as CalendarEvent))
                .filter(e => e.date >= todayStr_ && e.date <= future14Str)
                .sort((a, b) => a.date.localeCompare(b.date))
            setUpcomingEvents(calEvents)

            // 待辦任務
            const allTasks = tasksSnap.docs.map(d => ({ id: d.id, ...d.data() } as Task))
            setTasks(allTasks.filter(t => !t.done))

            let totalMarketValue = 0
            let priceAvailable = false

            // 過濾已平倉（shares <= 0）部位
            const activePositions = Object.values(positions).filter(pos => pos.shares > 0)

            const holdingList: HoldingItem[] = activePositions.map(pos => {
                const rawPrice = savedPrices[pos.code]
                const currentPrice = typeof rawPrice === 'number' && rawPrice > 0 ? rawPrice : null
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
            setTotalCash(calcAvailableCash(cashRecords, trades))
            setHasPrice(priceAvailable)
            if (savedAt) setLastUpdated(savedAt)

            // ── 計算融資部位（按代號彙總，使用 isMargin 欄位）──
            const marginMap: Record<string, MarginPosition> = {}
            for (const t of trades) {
                if (!t.isMargin) continue
                const code = t.code
                if (!marginMap[code]) {
                    marginMap[code] = { code, name: t.name, shares: 0, marginAmount: 0, marginCost: 0 }
                }
                const pos = marginMap[code]
                if (t.type === 'buy') {
                    const stockVal = t.price * t.shares
                    const mAmt = (t as any).marginAmount ?? Math.floor(stockVal * ((t as any).marginRatio ?? 0.6))
                    pos.shares += t.shares
                    pos.marginAmount += mAmt
                    pos.marginCost += stockVal
                } else if (t.type === 'sell') {
                    // 融資賣出：按比例歸還借款
                    if (pos.shares > 0) {
                        const ratio = t.shares / pos.shares
                        pos.marginAmount -= pos.marginAmount * ratio
                        pos.marginCost -= pos.marginCost * ratio
                        pos.shares -= t.shares
                    }
                }
            }
            const activeMargin = Object.values(marginMap).filter(m => m.shares > 0 && m.marginAmount > 0)
            setMarginPositions(activeMargin)
        } catch (err) { console.error(err) }
        finally { setLoading(false) }
    }

    const toggleTask = async (id: string, done: boolean) => {
        try {
            await updateDoc(userDoc(investDB, 'tasks', id), { done: !done })
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
            // ✅ merge:true 避免覆蓋其他已快取的股票現價
            await setDoc(userDocNested(investDB, 'settings', 'lastPrices'), priceData, { merge: true })

            let totalMarketValue = 0
            let priceAvailable = false

            const updated: HoldingItem[] = holdings.map(h => {
                const rawPrice = quotes[h.code]
                const currentPrice = (typeof rawPrice === 'number' && rawPrice > 0) ? rawPrice : null
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

    // ✅ 優化：直接呼叫，移除不必要的 setTimeout 延遲
    useEffect(() => {
        void loadData()
        return () => {
            if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // 重新載入加 30 秒 cooldown，防止連續點擊觸發多次全量讀取
    const handleReload = () => {
        if (reloadCooldown > 0 || loading) return
        void loadData()
        setReloadCooldown(30)
        cooldownTimerRef.current = setInterval(() => {
            setReloadCooldown(prev => {
                if (prev <= 1) {
                    clearInterval(cooldownTimerRef.current!)
                    cooldownTimerRef.current = null
                    return 0
                }
                return prev - 1
            })
        }, 1000)
    }

    const totalMarketValue = holdings.reduce((s, h) => s + h.marketValue, 0)
    const totalCost = holdings.reduce((s, h) => s + h.totalCost, 0)
    const totalAssets = totalMarketValue + totalCash

    const holdingsWithPrice = holdings.filter(h => h.currentPrice !== null)
    const holdingsWithoutPrice = holdings.filter(h => h.currentPrice === null)
    const totalUnrealized = holdingsWithPrice.reduce((s, h) => s + h.unrealizedPnL, 0)

    // ── 融資維持率計算 ──
    // 維持率 = 融資股票目前市值 / 融資金額（借款） × 100%
    // 台灣法規：低於 130% 追繳，低於 120% 強制斷頭
    const totalMarginDebt = marginPositions.reduce((s, m) => s + m.marginAmount, 0)
    const marginStockMarketValue = marginPositions.reduce((s, m) => {
        const h = holdings.find(h => h.code === m.code)
        // 若有現價用市值，否則用買入時成本
        const mv = h ? h.currentPrice !== null ? h.currentPrice * m.shares : m.marginCost : m.marginCost
        return s + mv
    }, 0)
    const marginRatioValue = totalMarginDebt > 0 ? (marginStockMarketValue / totalMarginDebt) * 100 : null
    const hasMargin = marginPositions.length > 0

    // 維持率顏色：>160% 綠，130~160% 橙，<130% 紅
    const marginRatioColor = marginRatioValue === null ? '#8892a4'
        : marginRatioValue >= 160 ? '#00c896'
            : marginRatioValue >= 130 ? '#f5a623'
                : '#ff5757'

    // 融資加碼試算結果（即時計算，純前端）
    const simPriceNum = parseFloat(simPrice)
    const simSharesNum = parseInt(simShares, 10)
    const simRatioNum = parseFloat(simRatio)
    const simResult = (simOpen && simPriceNum > 0 && simSharesNum > 0 && simRatioNum > 0)
        ? simulateMarginBuy(marginStockMarketValue, totalMarginDebt, simPriceNum, simSharesNum, simRatioNum)
        : null
    const simRatioColor = simResult === null ? '#8892a4'
        : simResult.newMarginRatio >= 160 ? '#00c896'
            : simResult.newMarginRatio >= 130 ? '#f5a623'
                : '#ff5757'

    // 個股圓餅圖
    const pieData: PieEntry[] = [
        ...holdings.map((h, i) => ({
            name: `${h.code} ${h.name}`,
            value: h.marketValue,
            fill: COLORS[i % COLORS.length]
        })),
        ...(totalCash > 0 ? [{ name: '現金', value: totalCash, fill: CASH_COLOR }] : [])
    ]

    // 族群圓餅圖 — 依 stockGroups 彙總市值
    const groupMap: Record<string, number> = {}
    let ungroupedValue = 0
    holdings.forEach(h => {
        const g = stockGroups[h.code]
        if (g) {
            groupMap[g] = (groupMap[g] || 0) + h.marketValue
        } else {
            ungroupedValue += h.marketValue
        }
    })
    if (totalCash > 0) groupMap['現金'] = (groupMap['現金'] || 0) + totalCash
    if (ungroupedValue > 0) groupMap['未分類'] = (groupMap['未分類'] || 0) + ungroupedValue

    const groupPieData: PieEntry[] = Object.entries(groupMap)
        .sort((a, b) => b[1] - a[1])
        .map(([name, value], i) => ({
            name,
            value,
            fill: name === '現金' ? CASH_COLOR : name === '未分類' ? '#3d4460' : COLORS[i % COLORS.length]
        }))

    const hasAnyGroup = Object.keys(stockGroups).length > 0

    const unrealizedLabel = hasPrice && holdingsWithoutPrice.length > 0
        ? `未實現損益（${holdingsWithPrice.length}/${holdings.length} 檔）`
        : '未實現損益'

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
        .dash-pies { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; margin-bottom: 16px; }
        @media (max-width: 800px) { .dash-pies { grid-template-columns: 1fr; } }
        .dash-extra { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; margin-top: 16px; }
        @media (max-width: 700px) { .dash-extra { grid-template-columns: 1fr; } }
        .h-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .h-table th { padding: 8px 10px; text-align: left; color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; white-space: nowrap; }
        .h-table td { padding: 10px; border-bottom: 1px solid #2e3349; color: #e2e8f0; white-space: nowrap; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .task-row:hover { background-color: rgba(79,142,247,0.06) !important; }
        .pie-legend { max-height: 160px; overflow-y: auto; }
        .pie-legend::-webkit-scrollbar { width: 4px; }
        .pie-legend::-webkit-scrollbar-track { background: transparent; }
        .pie-legend::-webkit-scrollbar-thumb { background: #2e3349; border-radius: 2px; }
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
                            onClick={handleReload}
                            disabled={loading || reloadCooldown > 0}
                            title={reloadCooldown > 0 ? `請稍候 ${reloadCooldown} 秒後再試` : '重新載入資料'}
                            style={{ backgroundColor: '#21253a', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 14px', color: reloadCooldown > 0 ? '#8892a4' : '#e2e8f0', fontSize: '13px', cursor: reloadCooldown > 0 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px', opacity: reloadCooldown > 0 ? 0.6 : 1 }}
                        >
                            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
                            {reloadCooldown > 0 ? `${reloadCooldown}s` : '重新載入'}
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

                        {/* ── 融資維持率卡片（有融資部位才顯示）── */}
                        {hasMargin && (
                            <div style={{ marginBottom: '16px' }}>
                                <div style={{
                                    ...card,
                                    borderColor: marginRatioValue !== null && marginRatioValue < 130 ? 'rgba(255,87,87,0.5)'
                                        : marginRatioValue !== null && marginRatioValue < 160 ? 'rgba(245,166,35,0.4)'
                                            : '#2e3349',
                                    background: marginRatioValue !== null && marginRatioValue < 130 ? 'linear-gradient(135deg, #1a1d27 0%, rgba(255,87,87,0.06) 100%)'
                                        : marginRatioValue !== null && marginRatioValue < 160 ? 'linear-gradient(135deg, #1a1d27 0%, rgba(245,166,35,0.05) 100%)'
                                            : '#1a1d27'
                                }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
                                        {/* 左：主要數字 */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                            <div style={{ width: '40px', height: '40px', borderRadius: '10px', backgroundColor: `${marginRatioColor}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                                <TrendingDown size={20} color={marginRatioColor} />
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '4px' }}>融資維持率</div>
                                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                                                    <span style={{ fontSize: 'clamp(22px, 3vw, 30px)', fontWeight: 700, color: marginRatioColor, letterSpacing: '-0.5px' }}>
                                                        {marginRatioValue !== null ? `${marginRatioValue.toFixed(1)}%` : '—'}
                                                    </span>
                                                    {marginRatioValue !== null && (
                                                        <span style={{
                                                            fontSize: '12px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px',
                                                            backgroundColor: marginRatioValue >= 160 ? 'rgba(0,200,150,0.12)' : marginRatioValue >= 130 ? 'rgba(245,166,35,0.12)' : 'rgba(255,87,87,0.12)',
                                                            color: marginRatioColor
                                                        }}>
                                                            {marginRatioValue >= 160 ? '✓ 安全' : marginRatioValue >= 130 ? '⚠ 留意' : '⚠ 危險'}
                                                        </span>
                                                    )}
                                                </div>
                                                <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '2px' }}>
                                                    {!hasPrice ? '尚未更新現價，以買入成本估算' : '以最新現價計算'}
                                                </div>
                                            </div>
                                        </div>

                                        {/* 右：融資明細 */}
                                        <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                                            <div>
                                                <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>融資股票市值</div>
                                                <div style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>${marginStockMarketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>融資借款金額</div>
                                                <div style={{ fontSize: '15px', fontWeight: 600, color: '#f5a623' }}>${totalMarginDebt.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>融資部位數</div>
                                                <div style={{ fontSize: '15px', fontWeight: 600, color: '#a78bfa' }}>{marginPositions.length} 檔</div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* 進度條 */}
                                    {marginRatioValue !== null && (
                                        <div style={{ marginTop: '16px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#8892a4', marginBottom: '4px' }}>
                                                <span>斷頭線 120%</span>
                                                <span>追繳線 130%</span>
                                                <span>安全線 160%</span>
                                                <span>目前 {marginRatioValue.toFixed(1)}%</span>
                                            </div>
                                            <div style={{ height: '6px', backgroundColor: '#0f1117', borderRadius: '3px', overflow: 'hidden', position: 'relative' }}>
                                                {/* 底層色帶 */}
                                                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, rgba(255,87,87,0.3) 0%, rgba(255,87,87,0.3) 20%, rgba(245,166,35,0.3) 20%, rgba(245,166,35,0.3) 40%, rgba(0,200,150,0.2) 40%, rgba(0,200,150,0.2) 100%)' }} />
                                                {/* 當前值指示 */}
                                                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.min(marginRatioValue / 250 * 100, 100)}%`, backgroundColor: marginRatioColor, borderRadius: '3px', transition: 'width 0.4s ease' }} />
                                            </div>
                                        </div>
                                    )}

                                    {/* 融資個股明細 */}
                                    {marginPositions.length > 0 && (
                                        <div style={{ marginTop: '14px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                            {marginPositions.map(m => {
                                                const h = holdings.find(h => h.code === m.code)
                                                const mv = h ? (h.currentPrice !== null ? h.currentPrice * m.shares : m.marginCost) : m.marginCost
                                                const ratio = m.marginAmount > 0 ? (mv / m.marginAmount) * 100 : 0
                                                const rColor = ratio >= 160 ? '#00c896' : ratio >= 130 ? '#f5a623' : '#ff5757'
                                                return (
                                                    <div key={m.code} style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '8px 12px', border: `1px solid ${rColor}28`, minWidth: '120px' }}>
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                                                            <span style={{ color: '#4f8ef7', fontWeight: 700, fontSize: '13px' }}>{m.code}</span>
                                                            <span style={{ color: rColor, fontWeight: 600, fontSize: '12px' }}>{ratio.toFixed(0)}%</span>
                                                        </div>
                                                        <div style={{ fontSize: '11px', color: '#8892a4', marginTop: '2px' }}>{m.shares.toLocaleString()} 股</div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    )}

                                    {/* 危險警示 */}
                                    {marginRatioValue !== null && marginRatioValue < 130 && (
                                        <div style={{ marginTop: '12px', padding: '8px 12px', backgroundColor: 'rgba(255,87,87,0.08)', border: '1px solid rgba(255,87,87,0.25)', borderRadius: '8px', fontSize: '12px', color: '#ff5757' }}>
                                            ⚠️ 維持率低於 130%，請留意追繳風險！強制斷頭線為 120%。
                                        </div>
                                    )}

                                    {/* ── 加碼試算區塊 ── */}
                                    <div style={{ marginTop: '14px', borderTop: '1px solid #2e3349', paddingTop: '14px' }}>
                                        <button
                                            onClick={() => setSimOpen(v => !v)}
                                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4f8ef7', fontSize: '12px', fontWeight: 600, padding: 0, display: 'flex', alignItems: 'center', gap: '5px' }}
                                        >
                                            <span style={{ fontSize: '14px' }}>{simOpen ? '▾' : '▸'}</span>
                                            加碼試算
                                        </button>

                                        {simOpen && (
                                            <div style={{ marginTop: '12px' }}>
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end' }}>
                                                    {[
                                                        { label: '買入價格', value: simPrice, setter: setSimPrice, placeholder: '例：600', unit: '元' },
                                                        { label: '加碼股數', value: simShares, setter: setSimShares, placeholder: '例：1000', unit: '股' },
                                                        { label: '融資成數', value: simRatio, setter: setSimRatio, placeholder: '0.6', unit: '' },
                                                    ].map(({ label, value, setter, placeholder, unit }) => (
                                                        <div key={label}>
                                                            <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>{label}</div>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                                <input
                                                                    type="number"
                                                                    value={value}
                                                                    onChange={e => setter(e.target.value)}
                                                                    placeholder={placeholder}
                                                                    style={{ width: '90px', padding: '6px 8px', backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '6px', color: '#e2e8f0', fontSize: '13px', outline: 'none' }}
                                                                />
                                                                {unit && <span style={{ fontSize: '12px', color: '#8892a4' }}>{unit}</span>}
                                                            </div>
                                                        </div>
                                                    ))}
                                                    <button
                                                        onClick={() => { setSimPrice(''); setSimShares(''); setSimRatio('0.6') }}
                                                        style={{ padding: '6px 10px', backgroundColor: '#21253a', border: '1px solid #2e3349', borderRadius: '6px', color: '#8892a4', fontSize: '12px', cursor: 'pointer' }}
                                                    >清除</button>
                                                </div>

                                                {simResult ? (
                                                    <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '8px' }}>
                                                        <div style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '10px 12px', border: `1px solid ${simRatioColor}30` }}>
                                                            <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>加碼後維持率</div>
                                                            <div style={{ fontSize: '18px', fontWeight: 700, color: simRatioColor }}>{simResult.newMarginRatio.toFixed(1)}%</div>
                                                            <div style={{ fontSize: '11px', marginTop: '3px', color: simRatioColor, fontWeight: 600 }}>
                                                                {simResult.newMarginRatio >= 160 ? '✓ 安全' : simResult.newMarginRatio >= 130 ? '⚠ 留意' : '⚠ 危險'}
                                                            </div>
                                                        </div>
                                                        <div style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '10px 12px' }}>
                                                            <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>較現在變化</div>
                                                            <div style={{ fontSize: '16px', fontWeight: 700, color: simResult.newMarginRatio >= (marginRatioValue ?? 0) ? '#00c896' : '#ff5757' }}>
                                                                {simResult.newMarginRatio >= (marginRatioValue ?? 0) ? '+' : ''}{(simResult.newMarginRatio - (marginRatioValue ?? 0)).toFixed(1)}%
                                                            </div>
                                                        </div>
                                                        <div style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '10px 12px' }}>
                                                            <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>新增借款</div>
                                                            <div style={{ fontSize: '14px', fontWeight: 600, color: '#f5a623' }}>${simResult.addedDebt.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                                        </div>
                                                        <div style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '10px 12px' }}>
                                                            <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>需自備款</div>
                                                            <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>${simResult.addedEquity.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                                        </div>
                                                        <div style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '10px 12px' }}>
                                                            <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>距追繳線(130%)緩衝</div>
                                                            <div style={{ fontSize: '14px', fontWeight: 600, color: simResult.bufferTo130 >= 0 ? '#00c896' : '#ff5757' }}>
                                                                {simResult.bufferTo130 >= 0 ? '+' : ''}${simResult.bufferTo130.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                            </div>
                                                        </div>
                                                        <div style={{ backgroundColor: '#0f1117', borderRadius: '8px', padding: '10px 12px' }}>
                                                            <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>距斷頭線(120%)緩衝</div>
                                                            <div style={{ fontSize: '14px', fontWeight: 600, color: simResult.bufferTo120 >= 0 ? '#00c896' : '#ff5757' }}>
                                                                {simResult.bufferTo120 >= 0 ? '+' : ''}${simResult.bufferTo120.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                            </div>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div style={{ marginTop: '10px', fontSize: '12px', color: '#3d4460' }}>輸入買入價格與股數後自動計算</div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        {hasPrice && holdingsWithoutPrice.length > 0 && (
                            <div style={{ marginBottom: '12px', padding: '10px 14px', backgroundColor: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.25)', borderRadius: '8px', fontSize: '12px', color: '#f5a623' }}>
                                ⚠️ {holdingsWithoutPrice.length} 檔持倉（{holdingsWithoutPrice.map(h => h.code).join('、')}）尚未更新現價，市值以成本計算，未實現損益僅計算已有現價的持倉。
                            </div>
                        )}

                        {/* ── 兩個圓餅圖並排 ── */}
                        <div className="dash-pies">
                            {/* 個股分布 */}
                            <div style={card}>
                                <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>資產分布（個股）</div>
                                {pieData.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '40px', color: '#8892a4', fontSize: '13px' }}>尚無持倉</div>
                                ) : (
                                    <>
                                        <ResponsiveContainer width="100%" height={180}>
                                            <PieChart>
                                                <Pie data={pieData} cx="50%" cy="50%" innerRadius={45} outerRadius={75} paddingAngle={2} dataKey="value">
                                                    {pieData.map((entry, i) => (
                                                        <Cell key={i} fill={entry.fill} />
                                                    ))}
                                                </Pie>
                                                <Tooltip content={<AssetTooltip totalAssets={totalAssets} />} />
                                            </PieChart>
                                        </ResponsiveContainer>
                                        <div className="pie-legend" style={{ marginTop: '8px' }}>
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

                            {/* 族群分布 */}
                            <div style={card}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>族群佔比</div>
                                </div>
                                {!hasAnyGroup ? (
                                    <div style={{ textAlign: 'center', padding: '40px 20px', color: '#8892a4', fontSize: '13px' }}>
                                        <Tag size={28} color="#2e3349" style={{ marginBottom: '12px' }} />
                                        <p style={{ margin: '0 0 6px' }}>尚未設定族群標籤</p>
                                        <p style={{ margin: 0, fontSize: '12px' }}>
                                            前往
                                            <button onClick={() => navigate('/invest/holdings')}
                                                style={{ background: 'none', border: 'none', color: '#a78bfa', cursor: 'pointer', fontSize: '12px', padding: '0 4px', textDecoration: 'underline' }}>
                                                持倉明細
                                            </button>
                                            設定每檔股票的族群
                                        </p>
                                    </div>
                                ) : (
                                    <>
                                        <ResponsiveContainer width="100%" height={180}>
                                            <PieChart>
                                                <Pie
                                                    data={groupPieData}
                                                    cx="50%" cy="50%"
                                                    innerRadius={45} outerRadius={75}
                                                    paddingAngle={2}
                                                    dataKey="value"
                                                    labelLine={false}
                                                    label={renderCustomLabel}
                                                >
                                                    {groupPieData.map((entry, i) => (
                                                        <Cell key={i} fill={entry.fill} />
                                                    ))}
                                                </Pie>
                                                <Tooltip content={<GroupTooltip totalAssets={totalAssets} />} />
                                            </PieChart>
                                        </ResponsiveContainer>
                                        <div className="pie-legend" style={{ marginTop: '8px' }}>
                                            {groupPieData.map(item => (
                                                <div key={item.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '12px' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                        <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: item.fill, flexShrink: 0 }} />
                                                        <span style={{ color: item.name === '未分類' ? '#8892a4' : '#e2e8f0' }}>{item.name}</span>
                                                    </div>
                                                    <span style={{ color: '#8892a4' }}>
                                                        {totalAssets > 0 ? ((item.value / totalAssets) * 100).toFixed(1) : 0}%
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                        {ungroupedValue > 0 && (
                                            <div style={{ marginTop: '10px', padding: '6px 10px', backgroundColor: 'rgba(167,139,250,0.07)', borderRadius: '6px', fontSize: '11px', color: '#8892a4', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                <Tag size={11} color="#a78bfa" />
                                                有 {holdings.filter(h => !stockGroups[h.code]).length} 檔尚未設定族群，已歸入「未分類」
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>

                        {/* 目前持倉表格 */}
                        <div style={{ ...card, marginBottom: '0' }}>
                            <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>目前持倉</div>
                            {holdings.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '40px', color: '#8892a4', fontSize: '13px' }}>尚無持倉資料</div>
                            ) : (
                                <div style={{ overflowX: 'auto' }}>
                                    <table className="h-table">
                                        <thead>
                                            <tr>{['代號', '名稱', '股數', '均價', '現價', '未實現損益', '報酬率', '佔比', '族群'].map(h => <th key={h}>{h}</th>)}</tr>
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
                                                    <td>
                                                        {stockGroups[h.code] ? (
                                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.12)', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>
                                                                <Tag size={10} />
                                                                {stockGroups[h.code]}
                                                            </span>
                                                        ) : (
                                                            <span style={{ fontSize: '12px', color: '#3d4460' }}>—</span>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
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
                                                {overdueTasks.map(t => <TaskRow key={t.id} task={t} todayStr={todayStr} />)}
                                            </>
                                        )}
                                        {todayTasks.length > 0 && (
                                            <>
                                                <div style={{ fontSize: '11px', color: '#f5a623', fontWeight: 600, padding: '4px 0 2px' }}>今日到期</div>
                                                {todayTasks.map(t => <TaskRow key={t.id} task={t} todayStr={todayStr} />)}
                                            </>
                                        )}
                                        {futureTasks.length > 0 && (
                                            <>
                                                {(overdueTasks.length > 0 || todayTasks.length > 0) && (
                                                    <div style={{ fontSize: '11px', color: '#8892a4', fontWeight: 600, padding: '4px 0 2px' }}>其他</div>
                                                )}
                                                {futureTasks.map(t => <TaskRow key={t.id} task={t} todayStr={todayStr} />)}
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

function TaskRow({ task, todayStr }: {
    task: Task
    todayStr: string
}) {
    const navigate = useNavigate()
    const isOverdue = task.dueDate && task.dueDate < todayStr
    return (
        <div className="task-row"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', backgroundColor: '#0f1117', borderRadius: '8px', cursor: 'pointer' }}
            onClick={() => navigate('/calendar/tasks')}
            title="點擊前往任務管理頁面"
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