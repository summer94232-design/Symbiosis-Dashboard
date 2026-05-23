// YearReview.tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { collection, getDocs, orderBy, query, doc, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { type TradeRecord } from '../../lib/calc'


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
    cagr: number
    totalReturn: number
}

interface RealizedTrade {
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
    winRate: number | null
    tradeCount: number
}

interface BarChartEntry {
    year: string
    '年度報酬率%': number
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

// ── 原始現金流（供 XIRR 區間計算使用）──
interface RawCashflow {
    date: string
    amount: number // 負 = 流出（買入/入金），正 = 流入（賣出/出金/股利）
}

// ── 出入金（供 snapshot 分頁排除增資影響）──
// amount 約定：入金 = 負（資金流出口袋、流入帳戶），出金 = 正
// 與 XIRR 期初(負)、期末(正) 方向一致
interface AccountCashflow {
    date: string
    amount: number
}

function calcXIRR(cashflows: { date: string; amount: number }[]): number | null {
    if (cashflows.length < 2) return null
    const t0 = new Date(cashflows[0].date).getTime()
    const days = cashflows.map(cf => (new Date(cf.date).getTime() - t0) / 86400000)
    const amounts = cashflows.map(cf => cf.amount)
    const npv = (rate: number) =>
        amounts.reduce((s, a, i) => s + a / Math.pow(1 + rate, days[i] / 365.25), 0)
    let lo = -0.999, hi = 100.0
    if (Math.sign(npv(lo)) === Math.sign(npv(hi))) return null
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2
        if (Math.abs(hi - lo) < 1e-8) return mid
        if (Math.sign(npv(mid)) === Math.sign(npv(lo))) lo = mid
        else hi = mid
    }
    return (lo + hi) / 2
}

function calcMDD(curve: number[]): number {
    let peak = -Infinity, maxDD = 0
    for (const v of curve) {
        if (v > peak) peak = v
        const dd = peak > 0 ? (peak - v) / peak : 0
        if (dd > maxDD) maxDD = dd
    }
    return maxDD
}

function heatColor(val: number, max: number): string {
    if (max === 0) return 'var(--c-border)'
    const r = Math.min(Math.abs(val) / max, 1)
    if (val > 0) return `rgba(0,200,150,${(0.15 + r * 0.65).toFixed(2)})`
    if (val < 0) return `rgba(255,87,87,${(0.15 + r * 0.65).toFixed(2)})`
    return 'var(--c-card)'
}

function calcCAGR(startValue: number, endValue: number, years: number): number {
    if (startValue <= 0 || years <= 0) return 0
    return (Math.pow(endValue / startValue, 1 / years) - 1) * 100
}

