import { useState, useEffect, useRef } from 'react'
import { addDoc, getDocs, updateDoc, deleteDoc, orderBy, query, setDoc, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { Pencil, Trash2, X, Check } from 'lucide-react'

interface DividendRecord {
    id?: string
    date: string
    code: string
    name: string
    cashDividend: number
    stockDividend: number
    note: string
}

const empty: DividendRecord = { date: new Date().toISOString().split('T')[0], code: '', name: '', cashDividend: 0, stockDividend: 0, note: '' }
const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

// ★ 本地快取，與 Trades.tsx 共用同一個 module-level 快取
const dictCache: Record<string, string> = {}

async function lookupStockName(code: string): Promise<string> {
    if (dictCache[code]) return dictCache[code]
    const shortDoc = await getDoc(userDoc(investDB, 'stockDict', code))
    if (shortDoc.exists()) {
        const name = shortDoc.data().name as string
        dictCache[code] = name
        return name
    }
    const fullDoc = await getDoc(userDoc(investDB, 'stockDictFull', code))
    if (fullDoc.exists()) {
        const name = fullDoc.data().name as string
        dictCache[code] = name
        await setDoc(userDoc(investDB, 'stockDict', code), { name })
        return name
    }
    return ''
}

export default function Dividend() {
    const [records, setRecords] = useState<DividendRecord[]>([])
    const [editingId, setEditingId] = useState<string | null>(null)
    const [form, setForm] = useState<DividendRecord>(empty)
    const [loading, setLoading] = useState(false)
    const [lookingUp, setLookingUp] = useState(false)
    const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    const load = async () => {
        const q = query(userCol(investDB, 'dividends'), orderBy('date', 'desc'))
        const snap = await getDocs(q)
        setRecords(snap.docs.map(d => ({ id: d.id, ...d.data() } as DividendRecord)))
    }

    useEffect(() => { load() }, [])

    // ★ debounce 500ms 再查詢
    const handleCodeChange = (code: string) => {
        const upper = code.toUpperCase()
        setForm(f => ({ ...f, code: upper }))

        if (lookupTimer.current) clearTimeout(lookupTimer.current)
        if (upper.length < 3) return

        lookupTimer.current = setTimeout(async () => {
            setLookingUp(true)
            const name = await lookupStockName(upper)
            if (name) setForm(f => ({ ...f, name }))
            setLookingUp(false)
        }, 500)
    }

    const handleSave = async () => {
        if (!form.code || !form.date) return
        setLoading(true)
        if (editingId) {
            await updateDoc(userDoc(investDB, 'dividends', editingId), { ...form })
        } else {
            await addDoc(userCol(investDB, 'dividends'), { ...form })
        }
        // 儲存時同步寫入常用字典
        if (form.name && form.code) {
            dictCache[form.code] = form.name
            await setDoc(userDoc(investDB, 'stockDict', form.code), { name: form.name })
        }
        setEditingId(null); setForm(empty); setLoading(false); load()
    }

    const handleEdit = (r: DividendRecord) => {
        if (r.code && r.name) dictCache[r.code] = r.name
        setForm(r); setEditingId(r.id!)
    }
    const handleCancel = () => { setForm(empty); setEditingId(null) }
    const handleDelete = async (id: string) => {
        if (!confirm('確定要刪除？')) return
        await deleteDoc(userDoc(investDB, 'dividends', id)); load()
    }

    const totalCash = records.reduce((s, r) => s + r.cashDividend, 0)
    const totalStock = records.reduce((s, r) => s + r.stockDividend, 0)

    return (
        <>
            <style>{`
        .div-form-grid { display: grid; gap: 12px; grid-template-columns: repeat(3, 1fr); }
        @media (max-width: 900px) { .div-form-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .div-form-grid { grid-template-columns: 1fr; } }
        .div-stats { display: grid; gap: 16px; grid-template-columns: repeat(2, 1fr); margin-bottom: 20px; }
        @media (max-width: 480px) { .div-stats { grid-template-columns: 1fr; } }
        .table-wrap { overflow-x: auto; }
        .div-table { width: 100%; border-collapse: collapse; font-size: 14px; }
        .div-table th, .div-table td { padding: 10px 12px; text-align: left; }
        .div-table th { color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; }
        .div-table td { border-bottom: 1px solid #2e3349; color: #e2e8f0; }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>
                <div style={{ marginBottom: '24px' }}>
                    <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>除權息</h1>
                    <p style={{ fontSize: '13px', color: '#8892a4', margin: '4px 0 0' }}>共 {records.length} 筆紀錄</p>
                </div>

                {/* 統計卡片 */}
                <div className="div-stats">
                    {[{ label: '累計現金股利', value: `${totalCash.toLocaleString()} 元`, color: '#00c896' }, { label: '累計股票股利', value: `${totalStock.toLocaleString()} 股`, color: '#4f8ef7' }].map(({ label, value, color }) => (
                        <div key={label} style={card}>
                            <div style={{ fontSize: '12px', color: '#8892a4', marginBottom: '8px' }}>{label}</div>
                            <div style={{ fontSize: 'clamp(18px, 2vw, 22px)', fontWeight: 700, color }}>{value}</div>
                        </div>
                    ))}
                </div>

                {/* 表單 */}
                <div style={{ ...card, marginBottom: '20px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>
                        {editingId ? '✏️ 編輯紀錄' : '➕ 新增紀錄'}
                    </div>
                    <div className="div-form-grid">
                        <div><label style={lbl}>日期</label><input type="date" style={inp} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></div>
                        <div>
                            <label style={lbl}>股票代號</label>
                            <input style={inp} placeholder="例：2330" value={form.code} onChange={e => handleCodeChange(e.target.value)} />
                        </div>
                        <div>
                            <label style={lbl}>股票名稱 {lookingUp && <span style={{ color: '#8892a4', fontSize: '10px' }}>查詢中...</span>}</label>
                            <input style={inp} placeholder="輸入代號後自動帶入" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                        </div>
                        <div><label style={lbl}>現金股利（元）</label><input type="number" style={inp} placeholder="0" value={form.cashDividend || ''} onChange={e => setForm(f => ({ ...f, cashDividend: parseFloat(e.target.value) || 0 }))} /></div>
                        <div><label style={lbl}>股票股利（股）</label><input type="number" style={inp} placeholder="0" value={form.stockDividend || ''} onChange={e => setForm(f => ({ ...f, stockDividend: parseFloat(e.target.value) || 0 }))} /></div>
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
                        <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}><p>還沒有除權息紀錄，請在上方新增</p></div>
                    ) : (
                        <div className="table-wrap">
                            <table className="div-table">
                                <thead>
                                    <tr>{['日期', '代號', '名稱', '現金股利', '股票股利', '備註', ''].map(h => <th key={h}>{h}</th>)}</tr>
                                </thead>
                                <tbody>
                                    {records.map(r => (
                                        <tr key={r.id} style={{ backgroundColor: editingId === r.id ? 'rgba(79,142,247,0.06)' : 'transparent' }}>
                                            <td>{r.date}</td>
                                            <td style={{ color: '#4f8ef7', fontWeight: 600 }}>{r.code}</td>
                                            <td>{r.name}</td>
                                            <td style={{ color: '#00c896', fontWeight: 600 }}>{r.cashDividend.toLocaleString()} 元</td>
                                            <td style={{ color: '#4f8ef7', fontWeight: 600 }}>{r.stockDividend.toLocaleString()} 股</td>
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