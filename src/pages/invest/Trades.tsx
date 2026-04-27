import { useState, useEffect, useRef } from 'react'
import { addDoc, getDocs, updateDoc, deleteDoc, orderBy, query, setDoc, getDoc } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc, userDocNested } from '../../lib/userDB'
import { calcFee, calcTax, isETF } from '../../lib/calc'
import { Pencil, Trash2, X, Check, Upload, Search, ChevronDown, ChevronUp } from 'lucide-react'

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
    isMargin?: boolean     // 是否為融資交易
    marginRatio?: number   // 融資成數（例：0.6）
    marginAmount?: number  // 融資借款金額
}

const emptyTrade: Trade = {
    date: new Date().toISOString().split('T')[0],
    type: 'buy', code: '', name: '', price: 0, shares: 0, fee: 0, tax: 0, total: 0, note: '',
    isMargin: false, marginRatio: 0.6, marginAmount: 0
}

const card: React.CSSProperties = { backgroundColor: '#1a1d27', border: '1px solid #2e3349', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: '#0f1117', border: '1px solid #2e3349', borderRadius: '8px', padding: '8px 12px', color: '#e2e8f0', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: '#8892a4', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

const isOddLot = (shares: number) => shares > 0 && shares < 1000

function parseCSVLine(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
            else { inQuotes = !inQuotes }
        } else if (ch === ',' && !inQuotes) {
            result.push(current.trim())
            current = ''
        } else {
            current += ch
        }
    }
    result.push(current.trim())
    return result
}

const toNum = (s: string) => parseFloat((s || '').replace(/,/g, '')) || 0
const toInt = (s: string) => parseInt((s || '').replace(/,/g, '')) || 0

// ★ 本地快取：同一個 session 內不重複查詢同一代號
const dictCache: Record<string, string> = {}

// ★ 單筆查詢：先查 stockDict（常用），找不到再查 stockDictFull（完整台股）
async function lookupStockName(code: string): Promise<string> {
    if (dictCache[code]) return dictCache[code]

    // 先查常用字典
    const shortDoc = await getDoc(userDoc(investDB, 'stockDict', code))
    if (shortDoc.exists()) {
        const name = shortDoc.data().name as string
        dictCache[code] = name
        return name
    }

    // 找不到再查完整字典
    const fullDoc = await getDoc(userDoc(investDB, 'stockDictFull', code))
    if (fullDoc.exists()) {
        const name = fullDoc.data().name as string
        dictCache[code] = name
        // 找到後順便寫回 stockDict，下次直接命中
        await setDoc(userDoc(investDB, 'stockDict', code), { name })
        return name
    }

    return ''
}

