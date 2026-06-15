import { useState, useEffect, useRef, useMemo } from 'react'
import { getDocs, orderBy, query, getDoc, updateDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { calcPositions, calcAvailableCash, calcReturnRate, simulateMarginBuy, aggregateMarginPositions, type TradeRecord, type DividendRecord } from '../../lib/calc'
// ✅ 1-2：共用 UI 樣式與損益顏色
import { card } from '../../ui/styles'
import { pnlColor } from '../../ui/format'
import { DollarSign, BarChart2, RefreshCw, Calendar, CheckSquare, ExternalLink, Tag, TrendingDown } from 'lucide-react'
import { PieChart, Pie, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { useNavigate } from 'react-router-dom'
import { usePrices } from '../../PriceContext'
import { fetchTrades, fetchDividends, fetchCashflow } from '../../lib/investData'
import { maybeAutoSnapshotToday } from '../../lib/snapshot'
import InfoHint from '../../components/InfoHint'

const COLORS = ['var(--c-accent)', 'var(--c-positive)', 'var(--c-warning)', 'var(--c-danger)', 'var(--c-purple)', '#34d399', '#fb923c', '#60a5fa', '#f472b6', '#facc15', '#38bdf8', '#4ade80']
const CASH_COLOR = 'var(--c-muted)'

interface HoldingItem {
    code: string
    name: string
    shares: number
    avgCost: number
    totalCost: number
    marginAmount: number   // ✅ 新增：融資借款金額（0 = 現股）
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

// ── 賣出追蹤通知預設值（實際值由 settings/soldAlert 讀取，與賣出追蹤頁共用）──
const DEFAULT_SOLD_WATCH_DAYS = 14
const DEFAULT_SOLD_RISE_THRESHOLD = 10  // %

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
                <span style={{ color: 'var(--c-purple)', fontWeight: 600 }}>{pct}%</span>
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
    // ✅ 3-1：行程/任務側卡獨立載入狀態，不擋核心指標渲染
    const [sideLoading, setSideLoading] = useState(true)
    const [lastUpdated, setLastUpdated] = useState('')
    const [hasPrice, setHasPrice] = useState(false)
    const [stockGroups, setStockGroups] = useState<Record<string, string>>({})
    const [sortMode, setSortMode] = useState<'marketValue' | 'group' | 'returnRate' | 'code' | 'unrealizedPnL'>('group')
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
    // 賣出追蹤通知設定（與賣出追蹤頁共用 settings/soldAlert）
    const [soldAlertCfg, setSoldAlertCfg] = useState({ watchDays: DEFAULT_SOLD_WATCH_DAYS, riseThreshold: DEFAULT_SOLD_RISE_THRESHOLD })
    // sell trades 快取，供 updatePrices 掃描通知用（不重複讀 Firebase）
    const [sellTradesCache, setSellTradesCache] = useState<Array<{ date: string; code: string; name: string; price: number; shares: number }>>([])

    // 融資加碼試算 state
    const [simOpen, setSimOpen] = useState(false)
    const [simPrice, setSimPrice] = useState('')
    const [simShares, setSimShares] = useState('')
    const [simRatio, setSimRatio] = useState('0.6')

    // ✅ 優化：單一 Promise.all 並行抓取所有資料，消除串行等待
    // ✅ 3-1：載入瘦身——核心資料（持倉/現金/融資/賣出追蹤）獨立載入、先到先渲染；
    //    行事曆/任務側卡由 loadSideCards 平行延後載入，感知載入時間約減半。
    const loadCore = async () => {
        setLoading(true)
        try {
            const [
                trades, dividends, cashRecords,
                priceDoc, groupDoc, soldCfgDoc,
            ] = await Promise.all([
                // ✅ 1-1：改走共用快取層（lib/investData），多頁共用同一份資料
                fetchTrades<TradeRecord>('asc'),
                fetchDividends<DividendRecord>('asc'),
                fetchCashflow<CashRecord>('asc'),
                getDoc(userDocNested(investDB, 'settings', 'lastPrices')),
                getDoc(userDocNested(investDB, 'settings', 'stockGroups')),
                getDoc(userDocNested(investDB, 'settings', 'soldAlert')),
            ])

            // 賣出追蹤通知設定（與賣出追蹤頁共用同一份）
            const soldCfg = {
                watchDays: DEFAULT_SOLD_WATCH_DAYS,
                riseThreshold: DEFAULT_SOLD_RISE_THRESHOLD,
                ...(soldCfgDoc.exists() ? soldCfgDoc.data() : {}),
            }
            setSoldAlertCfg({ watchDays: soldCfg.watchDays, riseThreshold: soldCfg.riseThreshold })

            // 快取賣出紀錄（日期在觀察天數內），供 updatePrices 掃描通知
            const sellCache = trades
                .filter(t => t.type === 'sell')
                .map(t => ({ date: t.date, code: t.code, name: t.name, price: t.price, shares: t.shares }))
                .filter(t => {
                    const d = Math.floor((Date.now() - new Date(t.date).getTime()) / 86400000)
                    return d <= soldCfg.watchDays
                })
            setSellTradesCache(sellCache)

            const { holdings: positions, realized } = calcPositions(trades, dividends)
            setRealizedPnL(realized.reduce((s, r) => s + r.realized, 0))

            const savedPrices: Record<string, number | string> = priceDoc.exists() ? priceDoc.data() : {}
            const savedAt = typeof savedPrices._updatedAt === 'string' ? savedPrices._updatedAt : ''

            const groups: Record<string, string> = groupDoc.exists() ? groupDoc.data() : {}
            setStockGroups(groups)

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
                const marginAmount = pos.marginAmount ?? 0
                // ✅ 融資用自備款為分母，現股用全額成本
                const returnRate = calcReturnRate(unrealizedPnL, pos.totalCost, marginAmount)
                totalMarketValue += marketValue
                return { ...pos, marginAmount, currentPrice, marketValue, unrealizedPnL, returnRate, ratio: 0 }
            })

            holdingList.forEach(h => {
                h.ratio = totalMarketValue > 0 ? (h.marketValue / totalMarketValue) * 100 : 0
            })
            holdingList.sort((a, b) => b.marketValue - a.marketValue)

            setHoldings(holdingList)
            // ✅ Bug 修正：傳 false。本系統的賣出 total（收付金額）記的是「已扣除歸還券商借款後的
            //   淨入帳金額」，calcAvailableCash 直接 + sellTotal 即為正確可用現金。
            //   若傳 true 會再扣一次 calcMarginRepaid（借款本金），導致融資賣出後現金被低估。
            // ✅ 方案 A：可用現金含現金股利（與 calcAvailableCash 的全系統口徑一致）
            setTotalCash(calcAvailableCash(cashRecords, trades, dividends))
            setHasPrice(priceAvailable)
            // ✅ 修正：優先用 PriceContext 的最後更新時間，再 fallback Firebase savedAt
            if (ctxLastUpdated) setLastUpdated(ctxLastUpdated)
            else if (savedAt) setLastUpdated(savedAt)

            // ── 計算融資部位（集中於 calc.ts，與資產趨勢頁口徑一致）──
            const activeMargin: MarginPosition[] = aggregateMarginPositions(trades).map(m => ({
                code: m.code, name: m.name, shares: m.shares,
                marginAmount: m.marginAmount, marginCost: m.marginCost,
            }))
            setMarginPositions(activeMargin)
        } catch (err) { console.error(err) }
        finally { setLoading(false) }
        // ✅ 5-1：核心資料就緒後嘗試自動快照（fire-and-forget，規則見 lib/snapshot.ts：
        //    同日只寫一次、不覆蓋手動快照、現價須為今日、缺價跳過）
        void maybeAutoSnapshotToday()
    }

    // ✅ 3-1：行程/任務側卡——與核心資料平行載入，慢了也不擋主畫面
    const loadSideCards = async () => {
        setSideLoading(true)
        try {
            const todayStr_ = new Date().toISOString().split('T')[0]
            const future14Str = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]
            const [eventsSnap, tasksSnap] = await Promise.all([
                getDocs(userCol(investDB, 'calendarEvents')),
                getDocs(query(userCol(investDB, 'tasks'), orderBy('order', 'asc'))),
            ])
            // 行事曆事件
            const calEvents: CalendarEvent[] = eventsSnap.docs
                .map(d => ({ id: d.id, ...d.data() } as CalendarEvent))
                .filter(e => e.date >= todayStr_ && e.date <= future14Str)
                .sort((a, b) => a.date.localeCompare(b.date))
            setUpcomingEvents(calEvents)
            // 待辦任務
            const allTasks = tasksSnap.docs.map(d => ({ id: d.id, ...d.data() } as Task))
            setTasks(allTasks.filter(t => !t.done))
        } catch (err) { console.error(err) }
        finally { setSideLoading(false) }
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
            // ✅ 融資用自備款為分母，現股用全額成本
            const returnRate = calcReturnRate(unrealizedPnL, h.totalCost, h.marginAmount)
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
                return pct >= soldAlertCfg.riseThreshold
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

        // ✅ 5-1：現價剛寫回 lastPrices（_updatedAt 為今日），是自動快照最準的時機
        void maybeAutoSnapshotToday()
    }

    // ✅ 優化：直接呼叫，移除不必要的 setTimeout 延遲
    useEffect(() => {
        void loadCore()
        void loadSideCards()
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
        void loadCore()
        void loadSideCards()
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

    // ── 倉位百分比 = 股票市值 ÷ 自有資金（槓桿後曝險）──
    // 自有資金（equity）= 總資產 − 融資借款，反映真正投入的本金
    // 無融資時分母 = 總資產，倉位% 退化為單純的持股佔比
    const equityCapital = totalAssets - totalMarginDebt
    const positionPct = equityCapital > 0 ? (totalMarketValue / equityCapital) * 100 : null

    // 淨資產 = 市值 + 現金 − 融資借款（負債）。與資產趨勢、年度回顧快照口徑一致。
    // 註：totalAssets（毛額）仍用於圓餅圖佔比與維持率分母，故兩者並存。
    const netAssets = totalAssets - totalMarginDebt

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
    // ✅ 3-3：依賴 holdings/totalCash 的衍生值包 useMemo，
    //    避免試算表單輸入等無關 state 變動時每次 render 重算
    const pieData: PieEntry[] = useMemo(() => [
        ...holdings.map((h, i) => ({
            name: `${h.code} ${h.name}`,
            value: h.marketValue,
            fill: COLORS[i % COLORS.length]
        })),
        ...(totalCash > 0 ? [{ name: '現金', value: totalCash, fill: CASH_COLOR }] : [])
    ], [holdings, totalCash])

    // 族群圓餅圖 — 依 stockGroups 彙總市值（✅ 3-3：useMemo）
    const groupPieData: PieEntry[] = useMemo(() => {
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
        // 族群佔比不含現金
        if (ungroupedValue > 0) groupMap['未分類'] = (groupMap['未分類'] || 0) + ungroupedValue

        return Object.entries(groupMap)
            .sort((a, b) => b[1] - a[1])
            .map(([name, value], i) => ({
                name,
                value,
                fill: name === '現金' ? CASH_COLOR : name === '未分類' ? 'var(--c-dim)' : COLORS[i % COLORS.length]
            }))
    }, [holdings, stockGroups])

    // 未分類市值合計（族群圓餅圖下方提示文案用；計算口徑與 groupPieData 內一致）
    const ungroupedValue = useMemo(
        () => holdings.reduce((s, h) => s + (stockGroups[h.code] ? 0 : h.marketValue), 0),
        [holdings, stockGroups]
    )

    const hasAnyGroup = Object.keys(stockGroups).length > 0

    // ── 目前持倉表格排序（✅ 3-3：useMemo）──
    // 依族群模式：先依「族群總市值」大到小排族群，未分類排最後；同族群內再依個股市值大到小
    const sortedHoldings = useMemo(() => {
        const groupTotalMV: Record<string, number> = {}
        holdings.forEach(h => {
            const g = stockGroups[h.code] || '__未分類__'
            groupTotalMV[g] = (groupTotalMV[g] || 0) + h.marketValue
        })
        return [...holdings].sort((a, b) => {
            switch (sortMode) {
                case 'group': {
                    const ga = stockGroups[a.code] || '__未分類__'
                    const gb = stockGroups[b.code] || '__未分類__'
                    if (ga !== gb) {
                        // 未分類永遠排最後
                        if (ga === '__未分類__') return 1
                        if (gb === '__未分類__') return -1
                        const diff = (groupTotalMV[gb] || 0) - (groupTotalMV[ga] || 0)
                        if (diff !== 0) return diff
                        return ga.localeCompare(gb, 'zh-TW') // 族群總市值相同時依名稱
                    }
                    return b.marketValue - a.marketValue // 同族群內依市值
                }
                case 'returnRate':
                    return b.returnRate - a.returnRate
                case 'unrealizedPnL':
                    return b.unrealizedPnL - a.unrealizedPnL
                case 'code':
                    return a.code.localeCompare(b.code, 'zh-TW')
                case 'marketValue':
                default:
                    return b.marketValue - a.marketValue
            }
        })
    }, [holdings, stockGroups, sortMode])

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
        .dash-side-cards { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 16px; }
        .dash-side-cards > * { flex: 1 1 360px; min-width: 0; }
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
                                    · {soldAlertCfg.watchDays} 天內賣出，現價漲超 {soldAlertCfg.riseThreshold}%
                                </span>
                            </div>
                            <span style={{ fontSize: '11px', color: 'var(--c-accent)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                查看詳情 →
                            </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '6px' }}>
                            {soldAlerts.map(a => (
                                <div key={a.code + a.date} style={{
                                    display: 'flex', alignItems: 'center', gap: '10px',
                                    backgroundColor: 'var(--c-card)', borderRadius: '8px', padding: '8px 14px',
                                    border: '1px solid color-mix(in srgb, var(--c-danger) 20%, transparent)',
                                }}>
                                    <span style={{ fontWeight: 700, color: 'var(--c-accent)', fontSize: '14px', minWidth: '46px' }}>{a.code}</span>
                                    <span style={{ fontSize: '12px', color: 'var(--c-text)', minWidth: '48px' }}>{a.name}</span>
                                    <span style={{ fontSize: '11px', color: 'var(--c-muted)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {a.date} · {a.soldPrice} → {a.currentPrice.toFixed(2)}
                                    </span>
                                    <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--c-danger)', minWidth: '64px', textAlign: 'right' }}>
                                        +{a.changePct.toFixed(2)}%
                                    </span>
                                    <span style={{ fontSize: '12px', color: 'var(--c-danger)', fontWeight: 600, minWidth: '92px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                        +{a.opportunityCost.toLocaleString()}
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
                                { label: '總資產', value: `$${netAssets.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: 'var(--c-accent)', icon: DollarSign },
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
                                    <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px', display: 'flex', alignItems: 'center' }}>
                                        {label}
                                        {label === unrealizedLabel && <InfoHint text="（現價 − 平均成本）× 股數。平均成本為移動平均、含手續費並經配股攤薄。下方表格的個股報酬率對融資部位改以自備款為分母。" />}
                                        {label === '已實現損益' && <InfoHint text="賣出價 − 賣出當時的移動平均成本（含配股攤薄），與歷史損益頁口徑一致；年度回顧的 XIRR 為另一種口徑，數字不同屬正常。" />}
                                    </div>
                                    <div style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 700, color }}>{value}</div>
                                </div>
                            ))}
                        </div>

                        {/* ── 倉位 / 融資維持率 並排卡片（手機自動換行）── */}
                        <div className="dash-side-cards">

                            {/* 倉位卡片 */}
                            <div style={{
                                ...card,
                                display: 'flex', flexDirection: 'column',
                                borderColor: positionPct !== null && positionPct > 100 ? 'rgba(245,166,35,0.4)' : 'var(--c-border)',
                                background: positionPct !== null && positionPct > 100
                                    ? 'linear-gradient(135deg, var(--c-sidebar) 0%, color-mix(in srgb, var(--c-warning) 5%, transparent) 100%)'
                                    : 'var(--c-sidebar)'
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                    <div style={{ width: '40px', height: '40px', borderRadius: '10px', backgroundColor: `${positionPct !== null && positionPct > 100 ? 'var(--c-warning)' : 'var(--c-accent)'}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                        <BarChart2 size={20} color={positionPct !== null && positionPct > 100 ? 'var(--c-warning)' : 'var(--c-accent)'} />
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '4px' }}>倉位百分比</div>
                                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                                            <span style={{ fontSize: 'clamp(22px, 3vw, 30px)', fontWeight: 700, color: positionPct !== null && positionPct > 100 ? 'var(--c-warning)' : 'var(--c-accent)', letterSpacing: '-0.5px' }}>
                                                {positionPct !== null ? `${positionPct.toFixed(1)}%` : '—'}
                                            </span>
                                            {hasMargin && positionPct !== null && (
                                                <span style={{ fontSize: '12px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px', backgroundColor: 'color-mix(in srgb, var(--c-warning) 12%, transparent)', color: 'var(--c-warning)' }}>
                                                    含槓桿
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginTop: '2px' }}>
                                            股票市值 ÷ 自有資金{!hasPrice ? '（以成本估算）' : ''}
                                        </div>
                                    </div>
                                </div>

                                {/* 資金分布堆疊條：現金 / 股票部位 / 槓桿部位 */}
                                {(() => {
                                    const cashVal = Math.max(totalCash, 0)
                                    // 槓桿部位 = 融資買進的股票市值（含自備款）
                                    const leverVal = marginStockMarketValue
                                    // 自有股票部位 = 全部股票市值 − 融資股票市值（互斥，避免重複計算）
                                    const ownStockVal = Math.max(totalMarketValue - leverVal, 0)
                                    const base = cashVal + ownStockVal + leverVal
                                    const pct = (v: number) => base > 0 ? (v / base) * 100 : 0
                                    const segs = [
                                        { label: '現金', value: cashVal, color: 'var(--c-warning)' },
                                        { label: '股票部位', value: ownStockVal, color: 'var(--c-positive)' },
                                        { label: '槓桿部位', value: leverVal, color: 'var(--c-purple)' },
                                    ]
                                    return (
                                        <div style={{ marginTop: '20px' }}>
                                            <div style={{ fontSize: '11px', lineHeight: '15px', color: 'var(--c-muted)', marginBottom: '6px' }}>資金分布</div>
                                            <div style={{ display: 'flex', height: '10px', borderRadius: '5px', overflow: 'hidden', backgroundColor: 'var(--c-bg)' }}>
                                                {segs.map(s => s.value > 0 && (
                                                    <div key={s.label} style={{ width: `${pct(s.value)}%`, backgroundColor: s.color, transition: 'width 0.4s ease' }} />
                                                ))}
                                            </div>
                                            {/* 圖例 */}
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '10px' }}>
                                                {segs.map(s => (
                                                    <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                        <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: s.color, flexShrink: 0 }} />
                                                        <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>{s.label}</span>
                                                        <span style={{ fontSize: '11px', color: 'var(--c-text)', fontWeight: 600 }}>{pct(s.value).toFixed(0)}%</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )
                                })()}

                                {/* 明細 */}
                                <div style={{ marginTop: 'auto', paddingTop: '16px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
                                    {[
                                        { label: '現金', value: Math.max(totalCash, 0), color: 'var(--c-warning)' },
                                        { label: '股票部位', value: Math.max(totalMarketValue - marginStockMarketValue, 0), color: 'var(--c-positive)' },
                                        { label: '槓桿部位', value: marginStockMarketValue, color: 'var(--c-purple)' },
                                    ].map(({ label, value, color }) => (
                                        <div key={label} style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '10px 12px' }}>
                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>{label}</div>
                                            <div style={{ fontSize: '14px', fontWeight: 600, color }}>${value.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* ── 融資維持率卡片（有融資部位才顯示）── */}
                            {hasMargin && (
                                <div style={{
                                    ...card,
                                    display: 'flex', flexDirection: 'column',
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
                                                <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--c-purple)' }}>{marginPositions.length} 檔</div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* 進度條 */}
                                    {marginRatioValue !== null && (
                                        <div style={{ marginTop: '20px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', lineHeight: '15px', color: 'var(--c-muted)', marginBottom: '6px' }}>
                                                <span>斷頭線 120%</span>
                                                <span>追繳線 130%</span>
                                                <span>安全線 160%</span>
                                                <span>目前 {marginRatioValue.toFixed(1)}%</span>
                                            </div>
                                            <div style={{ height: '10px', backgroundColor: 'var(--c-bg)', borderRadius: '5px', overflow: 'hidden', position: 'relative' }}>
                                                {/* 底層色帶 */}
                                                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, rgba(255,87,87,0.3) 0%, rgba(255,87,87,0.3) 20%, rgba(245,166,35,0.3) 20%, rgba(245,166,35,0.3) 40%, rgba(0,200,150,0.2) 40%, rgba(0,200,150,0.2) 100%)' }} />
                                                {/* 當前值指示 */}
                                                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.min(marginRatioValue / 250 * 100, 100)}%`, backgroundColor: marginRatioColor, borderRadius: '5px', transition: 'width 0.4s ease' }} />
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
                                                    <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--c-dim)' }}>輸入買入價格與股數後自動計算</div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                        {/* ── /倉位 + 融資 並排卡片 ── */}

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
                                                <Pie data={pieData} cx="50%" cy="50%" innerRadius={45} outerRadius={75} paddingAngle={2} dataKey="value" labelLine={false} label={renderCustomLabel}>
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
                                                style={{ background: 'none', border: 'none', color: 'var(--c-purple)', cursor: 'pointer', fontSize: '12px', padding: '0 4px', textDecoration: 'underline' }}>
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
                                                <Tooltip content={<GroupTooltip totalAssets={totalMarketValue} />} />
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
                                                        {totalMarketValue > 0 ? ((item.value / totalMarketValue) * 100).toFixed(1) : 0}%
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                        {ungroupedValue > 0 && (
                                            <div style={{ marginTop: '10px', padding: '6px 10px', backgroundColor: 'rgba(167,139,250,0.07)', borderRadius: '6px', fontSize: '11px', color: 'var(--c-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                <Tag size={11} color="var(--c-purple)" />
                                                有 {holdings.filter(h => !stockGroups[h.code]).length} 檔尚未設定族群，已歸入「未分類」
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>

                        {/* 目前持倉表格 */}
                        <div style={{ ...card, marginBottom: '0' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', gap: '8px', flexWrap: 'wrap' }}>
                                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>目前持倉</div>
                                <select
                                    value={sortMode}
                                    onChange={e => setSortMode(e.target.value as typeof sortMode)}
                                    style={{ backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '4px 8px', fontSize: '12px', cursor: 'pointer' }}
                                >
                                    <option value="marketValue">依市值</option>
                                    <option value="group">依族群</option>
                                    <option value="returnRate">依報酬率</option>
                                    <option value="unrealizedPnL">依未實現損益</option>
                                    <option value="code">依代號</option>
                                </select>
                            </div>
                            {holdings.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--c-muted)', fontSize: '13px' }}>尚無持倉資料</div>
                            ) : (
                                <div style={{ overflowX: 'auto' }}>
                                    <table className="h-table">
                                        <thead>
                                            <tr>{['代號', '名稱', '股數', '均價', '現價', '未實現損益', '報酬率', '佔比', '族群'].map(h => <th key={h}>{h}</th>)}</tr>
                                        </thead>
                                        <tbody>
                                            {sortedHoldings.map(h => (
                                                <tr key={h.code}>
                                                    <td style={{ color: 'var(--c-accent)', fontWeight: 700 }}>{h.code}</td>
                                                    <td>
                                                        {h.name}
                                                        {/* ✅ 融資標籤 */}
                                                        {h.marginAmount > 0 && (
                                                            <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--c-warning)', backgroundColor: 'rgba(245,166,35,0.12)', padding: '1px 5px', borderRadius: '4px', fontWeight: 600 }}>
                                                                融資
                                                            </span>
                                                        )}
                                                    </td>
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
                                                            : <span
                                                                style={{ backgroundColor: h.returnRate >= 0 ? 'color-mix(in srgb, var(--c-positive) 12%, transparent)' : 'color-mix(in srgb, var(--c-danger) 12%, transparent)', color: pnlColor(h.returnRate), padding: '2px 8px', borderRadius: '20px', fontSize: '12px', fontWeight: 600 }}
                                                                title={h.marginAmount > 0 ? `融資損益率（以自備款 $${(h.totalCost - h.marginAmount).toLocaleString()} 為基準）` : '現股損益率'}
                                                            >
                                                                {h.returnRate >= 0 ? '+' : ''}{h.returnRate.toFixed(2)}%
                                                            </span>
                                                        }
                                                    </td>
                                                    <td style={{ color: 'var(--c-muted)' }}>{h.ratio.toFixed(1)}%</td>
                                                    <td>
                                                        {stockGroups[h.code] ? (
                                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--c-purple)', backgroundColor: 'rgba(167,139,250,0.12)', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>
                                                                <Tag size={10} />
                                                                {stockGroups[h.code]}
                                                            </span>
                                                        ) : (
                                                            <span style={{ fontSize: '12px', color: 'var(--c-dim)' }}>—</span>
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

                                {sideLoading ? (
                                    <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--c-muted)', fontSize: '13px' }}>載入中…</div>
                                ) : upcomingEvents.length === 0 ? (
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

                                {sideLoading ? (
                                    <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--c-muted)', fontSize: '13px' }}>載入中…</div>
                                ) : tasks.length === 0 ? (
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