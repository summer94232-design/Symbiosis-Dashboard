import LoadingState from '../../components/LoadingState'
import { useState, useEffect, useRef, useMemo } from 'react'
import { getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { captureUserSession, userDocNested } from '../../lib/userDB'
import { calcGrossAmount, calcHoldingValuation, calcPositionAdjustment, simulateMarginBuy } from '../../lib/calc'
// ✅ 1-2：共用 UI 樣式與損益顏色
import { card } from '../../ui/styles'
import { pnlColor } from '../../ui/format'
import { DollarSign, BarChart2, RefreshCw, Calendar, CheckSquare, ExternalLink, Tag, TrendingDown, ChevronDown, ChevronUp, Calculator, AlertTriangle, X } from 'lucide-react'
import { PieChart, Pie, Tooltip, ResponsiveContainer, Cell, type PieLabelRenderProps } from 'recharts'
import { useNavigate } from 'react-router-dom'
import { usePrices, PriceRefreshStatus } from '../../PriceContext'
import { loadPortfolioSnapshot, type PortfolioHoldingGroup } from '../../lib/portfolioSnapshot'
import HoldingFundingBadge from '../../components/HoldingFundingBadge'
import { useInvestSync, InvestSyncStatus } from '../../InvestSyncContext'
import { formatAutoSnapshotFeedback, maybeAutoSnapshotToday, type AutoSnapshotResult } from '../../lib/snapshot'
import { toLocalDateString } from '../../lib/date'
import InfoHint from '../../components/InfoHint'
import DividendFeedStatus from '../../components/DividendFeedStatus'
import MarketReportButton from '../../components/MarketReportButton'
import ActionNotice, { type ActionNoticeState } from '../../components/ActionNotice'
import { fetchCalendarEventsInRange, fetchOpenTasks } from '../../lib/plannerData'
import { eventOverlapsRange, type EventTiming } from '../../lib/calendarTiming'
import { syncYahooInvestorMeetings } from '../../lib/investorMeetings'
import { DEFAULT_MARGIN_RULES, loadMarginRules } from '../../lib/marginSettings'


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

interface CalendarEvent extends EventTiming {
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

type DashboardSectionKey = 'risk' | 'allocation' | 'holdings' | 'planner'

const DASHBOARD_SECTIONS: Array<{ key: DashboardSectionKey; id: string; label: string }> = [
    { key: 'risk', id: 'dashboard-risk', label: '資金與風險' },
    { key: 'allocation', id: 'dashboard-allocation', label: '資產分布' },
    { key: 'holdings', id: 'dashboard-holdings', label: '目前持倉' },
    { key: 'planner', id: 'dashboard-planner', label: '行程任務' },
]

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
function renderCustomLabel({ cx = 0, cy = 0, midAngle = 0, innerRadius = 0, outerRadius = 0, percent = 0 }: PieLabelRenderProps) {
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
interface PortfolioTooltipProps {
    active?: boolean
    payload?: readonly { name?: string | number; value?: number; payload?: { fill?: string } }[]
    totalAssets: number
}
function AssetTooltip({ active, payload, totalAssets }: PortfolioTooltipProps) {
    if (!active || !payload?.length) return null
    const { name, value = 0, payload: { fill } = {} } = payload[0]
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
function GroupTooltip({ active, payload, totalAssets }: PortfolioTooltipProps) {
    if (!active || !payload?.length) return null
    const { name, value = 0, payload: { fill } = {} } = payload[0]
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
    const { prices: ctxPrices, priceErrors, lastUpdated: ctxLastUpdated, priceLoading, refreshProgress, updatePrices: ctxUpdatePrices, loadCachedPrices } = usePrices()
    const { version: syncVersion } = useInvestSync()

    const [storedHoldings, setHoldings] = useState<HoldingItem[]>([])
    const [storedHoldingGroups, setHoldingGroups] = useState<PortfolioHoldingGroup[]>([])
    const holdingGroups = useMemo(() => {
        const rows = storedHoldingGroups.map(h => Object.hasOwn(ctxPrices, h.code) ? { ...h, ...calcHoldingValuation(h, ctxPrices[h.code]) } : h)
        const total = rows.reduce((sum, h) => sum + h.marketValue, 0)
        return rows.map(h => ({ ...h, ratio: total > 0 ? h.marketValue / total * 100 : 0 }))
    }, [storedHoldingGroups, ctxPrices])
    const holdings = useMemo(() => {
        const rows = storedHoldings.map(h => Object.hasOwn(ctxPrices, h.code) ? { ...h, ...calcHoldingValuation(h, ctxPrices[h.code]) } : h)
        const total = rows.reduce((sum, h) => sum + h.marketValue, 0)
        return rows.map(h => ({ ...h, ratio: total > 0 ? h.marketValue / total * 100 : 0 }))
    }, [storedHoldings, ctxPrices])
    const [totalCash, setTotalCash] = useState(0)
    const [realizedPnL, setRealizedPnL] = useState(0)
    const [loading, setLoading] = useState(true)
    const [hasLoaded, setHasLoaded] = useState(false)
    const [marginRules, setMarginRules] = useState(DEFAULT_MARGIN_RULES)
    const [syncingInvestorMeetings, setSyncingInvestorMeetings] = useState(false)
    // ✅ 3-1：行程/任務側卡獨立載入狀態，不擋核心指標渲染
    const [sideLoading, setSideLoading] = useState(true)
    const hasPrice = holdings.some(h => h.currentPrice !== null)
    const [stockGroups, setStockGroups] = useState<Record<string, string>>({})
    const [sortMode, setSortMode] = useState<'marketValue' | 'group' | 'returnRate' | 'code' | 'unrealizedPnL'>('group')
    const [expandedHoldingCode, setExpandedHoldingCode] = useState<string | null>(null)
    const [notice, setNotice] = useState<ActionNoticeState | null>(null)
    const priceRefreshGeneration = useRef(0)
    const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [valuationNoticeVisible, setValuationNoticeVisible] = useState(false)

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
    // 賣出追蹤通知設定（與賣出追蹤頁共用 settings/soldAlert）
    const [soldAlertCfg, setSoldAlertCfg] = useState({ watchDays: DEFAULT_SOLD_WATCH_DAYS, riseThreshold: DEFAULT_SOLD_RISE_THRESHOLD })
    // sell trades 快取，供 updatePrices 掃描通知用（不重複讀 Firebase）
    const [sellTradesCache, setSellTradesCache] = useState<Array<{ date: string; code: string; name: string; price: number; shares: number }>>([])
    const soldAlerts: SoldAlert[] = useMemo(() => sellTradesCache.flatMap(trade => {
        const currentPrice = ctxPrices[trade.code]
        if (currentPrice == null || trade.price <= 0) return []
        const changePct = (currentPrice - trade.price) / trade.price * 100
        return changePct >= soldAlertCfg.riseThreshold ? [{
            code: trade.code, name: trade.name, date: trade.date, soldPrice: trade.price, shares: trade.shares,
            currentPrice, changePct, opportunityCost: Math.round((currentPrice - trade.price) * trade.shares),
        }] : []
    }).sort((a, b) => b.changePct - a.changePct), [sellTradesCache, ctxPrices, soldAlertCfg.riseThreshold])

    // 融資加碼試算 state
    const [simOpen, setSimOpen] = useState(false)
    const [simPrice, setSimPrice] = useState('')
    const [simShares, setSimShares] = useState('')
    const [simRatio, setSimRatio] = useState('0.6')
    // 倉位水位試算（只存在本機畫面，不寫入資料庫）
    const [targetPositionPct, setTargetPositionPct] = useState('')
    const [adjustmentCode, setAdjustmentCode] = useState('')
    const [adjustmentPrice, setAdjustmentPrice] = useState('')

    useEffect(() => { void loadMarginRules().then(setMarginRules) }, [])

    const showNotice = (next: ActionNoticeState) => {
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
        setNotice(next)
        // 成功／一般提示自動收合；錯誤持續保留到使用者手動關閉。
        if (next.type !== 'error') noticeTimerRef.current = setTimeout(() => setNotice(null), 4200)
    }

    const scrollToDashboardSection = (id: string) => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    const topbarRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const topbar = topbarRef.current
        if (!topbar) return
        const update = () => topbar.parentElement?.style.setProperty('--dashboard-sticky-height', `${topbar.getBoundingClientRect().height}px`)
        update()
        const observer = new ResizeObserver(update)
        observer.observe(topbar)
        return () => observer.disconnect()
    }, [])

    // ✅ 優化：單一 Promise.all 並行抓取所有資料，消除串行等待
    // ✅ 3-1：載入瘦身——核心資料（持倉/現金/融資/賣出追蹤）獨立載入、先到先渲染；
    //    行事曆/任務側卡由 loadSideCards 平行延後載入，感知載入時間約減半。
    const loadCore = async () => {
        setLoading(true)
        try {
            const [snapshot, groupDoc, soldCfgDoc] = await Promise.all([
                loadPortfolioSnapshot(ctxPrices),
                getDoc(userDocNested(investDB, 'settings', 'stockGroups')),
                getDoc(userDocNested(investDB, 'settings', 'soldAlert')),
            ])
            const trades = snapshot.trades

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

            setRealizedPnL(snapshot.realizedPnL)
            loadCachedPrices(snapshot.savedPriceData, snapshot.priceUpdatedAt)

            const groups: Record<string, string> = groupDoc.exists() ? groupDoc.data() : {}
            setStockGroups(groups)

            const holdingList: HoldingItem[] = snapshot.holdings.map(holding => ({
                code: holding.code, name: holding.name, shares: holding.shares,
                avgCost: holding.avgCost, totalCost: holding.totalCost,
                marginAmount: holding.marginAmount, currentPrice: holding.currentPrice,
                marketValue: holding.marketValue, unrealizedPnL: holding.unrealizedPnL,
                returnRate: holding.returnRate, ratio: holding.ratio,
            }))

            setHoldings(holdingList)
            setHoldingGroups(snapshot.holdingGroups)
            // ✅ Bug 修正：傳 false。本系統的賣出 total（收付金額）記的是「已扣除歸還券商借款後的
            //   淨入帳金額」，calcAvailableCash 直接 + sellTotal 即為正確可用現金。
            //   若傳 true 會再扣一次 calcMarginRepaid（借款本金），導致融資賣出後現金被低估。
            // ✅ 方案 A：可用現金含現金股利（與 calcAvailableCash 的全系統口徑一致）
            setTotalCash(snapshot.cash)
            setHasLoaded(true)

            // ── 計算融資部位（集中於 calc.ts，與資產趨勢頁口徑一致）──
            const activeMargin: MarginPosition[] = snapshot.marginPositions.map(m => ({
                code: m.code, name: m.name, shares: m.shares,
                marginAmount: m.marginAmount, marginCost: m.marginCost,
            }))
            setMarginPositions(activeMargin)
        } catch (err) {
            console.error(err)
            showNotice({ type: 'error', message: '資料載入失敗，請確認網路後再試一次。' })
        }
        finally { setLoading(false) }
        // ✅ 5-1：核心資料就緒後嘗試自動快照（fire-and-forget，規則見 lib/snapshot.ts：
        //    同日只寫一次、不覆蓋手動快照、現價須為今日、缺價跳過）
        void maybeAutoSnapshotToday()
    }

    // ✅ 3-1：行程/任務側卡——與核心資料平行載入，慢了也不擋主畫面
    const loadSideCards = async () => {
        setSideLoading(true)
        try {
            const todayStr_ = toLocalDateString()
            const future14Str = toLocalDateString(new Date(Date.now() + 14 * 86400000))
            const [eventRows, taskRows] = await Promise.all([
                fetchCalendarEventsInRange<CalendarEvent>(todayStr_, future14Str),
                fetchOpenTasks<Task>(),
            ])
            // 行事曆事件
            const calEvents: CalendarEvent[] = eventRows
                .filter(e => eventOverlapsRange(e, todayStr_, future14Str))
                .sort((a, b) => a.date.localeCompare(b.date))
            setUpcomingEvents(calEvents)
            // 待辦任務
            const allTasks = taskRows
            setTasks(allTasks.filter(t => !t.done))
        } catch (err) { console.error(err) }
        finally { setSideLoading(false) }
    }


    // ✅ 修正：委託 PriceContext 更新，結果自動同步到 Holdings、Watchlist 等所有頁面
    const updatePrices = async () => {
        if (priceLoading) return
        const generation = ++priceRefreshGeneration.current
        const session = captureUserSession()
        const meetingSync = !syncingInvestorMeetings ? syncYahooInvestorMeetings().then(
            result => ({ result }), () => ({ result: null }),
        ) : null
        if (meetingSync) setSyncingInvestorMeetings(true)
        let symbols = [...new Set([...holdings.map(h => h.code), ...sellTradesCache.map(t => t.code)])]
        let snapshotResult: AutoSnapshotResult | null = null
        let priceFeedback: ActionNoticeState | null = null
        let meetingFeedback: ActionNoticeState | null = null
        const publishFeedback = () => {
            try { session.assertActive() } catch { return }
            if (!priceFeedback || priceRefreshGeneration.current !== generation) return
            const snapshotFeedback = snapshotResult ? formatAutoSnapshotFeedback(snapshotResult) : null
            showNotice({
                type: priceFeedback.type === 'error' || snapshotFeedback?.type === 'error' ? 'error'
                    : priceFeedback.type === 'info' || snapshotFeedback?.type === 'info' || meetingFeedback?.type === 'info' ? 'info' : 'success',
                message: [priceFeedback.message, snapshotFeedback?.message, meetingFeedback?.message].filter(Boolean).join(' '),
            })
        }
        const quotes = await ctxUpdatePrices(symbols, {
            onSnapshot: result => { snapshotResult = result; publishFeedback() },
        })
        try { session.assertActive() } catch { return }
        symbols = Object.keys(quotes)
        const updatedCount = symbols.filter(code => typeof quotes[code] === 'number' && (quotes[code] as number) > 0).length
        priceFeedback = symbols.length === 0 || updatedCount === 0
            ? { type: 'error', message: '這次未取得有效現價，請查看報價提示後再試。' }
            : updatedCount < symbols.length
                ? { type: 'info', message: `已更新 ${updatedCount} 檔，另有 ${symbols.length - updatedCount} 檔暫時無報價。` }
                : { type: 'success', message: `已更新 ${updatedCount} 檔股票現價。` }
        publishFeedback()
        session.assertActive()
        let totalMarketValue = 0
        const updated: HoldingItem[] = holdings.map(h => {
            const valuation = calcHoldingValuation(h, quotes[h.code])
            totalMarketValue += valuation.marketValue
            return { ...h, ...valuation }
        })
        updated.forEach(h => { h.ratio = totalMarketValue > 0 ? (h.marketValue / totalMarketValue) * 100 : 0 })
        updated.sort((a, b) => b.marketValue - a.marketValue)
        setHoldings(updated)
        // Quote completion does not wait for the independent meeting refresh.
        if (meetingSync) void meetingSync.then(({ result }) => {
            session.assertActive()
            setSyncingInvestorMeetings(false)
            meetingFeedback = !result
                ? { type: 'info', message: '法說會暫時無法同步。' }
                : result.fetched === 0
                    ? { type: 'info', message: '法說會目前沒有可更新資料。' }
                    : { type: 'success', message: result.changedGroups > 0 ? `法說會已同步，更新 ${result.changedGroups} 組資料。` : '法說會已同步，沒有新異動。' }
            publishFeedback()
        }).catch(() => {})
    }

    // ✅ 優化：直接呼叫，移除不必要的 setTimeout 延遲
    useEffect(() => {
        void loadCore()
        void loadSideCards()
        return () => {
            if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [syncVersion])

    const totalMarketValue = holdings.reduce((s, h) => s + h.marketValue, 0)
    const totalCost = holdings.reduce((s, h) => s + h.totalCost, 0)
    const totalAssets = totalMarketValue + totalCash

    const holdingsWithPrice = holdings.filter(h => h.currentPrice !== null)
    const holdingsWithoutPrice = holdings.filter(h => h.currentPrice === null)
    const valuationCompleteness = holdings.length > 0 ? Math.round(holdingsWithPrice.length / holdings.length * 100) : 100
    const totalUnrealized = holdingsWithPrice.reduce((s, h) => s + h.unrealizedPnL, 0)
    const valuationIssueKey = holdingsWithoutPrice.map(holding => holding.code).sort().join('|')

    useEffect(() => {
        if (holdings.length === 0) { setValuationNoticeVisible(false); return }
        setValuationNoticeVisible(true)
        // 完整估值只短暫告知；缺價屬疑慮，直到使用者關閉前持續顯示。
        if (valuationIssueKey) return
        const timer = setTimeout(() => setValuationNoticeVisible(false), 4200)
        return () => clearTimeout(timer)
    }, [holdings.length, valuationIssueKey])

    // ── 融資維持率計算 ──
    // 維持率 = 融資股票目前市值 / 融資金額（借款） × 100%
    // 台灣法規：低於 130% 追繳，低於 120% 強制斷頭
    const totalMarginDebt = marginPositions.reduce((s, m) => s + m.marginAmount, 0)
    const marginStockMarketValue = marginPositions.reduce((s, m) => {
        const h = holdings.find(h => h.code === m.code)
        // 若有現價用市值，否則用買入時成本
        const mv = h ? h.currentPrice !== null ? calcGrossAmount(h.currentPrice, m.shares) : m.marginCost : m.marginCost
        return s + mv
    }, 0)
    const marginRatioValue = totalMarginDebt > 0 ? (marginStockMarketValue / totalMarginDebt) * 100 : null
    const hasMargin = marginPositions.length > 0

    // ── 倉位百分比 = 股票市值 ÷ 自有資金（槓桿後曝險）──
    // 自有資金（equity）= 總資產 − 融資借款，反映真正投入的本金
    // 無融資時分母 = 總資產，倉位% 退化為單純的持股佔比
    const equityCapital = totalAssets - totalMarginDebt
    const positionPct = equityCapital > 0 ? (totalMarketValue / equityCapital) * 100 : null
    const targetPositionNum = Number(targetPositionPct)
    const positionAdjustment = targetPositionPct !== '' && Number.isFinite(targetPositionNum)
        ? calcPositionAdjustment(totalMarketValue, equityCapital, targetPositionNum)
        : null
    const adjustmentPriceNum = Number(adjustmentPrice)
    const estimatedShares = positionAdjustment && positionAdjustment.action !== 'hold' && adjustmentPriceNum > 0
        ? Math.max(1, Math.round(positionAdjustment.amount / adjustmentPriceNum))
        : null
    const selectedAdjustmentHolding = holdings.find(h => h.code === adjustmentCode)
    const achievedPositionPct = positionAdjustment && estimatedShares !== null
        ? (
            totalMarketValue
            + (positionAdjustment.action === 'buy' ? 1 : -1) * estimatedShares * adjustmentPriceNum
        ) / equityCapital * 100
        : null
    const adjustmentExceedsCash = positionAdjustment?.action === 'buy'
        && positionAdjustment.amount > Math.max(totalCash, 0)
    const adjustmentExceedsHolding = positionAdjustment?.action === 'sell'
        && estimatedShares !== null
        && selectedAdjustmentHolding !== undefined
        && estimatedShares > selectedAdjustmentHolding.shares

    // 淨資產 = 市值 + 現金 − 融資借款（負債）。與資產趨勢、年度回顧快照口徑一致。
    // 註：totalAssets（毛額）仍用於圓餅圖佔比與維持率分母，故兩者並存。
    const netAssets = totalAssets - totalMarginDebt
    const cashShortfall = Math.max(-totalCash, 0)

    // 維持率顏色：>160% 綠，130~160% 橙，<130% 紅
    const marginRatioColor = marginRatioValue === null ? 'var(--c-muted)'
        : marginRatioValue >= marginRules.safeRatio ? 'var(--c-positive)'
            : marginRatioValue >= marginRules.maintenanceRatio ? 'var(--c-warning)'
                : 'var(--c-danger)'

    // 融資加碼試算結果（即時計算，純前端）
    const simPriceNum = parseFloat(simPrice)
    const simSharesNum = parseInt(simShares, 10)
    const simRatioNum = parseFloat(simRatio)
    const simResult = (simOpen && simPriceNum > 0 && simSharesNum > 0 && simRatioNum > 0)
        ? simulateMarginBuy(marginStockMarketValue, totalMarginDebt, simPriceNum, simSharesNum, simRatioNum, marginRules)
        : null
    const simRatioColor = simResult === null ? 'var(--c-muted)'
        : simResult.newMarginRatio >= marginRules.safeRatio ? 'var(--c-positive)'
            : simResult.newMarginRatio >= marginRules.maintenanceRatio ? 'var(--c-warning)'
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
        holdingGroups.forEach(h => {
            const g = stockGroups[h.code] || '__未分類__'
            groupTotalMV[g] = (groupTotalMV[g] || 0) + h.marketValue
        })
        return [...holdingGroups].sort((a, b) => {
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
    }, [holdingGroups, stockGroups, sortMode])

    const unrealizedLabel = hasPrice && holdingsWithoutPrice.length > 0
        ? `未實現損益（${holdingsWithPrice.length}/${holdings.length} 檔）`
        : '未實現損益'

    const todayStr = toLocalDateString()
    const tomorrowStr = toLocalDateString(new Date(Date.now() + 86400000))

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
            {notice && <ActionNotice {...notice} onClose={() => setNotice(null)} />}
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
        .position-tool-grid { display: grid; grid-template-columns: 1fr 1.35fr 1fr; gap: 10px; }
        @media (max-width: 560px) { .position-tool-grid { grid-template-columns: 1fr; } }
        .dash-extra { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; margin-top: 16px; }
        @media (max-width: 700px) { .dash-extra { grid-template-columns: 1fr; } }
        .dashboard-topbar { position: sticky; top: 0; z-index: 30; padding: 8px 0; margin-bottom: 12px; background: var(--c-bg); border-bottom: 1px solid var(--c-border); }
        .dashboard-topbar .page-header { margin-bottom: 8px; }
        .dashboard-heading { display: flex; align-items: center; flex: 1; gap: 12px; min-width: 0; }
        .dashboard-heading .page-title { flex-shrink: 0; }
        .dashboard-heading-meta { flex: 1; min-width: 0; }
        .dashboard-heading-meta .page-subtitle { margin-top: 0; font-size: 12px; }
        .dashboard-heading-meta .invest-sync-status { padding: 0; justify-content: flex-start; }
        .dashboard-heading-meta .invest-sync-status__note > summary { margin-inline-start: 0; min-height: 22px; padding-block: 2px; }
        .dashboard-heading-meta .invest-sync-status__note .disclosure-note__body { text-align: left; }
        .dashboard-topbar > [role="status"], .dashboard-topbar > [role="alert"] { padding: 4px 0 !important; }
        .dashboard-section-nav { display: flex; gap: 8px; margin: 0; padding: 8px; border: 1px solid var(--c-border); border-radius: 11px; background: color-mix(in srgb, var(--c-bg) 94%, transparent); box-shadow: 0 8px 22px rgba(0,0,0,.16); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
        .dashboard-section-nav button { min-height: 34px; padding: 6px 12px; border: 1px solid transparent; border-radius: 8px; color: var(--c-muted); background: transparent; font-size: 12px; font-weight: 600; cursor: pointer; }
        .dashboard-section-nav button:hover { color: var(--c-text); border-color: var(--c-border); background: var(--c-card); }
        .dashboard-section { scroll-margin-top: calc(var(--dashboard-sticky-height, 120px) + 12px); margin-bottom: 16px; }
        .dashboard-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; padding-inline: 2px; }
        .dashboard-section-heading h2 { margin: 0; color: var(--c-text); font-size: 14px; font-weight: 700; }
        .dashboard-section > .dash-side-cards,
        .dashboard-section > .dash-pies,
        .dashboard-section > .dash-extra { margin-bottom: 0; margin-top: 0; }
        @media (max-width: 767px), (max-width: 950px) and (pointer: coarse) and (orientation: landscape) {
            .dashboard-section-nav { display: none; }
            .dashboard-topbar { padding-block: 4px 6px; margin-bottom: 10px; }
            .dashboard-heading { flex-basis: 100%; gap: 10px; }
            .dashboard-heading-meta .page-subtitle { font-size: 11px; }
            .dashboard-topbar .page-actions { width: 100%; justify-content: flex-end; }
        }
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

            <div className="dashboard-page" style={{ padding: '0 var(--ui-page-padding, clamp(16px, 3vw, 32px)) var(--ui-page-padding, clamp(16px, 3vw, 32px))', maxWidth: '1600px', margin: '0 auto' }}>
                <div className="dashboard-topbar" ref={topbarRef}>
                    <div className="page-header">
                        <div className="page-heading dashboard-heading">
                            <h1 className="page-title">儀表板</h1>
                            <div className="dashboard-heading-meta">
                                <InvestSyncStatus />
                                <p className="page-subtitle">
                                    {ctxLastUpdated ? `現價更新：${ctxLastUpdated}` : '尚未更新現價，點「更新現價」取得最新報價'}
                                </p>
                            </div>
                        </div>
                        <div className="page-actions dashboard-report-actions">
                            <MarketReportButton />
                            <button
                                className="ui-button ui-button-primary"
                                onClick={() => void updatePrices()}
                                disabled={priceLoading || loading}
                                title="更新現價、除權息、快照與法說會"
                            >
                                <RefreshCw size={15} className={priceLoading ? 'is-spinning' : undefined} />
                                {priceLoading ? '現價更新中...' : '更新現價'}
                            </button>
                        </div>
                    </div>
                    <PriceRefreshStatus />
                    <nav className="dashboard-section-nav" aria-label="儀表板區塊導覽">
                        {DASHBOARD_SECTIONS.map(section => (
                            <button key={section.key} type="button" onClick={() => scrollToDashboardSection(section.id)}>
                                {section.label}
                            </button>
                        ))}
                    </nav>
                </div>

                <DividendFeedStatus />
                {holdings.length > 0 && valuationNoticeVisible && (
                    <div role={holdingsWithoutPrice.length ? 'alert' : 'status'} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px', padding: '8px 10px 8px 12px', borderRadius: '9px', border: `1px solid ${holdingsWithoutPrice.length ? 'color-mix(in srgb, var(--c-warning) 35%, transparent)' : 'color-mix(in srgb, var(--c-positive) 30%, transparent)'}`, background: holdingsWithoutPrice.length ? 'color-mix(in srgb, var(--c-warning) 7%, transparent)' : 'color-mix(in srgb, var(--c-positive) 6%, transparent)', color: holdingsWithoutPrice.length ? 'var(--c-warning)' : 'var(--c-positive)', fontSize: '12px' }}>
                        {holdingsWithoutPrice.length ? <AlertTriangle size={14} /> : <CheckSquare size={14} />}
                        <strong>{priceLoading && !refreshProgress?.startsWith('持股已更新') ? `${refreshProgress || '持股更新中'}，估值可能含上次報價` : `估值完整度 ${holdingsWithPrice.length}/${holdings.length}（${valuationCompleteness}%）`}</strong>
                        {holdingsWithoutPrice.length > 0 && <span style={{ color: 'var(--c-muted)', flex: 1 }}>缺價：{holdingsWithoutPrice.map(h => h.code).join('、')}；暫以成本估算市值</span>}
                        {holdingsWithoutPrice.some(h => priceErrors[h.code]) && <span style={{ width: '100%', fontSize: '11px' }}>{holdingsWithoutPrice.filter(h => priceErrors[h.code]).map(h => `${h.code}：${priceErrors[h.code]}`).join('；')}</span>}
                        <button type="button" aria-label="關閉估值完整度提示" onClick={() => setValuationNoticeVisible(false)} style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: 'currentColor', cursor: 'pointer', display: 'grid', placeItems: 'center', padding: '2px', opacity: 0.75 }}><X size={14} /></button>
                    </div>
                )}

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

                {loading && hasLoaded && <p className="ui-refresh-status" role="status">資料更新中…</p>}
                {loading && !hasLoaded ? (
                    <LoadingState />
                ) : (
                    <>
                        <div className="dash-stats">
                            {[
                                { label: '總資產', value: `$${netAssets.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: 'var(--c-accent)', icon: DollarSign },
                                { label: '股票總市值（含出借）', value: `$${totalMarketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: 'var(--c-accent)', icon: BarChart2 },
                                { label: '帳面現金', value: `$${totalCash.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: cashShortfall > 0 ? 'var(--c-danger)' : 'var(--c-warning)', icon: DollarSign, cashWarning: cashShortfall > 0 },
                            ].map(({ label, value, color, icon: Icon, cashWarning }) => (
                                <div key={label} className="dashboard-kpi-card" style={{ ...card, borderColor: cashWarning ? 'color-mix(in srgb, var(--c-danger) 55%, var(--c-border))' : card.borderColor, background: cashWarning ? 'linear-gradient(135deg, var(--c-sidebar) 0%, color-mix(in srgb, var(--c-danger) 8%, transparent) 100%)' : card.backgroundColor }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <div>
                                            <div style={{ fontSize: '13px', color: 'var(--c-muted)', marginBottom: '8px' }}>{label}
                                                {label === '帳面現金' && <InfoHint text="成交日帳面現金，含未交割款；不等於銀行可提領餘額。交割款以元大查詢為準。" />}
                                            </div>
                                            <div style={{ fontSize: 'clamp(16px, 2vw, 22px)', fontWeight: 700, color }}>{value}</div>
                                            {cashWarning && <div role="alert" style={{ marginTop: '5px', color: 'var(--c-danger)', fontSize: '11px', fontWeight: 700 }}>帳面資金缺口 ${cashShortfall.toLocaleString('zh-TW', { maximumFractionDigits: 0 })} · 請核對交割款</div>}
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
                                <div key={label} className="dashboard-kpi-card" style={card}>
                                    <div style={{ fontSize: '13px', color: 'var(--c-muted)', marginBottom: '8px', display: 'flex', alignItems: 'center' }}>
                                        {label}
                                        {label === unrealizedLabel && <InfoHint text="市值扣含費成本及預估賣出費稅，不含股息；含出借股票。預估手續費未折扣；券商指定批次優先，其餘先進先出。融資未扣利息。" />}
                                        {label === '已實現損益' && <InfoHint text="賣出淨收入扣批次成本，與歷史損益一致；不同於 XIRR。" />}
                                    </div>
                                    <div style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 700, color }}>{value}</div>
                                </div>
                            ))}
                        </div>

                        {/* ── 倉位 / 融資維持率 並排卡片（手機自動換行）── */}
                        <section id="dashboard-risk" className="dashboard-section">
                            <div className="dashboard-section-heading">
                                <h2>資金與風險</h2>
                            </div>
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

                            {/* 倉位水位試算工具 */}
                            <div style={{ ...card, display: 'flex', flexDirection: 'column' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '18px' }}>
                                    <div style={{ width: '40px', height: '40px', borderRadius: '10px', backgroundColor: 'color-mix(in srgb, var(--c-accent) 14%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                        <Calculator size={20} color="var(--c-accent)" />
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '14px', color: 'var(--c-text)', fontWeight: 700 }}>倉位水位試算</div>
                                        
                                    </div>
                                </div>

                                <div className="position-tool-grid">
                                    <label>
                                        <span style={{ display: 'block', fontSize: '11px', color: 'var(--c-muted)', marginBottom: '5px' }}>目標倉位（%）</span>
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.1"
                                            inputMode="decimal"
                                            value={targetPositionPct}
                                            onChange={e => setTargetPositionPct(e.target.value)}
                                            placeholder={positionPct !== null ? positionPct.toFixed(1) : '例如 55'}
                                            aria-label="目標倉位百分比"
                                            style={{ width: '100%', boxSizing: 'border-box', backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '9px 10px', fontSize: '13px', outline: 'none' }}
                                        />
                                    </label>
                                    <label>
                                        <span style={{ display: 'block', fontSize: '11px', color: 'var(--c-muted)', marginBottom: '5px' }}>換算股票（選填）</span>
                                        <select
                                            value={adjustmentCode}
                                            onChange={e => {
                                                const code = e.target.value
                                                setAdjustmentCode(code)
                                                const holding = holdings.find(h => h.code === code)
                                                setAdjustmentPrice(holding ? String(holding.currentPrice ?? holding.avgCost) : '')
                                            }}
                                            aria-label="換算股票"
                                            style={{ width: '100%', boxSizing: 'border-box', backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '9px 10px', fontSize: '13px', outline: 'none' }}
                                        >
                                            <option value="">只計算金額</option>
                                            {holdings.map(h => <option key={h.code} value={h.code}>{h.code} {h.name}</option>)}
                                        </select>
                                    </label>
                                    <label>
                                        <span style={{ display: 'block', fontSize: '11px', color: 'var(--c-muted)', marginBottom: '5px' }}>參考股價</span>
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            inputMode="decimal"
                                            value={adjustmentPrice}
                                            onChange={e => setAdjustmentPrice(e.target.value)}
                                            placeholder="選股票後帶入"
                                            disabled={!adjustmentCode}
                                            aria-label="參考股價"
                                            style={{ width: '100%', boxSizing: 'border-box', backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '9px 10px', fontSize: '13px', outline: 'none', opacity: adjustmentCode ? 1 : 0.55 }}
                                        />
                                    </label>
                                </div>

                                <div style={{ marginTop: '16px', backgroundColor: 'var(--c-bg)', borderRadius: '10px', padding: '14px' }}>
                                    {!positionAdjustment ? (
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', textAlign: 'center', padding: '8px 0' }}>
                                            目前 {positionPct !== null ? positionPct.toFixed(1) : '—'}%，輸入目標水位開始試算
                                        </div>
                                    ) : positionAdjustment.action === 'hold' ? (
                                        <div style={{ fontSize: '14px', color: 'var(--c-positive)', fontWeight: 700, textAlign: 'center', padding: '8px 0' }}>已在目標水位，不需調整</div>
                                    ) : (
                                        <>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
                                                <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>
                                                    {positionAdjustment.currentPct.toFixed(1)}% → {positionAdjustment.targetPct.toFixed(1)}%
                                                </span>
                                                <span style={{ fontSize: 'clamp(18px, 2.5vw, 24px)', color: positionAdjustment.action === 'buy' ? 'var(--c-positive)' : 'var(--c-danger)', fontWeight: 800 }}>
                                                    {positionAdjustment.action === 'buy' ? '買進' : '賣出'} ${positionAdjustment.amount.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                </span>
                                            </div>
                                            {estimatedShares !== null && (
                                                <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--c-border)', display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                                                    <span style={{ fontSize: '12px', color: 'var(--c-muted)' }}>{adjustmentCode} 以 ${adjustmentPriceNum.toLocaleString('zh-TW')} 試算</span>
                                                    <strong style={{ fontSize: '14px', color: 'var(--c-text)' }}>
                                                        約 {estimatedShares.toLocaleString()} 股
                                                        <span style={{ marginLeft: '6px', color: 'var(--c-muted)', fontSize: '11px', fontWeight: 500 }}>
                                                            （{Math.floor(estimatedShares / 1000)} 張 + {estimatedShares % 1000} 股）
                                                        </span>
                                                    </strong>
                                                </div>
                                            )}
                                            {achievedPositionPct !== null && (
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginTop: '8px', textAlign: 'right' }}>
                                                    依整股估算，交易後約 {achievedPositionPct.toFixed(2)}%
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>

                                {(adjustmentExceedsCash || adjustmentExceedsHolding) && (
                                    <div style={{ marginTop: '10px', fontSize: '11px', lineHeight: 1.5, color: 'var(--c-warning)' }}>
                                        {adjustmentExceedsCash
                                            ? `⚠ 帳面現金約 $${Math.max(totalCash, 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}，不足以完成全部買進。`
                                            : `⚠ ${adjustmentCode} 目前持有 ${selectedAdjustmentHolding?.shares.toLocaleString()} 股，不足以單靠這檔完成賣出。`}
                                    </div>
                                )}
                                
                            </div>

                            {/* ── 融資維持率卡片（有融資部位才顯示）── */}
                            {hasMargin && (
                                <div style={{
                                    ...card,
                                    display: 'flex', flexDirection: 'column',
                                    borderColor: marginRatioValue !== null && marginRatioValue < marginRules.maintenanceRatio ? 'rgba(255,87,87,0.5)'
                                        : marginRatioValue !== null && marginRatioValue < marginRules.safeRatio ? 'rgba(245,166,35,0.4)'
                                            : 'var(--c-border)',
                                    background: marginRatioValue !== null && marginRatioValue < marginRules.maintenanceRatio ? 'linear-gradient(135deg, var(--c-sidebar) 0%, color-mix(in srgb, var(--c-danger) 6%, transparent) 100%)'
                                        : marginRatioValue !== null && marginRatioValue < marginRules.safeRatio ? 'linear-gradient(135deg, var(--c-sidebar) 0%, color-mix(in srgb, var(--c-warning) 5%, transparent) 100%)'
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
                                                            backgroundColor: marginRatioValue >= marginRules.safeRatio ? 'color-mix(in srgb, var(--c-positive) 12%, transparent)' : marginRatioValue >= marginRules.maintenanceRatio ? 'color-mix(in srgb, var(--c-warning) 12%, transparent)' : 'color-mix(in srgb, var(--c-danger) 12%, transparent)',
                                                            color: marginRatioColor
                                                        }}>
                                                            {marginRatioValue >= marginRules.safeRatio ? '✓ 安全' : marginRatioValue >= marginRules.maintenanceRatio ? '⚠ 留意' : '⚠ 危險'}
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
                                                <span>斷頭線 {marginRules.liquidationRatio}%</span>
                                                <span>追繳線 {marginRules.maintenanceRatio}%</span>
                                                <span>安全線 {marginRules.safeRatio}%</span>
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
                                                const mv = h ? (h.currentPrice !== null ? calcGrossAmount(h.currentPrice, m.shares) : m.marginCost) : m.marginCost
                                                const ratio = m.marginAmount > 0 ? (mv / m.marginAmount) * 100 : 0
                                                const rColor = ratio >= marginRules.safeRatio ? 'var(--c-positive)' : ratio >= marginRules.maintenanceRatio ? 'var(--c-warning)' : 'var(--c-danger)'
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
                                    {marginRatioValue !== null && marginRatioValue < marginRules.maintenanceRatio && (
                                        <div style={{ marginTop: '12px', padding: '8px 12px', backgroundColor: 'rgba(255,87,87,0.08)', border: '1px solid rgba(255,87,87,0.25)', borderRadius: '8px', fontSize: '12px', color: 'var(--c-danger)' }}>
                                            ⚠️ 維持率低於 {marginRules.maintenanceRatio}%，請留意追繳風險！斷頭線為 {marginRules.liquidationRatio}%。
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
                                                                {simResult.newMarginRatio >= marginRules.safeRatio ? '✓ 安全' : simResult.newMarginRatio >= marginRules.maintenanceRatio ? '⚠ 留意' : '⚠ 危險'}
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
                                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>距追繳線({marginRules.maintenanceRatio}%)緩衝</div>
                                                            <div style={{ fontSize: '14px', fontWeight: 600, color: simResult.bufferTo130 >= 0 ? 'var(--c-positive)' : 'var(--c-danger)' }}>
                                                                {simResult.bufferTo130 >= 0 ? '+' : ''}${simResult.bufferTo130.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                                                            </div>
                                                        </div>
                                                        <div style={{ backgroundColor: 'var(--c-bg)', borderRadius: '8px', padding: '10px 12px' }}>
                                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '4px' }}>距斷頭線({marginRules.liquidationRatio}%)緩衝</div>
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
                        </section>
                        {/* ── /倉位 + 融資 並排卡片 ── */}

                        {/* ── 兩個圓餅圖並排 ── */}
                        <section id="dashboard-allocation" className="dashboard-section">
                            <div className="dashboard-section-heading">
                                <h2>資產分布</h2>
                            </div>
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
                        </section>

                        {/* 目前持倉表格 */}
                        <section id="dashboard-holdings" className="dashboard-section">
                            <div className="dashboard-section-heading">
                                <h2>目前持倉</h2>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <select
                                        value={sortMode}
                                        onChange={e => setSortMode(e.target.value as typeof sortMode)}
                                        aria-label="持倉排序"
                                        style={{ backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '6px 8px', fontSize: '12px', cursor: 'pointer' }}
                                    >
                                        <option value="marketValue">依市值</option>
                                        <option value="group">依族群</option>
                                        <option value="returnRate">依報酬率</option>
                                        <option value="unrealizedPnL">依未實現損益</option>
                                        <option value="code">依代號</option>
                                    </select>
                                </div>
                            </div>
                        <div style={{ ...card, marginBottom: '0' }}>
                            {holdings.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--c-muted)', fontSize: '13px' }}>尚無持倉資料</div>
                            ) : (
                                <>
                                <div className="mobile-holdings-list dashboard-mobile-holdings">
                                    {sortedHoldings.map(h => {
                                        const expanded = expandedHoldingCode === h.positionKey
                                        const detailId = `dashboard-holding-${h.positionKey}`
                                        return (
                                            <div key={h.positionKey} className="mobile-holding-card">
                                                <button
                                                    type="button"
                                                    className="mobile-holding-summary"
                                                    aria-expanded={expanded}
                                                    aria-controls={detailId}
                                                    onClick={() => setExpandedHoldingCode(expanded ? null : h.positionKey)}
                                                >
                                                    <span className="mobile-holding-identity">
                                                        <span style={{ display: 'flex', alignItems: 'center' }}><strong>{h.code}</strong><HoldingFundingBadge type={h.fundingType} /></span>
                                                        <span>{h.name}</span>
                                                        <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>{h.shares.toLocaleString()} 股 · 均價 {h.avgCost.toFixed(2)}</span>
                                                    </span>
                                                    <span className="mobile-holding-result">
                                                        <strong>${h.marketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</strong>
                                                        <span style={{ color: h.currentPrice === null ? 'var(--c-muted)' : pnlColor(h.returnRate) }}>
                                                            {h.currentPrice === null ? '請更新現價' : `${h.returnRate >= 0 ? '+' : ''}${h.returnRate.toFixed(2)}%`}
                                                        </span>
                                                    </span>
                                                    {expanded ? <ChevronUp size={17} aria-hidden="true" /> : <ChevronDown size={17} aria-hidden="true" />}
                                                </button>
                                                {expanded && (
                                                    <div id={detailId} className="mobile-holding-details dashboard-holding-details">
                                                        {[
                                                            ['股數', h.shares.toLocaleString()],
                                                            ['融資借款', h.fundingType === 'margin' ? h.marginAmount.toLocaleString() : '—'],
                                                            ['平均成本', h.avgCost.toFixed(2)],
                                                            ['現價', h.currentPrice === null ? '—' : h.currentPrice.toFixed(2)],
                                                            ['未實現損益', h.currentPrice === null ? '—' : `${h.unrealizedPnL >= 0 ? '+' : ''}${h.unrealizedPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`],
                                                            ['持倉佔比', `${h.ratio.toFixed(1)}%`],
                                                            ['族群', stockGroups[h.code] || '未分類'],
                                                        ].map(([label, value]) => (
                                                            <div key={label}>
                                                                <span>{label}</span>
                                                                <strong>{value}</strong>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                                <div className="desktop-dashboard-holdings-table" style={{ overflowX: 'auto' }}>
                                    <table className="h-table">
                                        <thead>
                                            <tr>{['代號', '名稱', '股數', '均價', '現價', '未實現損益', '報酬率', '佔比', '族群'].map(h => <th key={h}>{h}</th>)}</tr>
                                        </thead>
                                        <tbody>
                                            {sortedHoldings.map(h => (
                                                <tr key={h.positionKey}>
                                                    <td style={{ color: 'var(--c-accent)', fontWeight: 700 }}>{h.code}</td>
                                                    <td>
                                                        {h.name}
                                                        <HoldingFundingBadge type={h.fundingType} />
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
                                                                title={h.marginAmount > 0 ? '融資報酬率（自備款口徑）' : '現股報酬率'}
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
                                </>
                            )}
                        </div>
                        </section>

                        {/* ── 兩欄：近14天行程 / 待辦任務 ── */}
                        <section id="dashboard-planner" className="dashboard-section">
                            <div className="dashboard-section-heading">
                                <h2>行程與任務</h2>
                            </div>
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
                        </section>
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
