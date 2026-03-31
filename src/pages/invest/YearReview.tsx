import { useState, useEffect } from 'react'
import { collection, getDocs, orderBy, query, doc, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { type TradeRecord } from '../../lib/calc'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'

// ─── 型別 ────────────────────────────────────────────────
interface MonthlyPnL {
    month: string
    realized: number
    dividend: number
    total: number
    costBasis: number
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

// ─── XIRR（Brent's method） ───────────────────────────────
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

// ─── MDD（已實現損益累積曲線） ────────────────────────────
function calcMDD(curve: number[]): number {
    let peak = -Infinity, maxDD = 0
    for (const v of curve) {
        if (v > peak) peak = v
        const dd = peak > 0 ? (peak - v) / peak : 0
        if (dd > maxDD) maxDD = dd
    }
    return maxDD
}

// ─── 月份熱力圖顏色 ───────────────────────────────────────
function heatColor(val: number, max: number): string {
    if (max === 0) return '#2e3349'
    const r = Math.min(Math.abs(val) / max, 1)
    if (val > 0) return `rgba(0,200,150,${(0.15 + r * 0.65).toFixed(2)})`
    if (val < 0) return `rgba(255,87,87,${(0.15 + r * 0.65).toFixed(2)})`
    return '#21253a'
}

// ─── 工具 ────────────────────────────────────────────────
const card: React.CSSProperties = {
    backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px'
}
const pnlColor = (v: number) => v >= 0 ? '#00c896' : '#ff5757'
const fmtMoney = (v: number) =>
    `${v >= 0 ? '+' : ''}$${Math.abs(v).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`
const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`

const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    return (
        <div style={{ backgroundColor: '#21253a', border: '1px solid #2e3349', borderRadius: '8px', padding: '12px 16px' }}>
            <p style={{ color: '#8892a4', fontSize: '12px', margin: '0 0 8px' }}>{label}</p>
            {payload.map((p: any) => (
                <p key={p.name} style={{ color: p.color, fontSize: '14px', fontWeight: 600, margin: '2px 0' }}>
                    {p.name}：${Number(p.value).toLocaleString()}
                </p>
            ))}
        </div>
    )
}

// ─── 主元件 ───────────────────────────────────────────────
export default function YearReview() {
    const [tab, setTab] = useState<'review' | 'performance'>('review')

    // 損益分析
    const [monthlyData, setMonthlyData] = useState<MonthlyPnL[]>([])
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear())
    const [startMonth, setStartMonth] = useState(1)
    const [endMonth, setEndMonth] = useState(12)
    const [loading, setLoading] = useState(true)
    const [years, setYears] = useState<number[]>([])

    // 績效指標
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
    const [perfLoading, setPerfLoading] = useState(true)

    // ─── 損益分析載入 ─────────────────────────────────────
    const loadReview = async () => {
        setLoading(true)
        try {
            const tradesSnap = await getDocs(query(collection(investDB, 'trades'), orderBy('date', 'asc')))
            const allTrades = tradesSnap.docs.map(d => d.data() as TradeRecord)
            const dividendsSnap = await getDocs(query(collection(investDB, 'dividends'), orderBy('date', 'asc')))
            const dividends = dividendsSnap.docs.map(d => d.data())

            const allDates = [...allTrades.map(t => t.date), ...dividends.map((d: any) => d.date)]
            const allYears = [...new Set(allDates.map(d => parseInt(d.slice(0, 4))))].sort()
            if (allYears.length > 0) setYears(allYears)

            const pos: Record<string, { shares: number; avgCost: number; totalCost: number }> = {}
            const monthlyRealized: Record<string, number> = {}
            const monthlyCost: Record<string, number> = {}
            const monthlyDividend: Record<string, number> = {}

            for (const t of allTrades) {
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
                    if (date.slice(0, 4) === String(selectedYear)) {
                        const mo = date.slice(0, 7)
                        monthlyRealized[mo] = (monthlyRealized[mo] || 0) + pnl
                        monthlyCost[mo] = (monthlyCost[mo] || 0) + cb
                    }
                    p.shares -= shares
                    p.totalCost = p.avgCost * p.shares
                    if (p.shares <= 0) { p.shares = 0; p.totalCost = 0; p.avgCost = 0 }
                }
            }

            dividends.forEach((d: any) => {
                if (d.date.slice(0, 4) === String(selectedYear)) {
                    const mo = d.date.slice(0, 7)
                    monthlyDividend[mo] = (monthlyDividend[mo] || 0) + d.cashDividend
                }
            })

            const result: MonthlyPnL[] = Array.from({ length: 12 }, (_, i) => {
                const mo = `${selectedYear}-${String(i + 1).padStart(2, '0')}`
                return {
                    month: `${i + 1}月`,
                    realized: monthlyRealized[mo] || 0,
                    dividend: monthlyDividend[mo] || 0,
                    total: (monthlyRealized[mo] || 0) + (monthlyDividend[mo] || 0),
                    costBasis: monthlyCost[mo] || 0,
                }
            })
            setMonthlyData(result)
        } catch (err) { console.error(err) }
        setLoading(false)
    }

    // ─── 績效指標載入 ─────────────────────────────────────
    const loadPerformance = async () => {
        setPerfLoading(true)
        try {
            const tradesSnap = await getDocs(query(collection(investDB, 'trades'), orderBy('date', 'asc')))
            const allTrades = tradesSnap.docs.map(d => d.data() as TradeRecord)
            const cashSnap = await getDocs(query(collection(investDB, 'cashflow'), orderBy('date', 'asc')))
            const cashflows = cashSnap.docs.map(d => d.data())
            const dividendsSnap = await getDocs(query(collection(investDB, 'dividends'), orderBy('date', 'asc')))
            const dividends = dividendsSnap.docs.map(d => d.data())
            const priceDoc = await getDoc(doc(investDB, 'settings', 'lastPrices'))
            const savedPrices: Record<string, any> = priceDoc.exists() ? priceDoc.data() : {}

            // FIFO 追蹤，計算持有天數
            const posDetail: Record<string, {
                shares: number; avgCost: number; totalCost: number
                lots: { date: string; shares: number; cost: number }[]
            }> = {}

            const realized: RealizedTrade[] = []
            let runningEquity = 0
            const equityCurve: number[] = []

            for (const t of allTrades) {
                const { code, name, type, price, shares, fee, tax, date } = t
                if (!posDetail[code]) posDetail[code] = { shares: 0, avgCost: 0, totalCost: 0, lots: [] }
                const p = posDetail[code]

                if (type === 'buy') {
                    const bc = price * shares + fee
                    p.totalCost += bc; p.shares += shares
                    p.avgCost = p.totalCost / p.shares
                    p.lots.push({ date, shares, cost: bc })
                } else {
                    // FIFO 出貨
                    let remaining = shares
                    let totalCb = 0
                    let firstBuyDate = date
                    while (remaining > 0 && p.lots.length > 0) {
                        const lot = p.lots[0]
                        const unitCost = lot.cost / lot.shares
                        if (lot.shares <= remaining) {
                            totalCb += lot.cost
                            if (firstBuyDate === date) firstBuyDate = lot.date
                            remaining -= lot.shares
                            p.lots.shift()
                        } else {
                            const portion = remaining * unitCost
                            totalCb += portion
                            if (firstBuyDate === date) firstBuyDate = lot.date
                            lot.shares -= remaining; lot.cost -= portion
                            remaining = 0
                        }
                    }

                    const sellRev = price * shares - fee - tax
                    const pnl = sellRev - totalCb
                    const holdDays = Math.max(0, Math.round(
                        (new Date(date).getTime() - new Date(firstBuyDate).getTime()) / 86400000
                    ))

                    realized.push({
                        date, code, name, pnl, costBasis: totalCb,
                        holdingDays: holdDays,
                        returnRate: totalCb > 0 ? (pnl / totalCb) * 100 : 0,
                    })

                    runningEquity += pnl
                    equityCurve.push(runningEquity)

                    p.shares -= shares
                    p.totalCost = p.avgCost * p.shares
                    if (p.shares <= 0) { p.shares = 0; p.totalCost = 0; p.avgCost = 0; p.lots = [] }
                }
            }

            setRealizedTrades([...realized].reverse())

            // 統計
            const wins = realized.filter(r => r.pnl > 0).length
            setTotalWins(wins)
            setTotalTrades(realized.length)
            setWinRate(realized.length > 0 ? (wins / realized.length) * 100 : null)
            setAvgHoldingDays(realized.length > 0
                ? realized.reduce((s, r) => s + r.holdingDays, 0) / realized.length : null)
            setMdd(equityCurve.length > 0 ? calcMDD(equityCurve) : null)

            // XIRR：出入金現金流 + 期末持倉市值
            const xirrBase: { date: string; amount: number }[] = []
            cashflows.forEach((cf: any) => {
                xirrBase.push({ date: cf.date, amount: cf.type === 'in' ? -cf.amount : cf.amount })
            })
            dividends.forEach((d: any) => {
                if (d.cashDividend > 0) xirrBase.push({ date: d.date, amount: d.cashDividend })
            })

            let endMV = 0, endCost = 0
            Object.entries(posDetail).forEach(([code, p]) => {
                if (p.shares > 0) {
                    const cp = savedPrices[code] ?? null
                    endMV += cp !== null ? cp * p.shares : p.totalCost
                    endCost += p.totalCost
                }
            })

            const today = new Date().toISOString().split('T')[0]
            const mkXirr = (endVal: number) =>
                calcXIRR([...xirrBase, { date: today, amount: endVal }]
                    .sort((a, b) => a.date.localeCompare(b.date)))

            setXirr(mkXirr(endMV))
            setXirrCost(mkXirr(endCost))

            // 各年度統計
            const allYrs = [...new Set(realized.map(r => parseInt(r.date.slice(0, 4))))].sort()
            const divByYear: Record<number, number> = {}
            dividends.forEach((d: any) => {
                const y = parseInt(d.date.slice(0, 4))
                divByYear[y] = (divByYear[y] || 0) + d.cashDividend
            })
            setYearStats(allYrs.map(y => {
                const yr = realized.filter(r => r.date.startsWith(String(y)))
                const totalR = yr.reduce((s, r) => s + r.pnl, 0)
                const totalCb = yr.reduce((s, r) => s + r.costBasis, 0)
                const totalD = divByYear[y] || 0
                const w = yr.filter(r => r.pnl > 0).length
                return {
                    year: y, realized: totalR, dividend: totalD, total: totalR + totalD,
                    costBasis: totalCb,
                    returnRate: totalCb > 0 ? (totalR / totalCb) * 100 : null,
                    winRate: yr.length > 0 ? (w / yr.length) * 100 : null,
                    tradeCount: yr.length,
                }
            }))

            // 熱力圖（全歷史，含股利）
            const heat: Record<string, number> = {}
            const posH: Record<string, { shares: number; avgCost: number; totalCost: number }> = {}
            for (const t of allTrades) {
                const { code, type, price, shares, fee, tax, date } = t
                if (!posH[code]) posH[code] = { shares: 0, avgCost: 0, totalCost: 0 }
                const p = posH[code]
                if (type === 'buy') {
                    const bc = price * shares + fee
                    p.totalCost += bc; p.shares += shares
                    p.avgCost = p.totalCost / p.shares
                } else {
                    const cb = p.avgCost * shares
                    const pnl = price * shares - fee - tax - cb
                    const mo = date.slice(0, 7)
                    heat[mo] = (heat[mo] || 0) + pnl
                    p.shares -= shares; p.totalCost = p.avgCost * p.shares
                    if (p.shares <= 0) { p.shares = 0; p.totalCost = 0; p.avgCost = 0 }
                }
            }
            dividends.forEach((d: any) => {
                const mo = d.date.slice(0, 7)
                heat[mo] = (heat[mo] || 0) + d.cashDividend
            })
            setHeatmapData(heat)

        } catch (err) { console.error(err) }
        setPerfLoading(false)
    }

    useEffect(() => { loadReview() }, [selectedYear])
    useEffect(() => { if (tab === 'performance') loadPerformance() }, [tab])

    // 損益分析計算
    const filtered = monthlyData.slice(startMonth - 1, endMonth)
    const totalRealized = filtered.reduce((s, m) => s + m.realized, 0)
    const totalDividend = filtered.reduce((s, m) => s + m.dividend, 0)
    const totalPnL = totalRealized + totalDividend
    const totalCostBasis = filtered.reduce((s, m) => s + m.costBasis, 0)
    const realizedReturnRate = totalCostBasis > 0 ? (totalRealized / totalCostBasis) * 100 : null
    const months = Array.from({ length: 12 }, (_, i) => i + 1)

    // 熱力圖
    const heatYears = [...new Set(Object.keys(heatmapData).map(k => k.slice(0, 4)))].sort()
    const heatMax = Math.max(...Object.values(heatmapData).map(Math.abs), 1)

    const tabBtn = (active: boolean): React.CSSProperties => ({
        backgroundColor: active ? '#1a1d27' : 'transparent',
        border: 'none', borderRadius: '6px', padding: '6px 20px',
        color: active ? '#e2e8f0' : '#8892a4',
        fontSize: '14px', cursor: 'pointer', fontWeight: active ? 600 : 400,
    })

    const sel: React.CSSProperties = {
        backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px',
        padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', outline: 'none'
    }

    return (
        <>
            <style>{`
        .review-stats { display: grid; gap: 16px; grid-template-columns: repeat(4, 1fr); margin-bottom: 20px; }
        .perf-stats   { display: grid; gap: 16px; grid-template-columns: repeat(4, 1fr); margin-bottom: 20px; }
        @media (max-width: 900px) { .review-stats, .perf-stats { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .review-stats, .perf-stats { grid-template-columns: 1fr; } }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>

                {/* 標題 + Tab */}
                <div style={{ marginBottom: '24px' }}>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: '0 0 12px' }}>年度復盤</h1>
                    <div style={{ display: 'inline-flex', backgroundColor: '#21253a', padding: '4px', borderRadius: '8px', gap: '4px' }}>
                        <button style={tabBtn(tab === 'review')} onClick={() => setTab('review')}>損益分析</button>
                        <button style={tabBtn(tab === 'performance')} onClick={() => setTab('performance')}>績效指標</button>
                    </div>
                </div>

                {/* ══ 損益分析 ══ */}
                {tab === 'review' && (
                    <>
                        <div style={{ ...card, marginBottom: '20px', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                            <div>
                                <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>年度</label>
                                <select style={sel} value={selectedYear} onChange={e => setSelectedYear(parseInt(e.target.value))}>
                                    {(years.length === 0 ? [new Date().getFullYear()] : years).map(y => <option key={y} value={y}>{y}</option>)}
                                </select>
                            </div>
                            <div>
                                <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>起始月份</label>
                                <select style={sel} value={startMonth} onChange={e => setStartMonth(parseInt(e.target.value))}>
                                    {months.map(m => <option key={m} value={m}>{m} 月</option>)}
                                </select>
                            </div>
                            <div>
                                <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>結束月份</label>
                                <select style={sel} value={endMonth} onChange={e => setEndMonth(parseInt(e.target.value))}>
                                    {months.filter(m => m >= startMonth).map(m => <option key={m} value={m}>{m} 月</option>)}
                                </select>
                            </div>
                        </div>

                        <div className="review-stats">
                            {[
                                { label: '已實現損益', txt: fmtMoney(totalRealized), color: pnlColor(totalRealized) },
                                { label: '股利收入', txt: `$${totalDividend.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: '#4f8ef7' },
                                { label: '合計收益', txt: fmtMoney(totalPnL), color: pnlColor(totalPnL) },
                                { label: '已實現報酬率', txt: realizedReturnRate !== null ? fmtPct(realizedReturnRate) : '—', color: realizedReturnRate !== null ? pnlColor(realizedReturnRate) : '#8892a4' },
                            ].map(({ label, txt, color }) => (
                                <div key={label} style={card}>
                                    <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>{label}</div>
                                    <div style={{ fontSize: 'clamp(16px, 2vw, 22px)', fontWeight: 700, color }}>{txt}</div>
                                </div>
                            ))}
                        </div>

                        <div style={{ ...card, marginBottom: '20px' }}>
                            <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '20px' }}>
                                {selectedYear} 年 {startMonth}–{endMonth} 月 損益分佈
                            </div>
                            {loading ? <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>載入中...</div> : (
                                <ResponsiveContainer width="100%" height={300}>
                                    <BarChart data={filtered} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#2e3349" />
                                        <XAxis dataKey="month" tick={{ fill: '#8892a4', fontSize: 12 }} />
                                        <YAxis tick={{ fill: '#8892a4', fontSize: 12 }} tickFormatter={v => `${(v / 1000).toFixed(0)}K`} width={50} />
                                        <Tooltip content={<CustomTooltip />} />
                                        <Bar dataKey="realized" name="已實現損益" radius={[4, 4, 0, 0]}>
                                            {filtered.map((entry, i) => <Cell key={i} fill={entry.realized >= 0 ? '#00c896' : '#ff5757'} />)}
                                        </Bar>
                                        <Bar dataKey="dividend" name="股利收入" fill="#4f8ef7" radius={[4, 4, 0, 0]} />
                                    </BarChart>
                                </ResponsiveContainer>
                            )}
                        </div>

                        <div style={card}>
                            <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>月份明細</div>
                            <div style={{ overflowX: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid #2e3349' }}>
                                            {['月份', '已實現損益', '股利收入', '合計', '已實現報酬率'].map(h => (
                                                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#8892a4', fontWeight: 500 }}>{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filtered.map(m => {
                                            const mr = m.costBasis > 0 ? (m.realized / m.costBasis) * 100 : null
                                            return (
                                                <tr key={m.month} style={{ borderBottom: '1px solid #2e3349' }}>
                                                    <td style={{ padding: '12px', color: '#e2e8f0', fontWeight: 500 }}>{selectedYear} {m.month}</td>
                                                    <td style={{ padding: '12px', color: m.realized !== 0 ? pnlColor(m.realized) : '#8892a4', fontWeight: 600 }}>
                                                        {m.realized !== 0 ? fmtMoney(m.realized) : '—'}
                                                    </td>
                                                    <td style={{ padding: '12px', color: m.dividend > 0 ? '#4f8ef7' : '#8892a4', fontWeight: 600 }}>
                                                        {m.dividend > 0 ? `+$${m.dividend.toLocaleString()}` : '—'}
                                                    </td>
                                                    <td style={{ padding: '12px', color: m.total !== 0 ? pnlColor(m.total) : '#8892a4', fontWeight: 700 }}>
                                                        {m.total !== 0 ? fmtMoney(m.total) : '—'}
                                                    </td>
                                                    <td style={{ padding: '12px' }}>
                                                        {mr !== null
                                                            ? <span style={{ backgroundColor: mr >= 0 ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)', color: pnlColor(mr), padding: '3px 10px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 }}>{fmtPct(mr)}</span>
                                                            : <span style={{ color: '#8892a4' }}>—</span>}
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

                {/* ══ 績效指標 ══ */}
                {tab === 'performance' && (
                    perfLoading
                        ? <div style={{ textAlign: 'center', padding: '80px', color: '#8892a4' }}>計算中...</div>
                        : (
                            <>
                                {/* 核心指標 */}
                                <div className="perf-stats">
                                    <div style={card}>
                                        <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>年化報酬率（XIRR）</div>
                                        <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: xirr !== null ? pnlColor(xirr) : '#8892a4' }}>
                                            {xirr !== null ? fmtPct(xirr * 100) : '—'}
                                        </div>
                                        <div style={{ fontSize: '12px', color: '#8892a4', marginTop: '6px' }}>
                                            保守估（以成本）：{xirrCost !== null ? fmtPct(xirrCost * 100) : '—'}
                                        </div>
                                    </div>

                                    <div style={card}>
                                        <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>最大回撤（MDD）</div>
                                        <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: mdd !== null && mdd > 0.1 ? '#ff5757' : '#e2e8f0' }}>
                                            {mdd !== null ? `-${(mdd * 100).toFixed(2)}%` : '—'}
                                        </div>
                                        <div style={{ fontSize: '12px', color: '#8892a4', marginTop: '6px' }}>依已實現損益曲線計算</div>
                                    </div>

                                    <div style={card}>
                                        <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>交易勝率</div>
                                        <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: winRate !== null ? (winRate >= 50 ? '#00c896' : '#ff5757') : '#8892a4' }}>
                                            {winRate !== null ? `${winRate.toFixed(1)}%` : '—'}
                                        </div>
                                        <div style={{ fontSize: '12px', color: '#8892a4', marginTop: '6px' }}>
                                            {totalWins} 勝 / {totalTrades - totalWins} 敗（共 {totalTrades} 筆）
                                        </div>
                                    </div>

                                    <div style={card}>
                                        <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>平均持有天數</div>
                                        <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 700, color: '#e2e8f0' }}>
                                            {avgHoldingDays !== null ? `${Math.round(avgHoldingDays)} 天` : '—'}
                                        </div>
                                        <div style={{ fontSize: '12px', color: '#8892a4', marginTop: '6px' }}>
                                            {avgHoldingDays !== null
                                                ? avgHoldingDays < 7 ? '短線為主' : avgHoldingDays < 30 ? '波段操作' : '中長線持有'
                                                : ''}
                                        </div>
                                    </div>
                                </div>

                                {/* 各年度比較 */}
                                <div style={{ ...card, marginBottom: '20px' }}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>各年度績效比較</div>
                                    {yearStats.length === 0
                                        ? <div style={{ textAlign: 'center', padding: '32px', color: '#8892a4' }}>尚無已實現交易紀錄</div>
                                        : (
                                            <div style={{ overflowX: 'auto' }}>
                                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                                                    <thead>
                                                        <tr style={{ borderBottom: '1px solid #2e3349' }}>
                                                            {['年度', '已實現損益', '股利收入', '合計', '已實現報酬率', '勝率', '交易筆數'].map(h => (
                                                                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#8892a4', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {yearStats.map(y => (
                                                            <tr key={y.year} style={{ borderBottom: '1px solid #2e3349' }}>
                                                                <td style={{ padding: '12px', color: '#4f8ef7', fontWeight: 700 }}>{y.year}</td>
                                                                <td style={{ padding: '12px', color: pnlColor(y.realized), fontWeight: 600 }}>{fmtMoney(y.realized)}</td>
                                                                <td style={{ padding: '12px', color: '#4f8ef7', fontWeight: 600 }}>+${y.dividend.toLocaleString()}</td>
                                                                <td style={{ padding: '12px', color: pnlColor(y.total), fontWeight: 700 }}>{fmtMoney(y.total)}</td>
                                                                <td style={{ padding: '12px' }}>
                                                                    {y.returnRate !== null
                                                                        ? <span style={{ backgroundColor: y.returnRate >= 0 ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)', color: pnlColor(y.returnRate), padding: '2px 8px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 }}>{fmtPct(y.returnRate)}</span>
                                                                        : '—'}
                                                                </td>
                                                                <td style={{ padding: '12px', color: y.winRate !== null ? (y.winRate >= 50 ? '#00c896' : '#ff5757') : '#8892a4', fontWeight: 600 }}>
                                                                    {y.winRate !== null ? `${y.winRate.toFixed(1)}%` : '—'}
                                                                </td>
                                                                <td style={{ padding: '12px', color: '#8892a4' }}>{y.tradeCount} 筆</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        )}
                                </div>

                                {/* 月份熱力圖 */}
                                <div style={{ ...card, marginBottom: '20px' }}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>月份損益熱力圖（全歷史）</div>
                                    {heatYears.length === 0
                                        ? <div style={{ textAlign: 'center', padding: '32px', color: '#8892a4' }}>尚無資料</div>
                                        : (
                                            <div style={{ overflowX: 'auto' }}>
                                                <table style={{ borderCollapse: 'separate', borderSpacing: '4px', fontSize: '12px' }}>
                                                    <thead>
                                                        <tr>
                                                            <th style={{ padding: '4px 8px', color: '#8892a4', fontWeight: 500, textAlign: 'left', minWidth: '48px' }} />
                                                            {Array.from({ length: 12 }, (_, i) => (
                                                                <th key={i} style={{ padding: '4px 8px', color: '#8892a4', fontWeight: 500, textAlign: 'center', minWidth: '54px' }}>{i + 1}月</th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {heatYears.map(yr => (
                                                            <tr key={yr}>
                                                                <td style={{ padding: '4px 8px', color: '#8892a4', fontWeight: 600, whiteSpace: 'nowrap' }}>{yr}</td>
                                                                {Array.from({ length: 12 }, (_, i) => {
                                                                    const mo = `${yr}-${String(i + 1).padStart(2, '0')}`
                                                                    const val = heatmapData[mo]
                                                                    return (
                                                                        <td key={i} style={{
                                                                            padding: '6px 4px', borderRadius: '6px', textAlign: 'center',
                                                                            backgroundColor: val !== undefined ? heatColor(val, heatMax) : '#1a1d27',
                                                                            color: val !== undefined ? (val >= 0 ? '#00c896' : '#ff5757') : '#2e3349',
                                                                            fontWeight: 600, minWidth: '54px', fontSize: '11px', whiteSpace: 'nowrap',
                                                                        }}>
                                                                            {val !== undefined
                                                                                ? `${val >= 0 ? '+' : ''}${(val / 1000).toFixed(1)}K`
                                                                                : '—'}
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

                                {/* 已實現交易明細 */}
                                <div style={card}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>
                                        已實現交易明細（最近 {Math.min(realizedTrades.length, 50)} 筆）
                                    </div>
                                    {realizedTrades.length === 0
                                        ? <div style={{ textAlign: 'center', padding: '32px', color: '#8892a4' }}>尚無已實現交易</div>
                                        : (
                                            <div style={{ overflowX: 'auto' }}>
                                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                                                    <thead>
                                                        <tr style={{ borderBottom: '1px solid #2e3349' }}>
                                                            {['賣出日', '代號', '名稱', '持有天數', '損益', '報酬率'].map(h => (
                                                                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#8892a4', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {realizedTrades.slice(0, 50).map((r, i) => (
                                                            <tr key={i} style={{ borderBottom: '1px solid #2e3349' }}>
                                                                <td style={{ padding: '12px', color: '#8892a4' }}>{r.date}</td>
                                                                <td style={{ padding: '12px', color: '#4f8ef7', fontWeight: 700 }}>{r.code}</td>
                                                                <td style={{ padding: '12px', color: '#e2e8f0' }}>{r.name}</td>
                                                                <td style={{ padding: '12px', color: '#8892a4' }}>{r.holdingDays} 天</td>
                                                                <td style={{ padding: '12px', color: pnlColor(r.pnl), fontWeight: 600 }}>{fmtMoney(r.pnl)}</td>
                                                                <td style={{ padding: '12px' }}>
                                                                    <span style={{ backgroundColor: r.returnRate >= 0 ? 'rgba(0,200,150,0.12)' : 'rgba(255,87,87,0.12)', color: pnlColor(r.returnRate), padding: '3px 10px', borderRadius: '20px', fontSize: '13px', fontWeight: 600 }}>
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
