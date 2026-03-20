import { useState, useEffect } from 'react'
import { collection, addDoc, getDocs, updateDoc, deleteDoc, doc, orderBy, query } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { Pencil, Trash2, X, Check } from 'lucide-react'

interface CashRecord {
  id?: string
  date: string
  type: 'in' | 'out'
  amount: number
  note: string
}

const empty: CashRecord = { date: new Date().toISOString().split('T')[0], type: 'in', amount: 0, note: '' }
const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

export default function CashFlow() {
  const [records, setRecords] = useState<CashRecord[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<CashRecord>(empty)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    const q = query(collection(investDB, 'cashflow'), orderBy('date', 'desc'))
    const snap = await getDocs(q)
    setRecords(snap.docs.map(d => ({ id: d.id, ...d.data() } as CashRecord)))
  }

  useEffect(() => { load() }, [])

  const handleSave = async () => {
    if (!form.amount) return
    setLoading(true)
    if (editingId) {
      await updateDoc(doc(investDB, 'cashflow', editingId), { ...form })
    } else {
      await addDoc(collection(investDB, 'cashflow'), { ...form })
    }
    setEditingId(null); setForm(empty); setLoading(false); load()
  }

  const handleEdit = (r: CashRecord) => { setForm(r); setEditingId(r.id!) }
  const handleCancel = () => { setForm(empty); setEditingId(null) }
  const handleDelete = async (id: string) => {
    if (!confirm('確定要刪除？')) return
    await deleteDoc(doc(investDB, 'cashflow', id)); load()
  }

  const totalIn = records.filter(r => r.type === 'in').reduce((s, r) => s + r.amount, 0)
  const totalOut = records.filter(r => r.type === 'out').reduce((s, r) => s + r.amount, 0)
  const net = totalIn - totalOut

  return (
    <>
      <style>{`
        .cash-form-grid { display: grid; gap: 12px; grid-template-columns: repeat(4, 1fr); }
        @media (max-width: 900px) { .cash-form-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .cash-form-grid { grid-template-columns: 1fr; } }
        .cash-stats { display: grid; gap: 16px; grid-template-columns: repeat(3, 1fr); margin-bottom: 20px; }
        @media (max-width: 600px) { .cash-stats { grid-template-columns: 1fr; } }
        .table-wrap { overflow-x: auto; }
        .cash-table { width: 100%; border-collapse: collapse; font-size: 14px; }
        .cash-table th, .cash-table td { padding: 10px 12px; text-align: left; }
        .cash-table th { color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; }
        .cash-table td { border-bottom: 1px solid #2e3349; color: #e2e8f0; }
      `}</style>

      <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>出入金</h1>
          <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>共 {records.length} 筆紀錄</p>
        </div>

        {/* 統計卡片 */}
        <div className="cash-stats">
          {[{ label: '總入金', value: totalIn, color: '#00c896' }, { label: '總出金', value: totalOut, color: '#ff5757' }, { label: '淨值', value: net, color: net >= 0 ? '#00c896' : '#ff5757' }].map(({ label, value, color }) => (
            <div key={label} style={card}>
              <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>{label}</div>
              <div style={{ fontSize: 'clamp(18px, 2vw, 22px)', fontWeight: 700, color }}>{value.toLocaleString()}</div>
            </div>
          ))}
        </div>

        {/* 表單 */}
        <div style={{ ...card, marginBottom: '20px' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>
            {editingId ? '✏️ 編輯紀錄' : '➕ 新增紀錄'}
          </div>
          <div className="cash-form-grid">
            <div><label style={lbl}>日期</label><input type="date" style={inp} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></div>
            <div><label style={lbl}>類型</label>
              <select style={inp} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as 'in' | 'out' }))}>
                <option value="in">入金</option>
                <option value="out">出金</option>
              </select>
            </div>
            <div><label style={lbl}>金額</label><input type="number" style={inp} placeholder="0" value={form.amount || ''} onChange={e => setForm(f => ({ ...f, amount: parseFloat(e.target.value) || 0 }))} /></div>
            <div><label style={lbl}>備註</label><input style={inp} placeholder="選填" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} /></div>
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
            {editingId && <button style={btn('#2e3349')} onClick={handleCancel}><X size={14} />取消編輯</button>}
            <button style={btn('#4f8ef7')} onClick={handleSave} disabled={loading}>
              <Check size={14} />{loading ? '儲存中...' : editingId ? '確認更新' : '確認新增'}
            </button>
          </div>
        </div>

        {/* 列表 */}
        <div style={card}>
          {records.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}><p>還沒有出入金紀錄，請在上方新增</p></div>
          ) : (
            <div className="table-wrap">
              <table className="cash-table">
                <thead>
                  <tr>{['日期', '類型', '金額', '備註', ''].map(h => <th key={h}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {records.map(r => (
                    <tr key={r.id} style={{ backgroundColor: editingId === r.id ? 'rgba(79,142,247,0.06)' : 'transparent' }}>
                      <td>{r.date}</td>
                      <td><span style={{ backgroundColor: r.type === 'in' ? 'rgba(0,200,150,0.15)' : 'rgba(255,87,87,0.15)', color: r.type === 'in' ? '#00c896' : '#ff5757', padding: '2px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600 }}>{r.type === 'in' ? '入金' : '出金'}</span></td>
                      <td style={{ color: r.type === 'in' ? '#00c896' : '#ff5757', fontWeight: 600 }}>{r.amount.toLocaleString()}</td>
                      <td style={{ color: '#8892a4' }}>{r.note}</td>
                      <td>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button onClick={() => handleEdit(r)} style={{ background: 'none', border: 'none', color: '#4f8ef7', cursor: 'pointer' }}><Pencil size={15} /></button>
                          <button onClick={() => handleDelete(r.id!)} style={{ background: 'none', border: 'none', color: '#ff5757', cursor: 'pointer' }}><Trash2 size={15} /></button>
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