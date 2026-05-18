import { useState, useEffect, useRef } from 'react'
import { collection, getDocs, orderBy, query, doc, setDoc, getDoc, updateDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { calcPositions, calcAvailableCash, simulateMarginBuy, calcMarginDebt, type TradeRecord, type DividendRecord } from '../../lib/calc'
import { DollarSign, BarChart2, RefreshCw, Calendar, CheckSquare, ExternalLink, Tag, TrendingDown } from 'lucide-react'
import { PieChart, Pie, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { useNavigate } from 'react-router-dom'
import { usePrices } from '../../PriceContext'

const COLORS = ['var(--c-accent)', 'var(--c-positive)', 'var(--c-warning)', 'var(--c-danger)', '#a78bfa', '#34d399', '#fb923c', '#60a5fa', '#f472b6', '#facc15', '#38bdf8', '#4ade80']
const CASH_COLOR = 'var(--c-muted)'
const pnlColor = (v: number) => v >= 0 ? 'var(--c-positive)' : 'var(--c-danger)'
const card: React.CSSProperties = {
    backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px'
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

const PRIORITY_COLORS = { high: 'var(--c-danger)', medium: 'var(--c-warning)', low: 'var(--c-positive)' }
const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' }

// ── 賣出追蹤通知（固定值：14天內賣出、漲超10%）─────────────────────────────
const SOLD_WATCH_DAYS = 14
const SOLD_RISE_THRESHOLD = 10  // %

interface SoldAlert {
    code: string
    name: string
    date: string
    soldPrice: number
    shares: number
    currentPrice: number
    changePct: number
    opportunityCost: number
}

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
        <div style={{ backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '10px', padding: '10px 14px', minWidth: '160px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '8px' }}>
                <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: fill, flexShrink: 0 }} />
                <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--c-text)' }}>{name}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '20px', fontSize: '12px' }}>
                <span style={{ color: 'var(--c-muted)' }}>市值</span>
                <span style={{ color: 'var(--c-text)', fontWeight: 600 }}>${value.toLocaleString()}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '20px', fontSize: '12px', marginTop: '4px' }}>
                <span style={{ color: 'var(--c-muted)' }}>佔比</span>
                <span style={{ color: 'var(--c-accent)', fontWeight: 600 }}>{pct}%</span>
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
        <div style={{ backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '10px', padding: '10px 14px', minWidth: '160px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '8px' }}>
                <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: fill, flexShrink: 0 }} />
                <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--c-text)' }}>{name}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '20px', fontSize: '12px' }}>
                <span style={{ color: 'var(--c-muted)' }}>市值</span>
                <span style={{ color: 'var(--c-text)', fontWeight: 600 }}>${value.toLocaleString()}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '20px', fontSize: '12px', marginTop: '4px' }}>
                <span style={{ color: 'var(--c-muted)' }}>佔比</span>
                <span style={{ color: '#a78bfa', fontWeight: 600 }}>{pct}%</span>
            </div>
        </div>
    )
}

