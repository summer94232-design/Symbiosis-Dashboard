import { useState, useEffect, useRef } from 'react'
import { collection, addDoc, getDocs, updateDoc, deleteDoc, doc, orderBy, query, setDoc, writeBatch } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { calcFee, calcTax, isETF } from '../../lib/calc'
import { Pencil, Trash2, X, Check, Upload, Search } from 'lucide-react'

interface Trade {
  id?: string
  date: string
  type: 'buy' | 'sell'
  code: string
  name: string
  price: number
  shares: number
  fee: number
  tax: number
  total: number
  note: string
}

const emptyTrade: Trade = {
  date: new Date().toISOString().split('T')[0],
  type: 'buy', code: '', name: '', price: 0, shares: 0, fee: 0, tax: 0, total: 0, note: ''
}

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

export default function Trades() {
  const [trades, setTrades] = useState<Trade[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<Trade>(emptyTrade)
  const [loading, setLoading] = useState(false)
  const [stockDict, setStockDict] = useState<Record<string, string>>({})
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ success: number; failed: number; skipped: number } | null>(null)
  const [search, setSearch] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = async () => {
    const q = query(collection(investDB, 'trades'), orderBy('date', 'desc'))
    const snap = await getDocs(q)
    setTrades(snap.docs.map(d => ({ id: d.id, ...d.data() } as Trade)))
  }

  const loadDict = async () => {
    const snap = await getDocs(collection(investDB, 'stockDict'))
    const dict: Record<string, string> = {}
    snap.docs.forEach(d => { dict[d.id] = d.data().name })
    setStockDict(dict)
  }

  useEffect(() => { load(); loadDict() }, [])

  const handleCodeChange = (code: string) => {
    const upper = code.toUpperCase()
    setForm(f => {
      const name = stockDict[upper] || f.name
      const fee = f.price && f.shares ? calcFee(f.price, f.shares) : f.fee
      const tax = f.type === 'sell' && f.price && f.shares ? calcTax(f.price, f.shares, upper) : 0
      const u = { ...f, code: upper, name, fee, tax }
      u.total = f.type === 'buy' ? f.price * f.shares + u.fee : f.price * f.shares - u.fee - u.tax
      return u
    })
  }

  const calcTotal = (f: Trade) => f.type === 'buy' ? f.price * f.shares + f.fee : f.price * f.shares - f.fee - f.tax

  const handleChange = (key: keyof Trade, value: any) => {
    setForm(f => {
      const u = { ...f, [key]: value }
      if (['price', 'shares', 'type', 'code'].includes(key)) {
        if (u.price && u.shares) {
          u.fee = calcFee(u.price, u.shares)
          u.tax = u.type === 'sell' ? calcTax(u.price, u.shares, u.code) : 0
        }
      }
      u.total = calcTotal(u)
      return u
    })
  }

  const handleSave = async () => {
    if (!form.code || !form.price || !form.shares) return
    setLoading(true)
    if (form.name && form.code) await setDoc(doc(investDB, 'stockDict', form.code), { name: form.name })
    if (editingId) {
      await updateDoc(doc(investDB, 'trades', editingId), { ...form })
    } else {
      await addDoc(collection(investDB, 'trades'), { ...form })
    }
    setEditingId(null); setForm(emptyTrade); setLoading(false)
    load(); loadDict()
  }

  const handleEdit = (t: Trade) => { setForm(t); setEditingId(t.id!) }
  const handleCancel = () => { setForm(emptyTrade); setEditingId(null) }
  const handleDelete = async (id: string) => {
    if (!confirm('確定要刪除？')) return
    await deleteDoc(doc(investDB, 'trades', id)); load()
  }

  const handleImportCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true); setImportResult(null)
    const text = await file.text()
    const lines = text.split('\n').filter(l => l.trim())
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''))
    let success = 0, failed = 0, skipped = 0

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''))
      const row: Record<string, string> = {}
      headers.forEach((h, idx) => { row[h] = cols[idx] || '' })
      const type = row['類型']
      const date = row['日期']

      if (type === '入金') {
        const amount = parseFloat(row['價格/金額']) || 0
        if (amount > 0) { await addDoc(collection(investDB, 'cashflow'), { date, type: 'in', amount, note: row['備註/筆記'] || '' }); success++ }
        else skipped++
        continue
      }
      if (type !== '買進' && type !== '賣出') { skipped++; continue }

      const rawCode = (row['代號'] || '').replace('.TW', '').replace('.tw', '').trim()
      const name = (row['名稱'] || '').trim()
      const price = parseFloat(row['價格/金額']) || 0
      const shares = parseInt(row['股數']) || 0
      if (!rawCode || !price || !shares) { failed++; continue }

      const tradeType = type === '買進' ? 'buy' : 'sell'
      const fee = calcFee(price, shares)
      const tax = tradeType === 'sell' ? calcTax(price, shares, rawCode) : 0
      const total = tradeType === 'buy' ? price * shares + fee : price * shares - fee - tax

      try {
        await addDoc(collection(investDB, 'trades'), { date, type: tradeType, code: rawCode, name, price, shares, fee, tax, total, note: row['備註/筆記'] || '' })
        if (name && rawCode) await setDoc(doc(investDB, 'stockDict', rawCode), { name })
        success++
      } catch { failed++ }
    }

    setImportResult({ success, failed, skipped })
    setImporting(false); e.target.value = ''
    load(); loadDict()
  }

  // 搜尋篩選
  const filtered = trades.filter(t =>
    !search || t.code.toLowerCase().includes(search.toLowerCase()) || t.name.includes(search)
  )

  return (
    <>
      <style>{`
        .trades-grid { display: grid; gap: 12px; grid-template-columns: repeat(5, 1fr); }
        .trades-grid .span2 { grid-column: span 2; }
        @media (max-width: 1100px) { .trades-grid { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 700px) { .trades-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .trades-grid { grid-template-columns: 1fr; } .trades-grid .span2 { grid-column: span 1; } }
        .table-wrap { overflow-x: auto; }
        .trade-table { width: 100%; border-collapse: collapse; font-size: 14px; }
        .trade-table th { padding: 10px 12px; text-align: left; color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; white-space: nowrap; }
        .trade-table td { padding: 12px; border-bottom: 1px solid #2e3349; color: #e2e8f0; white-space: nowrap; }
        .trade-table tr:hover td { background-color: rgba(79,142,247,0.04); }
      `}</style>

      <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>買賣紀錄</h1>
            <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>共 {trades.length} 筆交易</p>
          </div>
          <label style={{ ...btn('#21253a'), border: '1px solid #2e3349', cursor: 'pointer' }}>
            <Upload size={15} />{importing ? '匯入中...' : '匯入歷史紀錄 CSV'}
            <input ref={fileRef} type="file" accept=".csv" onChange={handleImportCSV} disabled={importing} style={{ display: 'none' }} />
          </label>
        </div>

        {importResult && (
          <div style={{ backgroundColor: 'rgba(0,200,150,0.08)', border: '1px solid rgba(0,200,150,0.25)', borderRadius: '10px', padding: '14px 18px', marginBottom: '16px', display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            <div><span style={{ fontSize: '12px', color: '#8892a4' }}>成功匯入</span><div style={{ fontSize: '18px', fontWeight: 700, color: '#00c896' }}>{importResult.success} 筆</div></div>
            {importResult.failed > 0 && <div><span style={{ fontSize: '12px', color: '#8892a4' }}>失敗</span><div style={{ fontSize: '18px', fontWeight: 700, color: '#ff5757' }}>{importResult.failed} 筆</div></div>}
            {importResult.skipped > 0 && <div><span style={{ fontSize: '12px', color: '#8892a4' }}>略過</span><div style={{ fontSize: '18px', fontWeight: 700, color: '#8892a4' }}>{importResult.skipped} 筆</div></div>}
          </div>
        )}

        {/* 表單 */}
        <div style={{ ...card, marginBottom: '20px' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>
            {editingId ? '✏️ 編輯交易' : '➕ 新增交易'}
          </div>
          <div className="trades-grid">
            <div><label style={lbl}>日期</label><input type="date" style={inp} value={form.date} onChange={e => handleChange('date', e.target.value)} /></div>
            <div><label style={lbl}>類型</label>
              <select style={inp} value={form.type} onChange={e => handleChange('type', e.target.value)}>
                <option value="buy">買入</option>
                <option value="sell">賣出</option>
              </select>
            </div>
            <div><label style={lbl}>股票代號</label><input style={inp} placeholder="例：2330" value={form.code} onChange={e => handleCodeChange(e.target.value)} /></div>
            <div><label style={lbl}>股票名稱</label><input style={inp} placeholder="例：台積電" value={form.name} onChange={e => handleChange('name', e.target.value)} /></div>
            <div><label style={lbl}>價格</label><input type="number" style={inp} placeholder="0" value={form.price || ''} onChange={e => handleChange('price', parseFloat(e.target.value) || 0)} /></div>
            <div><label style={lbl}>股數</label><input type="number" style={inp} placeholder="0" value={form.shares || ''} onChange={e => handleChange('shares', parseInt(e.target.value) || 0)} /></div>
            <div>
              <label style={lbl}>手續費 <span style={{ color: '#4f8ef7', fontSize: '11px' }}>（6折自動計算）</span></label>
              <input type="number" style={inp} value={form.fee || ''} onChange={e => handleChange('fee', parseFloat(e.target.value) || 0)} />
            </div>
            <div>
              <label style={lbl}>交易稅 <span style={{ color: form.type === 'sell' ? (isETF(form.code) ? '#f5a623' : '#4f8ef7') : '#2e3349', fontSize: '11px' }}>
                {form.type === 'sell' ? (isETF(form.code) ? '（ETF千分之一）' : '（千分之三）') : '（買入免稅）'}
              </span></label>
              <input type="number" style={inp} value={form.tax || ''} onChange={e => handleChange('tax', parseFloat(e.target.value) || 0)} />
            </div>
            <div><label style={lbl}>收付金額</label><input type="number" style={{ ...inp, color: form.type === 'buy' ? '#ff5757' : '#00c896' }} value={form.total} readOnly /></div>
            <div className="span2"><label style={lbl}>備註</label><input style={inp} placeholder="選填" value={form.note} onChange={e => handleChange('note', e.target.value)} /></div>
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
            {editingId && <button style={btn('#2e3349')} onClick={handleCancel}><X size={14} />取消編輯</button>}
            <button style={btn('#4f8ef7')} onClick={handleSave} disabled={loading}>
              <Check size={14} />{loading ? '儲存中...' : editingId ? '確認更新' : '確認新增'}
            </button>
          </div>
        </div>

        {/* 搜尋列 */}
        <div style={{ marginBottom: '12px', position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#8892a4' }} />
          <input style={{ ...inp, paddingLeft: '36px', backgroundColor: '#1a1d27', border: '1px solid #2e3349' }}
            placeholder="搜尋代號或名稱..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        {/* 列表 */}
        <div style={card}>
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>
              {search ? `找不到「${search}」相關紀錄` : '還沒有交易紀錄，請在上方新增或匯入 CSV'}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="trade-table">
                <thead>
                  <tr>{['日期', '類型', '代號', '名稱', '價格', '股數', '手續費', '交易稅', '收付金額', '備註', ''].map(h => <th key={h}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {filtered.map(trade => (
                    <tr key={trade.id} style={{ backgroundColor: editingId === trade.id ? 'rgba(79,142,247,0.06)' : 'transparent' }}>
                      <td>{trade.date}</td>
                      <td><span style={{ backgroundColor: trade.type === 'buy' ? 'rgba(255,87,87,0.15)' : 'rgba(0,200,150,0.15)', color: trade.type === 'buy' ? '#ff5757' : '#00c896', padding: '2px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600 }}>{trade.type === 'buy' ? '買入' : '賣出'}</span></td>
                      <td style={{ color: '#4f8ef7', fontWeight: 700 }}>{trade.code}</td>
                      <td>{trade.name}</td>
                      <td>{trade.price.toLocaleString()}</td>
                      <td>{trade.shares.toLocaleString()}</td>
                      <td>{trade.fee.toLocaleString()}</td>
                      <td>{trade.tax.toLocaleString()}</td>
                      <td style={{ color: trade.type === 'buy' ? '#ff5757' : '#00c896', fontWeight: 600 }}>{trade.total.toLocaleString()}</td>
                      <td style={{ color: '#8892a4' }}>{trade.note}</td>
                      <td>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button onClick={() => handleEdit(trade)} style={{ background: 'none', border: 'none', color: '#4f8ef7', cursor: 'pointer' }}><Pencil size={15} /></button>
                          <button onClick={() => handleDelete(trade.id!)} style={{ background: 'none', border: 'none', color: '#ff5757', cursor: 'pointer' }}><Trash2 size={15} /></button>
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