const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 12px', color: 'var(--c-text)', fontSize: '14px', outline: 'none' }
const pnlColor = (v: number) => v >= 0 ? 'var(--c-positive)' : 'var(--c-danger)'
const fmtMoney = (v: number) => `${v >= 0 ? '+' : ''}$${Math.abs(v).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`
const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`

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
    const [tab, setTab] = useState<'review' | 'snapshot' | 'performance'>('review')

    const [monthlyData, setMonthlyData] = useState<MonthlyPnL[]>([])
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear())
    const [startMonth, setStartMonth] = useState(1)
    const [endMonth, setEndMonth] = useState(12)
    const [loading, setLoading] = useState(true)
    const [years, setYears] = useState<number[]>([])

    const [yearlyPerf, setYearlyPerf] = useState<YearlyPerf[]>([])
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [customCAGR, setCustomCAGR] = useState<number | null>(null)
    const [assetSnapshots, setAssetSnapshots] = useState<Record<string, number>>({})
    const [perfLoading, setPerfLoading] = useState(false)
    const [perfConfig, setPerfConfig] = useState<{ startDate: string | null; startValue: number | null }>({ startDate: null, startValue: null })
    const allTradesRef = useRef<TradeRecord[]>([])
    const allDividendsRef = useRef<{ date: string; cashDividend: number }[]>([])
    // ✅ 新增：出入金快取（snapshot 分頁排除增資影響用），入金=負/出金=正
    const allCashflowsRef = useRef<AccountCashflow[]>([])
    // ── 快取：原始資料載入一次後存在 ref，切換年份只重算 ──
    const rawDataLoadedRef = useRef(false)
    const savedPricesRef = useRef<Record<string, number | string>>({})

    const [xirr, setXirr] = useState<number | null>(null)
    const [xirrCost, setXirrCost] = useState<number | null>(null)
    const [mdd, setMdd] = useState<number | null>(null)
    const [winRate, setWinRate] = useState<number | null>(null)
    const [totalWins, setTotalWins] = useState(0)
    const [totalTrades, setTotalTrades] = useState(0)
    const [avgHoldingDays, setAvgHoldingDays] = useState<number | null>(null)
    const [yearStats, setYearStats] = useState<YearStat[]>([])
    const [heatmapData, setHeatmapData] = useState<Record<string, number>>({})
    const [realizedTrades, setRealizedTrades] = useState<RealizedTrade[]>([])
    const [xirrLoading, setXirrLoading] = useState(true)

    // ── XIRR 區間篩選 ──
    const [xirrRangeStart, setXirrRangeStart] = useState('')
    const [xirrRangeEnd, setXirrRangeEnd] = useState('')
    const [xirrRange, setXirrRange] = useState<number | null>(null)
    const [xirrRangeLoading, setXirrRangeLoading] = useState(false)
    // 儲存原始現金流供區間重算（loadPerformance 後設定）
    const rawCashflowsRef = useRef<RawCashflow[]>([])
    // 儲存每一天的持倉快照（日期 → {code: {shares, avgCost}}）供區間估算用
    const posSnapshotRef = useRef<{
        dates: string[]
        snapshots: Record<string, Record<string, { shares: number; avgCost: number }>>
        savedPrices: Record<string, number | string>
    }>({ dates: [], snapshots: {}, savedPrices: {} })

    // ✅ 修正：年度報酬率改用 XIRR，排除出入金（增資）影響。
    //   原本 (年末資產 − 年初資產) / 年初資產 會把入金當成獲利而高估。
    //   新做法：把每年視為一段現金流，期初淨值=流出(負)、區間出入金、區間股利、期末淨值=流入(正)，
    //   以 XIRR 求年化報酬，金額多寡與時點都不再扭曲報酬率。
    const calcYearlyPerf = useCallback((
        allYears: number[],
        snapshots: Record<string, number>,
        _trades: TradeRecord[],
        cashflows: AccountCashflow[],
        dividends: { date: string; cashDividend: number }[]
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

            // 組現金流：期初淨值(負) + 區間出入金(入金負/出金正) + 區間股利(正) + 期末淨值(正)
            const cf: { date: string; amount: number }[] = [{ date: startDate, amount: -startValue }]
            cashflows
                .filter(c => c.date > startDate && c.date <= endDate)
                .forEach(c => cf.push({ date: c.date, amount: c.amount }))
            dividends
                .filter(dv => dv.date > startDate && dv.date <= endDate && dv.cashDividend > 0)
                .forEach(dv => cf.push({ date: dv.date, amount: dv.cashDividend }))
            cf.push({ date: endDate, amount: endValue })

            const xirr = calcXIRR(cf.sort((a, b) => a.date.localeCompare(b.date)))
            const annualized = xirr != null ? xirr * 100 : 0

            perf.push({
                year, startValue, endValue, invested,
                cagr: annualized,        // XIRR 年化（已排除出入金）
                totalReturn: annualized  // 與 cagr 同口徑，圖表/表格皆顯示真實年化報酬
            })
        })
        setYearlyPerf(perf)
    }, [])

    // ── 根據已快取的 trades/dividends 重算指定年份的月度資料（不讀 Firestore）──
    const calcMonthlyForYear = useCallback((year: number, trades: TradeRecord[], dividends: { date: string; cashDividend: number }[]) => {
        const pos: Record<string, { shares: number; avgCost: number; totalCost: number }> = {}
        const monthlyRealized: Record<string, number> = {}
        const monthlyCost: Record<string, number> = {}
        const monthlyDividend: Record<string, number> = {}

        for (const t of trades) {
            const { code, type, price, shares, fee, tax, date } = t
            if (!pos[code]) pos[code] = { shares: 0, avgCost: 0, totalCost: 0 }
            const p = pos[code]
            if (type === 'buy') {
                const bc = price * shares + fee
                p.totalCost += bc; p.shares += shares
                p.avgCost = p.shares > 0 ? p.totalCost / p.shares : 0
            } else {
                const cb = p.avgCost * shares
                const pnl = price * shares - fee - tax - cb
                if (date.slice(0, 4) === String(year)) {
                    const mo = date.slice(0, 7)
                    monthlyRealized[mo] = (monthlyRealized[mo] || 0) + pnl
                    monthlyCost[mo] = (monthlyCost[mo] || 0) + cb
                }
                p.shares -= shares; p.totalCost = p.avgCost * p.shares
                if (p.shares <= 0) { p.shares = 0; p.totalCost = 0; p.avgCost = 0 }
            }
        }

        dividends.forEach(d => {
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
            let trades: TradeRecord[]
            interface DividendRecord { date: string; cashDividend: number }
            let dividends: DividendRecord[]
            let snapshots: Record<string, number>
            let cashflows: AccountCashflow[]

            // ── 只有第一次才讀 Firestore，之後切換年份從快取重算 ──
            if (!rawDataLoadedRef.current) {
                // ✅ 多讀 cashflow，供 snapshot 分頁排除出入金
                const [tradesSnap, dividendsSnap, snapshotsSnap, cashflowSnap] = await Promise.all([
                    getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'asc'))),
                    getDocs(query(userCol(investDB, 'dividends'), orderBy('date', 'asc'))),
                    getDocs(query(userCol(investDB, 'assetSnapshots'), orderBy('date', 'asc'))),
                    getDocs(query(userCol(investDB, 'cashflow'), orderBy('date', 'asc')))
                ])

                trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
                dividends = dividendsSnap.docs.map(d => d.data() as DividendRecord)
                snapshots = {}
                snapshotsSnap.docs.forEach(d => { snapshots[d.data().date as string] = d.data().totalAssets as number })
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
                cashflows = cashflowSnap.docs.map(d => {
                    const c = d.data() as { date: string; type: 'in' | 'out'; amount: number }
                    return { date: c.date, amount: c.type === 'in' ? -c.amount : c.amount }
                })

                allTradesRef.current = trades
                allDividendsRef.current = dividends
                allCashflowsRef.current = cashflows

                // 讀取設定與現價（只需一次）
                getDoc(userDocNested(investDB, 'settings', 'performanceConfig')).then(pd => {
                    if (pd.exists()) setPerfConfig({ startDate: pd.data().startDate || null, startValue: pd.data().startValue || null })
                }).catch(() => { })
                getDoc(userDocNested(investDB, 'settings', 'lastPrices')).then(pd => {
                    savedPricesRef.current = pd.exists() ? pd.data() as Record<string, number | string> : {}
                }).catch(() => { })

                const allDates = [...trades.map(t => t.date), ...dividends.map(d => d.date)]
                const allYears = [...new Set(allDates.map(d => parseInt(d.slice(0, 4))))].sort()
                if (allYears.length > 0) {
                    setYears(allYears)
                    setCustomStart(prev => prev || `${allYears[0]}-01-01`)
                    setCustomEnd(prev => prev || new Date().toISOString().split('T')[0])
                }
                calcYearlyPerf(allYears, snapshots, trades, cashflows, dividends)
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
        } catch (err) { console.error(err) }
        setLoading(false)
    }, [selectedYear, calcYearlyPerf, calcMonthlyForYear, assetSnapshots])

    // ── 切換年份時只重算月度資料，不重讀 Firestore ──
    const handleYearChange = useCallback((year: number) => {
        setSelectedYear(year)
        if (rawDataLoadedRef.current) {
            calcMonthlyForYear(year, allTradesRef.current, allDividendsRef.current)
        }
    }, [calcMonthlyForYear])

    // ✅ 修正：自訂區間 CAGR 改用 XIRR，排除區間內出入金（增資）影響。
    //   期初持倉以成本估值作為流出(負)，期末（持倉市值 + 區間已實現 + 區間股利）作為流入(正)，
    //   區間內的出入金一併納入現金流，XIRR 自動排除增資對報酬率的扭曲。
    const calcCustomCAGR = useCallback(() => {
        if (!customStart || !customEnd || customStart >= customEnd) return
        setPerfLoading(true)

        const trades = allTradesRef.current
        const dividends = allDividendsRef.current
        const cashflows = allCashflowsRef.current
        const savedPrices = savedPricesRef.current

        // 設定頁的起始日配置：實際計算起始點 = max(customStart, perfConfig.startDate)
        const effectiveStart = perfConfig.startDate && perfConfig.startDate > customStart
            ? perfConfig.startDate
            : customStart

        // 期初資產：若設定頁有起始資產且起始日吻合，用那個數字；否則用期初持倉成本推算
        let startValue: number
        if (perfConfig.startValue && perfConfig.startDate && effectiveStart === perfConfig.startDate) {
            startValue = perfConfig.startValue
        } else {
            const posStart: Record<string, { shares: number; avgCost: number; totalCost: number }> = {}
            for (const t of trades) {
                if (t.date > effectiveStart) break
                const { code, type, price, shares, fee } = t
                if (!posStart[code]) posStart[code] = { shares: 0, avgCost: 0, totalCost: 0 }
                const p = posStart[code]
                if (type === 'buy') {
                    const bc = price * shares + (fee || 0)
                    p.totalCost += bc; p.shares += shares
                    p.avgCost = p.shares > 0 ? p.totalCost / p.shares : 0
                } else {
                    p.shares -= shares; p.totalCost = p.avgCost * p.shares
                    if (p.shares <= 0) { p.shares = 0; p.totalCost = 0; p.avgCost = 0 }
                }
            }
            startValue = Object.values(posStart).reduce((s, p) => s + p.totalCost, 0)
        }

        // 跑完 customEnd 前所有交易，得到期末持倉（FIFO）
        const posEnd: Record<string, { shares: number; avgCost: number; totalCost: number; lots: { shares: number; cost: number }[] }> = {}
        let realizedPnL = 0
        for (const t of trades) {
            if (t.date > customEnd) break
            const { code, type, price, shares, fee, tax } = t
            if (!posEnd[code]) posEnd[code] = { shares: 0, avgCost: 0, totalCost: 0, lots: [] }
            const p = posEnd[code]
            if (type === 'buy') {
                const bc = price * shares + (fee || 0)
                p.totalCost += bc; p.shares += shares
                p.avgCost = p.shares > 0 ? p.totalCost / p.shares : 0
                p.lots.push({ shares, cost: bc })
            } else {
                let remaining = shares, totalCb = 0
                while (remaining > 0 && p.lots.length > 0) {
                    const lot = p.lots[0]
                    const uc = lot.cost / lot.shares
                    if (lot.shares <= remaining) {
                        totalCb += lot.cost; remaining -= lot.shares; p.lots.shift()
                    } else {
                        totalCb += remaining * uc; lot.shares -= remaining; lot.cost -= remaining * uc; remaining = 0
                    }
                }
                if (t.date > effectiveStart) {
                    realizedPnL += price * shares - (fee || 0) - (tax || 0) - totalCb
                }
                p.shares -= shares; p.totalCost = p.avgCost * p.shares
                if (p.shares <= 0) { p.shares = 0; p.totalCost = 0; p.avgCost = 0; p.lots = [] }
            }
        }

        const endPortfolioValue = Object.entries(posEnd).reduce((s, [code, p]) => {
            if (p.shares <= 0) return s
            const cp = savedPrices[code]
            return s + (typeof cp === 'number' ? cp * p.shares : p.totalCost)
        }, 0)

        const dividendIncome = dividends
            .filter(d => d.date > effectiveStart && d.date <= customEnd)
            .reduce((s, d) => s + d.cashDividend, 0)

        // 期末總流入：持倉市值（含已實現損益已反映在現金，但此處 endPortfolioValue 僅為剩餘持倉，
        // 故仍需加回區間已實現損益與股利作為回收價值）
        const endValue = endPortfolioValue + realizedPnL + dividendIncome

        if (startValue <= 0 || endValue <= 0) { setCustomCAGR(null); setPerfLoading(false); return }

        // 組現金流：期初(負) + 區間出入金 + 期末(正)，以 XIRR 求年化（排除增資）
        const cf: { date: string; amount: number }[] = [{ date: effectiveStart, amount: -startValue }]
        cashflows
            .filter(c => c.date > effectiveStart && c.date <= customEnd)
            .forEach(c => cf.push({ date: c.date, amount: c.amount }))
        cf.push({ date: customEnd, amount: endValue })

        const xirr = calcXIRR(cf.sort((a, b) => a.date.localeCompare(b.date)))
        if (xirr == null) { setCustomCAGR(null); setPerfLoading(false); return }

        setCustomCAGR(xirr * 100)
        setPerfLoading(false)
    }, [customStart, customEnd, perfConfig])

    // ── 計算 XIRR 區間 ──
    const calcXirrRange = useCallback(() => {
        if (!xirrRangeStart || !xirrRangeEnd) return
        if (xirrRangeStart >= xirrRangeEnd) return
        setXirrRangeLoading(true)

        const { dates: snapDates, snapshots: posSnaps, savedPrices } = posSnapshotRef.current
        const allCfs = rawCashflowsRef.current

        // 過濾出區間內的現金流
        const inRange = allCfs.filter(cf => cf.date >= xirrRangeStart && cf.date <= xirrRangeEnd)

        // 估算期初持倉市值（作為負現金流，代表「在這個時間點投入」）
        // 找最接近 xirrRangeStart 且 <= xirrRangeStart 的快照日期
        const beforeSnap = snapDates.filter(d => d <= xirrRangeStart).sort()
        const startSnapDate = beforeSnap[beforeSnap.length - 1]
        let startPortfolioValue = 0
        if (startSnapDate) {
            const snap = posSnaps[startSnapDate]
            Object.entries(snap).forEach(([code, { shares, avgCost }]) => {
                if (shares <= 0) return
                const cp = savedPrices[code]
                // 用現價估算，若無現價則用成本
                startPortfolioValue += typeof cp === 'number' ? cp * shares : avgCost * shares
            })
        }

        // 估算期末持倉市值（作為正現金流，代表「在這個時間點回收」）
        const afterSnap = snapDates.filter(d => d <= xirrRangeEnd).sort()
        const endSnapDate = afterSnap[afterSnap.length - 1]
        let endPortfolioValue = 0
        if (endSnapDate) {
            const snap = posSnaps[endSnapDate]
            Object.entries(snap).forEach(([code, { shares, avgCost }]) => {
                if (shares <= 0) return
                const cp = savedPrices[code]
                endPortfolioValue += typeof cp === 'number' ? cp * shares : avgCost * shares
            })
        }

        // 組合現金流：期初持倉（負）＋ 區間內現金流 ＋ 期末持倉（正）
        const combined: { date: string; amount: number }[] = []
        if (startPortfolioValue > 0) {
            combined.push({ date: xirrRangeStart, amount: -startPortfolioValue })
        }
        inRange.forEach(cf => combined.push({ date: cf.date, amount: cf.amount }))
        if (endPortfolioValue > 0) {
            combined.push({ date: xirrRangeEnd, amount: endPortfolioValue })
        }

        const sorted = combined.sort((a, b) => a.date.localeCompare(b.date))
        const result = sorted.length >= 2 ? calcXIRR(sorted) : null
        setXirrRange(result)
        setXirrRangeLoading(false)
    }, [xirrRangeStart, xirrRangeEnd])

    const loadPerformance = useCallback(async () => {
        setXirrLoading(true)
        try {
            const tradesSnap = await getDocs(query(userCol(investDB, 'trades'), orderBy('date', 'asc')))
            const allTrades = tradesSnap.docs.map(d => d.data() as TradeRecord)

            interface CashflowRecord { date: string; type: 'in' | 'out'; amount: number }
            const cashSnap = await getDocs(query(userCol(investDB, 'cashflow'), orderBy('date', 'asc')))
            const cashflows = cashSnap.docs.map(d => d.data() as CashflowRecord)

            interface DividendRecord { date: string; cashDividend: number }
            const dividendsSnap = await getDocs(query(userCol(investDB, 'dividends'), orderBy('date', 'asc')))
            const dividends = dividendsSnap.docs.map(d => d.data() as DividendRecord)

            const priceDoc = await getDoc(userDocNested(investDB, 'settings', 'lastPrices'))
            const savedPrices: Record<string, number | string> = priceDoc.exists() ? priceDoc.data() : {}

            const posDetail: Record<string, {
                shares: number; avgCost: number; totalCost: number
                lots: { date: string; shares: number; cost: number }[]
            }> = {}
            const realized: RealizedTrade[] = []
            let runningEquity = 0
            const equityCurve: number[] = []

            // ── 建立持倉快照（每一筆交易後記錄一次）──
            const snapDates: string[] = []
            const posSnapshots: Record<string, Record<string, { shares: number; avgCost: number }>> = {}

            // 收集原始現金流供區間計算
            // 正負號 = XIRR 口徑：入金記負(投入)、出金記正(回收)，與本檔 snapshot 分頁一致
            const rawCfs: RawCashflow[] = []
            cashflows.forEach(cf => {
                rawCfs.push({ date: cf.date, amount: cf.type === 'in' ? -cf.amount : cf.amount })
            })

            for (const t of allTrades) {
                const { code, name, type, price, shares, fee, tax, date } = t
                if (!posDetail[code]) posDetail[code] = { shares: 0, avgCost: 0, totalCost: 0, lots: [] }
                const p = posDetail[code]
                if (type === 'buy') {
                    const bc = price * shares + fee
                    p.totalCost += bc; p.shares += shares; p.avgCost = p.totalCost / p.shares
                    p.lots.push({ date, shares, cost: bc })
                } else {
                    let remaining = shares, totalCb = 0, firstBuyDate = date
                    while (remaining > 0 && p.lots.length > 0) {
                        const lot = p.lots[0]
                        const uc = lot.cost / lot.shares
                        if (lot.shares <= remaining) {
                            totalCb += lot.cost
                            if (firstBuyDate === date) firstBuyDate = lot.date
                            remaining -= lot.shares; p.lots.shift()
                        } else {
                            const portion = remaining * uc
                            totalCb += portion
                            if (firstBuyDate === date) firstBuyDate = lot.date
                            lot.shares -= remaining; lot.cost -= portion; remaining = 0
                        }
                    }
                    const pnl = price * shares - fee - tax - totalCb
                    const holdDays = Math.max(0, Math.round(
                        (new Date(date).getTime() - new Date(firstBuyDate).getTime()) / 86400000
                    ))
                    realized.push({ date, code, name, pnl, costBasis: totalCb, holdingDays: holdDays, returnRate: totalCb > 0 ? (pnl / totalCb) * 100 : 0 })
                    runningEquity += pnl; equityCurve.push(runningEquity)
                    p.shares -= shares; p.totalCost = p.avgCost * p.shares
                    if (p.shares <= 0) { p.shares = 0; p.totalCost = 0; p.avgCost = 0; p.lots = [] }

                    // 賣出的收益加入原始現金流
                    rawCfs.push({ date, amount: price * shares - fee - tax })
                }

                // 每筆交易後儲存持倉快照
                const snap: Record<string, { shares: number; avgCost: number }> = {}
                Object.entries(posDetail).forEach(([c, pd]) => {
                    snap[c] = { shares: pd.shares, avgCost: pd.avgCost }
                })
                if (!snapDates.includes(date)) snapDates.push(date)
                posSnapshots[date] = snap
            }

            // 股利也加入原始現金流
            dividends.forEach(d => {
                if (d.cashDividend > 0) rawCfs.push({ date: d.date, amount: d.cashDividend })
            })

            // 儲存供區間計算使用
            rawCashflowsRef.current = rawCfs.sort((a, b) => a.date.localeCompare(b.date))
            posSnapshotRef.current = {
                dates: snapDates.sort(),
                snapshots: posSnapshots,
                savedPrices
            }

            // 初始化區間日期（如果還沒設定）
            if (rawCfs.length > 0) {
                setXirrRangeStart(prev => prev || rawCfs.map(cf => cf.date).sort()[0])
                setXirrRangeEnd(prev => prev || new Date().toISOString().split('T')[0])
            }

            setRealizedTrades([...realized].reverse())
            const wins = realized.filter(r => r.pnl > 0.5).length
            setTotalWins(wins); setTotalTrades(realized.length)
            setWinRate(realized.length > 0 ? (wins / realized.length) * 100 : null)
            setAvgHoldingDays(realized.length > 0 ? realized.reduce((s, r) => s + r.holdingDays, 0) / realized.length : null)
            setMdd(equityCurve.length > 0 ? calcMDD(equityCurve) : null)

            // 全期 XIRR（出入金 + 股利，終值用現價）
            // 正負號 = XIRR 口徑：入金負、出金正、股利正、期末市值正
            const xirrBase: { date: string; amount: number }[] = []
            cashflows.forEach(cf => { xirrBase.push({ date: cf.date, amount: cf.type === 'in' ? -cf.amount : cf.amount }) })
            dividends.forEach(d => { if (d.cashDividend > 0) xirrBase.push({ date: d.date, amount: d.cashDividend }) })

            let endMV = 0, endCost = 0
            Object.entries(posDetail).forEach(([code, p]) => {
                if (p.shares > 0) {
                    const cp = savedPrices[code] ?? null
                    endMV += typeof cp === 'number' ? cp * p.shares : p.totalCost
                    endCost += p.totalCost
                }
            })

            const today = new Date().toISOString().split('T')[0]
            const mkXirr = (ev: number) => calcXIRR(
                [...xirrBase, { date: today, amount: ev }].sort((a, b) => a.date.localeCompare(b.date))
            )
            setXirr(mkXirr(endMV)); setXirrCost(mkXirr(endCost))

            const allYrs = [...new Set(realized.map(r => parseInt(r.date.slice(0, 4))))].sort()
            const divByYear: Record<number, number> = {}
            dividends.forEach(d => { const y = parseInt(d.date.slice(0, 4)); divByYear[y] = (divByYear[y] || 0) + d.cashDividend })

            setYearStats(allYrs.map(y => {
                const yr = realized.filter(r => r.date.startsWith(String(y)))
                const totalR = yr.reduce((s, r) => s + r.pnl, 0)
                const totalCb = yr.reduce((s, r) => s + r.costBasis, 0)
                const totalD = divByYear[y] || 0
                const w = yr.filter(r => r.pnl > 0.5).length
                return { year: y, realized: totalR, dividend: totalD, total: totalR + totalD, costBasis: totalCb, returnRate: totalCb > 0 ? (totalR / totalCb) * 100 : null, winRate: yr.length > 0 ? (w / yr.length) * 100 : null, tradeCount: yr.length }
            }))

            const heat: Record<string, number> = {}
            const posH: Record<string, { shares: number; avgCost: number; totalCost: number }> = {}
            for (const t of allTrades) {
                const { code, type, price, shares, fee, tax, date } = t
                if (!posH[code]) posH[code] = { shares: 0, avgCost: 0, totalCost: 0 }
                const p = posH[code]
                if (type === 'buy') {
                    const bc = price * shares + fee
                    p.totalCost += bc; p.shares += shares; p.avgCost = p.totalCost / p.shares
                } else {
                    const cb = p.avgCost * shares
                    const pnl = price * shares - fee - tax - cb
                    heat[date.slice(0, 7)] = (heat[date.slice(0, 7)] || 0) + pnl
                    p.shares -= shares; p.totalCost = p.avgCost * p.shares
                    if (p.shares <= 0) { p.shares = 0; p.totalCost = 0; p.avgCost = 0 }
                }
            }
            dividends.forEach(d => { heat[d.date.slice(0, 7)] = (heat[d.date.slice(0, 7)] || 0) + d.cashDividend })
            setHeatmapData(heat)
        } catch (err) { console.error(err) }
        setXirrLoading(false)
    }, [])

    // 初始載入 + selectedYear 變動時重新載入
    useEffect(() => {
        let cancelled = false
        const run = async () => {
            await load()
        }
        if (!cancelled) void run()
        return () => { cancelled = true }
    }, [load])

    // ✅ tab 切換時載入進階績效
    const prevTab = useRef<string>('')
    useEffect(() => {
        if (tab !== 'performance' || prevTab.current === 'performance') return
        prevTab.current = tab
        const timer = setTimeout(() => { void loadPerformance() }, 0)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab])

    const filtered = monthlyData.slice(startMonth - 1, endMonth)
    const totalRealized = filtered.reduce((s, m) => s + m.realized, 0)
    const totalDividend = filtered.reduce((s, m) => s + m.dividend, 0)
    const totalPnL = totalRealized + totalDividend
    const totalCostBasis = filtered.reduce((s, m) => s + m.costBasis, 0)
    const realizedReturnRate = totalCostBasis > 0 ? (totalRealized / totalCostBasis) * 100 : null
    const months = Array.from({ length: 12 }, (_, i) => i + 1)

    // ✅ 修正：整體 CAGR 改用 XIRR（排除全期出入金影響），與年度表同口徑。
    const overallCAGR = (() => {
        const dates = Object.keys(assetSnapshots).sort()
        if (dates.length < 2) return null
        const startDate = dates[0]
        const endDate = dates[dates.length - 1]
        const startValue = assetSnapshots[startDate] || 0
        const endValue = assetSnapshots[endDate] || 0
        if (startValue <= 0 || endValue <= 0) return null

        const cashflows = allCashflowsRef.current
        const dividends = allDividendsRef.current

        const cf: { date: string; amount: number }[] = [{ date: startDate, amount: -startValue }]
        cashflows
            .filter(c => c.date > startDate && c.date <= endDate)
            .forEach(c => cf.push({ date: c.date, amount: c.amount }))
        dividends
            .filter(dv => dv.date > startDate && dv.date <= endDate && dv.cashDividend > 0)
            .forEach(dv => cf.push({ date: dv.date, amount: dv.cashDividend }))
        cf.push({ date: endDate, amount: endValue })

        const xirr = calcXIRR(cf.sort((a, b) => a.date.localeCompare(b.date)))
        return xirr != null ? xirr * 100 : null
    })()

    const perfChartData: BarChartEntry[] = yearlyPerf.map(p => ({
        year: `${p.year}`,
        '年度報酬率%': parseFloat(p.totalReturn.toFixed(2)),
        '年末資產': p.endValue,
        fill: p.totalReturn >= 0 ? 'var(--c-positive)' : 'var(--c-danger)'
    }))

    const filteredWithFill: MonthlyBarEntry[] = filtered.map(m => ({
        ...m,
        realizedFill: m.realized >= 0 ? 'var(--c-positive)' : 'var(--c-danger)'
    }))

    const heatYears = [...new Set(Object.keys(heatmapData).map(k => k.slice(0, 4)))].sort()
    const heatMax = Math.max(...Object.values(heatmapData).map(Math.abs), 1)

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

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>
                <div style={{ marginBottom: '24px' }}>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: '0 0 12px' }}>年度復盤</h1>
                    <div style={{ display: 'inline-flex', backgroundColor: 'var(--c-card)', padding: '4px', borderRadius: '8px', gap: '4px' }}>
                        <button style={tabBtn(tab === 'review')} onClick={() => setTab('review')}>損益分析</button>
                        <button style={tabBtn(tab === 'snapshot')} onClick={() => setTab('snapshot')}>資產快照 CAGR</button>
                        <button style={tabBtn(tab === 'performance')} onClick={() => setTab('performance')}>進階績效</button>
                    </div>
                </div>

                {tab === 'review' && (
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
                            {loading ? <div style={{ textAlign: 'center', padding: '48px', color: 'var(--c-muted)' }}>載入中...</div> : (
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

                {tab === 'snapshot' && (
                    <>
                        <div style={{ marginBottom: '20px' }}>
                            <h2 style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 700, color: 'var(--c-text)', margin: '0 0 4px' }}>投資績效報告</h2>
                            <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: 0 }}>基於資產趨勢快照計算，報酬率採 XIRR 已排除出入金（增資）影響</p>
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
                                    <p style={{ fontSize: '12px', color: 'var(--c-muted)', margin: '0 0 16px' }}>
                                        依交易紀錄推算期初持倉成本與期末市值，並以 XIRR 排除區間內出入金影響
                                        {perfConfig.startDate && <span style={{ color: 'var(--c-accent)' }}>　起{perfConfig.startDate}</span>}
                                    </p>
                                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                                        <div>
                                            <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>起始日期</label>
                                            <input type="date" style={inp} value={customStart} onChange={e => { setCustomStart(e.target.value); setCustomCAGR(null) }} />
                                        </div>
                                        <div>
                                            <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>結束日期</label>
                                            <input type="date" style={inp} value={customEnd} onChange={e => { setCustomEnd(e.target.value); setCustomCAGR(null) }} />
                                        </div>
                                        <button onClick={calcCustomCAGR}
                                            disabled={perfLoading || !customStart || !customEnd || customStart >= customEnd}
                                            style={{ backgroundColor: 'var(--c-accent)', border: 'none', borderRadius: '8px', padding: '8px 20px', color: '#fff', fontSize: '14px', cursor: 'pointer', opacity: (!customStart || !customEnd || customStart >= customEnd) ? 0.5 : 1 }}>
                                            {perfLoading ? '計算中...' : '計算'}
                                        </button>
                                    </div>
                                    {customCAGR !== null && (
                                        <div style={{ marginTop: '16px', backgroundColor: customCAGR >= 0 ? 'rgba(0,200,150,0.1)' : 'rgba(255,87,87,0.1)', border: `1px solid ${customCAGR >= 0 ? 'rgba(0,200,150,0.3)' : 'rgba(255,87,87,0.3)'}`, borderRadius: '10px', padding: '16px 24px', display: 'inline-flex', flexDirection: 'column', gap: '4px' }}>
                                            <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>年化報酬（XIRR）</span>
                                            <span style={{ fontSize: '32px', fontWeight: 700, color: pnlColor(customCAGR) }}>{customCAGR >= 0 ? '+' : ''}{customCAGR.toFixed(2)}%</span>
                                            <span style={{ fontSize: '11px', color: 'var(--c-muted)' }}>
                                                {perfConfig.startDate && perfConfig.startDate > customStart ? perfConfig.startDate : customStart} ～ {customEnd}　已排除出入金
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
                                                    <tr key={p.year}>
                                                        <td style={{ color: 'var(--c-accent)', fontWeight: 600 }}>{p.year}</td>
                                                        <td>${p.startValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                                        <td>${p.endValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                                                        <td style={{ color: pnlColor(p.totalReturn), fontWeight: 600 }}>{p.totalReturn >= 0 ? '+' : ''}{p.totalReturn.toFixed(2)}%</td>
                                                        <td style={{ color: pnlColor(p.cagr), fontWeight: 600 }}>{p.cagr >= 0 ? '+' : ''}{p.cagr.toFixed(2)}%</td>
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
                                            保守估（以成本）：{xirrCost !== null ? fmtPct(xirrCost * 100) : '—'}
                                        </div>
                                        {/* ✅ XIRR 無法計算時說明原因，避免用戶誤以為功能故障 */}
                                        {xirr === null && !xirrLoading && (
                                            <div style={{ fontSize: '11px', color: 'var(--c-warning)', marginTop: '8px', lineHeight: 1.5 }}>
                                                現金流方向不足（需同時有買入與賣出），或資料筆數不足，無法計算 XIRR。
                                            </div>
                                        )}
                                    </div>
                                    <div style={card}>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginBottom: '8px' }}>最大回撤（MDD）</div>
                                        <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: mdd !== null && mdd > 0.1 ? 'var(--c-danger)' : 'var(--c-text)' }}>
                                            {mdd !== null ? `-${(mdd * 100).toFixed(2)}%` : '—'}
                                        </div>
                                        <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginTop: '6px' }}>依已實現損益曲線計算</div>
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

                                {/* ── 自訂區間 XIRR ── */}
                                <div style={{ ...card, marginBottom: '20px' }}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)', marginBottom: '4px' }}>自訂區間 XIRR</div>
                                    <p style={{ fontSize: '12px', color: 'var(--c-muted)', margin: '0 0 16px' }}>
                                        計算指定時間區間內的年化報酬率。期初／期末持倉以成本或現價估值，區間內出入金與股利均納入計算。
                                    </p>
                                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                                        <div>
                                            <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>起始日期</label>
                                            <input type="date" style={inp} value={xirrRangeStart} onChange={e => { setXirrRangeStart(e.target.value); setXirrRange(null) }} />
                                        </div>
                                        <div>
                                            <label style={{ fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }}>結束日期</label>
                                            <input type="date" style={inp} value={xirrRangeEnd} onChange={e => { setXirrRangeEnd(e.target.value); setXirrRange(null) }} />
                                        </div>
                                        <button
                                            onClick={calcXirrRange}
                                            disabled={xirrRangeLoading || !xirrRangeStart || !xirrRangeEnd || xirrRangeStart >= xirrRangeEnd}
                                            style={{ backgroundColor: 'var(--c-accent)', border: 'none', borderRadius: '8px', padding: '8px 20px', color: '#fff', fontSize: '14px', cursor: 'pointer', opacity: (!xirrRangeStart || !xirrRangeEnd || xirrRangeStart >= xirrRangeEnd) ? 0.5 : 1 }}>
                                            {xirrRangeLoading ? '計算中...' : '計算'}
                                        </button>

                                        {xirrRange !== null && (
                                            <div style={{
                                                backgroundColor: xirrRange >= 0 ? 'rgba(0,200,150,0.1)' : 'rgba(255,87,87,0.1)',
                                                border: `1px solid ${xirrRange >= 0 ? 'rgba(0,200,150,0.3)' : 'rgba(255,87,87,0.3)'}`,
                                                borderRadius: '8px', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: '12px'
                                            }}>
                                                <div>
                                                    <div style={{ fontSize: '11px', color: 'var(--c-muted)', marginBottom: '2px' }}>區間 XIRR</div>
                                                    <div style={{ fontSize: '22px', fontWeight: 700, color: pnlColor(xirrRange) }}>
                                                        {fmtPct(xirrRange * 100)}
                                                    </div>
                                                </div>
                                                <div style={{ fontSize: '11px', color: 'var(--c-muted)', lineHeight: 1.6 }}>
                                                    {xirrRangeStart} ～ {xirrRangeEnd}
                                                </div>
                                            </div>
                                        )}

                                        {xirrRange === null && !xirrRangeLoading && xirrRangeStart && xirrRangeEnd && xirrRangeStart < xirrRangeEnd && (
                                            <span style={{ fontSize: '12px', color: 'var(--c-muted)', alignSelf: 'center' }}>
                                                點「計算」取得區間 XIRR
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
                                            const end = new Date().toISOString().split('T')[0]
                                            const start = new Date(Date.now() - y * 365.25 * 86400000).toISOString().split('T')[0]
                                            return (
                                                <button key={label} onClick={() => { setXirrRangeStart(start); setXirrRangeEnd(end); setXirrRange(null) }}
                                                    style={{ backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '4px 12px', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>
                                                    {label}
                                                </button>
                                            )
                                        })}
                                        {years.map(y => (
                                            <button key={y} onClick={() => {
                                                setXirrRangeStart(`${y}-01-01`)
                                                setXirrRangeEnd(`${y}-12-31`)
                                                setXirrRange(null)
                                            }}
                                                style={{ backgroundColor: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: '6px', padding: '4px 12px', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer' }}>
                                                {y} 年
                                            </button>
                                        ))}
                                    </div>
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
                                                            {['年度', '已實現損益', '股利收入', '合計', '已實現報酬率', '勝率', '交易筆數'].map(h => (
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
                                                                <td style={{ padding: '12px', color: 'var(--c-accent)', fontWeight: 700 }}>{r.code}</td>
                                                                <td style={{ padding: '12px', color: 'var(--c-text)' }}>{r.name}</td>
                                                                <td style={{ padding: '12px', color: 'var(--c-muted)' }}>{r.holdingDays} 天</td>
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