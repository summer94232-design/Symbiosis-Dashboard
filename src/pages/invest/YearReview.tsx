import { useState, useEffect } from 'react'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LineChart, Line, Legend } from 'recharts'
import { calcPositions, calcAvailableCash, type TradeRecord } from '../../lib/calc'

interface MonthlyPnL {
  month: string
  realized: number
  dividend: number
  total: number
}

interface YearlyPerf {
  year: number
  startValue: number
  endValue: number
  invested: number
  cagr: number
  totalReturn: number
}

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', outline: 'none' }
const pnlColor = (v: number) => v >= 0 ? '#00c896' : '#ff5757'

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ backgroundColor: '#21253a', border: '1px solid #2e3349', borderRadius: '8px', padding: '12px 16px' }}>
      <p style={{ color: '#8892a4', fontSize: '12px', margin: '0 0 8px' }}>{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color, fontSize: '14px', fontWeight: 600, margin: '2px 0' }}>
          {p.name}：{typeof p.value === 'number' && p.name.includes('%') ? `${p.value.toFixed(2)}%` : `$${Number(p.value).toLocaleString()}`}
        </p>
      ))}
    </div>
  )
}

// 計算 CAGR
function calcCAGR(startValue: number, endValue: number, years: number): number {
  if (startValue <= 0 || years <= 0) return 0
  return (Math.pow(endValue / startValue, 1 / years) - 1) * 100
}

