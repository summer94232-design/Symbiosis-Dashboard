import LoadingState from '../../components/LoadingState'
import { accountXirr, calculateSnapshotAccountReturn, buildTimeWeightedReturns, calculateReturnDrawdown, snapshotValuationIssue, type AssetValuation } from '../../lib/performanceReturns'
import DisclosureNote from '../../components/DisclosureNote'
import { buildTodaySnapshot } from '../../lib/snapshot'
import { captureUserSession } from '../../lib/userDB'
// YearReview.tsx
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useInvestSync } from '../../InvestSyncContext'
import { getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { calcPositions, receivedCashDividends, type DividendRecord, type TradeRecord } from '../../lib/calc'
import { fetchTrades, fetchDividends, fetchCashflow, fetchAssetSnapshots } from '../../lib/investData'
// ✅ 1-2：共用 UI 樣式與格式化（inp 因本頁刻意無 width:100%，保留本地定義）
import { card } from '../../ui/styles'
import { pnlColor, fmtMoney, fmtPct } from '../../ui/format'
import { toLocalDateString } from '../../lib/date'


interface MonthlyPnL {
    month: string
    realized: number
    dividend: number
    total: number
    costBasis: number
}

interface YearlyPerf {
    year: number
    startValue: number
    endValue: number
    invested: number
    cagr: number | null
    totalReturn: number | null
    reason: string
}

interface RealizedTrade {
    category?: 'dayTrade' | 'inventory'
    date: string
    code: string
    name: string
    pnl: number
    costBasis: number
    holdingDays: number
    returnRate: number
}

interface YearStat {
    year: number
    realized: number
    dividend: number
    total: number
    costBasis: number
    returnRate: number | null
    /** Account XIRR includes received dividends and unrealized NAV changes. */
    totalReturnRate: number | null
    winRate: number | null
    tradeCount: number
}

interface BarChartEntry {
    year: string
    '年度報酬率%': number | null
    '年末資產': number
    fill: string
}

interface MonthlyBarEntry {
    month: string
    realized: number
    dividend: number
    total: number
    costBasis: number
    realizedFill: string
}

// ── 出入金（供 snapshot 分頁排除增資影響）──
// amount 約定：入金 = 負（資金流出口袋、流入帳戶），出金 = 正
// 與 XIRR 期初(負)、期末(正) 方向一致
interface AccountCashflow {
    date: string
    amount: number
}

function heatColor(val: number, max: number): string {
    if (max === 0) return 'var(--c-border)'
    const r = Math.min(Math.abs(val) / max, 1)
    if (val > 0) return `rgba(0,200,150,${(0.15 + r * 0.65).toFixed(2)})`
    if (val < 0) return `rgba(255,87,87,${(0.15 + r * 0.65).toFixed(2)})`
    return 'var(--c-card)'
}

// 本頁的 inp 刻意不帶 width:100%（用於行內 select），與共用版不同，故保留本地定義
const inp: React.CSSProperties = { backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 12px', color: 'var(--c-text)', fontSize: '14px', outline: 'none' }

interface TooltipProps {
    active?: boolean
    payload?: { name: string; value: number; color: string }[]
    label?: string
}

const CustomTooltip = ({ active, payload, label }: TooltipProps) => {
    if (!active || !payload?.length) return null
    return (
        <div style={{ backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '12px 16px' }}>
            <p style={{ color: 'var(--c-muted)', fontSize: '12px', margin: '0 0 8px' }}>{label}</p>
            {payload.map((p) => (
                <p key={p.name} style={{ color: p.color, fontSize: '14px', fontWeight: 600, margin: '2px 0' }}>
                    {p.name}：{p.name.includes('%') ? `${p.value.toFixed(2)}%` : `$${Number(p.value).toLocaleString()}`}
                </p>
            ))}
        </div>
    )
}

export default function YearReview() {
    const { version: syncVersion } = useInvestSync()
    const [tab, setTab] = useState<'review' | 'snapshot' | 'performance'>('review')

    const [monthlyData, setMonthlyData] = useState<MonthlyPnL[]>([])
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear())
    const [startMonth, setStartMonth] = useState(1)
    const [endMonth, setEndMonth] = useState(12)
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [hasLoaded, setHasLoaded] = useState(false)
    const [years, setYears] = useState<number[]>([])

    const [yearlyPerf, setYearlyPerf] = useState<YearlyPerf[]>([])
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [customCAGR, setCustomCAGR] = useState<number | null>(null)
    const [customMessage, setCustomMessage] = useState('')
    const [customBasis, setCustomBasis] = useState('')
    const customRequestRef = useRef(0)
    const [assetSnapshots, setAssetSnapshots] = useState<Record<string, number>>({})
    const [perfLoading, setPerfLoading] = useState(false)
    const [perfConfig, setPerfConfig] = useState<{ startDate: string | null; startValue: number | null }>({ startDate: null, startValue: null })
    const allTradesRef = useRef<TradeRecord[]>([])
    const allDividendsRef = useRef<DividendRecord[]>([])
    // ✅ 新增：出入金快取（snapshot 分頁排除增資影響用），入金=負/出金=正
    const allCashflowsRef = useRef<AccountCashflow[]>([])
    // ── 快取：原始資料載入一次後存在 ref，切換年份只重算 ──
    const rawDataLoadedRef = useRef(false)
    const loadedVersionRef = useRef(syncVersion)
    if (loadedVersionRef.current !== syncVersion) {
        rawDataLoadedRef.current = false
        loadedVersionRef.current = syncVersion
    }

    const [xirr, setXirr] = useState<number | null>(null)
    const [mdd, setMdd] = useState<number | null>(null)
    const [winRate, setWinRate] = useState<number | null>(null)
    const [totalWins, setTotalWins] = useState(0)
    const [totalTrades, setTotalTrades] = useState(0)
    const [avgHoldingDays, setAvgHoldingDays] = useState<number | null>(null)
    const [yearStats, setYearStats] = useState<YearStat[]>([])
    const [heatmapData, setHeatmapData] = useState<Record<string, number>>({})
    const [realizedTrades, setRealizedTrades] = useState<RealizedTrade[]>([])
    const [xirrLoading, setXirrLoading] = useState(true)

    // ── 自訂區間：套用於本頁所有統計（XIRR / MDD / 勝率 / 平均持有天數），
    //    可排除帳戶閒置前的久遠舊紀錄，只看真實想檢視的那段期間 ──
    const [rangeStart, setRangeStart] = useState('')
    const [rangeEnd, setRangeEnd] = useState('')
    const [rangeStats, setRangeStats] = useState<{
        xirr: number | null
        mdd: number | null
        winRate: number | null
        wins: number
        total: number
        avgHoldingDays: number | null
    } | null>(null)
    const [rangeLoading, setRangeLoading] = useState(false)

    const performanceSnapshotsRef = useRef<AssetValuation[]>([])
    const performanceCashflowsRef = useRef<AccountCashflow[]>([])
    const [performanceMessage, setPerformanceMessage] = useState('')
    const [rangeMessage, setRangeMessage] = useState('')

    // ✅ 修正：年度報酬率改用 XIRR，排除出入金（增資）影響。
    //   原本 (年末資產 − 年初資產) / 年初資產 會把入金當成獲利而高估。
    //   新做法：把每年視為一段現金流，期初淨值=流出(負)、區間出入金、期末淨值=流入(正)，
    //   以 XIRR 求年化報酬，金額多寡與時點都不再扭曲報酬率。
    //   （方案 A 後快照 cash 已含股利，故股利不另列現金流。）
    const calcYearlyPerf = useCallback((
        allYears: number[],
        snapshots: Record<string, number>,
        cashflows: AccountCashflow[]
    ) => {
        const perf: YearlyPerf[] = []
        allYears.forEach(year => {
            const yearDates = Object.keys(snapshots).filter(d => d.startsWith(`${year}`)).sort()
            const prevYearDates = Object.keys(snapshots).filter(d => d.startsWith(`${year - 1}`)).sort()
            const startDate = prevYearDates[prevYearDates.length - 1] || yearDates[0]
            const endDate = yearDates[yearDates.length - 1]
            if (!startDate || !endDate) return
            const startValue = snapshots[startDate] || 0
            const endValue = snapshots[endDate] || 0

            // 當年淨投入（僅供顯示參考）
            const invested = cashflows
                .filter(c => c.date > startDate && c.date <= endDate)
                .reduce((s, c) => s - c.amount, 0) // amount 入金為負 → 取負還原成「投入金額為正」

            // NAV already includes dividends and sale proceeds; only external flows enter XIRR.
            const result = calculateSnapshotAccountReturn({ snapshots: performanceSnapshotsRef.current, startDate, endDate, cashflows })
            const annualized = result.annualized

            perf.push({
                year, startValue, endValue, invested, reason: result.reason,
                cagr: annualized,        // XIRR 年化（已排除出入金）
                totalReturn: annualized  // 與 cagr 同口徑，圖表/表格皆顯示真實年化報酬
            })
        })
        setYearlyPerf(perf)
    }, [])

    // ── 根據已快取的 trades/dividends 重算指定年份的月度資料（不讀 Firestore）──
    const calcMonthlyForYear = useCallback((year: number, trades: TradeRecord[], dividends: DividendRecord[]) => {
        const monthlyRealized: Record<string, number> = {}
        const monthlyCost: Record<string, number> = {}
        const monthlyDividend: Record<string, number> = {}

        for (const r of calcPositions(trades, dividends, { asOf: toLocalDateString() }).realized) {
            if (r.date.slice(0, 4) !== String(year)) continue
            const mo = r.date.slice(0, 7)
            monthlyRealized[mo] = (monthlyRealized[mo] || 0) + r.realized
            monthlyCost[mo] = (monthlyCost[mo] || 0) + r.avgCost * r.shares
        }

        receivedCashDividends(dividends, toLocalDateString()).forEach(d => {
            if (d.date.slice(0, 4) === String(year)) {
                const mo = d.date.slice(0, 7)
                monthlyDividend[mo] = (monthlyDividend[mo] || 0) + d.cashDividend
            }
        })

        setMonthlyData(Array.from({ length: 12 }, (_, i) => {
            const mo = `${year}-${String(i + 1).padStart(2, '0')}`
            return {
                month: `${i + 1}月`,
                realized: monthlyRealized[mo] || 0,
                dividend: monthlyDividend[mo] || 0,
                total: (monthlyRealized[mo] || 0) + (monthlyDividend[mo] || 0),
                costBasis: monthlyCost[mo] || 0
            }
        }))
    }, [])

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const session = captureUserSession()
            let trades: TradeRecord[]
            let dividends: DividendRecord[]
            let snapshots: Record<string, number>
            let cashflows: AccountCashflow[]

            // ── 只有第一次才讀 Firestore，之後切換年份從快取重算 ──
            if (!rawDataLoadedRef.current) {
                // ✅ 多讀 cashflow，供 snapshot 分頁排除出入金
                const [tradesData, dividendsData, allSnapshotRows, cashflowData] = await Promise.all([
                    fetchTrades<TradeRecord>('asc'),
                    fetchDividends<DividendRecord>('asc'),
                    fetchAssetSnapshots<AssetValuation>('asc'),
                    fetchCashflow<{ date: string; type: 'in' | 'out'; amount: number }>('asc')
                ])

                session.assertActive()
                const snapshotRows = allSnapshotRows.filter(row => row.date <= toLocalDateString())
                trades = tradesData
                dividends = dividendsData
                snapshots = {}
                snapshotRows.forEach(row => { snapshots[row.date] = row.totalAssets })
                performanceSnapshotsRef.current = snapshotRows
                setAssetSnapshots(snapshots)

                // ┌─────────────────────────────────────────────────────────────┐
                // │ 正負號約定（本檔 = XIRR 口徑，入金記「負」）                     │
                // │   入金 'in'  → amount 為負（資金流出你的口袋、投入帳戶）         │
                // │   出金 'out' → amount 為正（資金回到你的口袋）                  │
                // │ 用途：XIRR 現金流方向 → 期初淨值(負)、期間入金(負)、             │
                // │       期末淨值(正)；NPV=0 時解出的利率即年化報酬。              │
                // │ ⚠️ 注意：AssetTrend.tsx 的 TWR 口徑正負號「相反」(入金記正)，     │
                // │   兩邊用途不同、各自正確，請勿為了統一而改動任一邊。            │
                // └─────────────────────────────────────────────────────────────┘
                cashflows = cashflowData.map(c => ({ date: c.date, amount: c.type === 'in' ? -c.amount : c.amount }))

                allTradesRef.current = trades
                allDividendsRef.current = dividends
                allCashflowsRef.current = cashflows

                // 讀取設定與現價（只需一次）
                getDoc(session.doc(investDB, 'settings', 'performanceConfig')).then(pd => {
                    session.assertActive()
                    if (pd.exists()) setPerfConfig({ startDate: pd.data().startDate || null, startValue: pd.data().startValue || null })
                }).catch(() => { })

                const allDates = [...trades.map(t => t.date), ...receivedCashDividends(dividends, toLocalDateString()).map(d => d.date), ...snapshotRows.map(s => s.date)].filter(d => d <= toLocalDateString())
                const allYears = [...new Set(allDates.map(d => parseInt(d.slice(0, 4))))].sort()
                if (allYears.length > 0) {
                    setYears(allYears)
                    setCustomStart(prev => prev || `${allYears[0]}-01-01`)
                    setCustomEnd(prev => prev || toLocalDateString())
                }
                calcYearlyPerf(allYears, snapshots, cashflows)
                rawDataLoadedRef.current = true
            } else {
                // 切換年份：從快取直接重算，不讀 Firestore
                trades = allTradesRef.current
                dividends = allDividendsRef.current
                snapshots = assetSnapshots
                cashflows = allCashflowsRef.current
            }

            // 重算本年月度資料
            calcMonthlyForYear(selectedYear, trades, dividends)
            setLoadError('')
            setHasLoaded(true)
        } catch (err) { console.error(err); setLoadError(err instanceof Error ? err.message : '年度資料載入失敗，請重新載入。') }
        setLoading(false)
    }, [selectedYear, calcYearlyPerf, calcMonthlyForYear, assetSnapshots])

    // ── 切換年份時只重算月度資料，不重讀 Firestore ──
    const handleYearChange = useCallback((year: number) => {
        setSelectedYear(year)
        // The load effect reuses cached rows and also handles invalid-ledger errors.
    }, [])

    // End-of-day account NAV plus external flows only. Sale proceeds and dividends
    // already belong to NAV cash; adding realized profit again would double-count.
    const calcCustomCAGR = useCallback(async () => {
        const requestId = ++customRequestRef.current
        setCustomCAGR(null)
        setCustomMessage('')
        setCustomBasis('')
        if (!customStart || !customEnd || customStart >= customEnd) return
        setPerfLoading(true)
        try {
            const session = captureUserSession()
            const [snapshots, cashflows, configDoc] = await Promise.all([
                fetchAssetSnapshots<AssetValuation>('asc'),
                fetchCashflow<{ date: string; type: 'in' | 'out'; amount: number }>('asc'),
                getDoc(session.doc(investDB, 'settings', 'performanceConfig')),
            ])
            session.assertActive()
            if (requestId !== customRequestRef.current) return
            const config = configDoc.exists() ? configDoc.data() : {}
            const start = typeof config.startDate === 'string' && config.startDate > customStart ? config.startDate : customStart
            if (start >= customEnd || customEnd > toLocalDateString()) {
                setCustomMessage('請選擇截至今日的有效區間；績效起始設定不得晚於結束日')
                return
            }
            // Historical values come from dated snapshots; today's endpoint may use current quotes.
            let endSource = '當日資產快照'
            if (!snapshots.some(s => s.date === customEnd) && customEnd === toLocalDateString()) {
                const current = await buildTodaySnapshot()
                session.assertActive()
                if (requestId !== customRequestRef.current) return
                if (current.snapshot.date !== customEnd || current.missing.length || current.stale.length) {
                    setCustomMessage('今日淨值尚缺完整有效報價，請先更新所有持股現價')
                    return
                }
                snapshots.push(current.snapshot)
                endSource = '今日有效報價估值'
            }
            const result = calculateSnapshotAccountReturn({ snapshots, startDate: start, endDate: customEnd,
                cashflows: cashflows.map(c => ({ date: c.date, amount: c.type === 'in' ? -c.amount : c.amount })) })
            setCustomCAGR(result.annualized)
            setCustomMessage(result.reason)
            if (result.startValue !== null && result.endValue !== null) {
                setCustomBasis(start + ' ～ ' + customEnd + '；期初 ' + result.startValue.toLocaleString() + '（當日資產快照），期末 ' + result.endValue.toLocaleString() + '（' + endSource + '）')
            }
        } catch (error) {
            if (requestId === customRequestRef.current) setCustomMessage(error instanceof Error ? error.message : '無法計算區間報酬')
        } finally { if (requestId === customRequestRef.current) setPerfLoading(false) }
    }, [customStart, customEnd])

    // ── 計算自訂區間統計：只取區間內的資料重算 XIRR / MDD / 勝率 / 平均持有天數，
    //    確保整頁指標口徑一致，不會有些採全歷史、有些採區間的落差 ──
    const calcRangeStats = useCallback(() => {
        if (!rangeStart || !rangeEnd || rangeStart >= rangeEnd) return
        setRangeLoading(true)

        // 勝率／平均持有天數取區間已實現交易；MDD 另取區間每日快照淨值。
        const tradesInRange = realizedTrades
            .filter(r => r.date >= rangeStart && r.date <= rangeEnd)
            .sort((a, b) => a.date.localeCompare(b.date))

        const wins = tradesInRange.filter(r => r.pnl > 0.5).length
        const total = tradesInRange.length
        const winRate = total > 0 ? (wins / total) * 100 : null
        const avgHoldingDays = total > 0 ? tradesInRange.reduce((s, r) => s + r.holdingDays, 0) / total : null

        const snapshots = performanceSnapshotsRef.current.filter(s => s.date >= rangeStart && s.date <= rangeEnd)
        const cashflows = performanceCashflowsRef.current
        const result = calculateSnapshotAccountReturn({ snapshots, startDate: rangeStart, endDate: rangeEnd, cashflows })
        const points = buildTimeWeightedReturns(snapshots, cashflows.map(c => ({ ...c, amount: -c.amount })), true, true)
        // XIRR may have a boundary result or no unique root while NAV drawdown
        // remains valid. Require the requested endpoints independently.
        const mdd = points[0]?.date === rangeStart && points.at(-1)?.date === rangeEnd ? calculateReturnDrawdown(points) : null
        setRangeMessage(result.reason || points.find(p => p.issue)?.issue || '')
        setRangeStats({ xirr: result.annualized === null ? null : result.annualized / 100, mdd, winRate, wins, total, avgHoldingDays })
        setRangeLoading(false)
    }, [rangeStart, rangeEnd, realizedTrades])

    const loadPerformance = useCallback(async () => {
        setXirrLoading(true)
        try {
            const session = captureUserSession()
            const [allTrades, dividends, cashflows, allSnapshotRows] = await Promise.all([
                fetchTrades<TradeRecord>('asc'), fetchDividends<DividendRecord>('asc'),
                fetchCashflow<{date: string; type: 'in' | 'out'; amount: number}>('asc'),
                fetchAssetSnapshots<AssetValuation>('asc'),
            ])
            session.assertActive()
            const today = toLocalDateString()
            const snapshots = allSnapshotRows.filter(row => row.date <= today).sort((a, b) => a.date.localeCompare(b.date))
            const received = receivedCashDividends(dividends, today)
            performanceSnapshotsRef.current = snapshots
            performanceCashflowsRef.current = cashflows.filter(c => c.date <= today).map(c => ({date: c.date, amount: c.type === 'in' ? -c.amount : c.amount}))
            const calculation = calcPositions(allTrades, dividends, { asOf: today })
            const realized: RealizedTrade[] = calculation.realized.map(r => ({
                date: r.date, code: r.code, name: r.name, pnl: r.realized,
                costBasis: r.avgCost * r.shares, holdingDays: r.holdingDays || 0,
                returnRate: r.returnRate * 100, category: r.category,
            }))
            const points = buildTimeWeightedReturns(snapshots, performanceCashflowsRef.current.map(c => ({...c, amount: -c.amount})), true, true)
            const valuationDates = snapshots.filter(s => !snapshotValuationIssue(s, s.date)).map(s => s.date)
            setRangeStart(prev => prev || valuationDates[0] || today)
            setRangeEnd(prev => prev || valuationDates.at(-1) || today)

            setRealizedTrades([...realized].reverse())
            const wins = realized.filter(r => r.pnl > 0.5).length
            setTotalWins(wins); setTotalTrades(realized.length)
            setWinRate(realized.length > 0 ? (wins / realized.length) * 100 : null)
            setAvgHoldingDays(realized.length > 0 ? realized.reduce((s, r) => s + r.holdingDays, 0) / realized.length : null)
            setMdd(calculateReturnDrawdown(points))
            const endpoint = snapshots.at(-1)
            const endpointIssue = snapshotValuationIssue(endpoint, endpoint?.date || today)
                || (snapshots.filter(row => row.date === endpoint?.date).length > 1 ? '同一天有重複快照，請先核對紀錄' : null)
            const flowRows = performanceCashflowsRef.current.filter(c => endpoint && c.date <= endpoint.date)
            const rate = endpointIssue ? null : accountXirr([...flowRows, {date: endpoint!.date, amount: endpoint!.totalAssets}])
            setXirr(rate)
            setPerformanceMessage(endpointIssue || (rate === null ? '現金流無法求得單一報酬率' : '依截至 ' + endpoint!.date + ' 的每日快照估算'))
            const allYrs = [...new Set([...realized.map(r => parseInt(r.date.slice(0, 4))), ...received.map(d => parseInt(d.date.slice(0, 4)))])].sort()
            const divByYear: Record<number, number> = {}
            received.forEach(d => { const y = parseInt(d.date.slice(0, 4)); divByYear[y] = (divByYear[y] || 0) + d.cashDividend })

            setYearStats(allYrs.map(y => {
                const yr = realized.filter(r => r.date.startsWith(String(y)))
                const totalR = yr.reduce((s, r) => s + r.pnl, 0)
                const totalCb = yr.reduce((s, r) => s + r.costBasis, 0)
                const totalD = divByYear[y] || 0
                const w = yr.filter(r => r.pnl > 0.5).length
                const dated = snapshots.filter(s => s.date <= today).sort((a, b) => a.date.localeCompare(b.date))
                const yearValues = dated.filter(s => s.date.startsWith(String(y)))
                const start = dated.filter(s => s.date.startsWith(String(y - 1))).at(-1) || yearValues[0]
                const end = yearValues.at(-1)
                const accountRate = start && end ? calculateSnapshotAccountReturn({ snapshots: dated,
                    startDate: start.date, endDate: end.date, cashflows: performanceCashflowsRef.current }).annualized : null
                return {
                    year: y, realized: totalR, dividend: totalD, total: totalR + totalD, costBasis: totalCb,
                    returnRate: totalCb > 0 ? (totalR / totalCb) * 100 : null,
                    // Dividends from open holdings cannot use closed-trade costs as their denominator.
                    totalReturnRate: accountRate,
                    winRate: yr.length > 0 ? (w / yr.length) * 100 : null, tradeCount: yr.length,
                }
            }))

            const heat: Record<string, number> = {}
            for (const r of calculation.realized) {
                heat[r.date.slice(0, 7)] = (heat[r.date.slice(0, 7)] || 0) + r.realized
            }
            received.forEach(d => { heat[d.date.slice(0, 7)] = (heat[d.date.slice(0, 7)] || 0) + d.cashDividend })
            setHeatmapData(heat)
        setHasLoaded(true)
        } catch (err) { console.error(err); setXirr(null); setMdd(null); setPerformanceMessage(err instanceof Error ? err.message : '績效資料載入失敗'); setRangeStats(null) }
        setXirrLoading(false)
    }, [])

    // 初始載入 + selectedYear 變動時重新載入
    useEffect(() => {
        let cancelled = false
        const run = async () => {
            setRangeStats(null)
            await load()
        }
        if (!cancelled) void run()
        return () => { cancelled = true }
    }, [load, syncVersion])

    // 配對變更後重算，避免績效分頁保留舊成本。
    useEffect(() => {
        if (tab !== 'performance') return
        const timer = setTimeout(() => { void loadPerformance() }, 0)
        return () => clearTimeout(timer)
    }, [tab, syncVersion, loadPerformance])

    // ✅ 3-3：衍生值包 useMemo，避免月份滑桿/輸入互動時整批重算
    const filtered = useMemo(() => monthlyData.slice(startMonth - 1, endMonth), [monthlyData, startMonth, endMonth])
    const totalRealized = filtered.reduce((s, m) => s + m.realized, 0)
    const totalDividend = filtered.reduce((s, m) => s + m.dividend, 0)
    const totalPnL = totalRealized + totalDividend
    const totalCostBasis = filtered.reduce((s, m) => s + m.costBasis, 0)
    const realizedReturnRate = totalCostBasis > 0 ? (totalRealized / totalCostBasis) * 100 : null
    const months = Array.from({ length: 12 }, (_, i) => i + 1)

    // ✅ 修正：整體 CAGR 改用 XIRR（排除全期出入金影響），與年度表同口徑。
    // ✅ 3-3：XIRR 二分法 200 次迭代不便宜，包 useMemo 只在快照更新時重算
    //   （allCashflowsRef 為 ref 非反應式，但它在 setAssetSnapshots 之前就緒，以 assetSnapshots 觸發即正確）
    const overallCAGR = useMemo(() => {
        const dates = Object.keys(assetSnapshots).sort()
        if (dates.length < 2) return null
        const startDate = dates[0]
        const endDate = dates[dates.length - 1]
        return calculateSnapshotAccountReturn({ snapshots: performanceSnapshotsRef.current, startDate, endDate, cashflows: allCashflowsRef.current }).annualized
    }, [assetSnapshots])

    // ✅ 3-3：圖表資料衍生陣列包 useMemo（recharts 對 data 參考變動敏感，順便減少重繪）
    const perfChartData: BarChartEntry[] = useMemo(() => yearlyPerf.map(p => ({
        year: `${p.year}`,
        '年度報酬率%': p.totalReturn === null ? null : Number(p.totalReturn.toFixed(2)),
        '年末資產': p.endValue,
        fill: (p.totalReturn ?? 0) >= 0 ? 'var(--c-positive)' : 'var(--c-danger)'
    })), [yearlyPerf])

    const filteredWithFill: MonthlyBarEntry[] = useMemo(() => filtered.map(m => ({
        ...m,
        realizedFill: m.realized >= 0 ? 'var(--c-positive)' : 'var(--c-danger)'
    })), [filtered])

    const heatYears = useMemo(() => [...new Set(Object.keys(heatmapData).map(k => k.slice(0, 4)))].sort(), [heatmapData])
    const heatMax = useMemo(() => Math.max(...Object.values(heatmapData).map(Math.abs), 1), [heatmapData])

    const tabBtn = (active: boolean): React.CSSProperties => ({
        backgroundColor: active ? 'var(--c-sidebar)' : 'transparent', border: 'none', borderRadius: '6px',
        padding: '6px 18px', color: active ? 'var(--c-text)' : 'var(--c-muted)', fontSize: '14px', cursor: 'pointer', fontWeight: active ? 600 : 400,
    })

    return (
        <>
            <style>{`
        .review-stats { display: grid; gap: 16px; grid-template-columns: repeat(4, 1fr); margin-bottom: 20px; }
        .perf-stats   { display: grid; gap: 16px; grid-template-columns: repeat(4, 1fr); margin-bottom: 20px; }
        .snap-stats   { display: grid; gap: 16px; grid-template-columns: repeat(4, 1fr); margin-bottom: 20px; }
        @media (max-width: 900px) { .review-stats, .perf-stats, .snap-stats { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .review-stats, .perf-stats, .snap-stats { grid-template-columns: 1fr; } }
        .perf-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .perf-table th { padding: 10px 12px; text-align: left; color: var(--c-muted); font-weight: 500; border-bottom: 1px solid var(--c-border); white-space: nowrap; }
        .perf-table td { padding: 12px; border-bottom: 1px solid var(--c-border); color: var(--c-text); white-space: nowrap; }
      `}</style>

            <div style={{ padding: 'var(--ui-page-padding, clamp(16px, 3vw, 32px))', maxWidth: '1600px', margin: '0 auto' }}>
                <div style={{ marginBottom: '16px' }}>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: '0 0 12px' }}>年度復盤</h1>
                    <div style={{ display: 'inline-flex', backgroundColor: 'var(--c-card)', padding: '4px', borderRadius: '8px', gap: '4px' }}>
                        <button style={tabBtn(tab === 'review')} onClick={() => setTab('review')}>損益分析</button>
                        <button style={tabBtn(tab === 'snapshot')} onClick={() => setTab('snapshot')}>資產快照 CAGR</button>
                        <button style={tabBtn(tab === 'performance')} onClick={() => setTab('performance')}>進階績效</button>
                    </div>
                </div>

                {loadError && <div role="alert" className="ui-load-error">{loadError} <button className="ui-button ui-button-secondary" disabled={loading} onClick={() => { rawDataLoadedRef.current = false; void load() }}>重新載入</button></div>}

                {tab === 'review' && !loadError && (
                    <>
                        <div style={{ ...card, marginBottom: '20px', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                            <div>
                                <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>年度</label>
                                <select style={inp} value={selectedYear} onChange={e => handleYearChange(parseInt(e.target.value))}>
                                    {(years.length === 0 ? [new Date().getFullYear()] : years).map(y => <option key={y} value={y}>{y}</option>)}
                                </select>
                            </div>
                            <div>
                                <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>起始月份</label>
                                <select style={inp} value={startMonth} onChange={e => setStartMonth(parseInt(e.target.value))}>
                                    {months.map(m => <option key={m} value={m}>{m} 月</option>)}
                                </select>
                            </div>
                            <div>
                                <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>結束月份</label>
                                <select style={inp} value={endMonth} onChange={e => setEndMonth(parseInt(e.target.value))}>
                                    {months.filter(m => m >= startMonth).map(m => <option key={m} value={m}>{m} 月</option>)}
                                </select>
                            </div>
                        </div>

                        <div className="review-stats">
                            {[
                                { label: '已實現損益', txt: fmtMoney(totalRealized), color: pnlColor(totalRealized) },
                                { label: '股利收入', txt: `$${totalDividend.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: 'var(--c-accent)' },
                                { label: '合計收益', txt: fmtMoney(totalPnL), color: pnlColor(totalPnL) },
                                { label: '已實現報酬率', txt: realizedReturnRate !== null ? fmtPct(realizedReturnRate) : '—', color: realizedReturnRate !== null ? pnlColor(realizedReturnRate) : 'var(--c-muted)' },
                            ].map(({ label, txt, color }) => (
                                <div key={label} style={card}>
                                    <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>{label}</div>
                                    <div style={{ fontSize: 'clamp(16px, 2vw, 22px)', fontWeight: 700, color }}>{txt}</div>
                                </div>
                            ))}
                        </div>

                        <div style={{ ...card, marginBottom: '20px' }}>
                            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '20px' }}>
                                {selectedYear} 年 {startMonth}–{endMonth} 月 損益分佈
                            </div>
                            {loading && hasLoaded && <p className="ui-refresh-status" role="status">資料更新中…</p>}
                    {loading && !hasLoaded ? <LoadingState /> : (
                                <ResponsiveContainer width="100%" height={300}>
                                    <BarChart data={filteredWithFill} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="var(--c-border)" />
                                        <XAxis dataKey="month" tick={{ fill: 'var(--c-muted)', fontSize: 12 }} />
                                        <YAxis tick={{ fill: 'var(--c-muted)', fontSize: 12 }} tickFormatter={v => `${(Number(v) / 1000).toFixed(0)}K`} width={50} />
                                        <Tooltip content={<CustomTooltip />} />
                                        <Bar dataKey="realized" name="已實現損益" fill="var(--c-positive)" radius={[4, 4, 0, 0]} />
                                        <Bar dataKey="dividend" name="股利收入" fill="var(--c-accent)" radius={[4, 4, 0, 0]} />
                                    </BarChart>
                                </ResponsiveContainer>
                            )}
                        </div>

                        <div style={{ ...card, marginBottom: '40px' }}>
                            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>月份明細</div>
                            <div style={{ overflowX: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid var(--c-border)' }}>
                                            {['月份', '已實現損益', '股利收入', '合計', '已實現報酬率'].map(h => (
                                                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: 'var(--c-muted)', fontWeight: 500 }}>{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filtered.map(m => {
                                            const mr = m.costBasis > 0 ? (m.realized / m.costBasis) * 100 : null
                                            return (
                                                <tr key={m.month} style={{ borderBottom: '1px solid var(--c-border)' }}>
                                                    <td style={{ padding: '12px', color: 'var(--c-text)', fontWeight: 500 }}>{selectedYear} {m.month}</td>
                                                    <td style={{ padding: '12px', color: m.realized !== 0 ? pnlColor(m.realized) : 'var(--c-muted)', fontWeight: 600 }}>
                                                        {m.realized !== 0 ? fmtMoney(m.realized) : '—'}
                                                    </td>
                                                    <td style={{ padding: '12px', color: m.dividend > 0 ? 'var(--c-accent)' : 'var(--c-muted)', fontWeight: 600 }}>
                                                        {m.dividend > 0 ? `+$${m.dividend.toLocaleString()}` : '—'}
                                                    </td>
                                                    <td style={{ padding: '12px', color: m.total !== 0 ? pnlColor(m.total) : 'var(--c-muted)', fontWeight: 700 }}>
                                                        {m.total !== 0 ? fmtMoney(m.total) : '—'}
                                                    </td>
                                                    <td style={{ padding: '12px' }}>
                                                        {mr !== null
                                                            ? <span style={{ backgroundColor: mr >= 0 ? 'color-mix(in srgb, var(--c-positive) 12%, transparent)' : 'color-mix(in srgb, var(--c-danger) 12%, transparent)', color: pnlColor(mr), padding: '3px 10px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 }}>{fmtPct(mr)}</span>
                                                            : <span style={{ color: 'var(--c-muted)' }}>—</span>}
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </>
                )}

                {tab === 'snapshot' && !loadError && (
                    <>
                        <div style={{ marginBottom: '20px' }}>
                            <h2 style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 700, color: 'var(--c-text)', margin: '0 0 4px' }}>投資績效報告</h2>
                            <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: 0 }}>帳戶年化報酬（XIRR）</p>
                        </div>

                        {Object.keys(assetSnapshots).length < 2 ? (
                            <div style={{ ...card, textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>
                                <p style={{ fontSize: '15px' }}>資料不足</p>
                                <p style={{ fontSize: '13px', marginTop: '8px' }}>請先在「資產趨勢」頁面至少記錄 2 筆以上的資產快照才能計算績效</p>
                            </div>
                        ) : (
                            <>
                                <div className="snap-stats">
                                    {[
                                        { label: '整體 XIRR', value: overallCAGR !== null ? `${overallCAGR >= 0 ? '+' : ''}${overallCAGR.toFixed(2)}%` : '—', color: overallCAGR !== null ? pnlColor(overallCAGR) : 'var(--c-muted)', desc: '年化報酬（排除出入金）' },
                                        { label: '記錄年數', value: `${(() => { const d = Object.keys(assetSnapshots).sort(); if (d.length < 2) return 0; return ((new Date(d[d.length - 1]).getTime() - new Date(d[0]).getTime()) / (365.25 * 24 * 60 * 60 * 1000)).toFixed(1) })()}`, color: 'var(--c-accent)', desc: '年' },
                                        { label: '最新總資產', value: `$${(assetSnapshots[Object.keys(assetSnapshots).sort().pop()!] || 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: 'var(--c-accent)', desc: '最近一筆快照' },
                                        { label: '起始資產', value: `$${(assetSnapshots[Object.keys(assetSnapshots).sort()[0]] || 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: 'var(--c-muted)', desc: '第一筆快照' },
                                    ].map(({ label, value, color, desc }) => (
                                        <div key={label} style={card}>
                                            <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '4px' }}>{label}</div>
                                            <div style={{ fontSize: 'clamp(18px, 2vw, 22px)', fontWeight: 700, color, marginBottom: '4px' }}>{value}</div>
                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)' }}>{desc}</div>
                                        </div>
                                    ))}
                                </div>

                                <div style={{ ...card, marginBottom: '20px' }}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '4px' }}>自訂區間年化報酬（XIRR）</div>
                                    <DisclosureNote summary="帳戶績效依快照與出入金估算。" style={{ margin: '0 0 12px' }}>歷史端點採當日保存的快照；今日無快照時採完整有效報價。出入金依實際轉帳日，股利與買賣已含於淨值。</DisclosureNote>
                                    {perfConfig.startDate && <div style={{ fontSize: '12px', color: 'var(--c-accent)', marginBottom: '8px' }}>績效起始：{perfConfig.startDate}</div>}
                                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                                        <div>
                                            <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>起始日期</label>
                                            <input type="date" style={inp} value={customStart} onChange={e => { setCustomStart(e.target.value); customRequestRef.current++; setPerfLoading(false); setCustomCAGR(null); setCustomMessage(''); setCustomBasis('') }} />
                                        </div>
                                        <div>
                                            <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>結束日期</label>
                                            <input type="date" style={inp} value={customEnd} onChange={e => { setCustomEnd(e.target.value); customRequestRef.current++; setPerfLoading(false); setCustomCAGR(null); setCustomMessage(''); setCustomBasis('') }} />
                                        </div>
                                        <button onClick={calcCustomCAGR}
                                            disabled={perfLoading || !customStart || !customEnd || customStart >= customEnd}
                                            style={{ backgroundColor: 'var(--c-button-accent)', border: 'none', borderRadius: '8px', padding: '8px 20px', color: 'var(--c-on-accent)', fontSize: '14px', cursor: 'pointer', opacity: (!customStart || !customEnd || customStart >= customEnd) ? 0.5 : 1 }}>
                                            {perfLoading ? '計算中...' : '計算'}
                                        </button>
                                    </div>
                                    {customMessage && <div role="status" style={{ marginTop: '12px', color: 'var(--c-warning)', fontSize: '13px' }}>{customMessage}</div>}
                                    {customBasis && <div style={{ marginTop: '8px', color: 'var(--c-muted)', fontSize: '12px' }}>{customBasis}</div>}
                                    {customCAGR !== null && (
                                        <div style={{ marginTop: '16px', backgroundColor: customCAGR >= 0 ? 'rgba(0,200,150,0.1)' : 'rgba(255,87,87,0.1)', border: `1px solid ${customCAGR >= 0 ? 'rgba(0,200,150,0.3)' : 'rgba(255,87,87,0.3)'}`, borderRadius: '10px', padding: '16px 24px', display: 'inline-flex', flexDirection: 'column', gap: '4px' }}>
                                            <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>年化報酬（XIRR）</span>
                                            <span style={{ fontSize: '32px', fontWeight: 700, color: pnlColor(customCAGR) }}>{customCAGR >= 0 ? '+' : ''}{customCAGR.toFixed(2)}%</span>
                                            <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>
                                                365 天年化
                                            </span>
                                        </div>
                                    )}
                                </div>

                                {perfChartData.length >= 2 && (
                                    <div style={{ ...card, marginBottom: '20px' }}>
                                        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '20px' }}>年度報酬率趨勢（XIRR）</div>
                                        <ResponsiveContainer width="100%" height={280}>
                                            <BarChart data={perfChartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="var(--c-border)" />
                                                <XAxis dataKey="year" tick={{ fill: 'var(--c-muted)', fontSize: 12 }} />
                                                <YAxis tick={{ fill: 'var(--c-muted)', fontSize: 12 }} tickFormatter={v => `${v}%`} width={50} />
                                                <Tooltip content={<CustomTooltip />} />
                                                <Bar dataKey="年度報酬率%" fill="var(--c-positive)" radius={[4, 4, 0, 0]} />
                                            </BarChart>
                                        </ResponsiveContainer>
                                    </div>
                                )}

                                <div style={card}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>年度績效明細（報酬率為 XIRR，已排除出入金）</div>
                                    <div style={{ overflowX: 'auto' }}>
                                        <table className="perf-table">
                                            <thead>
                                                <tr>{['年度', '年初資產', '年末資產', '年度報酬率', 'XIRR'].map(h => <th key={h}>{h}</th>)}</tr>
                                            </thead>
                                            <tbody>
                                                {yearlyPerf.map(p => (
                                                    <tr key={p.year} title={p.reason || undefined}>
                                                        <td style={{ color: 'var(--c-accent)', fontWeight: 600 }}>{p.year}</td>
                                                        <td>${p.startValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                                        <td>${p.endValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                                        <td style={{ color: p.totalReturn === null ? 'var(--c-muted)' : pnlColor(p.totalReturn), fontWeight: 600 }}>{p.totalReturn === null ? '—' : fmtPct(p.totalReturn)}</td>
                                                        <td style={{ color: p.cagr === null ? 'var(--c-muted)' : pnlColor(p.cagr), fontWeight: 600 }}>{p.cagr === null ? '—' : fmtPct(p.cagr)}</td>
                                                    </tr>
                                                ))}
                                                {yearlyPerf.length > 0 && (() => {
                                                    const dates = Object.keys(assetSnapshots).sort()
                                                    const sv = assetSnapshots[dates[0]] || 0, ev = assetSnapshots[dates[dates.length - 1]] || 0
                                                    return (
                                                        <tr style={{ borderTop: '2px solid var(--c-border)', backgroundColor: 'color-mix(in srgb, var(--c-accent) 5%, transparent)' }}>
                                                            <td style={{ color: 'var(--c-text)', fontWeight: 700 }}>整體</td>
                                                            <td>${sv.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                                            <td>${ev.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                                            <td style={{ color: overallCAGR !== null ? pnlColor(overallCAGR) : 'var(--c-muted)', fontWeight: 600 }}>
                                                                {overallCAGR !== null ? `${overallCAGR >= 0 ? '+' : ''}${overallCAGR.toFixed(2)}%` : '—'}
                                                            </td>
                                                            <td style={{ color: overallCAGR !== null ? pnlColor(overallCAGR) : 'var(--c-muted)', fontWeight: 700 }}>
                                                                {overallCAGR !== null ? `${overallCAGR >= 0 ? '+' : ''}${overallCAGR.toFixed(2)}%` : '—'}
                                                            </td>
                                                        </tr>
                                                    )
                                                })()}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </>
                        )}
                    </>
                )}

                {tab === 'performance' && (
                    xirrLoading
                        ? <div style={{ textAlign: 'center', padding: '80px', color: 'var(--c-muted)' }}>計算中...</div>
                        : (
                            <>
                                {/* ── XIRR 統計卡片 ── */}
                                <div className="perf-stats">
                                    <div style={card}>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>年化報酬率（XIRR）</div>
                                        <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: xirr !== null ? pnlColor(xirr) : 'var(--c-muted)' }}>
                                            {xirr !== null ? fmtPct(xirr * 100) : '—'}
                                        </div>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginTop: '6px' }}>
                                            {performanceMessage}
                                        </div>
                                        {/* ✅ XIRR 無法計算時說明原因，避免用戶誤以為功能故障 */}
                                        {xirr === null && !xirrLoading && (
                                            <div style={{ fontSize: '11px', color: 'var(--c-warning)', marginTop: '8px', lineHeight: 1.5 }}>
                                                {performanceMessage || '尚缺有效快照或現金流，無法計算 XIRR。'}
                                            </div>
                                        )}
                                    </div>
                                    <div style={card}>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>最大回撤（MDD）</div>
                                        <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: mdd !== null && mdd > 0.1 ? 'var(--c-danger)' : 'var(--c-text)' }}>
                                            {mdd !== null ? `-${(mdd * 100).toFixed(2)}%` : '—'}
                                        </div>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginTop: '6px' }}>依每日快照排除出入金估算；估值或資金流資料不完整時顯示 —</div>
                                    </div>
                                    <div style={card}>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>交易勝率</div>
                                        <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: winRate !== null ? (winRate >= 50 ? 'var(--c-positive)' : 'var(--c-danger)') : 'var(--c-muted)' }}>
                                            {winRate !== null ? `${winRate.toFixed(1)}%` : '—'}
                                        </div>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginTop: '6px' }}>{totalWins} 勝 / {totalTrades - totalWins} 敗（共 {totalTrades} 筆）</div>
                                    </div>
                                    <div style={card}>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>平均持有天數</div>
                                        <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: 'var(--c-text)' }}>
                                            {avgHoldingDays !== null ? `${Math.round(avgHoldingDays)} 天` : '—'}
                                        </div>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginTop: '6px' }}>
                                            {avgHoldingDays !== null ? avgHoldingDays < 7 ? '短線為主' : avgHoldingDays < 30 ? '波段操作' : '中長線持有' : ''}
                                        </div>
                                    </div>
                                </div>

                                {/* ── 自訂區間統計（套用於整頁：XIRR / MDD / 勝率 / 平均持有天數） ── */}
                                <div style={{ ...card, marginBottom: '20px' }}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '4px' }}>自訂區間統計</div>
                                    <DisclosureNote summary="統計所選期間的交易。" style={{ margin: '0 0 12px' }}>XIRR 與回撤依所選期間的每日快照估算；勝率及持有天數使用期間交易。</DisclosureNote>
                                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                                        <div>
                                            <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>起始日期</label>
                                            <input type="date" style={inp} value={rangeStart} onChange={e => { setRangeStart(e.target.value); setRangeStats(null) }} />
                                        </div>
                                        <div>
                                            <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>結束日期</label>
                                            <input type="date" style={inp} value={rangeEnd} onChange={e => { setRangeEnd(e.target.value); setRangeStats(null) }} />
                                        </div>
                                        <button
                                            onClick={calcRangeStats}
                                            disabled={rangeLoading || !rangeStart || !rangeEnd || rangeStart >= rangeEnd}
                                            style={{ backgroundColor: 'var(--c-button-accent)', border: 'none', borderRadius: '8px', padding: '8px 20px', color: 'var(--c-on-accent)', fontSize: '14px', cursor: 'pointer', opacity: (!rangeStart || !rangeEnd || rangeStart >= rangeEnd) ? 0.5 : 1 }}>
                                            {rangeLoading ? '計算中...' : '計算'}
                                        </button>

                                        {rangeStats === null && !rangeLoading && rangeStart && rangeEnd && rangeStart < rangeEnd && (
                                            <span style={{ fontSize: '12px', color: 'var(--c-muted)', alignSelf: 'center' }}>
                                                點「計算」取得這段區間的統計
                                            </span>
                                        )}
                                    </div>

                                    {/* 快速區間按鈕 */}
                                    <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: '12px', color: 'var(--c-muted)', alignSelf: 'center', marginRight: '4px' }}>快速選擇：</span>
                                        {[
                                            { label: '近 1 年', years: 1 },
                                            { label: '近 2 年', years: 2 },
                                            { label: '近 3 年', years: 3 },
                                            { label: '近 5 年', years: 5 },
                                        ].map(({ label, years: y }) => {
                                            const end = toLocalDateString()
                                            const start = toLocalDateString(new Date(Date.now() - y * 365.25 * 86400000))
                                            return (
                                                <button key={label} onClick={() => { setRangeStart(start); setRangeEnd(end); setRangeStats(null) }}
                                                    style={{ backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '4px 12px', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>
                                                    {label}
                                                </button>
                                            )
                                        })}
                                        {years.map(y => (
                                            <button key={y} onClick={() => {
                                                setRangeStart(`${y}-01-01`)
                                                setRangeEnd(`${y}-12-31`)
                                                setRangeStats(null)
                                            }}
                                                style={{ backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '4px 12px', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>
                                                {y} 年
                                            </button>
                                        ))}
                                    </div>

                                    {/* 區間統計結果：與上方全歷史卡片相同排版，方便對照 */}
                                    {rangeMessage && <div role="status" style={{fontSize: '12px', color: 'var(--c-warning)', marginBottom: '8px'}}>{rangeMessage}</div>}
                                    {rangeStats && (
                                        <>
                                            <div className="perf-stats" style={{ marginTop: '20px' }}>
                                                <div style={{ ...card, backgroundColor: 'var(--c-bg)' }}>
                                                    <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>區間年化報酬率（XIRR）</div>
                                                    <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: rangeStats.xirr !== null ? pnlColor(rangeStats.xirr) : 'var(--c-muted)' }}>
                                                        {rangeStats.xirr !== null ? fmtPct(rangeStats.xirr * 100) : '—'}
                                                    </div>
                                                </div>
                                                <div style={{ ...card, backgroundColor: 'var(--c-bg)' }}>
                                                    <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>區間最大回撤（MDD）</div>
                                                    <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: rangeStats.mdd !== null && rangeStats.mdd > 0.1 ? 'var(--c-danger)' : 'var(--c-text)' }}>
                                                        {rangeStats.mdd !== null ? `-${(rangeStats.mdd * 100).toFixed(2)}%` : '—'}
                                                    </div>
                                                </div>
                                                <div style={{ ...card, backgroundColor: 'var(--c-bg)' }}>
                                                    <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>區間勝率</div>
                                                    <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: rangeStats.winRate !== null ? (rangeStats.winRate >= 50 ? 'var(--c-positive)' : 'var(--c-danger)') : 'var(--c-muted)' }}>
                                                        {rangeStats.winRate !== null ? `${rangeStats.winRate.toFixed(1)}%` : '—'}
                                                    </div>
                                                    <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginTop: '6px' }}>{rangeStats.wins} 勝 / {rangeStats.total - rangeStats.wins} 敗（共 {rangeStats.total} 筆）</div>
                                                </div>
                                                <div style={{ ...card, backgroundColor: 'var(--c-bg)' }}>
                                                    <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>區間平均持有天數</div>
                                                    <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: 'var(--c-text)' }}>
                                                        {rangeStats.avgHoldingDays !== null ? `${Math.round(rangeStats.avgHoldingDays)} 天` : '—'}
                                                    </div>
                                                </div>
                                            </div>
                                            <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginTop: '8px' }}>
                                                統計區間：{rangeStart} ～ {rangeEnd}
                                            </div>
                                        </>
                                    )}
                                </div>

                                {/* ── 各年度已實現績效 ── */}
                                <div style={{ ...card, marginBottom: '20px' }}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>各年度已實現績效</div>
                                    {yearStats.length === 0
                                        ? <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)' }}>尚無已實現交易紀錄</div>
                                        : (
                                            <div style={{ overflowX: 'auto' }}>
                                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                                                    <thead>
                                                        <tr style={{ borderBottom: '1px solid var(--c-border)' }}>
                                                            {['年度', '已實現損益', '股利收入', '合計', '已實現報酬率', '帳戶年化報酬', '勝率', '交易筆數'].map(h => (
                                                                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: 'var(--c-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {yearStats.map(y => (
                                                            <tr key={y.year} style={{ borderBottom: '1px solid var(--c-border)' }}>
                                                                <td style={{ padding: '12px', color: 'var(--c-accent)', fontWeight: 700 }}>{y.year}</td>
                                                                <td style={{ padding: '12px', color: pnlColor(y.realized), fontWeight: 600 }}>{fmtMoney(y.realized)}</td>
                                                                <td style={{ padding: '12px', color: 'var(--c-accent)', fontWeight: 600 }}>+${y.dividend.toLocaleString()}</td>
                                                                <td style={{ padding: '12px', color: pnlColor(y.total), fontWeight: 700 }}>{fmtMoney(y.total)}</td>
                                                                <td style={{ padding: '12px' }}>
                                                                    {y.returnRate !== null
                                                                        ? <span style={{ backgroundColor: y.returnRate >= 0 ? 'color-mix(in srgb, var(--c-positive) 12%, transparent)' : 'color-mix(in srgb, var(--c-danger) 12%, transparent)', color: pnlColor(y.returnRate), padding: '2px 8px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 }}>{fmtPct(y.returnRate)}</span>
                                                                        : '—'}
                                                                </td>
                                                                {/* Verified NAV endpoints use the same account XIRR as the annual review. */}
                                                                <td style={{ padding: '12px' }}>
                                                                    {y.totalReturnRate !== null
                                                                        ? <span style={{ backgroundColor: y.totalReturnRate >= 0 ? 'color-mix(in srgb, var(--c-positive) 12%, transparent)' : 'color-mix(in srgb, var(--c-danger) 12%, transparent)', color: pnlColor(y.totalReturnRate), padding: '2px 8px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 }}>{fmtPct(y.totalReturnRate)}</span>
                                                                        : '—'}
                                                                </td>
                                                                <td style={{ padding: '12px', color: y.winRate !== null ? (y.winRate >= 50 ? 'var(--c-positive)' : 'var(--c-danger)') : 'var(--c-muted)', fontWeight: 600 }}>
                                                                    {y.winRate !== null ? `${y.winRate.toFixed(1)}%` : '—'}
                                                                </td>
                                                                <td style={{ padding: '12px', color: 'var(--c-muted)' }}>{y.tradeCount} 筆</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        )}
                                </div>

                                {/* ── 月份損益熱力圖 ── */}
                                <div style={{ ...card, marginBottom: '20px' }}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>月份損益熱力圖（全歷史）</div>
                                    {heatYears.length === 0
                                        ? <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)' }}>尚無資料</div>
                                        : (
                                            <div style={{ overflowX: 'auto' }}>
                                                <table style={{ borderCollapse: 'separate', borderSpacing: '4px', fontSize: '12px' }}>
                                                    <thead>
                                                        <tr>
                                                            <th style={{ padding: '4px 8px', color: 'var(--c-muted)', fontWeight: 500, textAlign: 'left', minWidth: '48px' }} />
                                                            {Array.from({ length: 12 }, (_, i) => (
                                                                <th key={i} style={{ padding: '4px 8px', color: 'var(--c-muted)', fontWeight: 500, textAlign: 'center', minWidth: '54px' }}>{i + 1}月</th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {heatYears.map(yr => (
                                                            <tr key={yr}>
                                                                <td style={{ padding: '4px 8px', color: 'var(--c-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{yr}</td>
                                                                {Array.from({ length: 12 }, (_, i) => {
                                                                    const mo = `${yr}-${String(i + 1).padStart(2, '0')}`
                                                                    const val = heatmapData[mo]
                                                                    return (
                                                                        <td key={i} style={{ padding: '6px 4px', borderRadius: '6px', textAlign: 'center', backgroundColor: val !== undefined ? heatColor(val, heatMax) : 'var(--c-sidebar)', color: val !== undefined ? (val >= 0 ? 'var(--c-positive)' : 'var(--c-danger)') : 'var(--c-border)', fontWeight: 600, minWidth: '54px', fontSize: '11px', whiteSpace: 'nowrap' }}>
                                                                            {val !== undefined ? `${val >= 0 ? '+' : ''}${(val / 1000).toFixed(1)}K` : '—'}
                                                                        </td>
                                                                    )
                                                                })}
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        )}
                                </div>

                                {/* ── 已實現交易明細 ── */}
                                <div style={card}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '16px' }}>
                                        已實現交易明細（最近 {Math.min(realizedTrades.length, 50)} 筆）
                                    </div>
                                    {realizedTrades.length === 0
                                        ? <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)' }}>尚無已實現交易</div>
                                        : (
                                            <div style={{ overflowX: 'auto' }}>
                                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                                                    <thead>
                                                        <tr style={{ borderBottom: '1px solid var(--c-border)' }}>
                                                            {['賣出日', '代號', '名稱', '持有天數', '損益', '報酬率'].map(h => (
                                                                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: 'var(--c-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {realizedTrades.slice(0, 50).map((r, i) => (
                                                            <tr key={i} style={{ borderBottom: '1px solid var(--c-border)' }}>
                                                                <td style={{ padding: '12px', color: 'var(--c-muted)' }}>{r.date}</td>
                                                                <td style={{ padding: '12px', color: 'var(--c-accent)', fontWeight: 700 }}>{r.code}{r.category === 'dayTrade' ? '（當沖）' : ''}</td>
                                                                <td style={{ padding: '12px', color: 'var(--c-text)' }}>{r.name}</td>
                                                                <td style={{ padding: '12px', color: 'var(--c-muted)' }}>{r.holdingDays.toFixed(1)} 天</td>
                                                                <td style={{ padding: '12px', color: pnlColor(r.pnl), fontWeight: 600 }}>{fmtMoney(r.pnl)}</td>
                                                                <td style={{ padding: '12px' }}>
                                                                    <span style={{ backgroundColor: r.returnRate >= 0 ? 'color-mix(in srgb, var(--c-positive) 12%, transparent)' : 'color-mix(in srgb, var(--c-danger) 12%, transparent)', color: pnlColor(r.returnRate), padding: '3px 10px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 }}>
                                                                        {fmtPct(r.returnRate)}
                                                                    </span>
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        )}
                                </div>
                            </>
                        )
                )}
            </div>
        </>
    )
}
