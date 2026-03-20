import { useState, useEffect } from 'react'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'

interface MonthlyPnL {
  month: string
  realized: number
  dividend: number
  total: number
}

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }

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

export default function YearReview() {
  const [monthlyData, setMonthlyData] = useState<MonthlyPnL[]>([])
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear())
  const [startMonth, setStartMonth] = useState(1)
  const [endMonth, setEndMonth] = useState(12)
  const [loading, setLoading] = useState(true)
  const [years, setYears] = useState<number[]>([])

  const load = async () => {
    setLoading(true)
    try {
      const tradesSnap = await getDocs(query(collection(investDB, 'trades'), orderBy('date', 'asc')))
      const trades = tradesSnap.docs.map(d => d.data())
      const dividendsSnap = await getDocs(query(collection(investDB, 'dividends'), orderBy('date', 'asc')))
      const dividends = dividendsSnap.docs.map(d => d.data())

      // 取得所有年份
      const allDates = [...trades.map((t: any) => t.date), ...dividends.map((d: any) => d.date)]
      const allYears = [...new Set(allDates.map((d: string) => parseInt(d.slice(0, 4))))].sort()
      if (allYears.length > 0) setYears(allYears)

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

      // 建立月份資料
      const result: MonthlyPnL[] = []
      for (let m = 1; m <= 12; m++) {
        const month = `${selectedYear}-${String(m).padStart(2, '0')}`
        const realized = monthlyRealized[month] || 0
        const dividend = monthlyDividend[month] || 0
        result.push({ month: `${m}月`, realized, dividend, total: realized + dividend })
      }
      setMonthlyData(result)
    } catch (err) { console.error(err) }
    setLoading(false)
  }

  useEffect(() => { load() }, [selectedYear])

  const filtered = monthlyData.slice(startMonth - 1, endMonth)
  const totalRealized = filtered.reduce((s, m) => s + m.realized, 0)
  const totalDividend = filtered.reduce((s, m) => s + m.dividend, 0)
  const totalPnL = totalRealized + totalDividend
  const pnlColor = (v: number) => v >= 0 ? '#00c896' : '#ff5757'
  const months = Array.from({ length: 12 }, (_, i) => i + 1)

  return (
    <>
      <style>{`
        .review-stats { display: grid; gap: 16px; grid-template-columns: repeat(3, 1fr); margin-bottom: 20px; }
        @media (max-width: 700px) { .review-stats { grid-template-columns: 1fr; } }
      `}</style>

      <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>年度復盤</h1>
          <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>已實現損益與股利收入分析</p>
        </div>

        {/* 篩選列 */}
        <div style={{ ...card, marginBottom: '20px', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>年度</label>
            <select style={{ backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', outline: 'none' }}
              value={selectedYear} onChange={e => setSelectedYear(parseInt(e.target.value))}>
              {years.length === 0
                ? <option value={new Date().getFullYear()}>{new Date().getFullYear()}</option>
                : years.map(y => <option key={y} value={y}>{y}</option>)
              }
            </select>
          </div>
          <div>
            <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>起始月份</label>
            <select style={{ backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', outline: 'none' }}
              value={startMonth} onChange={e => setStartMonth(parseInt(e.target.value))}>
              {months.map(m => <option key={m} value={m}>{m} 月</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }}>結束月份</label>
            <select style={{ backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', outline: 'none' }}
              value={endMonth} onChange={e => setEndMonth(parseInt(e.target.value))}>
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
                  {filtered.map((entry, i) => (
                    <Cell key={i} fill={entry.realized >= 0 ? '#00c896' : '#ff5757'} />
                  ))}
                </Bar>
                <Bar dataKey="dividend" name="股利收入" fill="#4f8ef7" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* 月份明細表 */}
        <div style={card}>
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
      </div>
    </>
  )
}