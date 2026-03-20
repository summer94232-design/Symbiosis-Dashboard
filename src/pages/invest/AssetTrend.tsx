import { useState, useEffect } from 'react'
import { collection, getDocs, doc, setDoc, deleteDoc, orderBy, query, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { calcPositions, calcAvailableCash, type TradeRecord } from '../../lib/calc'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Save, Pencil, Trash2, Plus, X, Check, Zap } from 'lucide-react'

interface SnapshotRecord {
  date: string
  totalAssets: number
  marketValue: number
  cash: number
}

const emptySnap: SnapshotRecord = {
  date: new Date().toISOString().split('T')[0],
  totalAssets: 0, marketValue: 0, cash: 0
}

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

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

export default function AssetTrend() {
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [autoLoading, setAutoLoading] = useState(false)
  const [range, setRange] = useState<'1M' | '3M' | '6M' | '1Y' | 'ALL'>('3M')
  const [showForm, setShowForm] = useState(false)
  const [editingDate, setEditingDate] = useState<string | null>(null)
  const [form, setForm] = useState<SnapshotRecord>(emptySnap)
  const [formLoading, setFormLoading] = useState(false)

  const loadSnapshots = async () => {
    setLoading(true)
    const q = query(collection(investDB, 'assetSnapshots'), orderBy('date', 'asc'))
    const snap = await getDocs(q)
    setSnapshots(snap.docs.map(d => d.data() as SnapshotRecord))
    setLoading(false)
  }

  useEffect(() => { loadSnapshots() }, [])

  const handleAutoFill = async () => {
    setAutoLoading(true)
    try {
      const tradesSnap = await getDocs(query(collection(investDB, 'trades'), orderBy('date', 'asc')))
      const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
      const cashSnap = await getDocs(collection(investDB, 'cashflow'))
      const cashRecords = cashSnap.docs.map(d => d.data() as any)

      const { holdings: positions } = calcPositions(trades)

      const priceDoc = await getDoc(doc(investDB, 'settings', 'lastPrices'))
      const savedPrices: Record<string, any> = priceDoc.exists() ? priceDoc.data() : {}

      let marketValue = 0
      Object.values(positions).forEach(pos => {
        const price = savedPrices[pos.code] ?? (pos.totalCost / pos.shares)
        marketValue += price * pos.shares
      })

      const cash = calcAvailableCash(trades, cashRecords)
      const totalAssets = marketValue + cash

      setForm(f => ({
        ...f,
        totalAssets: Math.round(totalAssets),
        marketValue: Math.round(marketValue),
        cash: Math.round(cash)
      }))
    } catch (err) { console.error(err) }
    setAutoLoading(false)
  }

  const saveToday = async () => {
    setSaving(true)
    try {
      const tradesSnap = await getDocs(query(collection(investDB, 'trades'), orderBy('date', 'asc')))
      const trades = tradesSnap.docs.map(d => d.data() as TradeRecord)
      const cashSnap = await getDocs(collection(investDB, 'cashflow'))
      const cashRecords = cashSnap.docs.map(d => d.data() as any)

      const { holdings: positions } = calcPositions(trades)
      const priceDoc = await getDoc(doc(investDB, 'settings', 'lastPrices'))
      const savedPrices: Record<string, any> = priceDoc.exists() ? priceDoc.data() : {}

      let marketValue = 0
      Object.values(positions).forEach(pos => {
        const price = savedPrices[pos.code] ?? (pos.totalCost / pos.shares)
        marketValue += price * pos.shares
      })

      const cash = calcAvailableCash(trades, cashRecords)
      const totalAssets = marketValue + cash
      const today = new Date().toISOString().split('T')[0]

      await setDoc(doc(investDB, 'assetSnapshots', today), {
        date: today,
        totalAssets: Math.round(totalAssets),
        marketValue: Math.round(marketValue),
        cash: Math.round(cash)
      })
      await loadSnapshots()
    } catch (err) { console.error(err) }
    setSaving(false)
  }

  const handleSave = async () => {
    if (!form.date) return
    setFormLoading(true)
    await setDoc(doc(investDB, 'assetSnapshots', form.date), { ...form })
    setShowForm(false); setEditingDate(null); setForm(emptySnap)
    setFormLoading(false); loadSnapshots()
  }

  const handleEdit = (s: SnapshotRecord) => { setForm({ ...s }); setEditingDate(s.date); setShowForm(true) }
  const handleDelete = async (date: string) => {
    if (!confirm(`確定要刪除 ${date} 的紀錄？`)) return
    await deleteDoc(doc(investDB, 'assetSnapshots', date)); loadSnapshots()
  }
  const handleCancel = () => { setShowForm(false); setEditingDate(null); setForm(emptySnap) }

  const filterByRange = (data: SnapshotRecord[]) => {
    if (range === 'ALL') return data
    const now = new Date()
    const months = range === '1M' ? 1 : range === '3M' ? 3 : range === '6M' ? 6 : 12
    const from = new Date(now.setMonth(now.getMonth() - months)).toISOString().split('T')[0]
    return data.filter(d => d.date >= from)
  }

  const filtered = filterByRange([...snapshots])
  const latest = snapshots[snapshots.length - 1]
  const oldest = filtered[0]
  const change = latest && oldest ? latest.totalAssets - oldest.totalAssets : 0
  const changeRate = oldest?.totalAssets > 0 ? (change / oldest.totalAssets) * 100 : 0
  const pnlColor = (v: number) => v >= 0 ? '#00c896' : '#ff5757'
  const rangeButtons: ('1M' | '3M' | '6M' | '1Y' | 'ALL')[] = ['1M', '3M', '6M', '1Y', 'ALL']

  return (
    <>
      <style>{`
        .trend-stats { display: grid; gap: 16px; grid-template-columns: repeat(4, 1fr); margin-bottom: 20px; }
        @media (max-width: 900px) { .trend-stats { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .trend-stats { grid-template-columns: 1fr; } }
        .snap-form-grid { display: grid; gap: 12px; grid-template-columns: repeat(4, 1fr); }
        @media (max-width: 800px) { .snap-form-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .snap-form-grid { grid-template-columns: 1fr; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>資產趨勢</h1>
            <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>共 {snapshots.length} 筆紀錄</p>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={() => { setForm(emptySnap); setEditingDate(null); setShowForm(true) }} style={btn('#21253a')}>
              <Plus size={14} />手動新增
            </button>
            <button onClick={saveToday} disabled={saving} style={btn('#4f8ef7')}>
              <Save size={14} style={{ animation: saving ? 'spin 1s linear infinite' : 'none' }} />
              {saving ? '記錄中...' : '記錄今日資產'}
            </button>
          </div>
        </div>

        {/* 統計卡片 */}
        <div className="trend-stats">
          {[
            { label: '最新總資產', value: latest?.totalAssets || 0, color: '#4f8ef7' },
            { label: '股票市值', value: latest?.marketValue || 0, color: '#00c896' },
            { label: '可用現金', value: latest?.cash || 0, color: '#f5a623' },
            { label: `區間變化 (${range})`, value: change, color: pnlColor(change), extra: `${changeRate >= 0 ? '+' : ''}${changeRate.toFixed(2)}%` },
          ].map(({ label, value, color, extra }) => (
            <div key={label} style={card}>
              <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>{label}</div>
              <div style={{ fontSize: 'clamp(16px, 2vw, 20px)', fontWeight: 700, color }}>
                {value < 0 ? '-' : ''}${Math.abs(value).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
              </div>
              {extra && <div style={{ fontSize: '13px', color, marginTop: '4px' }}>{extra}</div>}
            </div>
          ))}
        </div>

        {/* 手動新增／編輯表單 */}
        {showForm && (
          <div style={{ ...card, marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>
                {editingDate ? '✏️ 編輯紀錄' : '➕ 手動新增紀錄'}
              </span>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button onClick={handleAutoFill} disabled={autoLoading} style={{ ...btn('#00c896'), fontSize: '13px', padding: '6px 12px' }}>
                  <Zap size={13} style={{ animation: autoLoading ? 'spin 1s linear infinite' : 'none' }} />
                  {autoLoading ? '計算中...' : '自動帶入'}
                </button>
                <button onClick={handleCancel} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer' }}><X size={18} /></button>
              </div>
            </div>
            <p style={{ fontSize: '12px', color: '#8892a4', margin: '0 0 16px' }}>點「自動帶入」會從 Firebase 計算目前持倉市值與現金</p>
            <div className="snap-form-grid">
              <div>
                <label style={lbl}>日期</label>
                <input type="date" style={inp} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <div>
                <label style={lbl}>總資產</label>
                <input type="number" style={inp} placeholder="0" value={form.totalAssets || ''} onChange={e => setForm(f => ({ ...f, totalAssets: parseFloat(e.target.value) || 0 }))} />
              </div>
              <div>
                <label style={lbl}>股票市值</label>
                <input type="number" style={inp} placeholder="0" value={form.marketValue || ''} onChange={e => setForm(f => ({ ...f, marketValue: parseFloat(e.target.value) || 0 }))} />
              </div>
              <div>
                <label style={lbl}>現金</label>
                <input type="number" style={inp} placeholder="0" value={form.cash || ''} onChange={e => setForm(f => ({ ...f, cash: parseFloat(e.target.value) || 0 }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
              <button style={btn('#2e3349')} onClick={handleCancel}><X size={14} />取消</button>
              <button style={btn('#4f8ef7')} onClick={handleSave} disabled={formLoading}>
                <Check size={14} />{formLoading ? '儲存中...' : editingDate ? '確認更新' : '確認新增'}
              </button>
            </div>
          </div>
        )}

        {/* 折線圖 */}
        <div style={{ ...card, marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>資產走勢圖</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              {rangeButtons.map(r => (
                <button key={r} onClick={() => setRange(r)} style={{ backgroundColor: range === r ? '#4f8ef7' : '#21253a', border: '1px solid', borderColor: range === r ? '#4f8ef7' : '#2e3349', borderRadius: '6px', padding: '4px 12px', color: range === r ? '#fff' : '#8892a4', fontSize: '13px', cursor: 'pointer' }}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>載入中...</div>
          ) : filtered.length < 2 ? (
            <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>
              <p style={{ fontSize: '15px' }}>資料不足，無法顯示趨勢圖</p>
              <p style={{ fontSize: '13px', marginTop: '8px' }}>請累積至少 2 筆資料</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={filtered} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2e3349" />
                <XAxis dataKey="date" tick={{ fill: '#8892a4', fontSize: 12 }} tickFormatter={d => d.slice(5)} />
                <YAxis tick={{ fill: '#8892a4', fontSize: 12 }} tickFormatter={v => `${(v / 10000).toFixed(0)}萬`} width={60} />
                <Tooltip content={<CustomTooltip />} />
                <Line type="monotone" dataKey="totalAssets" name="總資產" stroke="#4f8ef7" strokeWidth={2.5} dot={false} activeDot={{ r: 5, fill: '#4f8ef7' }} />
                <Line type="monotone" dataKey="marketValue" name="股票市值" stroke="#00c896" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: '#00c896' }} />
                <Line type="monotone" dataKey="cash" name="現金" stroke="#f5a623" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: '#f5a623' }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* 歷史紀錄列表 */}
        <div style={card}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>歷史紀錄</div>
          {snapshots.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px', color: '#8892a4', fontSize: '13px' }}>還沒有紀錄</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #2e3349' }}>
                    {['日期', '總資產', '股票市值', '現金', ''].map(h => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#8892a4', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...snapshots].reverse().map(s => (
                    <tr key={s.date} style={{ borderBottom: '1px solid #2e3349', backgroundColor: editingDate === s.date ? 'rgba(79,142,247,0.06)' : 'transparent' }}>
                      <td style={{ padding: '12px', color: '#8892a4' }}>{s.date}</td>
                      <td style={{ padding: '12px', color: '#4f8ef7', fontWeight: 600 }}>${s.totalAssets.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                      <td style={{ padding: '12px', color: '#00c896' }}>${s.marketValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                      <td style={{ padding: '12px', color: '#f5a623' }}>${s.cash.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</td>
                      <td style={{ padding: '12px' }}>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button onClick={() => handleEdit(s)} style={{ background: 'none', border: 'none', color: '#4f8ef7', cursor: 'pointer' }}><Pencil size={15} /></button>
                          <button onClick={() => handleDelete(s.date)} style={{ background: 'none', border: 'none', color: '#ff5757', cursor: 'pointer' }}><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  )
}