export default function Trades() {
    const [trades, setTrades] = useState<Trade[]>([])
    const [editingId, setEditingId] = useState<string | null>(null)
    const [form, setForm] = useState<Trade>(emptyTrade)
    const [loading, setLoading] = useState(false)
    const [lookingUp, setLookingUp] = useState(false)
    const [importing, setImporting] = useState(false)
    const [importResult, setImportResult] = useState<{ success: number; failed: number; skipped: number } | null>(null)
    const [search, setSearch] = useState('')
    const [showForm, setShowForm] = useState(false)
    const [expandedId, setExpandedId] = useState<string | null>(null)
    const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
    const [editModal, setEditModal] = useState(false)
    const fileRef = useRef<HTMLInputElement>(null)
    // debounce ref for code lookup
    const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        const handle = () => setIsMobile(window.innerWidth < 768)
        window.addEventListener('resize', handle)
        return () => window.removeEventListener('resize', handle)
    }, [])

    const load = async () => {
        const q = query(userCol(investDB, 'trades'), orderBy('date', 'desc'))
        const snap = await getDocs(q)
        const rawTrades = snap.docs.map(d => ({ id: d.id, ...d.data() } as Trade))
        // 統一所有舊格式：spot_buy/margin_buy → buy+isMargin, spot_sell/margin_sell → sell+isMargin
        const normalized = rawTrades.map(t => {
            const type = t.type as string
            if (type === 'spot_buy') return { ...t, type: 'buy' as const, isMargin: false }
            if (type === 'spot_sell') return { ...t, type: 'sell' as const, isMargin: false }
            if (type === 'margin_buy') return { ...t, type: 'buy' as const, isMargin: true }
            if (type === 'margin_sell') return { ...t, type: 'sell' as const, isMargin: true }
            return t
        })
        setTrades(normalized)
    }

    useEffect(() => { load() }, [])

    // ★ 輸入代號後 debounce 500ms 再查詢，避免每按一個字就打 Firebase
    const handleCodeChange = (code: string) => {
        const upper = code.toUpperCase()
        setForm(f => {
            const fee = f.price && f.shares ? calcFee(f.price, f.shares) : f.fee
            const tax = f.type === 'sell' && f.price && f.shares ? calcTax(f.price, f.shares, upper) : 0
            const u = { ...f, code: upper, fee, tax }
            u.total = f.type === 'buy' ? f.price * f.shares + u.fee : f.price * f.shares - u.fee - u.tax
            return u
        })

        if (lookupTimer.current) clearTimeout(lookupTimer.current)
        if (upper.length < 3) return

        lookupTimer.current = setTimeout(async () => {
            setLookingUp(true)
            const name = await lookupStockName(upper)
            if (name) {
                setForm(f => ({ ...f, name }))
            }
            setLookingUp(false)
        }, 500)
    }

    const calcTotal = (f: Trade) => {
        if (f.type === 'buy' && f.isMargin) {
            // 融資買入：total = 自備款 + 手續費（不含融資借款部分）
            const stockValue = f.price * f.shares
            const marginAmt = Math.floor(stockValue * (f.marginRatio ?? 0.6))
            return stockValue - marginAmt + f.fee
        }
        return f.type === 'buy' ? f.price * f.shares + f.fee : f.price * f.shares - f.fee - f.tax
    }

    const handleChange = (key: keyof Trade, value: Trade[keyof Trade]) => {
        setForm(f => {
            const u = { ...f, [key]: value }
            if (['price', 'shares', 'type', 'code', 'marginRatio', 'isMargin'].includes(key)) {
                if (u.price && u.shares) {
                    u.fee = calcFee(u.price, u.shares)
                    u.tax = u.type === 'sell' ? calcTax(u.price, u.shares, u.code) : 0
                    if (u.type === 'buy' && u.isMargin) {
                        u.marginAmount = Math.floor(u.price * u.shares * (u.marginRatio ?? 0.6))
                    }
                }
            }
            u.total = calcTotal(u)
            return u
        })
    }

    const handleSave = async () => {
        if (!form.code || !form.price || !form.shares) return
        setLoading(true)
        if (form.name && form.code) {
            dictCache[form.code] = form.name
            await setDoc(userDoc(investDB, 'stockDict', form.code), { name: form.name })
        }
        if (editingId) {
            await updateDoc(userDoc(investDB, 'trades', editingId), { ...form })
        } else {
            await addDoc(userCol(investDB, 'trades'), { ...form })
        }
        setEditingId(null); setForm(emptyTrade); setLoading(false); setShowForm(false); setEditModal(false)
        load()
    }

    const handleEdit = (t: Trade) => {
        if (t.code && t.name) dictCache[t.code] = t.name
        // 已在 load() 正規化，直接使用
        setForm(t); setEditingId(t.id!); setEditModal(true)
    }
    const handleCancel = () => { setForm(emptyTrade); setEditingId(null); setShowForm(false); setEditModal(false) }
    const handleDelete = async (id: string) => {
        if (!confirm('確定要刪除？')) return
        await deleteDoc(userDoc(investDB, 'trades', id)); load()
    }

    const handleImportCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        setImporting(true); setImportResult(null)

        const text = await file.text()
        const lines = text
            .replace(/^\uFEFF/, '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .split('\n')
            .filter(l => l.trim())

        if (lines.length < 2) {
            setImporting(false); e.target.value = ''; return
        }

        const headers = parseCSVLine(lines[0])
        let success = 0, failed = 0, skipped = 0

        for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i])
            const row: Record<string, string> = {}
            headers.forEach((h, idx) => { row[h] = cols[idx] || '' })

            const type = row['類型']
            const date = row['日期']

            if (type === '入金' || type === '出金') {
                const amount = toNum(row['價格/金額'] || row['金額'] || '')
                if (amount > 0) {
                    await addDoc(userCol(investDB, 'cashflow'), {
                        date,
                        type: type === '入金' ? 'in' : 'out',
                        amount,
                        note: row['備註/筆記'] || row['備註'] || ''
                    })
                    success++
                } else { skipped++ }
                continue
            }
            // 支援新舊格式：現貨買入/現貨賣出/融資買入/融資賣出/買進/賣出
            const validTypes = ['買進', '賣出', '現貨買入', '現貨賣出', '融資買入', '融資賣出']
            if (!validTypes.includes(type)) { skipped++; continue }

            const isMarginCSV = type === '融資買入' || type === '融資賣出'
            const tradeType = (type === '賣出' || type === '現貨賣出' || type === '融資賣出') ? 'sell' : 'buy'

            const rawCode = (row['代號'] || '').replace('.TW', '').replace('.tw', '').trim()
            const name = (row['名稱'] || '').trim()
            const price = toNum(row['價格/金額'] || row['價格'] || '')
            const shares = toInt(row['股數'])

            if (!rawCode || !price || !shares) { failed++; continue }

            const isSell = tradeType === 'sell'
            const fee = calcFee(price, shares)
            const tax = isSell ? calcTax(price, shares, rawCode) : 0
            const total = isSell ? price * shares - fee - tax : price * shares + fee

            try {
                await addDoc(userCol(investDB, 'trades'), {
                    date, type: tradeType, code: rawCode, name, price, shares, fee, tax, total, isMargin: isMarginCSV,
                    note: row['備註/筆記'] || row['備註'] || ''
                })
                // ★ CSV 匯入時同步寫入 stockDict（只寫有名稱的）
                if (name && rawCode) {
                    dictCache[rawCode] = name
                    await setDoc(userDoc(investDB, 'stockDict', rawCode), { name })
                }
                success++
            } catch { failed++ }
        }

        setImportResult({ success, failed, skipped })
        setImporting(false); e.target.value = ''
        load()
    }

    const filtered = trades.filter(t =>
        !search || t.code.toLowerCase().includes(search.toLowerCase()) || t.name.includes(search)
    )

    const feeHint = () => isOddLot(form.shares) ? '（零股 6折，最低 1 元）' : '（6折自動計算）'
    const feeHintColor = isOddLot(form.shares) ? '#f5a623' : '#4f8ef7'

    return (
        <>
            {/* 編輯 Modal */}
            {editModal && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.65)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
                    onClick={e => { if (e.target === e.currentTarget) handleCancel() }}>
                    <div style={{ ...card, width: '100%', maxWidth: '720px', maxHeight: '90vh', overflowY: 'auto', position: 'relative' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                            <div style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                ✏️ 編輯交易
                                {isOddLot(form.shares) && (
                                    <span style={{ fontSize: '11px', backgroundColor: 'rgba(245,166,35,0.15)', color: '#f5a623', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>零股</span>
                                )}
                            </div>
                            <button onClick={handleCancel} style={{ background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer', padding: '4px' }}><X size={18} /></button>
                        </div>
                        <div className="trades-grid">
                            <div><label style={lbl}>日期</label><input type="date" style={inp} value={form.date} onChange={e => handleChange('date', e.target.value)} /></div>
                            <div><label style={lbl}>類型</label>
                                <select style={inp} value={form.type} onChange={e => handleChange('type', e.target.value)}>
                                    <option value="buy">買入</option>
                                    <option value="sell">賣出</option>
                                </select>
                            </div>
                            <div>
                                <label style={lbl}>股票代號</label>
                                <input style={inp} placeholder="例：2330" value={form.code} onChange={e => handleCodeChange(e.target.value)} />
                            </div>
                            <div>
                                <label style={lbl}>股票名稱 {lookingUp && <span style={{ color: '#8892a4', fontSize: '10px' }}>查詢中...</span>}</label>
                                <input style={inp} placeholder="輸入代號後自動帶入" value={form.name} onChange={e => handleChange('name', e.target.value)} />
                            </div>
                            <div><label style={lbl}>價格</label><input type="number" style={inp} placeholder="0" value={form.price || ''} onChange={e => handleChange('price', parseFloat(e.target.value) || 0)} /></div>
                            <div><label style={lbl}>股數</label><input type="number" style={inp} placeholder="0" value={form.shares || ''} onChange={e => handleChange('shares', parseInt(e.target.value) || 0)} /></div>
                            <div>
                                <label style={lbl}>手續費 <span style={{ color: feeHintColor, fontSize: '11px' }}>{feeHint()}</span></label>
                                <input type="number" style={inp} value={form.fee || ''} onChange={e => handleChange('fee', parseFloat(e.target.value) || 0)} />
                            </div>
                            <div>
                                <label style={lbl}>交易稅 <span style={{ color: form.type === 'sell' ? (isETF(form.code) ? '#f5a623' : '#4f8ef7') : '#2e3349', fontSize: '11px' }}>
                                    {form.type === 'sell' ? (isETF(form.code) ? '（ETF千分之一）' : '（千分之三）') : '（買入免稅）'}
                                </span></label>
                                <input type="number" style={inp} value={form.tax || ''} onChange={e => handleChange('tax', parseFloat(e.target.value) || 0)} />
                            </div>
                            <div>
                                <label style={lbl}>收付金額 {form.isMargin && form.type === 'buy' && <span style={{ color: '#f5a623', fontSize: '11px' }}>（自備款）</span>}</label>
                                <input type="number" style={{ ...inp, color: form.type === 'buy' ? '#ff5757' : '#00c896' }} value={form.total} readOnly />
                            </div>
                            <div className="span2">
                                <label style={lbl}>備註</label>
                                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                    <input style={{ ...inp, flex: 1 }} placeholder="選填" value={form.note} onChange={e => handleChange('note', e.target.value)} />
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', flexShrink: 0, userSelect: 'none' as const }}>
                                        <div
                                            onClick={() => handleChange('isMargin', !form.isMargin)}
                                            style={{
                                                width: '38px', height: '22px', borderRadius: '11px', position: 'relative', cursor: 'pointer', flexShrink: 0,
                                                backgroundColor: form.isMargin ? 'rgba(245,166,35,0.9)' : '#2e3349',
                                                transition: 'background-color 0.2s'
                                            }}>
                                            <div style={{
                                                position: 'absolute', top: '3px', left: form.isMargin ? '19px' : '3px',
                                                width: '16px', height: '16px', borderRadius: '50%', backgroundColor: '#fff',
                                                transition: 'left 0.2s'
                                            }} />
                                        </div>
                                        <span style={{ fontSize: '12px', color: form.isMargin ? '#f5a623' : '#8892a4', fontWeight: form.isMargin ? 600 : 400 }}>融資</span>
                                    </label>
                                </div>
                            </div>
                            {form.isMargin && form.type === 'buy' && (
                                <>
                                    <div>
                                        <label style={lbl}>融資成數 <span style={{ color: '#f5a623', fontSize: '11px' }}>（例：0.6 = 六成）</span></label>
                                        <input type="number" step="0.1" min="0" max="1" style={inp} value={form.marginRatio ?? 0.6} onChange={e => handleChange('marginRatio', parseFloat(e.target.value) || 0.6)} />
                                    </div>
                                    <div>
                                        <label style={lbl}>融資金額 <span style={{ color: '#f5a623', fontSize: '11px' }}>（自動計算）</span></label>
                                        <input type="number" style={{ ...inp, color: '#f5a623' }} value={form.marginAmount ?? 0} readOnly />
                                    </div>
                                </>
                            )}
                        </div>
                        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
                            <button style={btn('#2e3349')} onClick={handleCancel}><X size={14} />取消</button>
                            <button style={btn('#4f8ef7')} onClick={handleSave} disabled={loading}>
                                <Check size={14} />{loading ? '儲存中...' : '確認更新'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            <style>{`
        .trades-grid { display: grid; gap: 12px; grid-template-columns: repeat(5, 1fr); }
        .trades-grid .span2 { grid-column: span 2; }
        @media (max-width: 1100px) { .trades-grid { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 700px) { .trades-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .trades-grid { grid-template-columns: 1fr; } .trades-grid .span2 { grid-column: span 1; } }
        .trade-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .trade-table th { padding: 8px 10px; text-align: left; color: #8892a4; font-weight: 500; border-bottom: 1px solid #2e3349; white-space: nowrap; }
        .trade-table td { padding: 10px; border-bottom: 1px solid #2e3349; color: #e2e8f0; white-space: nowrap; }
        .trade-table tr:hover td { background-color: rgba(79,142,247,0.04); }
        .trade-card { background: #0f1117; border-radius: 10px; padding: 12px 14px; border: 1px solid #2e3349; margin-bottom: 8px; }
        .trade-card:active { border-color: #4f8ef7; }
      `}</style>

            <div style={{ padding: 'clamp(12px, 3vw, 32px)', maxWidth: '1600px', margin: '0 auto' }}>

                {/* 標題列 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                        <h1 style={{ fontSize: 'clamp(16px, 2.5vw, 22px)', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>買賣紀錄</h1>
                        <p style={{ fontSize: '12px', color: '#8892a4', margin: '2px 0 0' }}>共 {trades.length} 筆交易</p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <label style={{ ...btn('#21253a'), border: '1px solid #2e3349', cursor: 'pointer', fontSize: '12px', padding: '7px 10px' }}>
                            <Upload size={13} />{isMobile ? 'CSV' : importing ? '匯入中...' : '匯入歷史紀錄 CSV'}
                            <input ref={fileRef} type="file" accept=".csv" onChange={handleImportCSV} disabled={importing} style={{ display: 'none' }} />
                        </label>
                        <button style={{ ...btn('#4f8ef7'), fontSize: '12px', padding: '7px 12px' }} onClick={() => { setForm(emptyTrade); setEditingId(null); setShowForm(v => !v) }}>
                            {showForm ? <X size={13} /> : <Check size={13} />}{showForm ? '收起' : '新增交易'}
                        </button>
                    </div>
                </div>

                {importResult && (
                    <div style={{ backgroundColor: 'rgba(0,200,150,0.08)', border: '1px solid rgba(0,200,150,0.25)', borderRadius: '10px', padding: '12px 16px', marginBottom: '12px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                        <div><span style={{ fontSize: '11px', color: '#8892a4' }}>成功匯入</span><div style={{ fontSize: '16px', fontWeight: 700, color: '#00c896' }}>{importResult.success} 筆</div></div>
                        {importResult.failed > 0 && <div><span style={{ fontSize: '11px', color: '#8892a4' }}>失敗</span><div style={{ fontSize: '16px', fontWeight: 700, color: '#ff5757' }}>{importResult.failed} 筆</div></div>}
                        {importResult.skipped > 0 && <div><span style={{ fontSize: '11px', color: '#8892a4' }}>略過</span><div style={{ fontSize: '16px', fontWeight: 700, color: '#8892a4' }}>{importResult.skipped} 筆</div></div>}
                    </div>
                )}

                {/* 表單 */}
                {showForm && (
                    <div style={{ ...card, marginBottom: '16px' }}>
                        <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', marginBottom: '16px' }}>
                            {editingId ? '✏️ 編輯交易' : '➕ 新增交易'}
                            {isOddLot(form.shares) && (
                                <span style={{ marginLeft: '10px', fontSize: '11px', backgroundColor: 'rgba(245,166,35,0.15)', color: '#f5a623', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 }}>
                                    零股交易
                                </span>
                            )}
                        </div>
                        <div className="trades-grid">
                            <div><label style={lbl}>日期</label><input type="date" style={inp} value={form.date} onChange={e => handleChange('date', e.target.value)} /></div>
                            <div><label style={lbl}>類型</label>
                                <select style={inp} value={form.type} onChange={e => handleChange('type', e.target.value)}>
                                    <option value="buy">買入</option>
                                    <option value="sell">賣出</option>
                                </select>
                            </div>
                            <div>
                                <label style={lbl}>股票代號</label>
                                <input style={inp} placeholder="例：2330" value={form.code} onChange={e => handleCodeChange(e.target.value)} />
                            </div>
                            <div>
                                <label style={lbl}>股票名稱 {lookingUp && <span style={{ color: '#8892a4', fontSize: '10px' }}>查詢中...</span>}</label>
                                <input style={inp} placeholder="輸入代號後自動帶入" value={form.name} onChange={e => handleChange('name', e.target.value)} />
                            </div>
                            <div><label style={lbl}>價格</label><input type="number" style={inp} placeholder="0" value={form.price || ''} onChange={e => handleChange('price', parseFloat(e.target.value) || 0)} /></div>
                            <div><label style={lbl}>股數</label><input type="number" style={inp} placeholder="0" value={form.shares || ''} onChange={e => handleChange('shares', parseInt(e.target.value) || 0)} /></div>
                            <div>
                                <label style={lbl}>手續費 <span style={{ color: feeHintColor, fontSize: '11px' }}>{feeHint()}</span></label>
                                <input type="number" style={inp} value={form.fee || ''} onChange={e => handleChange('fee', parseFloat(e.target.value) || 0)} />
                            </div>
                            <div>
                                <label style={lbl}>交易稅 <span style={{ color: form.type === 'sell' ? (isETF(form.code) ? '#f5a623' : '#4f8ef7') : '#2e3349', fontSize: '11px' }}>
                                    {form.type === 'sell' ? (isETF(form.code) ? '（ETF千分之一）' : '（千分之三）') : '（買入免稅）'}
                                </span></label>
                                <input type="number" style={inp} value={form.tax || ''} onChange={e => handleChange('tax', parseFloat(e.target.value) || 0)} />
                            </div>
                            <div>
                                <label style={lbl}>收付金額 {form.isMargin && form.type === 'buy' && <span style={{ color: '#f5a623', fontSize: '11px' }}>（自備款）</span>}</label>
                                <input type="number" style={{ ...inp, color: form.type === 'buy' ? '#ff5757' : '#00c896' }} value={form.total} readOnly />
                            </div>
                            <div className="span2">
                                <label style={lbl}>備註</label>
                                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                    <input style={{ ...inp, flex: 1 }} placeholder="選填" value={form.note} onChange={e => handleChange('note', e.target.value)} />
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', flexShrink: 0, userSelect: 'none' as const }}>
                                        <div
                                            onClick={() => handleChange('isMargin', !form.isMargin)}
                                            style={{
                                                width: '38px', height: '22px', borderRadius: '11px', position: 'relative', cursor: 'pointer', flexShrink: 0,
                                                backgroundColor: form.isMargin ? 'rgba(245,166,35,0.9)' : '#2e3349',
                                                transition: 'background-color 0.2s'
                                            }}>
                                            <div style={{
                                                position: 'absolute', top: '3px', left: form.isMargin ? '19px' : '3px',
                                                width: '16px', height: '16px', borderRadius: '50%', backgroundColor: '#fff',
                                                transition: 'left 0.2s'
                                            }} />
                                        </div>
                                        <span style={{ fontSize: '12px', color: form.isMargin ? '#f5a623' : '#8892a4', fontWeight: form.isMargin ? 600 : 400 }}>融資</span>
                                    </label>
                                </div>
                            </div>
                            {form.isMargin && form.type === 'buy' && (
                                <>
                                    <div>
                                        <label style={lbl}>融資成數 <span style={{ color: '#f5a623', fontSize: '11px' }}>（例：0.6 = 六成）</span></label>
                                        <input type="number" step="0.1" min="0" max="1" style={inp} value={form.marginRatio ?? 0.6} onChange={e => handleChange('marginRatio', parseFloat(e.target.value) || 0.6)} />
                                    </div>
                                    <div>
                                        <label style={lbl}>融資金額 <span style={{ color: '#f5a623', fontSize: '11px' }}>（自動計算）</span></label>
                                        <input type="number" style={{ ...inp, color: '#f5a623' }} value={form.marginAmount ?? 0} readOnly />
                                    </div>
                                </>
                            )}
                        </div>
                        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
                            {editingId && <button style={btn('#2e3349')} onClick={handleCancel}><X size={14} />取消</button>}
                            <button style={btn('#4f8ef7')} onClick={handleSave} disabled={loading}>
                                <Check size={14} />{loading ? '儲存中...' : editingId ? '確認更新' : '確認新增'}
                            </button>
                        </div>
                    </div>
                )}

                {/* 搜尋列 */}
                <div style={{ marginBottom: '12px', position: 'relative' }}>
                    <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#8892a4' }} />
                    <input style={{ ...inp, paddingLeft: '36px', backgroundColor: '#1a1d27', border: '1px solid #2e3349' }}
                        placeholder="搜尋代號或名稱..." value={search} onChange={e => setSearch(e.target.value)} />
                </div>

                {/* 列表 */}
                <div style={card}>
                    {filtered.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '48px', color: '#8892a4' }}>
                            {search ? `找不到「${search}」相關紀錄` : '還沒有交易紀錄'}
                        </div>
                    ) : isMobile ? (
                        <div>
                            {filtered.map(trade => (
                                <div key={trade.id} className="trade-card">
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                                        onClick={() => setExpandedId(expandedId === trade.id ? null : trade.id!)}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                                            <span style={{ backgroundColor: trade.type === 'buy' ? 'rgba(255,87,87,0.15)' : 'rgba(0,200,150,0.15)', color: trade.type === 'buy' ? '#ff5757' : '#00c896', padding: '2px 8px', borderRadius: '20px', fontSize: '11px', fontWeight: 600, flexShrink: 0 }}>
                                                {trade.type === 'buy' ? '買' : '賣'}
                                            </span>
                                            {trade.isMargin && (
                                                <span style={{ backgroundColor: 'rgba(245,166,35,0.15)', color: '#f5a623', padding: '1px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600, flexShrink: 0 }}>融資</span>
                                            )}
                                            {isOddLot(trade.shares) && (
                                                <span style={{ backgroundColor: 'rgba(245,166,35,0.12)', color: '#f5a623', padding: '1px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600, flexShrink: 0 }}>零股</span>
                                            )}
                                            <span style={{ color: '#4f8ef7', fontWeight: 700, fontSize: '14px', flexShrink: 0 }}>{trade.code}</span>
                                            <span style={{ color: '#e2e8f0', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trade.name}</span>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                                            <span style={{ color: trade.type === 'buy' ? '#ff5757' : '#00c896', fontWeight: 600, fontSize: '13px' }}>
                                                ${trade.total.toLocaleString()}
                                            </span>
                                            {expandedId === trade.id ? <ChevronUp size={14} color="#8892a4" /> : <ChevronDown size={14} color="#8892a4" />}
                                        </div>
                                    </div>
                                    {expandedId === trade.id && (
                                        <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #2e3349' }}>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '10px' }}>
                                                {[
                                                    { label: '日期', value: trade.date },
                                                    { label: '價格', value: trade.price.toLocaleString() },
                                                    { label: '股數', value: `${trade.shares.toLocaleString()}${isOddLot(trade.shares) ? ' (零股)' : ''}` },
                                                    { label: '手續費', value: trade.fee.toLocaleString() },
                                                    { label: '交易稅', value: trade.tax.toLocaleString() },
                                                    { label: '備註', value: trade.note || '—' },
                                                ].map(({ label, value }) => (
                                                    <div key={label}>
                                                        <div style={{ fontSize: '10px', color: '#8892a4' }}>{label}</div>
                                                        <div style={{ fontSize: '13px', color: '#e2e8f0' }}>{value}</div>
                                                    </div>
                                                ))}
                                            </div>
                                            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                                                <button onClick={() => handleEdit(trade)} style={{ ...btn('#21253a'), border: '1px solid #2e3349', fontSize: '12px', padding: '6px 12px' }}>
                                                    <Pencil size={12} />編輯
                                                </button>
                                                <button onClick={() => handleDelete(trade.id!)} style={{ ...btn('rgba(255,87,87,0.15)'), color: '#ff5757', fontSize: '12px', padding: '6px 12px' }}>
                                                    <Trash2 size={12} />刪除
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div style={{ overflowX: 'auto' }}>
                            <table className="trade-table">
                                <thead>
                                    <tr>{['日期', '類型', '代號', '名稱', '價格', '股數', '手續費', '交易稅', '收付金額', '備註', ''].map(h => <th key={h}>{h}</th>)}</tr>
                                </thead>
                                <tbody>
                                    {filtered.map(trade => (
                                        <tr key={trade.id} style={{ backgroundColor: editingId === trade.id ? 'rgba(79,142,247,0.06)' : 'transparent' }}>
                                            <td>{trade.date}</td>
                                            <td>
                                                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                                    <span style={{ backgroundColor: trade.type === 'buy' ? 'rgba(255,87,87,0.15)' : 'rgba(0,200,150,0.15)', color: trade.type === 'buy' ? '#ff5757' : '#00c896', padding: '2px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600 }}>{trade.type === 'buy' ? '買入' : '賣出'}</span>
                                                    {trade.isMargin && <span style={{ backgroundColor: 'rgba(245,166,35,0.15)', color: '#f5a623', padding: '2px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600 }}>融資</span>}
                                                    {isOddLot(trade.shares) && <span style={{ backgroundColor: 'rgba(245,166,35,0.12)', color: '#d3d3d3', padding: '2px 6px', borderRadius: '20px', fontSize: '10px', fontWeight: 600 }}>零股</span>}
                                                </div>
                                            </td>
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