export default function YearReview() {
  const [monthlyData, setMonthlyData] = useState<MonthlyPnL[]>([])
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear())
  const [startMonth, setStartMonth] = useState(1)
  const [endMonth, setEndMonth] = useState(12)
  const [loading, setLoading] = useState(true)
  const [years, setYears] = useState<number[]>([])

  // 績效報告 state
  const [yearlyPerf, setYearlyPerf] = useState<YearlyPerf[]>([])
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [customCAGR, setCustomCAGR] = useState<number | null>(null)
  const [assetSnapshots, setAssetSnapshots] = useState<Record<string, number>>({})
  const [perfLoading, setPerfLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [tradesSnap, dividendsSnap, snapshotsSnap] = await Promise.all([
        getDocs(query(collection(investDB, 'trades'), orderBy('date', 'asc'))),
        getDocs(query(collection(investDB, 'dividends'), orderBy('date', 'asc'))),
        getDocs(query(collection(investDB, 'assetSnapshots'), orderBy('date', 'asc')))
      ])

      const trades = tradesSnap.docs.map(d => d.data())
      const dividends = dividendsSnap.docs.map(d => d.data())

      // 資產快照
      const snapshots: Record<string, number> = {}
      snapshotsSnap.docs.forEach(d => { snapshots[d.data().date] = d.data().totalAssets })
      setAssetSnapshots(snapshots)

      // 取得所有年份
      const allDates = [...trades.map((t: any) => t.date), ...dividends.map((d: any) => d.date)]
      const allYears = [...new Set(allDates.map((d: string) => parseInt(d.slice(0, 4))))].sort()
      if (allYears.length > 0) {
        setYears(allYears)
        // 預設自訂區間
        if (!customStart) setCustomStart(`${allYears[0]}-01-01`)
        if (!customEnd) setCustomEnd(new Date().toISOString().split('T')[0])
      }

      // 計算每月已實現損益
      const map: Record<string, { shares: number; cost: number }> = {}
      const monthlyRealized: Record<string, number> = {}
      const monthlyDividend: Record<string, number> = {}

      trades.forEach((t: any) => {
        const code = t.code
        if (!map[code]) map[code] = { shares: 0, cost: 0 }
        if (t.type === 'buy') {
          map[code].shares += t.shares
          map[code].cost += t.price * t.shares + t.fee
        } else {
          const avg = map[code].shares > 0 ? map[code].cost / map[code].shares : 0
          const pnl = (t.price - avg) * t.shares - t.fee - t.tax
          const month = t.date.slice(0, 7)
          monthlyRealized[month] = (monthlyRealized[month] || 0) + pnl
          map[code].shares -= t.shares
          map[code].cost -= avg * t.shares
        }
      })

      dividends.forEach((d: any) => {
        const month = d.date.slice(0, 7)
        monthlyDividend[month] = (monthlyDividend[month] || 0) + d.cashDividend
      })

      const result: MonthlyPnL[] = []
      for (let m = 1; m <= 12; m++) {
        const month = `${selectedYear}-${String(m).padStart(2, '0')}`
        const realized = monthlyRealized[month] || 0
        const dividend = monthlyDividend[month] || 0
        result.push({ month: `${m}月`, realized, dividend, total: realized + dividend })
      }
      setMonthlyData(result)

      // 計算年度績效
      calcYearlyPerf(allYears, snapshots, trades as TradeRecord[])
    } catch (err) { console.error(err) }
    setLoading(false)
  }

  const calcYearlyPerf = (allYears: number[], snapshots: Record<string, number>, trades: TradeRecord[]) => {
    const perf: YearlyPerf[] = []

    allYears.forEach(year => {
      // 找該年度最接近年初和年末的快照
      const yearDates = Object.keys(snapshots).filter(d => d.startsWith(`${year}`)).sort()
      const prevYearDates = Object.keys(snapshots).filter(d => d.startsWith(`${year - 1}`)).sort()

      const startDate = prevYearDates[prevYearDates.length - 1] || yearDates[0]
      const endDate = yearDates[yearDates.length - 1]

      if (!startDate || !endDate) return

      const startValue = snapshots[startDate] || 0
      const endValue = snapshots[endDate] || 0

      // 該年度淨投入
      const yearTrades = trades.filter(t => t.date.startsWith(`${year}`))
      const invested = yearTrades.reduce((s, t) => {
        if (t.type === 'buy') return s + t.price * t.shares + (t.fee || 0)
        return s - t.price * t.shares + (t.fee || 0) + (t.tax || 0)
      }, 0)

      const totalReturn = startValue > 0 ? ((endValue - startValue) / startValue) * 100 : 0
      const cagr = calcCAGR(startValue, endValue, 1)

      perf.push({ year, startValue, endValue, invested, cagr, totalReturn })
    })

    setYearlyPerf(perf)
  }

  // 計算自訂區間 CAGR
  const calcCustomCAGR = () => {
    if (!customStart || !customEnd) return
    setPerfLoading(true)

    const startDates = Object.keys(assetSnapshots).filter(d => d >= customStart).sort()
    const endDates = Object.keys(assetSnapshots).filter(d => d <= customEnd).sort()

    const startDate = startDates[0]
    const endDate = endDates[endDates.length - 1]

    if (!startDate || !endDate) { setCustomCAGR(null); setPerfLoading(false); return }

    const startValue = assetSnapshots[startDate]
    const endValue = assetSnapshots[endDate]

    const startMs = new Date(startDate).getTime()
    const endMs = new Date(endDate).getTime()
    const years = (endMs - startMs) / (365.25 * 24 * 60 * 60 * 1000)

    setCustomCAGR(calcCAGR(startValue, endValue, years))
    setPerfLoading(false)
  }

  useEffect(() => { load() }, [selectedYear])

  const filtered = monthlyData.slice(startMonth - 1, endMonth)
  const totalRealized = filtered.reduce((s, m) => s + m.realized, 0)
  const totalDividend = filtered.reduce((s, m) => s + m.dividend, 0)
  const totalPnL = totalRealized + totalDividend
  const months = Array.from({ length: 12 }, (_, i) => i + 1)

  // 整體 CAGR（第一筆到最新）
  const overallCAGR = (() => {
    const dates = Object.keys(assetSnapshots).sort()
    if (dates.length < 2) return null
    const startValue = assetSnapshots[dates[0]]
    const endValue = assetSnapshots[dates[dates.length - 1]]
    const years = (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / (365.25 * 24 * 60 * 60 * 1000)
    return calcCAGR(startValue, endValue, years)
  })()

  const perfChartData = yearlyPerf.map(p => ({
    year: `${p.year}`,
    '年度報酬率%': parseFloat(p.totalReturn.toFixed(2)),
    '年末資產': p.endValue
  }))

  return (
    <>
      <style>{`
        .review-stats { display: grid; gap: 16px; grid-template-columns: repeat(3, 1fr); margin-bottom: 20px; }
        @media (max-width: 700px) { .review-stats { grid-template-columns: 1fr; } }
        .perf-stats { display: grid; gap: 16px; grid-template-columns: repeat(4, 1fr); margin-bottom: 20px; }
        @media (max-width: 900px) { .perf-stats { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .perf-stats { grid-template-columns: 1fr; } }
        .perf-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .perf-table th { padding: 10px 12px; text-align: left; color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; white-space: nowrap; }
        .perf-table td { padding: 12px; border-bottom: 1px solid #2e3349; color: #e2e8f0; white-space: nowrap; }
      `}</style>

      <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>

        {/* ===== 年度復盤（原有功能）===== */}
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>年度復盤</h1>
          <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>已實現損益與股利收入分析</p>
        </div>

        {/* 篩選列 */}
        <div style={{ ...card, marginBottom: '20px', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>年度</label>
            <select style={inp} value={selectedYear} onChange={e => setSelectedYear(parseInt(e.target.value))}>
              {years.length === 0
                ? <option value={new Date().getFullYear()}>{new Date().getFullYear()}</option>
                : years.map(y => <option key={y} value={y}>{y}</option>)
              }
            </select>
          </div>
          <div>
            <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>起始月份</label>
            <select style={inp} value={startMonth} onChange={e => setStartMonth(parseInt(e.target.value))}>
              {months.map(m => <option key={m} value={m}>{m} 月</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>結束月份</label>
            <select style={inp} value={endMonth} onChange={e => setEndMonth(parseInt(e.target.value))}>
              {months.filter(m => m >= startMonth).map(m => <option key={m} value={m}>{m} 月</option>)}
            </select>
          </div>
        </div>

        {/* 統計卡片 */}
        <div className="review-stats">
          {[
            { label: '已實現損益', value: totalRealized, color: pnlColor(totalRealized) },
            { label: '股利收入', value: totalDividend, color: '#4f8ef7' },
            { label: '合計收益', value: totalPnL, color: pnlColor(totalPnL) },
          ].map(({ label, value, color }) => (
            <div key={label} style={card}>
              <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>{label}</div>
              <div style={{ fontSize: 'clamp(18px, 2vw, 22px)', fontWeight: 700, color }}>
                {value >= 0 ? '+' : ''}{value.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
              </div>
            </div>
          ))}
        </div>

        {/* 長條圖 */}
        <div style={{ ...card, marginBottom: '20px' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '20px' }}>
            {selectedYear} 年 {startMonth}–{endMonth} 月 損益分佈
          </div>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>載入中...</div>
          ) : (
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

        {/* 月份明細表 */}
        <div style={{ ...card, marginBottom: '40px' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>月份明細</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #2e3349' }}>
                  {['月份', '已實現損益', '股利收入', '合計'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#8892a4', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(m => (
                  <tr key={m.month} style={{ borderBottom: '1px solid #2e3349' }}>
                    <td style={{ padding: '12px', color: '#e2e8f0', fontWeight: 500 }}>{selectedYear} {m.month}</td>
                    <td style={{ padding: '12px', color: pnlColor(m.realized), fontWeight: 600 }}>
                      {m.realized >= 0 ? '+' : ''}{m.realized.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                    </td>
                    <td style={{ padding: '12px', color: '#4f8ef7', fontWeight: 600 }}>
                      +{m.dividend.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                    </td>
                    <td style={{ padding: '12px', color: pnlColor(m.total), fontWeight: 700 }}>
                      {m.total >= 0 ? '+' : ''}{m.total.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ===== 投資績效報告（新增）===== */}
        <div style={{ marginBottom: '24px' }}>
          <h2 style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 700, color: '#e2e8f0', margin: '0 0 4px' }}>投資績效報告</h2>
          <p style={{ fontSize: '13px', color: '#8892a4', margin: 0 }}>基於資產趨勢快照計算，請先在「資產趨勢」頁面記錄每年資產</p>
        </div>

        {Object.keys(assetSnapshots).length < 2 ? (
          <div style={{ ...card, textAlign: 'center', padding: '48px', color: '#8892a4' }}>
            <p style={{ fontSize: '15px' }}>資料不足</p>
            <p style={{ fontSize: '13px', marginTop: '8px' }}>請先在「資產趨勢」頁面至少記錄 2 筆以上的資產快照才能計算績效</p>
          </div>
        ) : (
          <>
            {/* 整體績效卡片 */}
            <div className="perf-stats">
              {[
                {
                  label: '整體 CAGR',
                  value: overallCAGR !== null ? `${overallCAGR >= 0 ? '+' : ''}${overallCAGR.toFixed(2)}%` : '—',
                  color: overallCAGR !== null ? pnlColor(overallCAGR) : '#8892a4',
                  desc: '年化複合報酬率'
                },
                {
                  label: '記錄年數',
                  value: `${(() => {
                    const dates = Object.keys(assetSnapshots).sort()
                    if (dates.length < 2) return 0
                    return ((new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / (365.25 * 24 * 60 * 60 * 1000)).toFixed(1)
                  })()}`,
                  color: '#4f8ef7',
                  desc: '年'
                },
                {
                  label: '最新總資產',
                  value: `$${(assetSnapshots[Object.keys(assetSnapshots).sort().pop()!] || 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`,
                  color: '#4f8ef7',
                  desc: '最近一筆快照'
                },
                {
                  label: '起始資產',
                  value: `$${(assetSnapshots[Object.keys(assetSnapshots).sort()[0]] || 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`,
                  color: '#8892a4',
                  desc: '第一筆快照'
                },
              ].map(({ label, value, color, desc }) => (
                <div key={label} style={card}>
                  <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '4px' }}>{label}</div>
                  <div style={{ fontSize: 'clamp(18px, 2vw, 22px)', fontWeight: 700, color, marginBottom: '4px' }}>{value}</div>
                  <div style={{ fontSize: '11px', color: '#8892a4' }}>{desc}</div>
                </div>
              ))}
            </div>

            {/* 自訂區間 CAGR */}
            <div style={{ ...card, marginBottom: '20px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>自訂區間 CAGR</div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>起始日期</label>
                  <input type="date" style={inp} value={customStart} onChange={e => setCustomStart(e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>結束日期</label>
                  <input type="date" style={inp} value={customEnd} onChange={e => setCustomEnd(e.target.value)} />
                </div>
                <button onClick={calcCustomCAGR} disabled={perfLoading}
                  style={{ backgroundColor: '#4f8ef7', border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer' }}>
                  計算
                </button>
                {customCAGR !== null && (
                  <div style={{ backgroundColor: customCAGR >= 0 ? 'rgba(0,200,150,0.1)' : 'rgba(255,87,87,0.1)', border: `1px solid ${customCAGR >= 0 ? 'rgba(0,200,150,0.3)' : 'rgba(255,87,87,0.3)'}`, borderRadius: '8px', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '12px', color: '#8892a4' }}>區間 CAGR</span>
                    <span style={{ fontSize: '22px', fontWeight: 700, color: pnlColor(customCAGR) }}>
                      {customCAGR >= 0 ? '+' : ''}{customCAGR.toFixed(2)}%
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* 年度報酬率長條圖 */}
            {perfChartData.length >= 2 && (
              <div style={{ ...card, marginBottom: '20px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '20px' }}>年度報酬率趨勢</div>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={perfChartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2e3349" />
                    <XAxis dataKey="year" tick={{ fill: '#8892a4', fontSize: 12 }} />
                    <YAxis tick={{ fill: '#8892a4', fontSize: 12 }} tickFormatter={v => `${v}%`} width={50} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="年度報酬率%" radius={[4, 4, 0, 0]}>
                      {perfChartData.map((entry, i) => (
                        <Cell key={i} fill={entry['年度報酬率%'] >= 0 ? '#00c896' : '#ff5757'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* 年度績效明細表 */}
            <div style={card}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>年度績效明細</div>
              <div style={{ overflowX: 'auto' }}>
                <table className="perf-table">
                  <thead>
                    <tr>
                      {['年度', '年初資產', '年末資產', '年度報酬率', 'CAGR'].map(h => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {yearlyPerf.map(p => (
                      <tr key={p.year}>
                        <td style={{ color: '#4f8ef7', fontWeight: 600 }}>{p.year}</td>
                        <td>${p.startValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                        <td>${p.endValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                        <td style={{ color: pnlColor(p.totalReturn), fontWeight: 600 }}>
                          {p.totalReturn >= 0 ? '+' : ''}{p.totalReturn.toFixed(2)}%
                        </td>
                        <td style={{ color: pnlColor(p.cagr), fontWeight: 600 }}>
                          {p.cagr >= 0 ? '+' : ''}{p.cagr.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                    {yearlyPerf.length > 0 && (
                      <tr style={{ borderTop: '2px solid #2e3349', backgroundColor: 'rgba(79,142,247,0.05)' }}>
                        <td style={{ color: '#e2e8f0', fontWeight: 700 }}>整體</td>
                        <td>${(assetSnapshots[Object.keys(assetSnapshots).sort()[0]] || 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                        <td>${(assetSnapshots[Object.keys(assetSnapshots).sort().pop()!] || 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                        <td style={{ color: pnlColor((() => {
                          const dates = Object.keys(assetSnapshots).sort()
                          if (dates.length < 2) return 0
                          return ((assetSnapshots[dates[dates.length - 1]] - assetSnapshots[dates[0]]) / assetSnapshots[dates[0]]) * 100
                        })()), fontWeight: 600 }}>
                          {(() => {
                            const dates = Object.keys(assetSnapshots).sort()
                            if (dates.length < 2) return '—'
                            const r = ((assetSnapshots[dates[dates.length - 1]] - assetSnapshots[dates[0]]) / assetSnapshots[dates[0]]) * 100
                            return `${r >= 0 ? '+' : ''}${r.toFixed(2)}%`
                          })()}
                        </td>
                        <td style={{ color: overallCAGR !== null ? pnlColor(overallCAGR) : '#8892a4', fontWeight: 700 }}>
                          {overallCAGR !== null ? `${overallCAGR >= 0 ? '+' : ''}${overallCAGR.toFixed(2)}%` : '—'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}