export default function Dashboard() {
    const navigate = useNavigate()
    // ✅ 修正：改用 PriceContext，updatePrices 會同步更新全域，Holdings/Watchlist 等頁面一併反映
    const { prices: ctxPrices, lastUpdated: ctxLastUpdated, priceLoading, updatePrices: ctxUpdatePrices } = usePrices()

    const [holdings, setHoldings] = useState<HoldingItem[]>([])
    const [totalCash, setTotalCash] = useState(0)
    const [realizedPnL, setRealizedPnL] = useState(0)
    const [loading, setLoading] = useState(true)
    const [lastUpdated, setLastUpdated] = useState('')
    const [hasPrice, setHasPrice] = useState(false)
    const [stockGroups, setStockGroups] = useState<Record<string, string>>({})
    const [reloadCooldown, setReloadCooldown] = useState(0) // 秒數倒數
    const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const [showReloadConfirm, setShowReloadConfirm] = useState(false)

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
    const [soldAlerts, setSoldAlerts] = useState<SoldAlert[]>([])
    // sell trades 快取，供 updatePrices 掃描通知用（不重複讀 Firebase）
    const [sellTradesCache, setSellTradesCache] = useState<Array<{ date: string; code: string; name: string; price: number; shares: number }>>([])

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

            // 快取賣出紀錄（日期在 SOLD_WATCH_DAYS 內），供 updatePrices 掃描通知
            const today0 = new Date().toISOString().split('T')[0]
            const sellCache = trades
                .filter(t => t.type === 'sell')
                .map(t => ({ date: t.date, code: t.code, name: t.name, price: t.price, shares: t.shares }))
                .filter(t => {
                    const d = Math.floor((Date.now() - new Date(t.date).getTime()) / 86400000)
                    return d <= SOLD_WATCH_DAYS
                })
            setSellTradesCache(sellCache)

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
                // ✅ 修正：優先用 PriceContext（跨頁同步），再 fallback Firebase 快取
                const ctxVal = ctxPrices[pos.code]
                const fbVal = savedPrices[pos.code]
                const currentPrice = (typeof ctxVal === 'number' && ctxVal > 0)
                    ? ctxVal
                    : (typeof fbVal === 'number' && fbVal > 0 ? fbVal : null)
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
            // ✅ 修正：優先用 PriceContext 的最後更新時間，再 fallback Firebase savedAt
            if (ctxLastUpdated) setLastUpdated(ctxLastUpdated)
            else if (savedAt) setLastUpdated(savedAt)

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
                    // ✅ 修正：永遠用 calcMarginDebt 重算（捨去至千元），不信任舊存的 marginAmount
                    // 舊資料可能存了未捨去的值（如 90600），導致與券商對不上
                    const marginRatio = (t as any).marginRatio ?? 0.6
                    const mAmt = calcMarginDebt(stockVal, marginRatio)
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

    // ✅ 修正：委託 PriceContext 更新，結果自動同步到 Holdings、Watchlist 等所有頁面
    const updatePrices = async () => {
        // 持倉代號 + 近期賣出代號（賣出追蹤通知需要）一併查詢，不額外呼叫 Firebase
        const holdingCodes = holdings.map(h => h.code)
        const sellCodes = sellTradesCache.map(t => t.code)
        const symbols = [...new Set([...holdingCodes, ...sellCodes])]
        if (symbols.length === 0) return
        const quotes = await ctxUpdatePrices(symbols)

        // 用 context 回傳的即時 quotes 同步更新本頁 holdings（不等 state 重渲染）
        let totalMarketValue = 0
        let priceAvailable = false
        const updated: HoldingItem[] = holdings.map(h => {
            const rawPrice = quotes[h.code]
            const currentPrice = (typeof rawPrice === 'number' && rawPrice > 0) ? rawPrice : null
            if (currentPrice !== null) priceAvailable = true
            const marketValue = currentPrice !== null ? currentPrice * h.shares : h.totalCost
            const unrealizedPnL = currentPrice !== null ? marketValue - h.totalCost : 0
            const returnRate = (currentPrice !== null && h.totalCost > 0)
                ? (unrealizedPnL / h.totalCost) * 100 : 0
            totalMarketValue += marketValue
            return { ...h, currentPrice, marketValue, unrealizedPnL, returnRate }
        })
        updated.forEach(h => { h.ratio = totalMarketValue > 0 ? (h.marketValue / totalMarketValue) * 100 : 0 })
        updated.sort((a, b) => b.marketValue - a.marketValue)
        setHoldings(updated)
        setHasPrice(priceAvailable)
        setLastUpdated(new Date().toLocaleString('zh-TW'))

        // ── 掃描賣出追蹤通知（零額外 Firebase 讀取，直接用本次 quotes）──
        const alerts: SoldAlert[] = sellTradesCache
            .filter(t => {
                const p = quotes[t.code]
                if (typeof p !== 'number' || p <= 0) return false
                const pct = ((p - t.price) / t.price) * 100
                return pct >= SOLD_RISE_THRESHOLD
            })
            .map(t => {
                const currentPrice = quotes[t.code] as number
                const changePct = ((currentPrice - t.price) / t.price) * 100
                return {
                    code: t.code, name: t.name, date: t.date,
                    soldPrice: t.price, shares: t.shares,
                    currentPrice, changePct,
                    opportunityCost: Math.round((currentPrice - t.price) * t.shares),
                }
            })
            .sort((a, b) => b.changePct - a.changePct)
        setSoldAlerts(alerts)
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
        setShowReloadConfirm(true)
    }

    const confirmReload = () => {
        setShowReloadConfirm(false)
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
    const marginRatioColor = marginRatioValue === null ? 'var(--c-muted)'
        : marginRatioValue >= 160 ? 'var(--c-positive)'
            : marginRatioValue >= 130 ? 'var(--c-warning)'
                : 'var(--c-danger)'

    // 融資加碼試算結果（即時計算，純前端）
    const simPriceNum = parseFloat(simPrice)
    const simSharesNum = parseInt(simShares, 10)
    const simRatioNum = parseFloat(simRatio)
    const simResult = (simOpen && simPriceNum > 0 && simSharesNum > 0 && simRatioNum > 0)
        ? simulateMarginBuy(marginStockMarketValue, totalMarginDebt, simPriceNum, simSharesNum, simRatioNum)
        : null
    const simRatioColor = simResult === null ? 'var(--c-muted)'
        : simResult.newMarginRatio >= 160 ? 'var(--c-positive)'
            : simResult.newMarginRatio >= 130 ? 'var(--c-warning)'
                : 'var(--c-danger)'

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
        .h-table th { padding: 8px 10px; text-align: left; color: var(--c-muted); font-weight: 500; border-bottom: 1px solid var(--c-border); white-space: nowrap; }
        .h-table td { padding: 10px; border-bottom: 1px solid var(--c-border); color: var(--c-text); white-space: nowrap; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .task-row:hover { background-color: rgba(79,142,247,0.06) !important; }
        .pie-legend { max-height: 160px; overflow-y: auto; }
        .pie-legend::-webkit-scrollbar { width: 4px; }
        .pie-legend::-webkit-scrollbar-track { background: transparent; }
        .pie-legend::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 2px; }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>儀表板</h1>
                        <p style={{ fontSize: '12px', color: 'var(--c-muted)', margin: '4px 0 0' }}>
                            {lastUpdated ? `現價更新：${lastUpdated}` : '尚未更新現價，點「更新現價」取得最新報價'}
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <div style={{ position: 'relative' }}>
                            <button
                                onClick={handleReload}
                                disabled={loading || reloadCooldown > 0}
                                title={reloadCooldown > 0 ? `請稍候 ${reloadCooldown} 秒後再試` : '重新載入資料'}
                                style={{ backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 14px', color: reloadCooldown > 0 ? 'var(--c-muted)' : 'var(--c-text)', fontSize: '13px', cursor: reloadCooldown > 0 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px', opacity: reloadCooldown > 0 ? 0.6 : 1 }}
                            >
                                <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
                                {reloadCooldown > 0 ? `${reloadCooldown}s` : '重新載入'}
                            </button>
                            {showReloadConfirm && (
                                <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '10px', padding: '14px 16px', zIndex: 50, minWidth: '200px', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}>
                                    <div style={{ fontSize: '13px', color: 'var(--c-text)', marginBottom: '12px', fontWeight: 600 }}>確認重新載入？</div>
                                    <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '12px' }}>將重新從資料庫讀取所有資料</div>
                                    <div style={{ display: 'flex', gap: '8px' }}>
                                        <button onClick={confirmReload}
                                            style={{ flex: 1, backgroundColor: 'var(--c-accent)', border: 'none', borderRadius: '6px', padding: '6px 0', color: '#fff', fontSize: '12px', cursor: 'pointer', fontWeight: 600 }}>
                                            確認
                                        </button>
                                        <button onClick={() => setShowReloadConfirm(false)}
                                            style={{ flex: 1, backgroundColor: 'transparent', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '6px 0', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>
                                            取消
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                        <button
                            onClick={() => void updatePrices()}
                            disabled={priceLoading || loading}
                            style={{ backgroundColor: 'var(--c-accent)', border: 'none', borderRadius: '8px', padding: '8px 14px', color: '#fff', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
                        >
                            <RefreshCw size={14} style={{ animation: priceLoading ? 'spin 1s linear infinite' : 'none' }} />
                            {priceLoading ? '更新中...' : '更新現價'}
                        </button>
                    </div>
                </div>

                {/* ── 賣出追蹤通知卡片（有觸發才顯示）── */}
                {soldAlerts.length > 0 && (
                    <div style={{
                        border: '1px solid color-mix(in srgb, var(--c-danger) 40%, transparent)',
                        borderRadius: '12px', padding: '14px 18px', marginBottom: '20px',
                        backgroundColor: 'color-mix(in srgb, var(--c-danger) 6%, transparent)',
                        cursor: 'pointer',
                    }} onClick={() => navigate('/invest/sold-tracker')}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: soldAlerts.length > 0 ? '12px' : '0' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--c-danger)', fontWeight: 700, fontSize: '14px' }}>
                                <TrendingDown size={15} />
                                賣出追蹤通知（{soldAlerts.length} 筆）
                                <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--c-muted)' }}>
                                    · {SOLD_WATCH_DAYS} 天內賣出，現價漲超 {SOLD_RISE_THRESHOLD}%
                                </span>
                            </div>
                            <span style={{ fontSize: '11px', color: 'var(--c-accent)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                查看詳情 →
                            </span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {soldAlerts.map(a => (
                                <div key={a.code + a.date} style={{
                                    display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
                                    backgroundColor: 'var(--c-card)', borderRadius: '8px', padding: '8px 14px',
                                    border: '1px solid color-mix(in srgb, var(--c-danger) 20%, transparent)',
                                }}>
                                    <span style={{ fontWeight: 700, color: 'var(--c-accent)', fontSize: '14px', minWidth: '50px' }}>{a.code}</span>
                                    <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>{a.name}</span>
                                    <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>賣出 {a.date}</span>
                                    <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>賣出價 {a.soldPrice}</span>
                                    <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>→ 現價 {a.currentPrice.toFixed(2)}</span>
                                    <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--c-danger)' }}>
                                        +{a.changePct.toFixed(2)}%
                                    </span>
                                    <span style={{ fontSize: '12px', color: 'var(--c-danger)', fontWeight: 600 }}>
                                        機會成本 +{a.opportunityCost.toLocaleString()} 元
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {loading ? (
                    <div style={{ textAlign: 'center', padding: '80px', color: 'var(--c-muted)' }}>載入中...</div>
                ) : (
                    <>
                        <div className="dash-stats">
                            {[
                                { label: '總資產', value: `$${totalAssets.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: 'var(--c-accent)', icon: DollarSign },
                                { label: '股票總市值', value: `$${totalMarketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: 'var(--c-accent)', icon: BarChart2 },
                                { label: '可用現金', value: `$${totalCash.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: 'var(--c-warning)', icon: DollarSign },
                            ].map(({ label, value, color, icon: Icon }) => (
                                <div key={label} style={card}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <div>
                                            <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>{label}</div>
                                            <div style={{ fontSize: 'clamp(16px, 2vw, 22px)', fontWeight: 700, color }}>{value}</div>
                                        </div>
                                        <Icon size={18} color={color} style={{ opacity: 0.5 }} />
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="dash-stats">
                            {[
                                { label: '股票總成本', value: `$${totalCost.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: 'var(--c-muted)' },
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
                                    <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>{label}</div>
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
                                            : 'var(--c-border)',
                                    background: marginRatioValue !== null && marginRatioValue < 130 ? 'linear-gradient(135deg, var(--c-sidebar) 0%, color-mix(in srgb, var(--c-danger) 6%, transparent) 100%)'
                                        : marginRatioValue !== null && marginRatioValue < 160 ? 'linear-gradient(135deg, var(--c-sidebar) 0%, color-mix(in srgb, var(--c-warning) 5%, transparent) 100%)'
                                            : 'var(--c-sidebar)'
                                }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
                                        {/* 左：主要數字 */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                            <div style={{ width: '40px', height: '40px', borderRadius: '10px', backgroundColor: `${marginRatioColor}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                                <TrendingDown size={20} color={marginRatioColor} />
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '4px' }}>融資維持率</div>
                                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                                                    <span style={{ fontSize: 'clamp(22px, 3vw, 30px)', fontWeight: 700, color: marginRatioColor, letterSpacing: '-0.5px' }}>
                                                        {marginRatioValue !== null ? `${marginRatioValue.toFixed(1)}%` : '—'}
                                                    </span>
                                                    {marginRatioValue !== null && (
                                                        <span style={{
                                                            fontSize: '12px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px',
                                                            backgroundColor: marginRatioValue >= 160 ? 'color-mix(in srgb, var(--c-positive) 12%, transparent)' : marginRatioValue >= 130 ? 'color-mix(in srgb, var(--c-warning) 12%, transparent)' : 'color-mix(in srgb, var(--c-danger) 12%, transparent)',
                                                            color: marginRatioColor
                                                        }}>
                                                            {marginRatioValue >= 160 ? '✓ 安全' : marginRatioValue >= 130 ? '⚠ 留意' : '⚠ 危險'}
                                                        </span>
                                                    )}
                                                </div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginTop: '2px' }}>
                                                    {!hasPrice ? '尚未更新現價，以買入成本估算' : '以最新現價計算'}
                                                </div>
                                            </div>
                                        </div>

                                        {/* 右：融資明細 */}
                                        <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                                            <div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>融資股票市值</div>
                                                <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-text)' }}>${marginStockMarketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>融資借款金額</div>
                                                <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-warning)' }}>${totalMarginDebt.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>融資部位數</div>
                                                <div style={{ fontSize: '15px', fontWeight: 600, color: '#a78bfa' }}>{marginPositions.length} 檔</div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* 進度條 */}
                                    {marginRatioValue !== null && (
                                        <div style={{ marginTop: '16px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--c-muted)', marginBottom: '4px' }}>
                                                <span>斷頭線 120%</span>
                                                <span>追繳線 130%</span>
                                                <span>安全線 160%</span>
                                                <span>目前 {marginRatioValue.toFixed(1)}%</span>
                                            </div>
                                            <div style={{ height: '6px', backgroundColor: 'var(--c-bg)', borderRadius: '3px', overflow: 'hidden', position: 'relative' }}>
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
                                                const rColor = ratio >= 160 ? 'var(--c-positive)' : ratio >= 130 ? 'var(--c-warning)' : 'var(--c-danger)'
                                                return (
                                                    <div key={m.code} style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '8px 12px', border: `1px solid ${rColor}28`, minWidth: '120px' }}>
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                                                            <span style={{ color: 'var(--c-accent)', fontWeight: 700, fontSize: '13px' }}>{m.code}</span>
                                                            <span style={{ color: rColor, fontWeight: 600, fontSize: '12px' }}>{ratio.toFixed(0)}%</span>
                                                        </div>
                                                        <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginTop: '2px' }}>{m.shares.toLocaleString()} 股</div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    )}

                                    {/* 危險警示 */}
                                    {marginRatioValue !== null && marginRatioValue < 130 && (
                                        <div style={{ marginTop: '12px', padding: '8px 12px', backgroundColor: 'rgba(255,87,87,0.08)', border: '1px solid rgba(255,87,87,0.25)', borderRadius: '8px', fontSize: '12px', color: 'var(--c-danger)' }}>
                                            ⚠️ 維持率低於 130%，請留意追繳風險！強制斷頭線為 120%。
                                        </div>
                                    )}

                                    {/* ── 加碼試算區塊 ── */}
                                    <div style={{ marginTop: '14px', borderTop: '1px solid var(--c-border)', paddingTop: '14px' }}>
                                        <button
                                            onClick={() => setSimOpen(v => !v)}
                                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-accent)', fontSize: '12px', fontWeight: 600, padding: 0, display: 'flex', alignItems: 'center', gap: '5px' }}
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
                                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>{label}</div>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                                <input
                                                                    type="number"
                                                                    value={value}
                                                                    onChange={e => setter(e.target.value)}
                                                                    placeholder={placeholder}
                                                                    style={{ width: '90px', padding: '6px 8px', backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '6px', color: 'var(--c-text)', fontSize: '13px', outline: 'none' }}
                                                                />
                                                                {unit && <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>{unit}</span>}
                                                            </div>
                                                        </div>
                                                    ))}
                                                    <button
                                                        onClick={() => { setSimPrice(''); setSimShares(''); setSimRatio('0.6') }}
                                                        style={{ padding: '6px 10px', backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '6px', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}
                                                    >清除</button>
                                                </div>

                                                {simResult ? (
                                                    <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '8px' }}>
                                                        <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '10px 12px', border: `1px solid ${simRatioColor}30` }}>
                                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>加碼後維持率</div>
                                                            <div style={{ fontSize: '18px', fontWeight: 700, color: simRatioColor }}>{simResult.newMarginRatio.toFixed(1)}%</div>
                                                            <div style={{ fontSize: '11px', marginTop: '3px', color: simRatioColor, fontWeight: 600 }}>
                                                                {simResult.newMarginRatio >= 160 ? '✓ 安全' : simResult.newMarginRatio >= 130 ? '⚠ 留意' : '⚠ 危險'}
                                                            </div>
                                                        </div>
                                                        <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '10px 12px' }}>
                                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>較現在變化</div>
                                                            <div style={{ fontSize: '16px', fontWeight: 700, color: simResult.newMarginRatio >= (marginRatioValue ?? 0) ? 'var(--c-positive)' : 'var(--c-danger)' }}>
                                                                {simResult.newMarginRatio >= (marginRatioValue ?? 0) ? '+' : ''}{(simResult.newMarginRatio - (marginRatioValue ?? 0)).toFixed(1)}%
                                                            </div>
                                                        </div>
                                                        <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '10px 12px' }}>
                                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>新增借款</div>
                                                            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-warning)' }}>${simResult.addedDebt.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                                        </div>
                                                        <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '10px 12px' }}>
                                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>需自備款</div>
                                                            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>${simResult.addedEquity.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                                        </div>
                                                        <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '10px 12px' }}>
                                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>距追繳線(130%)緩衝</div>
                                                            <div style={{ fontSize: '14px', fontWeight: 600, color: simResult.bufferTo130 >= 0 ? 'var(--c-positive)' : 'var(--c-danger)' }}>
                                                                {simResult.bufferTo130 >= 0 ? '+' : ''}${simResult.bufferTo130.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                            </div>
                                                        </div>
                                                        <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '10px 12px' }}>
                                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>距斷頭線(120%)緩衝</div>
                                                            <div style={{ fontSize: '14px', fontWeight: 600, color: simResult.bufferTo120 >= 0 ? 'var(--c-positive)' : 'var(--c-danger)' }}>
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
                            <div style={{ marginBottom: '12px', padding: '10px 14px', backgroundColor: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.25)', borderRadius: '8px', fontSize: '12px', color: 'var(--c-warning)' }}>
                                ⚠️ {holdingsWithoutPrice.length} 檔持倉（{holdingsWithoutPrice.map(h => h.code).join('、')}）尚未更新現價，市值以成本計算，未實現損益僅計算已有現價的持倉。
                            </div>
                        )}

                        {/* ── 兩個圓餅圖並排 ── */}
                        <div className="dash-pies">
                            {/* 個股分布 */}
                            <div style={card}>
                                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>資產分布（個股）</div>
                                {pieData.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '40px', color: 'var(--c-muted)', fontSize: '13px' }}>尚無持倉</div>
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
                                                        <span style={{ color: 'var(--c-text)' }}>{item.name}</span>
                                                    </div>
                                                    <span style={{ color: 'var(--c-muted)' }}>{totalAssets > 0 ? ((item.value / totalAssets) * 100).toFixed(1) : 0}%</span>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </div>

                            {/* 族群分布 */}
                            <div style={card}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>族群佔比</div>
                                </div>
                                {!hasAnyGroup ? (
                                    <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--c-muted)', fontSize: '13px' }}>
                                        <Tag size={28} color="var(--c-border)" style={{ marginBottom: '12px' }} />
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
                                                        <span style={{ color: item.name === '未分類' ? 'var(--c-muted)' : 'var(--c-text)' }}>{item.name}</span>
                                                    </div>
                                                    <span style={{ color: 'var(--c-muted)' }}>
                                                        {totalAssets > 0 ? ((item.value / totalAssets) * 100).toFixed(1) : 0}%
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                        {ungroupedValue > 0 && (
                                            <div style={{ marginTop: '10px', padding: '6px 10px', backgroundColor: 'rgba(167,139,250,0.07)', borderRadius: '6px', fontSize: '11px', color: 'var(--c-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
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
                            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>目前持倉</div>
                            {holdings.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--c-muted)', fontSize: '13px' }}>尚無持倉資料</div>
                            ) : (
                                <div style={{ overflowX: 'auto' }}>
                                    <table className="h-table">
                                        <thead>
                                            <tr>{['代號', '名稱', '股數', '均價', '現價', '未實現損益', '報酬率', '佔比', '族群'].map(h => <th key={h}>{h}</th>)}</tr>
                                        </thead>
                                        <tbody>
                                            {holdings.map(h => (
                                                <tr key={h.code}>
                                                    <td style={{ color: 'var(--c-accent)', fontWeight: 700 }}>{h.code}</td>
                                                    <td>{h.name}</td>
                                                    <td>{h.shares.toLocaleString()}</td>
                                                    <td>{h.avgCost.toFixed(2)}</td>
                                                    <td style={{ color: h.currentPrice === null ? 'var(--c-muted)' : h.currentPrice > h.avgCost ? 'var(--c-positive)' : 'var(--c-danger)', fontWeight: 600 }}>
                                                        {h.currentPrice === null ? '—' : h.currentPrice.toFixed(2)}
                                                    </td>
                                                    <td style={{ color: h.currentPrice === null ? 'var(--c-muted)' : pnlColor(h.unrealizedPnL), fontWeight: 600 }}>
                                                        {h.currentPrice === null ? '—' : `${h.unrealizedPnL >= 0 ? '+' : ''}${h.unrealizedPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`}
                                                    </td>
                                                    <td>
                                                        {h.currentPrice === null
                                                            ? <span style={{ color: 'var(--c-muted)', fontSize: '12px' }}>點「更新現價」</span>
                                                            : <span style={{ backgroundColor: h.returnRate >= 0 ? 'color-mix(in srgb, var(--c-positive) 12%, transparent)' : 'color-mix(in srgb, var(--c-danger) 12%, transparent)', color: pnlColor(h.returnRate), padding: '2px 8px', borderRadius: '20px', fontSize: '12px', fontWeight: 600 }}>
                                                                {h.returnRate >= 0 ? '+' : ''}{h.returnRate.toFixed(2)}%
                                                            </span>
                                                        }
                                                    </td>
                                                    <td style={{ color: 'var(--c-muted)' }}>{h.ratio.toFixed(1)}%</td>
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
                                        <Calendar size={15} color="var(--c-accent)" />
                                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>近 14 天行程</span>
                                    </div>
                                    <button onClick={() => navigate('/calendar')}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-accent)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        <ExternalLink size={12} />前往月曆
                                    </button>
                                </div>

                                {upcomingEvents.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--c-muted)', fontSize: '13px' }}>近 14 天無行程</div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '300px', overflowY: 'auto' }}>
                                        {upcomingEvents.map(ev => {
                                            const isToday = ev.date === todayStr
                                            return (
                                                <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', backgroundColor: 'var(--c-bg)', borderRadius: '8px', borderLeft: `3px solid ${isToday ? 'var(--c-warning)' : 'var(--c-accent)'}` }}>
                                                    <div style={{ flex: 1, minWidth: 0 }}>
                                                        <div style={{ fontSize: '13px', color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</div>
                                                        <div style={{ fontSize: '11px', color: isToday ? 'var(--c-warning)' : 'var(--c-accent)', marginTop: '2px' }}>{formatEventDate(ev.date)}</div>
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
                                        <CheckSquare size={15} color="var(--c-positive)" />
                                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>待辦任務</span>
                                        {tasks.length > 0 && (
                                            <span style={{ backgroundColor: 'color-mix(in srgb, var(--c-positive) 15%, transparent)', color: 'var(--c-positive)', borderRadius: '20px', padding: '1px 8px', fontSize: '11px', fontWeight: 600 }}>
                                                {tasks.length}
                                            </span>
                                        )}
                                    </div>
                                    <button onClick={() => navigate('/calendar/tasks')}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-positive)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        <ExternalLink size={12} />任務管理
                                    </button>
                                </div>

                                {tasks.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--c-muted)', fontSize: '13px' }}>🎉 沒有待辦任務！</div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '300px', overflowY: 'auto' }}>
                                        {overdueTasks.length > 0 && (
                                            <>
                                                <div style={{ fontSize: '11px', color: 'var(--c-danger)', fontWeight: 600, padding: '4px 0 2px' }}>⚠️ 逾期</div>
                                                {overdueTasks.map(t => <TaskRow key={t.id} task={t} todayStr={todayStr} />)}
                                            </>
                                        )}
                                        {todayTasks.length > 0 && (
                                            <>
                                                <div style={{ fontSize: '11px', color: 'var(--c-warning)', fontWeight: 600, padding: '4px 0 2px' }}>今日到期</div>
                                                {todayTasks.map(t => <TaskRow key={t.id} task={t} todayStr={todayStr} />)}
                                            </>
                                        )}
                                        {futureTasks.length > 0 && (
                                            <>
                                                {(overdueTasks.length > 0 || todayTasks.length > 0) && (
                                                    <div style={{ fontSize: '11px', color: 'var(--c-muted)', fontWeight: 600, padding: '4px 0 2px' }}>其他</div>
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
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', backgroundColor: 'var(--c-bg)', borderRadius: '8px', cursor: 'pointer' }}
            onClick={() => navigate('/calendar/tasks')}
            title="點擊前往任務管理頁面"
        >
            <div style={{ width: '16px', height: '16px', border: `1.5px solid ${PRIORITY_COLORS[task.priority]}`, borderRadius: '4px', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: '13px', color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
            <div style={{ display: 'flex', gap: '4px', flexShrink: 0, alignItems: 'center' }}>
                {task.dueDate && (
                    <span style={{ fontSize: '11px', color: isOverdue ? 'var(--c-danger)' : 'var(--c-muted)' }}>
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